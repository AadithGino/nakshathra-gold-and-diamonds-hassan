import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { addDays, addMonths, startOfMonth } from 'date-fns';
import { fromZonedTime, toZonedTime } from 'date-fns-tz';
import {
  Customer,
  GoldRate,
  Payment,
  Payout,
  SchemeEnrollment,
  User,
} from '../src/models/index.js';
import { recordGoldInventoryMovement } from '../src/services/gold-control.service.js';
import {
  executeSchemeSettlement,
  previewSchemeSettlement,
} from '../src/services/scheme-settlement.service.js';
import { enrollmentDates } from '../src/services/scheme.service.js';
import { BUSINESS_TZ, businessDayRange } from '../src/utils/time.js';
import { AppError } from '../src/utils/AppError.js';
import { clearTestMongo, startTestMongo, stopTestMongo } from './helpers/mongo.js';

const INSTALLMENT = 100_000;
const GOLD_MG = 142;
const RATE_TODAY = 900_000;
const RATE_OLD = 500_000;
let seq = 0;
function phone() {
  seq += 1;
  return `+917802${String(seq).padStart(6, '0')}`;
}

async function seed(opts: {
  monthsAgo: number;
  paidMonths: number[];
  cashBasis?: 'CONTRIBUTION_VALUE' | 'CURRENT_GOLD_VALUE';
}) {
  const suffix = `${Date.now()}-${seq}`;
  const [actor] = await User.create([
    { name: 'Time Admin', phone: phone(), passwordHash: 'hash', role: 'ADMIN', status: 'ACTIVE' },
  ]);
  const [customerUser] = await User.create([
    { name: 'Time Customer', phone: phone(), passwordHash: 'hash', role: 'CUSTOMER', status: 'ACTIVE' },
  ]);
  const [customer] = await Customer.create([
    {
      userId: customerUser._id,
      customerCode: `CUST-TIME-${suffix}`,
      status: 'ACTIVE',
      kycStatus: 'VERIFIED',
      createdBy: actor._id,
    },
  ]);
  const startLocal = startOfMonth(addMonths(toZonedTime(new Date(), BUSINESS_TZ), -opts.monthsAgo));
  const startDate = fromZonedTime(startLocal, BUSINESS_TZ);
  const dates = enrollmentDates(startDate, 11, 11);
  const [enrollment] = await SchemeEnrollment.create([
    {
      customerId: customer._id,
      schemePlanId: actor._id,
      enrollmentNumber: `ENR-TIME-${suffix}`,
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
        receiptNumber: `KRL-TIME-${suffix}-${month}`,
        goldWeightMg: GOLD_MG,
        goldRatePerGramPaise: RATE_TODAY,
        collectorRole: 'ADMIN',
        createdBy: actor._id,
      },
    ]);
  }
  const { start: todayStart } = businessDayRange(new Date());
  if (!(await GoldRate.findOne({ effectiveFrom: todayStart, purity: '916' }))) {
    await GoldRate.create([
      {
        ratePerGramPaise: RATE_TODAY,
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
    { actorId: String(actor._id), actorRole: 'ADMIN', requestId: `stock-time-${suffix}` },
  );
  return { actor, customer, enrollment, startDate };
}

const ctx = (actorId: string, requestId: string) => ({
  actorId,
  actorRole: 'ADMIN' as const,
  requestId,
});

describe('settlement-operation-time', () => {
  beforeAll(async () => {
    await startTestMongo();
  }, 120_000);
  afterAll(async () => {
    await stopTestMongo();
  });
  beforeEach(async () => {
    await clearTestMongo();
  });

  it('uses live clock for premature vs maturity even when payoutDate is after redemptionStart', async () => {
    const fixture = await seed({ monthsAgo: 11, paidMonths: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11] });
    const payoutDate = fixture.startDate;
    await expect(
      executeSchemeSettlement(
        {
          enrollmentId: String(fixture.enrollment._id),
          kind: 'PREMATURE_CLOSE',
          settlementAsset: 'CASH',
          payoutDate,
          reason: 'Backdated after window',
          idempotencyKey: 'time-premature-window-0001',
        },
        ctx(String(fixture.actor._id), 'time-window'),
      ),
    ).rejects.toMatchObject({ code: 'USE_MATURITY_REDEMPTION_FLOW' });
  });

  it('rejects a future payoutDate instead of using it to grant premature close', async () => {
    const fixture = await seed({ monthsAgo: 3, paidMonths: [1, 2] });
    const future = addDays(new Date(), 2);
    await expect(
      executeSchemeSettlement(
        {
          enrollmentId: String(fixture.enrollment._id),
          kind: 'PREMATURE_CLOSE',
          settlementAsset: 'CASH',
          payoutDate: future,
          reason: 'Future dated close',
          idempotencyKey: 'time-future-0001',
        },
        ctx(String(fixture.actor._id), 'time-future'),
      ),
    ).rejects.toMatchObject({ code: 'PAYOUT_DATE_IN_FUTURE' });
  });

  it('values CURRENT_GOLD_VALUE from today, not the admin payoutDate', async () => {
    const fixture = await seed({
      monthsAgo: 3,
      paidMonths: [1, 2],
      cashBasis: 'CURRENT_GOLD_VALUE',
    });
    const oldDay = addDays(new Date(), -10);
    const { start: oldStart } = businessDayRange(oldDay);
    if (!(await GoldRate.findOne({ effectiveFrom: oldStart, purity: '916' }))) {
      await GoldRate.create([
        {
          ratePerGramPaise: RATE_OLD,
          purity: '916',
          effectiveFrom: oldStart,
          status: 'ACTIVE',
          createdBy: fixture.actor._id,
        },
      ]);
    }
    const preview = await previewSchemeSettlement({
      enrollmentId: String(fixture.enrollment._id),
      kind: 'PREMATURE_CLOSE',
      settlementAsset: 'CASH',
    });
    expect(preview.valuation?.ratePerGramPaise).toBe(RATE_TODAY);

    const payout = await executeSchemeSettlement(
      {
        enrollmentId: String(fixture.enrollment._id),
        kind: 'PREMATURE_CLOSE',
        settlementAsset: 'CASH',
        payoutDate: oldDay,
        reason: 'Old accounting date',
        idempotencyKey: 'time-rate-0001',
      },
      ctx(String(fixture.actor._id), 'time-rate'),
    );
    expect(payout.valuationGoldRatePerGramPaise).toBe(RATE_TODAY);
    expect(payout.valuationGoldRatePerGramPaise).not.toBe(RATE_OLD);
    expect(new Date(payout.payoutDate).getTime()).toBe(oldDay.getTime());
  });
});
