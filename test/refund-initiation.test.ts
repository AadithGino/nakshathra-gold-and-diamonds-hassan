import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import mongoose from 'mongoose';
import { startOfMonth } from 'date-fns';
import { fromZonedTime, toZonedTime } from 'date-fns-tz';
import {
  Payment,
  PaymentIntent,
  Payout,
  Refund,
  SchemeEnrollment,
  User,
} from '../src/models/index.js';
import { initiatePaymentRefund } from '../src/services/refund.service.js';
import { phonePeProvider } from '../src/services/phonepe.provider.js';
import { enrollmentDates } from '../src/services/scheme.service.js';
import { BUSINESS_TZ } from '../src/utils/time.js';
import { clearTestMongo, startTestMongo, stopTestMongo } from './helpers/mongo.js';

const INSTALLMENT = 100_000;

async function seedGatewayPayment(overrides: {
  payment?: Record<string, unknown>;
  enrollment?: Record<string, unknown>;
} = {}) {
  const [actor] = await User.create([
    {
      name: 'Refund Admin',
      phone: `+9188${String(Date.now()).slice(-8)}`,
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
      enrollmentNumber: `ENR-RFD-${Date.now()}`,
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
      ...overrides.enrollment,
    },
  ]);
  const merchantTransactionId = `KRL-RFD-${Date.now()}-${Math.random().toString(16).slice(2, 6)}`;
  await PaymentIntent.create([
    {
      customerId: actor._id,
      schemeId: enrollment._id,
      amountPaise: INSTALLMENT,
      merchantTransactionId,
      checkoutChannel: 'WEB',
      status: 'SUCCESS',
      idempotencyKey: `rfd-${merchantTransactionId}`,
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
      ...overrides.payment,
    },
  ]);
  return { actor, enrollment, payment, merchantTransactionId };
}

