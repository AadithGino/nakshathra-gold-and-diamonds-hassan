import { readFile } from 'node:fs/promises';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { addDays, addMonths, startOfMonth } from 'date-fns';
import { fromZonedTime, toZonedTime } from 'date-fns-tz';
import {
  Customer,
  GoldInventoryMovement,
  GoldRate,
  Payment,
  PaymentIntent,
  Payout,
  SchemeEnrollment,
  SystemSetting,
  User,
} from '../src/models/index.js';
import { createPayout } from '../src/services/finance.service.js';
import { initiatePhonePe } from '../src/services/gateway.service.js';
import { recordGoldInventoryMovement } from '../src/services/gold-control.service.js';
import { phonePeProvider } from '../src/services/phonepe.provider.js';
import {
  cashValueFromGoldWeightMg,
  executeSchemeSettlement,
  settlementRequestHash,
} from '../src/services/scheme-settlement.service.js';
import { enrollmentDates } from '../src/services/scheme.service.js';
import { AppError } from '../src/utils/AppError.js';
import { aggregateEnrollmentLedger } from '../src/utils/enrollment-ledger.js';
import { BUSINESS_TZ, businessDayRange } from '../src/utils/time.js';
import { clearTestMongo, startTestMongo, stopTestMongo } from './helpers/mongo.js';

const INSTALLMENT = 100_000;
const GOLD_MG = 142;
const RATE = 700_000;
const MARKET_RATE = 900_000;
const allMonths = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11];
let seq = 0;
function phone() {
  seq += 1;
  return `+917890${String(seq).padStart(6, '0')}`;
}

async function readSrc(relativeFromTest: string) {
  return readFile(new URL(relativeFromTest, import.meta.url), 'utf8');
}

function monthsAgoStart(monthsAgo: number, at = new Date()) {
  const startLocal = startOfMonth(addMonths(toZonedTime(at, BUSINESS_TZ), -monthsAgo));
  return fromZonedTime(startLocal, BUSINESS_TZ);
}

async function seedEnrollment(opts: {
  monthsAgo: number;
  paidMonths: number[];
  status?: 'ACTIVE' | 'MATURED';
  cashBasis?: 'CONTRIBUTION_VALUE' | 'CURRENT_GOLD_VALUE';
  ratePerGramPaise?: number;
  enablePhonePe?: boolean;
}) {
  const suffix = `${Date.now()}-${seq}`;
  const rate = opts.ratePerGramPaise ?? RATE;
  const [actor] = await User.create([
    { name: 'Audit Admin', phone: phone(), passwordHash: 'hash', role: 'ADMIN', status: 'ACTIVE' },
  ]);
  const [customerUser] = await User.create([
    { name: 'Audit Customer', phone: phone(), passwordHash: 'hash', role: 'CUSTOMER', status: 'ACTIVE' },
  ]);
  const [customer] = await Customer.create([
    {
      userId: customerUser._id,
      customerCode: `CUST-AUD-${suffix}`,
      status: 'ACTIVE',
      kycStatus: 'VERIFIED',
      createdBy: actor._id,
    },
  ]);
  const startDate = monthsAgoStart(opts.monthsAgo);
  const dates = enrollmentDates(startDate, 11, 11);
  const [enrollment] = await SchemeEnrollment.create([
    {
      customerId: customer._id,
      schemePlanId: actor._id,
      enrollmentNumber: `ENR-AUD-${suffix}`,
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
        receiptNumber: `KRL-AUD-${suffix}-${month}`,
        goldWeightMg: GOLD_MG,
        goldRatePerGramPaise: RATE,
        collectorRole: 'ADMIN',
        createdBy: actor._id,
      },
    ]);
  }
  const { start: todayStart } = businessDayRange(new Date());
  if (!(await GoldRate.findOne({ effectiveFrom: todayStart, purity: '916' }))) {
    await GoldRate.create([
      {
        ratePerGramPaise: rate,
        purity: '916',
        effectiveFrom: todayStart,
        status: 'ACTIVE',
        createdBy: actor._id,
      },
    ]);
  } else if (opts.ratePerGramPaise) {
    await GoldRate.updateOne(
      { effectiveFrom: todayStart, purity: '916' },
      { $set: { ratePerGramPaise: rate } },
    );
  }
  await recordGoldInventoryMovement(
    {
      movementType: 'OPENING_STOCK',
      goldWeightMg: 50_000,
      movementDate: new Date(),
      reason: 'Audit opening stock',
    },
    { actorId: String(actor._id), actorRole: 'ADMIN', requestId: `stock-aud-${suffix}` },
  );
  if (opts.enablePhonePe) {
    await SystemSetting.create([{ singletonKey: 'GLOBAL', customerPhonePeEnabled: true }]);
  }
  return { actor, customerUser, customer, enrollment };
}

const ctx = (actorId: string, requestId: string) => ({
  actorId,
  actorRole: 'ADMIN' as const,
  requestId,
});

