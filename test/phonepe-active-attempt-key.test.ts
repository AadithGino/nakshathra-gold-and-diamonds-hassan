import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { startOfMonth } from 'date-fns';
import { fromZonedTime, toZonedTime } from 'date-fns-tz';
import {
  Customer,
  GoldRate,
  PaymentIntent,
  SchemeEnrollment,
  SystemSetting,
  User,
} from '../src/models/index.js';
import {
  initiatePhonePe,
  initiatePhonePeSdkOrder,
  reconcilePaymentIntentStatus,
} from '../src/services/gateway.service.js';
import { phonePeProvider } from '../src/services/phonepe.provider.js';
import { enrollmentDates } from '../src/services/scheme.service.js';
import { BUSINESS_TZ, businessDayRange } from '../src/utils/time.js';
import { clearTestMongo, startTestMongo, stopTestMongo } from './helpers/mongo.js';

const INSTALLMENT = 100_000;

async function seedFixture() {
  const [user] = await User.create([
    {
      name: 'Active Attempt Customer',
      phone: '+919888100001',
      passwordHash: 'hash',
      role: 'CUSTOMER',
      status: 'ACTIVE',
    },
  ]);
  const [customer] = await Customer.create([
    {
      userId: user._id,
      customerCode: 'CUST-ATTEMPT-001',
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
      enrollmentNumber: 'ENR-ATTEMPT-001',
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

function pendingCheckout(input: { merchantOrderId: string }) {
  return {
    providerOrderId: `ORD-${input.merchantOrderId}`,
    state: 'PENDING',
    redirectUrl: 'https://phonepe.test/checkout',
    expiresAt: new Date(Date.now() + 600_000),
  };
}

function pendingSdkOrder(input: { merchantOrderId: string }) {
  return {
    orderId: `ORD-${input.merchantOrderId}`,
    state: 'PENDING',
    token: `TOKEN-${input.merchantOrderId}`,
    expiresAt: new Date(Date.now() + 600_000),
  };
}

describe('PhonePe active attempt reservation (at most one live order per installment)', () => {
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

  it('two concurrent requests, same scheme+month, different idempotency keys => exactly one PaymentIntent owns activeAttemptKey and provider create runs once', async () => {
    const { user, enrollment } = await seedFixture();
    let createCalls = 0;
    vi.spyOn(phonePeProvider, 'createPayment').mockImplementation(async (input: any) => {
      createCalls += 1;
      await new Promise((r) => setTimeout(r, 50));
      return pendingCheckout(input);
    });

    const results = await Promise.allSettled(
      Array.from({ length: 5 }, (_, i) =>
        initiatePhonePe(
          String(user._id),
          {
            schemeId: String(enrollment._id),
            amountPaise: INSTALLMENT,
            schemeMonth: 1,
            idempotencyKey: `active-attempt-key-${i}`,
          },
          `active-attempt-${i}`,
          'http://localhost:5173',
        ),
      ),
    );

    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');
    expect(fulfilled.length).toBeGreaterThanOrEqual(1);
    expect(rejected.length).toBeGreaterThanOrEqual(1);
    for (const r of rejected) {
      expect((r as PromiseRejectedResult).reason).toMatchObject({
        code: 'PAYMENT_ATTEMPT_ALREADY_ACTIVE',
        statusCode: 409,
      });
    }

    expect(createCalls).toBe(1);
    const intentsWithKey = await PaymentIntent.find({
      activeAttemptKey: { $exists: true, $ne: null },
    });
    expect(intentsWithKey.length).toBe(1);
    expect(await PaymentIntent.countDocuments({ schemeId: enrollment._id, schemeMonth: 1 })).toBe(
      1,
    );
  });

  it('WEB and SDK attempts for the same scheme month cannot both create a live provider order', async () => {
    const { user, enrollment } = await seedFixture();
    let createCalls = 0;
    vi.spyOn(phonePeProvider, 'createPayment').mockImplementation(async (input: any) => {
      createCalls += 1;
      return pendingCheckout(input);
    });
    vi.spyOn(phonePeProvider, 'createSdkOrder').mockImplementation(async (input: any) => {
      createCalls += 1;
      return pendingSdkOrder(input);
    });

    const web = await initiatePhonePe(
      String(user._id),
      {
        schemeId: String(enrollment._id),
        amountPaise: INSTALLMENT,
        schemeMonth: 1,
        idempotencyKey: 'cross-channel-web-0001',
      },
      'cross-channel-web',
      'http://localhost:5173',
    );
    expect(web.status).toBe('PENDING');
    expect(createCalls).toBe(1);

    await expect(
      initiatePhonePeSdkOrder(
        String(user._id),
        {
          schemeId: String(enrollment._id),
          amountPaise: INSTALLMENT,
          schemeMonth: 1,
          idempotencyKey: 'cross-channel-sdk-0001',
        },
        'cross-channel-sdk',
      ),
    ).rejects.toMatchObject({ code: 'PAYMENT_ATTEMPT_ALREADY_ACTIVE', statusCode: 409 });

    expect(createCalls).toBe(1);
    expect(await PaymentIntent.countDocuments({ schemeId: enrollment._id, schemeMonth: 1 })).toBe(
      1,
    );
  });

  it('a network-timeout create leaves the intent PROVIDER_CREATE_UNCERTAIN and still blocks a second live order', async () => {
    const { user, enrollment } = await seedFixture();
    let createCalls = 0;
    vi.spyOn(phonePeProvider, 'createPayment').mockImplementation(async () => {
      createCalls += 1;
      throw new Error('network timeout');
    });

    await expect(
      initiatePhonePe(
        String(user._id),
        {
          schemeId: String(enrollment._id),
          amountPaise: INSTALLMENT,
          schemeMonth: 1,
          idempotencyKey: 'uncertain-blocks-0001',
        },
        'uncertain-blocks-1',
        'http://localhost:5173',
      ),
    ).rejects.toThrow(/network timeout/);

    const uncertain = await PaymentIntent.findOne({ idempotencyKey: 'uncertain-blocks-0001' });
    expect(uncertain?.status).toBe('PROVIDER_CREATE_UNCERTAIN');
    expect(uncertain?.activeAttemptKey).toBeTruthy();

    await expect(
      initiatePhonePe(
        String(user._id),
        {
          schemeId: String(enrollment._id),
          amountPaise: INSTALLMENT,
          schemeMonth: 1,
          idempotencyKey: 'uncertain-blocks-second-0001',
        },
        'uncertain-blocks-2',
        'http://localhost:5173',
      ),
    ).rejects.toMatchObject({ code: 'PAYMENT_ATTEMPT_ALREADY_ACTIVE', statusCode: 409 });

    expect(createCalls).toBe(1);
    expect(await PaymentIntent.countDocuments({ schemeId: enrollment._id, schemeMonth: 1 })).toBe(
      1,
    );
  });

  it('a FAILED terminal intent releases activeAttemptKey and allows a fresh attempt', async () => {
    const { user, enrollment } = await seedFixture();
    vi.spyOn(phonePeProvider, 'createPayment').mockImplementation(async (input: any) =>
      pendingCheckout(input),
    );

    const first = await initiatePhonePe(
      String(user._id),
      {
        schemeId: String(enrollment._id),
        amountPaise: INSTALLMENT,
        schemeMonth: 1,
        idempotencyKey: 'release-on-failed-0001',
      },
      'release-failed-1',
      'http://localhost:5173',
    );
    expect(first.status).toBe('PENDING');

    const intent = await PaymentIntent.findOne({ idempotencyKey: 'release-on-failed-0001' });
    expect(intent?.activeAttemptKey).toBeTruthy();

    vi.spyOn(phonePeProvider, 'checkStatus').mockResolvedValue({
      state: 'FAILED',
      amountPaise: INSTALLMENT,
      raw: {},
    });
    const reconciled = await reconcilePaymentIntentStatus(
      String(intent!._id),
      'RECOVERY_WORKER',
      'release-failed-reconcile',
    );
    expect(reconciled.state).toBe('FAILED');

    const afterFail = await PaymentIntent.findById(intent!._id);
    expect(afterFail?.status).toBe('FAILED');
    expect(afterFail?.activeAttemptKey).toBeFalsy();

    vi.restoreAllMocks();
    vi.spyOn(phonePeProvider, 'createPayment').mockImplementation(async (input: any) =>
      pendingCheckout(input),
    );
    const second = await initiatePhonePe(
      String(user._id),
      {
        schemeId: String(enrollment._id),
        amountPaise: INSTALLMENT,
        schemeMonth: 1,
        idempotencyKey: 'release-on-failed-retry-0001',
      },
      'release-failed-2',
      'http://localhost:5173',
    );
    expect(second.status).toBe('PENDING');
    expect(await PaymentIntent.countDocuments({ schemeId: enrollment._id, schemeMonth: 1 })).toBe(
      2,
    );
  });

  it('a SUCCESS terminal intent releases activeAttemptKey', async () => {
    const { user, enrollment } = await seedFixture();
    vi.spyOn(phonePeProvider, 'createPayment').mockImplementation(async (input: any) =>
      pendingCheckout(input),
    );

    const first = await initiatePhonePe(
      String(user._id),
      {
        schemeId: String(enrollment._id),
        amountPaise: INSTALLMENT,
        schemeMonth: 1,
        idempotencyKey: 'release-on-success-0001',
      },
      'release-success-1',
      'http://localhost:5173',
    );
    expect(first.status).toBe('PENDING');
    const intent = await PaymentIntent.findOne({ idempotencyKey: 'release-on-success-0001' });
    expect(intent?.activeAttemptKey).toBeTruthy();

    vi.spyOn(phonePeProvider, 'checkStatus').mockResolvedValue({
      state: 'SUCCESS',
      amountPaise: INSTALLMENT,
      transactionId: 'PP-RELEASE-SUCCESS',
      raw: {},
    });
    const reconciled = await reconcilePaymentIntentStatus(
      String(intent!._id),
      'RECOVERY_WORKER',
      'release-success-reconcile',
    );
    expect(reconciled.state).toBe('SUCCESS');

    const afterSuccess = await PaymentIntent.findById(intent!._id);
    expect(afterSuccess?.status).toBe('SUCCESS');
    expect(afterSuccess?.activeAttemptKey).toBeFalsy();
  });
});
