import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { addMonths, startOfMonth } from 'date-fns';
import { fromZonedTime, toZonedTime } from 'date-fns-tz';
import {
  Customer,
  GoldRate,
  Payment,
  PaymentIntent,
  Payout,
  SchemeEnrollment,
  SystemSetting,
  User,
} from '../src/models/index.js';
import {
  initiatePhonePe,
  initiatePhonePeSdkOrder,
} from '../src/services/gateway.service.js';
import { createManualPayment, finalizeGatewayPayment } from '../src/services/payment.service.js';
import { phonePeProvider } from '../src/services/phonepe.provider.js';
import { executeSchemeSettlement } from '../src/services/scheme-settlement.service.js';
import { enrollmentDates } from '../src/services/scheme.service.js';
import { AppError } from '../src/utils/AppError.js';
import { BUSINESS_TZ, businessDayRange } from '../src/utils/time.js';
import { clearTestMongo, startTestMongo, stopTestMongo } from './helpers/mongo.js';

const INSTALLMENT = 100_000;
let seq = 0;
function phone() {
  seq += 1;
  return `+917801${String(seq).padStart(6, '0')}`;
}

async function seedActive(opts: { paidMonths: number[] } = { paidMonths: [1] }) {
  const suffix = `${Date.now()}-${seq}`;
  const [actor] = await User.create([
    { name: 'Race Admin', phone: phone(), passwordHash: 'hash', role: 'ADMIN', status: 'ACTIVE' },
  ]);
  const [user] = await User.create([
    { name: 'Race Customer', phone: phone(), passwordHash: 'hash', role: 'CUSTOMER', status: 'ACTIVE' },
  ]);
  const [customer] = await Customer.create([
    {
      userId: user._id,
      customerCode: `CUST-RACE-${suffix}`,
      status: 'ACTIVE',
      kycStatus: 'VERIFIED',
      createdBy: actor._id,
    },
  ]);
  const now = new Date();
  const startLocal = startOfMonth(addMonths(toZonedTime(now, BUSINESS_TZ), -2));
  const startDate = fromZonedTime(startLocal, BUSINESS_TZ);
  const dates = enrollmentDates(startDate, 11, 11);
  const [enrollment] = await SchemeEnrollment.create([
    {
      customerId: customer._id,
      schemePlanId: actor._id,
      enrollmentNumber: `ENR-RACE-${suffix}`,
      schemeType: 'GOLD_WEIGHT',
      startDate,
      ...dates,
      durationMonths: 11,
      flexibleMonths: 11,
      monthlyInstallmentPaise: INSTALLMENT,
      makingChargeWaiverPercent: 100,
      gstRateBasisPoints: 300,
      prematureClosureEnabled: true,
      prematureClosureMinPaidInstallments: 1,
      prematureClosureSettlementAssets: ['GOLD', 'CASH'],
      maturitySettlementAssets: ['GOLD', 'CASH'],
      paymentsCompleted: opts.paidMonths.length,
      status: 'ACTIVE',
      createdBy: actor._id,
    },
  ]);
  for (const month of opts.paidMonths) {
    await Payment.create([
      {
        customerId: customer._id,
        schemeId: enrollment._id,
        amountPaise: INSTALLMENT,
        method: 'UPI',
        status: 'SUCCESS',
        paymentDate: startDate,
        schemeMonth: month,
        receiptNumber: `KRL-RACE-${suffix}-${month}`,
        collectorRole: 'ADMIN',
        createdBy: actor._id,
      },
    ]);
  }
  const { start: todayStart } = businessDayRange(now);
  const existingRate = await GoldRate.findOne({ effectiveFrom: todayStart, purity: '916' });
  if (!existingRate) {
    await GoldRate.create([
      {
        ratePerGramPaise: 750_000,
        purity: '916',
        effectiveFrom: todayStart,
        status: 'ACTIVE',
        createdBy: actor._id,
      },
    ]);
  }
  await SystemSetting.create([{ singletonKey: 'GLOBAL', customerPhonePeEnabled: true }]);
  return { actor, user, customer, enrollment };
}

function mockPhonePe() {
  return vi.spyOn(phonePeProvider, 'createPayment').mockResolvedValue({
    providerOrderId: 'ORD-RACE',
    state: 'PENDING',
    redirectUrl: 'https://phonepe.test/checkout',
    expiresAt: new Date(Date.now() + 600_000),
  } as any);
}

function mockSdk() {
  return vi.spyOn(phonePeProvider, 'createSdkOrder').mockResolvedValue({
    orderId: 'ORD-SDK',
    state: 'PENDING',
    token: 'sdk-token',
    expiresAt: new Date(Date.now() + 600_000),
  } as any);
}

