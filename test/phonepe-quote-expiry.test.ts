import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { startOfMonth } from 'date-fns';
import { fromZonedTime, toZonedTime } from 'date-fns-tz';
import {
  Customer,
  GoldRate,
  Payment,
  PaymentIntent,
  SchemeEnrollment,
  SystemSetting,
  User,
} from '../src/models/index.js';
import { initiatePhonePe, reconcilePaymentIntentStatus } from '../src/services/gateway.service.js';
import { phonePeProvider } from '../src/services/phonepe.provider.js';
import { enrollmentDates } from '../src/services/scheme.service.js';
import { BUSINESS_TZ, businessDayRange } from '../src/utils/time.js';
import { clearTestMongo, startTestMongo, stopTestMongo } from './helpers/mongo.js';

const INSTALLMENT = 100_000;

async function seedFixture() {
  const [user] = await User.create([
    {
      name: 'Quote Expiry Customer',
      phone: '+919888300001',
      passwordHash: 'hash',
      role: 'CUSTOMER',
      status: 'ACTIVE',
    },
  ]);
  const [customer] = await Customer.create([
    {
      userId: user._id,
      customerCode: 'CUST-QUOTE-001',
      status: 'ACTIVE',
      kycStatus: 'VERIFIED',
      createdBy: user._id,
    },
  ]);

  const now = new Date();
  const startLocal = startOfMonth(toZonedTime(now, BUSINESS_TZ));
  const startDate = fromZonedTime(startLocal, BUSINESS_TZ);
  const dates = enrollmentDates(startDate, 11, 11);
  const [enrollment] = await SchemeEnrollment.create([
    {
      customerId: customer._id,
      schemePlanId: user._id,
      enrollmentNumber: 'ENR-QUOTE-001',
      schemeType: 'GOLD_WEIGHT',
      startDate,
      flexiblePeriodEndDate: dates.flexiblePeriodEndDate,
      maturityDate: dates.maturityDate,
      redemptionStartDate: dates.redemptionStartDate,
      redemptionEndDate: dates.redemptionEndDate,
      durationMonths: 11,
      flexibleMonths: 11,
      monthlyInstallmentPaise: INSTALLMENT,
      makingChargeWaiverPercent: 100,
      gstRateBasisPoints: 300,
      status: 'ACTIVE',
      createdBy: user._id,
    },
  ]);

  const { start: todayStart } = businessDayRange(now);
  await GoldRate.create([
    {
      ratePerGramPaise: 750_000,
      purity: '916',
      effectiveFrom: todayStart,
      status: 'ACTIVE',
      createdBy: user._id,
    },
  ]);
  await SystemSetting.create([{ singletonKey: 'GLOBAL', customerPhonePeEnabled: true }]);

  return { user, customer, enrollment };
}

