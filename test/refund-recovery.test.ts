import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { startOfMonth } from 'date-fns';
import { fromZonedTime, toZonedTime } from 'date-fns-tz';
import {
  Payment,
  PaymentIntent,
  Refund,
  SchemeEnrollment,
  User,
} from '../src/models/index.js';
import {
  finalizeSuccessfulRefund,
  reconcileRefundStatus,
} from '../src/services/refund.service.js';
import { phonePeProvider } from '../src/services/phonepe.provider.js';
import { enrollmentDates } from '../src/services/scheme.service.js';
import { aggregateEnrollmentLedger } from '../src/utils/enrollment-ledger.js';
import {
  isRefundPendingTooLong,
  nextRefundRecoveryCheckAt,
} from '../src/utils/refund-recovery.js';
import { BUSINESS_TZ } from '../src/utils/time.js';
import {
  claimNextRefundRecovery,
  processRefundRecoveryBatch,
} from '../src/workers/refund-recovery.worker.js';
import { clearTestMongo, startTestMongo, stopTestMongo } from './helpers/mongo.js';

const INSTALLMENT = 100_000;

async function seedPendingRefund(overrides: Record<string, unknown> = {}) {
  const [actor] = await User.create([
    {
      name: 'Refund Recovery Admin',
      phone: `+9177${String(Date.now()).slice(-8)}`,
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
      enrollmentNumber: `ENR-RR-${Date.now()}`,
      schemeType: 'GOLD_WEIGHT',
      startDate,
      ...dates,
      durationMonths: 11,
      flexibleMonths: 11,
      monthlyInstallmentPaise: INSTALLMENT,
      makingChargeWaiverPercent: 100,
      gstRateBasisPoints: 300,
      status: 'ACTIVE',
      totalPaidPaise: INSTALLMENT,
      totalGoldWeightMg: 142,
      paymentsCompleted: 1,
      createdBy: actor._id,
    },
  ]);
  const merchantTransactionId = `KRL-RR-${Date.now()}-${Math.random().toString(16).slice(2, 6)}`;
  await PaymentIntent.create([
    {
      customerId: actor._id,
      schemeId: enrollment._id,
      amountPaise: INSTALLMENT,
      merchantTransactionId,
      checkoutChannel: 'WEB',
      status: 'SUCCESS',
      idempotencyKey: `rr-${merchantTransactionId}`,
      idempotencyScope: 'PHONEPE_CUSTOMER_WEB',
      requestHash: 'rr-hash',
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
      refundStatus: 'PENDING',
    },
  ]);
  const [refund] = await Refund.create([
    {
      paymentId: payment._id,
      customerId: actor._id,
      schemeId: enrollment._id,
      merchantRefundId: `RFD-${merchantTransactionId}`,
      originalMerchantOrderId: merchantTransactionId,
      amountPaise: INSTALLMENT,
      status: 'PENDING',
      reason: 'Recovery test',
      idempotencyKey: `idem-${merchantTransactionId}`,
      requestHash: 'hash',
      requestedBy: actor._id,
      requestedAt: now,
      nextStatusCheckAt: new Date(0),
      statusHistory: [{ status: 'PENDING', at: now, source: 'TEST' }],
      ...overrides,
    },
  ]);
  payment.refundId = refund._id;
  await payment.save();
  return { actor, enrollment, payment, refund, merchantTransactionId };
}

describe('refund recovery scheduling helpers', () => {
  it('uses age-based backoff and never fails on age alone', () => {
    const started = new Date('2026-08-01T00:00:00.000Z');
    const now = new Date('2026-08-01T00:10:00.000Z');
    expect(nextRefundRecoveryCheckAt(started, now).getTime() - now.getTime()).toBe(2 * 60_000);
    expect(isRefundPendingTooLong(started, now)).toBe(false);
    expect(isRefundPendingTooLong(started, new Date('2026-08-10T00:00:00.000Z'))).toBe(true);
  });
});

