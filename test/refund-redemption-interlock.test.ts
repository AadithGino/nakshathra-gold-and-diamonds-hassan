import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { addMonths, startOfMonth } from 'date-fns';
import { fromZonedTime, toZonedTime } from 'date-fns-tz';
import {
  Customer,
  FinancialException,
  Payment,
  Refund,
  SchemeEnrollment,
  User,
} from '../src/models/index.js';
import { createPayout } from '../src/services/finance.service.js';
import {
  finalizeSuccessfulRefund,
  initiatePaymentRefund,
} from '../src/services/refund.service.js';
import { phonePeProvider } from '../src/services/phonepe.provider.js';
import { enrollmentDates } from '../src/services/scheme.service.js';
import { BUSINESS_TZ } from '../src/utils/time.js';
import { clearTestMongo, startTestMongo, stopTestMongo } from './helpers/mongo.js';

const INSTALLMENT = 100_000;

async function seedRedeemableScheme(paymentCount = 11) {
  const [actor] = await User.create([
    {
      name: 'Interlock Admin',
      phone: `+9177${String(Date.now()).slice(-8)}`,
      passwordHash: 'hash',
      role: 'ADMIN',
      status: 'ACTIVE',
    },
  ]);
  const [customer] = await Customer.create([
    {
      userId: actor._id,
      customerCode: `CUST-IL-${Date.now()}`,
      status: 'ACTIVE',
      kycStatus: 'VERIFIED',
      createdBy: actor._id,
    },
  ]);

  const now = new Date();
  // Start 11 months ago so current business month is month 12 (redemption window).
  const startLocal = startOfMonth(addMonths(toZonedTime(now, BUSINESS_TZ), -11));
  const startDate = fromZonedTime(startLocal, BUSINESS_TZ);
  const dates = enrollmentDates(startDate, 11, 11);
  const [enrollment] = await SchemeEnrollment.create([
    {
      customerId: customer._id,
      schemePlanId: actor._id,
      enrollmentNumber: `ENR-IL-${Date.now()}`,
      schemeType: 'GOLD_WEIGHT',
      startDate,
      ...dates,
      durationMonths: 11,
      flexibleMonths: 11,
      monthlyInstallmentPaise: INSTALLMENT,
      makingChargeWaiverPercent: 100,
      gstRateBasisPoints: 300,
      status: 'ACTIVE',
      createdBy: actor._id,
      paymentsCompleted: paymentCount,
      totalPaidPaise: paymentCount * INSTALLMENT,
      availableGoldWeightMg: paymentCount * 142,
    },
  ]);

  const payments = [];
  for (let month = 1; month <= paymentCount; month++) {
    const merchantTransactionId = `KRL-IL-${Date.now()}-${month}`;
    const [payment] = await Payment.create([
      {
        customerId: customer._id,
        schemeId: enrollment._id,
        amountPaise: INSTALLMENT,
        method: 'UPI',
        status: 'SUCCESS',
        paymentDate: fromZonedTime(addMonths(startLocal, month - 1), BUSINESS_TZ),
        schemeMonth: month,
        receiptNumber: `KRL-IL-${Date.now()}-${month}`,
        merchantTransactionId,
        providerTransactionId: `PP-${merchantTransactionId}`,
        goldRatePerGramPaise: 700_000,
        goldWeightMg: 142,
        goldPurity: '916',
        collectorRole: 'CUSTOMER',
        createdBy: actor._id,
      },
    ]);
    payments.push(payment);
  }

  return { actor, customer, enrollment, payments, payoutDate: now };
}

