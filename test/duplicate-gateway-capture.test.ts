import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { startOfMonth } from 'date-fns';
import { fromZonedTime, toZonedTime } from 'date-fns-tz';
import {
  FinancialException,
  GoldRate,
  Payment,
  PaymentIntent,
  SchemeEnrollment,
  User,
} from '../src/models/index.js';
import { reconcilePaymentIntentStatus } from '../src/services/gateway.service.js';
import { phonePeProvider } from '../src/services/phonepe.provider.js';
import { enrollmentDates } from '../src/services/scheme.service.js';
import { claimablePaymentRecoveryFilter } from '../src/utils/mongo-filter.js';
import { BUSINESS_TZ, businessDayRange } from '../src/utils/time.js';
import { processPaymentRecoveryBatch } from '../src/workers/payment-recovery.worker.js';
import { clearTestMongo, startTestMongo, stopTestMongo } from './helpers/mongo.js';

const INSTALLMENT = 100_000;

async function seedFixtureWithExistingPayment() {
  const [actor] = await User.create([
    {
      name: 'Duplicate Capture User',
      phone: '+919888200001',
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
      enrollmentNumber: 'ENR-DUP-001',
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

  // An installment for schemeMonth 1 is already successfully paid by a prior attempt.
  const [existingPayment] = await Payment.create([
    {
      customerId: actor._id,
      schemeId: enrollment._id,
      amountPaise: INSTALLMENT,
      method: 'UPI',
      status: 'SUCCESS',
      paymentDate: now,
      schemeMonth: 1,
      merchantTransactionId: `KRL-DUP-EXISTING-${Date.now()}`,
      providerTransactionId: `PP-DUP-EXISTING-${Date.now()}`,
      collectorRole: 'CUSTOMER',
      goldRateId: rate._id,
      goldRatePerGramPaise: 750_000,
      goldWeightMg: 133,
      goldPurity: '916',
      createdBy: actor._id,
    },
  ]);

  // A second, different PaymentIntent later also claims schemeMonth 1.
  const merchantTransactionId = `KRL-DUP-SECOND-${Date.now()}`;
  const [intent] = await PaymentIntent.create([
    {
      customerId: actor._id,
      schemeId: enrollment._id,
      amountPaise: INSTALLMENT,
      merchantTransactionId,
      checkoutChannel: 'WEB',
      status: 'PENDING',
      idempotencyKey: `dup-${merchantTransactionId}`,
      idempotencyScope: 'PHONEPE_CUSTOMER_WEB',
      requestHash: 'duplicate-capture-fixture-hash',
      goldRateId: rate._id,
      goldRatePerGramPaise: 750_000,
      goldWeightMg: 133,
      goldPurity: '916',
      schemeMonth: 1,
      quoteCreatedAt: now,
      quoteExpiresAt: new Date(now.getTime() + 15 * 60_000),
      expiresAt: new Date(now.getTime() + 20 * 60_000),
      nextStatusCheckAt: new Date(0),
      statusCheckAttempts: 0,
      collectorRole: 'CUSTOMER',
      createdBy: actor._id,
      activeAttemptKey: `PHONEPE:${enrollment._id}:1`,
    },
  ]);

  return { actor, enrollment, existingPayment, intent, merchantTransactionId };
}

describe('duplicate PhonePe gateway capture containment', () => {
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

  it('never creates a second SUCCESS payment, marks the intent REVIEW_REQUIRED, and raises a CRITICAL financial exception', async () => {
    const { intent, existingPayment, enrollment } = await seedFixtureWithExistingPayment();

    vi.spyOn(phonePeProvider, 'checkStatus').mockResolvedValue({
      state: 'SUCCESS',
      amountPaise: INSTALLMENT,
      transactionId: 'PP-DUPLICATE-CAPTURE',
      raw: {},
    });

    const result = await reconcilePaymentIntentStatus(
      String(intent._id),
      'RECOVERY_WORKER',
      'duplicate-capture-1',
    );
    expect(result.state).toBe('REVIEW_REQUIRED');

    // No second SUCCESS payment for this installment, and the original is untouched.
    expect(
      await Payment.countDocuments({ schemeId: enrollment._id, schemeMonth: 1, status: 'SUCCESS' }),
    ).toBe(1);
    const stillOriginal = await Payment.findById(existingPayment._id);
    expect(stillOriginal?.status).toBe('SUCCESS');
    expect(stillOriginal?.amountPaise).toBe(INSTALLMENT);

    const updated = await PaymentIntent.findById(intent._id);
    expect(updated?.status).toBe('REVIEW_REQUIRED');
    expect(updated?.lastGatewayError).toBe('DUPLICATE_GATEWAY_CAPTURE');
    expect(updated?.nextStatusCheckAt).toBeFalsy();
    expect(updated?.activeAttemptKey).toBeFalsy();
    expect(updated?.confirmedAt).toBeTruthy();

    const exception = await FinancialException.findOne({
      type: 'DUPLICATE_GATEWAY_CAPTURE',
      paymentIntentId: intent._id,
    });
    expect(exception).toBeTruthy();
    expect(exception?.severity).toBe('CRITICAL');
    expect(String(exception?.paymentId)).toBe(String(existingPayment._id));
    expect(exception?.customerId).toBeTruthy();
  });

  it('never re-polls a REVIEW_REQUIRED intent (no future recovery loop)', async () => {
    const { intent } = await seedFixtureWithExistingPayment();
    vi.spyOn(phonePeProvider, 'checkStatus').mockResolvedValue({
      state: 'SUCCESS',
      amountPaise: INSTALLMENT,
      transactionId: 'PP-DUPLICATE-CAPTURE-2',
      raw: {},
    });
    await reconcilePaymentIntentStatus(String(intent._id), 'RECOVERY_WORKER', 'duplicate-capture-2');

    const updated = await PaymentIntent.findById(intent._id);
    expect(updated?.status).toBe('REVIEW_REQUIRED');

    // The recovery worker's own claim filter must never match a REVIEW_REQUIRED intent.
    const claimable = await PaymentIntent.findOne(
      claimablePaymentRecoveryFilter(new Date(Date.now() + 60_000)),
    );
    expect(claimable).toBeNull();

    // A batch run must not touch it (and must not throw retrying forever).
    const checkStatusCallsBefore = (phonePeProvider.checkStatus as any).mock.calls.length;
    await processPaymentRecoveryBatch('dup-capture-worker');
    const checkStatusCallsAfter = (phonePeProvider.checkStatus as any).mock.calls.length;
    expect(checkStatusCallsAfter).toBe(checkStatusCallsBefore);

    const stillReview = await PaymentIntent.findById(intent._id);
    expect(stillReview?.status).toBe('REVIEW_REQUIRED');
  });

  it('a second reconcile call on an already REVIEW_REQUIRED intent is a no-op skip', async () => {
    const { intent } = await seedFixtureWithExistingPayment();
    vi.spyOn(phonePeProvider, 'checkStatus').mockResolvedValue({
      state: 'SUCCESS',
      amountPaise: INSTALLMENT,
      transactionId: 'PP-DUPLICATE-CAPTURE-3',
      raw: {},
    });
    await reconcilePaymentIntentStatus(String(intent._id), 'RECOVERY_WORKER', 'first');
    const second = await reconcilePaymentIntentStatus(String(intent._id), 'WEBHOOK', 'second');
    expect(second).toMatchObject({ state: 'REVIEW_REQUIRED', skipped: true });
    expect(await Payment.countDocuments({})).toBe(1);
  });
});
