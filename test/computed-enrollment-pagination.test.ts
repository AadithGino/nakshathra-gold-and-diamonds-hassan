import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { addMonths, startOfMonth } from 'date-fns';
import { fromZonedTime, toZonedTime } from 'date-fns-tz';
import {
  Customer,
  Payment,
  SchemeEnrollment,
  User,
} from '../src/models/index.js';
import {
  listEnrollmentsFiltered,
  listRedemptionReadyEnrollments,
} from '../src/services/enrollment-collection.service.js';
import { enrollmentDates } from '../src/services/scheme.service.js';
import { BUSINESS_TZ } from '../src/utils/time.js';
import { clearTestMongo, startTestMongo, stopTestMongo } from './helpers/mongo.js';

const INSTALLMENT = 100_000;
const GOLD_MG = 142;
let seq = 0;
function phone() {
  seq += 1;
  return `+917804${String(seq).padStart(6, '0')}`;
}

async function seedActor() {
  const suffix = `${Date.now()}-${seq}`;
  const [actor] = await User.create([
    { name: 'Page Admin', phone: phone(), passwordHash: 'hash', role: 'ADMIN', status: 'ACTIVE' },
  ]);
  const [customerUser] = await User.create([
    { name: `Page Customer ${suffix}`, phone: phone(), passwordHash: 'hash', role: 'CUSTOMER', status: 'ACTIVE' },
  ]);
  const [customer] = await Customer.create([
    {
      userId: customerUser._id,
      customerCode: `CUST-PAGE-${suffix}`,
      status: 'ACTIVE',
      kycStatus: 'VERIFIED',
      createdBy: actor._id,
    },
  ]);
  return { actor, customer, suffix };
}

async function seedEnrollment(opts: {
  startDate: Date;
  paidMonths?: number[];
  paymentsCompleted?: number;
  enrollmentNumber: string;
  premature?: boolean;
}) {
  const { actor, customer } = await seedActor();
  const dates = enrollmentDates(opts.startDate, 11, 11);
  const [enrollment] = await SchemeEnrollment.create([
    {
      customerId: customer._id,
      schemePlanId: actor._id,
      enrollmentNumber: opts.enrollmentNumber,
      schemeType: 'GOLD_WEIGHT',
      startDate: opts.startDate,
      ...dates,
      durationMonths: 11,
      flexibleMonths: 11,
      monthlyInstallmentPaise: INSTALLMENT,
      makingChargeWaiverPercent: 100,
      gstRateBasisPoints: 300,
      prematureClosureEnabled: opts.premature ?? true,
      prematureClosureMinPaidInstallments: 1,
      prematureClosureSettlementAssets: ['GOLD', 'CASH'],
      maturitySettlementAssets: ['GOLD', 'CASH'],
      paymentsCompleted: opts.paymentsCompleted ?? (opts.paidMonths?.length ?? 0),
      status: 'ACTIVE',
      createdBy: actor._id,
    },
  ]);
  for (const month of opts.paidMonths ?? []) {
    await Payment.create([
      {
        customerId: customer._id,
        schemeId: enrollment._id,
        amountPaise: INSTALLMENT,
        method: 'UPI',
        status: 'SUCCESS',
        paymentDate: opts.startDate,
        schemeMonth: month,
        receiptNumber: `KRL-PAGE-${opts.enrollmentNumber}-${month}`,
        goldWeightMg: GOLD_MG,
        collectorRole: 'ADMIN',
        createdBy: actor._id,
      },
    ]);
  }
  return enrollment;
}

function monthsAgo(n: number) {
  const startLocal = startOfMonth(addMonths(toZonedTime(new Date(), BUSINESS_TZ), -n));
  return fromZonedTime(startLocal, BUSINESS_TZ);
}

const allMonths = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11];

describe('computed-enrollment-pagination', () => {
  beforeAll(async () => {
    await startTestMongo();
  }, 120_000);
  afterAll(async () => {
    await stopTestMongo();
  });
  beforeEach(async () => {
    await clearTestMongo();
  });

  it('fills a redemption-ready page from sparse matches without skipping or duplicating', async () => {
    const eligibleIndexes = new Set([3, 10, 18, 25, 33, 40, 41, 47]);
    const start = monthsAgo(11);
    for (let i = 0; i < 50; i += 1) {
      const startDate = new Date(start.getTime() + i * 60_000);
      await seedEnrollment({
        startDate,
        enrollmentNumber: `ENR-PAGE-${String(i).padStart(2, '0')}`,
        paymentsCompleted: 11,
        paidMonths: eligibleIndexes.has(i) ? allMonths : [],
      });
    }

    const findById = vi.spyOn(Customer, 'findById');
    const aggregate = vi.spyOn(Payment, 'aggregate');
    const page1 = await listRedemptionReadyEnrollments({ mode: 'cursor', cursor: null, limit: 5 });
    expect(page1.items).toHaveLength(5);
    expect(page1.meta.mode).toBe('cursor');
    expect(page1.meta.hasMore).toBe(true);
    const ids1 = page1.items.map((row: { enrollmentNumber: string }) => row.enrollmentNumber);
    expect(ids1).toEqual(['ENR-PAGE-03', 'ENR-PAGE-10', 'ENR-PAGE-18', 'ENR-PAGE-25', 'ENR-PAGE-33']);

    const page2 = await listRedemptionReadyEnrollments({
      mode: 'cursor',
      cursor: page1.meta.mode === 'cursor' ? page1.meta.nextCursor : null,
      limit: 5,
    });
    const ids2 = page2.items.map((row: { enrollmentNumber: string }) => row.enrollmentNumber);
    expect(ids2).toEqual(['ENR-PAGE-40', 'ENR-PAGE-41', 'ENR-PAGE-47']);
    expect(new Set([...ids1, ...ids2]).size).toBe(8);
    expect(findById).not.toHaveBeenCalled();
    expect(aggregate).not.toHaveBeenCalled();
  }, 60_000);

  it('applies premature and installmentStatus filters without underfilling the page', async () => {
    await seedEnrollment({
      startDate: monthsAgo(3),
      enrollmentNumber: 'ENR-PREM-01',
      paidMonths: [1],
      premature: true,
    });
    await seedEnrollment({
      startDate: monthsAgo(3),
      enrollmentNumber: 'ENR-PREM-02',
      paidMonths: [],
      premature: false,
    });
    const page = await listEnrollmentsFiltered(
      { mode: 'cursor', cursor: null, limit: 5 },
      { prematureClosureEligible: true },
    );
    expect(page.items.some((row: { enrollmentNumber: string }) => row.enrollmentNumber === 'ENR-PREM-01')).toBe(
      true,
    );
    expect(page.items.some((row: { enrollmentNumber: string }) => row.enrollmentNumber === 'ENR-PREM-02')).toBe(
      false,
    );
  });

  it('keeps ordinary search working without computed filters', async () => {
    await seedEnrollment({
      startDate: monthsAgo(1),
      enrollmentNumber: 'ENR-SEARCH-UNIQUE',
      paidMonths: [1],
    });
    const page = await listEnrollmentsFiltered(
      { mode: 'offset', page: 1, limit: 10 },
      { search: 'ENR-SEARCH-UNIQUE' },
    );
    expect(page.items).toHaveLength(1);
    expect(page.items[0].enrollmentNumber).toBe('ENR-SEARCH-UNIQUE');
  });
});