describe('Phase 4 refund initiation', () => {
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
      providerRefundId: 'PRV-REF-1',
      raw: { state: 'PENDING' },
    });
  });

  it('creates one refund for a successful gateway payment', async () => {
    const { actor, payment } = await seedGatewayPayment();
    const result = await initiatePaymentRefund(
      String(payment._id),
      { reason: 'Customer requested cancellation', idempotencyKey: 'refund-key-0001' },
      { actorId: String(actor._id), actorRole: 'ADMIN', requestId: 'r1' },
    );
    expect(result.status).toBe('PENDING');
    expect(await Refund.countDocuments({})).toBe(1);
    const stored = await Refund.findById(result.refundId);
    expect(stored?.nextStatusCheckAt).toBeTruthy();
    expect(stored?.active).toBe(true);
    expect(stored?.providerInitiatedAt).toBeTruthy();
    const updated = await Payment.findById(payment._id);
    expect(updated?.status).toBe('SUCCESS');
    expect(updated?.refundStatus).toBe('PENDING');
    expect(updated?.amountPaise).toBe(INSTALLMENT);
    expect(updated?.goldWeightMg).toBe(142);
  });

  it('rejects manual/non-gateway payments', async () => {
    const { actor, payment } = await seedGatewayPayment({
      payment: { merchantTransactionId: undefined, providerTransactionId: undefined, method: 'CASH' },
    });
    // sparse unique allows omitting merchantTransactionId
    await Payment.updateOne(
      { _id: payment._id },
      { $unset: { merchantTransactionId: 1, providerTransactionId: 1 } },
    );
    await expect(
      initiatePaymentRefund(
        String(payment._id),
        { reason: 'Cash refund attempt', idempotencyKey: 'cash-key-0001' },
        { actorId: String(actor._id), actorRole: 'ADMIN', requestId: 'r2' },
      ),
    ).rejects.toMatchObject({ code: 'REFUND_NOT_GATEWAY_PAYMENT' });
  });

  it('rejects non-SUCCESS payments', async () => {
    const { actor, payment } = await seedGatewayPayment({
      payment: { status: 'REVERSED', schemeMonth: 2 },
    });
    await expect(
      initiatePaymentRefund(
        String(payment._id),
        { reason: 'Already reversed', idempotencyKey: 'rev-key-0001' },
        { actorId: String(actor._id), actorRole: 'ADMIN', requestId: 'r3' },
      ),
    ).rejects.toMatchObject({ code: 'PAYMENT_NOT_REFUNDABLE' });
  });

  it('rejects redeemed schemes with REFUND_BLOCKED_AFTER_REDEMPTION', async () => {
    const { actor, payment, enrollment } = await seedGatewayPayment({
      enrollment: { status: 'REDEEMED' },
    });
    expect(enrollment.status).toBe('REDEEMED');
    await expect(
      initiatePaymentRefund(
        String(payment._id),
        { reason: 'After redemption', idempotencyKey: 'red-key-0001' },
        { actorId: String(actor._id), actorRole: 'ADMIN', requestId: 'r4' },
      ),
    ).rejects.toMatchObject({ code: 'REFUND_BLOCKED_AFTER_REDEMPTION' });
  });

  it('rejects when a successful payout exists', async () => {
    const { actor, payment, enrollment } = await seedGatewayPayment();
    await Payout.create({
      customerId: enrollment.customerId,
      schemeId: enrollment._id,
      amountPaise: INSTALLMENT,
      goldWeightMg: 142,
      payoutType: 'REDEEM',
      method: 'GOLD',
      payoutDate: new Date(),
      status: 'SUCCESS',
      createdBy: actor._id,
    });
    await expect(
      initiatePaymentRefund(
        String(payment._id),
        { reason: 'After payout', idempotencyKey: 'po-key-0001' },
        { actorId: String(actor._id), actorRole: 'ADMIN', requestId: 'r5' },
      ),
    ).rejects.toMatchObject({ code: 'REFUND_BLOCKED_AFTER_REDEMPTION' });
  });

  it('returns the same refund for identical idempotency retries', async () => {
    const { actor, payment } = await seedGatewayPayment();
    const input = { reason: 'Duplicate safe', idempotencyKey: 'same-key-0001' };
    const first = await initiatePaymentRefund(String(payment._id), input, {
      actorId: String(actor._id),
      actorRole: 'ADMIN',
      requestId: 'r6a',
    });
    const second = await initiatePaymentRefund(String(payment._id), input, {
      actorId: String(actor._id),
      actorRole: 'ADMIN',
      requestId: 'r6b',
    });
    expect(String(second.refundId)).toBe(String(first.refundId));
    expect(await Refund.countDocuments({})).toBe(1);
  });

  it('rejects changed payload with the same idempotency key', async () => {
    const { actor, payment } = await seedGatewayPayment();
    await initiatePaymentRefund(
      String(payment._id),
      { reason: 'Original reason text', idempotencyKey: 'reuse-key-0001' },
      { actorId: String(actor._id), actorRole: 'ADMIN', requestId: 'r7a' },
    );
    await expect(
      initiatePaymentRefund(
        String(payment._id),
        { reason: 'Changed reason text!', idempotencyKey: 'reuse-key-0001' },
        { actorId: String(actor._id), actorRole: 'ADMIN', requestId: 'r7b' },
      ),
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_KEY_REUSED' });
  });

  it('rejects partial amount with PARTIAL_REFUND_NOT_SUPPORTED', async () => {
    const { actor, payment } = await seedGatewayPayment();
    await expect(
      initiatePaymentRefund(
        String(payment._id),
        {
          reason: 'Partial attempt',
          idempotencyKey: 'partial-key-0001',
          amountPaise: INSTALLMENT - 1,
        },
        { actorId: String(actor._id), actorRole: 'ADMIN', requestId: 'r8' },
      ),
    ).rejects.toMatchObject({ code: 'PARTIAL_REFUND_NOT_SUPPORTED' });
  });

  it('does not create a second refund when PhonePe times out after local create', async () => {
    const { actor, payment } = await seedGatewayPayment();
    vi.spyOn(phonePeProvider, 'initiateRefund').mockRejectedValue(new Error('timeout'));
    const first = await initiatePaymentRefund(
      String(payment._id),
      { reason: 'Network uncertain', idempotencyKey: 'timeout-key-0001' },
      { actorId: String(actor._id), actorRole: 'ADMIN', requestId: 'r9a' },
    );
    expect(first.status).toBe('INITIATED');
    const stored = await Refund.findById(first.refundId);
    expect(stored?.nextStatusCheckAt).toBeTruthy();
    expect(stored?.providerInitiatedAt).toBeUndefined();
    expect(stored?.lastProviderError).toMatch(/timeout/);
    const second = await initiatePaymentRefund(
      String(payment._id),
      { reason: 'Network uncertain', idempotencyKey: 'timeout-key-0001' },
      { actorId: String(actor._id), actorRole: 'ADMIN', requestId: 'r9b' },
    );
    expect(String(second.refundId)).toBe(String(first.refundId));
    expect(await Refund.countDocuments({})).toBe(1);
  });
});
