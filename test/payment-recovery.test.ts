import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import mongoose from 'mongoose';
import { startOfMonth } from 'date-fns';
import { fromZonedTime, toZonedTime } from 'date-fns-tz';
import {
  GoldRate,
  Payment,
  PaymentIntent,
  SchemeEnrollment,
  User,
} from '../src/models/index.js';
import { reconcilePaymentIntentStatus } from '../src/services/gateway.service.js';
import { phonePeProvider } from '../src/services/phonepe.provider.js';
import { enrollmentDates } from '../src/services/scheme.service.js';
import { BUSINESS_TZ, businessDayRange } from '../src/utils/time.js';
import {
  isPaymentPendingTooLong,
  nextPaymentRecoveryCheckAt,
  scheduleInitialStatusCheck,
} from '../src/utils/payment-recovery.js';
import {
  claimNextPaymentRecovery,
  processPaymentRecoveryBatch,
} from '../src/workers/payment-recovery.worker.js';
import { clearTestMongo, startTestMongo, stopTestMongo } from './helpers/mongo.js';

const INSTALLMENT = 100_000;

async function seedPendingIntent(overrides: Record<string, unknown> = {}) {
  const [actor] = await User.create([
    {
      name: 'Recovery User',
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
      enrollmentNumber: `ENR-REC-${Date.now()}`,
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
  let rate = await GoldRate.findOne({ effectiveFrom: todayStart, status: 'ACTIVE' });
  if (!rate) {
    [rate] = await GoldRate.create([
      {
        ratePerGramPaise: 750_000,
        purity: '916',
        effectiveFrom: todayStart,
        status: 'ACTIVE',
        createdBy: actor._id,
      },
    ]);
  }
  const merchantTransactionId = `KRL-REC-${Date.now()}-${Math.random().toString(16).slice(2, 6)}`;
  const [intent] = await PaymentIntent.create([
    {
      customerId: actor._id,
      schemeId: enrollment._id,
      amountPaise: INSTALLMENT,
      merchantTransactionId,
      checkoutChannel: 'WEB',
      status: 'PENDING',
      idempotencyKey: `rec-${merchantTransactionId}`,
      idempotencyScope: 'PHONEPE_CUSTOMER_WEB',
      requestHash: 'recovery-hash',
      goldRateId: rate._id,
      goldRatePerGramPaise: 700_000,
      goldWeightMg: 142,
      goldPurity: '916',
      schemeMonth: 1,
      quoteCreatedAt: now,
      quoteExpiresAt: new Date(now.getTime() + 15 * 60_000),
      expiresAt: new Date(now.getTime() + 20 * 60_000),
      nextStatusCheckAt: new Date(0),
      statusCheckAttempts: 0,
      collectorRole: 'CUSTOMER',
      createdBy: actor._id,
      ...overrides,
    },
  ]);
  return { actor, enrollment, intent, merchantTransactionId };
}

describe('payment recovery scheduling helpers', () => {
  it('schedules the first check ~20-25 seconds out (PhonePe UAT requirement)', () => {
    const now = new Date('2026-08-05T10:00:00.000Z');
    const deltaMs = scheduleInitialStatusCheck(now).getTime() - now.getTime();
    expect(deltaMs).toBeGreaterThanOrEqual(20_000);
    expect(deltaMs).toBeLessThanOrEqual(25_000);
  });

  it('polls every 3 seconds in the first window after the initial check', () => {
    const started = new Date('2026-08-05T10:00:00.000Z');
    const now = new Date(started.getTime() + 30_000); // inside the 22.5s-52.5s window
    expect(nextPaymentRecoveryCheckAt(started, now).getTime() - now.getTime()).toBe(3_000);
  });

  it('polls every 6 seconds in the next window', () => {
    const started = new Date('2026-08-05T10:00:00.000Z');
    const now = new Date(started.getTime() + 80_000); // inside the 52.5s-112.5s window
    expect(nextPaymentRecoveryCheckAt(started, now).getTime() - now.getTime()).toBe(6_000);
  });

  it('polls every 10 seconds in the next window', () => {
    const started = new Date('2026-08-05T10:00:00.000Z');
    const now = new Date(started.getTime() + 140_000); // inside the 112.5s-172.5s window
    expect(nextPaymentRecoveryCheckAt(started, now).getTime() - now.getTime()).toBe(10_000);
  });

  it('polls every 30 seconds in the next window', () => {
    const started = new Date('2026-08-05T10:00:00.000Z');
    const now = new Date(started.getTime() + 200_000); // inside the 172.5s-232.5s window
    expect(nextPaymentRecoveryCheckAt(started, now).getTime() - now.getTime()).toBe(30_000);
  });

  it('settles to every 60 seconds after the busy windows', () => {
    const started = new Date('2026-08-05T10:00:00.000Z');
    const now = new Date(started.getTime() + 300_000); // past the 232.5s cutoff
    expect(nextPaymentRecoveryCheckAt(started, now).getTime() - now.getTime()).toBe(60_000);
  });

  it('uses age-based backoff and never treats age alone as failure', () => {
    const started = new Date('2026-08-01T00:00:00.000Z');
    const now = new Date('2026-08-01T00:10:00.000Z');
    expect(nextPaymentRecoveryCheckAt(started, now).getTime() - now.getTime()).toBe(60_000);
    expect(isPaymentPendingTooLong(started, now)).toBe(false);
    expect(isPaymentPendingTooLong(started, new Date('2026-08-10T00:00:00.000Z'))).toBe(true);
  });
});

describe('payment recovery worker', () => {
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

  it('finalizes a pending intent when PhonePe reports SUCCESS without a webhook', async () => {
    const { intent, merchantTransactionId } = await seedPendingIntent();
    vi.spyOn(phonePeProvider, 'checkStatus').mockResolvedValue({
      state: 'SUCCESS',
      amountPaise: INSTALLMENT,
      transactionId: 'PP-REC-1',
      raw: {},
    });

    expect(await processPaymentRecoveryBatch('rec-worker-1')).toBe(1);
    const updated = await PaymentIntent.findById(intent._id);
    expect(updated?.status).toBe('SUCCESS');
    expect(updated?.finalStatusSource).toBe('RECOVERY_WORKER');
    expect(updated?.goldWeightMg).toBe(142);
    expect(await Payment.countDocuments({ merchantTransactionId })).toBe(1);
  });

  it('reschedules when PhonePe is still PENDING', async () => {
    const { intent } = await seedPendingIntent();
    vi.spyOn(phonePeProvider, 'checkStatus').mockResolvedValue({
      state: 'PENDING',
      amountPaise: INSTALLMENT,
      raw: {},
    });
    await processPaymentRecoveryBatch('rec-worker-2');
    const updated = await PaymentIntent.findById(intent._id);
    expect(updated?.status).toBe('PENDING');
    expect(updated?.nextStatusCheckAt!.getTime()).toBeGreaterThan(Date.now());
  });

  it('marks FAILED only when PhonePe returns FAILED', async () => {
    const { intent } = await seedPendingIntent();
    vi.spyOn(phonePeProvider, 'checkStatus').mockResolvedValue({
      state: 'FAILED',
      amountPaise: INSTALLMENT,
      raw: {},
    });
    await processPaymentRecoveryBatch('rec-worker-3');
    expect((await PaymentIntent.findById(intent._id))?.status).toBe('FAILED');
    expect(await Payment.countDocuments({})).toBe(0);
  });

  it('keeps PENDING on network errors', async () => {
    const { intent } = await seedPendingIntent();
    vi.spyOn(phonePeProvider, 'checkStatus').mockRejectedValue(new Error('network down'));
    await processPaymentRecoveryBatch('rec-worker-4');
    const updated = await PaymentIntent.findById(intent._id);
    expect(updated?.status).toBe('PENDING');
    expect(updated?.lastGatewayError).toMatch(/network down/i);
  });

  it('does not finalize on amount mismatch and stores an explicit marker', async () => {
    const { intent } = await seedPendingIntent();
    vi.spyOn(phonePeProvider, 'checkStatus').mockResolvedValue({
      state: 'SUCCESS',
      amountPaise: INSTALLMENT + 1,
      transactionId: 'PP-BAD',
      raw: {},
    });
    const result = await reconcilePaymentIntentStatus(
      String(intent._id),
      'RECOVERY_WORKER',
      'mismatch',
    );
    expect(result).toMatchObject({ state: 'PENDING', amountMismatch: true });
    const updated = await PaymentIntent.findById(intent._id);
    expect(updated?.status).toBe('PENDING');
    expect(updated?.lastGatewayError).toBe('GATEWAY_AMOUNT_MISMATCH');
    expect(await Payment.countDocuments({})).toBe(0);
  });

  it('uses locked gold on late confirmation', async () => {
    const oldQuote = new Date(Date.now() - 60 * 60_000);
    const { intent } = await seedPendingIntent({
      quoteCreatedAt: oldQuote,
      expiresAt: new Date(Date.now() - 30 * 60_000),
      goldRatePerGramPaise: 700_000,
      goldWeightMg: 142,
    });
    vi.spyOn(phonePeProvider, 'checkStatus').mockResolvedValue({
      state: 'SUCCESS',
      amountPaise: INSTALLMENT,
      transactionId: 'PP-LATE',
      raw: {},
    });
    await processPaymentRecoveryBatch('rec-worker-late');
    const payment = await Payment.findOne({ merchantTransactionId: intent.merchantTransactionId });
    const updated = await PaymentIntent.findById(intent._id);
    expect(payment?.goldWeightMg).toBe(142);
    expect(payment?.goldRatePerGramPaise).toBe(700_000);
    expect(updated?.wasLateConfirmation).toBe(true);
  });

  it('recovery and duplicate reconcile create exactly one payment', async () => {
    const { intent, merchantTransactionId } = await seedPendingIntent();
    vi.spyOn(phonePeProvider, 'checkStatus').mockResolvedValue({
      state: 'SUCCESS',
      amountPaise: INSTALLMENT,
      transactionId: 'PP-RACE',
      raw: {},
    });
    await Promise.all([
      reconcilePaymentIntentStatus(String(intent._id), 'RECOVERY_WORKER', 'a'),
      reconcilePaymentIntentStatus(String(intent._id), 'WEBHOOK', 'b'),
    ]);
    expect(await Payment.countDocuments({ merchantTransactionId })).toBe(1);
  });

  it('old pending intents remain recoverable and are not silently failed', async () => {
    const started = new Date(Date.now() - 8 * 24 * 60 * 60_000);
    const { intent } = await seedPendingIntent({
      quoteCreatedAt: started,
      createdAt: started,
    });
    vi.spyOn(phonePeProvider, 'checkStatus').mockResolvedValue({
      state: 'PENDING',
      amountPaise: INSTALLMENT,
      raw: {},
    });
    await processPaymentRecoveryBatch('rec-old');
    const updated = await PaymentIntent.findById(intent._id);
    expect(updated?.status).toBe('PENDING');
    expect(updated?.lastGatewayError).toBe('PAYMENT_PENDING_TOO_LONG');
  });

  it('does not claim an intent with an active recovery lease', async () => {
    await seedPendingIntent({
      recoveryLockUntil: new Date(Date.now() + 60_000),
      recoveryLockedBy: 'other',
    });
    expect(await claimNextPaymentRecovery('me')).toBeNull();
  });

  it('stops polling once an intent reaches a terminal state', async () => {
    await seedPendingIntent({ status: 'SUCCESS', nextStatusCheckAt: new Date(0) });
    await seedPendingIntent({ status: 'FAILED', nextStatusCheckAt: new Date(0) });
    await seedPendingIntent({ status: 'REVIEW_REQUIRED', nextStatusCheckAt: new Date(0) });
    expect(await claimNextPaymentRecovery('me')).toBeNull();
  });

  it('continues the batch when one item fails status check', async () => {
    const first = await seedPendingIntent();
    const second = await seedPendingIntent();
    const third = await seedPendingIntent();

    vi.spyOn(phonePeProvider, 'checkStatus').mockImplementation(async (merchantOrderId: string) => {
      if (merchantOrderId === second.merchantTransactionId) {
        throw new Error('provider boom');
      }
      return {
        state: 'SUCCESS',
        amountPaise: INSTALLMENT,
        transactionId: `PP-${merchantOrderId}`,
        raw: {},
      };
    });

    const processed = await processPaymentRecoveryBatch('rec-contain', 10);
    expect(processed).toBe(3);

    expect((await PaymentIntent.findById(first.intent._id))?.status).toBe('SUCCESS');
    expect((await PaymentIntent.findById(second.intent._id))?.status).toBe('PENDING');
    expect((await PaymentIntent.findById(third.intent._id))?.status).toBe('SUCCESS');
  });

  it('moves late PhonePe success on a closed scheme to REVIEW_REQUIRED', async () => {
    const { FinancialException } = await import('../src/models/index.js');
    const { intent, enrollment } = await seedPendingIntent();
    await SchemeEnrollment.updateOne({ _id: enrollment._id }, { $set: { status: 'CLOSED' } });
    vi.spyOn(phonePeProvider, 'checkStatus').mockResolvedValue({
      state: 'SUCCESS',
      amountPaise: INSTALLMENT,
      transactionId: 'PP-FINALIZE-FAIL',
      raw: {},
    });

    await processPaymentRecoveryBatch('rec-finalize-fail', 5);
    expect((await PaymentIntent.findById(intent._id))?.status).toBe('REVIEW_REQUIRED');
    expect(
      await FinancialException.countDocuments({
        type: 'DUPLICATE_GATEWAY_CAPTURE',
        paymentIntentId: intent._id,
      }),
    ).toBe(1);
  });
});
