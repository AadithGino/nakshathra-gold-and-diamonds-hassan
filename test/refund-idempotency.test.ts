import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  Payment,
  Refund,
} from '../src/models/index.js';
import {
  initiatePaymentRefund,
  markFailedRefund,
  retryFailedRefund,
} from '../src/services/refund.service.js';
import { phonePeProvider } from '../src/services/phonepe.provider.js';
import { clearTestMongo, startTestMongo, stopTestMongo } from './helpers/mongo.js';

// Reuse seed helper from initiation suite via inline minimal seed.
import { startOfMonth } from 'date-fns';
import { fromZonedTime, toZonedTime } from 'date-fns-tz';
import { PaymentIntent, SchemeEnrollment, User } from '../src/models/index.js';
import { enrollmentDates } from '../src/services/scheme.service.js';
import { BUSINESS_TZ } from '../src/utils/time.js';

const INSTALLMENT = 100_000;

async function seedGatewayPayment() {
  const [actor] = await User.create([
    {
      name: 'Refund Idem Admin',
      phone: `+9189${String(Date.now()).slice(-8)}`,
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
      enrollmentNumber: `ENR-RID-${Date.now()}`,
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
  const merchantTransactionId = `KRL-RID-${Date.now()}-${Math.random().toString(16).slice(2, 6)}`;
  await PaymentIntent.create([
    {
      customerId: actor._id,
      schemeId: enrollment._id,
      amountPaise: INSTALLMENT,
      merchantTransactionId,
      checkoutChannel: 'WEB',
      status: 'SUCCESS',
      idempotencyKey: `rid-${merchantTransactionId}`,
      idempotencyScope: 'PHONEPE_CUSTOMER_WEB',
      requestHash: 'refund-hash',
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

describe('refund multi-attempt + concurrent idempotency', () => {
  beforeAll(async () => {
    await startTestMongo();
  });

  afterAll(async () => {
    await stopTestMongo();
  });

  beforeEach(async () => {
    await clearTestMongo();
    vi.spyOn(phonePeProvider, 'initiateRefund').mockResolvedValue({
      state: 'PENDING',
      amountPaise: INSTALLMENT,
      providerRefundId: 'PRV-CONC',
      raw: { state: 'PENDING' },
    });
  });

  it('20 concurrent identical requests create one active refund and one provider call', async () => {
    const { actor, payment } = await seedGatewayPayment();
    const key = 'conc-same-key-00000001';
    const results = await Promise.allSettled(
      Array.from({ length: 20 }, (_, i) =>
        initiatePaymentRefund(
          String(payment._id),
          { reason: 'Concurrent identical initiate', idempotencyKey: key },
          { actorId: String(actor._id), actorRole: 'ADMIN', requestId: `conc-${i}` },
        ),
      ),
    );

    const fulfilled = results.filter((r) => r.status === 'fulfilled') as Array<
      PromiseFulfilledResult<{ refundId: unknown; merchantRefundId: string }>
    >;
    expect(fulfilled.length).toBe(20);
    const ids = new Set(fulfilled.map((r) => String(r.value.refundId)));
    const merchants = new Set(fulfilled.map((r) => r.value.merchantRefundId));
    expect(ids.size).toBe(1);
    expect(merchants.size).toBe(1);
    expect(await Refund.countDocuments({ paymentId: payment._id })).toBe(1);
    expect(await Refund.countDocuments({ paymentId: payment._id, active: true })).toBe(1);
    expect(phonePeProvider.initiateRefund).toHaveBeenCalledTimes(1);
    for (const r of results) {
      expect(r.status).toBe('fulfilled');
      if (r.status === 'rejected') {
        expect(String(r.reason)).not.toMatch(/E11000|11000/);
      }
    }
  });

  it('concurrent different keys allow only one active attempt', async () => {
    const { actor, payment } = await seedGatewayPayment();
    const settled = await Promise.allSettled(
      Array.from({ length: 10 }, (_, i) =>
        initiatePaymentRefund(
          String(payment._id),
          {
            reason: 'Different keys race',
            idempotencyKey: `diff-key-${String(i).padStart(4, '0')}-xxxx`,
          },
          { actorId: String(actor._id), actorRole: 'ADMIN', requestId: `diff-${i}` },
        ),
      ),
    );

    const ok = settled.filter((r) => r.status === 'fulfilled');
    const failed = settled.filter((r) => r.status === 'rejected');
    expect(ok.length).toBeGreaterThanOrEqual(1);
    expect(ok.length + failed.length).toBe(10);
    expect(await Refund.countDocuments({ paymentId: payment._id, active: true })).toBe(1);
    for (const r of failed) {
      if (r.status === 'rejected') {
        expect((r.reason as { code?: string }).code).toMatch(
          /REFUND_ALREADY_EXISTS|REFUND_CREATE_RACE/,
        );
        expect(String(r.reason)).not.toMatch(/E11000/);
      }
    }
  });

  it('retries a terminal FAILED attempt without mutating history', async () => {
    const { actor, payment } = await seedGatewayPayment();
    const first = await initiatePaymentRefund(
      String(payment._id),
      { reason: 'First attempt will fail', idempotencyKey: 'retry-first-00000001' },
      { actorId: String(actor._id), actorRole: 'ADMIN', requestId: 'retry-1' },
    );

    await markFailedRefund(
      String(first.refundId),
      {
        state: 'FAILED',
        amountPaise: INSTALLMENT,
        errorCode: 'PROVIDER_FAILED',
        raw: { state: 'FAILED' },
      },
      { actorId: String(actor._id), actorRole: 'ADMIN', requestId: 'retry-fail' },
    );

    const failedDoc = await Refund.findById(first.refundId);
    expect(failedDoc?.status).toBe('FAILED');
    expect(failedDoc?.active).toBe(false);
    const failedMerchantId = failedDoc!.merchantRefundId;

    vi.mocked(phonePeProvider.initiateRefund).mockClear();
    vi.mocked(phonePeProvider.initiateRefund).mockResolvedValue({
      state: 'PENDING',
      amountPaise: INSTALLMENT,
      providerRefundId: 'PRV-RETRY-2',
      raw: { state: 'PENDING' },
    });

    const second = await retryFailedRefund(
      String(first.refundId),
      { idempotencyKey: 'retry-second-00000002', reason: 'Ops retry after provider failure' },
      { actorId: String(actor._id), actorRole: 'ADMIN', requestId: 'retry-2' },
    );

    expect(String(second.refundId)).not.toBe(String(first.refundId));
    expect(second.merchantRefundId).not.toBe(failedMerchantId);
    expect(second.attemptNumber).toBe(2);
    expect(second.active).toBe(true);
    expect(second.status).toBe('PENDING');

    const history = await Refund.find({ paymentId: payment._id }).sort({ attemptNumber: 1 });
    expect(history).toHaveLength(2);
    expect(history[0].status).toBe('FAILED');
    expect(history[0].active).toBe(false);
    expect(history[0].merchantRefundId).toBe(failedMerchantId);
    expect(history[1].attemptNumber).toBe(2);
    expect(history[1].active).toBe(true);

    const paymentAfter = await Payment.findById(payment._id);
    expect(paymentAfter?.status).toBe('SUCCESS');
    expect(paymentAfter?.refundStatus).toBe('PENDING');
    expect(String(paymentAfter?.refundId)).toBe(String(second.refundId));
    expect(phonePeProvider.initiateRefund).toHaveBeenCalledTimes(1);
  });
});
