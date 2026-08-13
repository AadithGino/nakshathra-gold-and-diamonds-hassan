import { addMonths, startOfMonth } from 'date-fns';
import { fromZonedTime, toZonedTime } from 'date-fns-tz';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  GoldRate,
  Payment,
  PaymentIntent,
  SchemeEnrollment,
  User,
} from '../src/models/index.js';
import { finalizeGatewayPayment, gatewayGoldFromIntent } from '../src/services/payment.service.js';
import { enrollmentDates } from '../src/services/scheme.service.js';
import { BUSINESS_TZ, businessDayRange } from '../src/utils/time.js';
import {
  clearTestMongo,
  startTestMongo,
  stopTestMongo,
  withTestTransaction,
} from './helpers/mongo.js';

const INSTALLMENT_PAISE = 100_000;
const LOCKED_RATE_PAISE = 700_000;
const LOCKED_WEIGHT_MG = 142;
const CURRENT_BOARD_RATE_PAISE = 800_000;

async function seedGatewayFixture() {
  const [actor] = await User.create([
    {
      name: 'Test Admin',
      phone: '+919999000001',
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
      enrollmentNumber: 'ENR-TEST-001',
      schemeType: 'GOLD_WEIGHT',
      startDate,
      flexiblePeriodEndDate: dates.flexiblePeriodEndDate,
      maturityDate: dates.maturityDate,
      redemptionStartDate: dates.redemptionStartDate,
      redemptionEndDate: dates.redemptionEndDate,
      durationMonths: 11,
      flexibleMonths: 11,
      monthlyInstallmentPaise: INSTALLMENT_PAISE,
      makingChargeWaiverPercent: 100,
      gstRateBasisPoints: 300,
      status: 'ACTIVE',
      createdBy: actor._id,
    },
  ]);

  const { start: todayStart } = businessDayRange(now);
  // Board rate for finalization day — intentionally different from the locked quote.
  const [boardRate] = await GoldRate.create([
    {
      ratePerGramPaise: CURRENT_BOARD_RATE_PAISE,
      purity: '916',
      effectiveFrom: todayStart,
      status: 'ACTIVE',
      createdBy: actor._id,
    },
  ]);

  // Separate historical rate document referenced by the intent snapshot.
  const lockedRateEffective = fromZonedTime(
    addMonths(startLocal, -1),
    BUSINESS_TZ,
  );
  const [lockedRate] = await GoldRate.create([
    {
      ratePerGramPaise: LOCKED_RATE_PAISE,
      purity: '916',
      effectiveFrom: lockedRateEffective,
      status: 'INACTIVE',
      createdBy: actor._id,
    },
  ]);

  const merchantTransactionId = `KRL-TEST-${Date.now()}`;
  const [intent] = await PaymentIntent.create([
    {
      customerId: actor._id,
      schemeId: enrollment._id,
      amountPaise: INSTALLMENT_PAISE,
      merchantTransactionId,
      checkoutChannel: 'WEB',
      status: 'PENDING',
      idempotencyKey: `idem-${merchantTransactionId}`,
      idempotencyScope: 'PHONEPE_CUSTOMER_WEB',
      requestHash: 'phase0-baseline-fixture-hash',
      goldRateId: lockedRate._id,
      goldRatePerGramPaise: LOCKED_RATE_PAISE,
      goldWeightMg: LOCKED_WEIGHT_MG,
      goldPurity: '916',
      schemeMonth: 1,
      quoteCreatedAt: lockedRateEffective,
      collectorRole: 'CUSTOMER',
      createdBy: actor._id,
    },
  ]);

  return { actor, enrollment, boardRate, lockedRate, intent, merchantTransactionId };
}

describe('gateway finalization baseline', () => {
  beforeAll(async () => {
    await startTestMongo();
  }, 120_000);

  afterAll(async () => {
    await stopTestMongo();
  });

  beforeEach(async () => {
    await clearTestMongo();
  });

  it('copies initiation-time gold values from PaymentIntent onto Payment', () => {
    expect(
      gatewayGoldFromIntent(
        {
          goldRateId: 'rate-id',
          goldRatePerGramPaise: LOCKED_RATE_PAISE,
          goldWeightMg: LOCKED_WEIGHT_MG,
          goldPurity: '916',
        },
        'GOLD_WEIGHT',
      ),
    ).toEqual({
      goldRateId: 'rate-id',
      goldRatePerGramPaise: LOCKED_RATE_PAISE,
      goldWeightMg: LOCKED_WEIGHT_MG,
      goldPurity: '916',
    });
  });

  it('creates exactly one Payment and reuses it on repeated finalization', async () => {
    const { intent, merchantTransactionId, actor } = await seedGatewayFixture();
    const context = { actorId: String(actor._id), actorRole: 'CUSTOMER' as const, requestId: 't1' };

    const first = await finalizeGatewayPayment(
      intent,
      { transactionId: 'PP-TXN-1', amountPaise: INSTALLMENT_PAISE },
      context,
    );
    expect(first.status).toBe('SUCCESS');
    expect(first.merchantTransactionId).toBe(merchantTransactionId);

    const reloaded = await PaymentIntent.findById(intent._id);
    const second = await finalizeGatewayPayment(
      reloaded!,
      { transactionId: 'PP-TXN-1', amountPaise: INSTALLMENT_PAISE },
      context,
    );

    expect(String(second._id)).toBe(String(first._id));
    const count = await Payment.countDocuments({ merchantTransactionId });
    expect(count).toBe(1);
  });

  it('does not recalculate gold from the current board rate on late success', async () => {
    const { intent, boardRate, actor } = await seedGatewayFixture();
    expect(boardRate.ratePerGramPaise).toBe(CURRENT_BOARD_RATE_PAISE);
    expect(intent.goldRatePerGramPaise).toBe(LOCKED_RATE_PAISE);
    expect(intent.goldRatePerGramPaise).not.toBe(boardRate.ratePerGramPaise);

    const payment = await finalizeGatewayPayment(
      intent,
      { transactionId: 'PP-TXN-LATE', amountPaise: INSTALLMENT_PAISE },
      { actorId: String(actor._id), actorRole: 'CUSTOMER', requestId: 't2' },
    );

    expect(payment.goldRatePerGramPaise).toBe(LOCKED_RATE_PAISE);
    expect(payment.goldWeightMg).toBe(LOCKED_WEIGHT_MG);
    expect(payment.goldRatePerGramPaise).not.toBe(CURRENT_BOARD_RATE_PAISE);
  });

  it('runs finalization inside a Mongo transaction helper', async () => {
    const { intent, actor } = await seedGatewayFixture();
    const payment = await withTestTransaction(async (session) =>
      finalizeGatewayPayment(
        intent,
        { transactionId: 'PP-TXN-TX', amountPaise: INSTALLMENT_PAISE },
        { actorId: String(actor._id), actorRole: 'CUSTOMER', requestId: 't3' },
        session,
      ),
    );
    expect(payment.status).toBe('SUCCESS');
    expect(await Payment.countDocuments({})).toBe(1);
  });
});
