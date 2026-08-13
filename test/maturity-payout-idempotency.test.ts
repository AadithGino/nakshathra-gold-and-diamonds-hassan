import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { addMonths, startOfMonth } from 'date-fns';
import { fromZonedTime, toZonedTime } from 'date-fns-tz';
import {
  Customer,
  GoldRate,
  Payment,
  Payout,
  SchemeEnrollment,
  User,
} from '../src/models/index.js';
import { createPayout } from '../src/services/finance.service.js';
import { recordGoldInventoryMovement } from '../src/services/gold-control.service.js';
import {
  defaultMaturityIdempotencyKey,
  executeSchemeSettlement,
} from '../src/services/scheme-settlement.service.js';
import { enrollmentDates } from '../src/services/scheme.service.js';
import { BUSINESS_TZ, businessDayRange } from '../src/utils/time.js';
import { clearTestMongo, startTestMongo, stopTestMongo } from './helpers/mongo.js';

const INSTALLMENT = 100_000;
const GOLD_MG = 142;
const RATE = 700_000;
const allMonths = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11];
let seq = 0;
function phone() {
  seq += 1;
  return `+917805${String(seq).padStart(6, '0')}`;
}

async function seedMature() {
  const suffix = `${Date.now()}-${seq}`;
  const [actor] = await User.create([
    { name: 'Idem Admin', phone: phone(), passwordHash: 'hash', role: 'ADMIN', status: 'ACTIVE' },
  ]);
  const [customerUser] = await User.create([
    { name: 'Idem Customer', phone: phone(), passwordHash: 'hash', role: 'CUSTOMER', status: 'ACTIVE' },
  ]);
  const [customer] = await Customer.create([
    {
      userId: customerUser._id,
      customerCode: `CUST-IDEM-${suffix}`,
      status: 'ACTIVE',
      kycStatus: 'VERIFIED',
      createdBy: actor._id,
    },
  ]);
  const startLocal = startOfMonth(addMonths(toZonedTime(new Date(), BUSINESS_TZ), -11));
  const startDate = fromZonedTime(startLocal, BUSINESS_TZ);
  const dates = enrollmentDates(startDate, 11, 11);
  const [enrollment] = await SchemeEnrollment.create([
    {
      customerId: customer._id,
      schemePlanId: actor._id,
      enrollmentNumber: `ENR-IDEM-${suffix}`,
      schemeType: 'GOLD_WEIGHT',
      startDate,
      ...dates,
      durationMonths: 11,
      flexibleMonths: 11,
      monthlyInstallmentPaise: INSTALLMENT,
      makingChargeWaiverPercent: 100,
      gstRateBasisPoints: 300,
      prematureClosureEnabled: true,
      prematureClosureSettlementAssets: ['GOLD', 'CASH'],
      maturitySettlementAssets: ['GOLD', 'CASH'],
      paymentsCompleted: 11,
      status: 'MATURED',
      createdBy: actor._id,
    },
  ]);
  for (const month of allMonths) {
    await Payment.create([
      {
        customerId: customer._id,
        schemeId: enrollment._id,
        amountPaise: INSTALLMENT,
        method: 'UPI',
        status: 'SUCCESS',
        paymentDate: startDate,
        schemeMonth: month,
        receiptNumber: `KRL-IDEM-${suffix}-${month}`,
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
    { actorId: String(actor._id), actorRole: 'ADMIN', requestId: `stock-idem-${suffix}` },
  );
  return { actor, customer, enrollment };
}

const ctx = (actorId: string, requestId: string) => ({
  actorId,
  actorRole: 'ADMIN' as const,
  requestId,
});

describe('maturity-payout-idempotency', () => {
  beforeAll(async () => {
    await startTestMongo();
  }, 120_000);
  afterAll(async () => {
    await stopTestMongo();
  });
  beforeEach(async () => {
    await clearTestMongo();
  });

  it('replays an omitted maturity key instead of SCHEME_ALREADY_SETTLED', async () => {
    const fixture = await seedMature();
    const input = {
      customerId: String(fixture.customer._id),
      schemeId: String(fixture.enrollment._id),
      payoutDate: new Date(),
      payoutType: 'REDEEM' as const,
      settlementAsset: 'GOLD' as const,
    };
    const first = await createPayout(input, ctx(String(fixture.actor._id), 'redeem-1'));
    const replay = await createPayout(input, ctx(String(fixture.actor._id), 'redeem-2'));
    expect(String(replay._id)).toBe(String(first._id));
    expect(first.idempotencyKey).toBe(
      defaultMaturityIdempotencyKey(String(fixture.enrollment._id), 'GOLD'),
    );
    expect(await Payout.countDocuments({ schemeId: fixture.enrollment._id })).toBe(1);
  });

  it('does not treat GOLD and CASH omitted-key retries as the same intent', async () => {
    const fixture = await seedMature();
    await createPayout(
      {
        customerId: String(fixture.customer._id),
        schemeId: String(fixture.enrollment._id),
        payoutDate: new Date(),
        payoutType: 'REDEEM',
        settlementAsset: 'GOLD',
      },
      ctx(String(fixture.actor._id), 'redeem-gold'),
    );
    await expect(
      createPayout(
        {
          customerId: String(fixture.customer._id),
          schemeId: String(fixture.enrollment._id),
          payoutDate: new Date(),
          payoutType: 'REDEEM',
          settlementAsset: 'CASH',
        },
        ctx(String(fixture.actor._id), 'redeem-cash'),
      ),
    ).rejects.toMatchObject({ code: 'SCHEME_ALREADY_SETTLED' });
  });

  it('rejects the same explicit key with a different settlement asset', async () => {
    const fixture = await seedMature();
    await createPayout(
      {
        customerId: String(fixture.customer._id),
        schemeId: String(fixture.enrollment._id),
        payoutDate: new Date(),
        payoutType: 'REDEEM',
        settlementAsset: 'GOLD',
        idempotencyKey: 'redeem-shared-key-0001',
      },
      ctx(String(fixture.actor._id), 'redeem-key-gold'),
    );
    await expect(
      createPayout(
        {
          customerId: String(fixture.customer._id),
          schemeId: String(fixture.enrollment._id),
          payoutDate: new Date(),
          payoutType: 'REDEEM',
          settlementAsset: 'CASH',
          idempotencyKey: 'redeem-shared-key-0001',
        },
        ctx(String(fixture.actor._id), 'redeem-key-cash'),
      ),
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_KEY_REUSED' });
  });

  it('keeps premature-close idempotency replay working', async () => {
    const suffix = `${Date.now()}-${seq}`;
    const [actor] = await User.create([
      { name: 'Prem Admin', phone: phone(), passwordHash: 'hash', role: 'ADMIN', status: 'ACTIVE' },
    ]);
    const [customerUser] = await User.create([
      { name: 'Prem Customer', phone: phone(), passwordHash: 'hash', role: 'CUSTOMER', status: 'ACTIVE' },
    ]);
    const [customer] = await Customer.create([
      {
        userId: customerUser._id,
        customerCode: `CUST-PREM-${suffix}`,
        status: 'ACTIVE',
        kycStatus: 'VERIFIED',
        createdBy: actor._id,
      },
    ]);
    const startLocal = startOfMonth(addMonths(toZonedTime(new Date(), BUSINESS_TZ), -3));
    const startDate = fromZonedTime(startLocal, BUSINESS_TZ);
    const dates = enrollmentDates(startDate, 11, 11);
    const [enrollment] = await SchemeEnrollment.create([
      {
        customerId: customer._id,
        schemePlanId: actor._id,
        enrollmentNumber: `ENR-PREM-${suffix}`,
        schemeType: 'GOLD_WEIGHT',
        startDate,
        ...dates,
        durationMonths: 11,
        flexibleMonths: 11,
        monthlyInstallmentPaise: INSTALLMENT,
        makingChargeWaiverPercent: 100,
        gstRateBasisPoints: 300,
        prematureClosureEnabled: true,
        prematureClosureSettlementAssets: ['CASH'],
        maturitySettlementAssets: ['GOLD'],
        paymentsCompleted: 2,
        status: 'ACTIVE',
        createdBy: actor._id,
      },
    ]);
    await Payment.create([
      {
        customerId: customer._id,
        schemeId: enrollment._id,
        amountPaise: INSTALLMENT,
        method: 'UPI',
        status: 'SUCCESS',
        paymentDate: startDate,
        schemeMonth: 1,
        receiptNumber: `KRL-PREM-${suffix}-1`,
        goldWeightMg: GOLD_MG,
        collectorRole: 'ADMIN',
        createdBy: actor._id,
      },
    ]);
    const input = {
      enrollmentId: String(enrollment._id),
      kind: 'PREMATURE_CLOSE' as const,
      settlementAsset: 'CASH' as const,
      payoutDate: new Date(),
      reason: 'Customer requested premature closure',
      idempotencyKey: 'premature-replay-0001',
    };
    const first = await executeSchemeSettlement(input, ctx(String(actor._id), 'prem-1'));
    const replay = await executeSchemeSettlement(input, ctx(String(actor._id), 'prem-2'));
    expect(String(replay._id)).toBe(String(first._id));
  });
});
