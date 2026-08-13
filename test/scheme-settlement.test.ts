import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { addMonths, startOfMonth } from 'date-fns';
import { fromZonedTime, toZonedTime } from 'date-fns-tz';
import {
  AuditLog,
  Customer,
  GoldInventoryMovement,
  GoldRate,
  OutboxEvent,
  Payment,
  PaymentIntent,
  Payout,
  Refund,
  SchemeEnrollment,
  User,
} from '../src/models/index.js';
import { createPayout } from '../src/services/finance.service.js';
import { recordGoldInventoryMovement } from '../src/services/gold-control.service.js';
import {
  calculateSchemeSettlement,
  cashValueFromGoldWeightMg,
  executeSchemeSettlement,
  previewSchemeSettlement,
} from '../src/services/scheme-settlement.service.js';
import { enrollmentDates } from '../src/services/scheme.service.js';
import { aggregateEnrollmentLedger } from '../src/utils/enrollment-ledger.js';
import { BUSINESS_TZ, businessDayRange } from '../src/utils/time.js';
import { AppError } from '../src/utils/AppError.js';
import { clearTestMongo, startTestMongo, stopTestMongo } from './helpers/mongo.js';

const INSTALLMENT = 100_000;
const RATE = 700_000;
const GOLD_MG = 142;
let seq = 0;
function phone() {
  seq += 1;
  return `+917710${String(seq).padStart(6, '0')}`;
}

function monthsAgoStart(monthsAgo: number, at = new Date()) {
  const startLocal = startOfMonth(addMonths(toZonedTime(at, BUSINESS_TZ), -monthsAgo));
  return fromZonedTime(startLocal, BUSINESS_TZ);
}

async function seed(opts: {
  monthsAgo: number;
  paidMonths: number[];
  status?: 'ACTIVE' | 'MATURED';
  prematureMin?: number;
  cashBasis?: 'CONTRIBUTION_VALUE' | 'CURRENT_GOLD_VALUE';
  assets?: Array<'GOLD' | 'CASH'>;
  kycStatus?: 'VERIFIED' | 'PENDING';
}) {
  const suffix = `${Date.now()}-${seq}`;
  const [actor] = await User.create([
    { name: 'Settle Admin', phone: phone(), passwordHash: 'hash', role: 'ADMIN', status: 'ACTIVE' },
  ]);
  const [customerUser] = await User.create([
    { name: 'Settle Customer', phone: phone(), passwordHash: 'hash', role: 'CUSTOMER', status: 'ACTIVE' },
  ]);
  const [customer] = await Customer.create([
    {
      userId: customerUser._id,
      customerCode: `CUST-SET-${suffix}`,
      status: 'ACTIVE',
      kycStatus: opts.kycStatus ?? 'VERIFIED',
      createdBy: actor._id,
    },
  ]);
  const startDate = monthsAgoStart(opts.monthsAgo);
  const dates = enrollmentDates(startDate, 11, 11);
  const [enrollment] = await SchemeEnrollment.create([
    {
      customerId: customer._id,
      schemePlanId: actor._id,
      enrollmentNumber: `ENR-SET-${suffix}`,
      schemeType: 'GOLD_WEIGHT',
      startDate,
      ...dates,
      durationMonths: 11,
      flexibleMonths: 11,
      monthlyInstallmentPaise: INSTALLMENT,
      makingChargeWaiverPercent: 100,
      gstRateBasisPoints: 300,
      paymentWindowType: 'FIXED_DAY',
      fixedPaymentDay: 5,
      prematureClosureEnabled: true,
      prematureClosureMinPaidInstallments: opts.prematureMin ?? 1,
      prematureClosureSettlementAssets: opts.assets ?? ['GOLD', 'CASH'],
      maturitySettlementAssets: opts.assets ?? ['GOLD', 'CASH'],
      prematureClosureCashBasis: opts.cashBasis ?? 'CONTRIBUTION_VALUE',
      maturityCashBasis: opts.cashBasis ?? 'CONTRIBUTION_VALUE',
      paymentsCompleted: opts.paidMonths.length,
      status: opts.status ?? 'ACTIVE',
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
        receiptNumber: `KRL-SET-${suffix}-${month}`,
        goldWeightMg: GOLD_MG,
        goldRatePerGramPaise: RATE,
        collectorRole: 'ADMIN',
        createdBy: actor._id,
      },
    ]);
  }
  const { start: todayStart } = businessDayRange(new Date());
  const existingRate = await GoldRate.findOne({ effectiveFrom: todayStart, purity: '916' });
  if (!existingRate) {
    await GoldRate.create([
      {
        ratePerGramPaise: RATE,
        purity: '916',
        effectiveFrom: todayStart,
        status: 'ACTIVE',
        createdBy: actor._id,
      },
    ]);
  }
  await recordGoldInventoryMovement(
    {
      movementType: 'OPENING_STOCK',
      goldWeightMg: 50_000,
      movementDate: new Date(),
      reason: 'Test opening stock',
    },
    { actorId: String(actor._id), actorRole: 'ADMIN', requestId: `stock-${suffix}` },
  );
  return { actor, customer, enrollment, startDate };
}

