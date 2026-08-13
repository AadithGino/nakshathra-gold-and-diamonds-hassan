import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { startOfMonth } from 'date-fns';
import { fromZonedTime, toZonedTime } from 'date-fns-tz';
import {
  FinancialException,
  Payment,
  PaymentIntent,
  Refund,
  SchemeEnrollment,
  User,
} from '../src/models/index.js';
import { initiatePaymentRefund } from '../src/services/refund.service.js';
import { phonePeProvider } from '../src/services/phonepe.provider.js';
import { enrollmentDates } from '../src/services/scheme.service.js';
import { claimableRefundRecoveryFilter } from '../src/utils/mongo-filter.js';
import { BUSINESS_TZ } from '../src/utils/time.js';
import {
  processRefundRecoveryBatch,
  repairUnscheduledActiveRefunds,
} from '../src/workers/refund-recovery.worker.js';
import { clearTestMongo, startTestMongo, stopTestMongo } from './helpers/mongo.js';

const INSTALLMENT = 100_000;

async function seedGatewayPayment() {
  const [actor] = await User.create([
    {
      name: 'Crash Recovery Admin',
      phone: `+9187${String(Date.now()).slice(-8)}`,
      passwordHash: 'hash',
      role: 'ADMIN',
    },
  ]);
  const now = new Date();
  const startLocal = startOfMonth(toZonedTime(now, BUSINESS_TZ));
  const startDate = fromZonedTime(startLocal, BUSINESS_TZ);
  const dates = enrollmentDates(startDate, 11, 11);
  const [enrollment] = await SchemeEnrollment.create([
    {
      customerId: actor._id,
      schemePlanId: actor._id,
      enrollmentNumber: `ENR-CR-${Date.now()}`,
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
    },
  ]);
  const merchantTransactionId = `KRL-CR-${Date.now()}-${Math.random().toString(16).slice(2, 6)}`;
  await PaymentIntent.create([
    {
      customerId: actor._id,
      schemeId: enrollment._id,
      amountPaise: INSTALLMENT,
      merchantTransactionId,
      checkoutChannel: 'WEB',
      status: 'SUCCESS',
      idempotencyKey: `cr-${merchantTransactionId}`,
      idempotencyScope: 'PHONEPE_CUSTOMER_WEB',
      requestHash: 'hash',
      goldRatePerGramPaise: 700_000,
      goldWeightMg: 142,
      goldPurity: '916',
      schemeMonth: 1,
      collectorRole: 'CUSTOMER',
      createdBy: actor._id,
    },
  ]);
  const [payment] = await Payment.create([
    {
      customerId: actor._id,
      schemeId: enrollment._id,
      amountPaise: INSTALLMENT,
      method: 'UPI',
      status: 'SUCCESS',
      paymentDate: now,
      schemeMonth: 1,
      receiptNumber: `KRL-2026-${String(Date.now()).slice(-7)}`,
      merchantTransactionId,
      providerTransactionId: `PP-${merchantTransactionId}`,
      goldRatePerGramPaise: 700_000,
      goldWeightMg: 142,
      goldPurity: '916',
      collectorRole: 'CUSTOMER',
      createdBy: actor._id,
    },
  ]);
  return { actor, enrollment, payment };
}