describe('settlement-payment-initiation-race', () => {
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

  it('lets premature close win when it acquires the lock first; PhonePe is not launched', async () => {
    const { actor, user, enrollment } = await seedActive();
    const createPayment = mockPhonePe();
    const close = executeSchemeSettlement(
      {
        enrollmentId: String(enrollment._id),
        kind: 'PREMATURE_CLOSE',
        settlementAsset: 'CASH',
        payoutDate: new Date(),
        reason: 'Close before new payment',
        idempotencyKey: 'race-close-first-0001',
      },
      { actorId: String(actor._id), actorRole: 'ADMIN', requestId: 'close-first' },
    );
    await vi.waitFor(async () => {
      const row = await SchemeEnrollment.findById(enrollment._id);
      return (
        row?.status === 'CLOSED' ||
        Boolean(row?.settlementLockUntil && row.settlementLockUntil.getTime() > Date.now())
      );
    });
    await expect(
      initiatePhonePe(
        String(user._id),
        {
          schemeId: String(enrollment._id),
          amountPaise: INSTALLMENT,
          schemeMonth: 2,
          idempotencyKey: 'race-phonepe-late-0001',
        },
        'pay-late',
        'http://localhost:5173',
      ),
    ).rejects.toBeInstanceOf(AppError);
    await close;
    expect(await SchemeEnrollment.findById(enrollment._id).then((row) => row?.status)).toBe('CLOSED');
    expect(createPayment).not.toHaveBeenCalled();
    expect(await PaymentIntent.countDocuments({ schemeId: enrollment._id })).toBe(0);
  });

  it('lets WEB PhonePe win when the intent is reserved first; close is blocked', async () => {
    const { actor, user, enrollment } = await seedActive();
    const createPayment = mockPhonePe();
    const launched = await initiatePhonePe(
      String(user._id),
      {
        schemeId: String(enrollment._id),
        amountPaise: INSTALLMENT,
        schemeMonth: 2,
        idempotencyKey: 'race-phonepe-first-0001',
      },
      'pay-first',
      'http://localhost:5173',
    );
    expect(launched.checkoutUrl).toBeTruthy();
    expect(createPayment).toHaveBeenCalled();
    await expect(
      executeSchemeSettlement(
        {
          enrollmentId: String(enrollment._id),
          kind: 'PREMATURE_CLOSE',
          settlementAsset: 'CASH',
          payoutDate: new Date(),
          reason: 'Close after intent',
          idempotencyKey: 'race-close-late-0001',
        },
        { actorId: String(actor._id), actorRole: 'ADMIN', requestId: 'close-late' },
      ),
    ).rejects.toMatchObject({ code: 'SCHEME_SETTLEMENT_BLOCKED_PENDING_PAYMENT' });
    expect(await SchemeEnrollment.findById(enrollment._id).then((row) => row?.status)).toBe('ACTIVE');
  });

  it('releases the financial lock before the PhonePe provider call', async () => {
    const { user, enrollment } = await seedActive();
    vi.spyOn(phonePeProvider, 'createPayment').mockImplementation(async () => {
      const row = await SchemeEnrollment.findById(enrollment._id);
      expect(
        !row?.settlementLockUntil || row.settlementLockUntil.getTime() <= Date.now(),
      ).toBe(true);
      return {
        providerOrderId: 'ORD-ORDER',
        state: 'PENDING',
        redirectUrl: 'https://phonepe.test/checkout',
        expiresAt: new Date(Date.now() + 600_000),
      } as any;
    });
    await initiatePhonePe(
      String(user._id),
      {
        schemeId: String(enrollment._id),
        amountPaise: INSTALLMENT,
        schemeMonth: 2,
        idempotencyKey: 'race-lock-order-0001',
      },
      'lock-order',
      'http://localhost:5173',
    );
  });

  it('serializes SDK initiation against premature close', async () => {
    const { actor, user, enrollment } = await seedActive();
    mockSdk();
    await initiatePhonePeSdkOrder(
      String(user._id),
      {
        schemeId: String(enrollment._id),
        amountPaise: INSTALLMENT,
        schemeMonth: 2,
        idempotencyKey: 'race-sdk-first-0001',
      },
      'sdk-first',
    );
    await expect(
      executeSchemeSettlement(
        {
          enrollmentId: String(enrollment._id),
          kind: 'PREMATURE_CLOSE',
          settlementAsset: 'CASH',
          payoutDate: new Date(),
          reason: 'Close after SDK intent',
          idempotencyKey: 'race-sdk-close-0001',
        },
        { actorId: String(actor._id), actorRole: 'ADMIN', requestId: 'sdk-close' },
      ),
    ).rejects.toMatchObject({ code: 'SCHEME_SETTLEMENT_BLOCKED_PENDING_PAYMENT' });
  });

  it('never leaves a closed scheme with unsettled principal after a manual vs close race', async () => {
    const { actor, customer, enrollment } = await seedActive({ paidMonths: [1] });
    const results = await Promise.allSettled([
      createManualPayment(
        {
          customerId: String(customer._id),
          schemeId: String(enrollment._id),
          amountPaise: INSTALLMENT,
          schemeMonth: 2,
          method: 'CASH',
          paymentDate: new Date(),
          idempotencyKey: 'race-manual-concurrent-0001',
        },
        { actorId: String(actor._id), actorRole: 'ADMIN', requestId: 'manual-race' },
      ),
      executeSchemeSettlement(
        {
          enrollmentId: String(enrollment._id),
          kind: 'PREMATURE_CLOSE',
          settlementAsset: 'CASH',
          payoutDate: new Date(),
          reason: 'Race close',
          idempotencyKey: 'race-close-concurrent-0001',
        },
        { actorId: String(actor._id), actorRole: 'ADMIN', requestId: 'close-race' },
      ),
    ]);
    expect(results.some((row) => row.status === 'fulfilled')).toBe(true);
    const row = await SchemeEnrollment.findById(enrollment._id);
    if (row?.status === 'CLOSED') {
      const { aggregateEnrollmentLedger } = await import('../src/utils/enrollment-ledger.js');
      const ledger = await aggregateEnrollmentLedger(String(enrollment._id));
      expect(ledger.availablePaise).toBe(0);
    }
  });

  it('rejects admin manual payment after premature close wins', async () => {
    const { actor, customer, enrollment } = await seedActive({ paidMonths: [1] });
    await executeSchemeSettlement(
      {
        enrollmentId: String(enrollment._id),
        kind: 'PREMATURE_CLOSE',
        settlementAsset: 'CASH',
        payoutDate: new Date(),
        reason: 'Close before manual',
        idempotencyKey: 'race-manual-close-0001',
      },
      { actorId: String(actor._id), actorRole: 'ADMIN', requestId: 'manual-close' },
    );
    await expect(
      createManualPayment(
        {
          customerId: String(customer._id),
          schemeId: String(enrollment._id),
          amountPaise: INSTALLMENT,
          schemeMonth: 2,
          method: 'CASH',
          paymentDate: new Date(),
          idempotencyKey: 'race-manual-late-0001',
        },
        {
          actorId: String(actor._id),
          actorRole: 'ADMIN',
          requestId: 'manual-late',
        },
      ),
    ).rejects.toMatchObject({
      code: expect.stringMatching(
        /SCHEME_NOT_ACTIVE|SCHEME_SETTLEMENT_IN_PROGRESS|SCHEME_ALREADY_SETTLED/,
      ),
    });
  });

  it('does not leave a stale lock when intent create fails', async () => {
    const { user, enrollment } = await seedActive();
    vi.spyOn(PaymentIntent, 'findOneAndUpdate').mockRejectedValueOnce(new Error('intent write failed'));
    await expect(
      initiatePhonePe(
        String(user._id),
        {
          schemeId: String(enrollment._id),
          amountPaise: INSTALLMENT,
          schemeMonth: 2,
          idempotencyKey: 'race-fail-intent-0001',
        },
        'fail-intent',
        'http://localhost:5173',
      ),
    ).rejects.toThrow('intent write failed');
    const row = await SchemeEnrollment.findById(enrollment._id);
    expect(
      !row?.settlementLockUntil || row.settlementLockUntil.getTime() <= Date.now(),
    ).toBe(true);
  });

  it('still finalizes a captured SUCCESS while a short mutation lock is held', async () => {
    const { actor, customer, enrollment } = await seedActive();
    const rate = await GoldRate.findOne({ purity: '916' });
    const [intent] = await PaymentIntent.create([
      {
        customerId: customer._id,
        schemeId: enrollment._id,
        amountPaise: INSTALLMENT,
        merchantTransactionId: `KRL-RACE-FIN-${seq}`,
        checkoutChannel: 'WEB',
        status: 'PENDING',
        idempotencyKey: 'race-finalize-lock-0001',
        idempotencyScope: 'PHONEPE_CUSTOMER_WEB',
        requestHash: 'race-finalize-hash',
        schemeMonth: 2,
        goldRateId: rate?._id,
        goldRatePerGramPaise: 750_000,
        goldWeightMg: 133,
        goldPurity: '916',
        collectorRole: 'CUSTOMER',
        createdBy: actor._id,
      },
    ]);
    await SchemeEnrollment.updateOne(
      { _id: enrollment._id },
      {
        $set: {
          settlementLockUntil: new Date(Date.now() + 60_000),
          settlementLockedBy: 'stale-payment-init',
        },
      },
    );
    const payment = await finalizeGatewayPayment(
      intent,
      { transactionId: 'txn-race', amountPaise: INSTALLMENT, providerCompletedAt: new Date() },
      { actorId: String(actor._id), actorRole: 'ADMIN', requestId: 'finalize-lock' },
    );
    expect(payment.status).toBe('SUCCESS');
    expect(await Payout.countDocuments({ schemeId: enrollment._id })).toBe(0);
  });
});