const allMonths = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11];
const ctx = (actorId: string, requestId: string) => ({
  actorId,
  actorRole: 'ADMIN' as const,
  requestId,
});

describe('scheme settlement', () => {
  beforeAll(async () => {
    await startTestMongo();
  }, 120_000);
  afterAll(async () => {
    await stopTestMongo();
  });
  beforeEach(async () => {
    await clearTestMongo();
  });

  it('previews premature GOLD and CASH contribution value without mutating finance', async () => {
    const fixture = await seed({ monthsAgo: 3, paidMonths: [1, 2, 3] });
    const before = await Payout.countDocuments();
    const gold = await previewSchemeSettlement({
      enrollmentId: String(fixture.enrollment._id),
      kind: 'PREMATURE_CLOSE',
      settlementAsset: 'GOLD',
    });
    const cash = await previewSchemeSettlement({
      enrollmentId: String(fixture.enrollment._id),
      kind: 'PREMATURE_CLOSE',
      settlementAsset: 'CASH',
    });
    expect(gold.eligible).toBe(true);
    expect(gold.goldWeightMg).toBe(3 * GOLD_MG);
    expect(gold.settlementPrincipalPaise).toBe(3 * INSTALLMENT);
    expect(cash.cashBasis).toBe('CONTRIBUTION_VALUE');
    expect(cash.cashAmountPaise).toBe(3 * INSTALLMENT);
    expect(await Payout.countDocuments()).toBe(before);
    expect(await SchemeEnrollment.findById(fixture.enrollment._id).then((row) => row?.status)).toBe(
      'ACTIVE',
    );
  });

  it('blocks premature preview below min installments, in redemption window, and without KYC', async () => {
    const low = await seed({ monthsAgo: 3, paidMonths: [1], prematureMin: 3 });
    const lowPreview = await previewSchemeSettlement({
      enrollmentId: String(low.enrollment._id),
      kind: 'PREMATURE_CLOSE',
      settlementAsset: 'CASH',
    });
    expect(lowPreview.eligible).toBe(false);
    expect(lowPreview.blockingReasons).toContain('PREMATURE_CLOSURE_MIN_INSTALLMENTS');

    const matureWindow = await seed({ monthsAgo: 11, paidMonths: allMonths });
    const windowPreview = await previewSchemeSettlement({
      enrollmentId: String(matureWindow.enrollment._id),
      kind: 'PREMATURE_CLOSE',
      settlementAsset: 'GOLD',
    });
    expect(windowPreview.blockingReasons).toContain('USE_MATURITY_REDEMPTION_FLOW');

    const kyc = await seed({ monthsAgo: 3, paidMonths: [1, 2], kycStatus: 'PENDING' });
    const kycPreview = await previewSchemeSettlement({
      enrollmentId: String(kyc.enrollment._id),
      kind: 'PREMATURE_CLOSE',
      settlementAsset: 'CASH',
    });
    expect(kycPreview.blockingReasons).toContain('KYC_VERIFICATION_REQUIRED');
  });

  it('calculates CURRENT_GOLD_VALUE with integer-safe floor', async () => {
    const fixture = await seed({
      monthsAgo: 3,
      paidMonths: [1, 2],
      cashBasis: 'CURRENT_GOLD_VALUE',
    });
    const preview = await previewSchemeSettlement({
      enrollmentId: String(fixture.enrollment._id),
      kind: 'PREMATURE_CLOSE',
      settlementAsset: 'CASH',
    });
    expect(preview.cashBasis).toBe('CURRENT_GOLD_VALUE');
    expect(preview.cashAmountPaise).toBe(cashValueFromGoldWeightMg(2 * GOLD_MG, RATE));
    expect(preview.valuation?.ratePerGramPaise).toBe(RATE);
  });

  it('executes GOLD and CASH premature close to CLOSED with zero remaining ledger', async () => {
    const goldFixture = await seed({ monthsAgo: 3, paidMonths: [1, 2] });
    const goldPayout = await executeSchemeSettlement(
      {
        enrollmentId: String(goldFixture.enrollment._id),
        kind: 'PREMATURE_CLOSE',
        settlementAsset: 'GOLD',
        payoutDate: new Date(),
        reason: 'Customer requested premature closure',
        idempotencyKey: 'premature-gold-1',
      },
      ctx(String(goldFixture.actor._id), 'pc-gold'),
    );
    expect(goldPayout.method).toBe('GOLD');
    const goldEnrollment = await SchemeEnrollment.findById(goldFixture.enrollment._id);
    expect(goldEnrollment?.status).toBe('CLOSED');
    const goldLedger = await aggregateEnrollmentLedger(String(goldFixture.enrollment._id));
    expect(goldLedger.availablePaise).toBe(0);
    expect(goldLedger.availableGoldWeightMg).toBe(0);
    expect(await GoldInventoryMovement.countDocuments({ payoutId: goldPayout._id })).toBe(1);
    expect(await AuditLog.findOne({ action: 'PAYOUT_CREATED', entityId: goldPayout._id })).toBeTruthy();

    const cashFixture = await seed({ monthsAgo: 3, paidMonths: [1, 2, 3] });
    const inventoryBefore = await GoldInventoryMovement.countDocuments({
      movementType: 'ISSUE_TO_CUSTOMER',
    });
    const cashPayout = await executeSchemeSettlement(
      {
        enrollmentId: String(cashFixture.enrollment._id),
        kind: 'PREMATURE_CLOSE',
        settlementAsset: 'CASH',
        payoutDate: new Date(),
        reason: 'Customer requested premature closure',
        idempotencyKey: 'premature-cash-1',
      },
      ctx(String(cashFixture.actor._id), 'pc-cash'),
    );
    expect(cashPayout.method).toBe('CASH');
    expect(cashPayout.amountPaise).toBe(3 * INSTALLMENT);
    expect(await SchemeEnrollment.findById(cashFixture.enrollment._id).then((row) => row?.status)).toBe(
      'CLOSED',
    );
    expect(await GoldInventoryMovement.countDocuments({ movementType: 'ISSUE_TO_CUSTOMER' })).toBe(
      inventoryBefore,
    );
    const cashLedger = await aggregateEnrollmentLedger(String(cashFixture.enrollment._id));
    expect(cashLedger.availableGoldWeightMg).toBe(0);
  });

  it('replays the same idempotency key and rejects a second concurrent payout', async () => {
    const fixture = await seed({ monthsAgo: 3, paidMonths: [1, 2] });
    const first = await executeSchemeSettlement(
      {
        enrollmentId: String(fixture.enrollment._id),
        kind: 'PREMATURE_CLOSE',
        settlementAsset: 'GOLD',
        payoutDate: new Date(),
        reason: 'Customer requested premature closure',
        idempotencyKey: 'same-key',
      },
      ctx(String(fixture.actor._id), 'pc-a'),
    );
    const replay = await executeSchemeSettlement(
      {
        enrollmentId: String(fixture.enrollment._id),
        kind: 'PREMATURE_CLOSE',
        settlementAsset: 'GOLD',
        payoutDate: new Date(),
        reason: 'Customer requested premature closure',
        idempotencyKey: 'same-key',
      },
      ctx(String(fixture.actor._id), 'pc-b'),
    );
    expect(String(replay._id)).toBe(String(first._id));
    expect(await Payout.countDocuments({ schemeId: fixture.enrollment._id, status: 'SUCCESS' })).toBe(1);
    await expect(
      executeSchemeSettlement(
        {
          enrollmentId: String(fixture.enrollment._id),
          kind: 'PREMATURE_CLOSE',
          settlementAsset: 'CASH',
          payoutDate: new Date(),
          reason: 'Customer requested premature closure',
          idempotencyKey: 'other-key',
        },
        ctx(String(fixture.actor._id), 'pc-c'),
      ),
    ).rejects.toMatchObject({ code: 'SCHEME_ALREADY_SETTLED' });
  });

  it('blocks settlement while a PhonePe intent is uncertain', async () => {
    const fixture = await seed({ monthsAgo: 3, paidMonths: [1, 2] });
    await PaymentIntent.create([
      {
        customerId: fixture.customer._id,
        schemeId: fixture.enrollment._id,
        amountPaise: INSTALLMENT,
        merchantTransactionId: `KRL-UNC-${fixture.enrollment._id}`,
        checkoutChannel: 'WEB',
        status: 'PROVIDER_CREATE_UNCERTAIN',
        idempotencyKey: 'uncertain',
        idempotencyScope: 'PHONEPE_CUSTOMER_WEB',
        requestHash: 'hash',
        schemeMonth: 3,
        collectorRole: 'CUSTOMER',
        createdBy: fixture.actor._id,
      },
    ]);
    await expect(
      executeSchemeSettlement(
        {
          enrollmentId: String(fixture.enrollment._id),
          kind: 'PREMATURE_CLOSE',
          settlementAsset: 'CASH',
          payoutDate: new Date(),
          reason: 'Customer requested premature closure',
          idempotencyKey: 'blocked-intent',
        },
        ctx(String(fixture.actor._id), 'pc-block'),
      ),
    ).rejects.toMatchObject({ code: 'SCHEME_SETTLEMENT_BLOCKED_PENDING_PAYMENT' });
  });

  it('redeems GOLD at maturity and supports CASH without issuing inventory', async () => {
    const gold = await seed({ monthsAgo: 11, paidMonths: allMonths, status: 'MATURED' });
    const payout = await createPayout(
      {
        customerId: String(gold.customer._id),
        schemeId: String(gold.enrollment._id),
        payoutDate: new Date(),
        payoutType: 'REDEEM',
      },
      ctx(String(gold.actor._id), 'redeem-gold'),
    );
    expect(payout.method).toBe('GOLD');
    expect(await SchemeEnrollment.findById(gold.enrollment._id).then((row) => row?.status)).toBe(
      'REDEEMED',
    );
    expect(await GoldInventoryMovement.countDocuments({ payoutId: payout._id })).toBe(1);

    const cash = await seed({ monthsAgo: 11, paidMonths: allMonths, status: 'MATURED' });
    const beforeIssue = await GoldInventoryMovement.countDocuments({ movementType: 'ISSUE_TO_CUSTOMER' });
    const cashPayout = await createPayout(
      {
        customerId: String(cash.customer._id),
        schemeId: String(cash.enrollment._id),
        payoutDate: new Date(),
        payoutType: 'REDEEM',
        settlementAsset: 'CASH',
        idempotencyKey: 'redeem-cash-1',
      },
      ctx(String(cash.actor._id), 'redeem-cash'),
    );
    expect(cashPayout.method).toBe('CASH');
    expect(await GoldInventoryMovement.countDocuments({ movementType: 'ISSUE_TO_CUSTOMER' })).toBe(
      beforeIssue,
    );
  });

  it('uses the shared calculation for CURRENT_GOLD_VALUE cash', () => {
    const calc = calculateSchemeSettlement({
      kind: 'REDEEM',
      settlementAsset: 'CASH',
      ledger: {
        totalPaidPaise: 200_000,
        totalGoldWeightMg: 284,
        totalPayoutPaise: 0,
        totalSettlementPrincipalPaise: 0,
        totalPayoutGoldWeightMg: 0,
        paymentsCompleted: 2,
        availablePaise: 200_000,
        availableGoldWeightMg: 284,
      },
      policy: {
        prematureClosureEnabled: true,
        prematureClosureMinPaidInstallments: 1,
        prematureClosureSettlementAssets: ['GOLD', 'CASH'],
        maturitySettlementAssets: ['GOLD', 'CASH'],
        prematureClosureCashBasis: 'CONTRIBUTION_VALUE',
        maturityCashBasis: 'CURRENT_GOLD_VALUE',
      },
      goldRate: { _id: 'rate', ratePerGramPaise: RATE },
    });
    expect(calc.amountPaise).toBe(cashValueFromGoldWeightMg(284, RATE));
    expect(calc.settlementPrincipalPaise).toBe(200_000);
  });
});
