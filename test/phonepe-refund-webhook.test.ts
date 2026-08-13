import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { startOfMonth } from 'date-fns';
import { fromZonedTime, toZonedTime } from 'date-fns-tz';
import {
  GoldRate,
  Payment,
  PaymentGatewayEvent,
  PaymentIntent,
  Refund,
  SchemeEnrollment,
  User,
} from '../src/models/index.js';
import { processPhonePeWebhook } from '../src/services/gateway.service.js';
import { phonePeProvider } from '../src/services/phonepe.provider.js';
import { enrollmentDates } from '../src/services/scheme.service.js';
import { BUSINESS_TZ, businessDayRange } from '../src/utils/time.js';
import { clearTestMongo, startTestMongo, stopTestMongo } from './helpers/mongo.js';

const INSTALLMENT = 100_000;

function bodyFor(payload: unknown) {
  return Buffer.from(JSON.stringify(payload));
}

async function seedFixture() {
  const [actor] = await User.create([
    {
      name: 'Webhook User',
      phone: `+9199${String(Date.now()).slice(-8)}`,
      passwordHash: 'hash',
      role: 'CUSTOMER',
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
      enrollmentNumber: `ENR-WH-${Date.now()}`,
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
  const { start: todayStart } = businessDayRange(now);
  const [rate] = await GoldRate.create([
    {
      ratePerGramPaise: 750_000,
      purity: '916',
      effectiveFrom: todayStart,
      status: 'ACTIVE',
      createdBy: actor._id,
    },
  ]);
  return { actor, enrollment, rate };
}

async function seedPendingIntent() {
  const { actor, enrollment, rate } = await seedFixture();
  const merchantTransactionId = `KRL-WH-${Date.now()}-${Math.random().toString(16).slice(2, 6)}`;
  const [intent] = await PaymentIntent.create([
    {
      customerId: actor._id,
      schemeId: enrollment._id,
      amountPaise: INSTALLMENT,
      merchantTransactionId,
      checkoutChannel: 'WEB',
      status: 'PENDING',
      idempotencyKey: `wh-${merchantTransactionId}`,
      idempotencyScope: 'PHONEPE_CUSTOMER_WEB',
      requestHash: 'webhook-fixture-hash',
      goldRateId: rate._id,
      goldRatePerGramPaise: 750_000,
      goldWeightMg: 133,
      goldPurity: '916',
      schemeMonth: 1,
      quoteCreatedAt: new Date(),
      quoteExpiresAt: new Date(Date.now() + 15 * 60_000),
      expiresAt: new Date(Date.now() + 20 * 60_000),
      nextStatusCheckAt: new Date(0),
      statusCheckAttempts: 0,
      collectorRole: 'CUSTOMER',
      createdBy: actor._id,
      activeAttemptKey: `PHONEPE:${enrollment._id}:1`,
    },
  ]);
  return { actor, enrollment, intent, merchantTransactionId };
}

async function seedRefundableFixture() {
  const { actor, enrollment, rate } = await seedFixture();
  const merchantTransactionId = `KRL-WH-PAY-${Date.now()}`;
  const [payment] = await Payment.create([
    {
      customerId: actor._id,
      schemeId: enrollment._id,
      amountPaise: INSTALLMENT,
      method: 'UPI',
      status: 'SUCCESS',
      paymentDate: new Date(),
      schemeMonth: 1,
      merchantTransactionId,
      providerTransactionId: `PP-WH-${Date.now()}`,
      collectorRole: 'CUSTOMER',
      goldRateId: rate._id,
      goldRatePerGramPaise: 750_000,
      goldWeightMg: 133,
      goldPurity: '916',
      createdBy: actor._id,
    },
  ]);
  const merchantRefundId = `RFD-WH-${Date.now()}`;
  const [refund] = await Refund.create([
    {
      paymentId: payment._id,
      customerId: actor._id,
      schemeId: enrollment._id,
      provider: 'PHONEPE',
      merchantRefundId,
      originalMerchantOrderId: merchantTransactionId,
      amountPaise: INSTALLMENT,
      status: 'PENDING',
      attemptNumber: 1,
      active: true,
      reason: 'test refund',
      idempotencyKey: `wh-refund-${merchantRefundId}`,
      requestHash: 'webhook-refund-fixture-hash',
      requestedBy: actor._id,
      requestedAt: new Date(),
      providerInitiatedAt: new Date(),
      nextStatusCheckAt: new Date(0),
      statusCheckAttempts: 0,
    },
  ]);
  return { actor, enrollment, payment, refund, merchantTransactionId, merchantRefundId };
}

describe('PhonePe webhook routing (payment vs refund events)', () => {
  beforeAll(async () => {
    await startTestMongo();
  }, 120_000);

  afterAll(async () => {
    await stopTestMongo();
  });

  beforeEach(async () => {
    await clearTestMongo();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('checkout.order.completed routes through payment reconciliation', async () => {
    const { intent, merchantTransactionId } = await seedPendingIntent();
    vi.spyOn(phonePeProvider, 'verifyWebhook').mockReturnValue({
      kind: 'PAYMENT',
      event: 'checkout.order.completed',
      merchantOrderId: merchantTransactionId,
      amountPaise: INSTALLMENT,
      state: 'COMPLETED',
      raw: {},
    });
    vi.spyOn(phonePeProvider, 'checkStatus').mockResolvedValue({
      state: 'SUCCESS',
      amountPaise: INSTALLMENT,
      transactionId: 'PP-WEBHOOK-1',
      raw: {},
    });

    const result = await processPhonePeWebhook('auth', bodyFor({ n: 1 }), 'wh-1');
    expect(result).toMatchObject({ processed: true, state: 'SUCCESS' });
    expect((await PaymentIntent.findById(intent._id))?.status).toBe('SUCCESS');
  });

  it('checkout.order.failed routes through payment reconciliation', async () => {
    const { intent, merchantTransactionId } = await seedPendingIntent();
    vi.spyOn(phonePeProvider, 'verifyWebhook').mockReturnValue({
      kind: 'PAYMENT',
      event: 'checkout.order.failed',
      merchantOrderId: merchantTransactionId,
      amountPaise: INSTALLMENT,
      state: 'FAILED',
      raw: {},
    });
    vi.spyOn(phonePeProvider, 'checkStatus').mockResolvedValue({
      state: 'FAILED',
      amountPaise: INSTALLMENT,
      raw: {},
    });

    const result = await processPhonePeWebhook('auth', bodyFor({ n: 2 }), 'wh-2');
    expect(result).toMatchObject({ processed: true, state: 'FAILED' });
    expect((await PaymentIntent.findById(intent._id))?.status).toBe('FAILED');
  });

  it('pg.refund.completed looks up Refund by merchantRefundId and finalizes via checkRefundStatus', async () => {
    const { refund, merchantRefundId, merchantTransactionId, payment } = await seedRefundableFixture();
    vi.spyOn(phonePeProvider, 'verifyWebhook').mockReturnValue({
      kind: 'REFUND',
      event: 'pg.refund.completed',
      merchantRefundId,
      originalMerchantOrderId: merchantTransactionId,
      amountPaise: INSTALLMENT,
      state: 'COMPLETED',
      raw: {},
    });
    vi.spyOn(phonePeProvider, 'checkRefundStatus').mockResolvedValue({
      state: 'SUCCESS',
      amountPaise: INSTALLMENT,
      providerRefundId: 'PPR-WEBHOOK-1',
      raw: {},
    });

    const result = await processPhonePeWebhook('auth', bodyFor({ n: 3 }), 'wh-3');
    expect(result).toMatchObject({ processed: true, state: 'SUCCESS' });
    expect((await Refund.findById(refund._id))?.status).toBe('SUCCESS');
    expect((await Payment.findById(payment._id))?.status).toBe('REFUNDED');
  });

  it('pg.refund.failed looks up Refund by merchantRefundId', async () => {
    const { refund, merchantRefundId, merchantTransactionId } = await seedRefundableFixture();
    vi.spyOn(phonePeProvider, 'verifyWebhook').mockReturnValue({
      kind: 'REFUND',
      event: 'pg.refund.failed',
      merchantRefundId,
      originalMerchantOrderId: merchantTransactionId,
      amountPaise: INSTALLMENT,
      state: 'FAILED',
      raw: {},
    });
    vi.spyOn(phonePeProvider, 'checkRefundStatus').mockResolvedValue({
      state: 'FAILED',
      amountPaise: INSTALLMENT,
      errorCode: 'REFUND_DECLINED',
      raw: {},
    });

    const result = await processPhonePeWebhook('auth', bodyFor({ n: 4 }), 'wh-4');
    expect(result).toMatchObject({ processed: true, state: 'FAILED' });
    expect((await Refund.findById(refund._id))?.status).toBe('FAILED');
  });

  it('refund webhook amount mismatch cannot finalize', async () => {
    const { merchantRefundId, merchantTransactionId, refund } = await seedRefundableFixture();
    vi.spyOn(phonePeProvider, 'verifyWebhook').mockReturnValue({
      kind: 'REFUND',
      event: 'pg.refund.completed',
      merchantRefundId,
      originalMerchantOrderId: merchantTransactionId,
      amountPaise: INSTALLMENT + 1,
      state: 'COMPLETED',
      raw: {},
    });

    await expect(processPhonePeWebhook('auth', bodyFor({ n: 5 }), 'wh-5')).rejects.toMatchObject({
      code: 'GATEWAY_VERIFICATION_FAILED',
      statusCode: 409,
    });
    expect((await Refund.findById(refund._id))?.status).toBe('PENDING');
  });

  it('refund webhook wrong originalMerchantOrderId cannot finalize', async () => {
    const { merchantRefundId, refund } = await seedRefundableFixture();
    vi.spyOn(phonePeProvider, 'verifyWebhook').mockReturnValue({
      kind: 'REFUND',
      event: 'pg.refund.completed',
      merchantRefundId,
      originalMerchantOrderId: 'KRL-SOME-OTHER-ORDER',
      amountPaise: INSTALLMENT,
      state: 'COMPLETED',
      raw: {},
    });

    await expect(processPhonePeWebhook('auth', bodyFor({ n: 6 }), 'wh-6')).rejects.toMatchObject({
      code: 'GATEWAY_VERIFICATION_FAILED',
      statusCode: 409,
    });
    expect((await Refund.findById(refund._id))?.status).toBe('PENDING');
  });

  it('refund webhook body claiming SUCCESS is not sufficient without a real checkRefundStatus call', async () => {
    const { merchantRefundId, merchantTransactionId, refund } = await seedRefundableFixture();
    vi.spyOn(phonePeProvider, 'verifyWebhook').mockReturnValue({
      kind: 'REFUND',
      event: 'pg.refund.completed',
      merchantRefundId,
      originalMerchantOrderId: merchantTransactionId,
      amountPaise: INSTALLMENT,
      state: 'COMPLETED', // webhook body says success
      raw: {},
    });
    // But the authoritative provider check says it is still pending.
    const checkRefundStatus = vi.spyOn(phonePeProvider, 'checkRefundStatus').mockResolvedValue({
      state: 'PENDING',
      amountPaise: INSTALLMENT,
      raw: {},
    });

    const result = await processPhonePeWebhook('auth', bodyFor({ n: 7 }), 'wh-7');
    expect(checkRefundStatus).toHaveBeenCalledWith(merchantRefundId);
    expect(result).toMatchObject({ processed: true, state: 'PENDING' });
    expect((await Refund.findById(refund._id))?.status).toBe('PENDING');
  });

  it('duplicate refund webhook (same payload) is idempotent', async () => {
    const { merchantRefundId, merchantTransactionId, refund } = await seedRefundableFixture();
    vi.spyOn(phonePeProvider, 'verifyWebhook').mockReturnValue({
      kind: 'REFUND',
      event: 'pg.refund.completed',
      merchantRefundId,
      originalMerchantOrderId: merchantTransactionId,
      amountPaise: INSTALLMENT,
      state: 'COMPLETED',
      raw: {},
    });
    vi.spyOn(phonePeProvider, 'checkRefundStatus').mockResolvedValue({
      state: 'SUCCESS',
      amountPaise: INSTALLMENT,
      providerRefundId: 'PPR-DUP-1',
      raw: {},
    });

    const body = bodyFor({ n: 8 });
    const first = await processPhonePeWebhook('auth', body, 'wh-8a');
    expect(first).toMatchObject({ processed: true, state: 'SUCCESS' });
    const second = await processPhonePeWebhook('auth', body, 'wh-8b');
    expect(second).toMatchObject({ duplicate: true });

    expect(await Refund.countDocuments({ _id: refund._id, status: 'SUCCESS' })).toBe(1);
    expect(await PaymentGatewayEvent.countDocuments({ merchantRefundId })).toBe(1);
  });

  it('refund webhook and recovery worker racing finalize exactly once', async () => {
    const { merchantRefundId, merchantTransactionId, refund, payment } = await seedRefundableFixture();
    vi.spyOn(phonePeProvider, 'verifyWebhook').mockReturnValue({
      kind: 'REFUND',
      event: 'pg.refund.completed',
      merchantRefundId,
      originalMerchantOrderId: merchantTransactionId,
      amountPaise: INSTALLMENT,
      state: 'COMPLETED',
      raw: {},
    });
    vi.spyOn(phonePeProvider, 'checkRefundStatus').mockResolvedValue({
      state: 'SUCCESS',
      amountPaise: INSTALLMENT,
      providerRefundId: 'PPR-RACE-1',
      raw: {},
    });

    const { reconcileRefundStatus } = await import('../src/services/refund.service.js');
    await Promise.all([
      processPhonePeWebhook('auth', bodyFor({ n: 9 }), 'wh-9-webhook'),
      reconcileRefundStatus(String(refund._id), { requestId: 'wh-9-worker', actorRole: 'ADMIN' }),
    ]);

    expect((await Refund.findById(refund._id))?.status).toBe('SUCCESS');
    expect((await Payment.findById(payment._id))?.status).toBe('REFUNDED');
  });

  it('records an authenticated but unrecognized event without any financial mutation', async () => {
    vi.spyOn(phonePeProvider, 'verifyWebhook').mockReturnValue({
      kind: 'UNKNOWN',
      event: 'pg.some.future.event',
      raw: { future: true },
    });

    const result = await processPhonePeWebhook('auth', bodyFor({ n: 10 }), 'wh-10');
    expect(result).toMatchObject({ processed: true, ignored: true });
    expect(await PaymentGatewayEvent.countDocuments({ eventType: 'pg.some.future.event' })).toBe(1);

    // Calling it again with the same body must be a no-op duplicate, not a crash.
    const second = await processPhonePeWebhook('auth', bodyFor({ n: 10 }), 'wh-10b');
    expect(second).toMatchObject({ duplicate: true });
  });
});
