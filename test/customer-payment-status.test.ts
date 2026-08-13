import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { startOfMonth } from 'date-fns';
import { fromZonedTime, toZonedTime } from 'date-fns-tz';
import { Customer, GoldRate, PaymentIntent, SchemeEnrollment, User } from '../src/models/index.js';
import { getCustomerPaymentIntent } from '../src/services/customer-portal.service.js';
import { phonePeProvider } from '../src/services/phonepe.provider.js';
import { enrollmentDates } from '../src/services/scheme.service.js';
import { AppError } from '../src/utils/AppError.js';
import { BUSINESS_TZ, businessDayRange } from '../src/utils/time.js';
import { clearTestMongo, startTestMongo, stopTestMongo } from './helpers/mongo.js';

const INSTALLMENT = 100_000;

async function seedCustomerWithIntent(overrides: Record<string, unknown> = {}) {
  const [user] = await User.create([
    {
      name: 'Status Poll Customer',
      phone: `+9199${String(Date.now()).slice(-8)}`,
      passwordHash: 'hash',
      role: 'CUSTOMER',
      status: 'ACTIVE',
    },
  ]);
  const [customer] = await Customer.create([
    {
      userId: user._id,
      customerCode: `CUST-STATUS-${Date.now()}`,
      status: 'ACTIVE',
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
      enrollmentNumber: `ENR-STATUS-${Date.now()}`,
      schemeType: 'GOLD_WEIGHT',
      startDate,
      ...dates,
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
  let rate = await GoldRate.findOne({ effectiveFrom: todayStart, status: 'ACTIVE' });
  if (!rate) {
    [rate] = await GoldRate.create([
      {
        ratePerGramPaise: 750_000,
        purity: '916',
        effectiveFrom: todayStart,
        status: 'ACTIVE',
        createdBy: user._id,
      },
    ]);
  }

  const merchantTransactionId = `KRL-STATUS-${Date.now()}-${Math.random().toString(16).slice(2, 6)}`;
  const [intent] = await PaymentIntent.create([
    {
      customerId: customer._id,
      schemeId: enrollment._id,
      amountPaise: INSTALLMENT,
      merchantTransactionId,
      checkoutChannel: 'WEB',
      status: 'PENDING',
      idempotencyKey: `status-${merchantTransactionId}`,
      idempotencyScope: 'PHONEPE_CUSTOMER_WEB',
      requestHash: 'status-fixture-hash',
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
      createdBy: user._id,
      activeAttemptKey: `PHONEPE:${enrollment._id}:1`,
      ...overrides,
    },
  ]);

  return { user, customer, enrollment, intent, merchantTransactionId };
}

describe('customer payment-intent status lookup is authoritative', () => {
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

  it('reconciles a stale PENDING intent against PhonePe rather than trusting the local row', async () => {
    const { user, intent, merchantTransactionId } = await seedCustomerWithIntent();
    vi.spyOn(phonePeProvider, 'checkStatus').mockResolvedValue({
      state: 'SUCCESS',
      amountPaise: INSTALLMENT,
      transactionId: 'PP-CUSTOMER-STATUS',
      raw: {},
    });

    const result = await getCustomerPaymentIntent(String(user._id), merchantTransactionId);
    expect(result.status).toBe('SUCCESS');
    expect(result.payment).toBeTruthy();
    expect(phonePeProvider.checkStatus).toHaveBeenCalledTimes(1);

    const updated = await PaymentIntent.findById(intent._id);
    expect(updated?.status).toBe('SUCCESS');
  });

  it('never checks the provider for an intent already terminal', async () => {
    const { user, merchantTransactionId } = await seedCustomerWithIntent({
      status: 'FAILED',
      nextStatusCheckAt: null,
      activeAttemptKey: undefined,
    });
    vi.spyOn(phonePeProvider, 'checkStatus').mockResolvedValue({
      state: 'PENDING',
      amountPaise: INSTALLMENT,
      raw: {},
    });

    const result = await getCustomerPaymentIntent(String(user._id), merchantTransactionId);
    expect(result.status).toBe('FAILED');
    expect(phonePeProvider.checkStatus).not.toHaveBeenCalled();
  });

  it('does not hammer PhonePe on repeated status requests (throttled)', async () => {
    const { user, merchantTransactionId } = await seedCustomerWithIntent();
    vi.spyOn(phonePeProvider, 'checkStatus').mockResolvedValue({
      state: 'PENDING',
      amountPaise: INSTALLMENT,
      raw: {},
    });

    await getCustomerPaymentIntent(String(user._id), merchantTransactionId);
    expect(phonePeProvider.checkStatus).toHaveBeenCalledTimes(1);

    // Immediate repeat poll must not fire another provider call.
    await getCustomerPaymentIntent(String(user._id), merchantTransactionId);
    expect(phonePeProvider.checkStatus).toHaveBeenCalledTimes(1);
  });

  it('a customer cannot query another customer\'s payment intent', async () => {
    const { merchantTransactionId } = await seedCustomerWithIntent();
    const { user: otherUser } = await seedCustomerWithIntent();

    await expect(
      getCustomerPaymentIntent(String(otherUser._id), merchantTransactionId),
    ).rejects.toMatchObject({ code: 'PAYMENT_INTENT_NOT_FOUND' } satisfies Partial<AppError>);
  });

  it('surfaces REVIEW_REQUIRED without leaking internal gateway error detail', async () => {
    const { user, merchantTransactionId } = await seedCustomerWithIntent({
      status: 'REVIEW_REQUIRED',
      nextStatusCheckAt: null,
      activeAttemptKey: undefined,
      lastGatewayError: 'DUPLICATE_GATEWAY_CAPTURE',
    });
    vi.spyOn(phonePeProvider, 'checkStatus').mockResolvedValue({
      state: 'PENDING',
      amountPaise: INSTALLMENT,
      raw: {},
    });

    const result = await getCustomerPaymentIntent(String(user._id), merchantTransactionId);
    expect(result.status).toBe('REVIEW_REQUIRED');
    expect(phonePeProvider.checkStatus).not.toHaveBeenCalled();
    expect(Object.keys(result)).not.toContain('lastGatewayError');
  });
});