describe('PhonePe order expiry stays aligned with the locked gold quote', () => {
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

  it('passes expireAfterSeconds derived from the 15-minute quote TTL to PhonePe', async () => {
    const { user, enrollment } = await seedFixture();
    let capturedExpireAfterSeconds: number | undefined;
    vi.spyOn(phonePeProvider, 'createPayment').mockImplementation(async (input: any) => {
      capturedExpireAfterSeconds = input.expireAfterSeconds;
      return {
        providerOrderId: `ORD-${input.merchantOrderId}`,
        state: 'PENDING',
        redirectUrl: 'https://phonepe.test/checkout',
        expiresAt: new Date(Date.now() + input.expireAfterSeconds * 1000),
      };
    });

    await initiatePhonePe(
      String(user._id),
      {
        schemeId: String(enrollment._id),
        amountPaise: INSTALLMENT,
        schemeMonth: 1,
        idempotencyKey: 'quote-expiry-aligned-0001',
      },
      'quote-expiry-1',
      'http://localhost:5173',
    );

    expect(capturedExpireAfterSeconds).toBeGreaterThan(895);
    expect(capturedExpireAfterSeconds).toBeLessThanOrEqual(900);

    const intent = await PaymentIntent.findOne({ idempotencyKey: 'quote-expiry-aligned-0001' });
    expect(intent?.expiresAt!.getTime()).toBeLessThanOrEqual(intent!.quoteExpiresAt!.getTime());
  });

  it('clamps a provider-reported expiry that would outlive the locked quote', async () => {
    const { user, enrollment } = await seedFixture();
    vi.spyOn(phonePeProvider, 'createPayment').mockImplementation(async (input: any) => ({
      providerOrderId: `ORD-${input.merchantOrderId}`,
      state: 'PENDING',
      redirectUrl: 'https://phonepe.test/checkout',
      // Provider claims a much longer expiry than the quote allows.
      expiresAt: new Date(Date.now() + 60 * 60_000),
    }));

    await initiatePhonePe(
      String(user._id),
      {
        schemeId: String(enrollment._id),
        amountPaise: INSTALLMENT,
        schemeMonth: 1,
        idempotencyKey: 'quote-expiry-clamp-0001',
      },
      'quote-expiry-2',
      'http://localhost:5173',
    );

    const intent = await PaymentIntent.findOne({ idempotencyKey: 'quote-expiry-clamp-0001' });
    expect(intent?.expiresAt!.getTime()).toBeLessThanOrEqual(intent!.quoteExpiresAt!.getTime());
  });

  it('does not discard a provider SUCCESS learned after the quote/order has expired', async () => {
    const { user, enrollment } = await seedFixture();
    vi.spyOn(phonePeProvider, 'createPayment').mockImplementation(async (input: any) => ({
      providerOrderId: `ORD-${input.merchantOrderId}`,
      state: 'PENDING',
      redirectUrl: 'https://phonepe.test/checkout',
      expiresAt: new Date(Date.now() + 900_000),
    }));

    await initiatePhonePe(
      String(user._id),
      {
        schemeId: String(enrollment._id),
        amountPaise: INSTALLMENT,
        schemeMonth: 1,
        idempotencyKey: 'late-success-after-expiry-0001',
      },
      'late-success-1',
      'http://localhost:5173',
    );
    vi.restoreAllMocks();

    const intent = await PaymentIntent.findOne({
      idempotencyKey: 'late-success-after-expiry-0001',
    });
    // Simulate the quote/order window having already elapsed by the time PhonePe confirms.
    await PaymentIntent.updateOne(
      { _id: intent!._id },
      {
        $set: {
          quoteCreatedAt: new Date(Date.now() - 30 * 60_000),
          quoteExpiresAt: new Date(Date.now() - 15 * 60_000),
          expiresAt: new Date(Date.now() - 15 * 60_000),
        },
      },
    );

    const providerCompletedAt = new Date();
    vi.spyOn(phonePeProvider, 'checkStatus').mockResolvedValue({
      state: 'SUCCESS',
      amountPaise: INSTALLMENT,
      transactionId: 'PP-LATE-CONFIRM',
      providerCompletedAt,
      raw: {},
    });

    const result = await reconcilePaymentIntentStatus(
      String(intent!._id),
      'RECOVERY_WORKER',
      'late-success-reconcile',
    );
    expect(result.state).toBe('SUCCESS');

    const updated = await PaymentIntent.findById(intent!._id);
    expect(updated?.status).toBe('SUCCESS');
    expect(updated?.wasLateConfirmation).toBe(true);
    expect(updated?.providerCompletedAt?.getTime()).toBe(providerCompletedAt.getTime());

    const payment = await Payment.findOne({ merchantTransactionId: intent!.merchantTransactionId });
    expect(payment?.status).toBe('SUCCESS');
    expect(payment?.providerCompletedAt?.getTime()).toBe(providerCompletedAt.getTime());
    expect(payment?.recognizedAt).toBeTruthy();
  });
});