describe('refund / redemption interlock', () => {
  beforeAll(async () => {
    await startTestMongo();
  }, 120_000);

  afterAll(async () => {
    await stopTestMongo();
  });

  beforeEach(async () => {
    await clearTestMongo();
    vi.restoreAllMocks();
    vi.spyOn(phonePeProvider, 'initiateRefund').mockResolvedValue({
      state: 'PENDING',
      amountPaise: INSTALLMENT,
      providerRefundId: 'PRV-IL-1',
      raw: { state: 'PENDING' },
    });
  });

  it('blocks redemption while a scheme payment refund is pending', async () => {
    const { actor, customer, enrollment, payments, payoutDate } = await seedRedeemableScheme(11);
    await initiatePaymentRefund(
      String(payments[0]._id),
      { reason: 'Customer request before redemption', idempotencyKey: 'il-block-0001' },
      { actorId: String(actor._id), actorRole: 'ADMIN', requestId: 'il-1' },
    );

    await expect(
      createPayout(
        {
          customerId: String(customer._id),
          schemeId: String(enrollment._id),
          payoutDate,
          payoutType: 'REDEEM',
        },
        { actorId: String(actor._id), actorRole: 'ADMIN', requestId: 'il-payout-1' },
      ),
    ).rejects.toMatchObject({ code: 'REDEMPTION_BLOCKED_PENDING_REFUND' });
  });

  it('does not mutate ledger when provider refund succeeds after redemption', async () => {
    const { actor, enrollment, payments } = await seedRedeemableScheme(1);
    const payment = payments[0];
    const initiated = await initiatePaymentRefund(
      String(payment._id),
      { reason: 'Late provider success race', idempotencyKey: 'il-after-redeem-0001' },
      { actorId: String(actor._id), actorRole: 'ADMIN', requestId: 'il-2' },
    );

    await SchemeEnrollment.updateOne({ _id: enrollment._id }, { $set: { status: 'REDEEMED' } });

    await expect(
      finalizeSuccessfulRefund(
        String(initiated.refundId),
        {
          state: 'SUCCESS',
          amountPaise: INSTALLMENT,
          providerRefundId: 'PRV-DONE',
          bankReferenceId: 'UTR-1',
          railType: 'UPI',
          raw: { state: 'SUCCESS' },
        },
        { actorId: String(actor._id), actorRole: 'ADMIN', requestId: 'il-finalize' },
      ),
    ).rejects.toMatchObject({ code: 'REFUND_COMPLETED_AFTER_REDEMPTION' });

    const still = await Payment.findById(payment._id);
    expect(still?.status).toBe('SUCCESS');
    expect(still?.amountPaise).toBe(INSTALLMENT);
    expect(still?.refundStatus).toBe('REVIEW_REQUIRED');

    const reviewed = await Refund.findById(initiated.refundId);
    expect(reviewed?.status).toBe('REVIEW_REQUIRED');
    expect(reviewed?.providerRefundId).toBe('PRV-DONE');
    expect(reviewed?.providerBankReferenceId).toBe('UTR-1');
    expect(reviewed?.nextStatusCheckAt).toBeUndefined();
    expect(reviewed?.recoveryLockUntil).toBeUndefined();

    expect(
      await FinancialException.countDocuments({
        type: 'REFUND_COMPLETED_AFTER_REDEMPTION',
        refundId: initiated.refundId,
      }),
    ).toBe(1);

    // Recovery claim filter only matches INITIATED/PENDING — review stays terminal.
    const { claimableRefundRecoveryFilter } = await import('../src/utils/mongo-filter.js');
    const reclaimable = await Refund.findOne({
      _id: initiated.refundId,
      ...claimableRefundRecoveryFilter(new Date(Date.now() + 86_400_000)),
    });
    expect(reclaimable).toBeNull();
  });

  it('allows only one of concurrent refund initiation and redemption', async () => {
    const { actor, customer, enrollment, payments, payoutDate } = await seedRedeemableScheme(11);
    const payment = payments[0];

    const settled = await Promise.allSettled([
      initiatePaymentRefund(
        String(payment._id),
        { reason: 'Concurrent race', idempotencyKey: 'il-race-0001' },
        { actorId: String(actor._id), actorRole: 'ADMIN', requestId: 'race-refund' },
      ),
      createPayout(
        {
          customerId: String(customer._id),
          schemeId: String(enrollment._id),
          payoutDate,
          payoutType: 'REDEEM',
        },
        { actorId: String(actor._id), actorRole: 'ADMIN', requestId: 'race-payout' },
      ),
    ]);

    const refundOk = settled[0].status === 'fulfilled';
    const payoutOk = settled[1].status === 'fulfilled';
    expect(refundOk || payoutOk).toBe(true);
    expect(refundOk && payoutOk).toBe(false);

    if (refundOk) {
      expect(await Refund.countDocuments({ paymentId: payment._id })).toBe(1);
      expect((await SchemeEnrollment.findById(enrollment._id))?.status).toBe('ACTIVE');
    } else {
      expect((await SchemeEnrollment.findById(enrollment._id))?.status).toBe('REDEEMED');
      expect(await Refund.countDocuments({})).toBe(0);
    }
  });
});