describe('refund recovery finalization', () => {
  beforeAll(async () => {
    await startTestMongo();
  }, 120_000);

  afterAll(async () => {
    await stopTestMongo();
  });

  beforeEach(async () => {
    await clearTestMongo();
    vi.restoreAllMocks();
  });

  it('reschedules when PhonePe refund is still PENDING', async () => {
    const { refund } = await seedPendingRefund();
    vi.spyOn(phonePeProvider, 'checkRefundStatus').mockResolvedValue({
      state: 'PENDING',
      amountPaise: INSTALLMENT,
      raw: {},
    });
    await processRefundRecoveryBatch('rr-1');
    const updated = await Refund.findById(refund._id);
    expect(updated?.status).toBe('PENDING');
    expect(updated?.nextStatusCheckAt!.getTime()).toBeGreaterThan(Date.now());
  });

  it('marks payment REFUNDED and updates enrollment on provider success', async () => {
    const { actor, payment, refund, enrollment } = await seedPendingRefund();
    vi.spyOn(phonePeProvider, 'checkRefundStatus').mockResolvedValue({
      state: 'SUCCESS',
      amountPaise: INSTALLMENT,
      providerRefundId: 'PRV-OK',
      bankReferenceId: 'UTR123',
      railType: 'UPI',
      raw: { state: 'COMPLETED' },
    });

    expect(await processRefundRecoveryBatch('rr-2')).toBe(1);

    const updatedPayment = await Payment.findById(payment._id);
    const updatedRefund = await Refund.findById(refund._id);
    expect(updatedRefund?.status).toBe('SUCCESS');
    expect(updatedPayment?.status).toBe('REFUNDED');
    expect(updatedPayment?.refundStatus).toBe('SUCCESS');
    expect(updatedPayment?.amountPaise).toBe(INSTALLMENT);
    expect(updatedPayment?.goldWeightMg).toBe(142);
    expect(updatedPayment?.goldRatePerGramPaise).toBe(700_000);
    expect(updatedRefund?.providerBankReferenceId).toBe('UTR123');

    const ledger = await aggregateEnrollmentLedger(String(enrollment._id));
    expect(ledger.totalPaidPaise).toBe(0);
    expect(ledger.totalGoldWeightMg).toBe(0);
    expect(ledger.paymentsCompleted).toBe(0);

    // Idempotent re-finalize
    const again = await finalizeSuccessfulRefund(
      String(refund._id),
      {
        state: 'SUCCESS',
        amountPaise: INSTALLMENT,
        providerRefundId: 'PRV-OK',
        raw: {},
      },
      { actorId: String(actor._id), actorRole: 'ADMIN', requestId: 'idem' },
    );
    expect(again.status).toBe('SUCCESS');
    expect(await Payment.countDocuments({ status: 'REFUNDED' })).toBe(1);
  });

  it('failed refund leaves payment SUCCESS and does not change ledger', async () => {
    const { payment, refund, enrollment } = await seedPendingRefund();
    vi.spyOn(phonePeProvider, 'checkRefundStatus').mockResolvedValue({
      state: 'FAILED',
      amountPaise: INSTALLMENT,
      errorCode: 'REFUND_DECLINED',
      raw: {},
    });
    await processRefundRecoveryBatch('rr-3');
    expect((await Refund.findById(refund._id))?.status).toBe('FAILED');
    const updatedPayment = await Payment.findById(payment._id);
    expect(updatedPayment?.status).toBe('SUCCESS');
    expect(updatedPayment?.refundStatus).toBe('FAILED');
    const ledger = await aggregateEnrollmentLedger(String(enrollment._id));
    expect(ledger.totalPaidPaise).toBe(INSTALLMENT);
  });

  it('amount mismatch does not finalize', async () => {
    const { refund, payment } = await seedPendingRefund();
    const result = await reconcileRefundStatus(
      String(refund._id),
      { actorRole: 'ADMIN', requestId: 'mm' },
      { state: 'SUCCESS', amountPaise: INSTALLMENT + 1, raw: {} },
    );
    expect(result).toMatchObject({ state: 'PENDING', amountMismatch: true });
    expect((await Payment.findById(payment._id))?.status).toBe('SUCCESS');
    expect((await Refund.findById(refund._id))?.status).toBe('PENDING');
  });

  it('only queries Refund collection for claimable work', async () => {
    await seedPendingRefund({
      recoveryLockUntil: new Date(Date.now() + 60_000),
      recoveryLockedBy: 'other',
    });
    expect(await claimNextRefundRecovery('me')).toBeNull();
  });

  it('manual reconcile and worker race finalize once', async () => {
    const { refund, payment, actor } = await seedPendingRefund();
    const status = {
      state: 'SUCCESS' as const,
      amountPaise: INSTALLMENT,
      providerRefundId: 'PRV-RACE',
      raw: {},
    };
    vi.spyOn(phonePeProvider, 'checkRefundStatus').mockResolvedValue(status);
    await Promise.all([
      reconcileRefundStatus(String(refund._id), {
        actorId: String(actor._id),
        actorRole: 'ADMIN',
        requestId: 'manual',
      }),
      processRefundRecoveryBatch('worker-race'),
    ]);
    expect(await Payment.countDocuments({ _id: payment._id, status: 'REFUNDED' })).toBe(1);
    expect(await Refund.countDocuments({ status: 'SUCCESS' })).toBe(1);
  });

  it('marks REFUND_PENDING_TOO_LONG without failing old refunds', async () => {
    const started = new Date(Date.now() - 8 * 24 * 60 * 60_000);
    const { refund } = await seedPendingRefund({
      requestedAt: started,
      createdAt: started,
    });
    vi.spyOn(phonePeProvider, 'checkRefundStatus').mockResolvedValue({
      state: 'PENDING',
      amountPaise: INSTALLMENT,
      raw: {},
    });
    await processRefundRecoveryBatch('rr-old');
    const updated = await Refund.findById(refund._id);
    expect(updated?.status).toBe('PENDING');
    expect(JSON.stringify(updated?.lastProviderResponse)).toMatch(/REFUND_PENDING_TOO_LONG/);
  });
});