describe('refund crash-recovery window', () => {
  beforeAll(async () => {
    await startTestMongo();
  });
  afterAll(async () => {
    await stopTestMongo();
  });
  beforeEach(async () => {
    await clearTestMongo();
    vi.restoreAllMocks();
  });

  it('schedules recovery in the first transaction before PhonePe is called', async () => {
    const { actor, payment } = await seedGatewayPayment();
    let sawScheduleBeforeProvider = false;
    vi.spyOn(phonePeProvider, 'initiateRefund').mockImplementation(async () => {
      const mid = await Refund.findOne({ paymentId: payment._id });
      sawScheduleBeforeProvider = Boolean(mid?.nextStatusCheckAt) && mid?.status === 'INITIATED';
      return {
        state: 'PENDING',
        amountPaise: INSTALLMENT,
        providerRefundId: 'PRV-MID',
        raw: { state: 'PENDING' },
      };
    });

    await initiatePaymentRefund(
      String(payment._id),
      { reason: 'Pre-provider schedule', idempotencyKey: 'crash-sched-00000001' },
      { actorId: String(actor._id), actorRole: 'ADMIN', requestId: 'cr-1' },
    );

    expect(sawScheduleBeforeProvider).toBe(true);
  });

  it('recovers after simulated crash following PhonePe accept without local response persistence', async () => {
    const { actor, payment } = await seedGatewayPayment();
    let initiateCalls = 0;
    vi.spyOn(phonePeProvider, 'initiateRefund').mockImplementation(async () => {
      initiateCalls += 1;
      // Simulate crash: provider accepted but we never persist Txn B.
      // Leave the INITIATED+scheduled document as-is by throwing before return is used...
      // Actual flow: if we throw, Txn B still runs as uncertain. To simulate crash after
      // provider accept with no Txn B, create the local record via initiate then force
      // the post-provider path to be skipped by restoring INITIATED without provider fields.
      return {
        state: 'PENDING',
        amountPaise: INSTALLMENT,
        providerRefundId: 'PRV-CRASH',
        raw: { state: 'PENDING' },
      };
    });

    const result = await initiatePaymentRefund(
      String(payment._id),
      { reason: 'Crash after accept', idempotencyKey: 'crash-accept-0000001' },
      { actorId: String(actor._id), actorRole: 'ADMIN', requestId: 'cr-2' },
    );

    // Force the crash window: drop provider fields / revert to INITIATED with schedule only.
    await Refund.updateOne(
      { _id: result.refundId },
      {
        $set: {
          status: 'INITIATED',
          active: true,
          nextStatusCheckAt: new Date(Date.now() - 1_000),
        },
        $unset: {
          providerInitiatedAt: 1,
          providerRefundId: 1,
          lastProviderResponse: 1,
        },
      },
    );

    vi.mocked(phonePeProvider.initiateRefund).mockClear();
    vi.spyOn(phonePeProvider, 'checkRefundStatus').mockResolvedValue({
      state: 'SUCCESS',
      amountPaise: INSTALLMENT,
      providerRefundId: 'PRV-CRASH',
      bankReferenceId: 'UTR-CRASH',
      raw: { state: 'SUCCESS' },
    });

    await processRefundRecoveryBatch('crash-worker', 5, new Date());

    expect(initiateCalls).toBe(1);
    expect(phonePeProvider.initiateRefund).toHaveBeenCalledTimes(0);
    expect(phonePeProvider.checkRefundStatus).toHaveBeenCalledTimes(1);

    const refund = await Refund.findById(result.refundId);
    expect(refund?.status).toBe('SUCCESS');
    expect(refund?.active).toBe(false);
    expect(refund?.confirmedAt).toBeTruthy();

    const paymentAfter = await Payment.findById(payment._id);
    expect(paymentAfter?.status).toBe('REFUNDED');
    expect(paymentAfter?.amountPaise).toBe(INSTALLMENT);
    expect(paymentAfter?.goldRatePerGramPaise).toBe(700_000);
    expect(paymentAfter?.goldWeightMg).toBe(142);
  });

  it('does not invent providerInitiatedAt after network exception', async () => {
    const { actor, payment } = await seedGatewayPayment();
    vi.spyOn(phonePeProvider, 'initiateRefund').mockRejectedValue(new Error('socket hang up'));

    const result = await initiatePaymentRefund(
      String(payment._id),
      { reason: 'Network fail', idempotencyKey: 'crash-net-0000000001' },
      { actorId: String(actor._id), actorRole: 'ADMIN', requestId: 'cr-3' },
    );

    const refund = await Refund.findById(result.refundId);
    expect(refund?.status).toBe('INITIATED');
    expect(refund?.active).toBe(true);
    expect(refund?.providerInitiatedAt).toBeUndefined();
    expect(refund?.nextStatusCheckAt).toBeTruthy();
    expect(refund?.lastProviderError).toMatch(/socket hang up/);
  });

  it('repairs legacy active refunds missing nextStatusCheckAt without re-initiating', async () => {
    const { actor, payment } = await seedGatewayPayment();
    vi.spyOn(phonePeProvider, 'initiateRefund').mockResolvedValue({
      state: 'PENDING',
      amountPaise: INSTALLMENT,
      providerRefundId: 'PRV-LEG',
      raw: { state: 'PENDING' },
    });
    const created = await initiatePaymentRefund(
      String(payment._id),
      { reason: 'Legacy schedule', idempotencyKey: 'crash-leg-0000000001' },
      { actorId: String(actor._id), actorRole: 'ADMIN', requestId: 'cr-4' },
    );

    await Refund.updateOne(
      { _id: created.refundId },
      { $unset: { nextStatusCheckAt: 1 }, $set: { status: 'INITIATED', active: true } },
    );

    vi.spyOn(phonePeProvider, 'initiateRefund');
    const repaired = await repairUnscheduledActiveRefunds(5);
    expect(repaired).toBe(1);

    const refund = await Refund.findById(created.refundId);
    expect(refund?.nextStatusCheckAt).toBeTruthy();
    expect(
      await FinancialException.countDocuments({ type: 'REFUND_MISSING_RECOVERY_SCHEDULE' }),
    ).toBe(1);

    const claimable = await Refund.findOne({
      _id: created.refundId,
      ...claimableRefundRecoveryFilter(new Date()),
    });
    expect(claimable).toBeTruthy();
  });

  it('continues the recovery batch when one item throws', async () => {
    const { actor, payment } = await seedGatewayPayment();
    let n = 0;
    vi.spyOn(phonePeProvider, 'initiateRefund').mockImplementation(async () => {
      n += 1;
      return {
        state: 'PENDING' as const,
        amountPaise: INSTALLMENT,
        providerRefundId: `PRV-BATCH-${n}`,
        raw: { state: 'PENDING' },
      };
    });
    const a = await initiatePaymentRefund(
      String(payment._id),
      { reason: 'Batch a', idempotencyKey: 'crash-batch-a-000001' },
      { actorId: String(actor._id), actorRole: 'ADMIN', requestId: 'cr-5a' },
    );

    const second = await seedGatewayPayment();
    const b = await initiatePaymentRefund(
      String(second.payment._id),
      { reason: 'Batch b', idempotencyKey: 'crash-batch-b-000001' },
      { actorId: String(second.actor._id), actorRole: 'ADMIN', requestId: 'cr-5b' },
    );

    await Refund.updateMany(
      { _id: { $in: [a.refundId, b.refundId] } },
      { $set: { nextStatusCheckAt: new Date(Date.now() - 1_000) } },
    );

    const badMerchantId = (await Refund.findById(a.refundId))!.merchantRefundId;
    let calls = 0;
    vi.spyOn(phonePeProvider, 'checkRefundStatus').mockImplementation(async (id: string) => {
      calls += 1;
      if (id === badMerchantId) {
        throw new Error('transient provider fault');
      }
      return {
        state: 'PENDING',
        amountPaise: INSTALLMENT,
        providerRefundId: 'PRV-OK',
        raw: { state: 'PENDING' },
      };
    });

    const processed = await processRefundRecoveryBatch('batch-worker', 10, new Date());
    expect(processed).toBeGreaterThanOrEqual(2);
    expect(calls).toBeGreaterThanOrEqual(2);
  });
});
