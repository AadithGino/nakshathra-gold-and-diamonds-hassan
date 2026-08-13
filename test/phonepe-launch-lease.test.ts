import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { addMonths, startOfMonth } from 'date-fns';
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
  reconcilePaymentIntentStatus,
} from '../src/services/gateway.service.js';
import { phonePeProvider } from '../src/services/phonepe.provider.js';
import { enrollmentDates } from '../src/services/scheme.service.js';
import { AppError } from '../src/utils/AppError.js';
import { BUSINESS_TZ, businessDayRange } from '../src/utils/time.js';
import { processPaymentRecoveryBatch } from '../src/workers/payment-recovery.worker.js';
import { clearTestMongo, startTestMongo, stopTestMongo } from './helpers/mongo.js';

const INSTALLMENT = 100_000;

async function seedFixture() {
  const [user] = await User.create([
    {
      name: 'Launch Customer',
      phone: '+919888000001',
      passwordHash: 'hash',
      role: 'CUSTOMER',
      status: 'ACTIVE',
    },
  ]);
  const [customer] = await Customer.create([
    {
      userId: user._id,
      customerCode: 'CUST-LAUNCH-001',
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
      enrollmentNumber: 'ENR-LAUNCH-001',
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

describe('PhonePe provider launch lease', () => {
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

  it('calls createPayment only once under concurrent incomplete launches', async () => {
    const { user, enrollment } = await seedFixture();
    let inFlight = 0;
    let maxInFlight = 0;
    let createCalls = 0;

    vi.spyOn(phonePeProvider, 'createPayment').mockImplementation(async (input: any) => {
      createCalls += 1;
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 250));
      inFlight -= 1;
      return {
        providerOrderId: `ORD-${input.merchantOrderId}`,
        state: 'PENDING',
        redirectUrl: 'https://phonepe.test/checkout',
        expiresAt: new Date(Date.now() + 600_000),
      };
    });

    const body = {
      schemeId: String(enrollment._id),
      amountPaise: INSTALLMENT,
      schemeMonth: 1,
      idempotencyKey: 'launch-lease-concurrent-0001',
    };

    const results = await Promise.all(
      Array.from({ length: 6 }, (_, i) =>
        initiatePhonePe(String(user._id), body, `launch-${i}`, 'http://localhost:5173'),
      ),
    );

    const merchantIds = new Set(results.map((r) => r.merchantTransactionId));
    expect(merchantIds.size).toBe(1);
    expect(createCalls).toBe(1);
    expect(maxInFlight).toBe(1);
    expect(await PaymentIntent.countDocuments({})).toBe(1);
    const intent = await PaymentIntent.findOne({});
    expect(intent?.status).toBe('PENDING');
    expect(intent?.checkoutUrl).toBeTruthy();
    expect(intent?.providerLaunchLockUntil).toBeFalsy();
  });

  it('does not mark FAILED on ambiguous provider create errors', async () => {
    const { user, enrollment } = await seedFixture();
    vi.spyOn(phonePeProvider, 'createPayment').mockRejectedValue(new Error('network timeout'));

    await expect(
      initiatePhonePe(
        String(user._id),
        {
          schemeId: String(enrollment._id),
          amountPaise: INSTALLMENT,
          schemeMonth: 1,
          idempotencyKey: 'launch-recoverable-0001',
        },
        'recoverable-1',
        'http://localhost:5173',
      ),
    ).rejects.toThrow(/network timeout/);

    const intent = await PaymentIntent.findOne({ idempotencyKey: 'launch-recoverable-0001' });
    expect(intent).toBeTruthy();
    expect(intent?.status).toBe('PROVIDER_CREATE_UNCERTAIN');
    expect(intent?.status).not.toBe('FAILED');
    expect(intent?.nextStatusCheckAt).toBeTruthy();
    expect(intent?.lastGatewayError).toMatch(/network timeout/);
  });

  it('does not re-call createPayment when local save fails after provider success', async () => {
    const { user, enrollment } = await seedFixture();
    let createCalls = 0;
    vi.spyOn(phonePeProvider, 'createPayment').mockImplementation(async (input: any) => {
      createCalls += 1;
      return {
        providerOrderId: `ORD-${input.merchantOrderId}`,
        state: 'PENDING',
        redirectUrl: 'https://phonepe.test/checkout',
        expiresAt: new Date(Date.now() + 600_000),
      };
    });

    const originalUpdateOne = PaymentIntent.updateOne.bind(PaymentIntent);
    const updateSpy = vi
      .spyOn(PaymentIntent, 'updateOne')
      .mockImplementation((filter: any, update: any, options?: any) => {
        const set = update?.$set ?? {};
        if (set.checkoutUrl && set.status === 'PENDING') {
          return Promise.reject(new Error('simulated local save failure')) as any;
        }
        return originalUpdateOne(filter, update, options);
      });

    await expect(
      initiatePhonePe(
        String(user._id),
        {
          schemeId: String(enrollment._id),
          amountPaise: INSTALLMENT,
          schemeMonth: 1,
          idempotencyKey: 'uncertain-save-fail-0001',
        },
        'uncertain-1',
        'http://localhost:5173',
      ),
    ).rejects.toThrow(/simulated local save failure/);

    const afterFirst = await PaymentIntent.findOne({ idempotencyKey: 'uncertain-save-fail-0001' });
    expect(afterFirst?.status).toBe('PROVIDER_CREATE_UNCERTAIN');
    expect(afterFirst?.nextStatusCheckAt).toBeTruthy();
    expect(afterFirst?.status).not.toBe('FAILED');
    expect(createCalls).toBe(1);

    updateSpy.mockRestore();

    for (let i = 0; i < 5; i++) {
      await expect(
        initiatePhonePe(
          String(user._id),
          {
            schemeId: String(enrollment._id),
            amountPaise: INSTALLMENT,
            schemeMonth: 1,
            idempotencyKey: 'uncertain-save-fail-0001',
          },
          `uncertain-retry-${i}`,
          'http://localhost:5173',
        ),
      ).rejects.toMatchObject({ code: 'PAYMENT_LAUNCH_RECOVERY_PENDING' });
    }
    expect(createCalls).toBe(1);
  });

  it('keeps uncertain intents recovery-only when PhonePe status is PENDING', async () => {
    const { user, enrollment } = await seedFixture();
    let createCalls = 0;
    vi.spyOn(phonePeProvider, 'createPayment').mockImplementation(async (input: any) => {
      createCalls += 1;
      return {
        providerOrderId: `ORD-${input.merchantOrderId}`,
        state: 'PENDING',
        redirectUrl: 'https://phonepe.test/checkout',
        expiresAt: new Date(Date.now() + 600_000),
      };
    });

    const originalUpdateOne = PaymentIntent.updateOne.bind(PaymentIntent);
    vi.spyOn(PaymentIntent, 'updateOne').mockImplementation((filter: any, update: any, options?: any) => {
      const set = update?.$set ?? {};
      if (set.checkoutUrl && set.status === 'PENDING') {
        return Promise.reject(new Error('simulated local save failure')) as any;
      }
      return originalUpdateOne(filter, update, options);
    });

    await expect(
      initiatePhonePe(
        String(user._id),
        {
          schemeId: String(enrollment._id),
          amountPaise: INSTALLMENT,
          schemeMonth: 1,
          idempotencyKey: 'uncertain-status-pending-0001',
        },
        'status-pending-1',
        'http://localhost:5173',
      ),
    ).rejects.toThrow(/simulated local save failure/);
    vi.restoreAllMocks();

    createCalls = 0;
    vi.spyOn(phonePeProvider, 'createPayment').mockImplementation(async () => {
      createCalls += 1;
      throw new Error('create must not be called');
    });
    vi.spyOn(phonePeProvider, 'checkStatus').mockResolvedValue({
      state: 'PENDING',
      amountPaise: INSTALLMENT,
      raw: { state: 'PENDING' },
    });

    const intent = await PaymentIntent.findOne({ idempotencyKey: 'uncertain-status-pending-0001' });
    expect(intent?.status).toBe('PROVIDER_CREATE_UNCERTAIN');

    const reconciled = await reconcilePaymentIntentStatus(
      String(intent!._id),
      'RECOVERY_WORKER',
      'test-status-pending',
    );
    expect(reconciled.state).toBe('PROVIDER_CREATE_UNCERTAIN');

    const after = await PaymentIntent.findById(intent!._id);
    expect(after?.status).toBe('PROVIDER_CREATE_UNCERTAIN');
    expect(after?.nextStatusCheckAt).toBeTruthy();

    await expect(
      initiatePhonePe(
        String(user._id),
        {
          schemeId: String(enrollment._id),
          amountPaise: INSTALLMENT,
          schemeMonth: 1,
          idempotencyKey: 'uncertain-status-pending-0001',
        },
        'status-pending-retry',
        'http://localhost:5173',
      ),
    ).rejects.toMatchObject({ code: 'PAYMENT_LAUNCH_RECOVERY_PENDING' });
    expect(createCalls).toBe(0);
  });

  it('converts stale PROVIDER_CREATING lease to uncertain without create', async () => {
    const { user, enrollment } = await seedFixture();
    let createCalls = 0;
    vi.spyOn(phonePeProvider, 'createPayment').mockImplementation(async (input: any) => {
      createCalls += 1;
      return {
        providerOrderId: `ORD-${input.merchantOrderId}`,
        state: 'PENDING',
        redirectUrl: 'https://phonepe.test/checkout',
        expiresAt: new Date(Date.now() + 600_000),
      };
    });

    await initiatePhonePe(
      String(user._id),
      {
        schemeId: String(enrollment._id),
        amountPaise: INSTALLMENT,
        schemeMonth: 1,
        idempotencyKey: 'stale-creating-0001',
      },
      'stale-creating-1',
      'http://localhost:5173',
    );
    expect(createCalls).toBe(1);

    await PaymentIntent.updateOne(
      { idempotencyKey: 'stale-creating-0001' },
      {
        $set: {
          status: 'PROVIDER_CREATING',
          checkoutUrl: null,
          providerLaunchLockedAt: new Date(Date.now() - 120_000),
          providerLaunchLockUntil: new Date(Date.now() - 60_000),
          providerLaunchLockedBy: 'expired-owner',
        },
        $unset: { nextStatusCheckAt: 1 },
      },
    );

    createCalls = 0;
    vi.spyOn(phonePeProvider, 'createPayment').mockImplementation(async () => {
      createCalls += 1;
      throw new Error('create must not be called for stale creating');
    });
    const checkStatus = vi.spyOn(phonePeProvider, 'checkStatus').mockResolvedValue({
      state: 'PENDING',
      amountPaise: INSTALLMENT,
      raw: { state: 'PENDING' },
    });

    await expect(
      initiatePhonePe(
        String(user._id),
        {
          schemeId: String(enrollment._id),
          amountPaise: INSTALLMENT,
          schemeMonth: 1,
          idempotencyKey: 'stale-creating-0001',
        },
        'stale-creating-retry',
        'http://localhost:5173',
      ),
    ).rejects.toMatchObject({ code: 'PAYMENT_LAUNCH_RECOVERY_PENDING' });

    expect(createCalls).toBe(0);
    const after = await PaymentIntent.findOne({ idempotencyKey: 'stale-creating-0001' });
    expect(after?.status).toBe('PROVIDER_CREATE_UNCERTAIN');
    expect(after?.nextStatusCheckAt).toBeTruthy();
    expect(after?.providerLaunchLockUntil).toBeFalsy();

    await PaymentIntent.updateOne(
      { _id: after!._id },
      { $set: { nextStatusCheckAt: new Date(Date.now() - 1000) } },
    );
    await processPaymentRecoveryBatch('test-stale-worker', 5);
    expect(createCalls).toBe(0);
    const recovered = await PaymentIntent.findById(after!._id);
    expect(recovered?.status).toBe('PROVIDER_CREATE_UNCERTAIN');
    expect(checkStatus).toHaveBeenCalled();
  });

  it('allows exactly one controlled recreate after authoritative order-not-found', async () => {
    const { user, enrollment } = await seedFixture();
    let createCalls = 0;
    let failLocalSave = true;

    const originalUpdateOne = PaymentIntent.updateOne.bind(PaymentIntent);
    vi.spyOn(PaymentIntent, 'updateOne').mockImplementation((filter: any, update: any, options?: any) => {
      const set = update?.$set ?? {};
      if (failLocalSave && set.checkoutUrl && set.status === 'PENDING') {
        return Promise.reject(new Error('simulated local save failure')) as any;
      }
      return originalUpdateOne(filter, update, options);
    });
    vi.spyOn(phonePeProvider, 'createPayment').mockImplementation(async (input: any) => {
      createCalls += 1;
      return {
        providerOrderId: `ORD-${input.merchantOrderId}-${createCalls}`,
        state: 'PENDING',
        redirectUrl: 'https://phonepe.test/checkout',
        expiresAt: new Date(Date.now() + 600_000),
      };
    });

    await expect(
      initiatePhonePe(
        String(user._id),
        {
          schemeId: String(enrollment._id),
          amountPaise: INSTALLMENT,
          schemeMonth: 1,
          idempotencyKey: 'authoritative-not-found-0001',
        },
        'not-found-1',
        'http://localhost:5173',
      ),
    ).rejects.toThrow(/simulated local save failure/);
    expect(createCalls).toBe(1);

    vi.restoreAllMocks();
    failLocalSave = false;
    createCalls = 0;
    vi.spyOn(phonePeProvider, 'createPayment').mockImplementation(async (input: any) => {
      createCalls += 1;
      await new Promise((r) => setTimeout(r, 100));
      return {
        providerOrderId: `ORD-RETRY-${input.merchantOrderId}-${createCalls}`,
        state: 'PENDING',
        redirectUrl: 'https://phonepe.test/checkout',
        expiresAt: new Date(Date.now() + 600_000),
      };
    });
    vi.spyOn(phonePeProvider, 'checkStatus').mockRejectedValue(
      new AppError('GATEWAY_REQUEST_FAILED', 'Payment gateway request failed', 502, true, [
        { providerCode: 'ORDER_NOT_FOUND', httpStatus: 404 },
      ]),
    );

    const intent = await PaymentIntent.findOne({ idempotencyKey: 'authoritative-not-found-0001' });
    expect(intent?.status).toBe('PROVIDER_CREATE_UNCERTAIN');

    const reconciled = await reconcilePaymentIntentStatus(
      String(intent!._id),
      'RECOVERY_WORKER',
      'test-not-found',
    );
    expect(reconciled).toMatchObject({ state: 'PENDING', allowCreateRetry: true });

    const launchable = await PaymentIntent.findById(intent!._id);
    expect(launchable?.status).toBe('PENDING');
    expect(launchable?.checkoutUrl).toBeFalsy();
    expect(launchable?.providerOrderId).toBeFalsy();

    const body = {
      schemeId: String(enrollment._id),
      amountPaise: INSTALLMENT,
      schemeMonth: 1,
      idempotencyKey: 'authoritative-not-found-0001',
    };
    const results = await Promise.allSettled(
      Array.from({ length: 20 }, (_, i) =>
        initiatePhonePe(String(user._id), body, `not-found-retry-${i}`, 'http://localhost:5173'),
      ),
    );
    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    expect(fulfilled.length).toBeGreaterThan(0);
    expect(createCalls).toBe(1);
    const after = await PaymentIntent.findById(intent!._id);
    expect(after?.status).toBe('PENDING');
    expect(after?.checkoutUrl).toBeTruthy();
  });

  it('does not recreate after status network timeout', async () => {
    const { user, enrollment } = await seedFixture();
    let createCalls = 0;
    vi.spyOn(phonePeProvider, 'createPayment').mockImplementation(async (input: any) => {
      createCalls += 1;
      return {
        providerOrderId: `ORD-${input.merchantOrderId}`,
        state: 'PENDING',
        redirectUrl: 'https://phonepe.test/checkout',
        expiresAt: new Date(Date.now() + 600_000),
      };
    });

    const originalUpdateOne = PaymentIntent.updateOne.bind(PaymentIntent);
    vi.spyOn(PaymentIntent, 'updateOne').mockImplementation((filter: any, update: any, options?: any) => {
      const set = update?.$set ?? {};
      if (set.checkoutUrl && set.status === 'PENDING') {
        return Promise.reject(new Error('simulated local save failure')) as any;
      }
      return originalUpdateOne(filter, update, options);
    });

    await expect(
      initiatePhonePe(
        String(user._id),
        {
          schemeId: String(enrollment._id),
          amountPaise: INSTALLMENT,
          schemeMonth: 1,
          idempotencyKey: 'status-timeout-0001',
        },
        'timeout-1',
        'http://localhost:5173',
      ),
    ).rejects.toThrow(/simulated local save failure/);

    vi.restoreAllMocks();
    createCalls = 0;
    vi.spyOn(phonePeProvider, 'createPayment').mockImplementation(async () => {
      createCalls += 1;
      throw new Error('create must not run after timeout');
    });
    vi.spyOn(phonePeProvider, 'checkStatus').mockRejectedValue(new Error('status check timeout'));

    const intent = await PaymentIntent.findOne({ idempotencyKey: 'status-timeout-0001' });
    const reconciled = await reconcilePaymentIntentStatus(
      String(intent!._id),
      'RECOVERY_WORKER',
      'test-timeout',
    );
    expect(reconciled).toMatchObject({
      state: 'PROVIDER_CREATE_UNCERTAIN',
      transientError: true,
    });

    const after = await PaymentIntent.findById(intent!._id);
    expect(after?.status).toBe('PROVIDER_CREATE_UNCERTAIN');
    expect(after?.nextStatusCheckAt).toBeTruthy();
    expect(after?.nextStatusCheckAt!.getTime()).toBeGreaterThan(Date.now());

    await expect(
      initiatePhonePe(
        String(user._id),
        {
          schemeId: String(enrollment._id),
          amountPaise: INSTALLMENT,
          schemeMonth: 1,
          idempotencyKey: 'status-timeout-0001',
        },
        'timeout-retry',
        'http://localhost:5173',
      ),
    ).rejects.toMatchObject({ code: 'PAYMENT_LAUNCH_RECOVERY_PENDING' });
    expect(createCalls).toBe(0);
  });

  it('retries same key without re-resolving month after ledger advances', async () => {
    const { user, enrollment } = await seedFixture();
    vi.spyOn(phonePeProvider, 'createPayment').mockImplementation(async (input: any) => ({
      providerOrderId: `ORD-${input.merchantOrderId}`,
      state: 'PENDING',
      redirectUrl: 'https://phonepe.test/checkout',
      expiresAt: new Date(Date.now() + 600_000),
    }));

    const key = 'early-lookup-month-0001';
    const first = await initiatePhonePe(
      String(user._id),
      {
        schemeId: String(enrollment._id),
        amountPaise: INSTALLMENT,
        idempotencyKey: key,
      },
      'early-1',
      'http://localhost:5173',
    );

    const stored = await PaymentIntent.findOne({ idempotencyKey: key });
    expect(stored?.schemeMonth).toBeTruthy();

    await SchemeEnrollment.updateOne(
      { _id: enrollment._id },
      {
        $set: {
          startDate: fromZonedTime(
            addMonths(startOfMonth(toZonedTime(new Date(), BUSINESS_TZ)), -2),
            BUSINESS_TZ,
          ),
        },
      },
    );

    const second = await initiatePhonePe(
      String(user._id),
      {
        schemeId: String(enrollment._id),
        amountPaise: INSTALLMENT,
        idempotencyKey: key,
      },
      'early-2',
      'http://localhost:5173',
    );

    expect(second.merchantTransactionId).toBe(first.merchantTransactionId);
    expect(await PaymentIntent.countDocuments({ idempotencyKey: key })).toBe(1);
    const after = await PaymentIntent.findOne({ idempotencyKey: key });
    expect(after?.schemeMonth).toBe(stored?.schemeMonth);
  });
});