describe('post-phase9 production audit — static invariants', () => {
  it('registers overdue/due/redemption-ready before /enrollments/:id', async () => {
    const source = await readSrc('../src/routes/admin/scheme-admin.routes.ts');
    const overdue = source.indexOf('/enrollments/overdue');
    const due = source.indexOf('/enrollments/due');
    const ready = source.indexOf('/enrollments/redemption-ready');
    const byId = source.indexOf('/enrollments/:id');
    expect(overdue).toBeGreaterThan(-1);
    expect(due).toBeGreaterThan(-1);
    expect(ready).toBeGreaterThan(-1);
    expect(byId).toBeGreaterThan(-1);
    expect(overdue).toBeLessThan(byId);
    expect(due).toBeLessThan(byId);
    expect(ready).toBeLessThan(byId);
  });

  it('hashes maturity requests by payoutDate business day, not server now', () => {
    const payoutDate = new Date('2026-03-09T18:30:00.000Z');
    const input = {
      customerId: 'cust-1',
      schemeId: 'sch-1',
      kind: 'REDEEM' as const,
      settlementAsset: 'GOLD' as const,
      payoutDate,
    };
    vi.useFakeTimers({ now: new Date('2026-03-10T06:30:00.000Z'), toFake: ['Date'] });
    try {
      const dayN = settlementRequestHash(input);
      vi.setSystemTime(new Date('2026-03-11T06:30:00.000Z'));
      const dayNPlusOne = settlementRequestHash(input);
      expect(dayNPlusOne).toBe(dayN);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('post-phase9 production audit — section 67 edges', () => {
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
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('replays the same maturity request after the server calendar day advances', async () => {
    const fixture = await seedEnrollment({
      monthsAgo: 11,
      paidMonths: allMonths,
      status: 'MATURED',
    });
    const payoutDate = new Date();
    const input = {
      customerId: String(fixture.customer._id),
      schemeId: String(fixture.enrollment._id),
      payoutDate,
      payoutType: 'REDEEM' as const,
      settlementAsset: 'GOLD' as const,
    };
    const first = await createPayout(input, ctx(String(fixture.actor._id), 'cross-day-1'));
    vi.useFakeTimers({ now: addDays(payoutDate, 1), toFake: ['Date'] });
    const replay = await createPayout(input, ctx(String(fixture.actor._id), 'cross-day-2'));
    expect(String(replay._id)).toBe(String(first._id));
    expect(await Payout.countDocuments({ schemeId: fixture.enrollment._id, status: 'SUCCESS' })).toBe(
      1,
    );
  });

  it('does not create PhonePe money in the redemption window; redeem still succeeds', async () => {
    const fixture = await seedEnrollment({
      monthsAgo: 11,
      paidMonths: allMonths,
      status: 'ACTIVE',
      enablePhonePe: true,
    });
    const createPayment = vi.spyOn(phonePeProvider, 'createPayment').mockResolvedValue({
      providerOrderId: 'ORD-MATURE',
      state: 'PENDING',
      redirectUrl: 'https://phonepe.test/checkout',
      expiresAt: new Date(Date.now() + 600_000),
    } as any);

    await expect(
      initiatePhonePe(
        String(fixture.customerUser._id),
        {
          schemeId: String(fixture.enrollment._id),
          amountPaise: INSTALLMENT,
          schemeMonth: 11,
          idempotencyKey: 'audit-phonepe-before-redeem-0001',
        },
        'pay-before-redeem',
        'http://localhost:5173',
      ),
    ).rejects.toBeInstanceOf(AppError);
    expect(createPayment).not.toHaveBeenCalled();
    expect(await PaymentIntent.countDocuments({ schemeId: fixture.enrollment._id })).toBe(0);

    const payout = await createPayout(
      {
        customerId: String(fixture.customer._id),
        schemeId: String(fixture.enrollment._id),
        payoutDate: new Date(),
        payoutType: 'REDEEM',
        settlementAsset: 'CASH',
      },
      ctx(String(fixture.actor._id), 'redeem-after-phonepe'),
    );
    expect(payout.status).toBe('SUCCESS');
    expect(await SchemeEnrollment.findById(fixture.enrollment._id).then((row) => row?.status)).toBe(
      'REDEEMED',
    );
    expect(await Payment.countDocuments({ schemeId: fixture.enrollment._id, status: 'SUCCESS' })).toBe(
      11,
    );
  });

  it('rejects PhonePe after maturity redeem and never creates a twelfth installment', async () => {
    const fixture = await seedEnrollment({
      monthsAgo: 11,
      paidMonths: allMonths,
      status: 'ACTIVE',
      enablePhonePe: true,
    });
    vi.spyOn(phonePeProvider, 'createPayment').mockResolvedValue({
      providerOrderId: 'ORD-AFTER',
      state: 'PENDING',
      redirectUrl: 'https://phonepe.test/checkout',
      expiresAt: new Date(Date.now() + 600_000),
    } as any);

    await createPayout(
      {
        customerId: String(fixture.customer._id),
        schemeId: String(fixture.enrollment._id),
        payoutDate: new Date(),
        payoutType: 'REDEEM',
        settlementAsset: 'CASH',
      },
      ctx(String(fixture.actor._id), 'redeem-before-phonepe'),
    );

    await expect(
      initiatePhonePe(
        String(fixture.customerUser._id),
        {
          schemeId: String(fixture.enrollment._id),
          amountPaise: INSTALLMENT,
          schemeMonth: 11,
          idempotencyKey: 'audit-phonepe-after-redeem-0001',
        },
        'pay-after-redeem',
        'http://localhost:5173',
      ),
    ).rejects.toBeInstanceOf(AppError);
    expect(await PaymentIntent.countDocuments({ schemeId: fixture.enrollment._id })).toBe(0);
    expect(await Payment.countDocuments({ schemeId: fixture.enrollment._id, status: 'SUCCESS' })).toBe(
      11,
    );
    const ledger = await aggregateEnrollmentLedger(String(fixture.enrollment._id));
    expect(ledger.availablePaise).toBe(0);
    expect(ledger.availableGoldWeightMg).toBe(0);
  });

  it('never lets concurrent PhonePe and maturity redeem both create money', async () => {
    const fixture = await seedEnrollment({
      monthsAgo: 11,
      paidMonths: allMonths,
      status: 'ACTIVE',
      enablePhonePe: true,
    });
    vi.spyOn(phonePeProvider, 'createPayment').mockResolvedValue({
      providerOrderId: 'ORD-RACE',
      state: 'PENDING',
      redirectUrl: 'https://phonepe.test/checkout',
      expiresAt: new Date(Date.now() + 600_000),
    } as any);

    const results = await Promise.allSettled([
      initiatePhonePe(
        String(fixture.customerUser._id),
        {
          schemeId: String(fixture.enrollment._id),
          amountPaise: INSTALLMENT,
          schemeMonth: 11,
          idempotencyKey: 'audit-phonepe-concurrent-0001',
        },
        'pay-concurrent',
        'http://localhost:5173',
      ),
      createPayout(
        {
          customerId: String(fixture.customer._id),
          schemeId: String(fixture.enrollment._id),
          payoutDate: new Date(),
          payoutType: 'REDEEM',
          settlementAsset: 'CASH',
        },
        ctx(String(fixture.actor._id), 'redeem-concurrent'),
      ),
    ]);

    expect(results.some((row) => row.status === 'fulfilled')).toBe(true);
    expect(await Payment.countDocuments({ schemeId: fixture.enrollment._id, status: 'SUCCESS' })).toBe(
      11,
    );
    expect(await PaymentIntent.countDocuments({ schemeId: fixture.enrollment._id })).toBe(0);
    const enrollment = await SchemeEnrollment.findById(fixture.enrollment._id);
    if (enrollment?.status === 'REDEEMED') {
      const ledger = await aggregateEnrollmentLedger(String(fixture.enrollment._id));
      expect(ledger.availablePaise).toBe(0);
      expect(ledger.availableGoldWeightMg).toBe(0);
      expect(await Payout.countDocuments({ schemeId: fixture.enrollment._id, status: 'SUCCESS' })).toBe(
        1,
      );
    }
  });

  it('leaves principal at zero, not negative, when CURRENT_GOLD_VALUE cash exceeds contribution', async () => {
    const fixture = await seedEnrollment({
      monthsAgo: 3,
      paidMonths: [1, 2],
      cashBasis: 'CURRENT_GOLD_VALUE',
      ratePerGramPaise: MARKET_RATE,
    });
    const marketCash = cashValueFromGoldWeightMg(2 * GOLD_MG, MARKET_RATE);
    expect(marketCash).toBeGreaterThan(2 * INSTALLMENT);

    const payout = await executeSchemeSettlement(
      {
        enrollmentId: String(fixture.enrollment._id),
        kind: 'PREMATURE_CLOSE',
        settlementAsset: 'CASH',
        payoutDate: new Date(),
        reason: 'Market-value cash above principal',
        idempotencyKey: 'audit-cash-above-principal-0001',
      },
      ctx(String(fixture.actor._id), 'cash-above'),
    );

    expect(payout.amountPaise).toBe(marketCash);
    expect(payout.settlementPrincipalPaise).toBe(2 * INSTALLMENT);
    expect(payout.amountPaise).toBeGreaterThan(payout.settlementPrincipalPaise);
    expect(await SchemeEnrollment.findById(fixture.enrollment._id).then((row) => row?.status)).toBe(
      'CLOSED',
    );
    const ledger = await aggregateEnrollmentLedger(String(fixture.enrollment._id));
    expect(ledger.availablePaise).toBe(0);
    expect(ledger.availableGoldWeightMg).toBe(0);
    expect(ledger.availablePaise).not.toBeLessThan(0);
    expect(
      await GoldInventoryMovement.countDocuments({
        movementType: 'ISSUE_TO_CUSTOMER',
        payoutId: payout._id,
      }),
    ).toBe(0);
  });
});
