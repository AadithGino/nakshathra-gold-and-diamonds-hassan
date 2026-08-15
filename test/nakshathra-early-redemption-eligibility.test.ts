import { addMonths, startOfMonth } from 'date-fns';
import { fromZonedTime, toZonedTime } from 'date-fns-tz';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { NAKSHATHRA_PREMATURE_CLOSURE_MIN_ELAPSED_MONTHS } from '../src/config/business.js';
import { Customer, Payment, Payout, User } from '../src/models/index.js';
import { hashPassword } from '../src/services/auth.service.js';
import { createCustomer } from '../src/services/customer.service.js';
import { createPayout } from '../src/services/finance.service.js';
import { createManualPayment } from '../src/services/payment.service.js';
import {
  createEnrollment,
  createSchemePlan,
  prematureCloseEnrollment,
  previewPrematureClosure,
  previewRedemption,
} from '../src/services/scheme-management.service.js';
import { previewSchemeSettlement } from '../src/services/scheme-settlement.service.js';
import {
  isPrematureClosureTimeEligible,
  prematureClosureEligibilityBoundary,
} from '../src/utils/premature-closure-policy.js';
import { LIVE_CASH_SETTLEMENT_POLICY } from '../src/utils/payment-window.js';
import { addSchemeMonths, BUSINESS_TZ } from '../src/utils/time.js';
import { clearTestMongo, startTestMongo, stopTestMongo } from './helpers/mongo.js';

const ADMIN_PHONE = '+917184900001';
const ADMIN_PASSWORD = 'AdminPass123!';
const CUSTOMER_PASSWORD = 'CustomerPass123!';
const MIN = 100_000;

function adminCtx(actorId: string, requestId: string) {
  return { actorId, actorRole: 'ADMIN' as const, requestId };
}

function monthStartIst(at = new Date()) {
  const local = toZonedTime(at, BUSINESS_TZ);
  const start = startOfMonth(local);
  start.setHours(0, 0, 0, 0);
  return fromZonedTime(start, BUSINESS_TZ);
}

function startMonthsAgo(monthsAgo: number, at = new Date()) {
  const startLocal = startOfMonth(addMonths(toZonedTime(at, BUSINESS_TZ), -monthsAgo));
  return fromZonedTime(startLocal, BUSINESS_TZ);
}

function monthDate(start: Date, monthOffset: number, day = 10) {
  const local = toZonedTime(start, BUSINESS_TZ);
  const shifted = addMonths(startOfMonth(local), monthOffset);
  shifted.setDate(day);
  shifted.setHours(12, 0, 0, 0);
  return fromZonedTime(shifted, BUSINESS_TZ);
}

async function seedAdmin() {
  const [admin] = await User.create([
    {
      name: 'Early Eligibility Admin',
      phone: ADMIN_PHONE,
      passwordHash: await hashPassword(ADMIN_PASSWORD),
      role: 'ADMIN',
      status: 'ACTIVE',
    },
  ]);
  return admin;
}

async function seedVerifiedCustomer(phone: string) {
  const admin = await User.findOne({ role: 'ADMIN' });
  const actorId = String(admin?._id ?? (await seedAdmin())._id);
  const created = await createCustomer(
    { name: 'Early Eligibility Customer', phone, password: CUSTOMER_PASSWORD },
    adminCtx(actorId, `ee-customer-${phone}`),
  );
  await Customer.updateOne({ _id: created.customer._id }, { $set: { kycStatus: 'VERIFIED' } });
  return created.customer;
}

async function seedCashPlan() {
  const admin = await User.findOne({ role: 'ADMIN' });
  const actorId = String(admin?._id ?? (await seedAdmin())._id);
  return createSchemePlan(
    {
      name: 'Early Eligibility Cash',
      type: 'CASH',
      durationMonths: 11,
      minimumPaymentPaise: MIN,
      termsText: 'Eleven contribution months then cash or jewellery settlement.',
    },
    adminCtx(actorId, 'ee-plan'),
  );
}

async function enroll(customerId: string, planId: string, startDate: Date, requestId: string) {
  const admin = await User.findOne({ role: 'ADMIN' });
  return createEnrollment(
    { customerId, schemePlanId: planId, startDate, monthlyInstallmentPaise: MIN },
    adminCtx(String(admin!._id), requestId),
  );
}

async function payMonth1(
  actorId: string,
  customerId: string,
  schemeId: string,
  start: Date,
  amountPaise: number,
  key: string,
) {
  return createManualPayment(
    {
      customerId,
      schemeId,
      amountPaise,
      method: 'CASH',
      paymentDate: monthDate(start, 0),
      idempotencyKey: key,
    },
    adminCtx(actorId, key),
  );
}

describe('Nakshathra early redemption — 6 elapsed scheme months', () => {
  beforeAll(async () => {
    await startTestMongo();
  }, 120_000);
  afterAll(async () => {
    await stopTestMongo();
  });
  beforeEach(async () => {
    await clearTestMongo();
  });

  it('configures elapsed months, not paid-installment count, as the Nakshathra time gate', async () => {
    expect(NAKSHATHRA_PREMATURE_CLOSURE_MIN_ELAPSED_MONTHS).toBe(6);
    expect(LIVE_CASH_SETTLEMENT_POLICY.prematureClosureMinElapsedMonths).toBe(6);
    const admin = await seedAdmin();
    const plan = await seedCashPlan();
    expect(plan.prematureClosureMinElapsedMonths).toBe(6);
    expect(admin.role).toBe('ADMIN');
  });

  it('rejects EARLY one day after enrollment even with a successful payment', async () => {
    const admin = await seedAdmin();
    const plan = await seedCashPlan();
    const customer = await seedVerifiedCustomer('+917184900101');
    const start = monthStartIst();
    const enrollment = await enroll(String(customer._id), String(plan._id), start, 'ee-day1');
    await payMonth1(
      String(admin._id),
      String(customer._id),
      String(enrollment._id),
      start,
      MIN,
      'ee-day1-pay',
    );

    const preview = await previewSchemeSettlement({
      enrollmentId: String(enrollment._id),
      kind: 'PREMATURE_CLOSE',
      settlementAsset: 'CASH',
      at: new Date(start.getTime() + 24 * 60 * 60 * 1000),
    });
    expect(preview.eligible).toBe(false);
    expect(preview.allowedSettlementModes).toEqual([]);
    expect(preview.reason).toBe('PREMATURE_CLOSURE_NOT_YET_ELIGIBLE');
    expect(preview.blockingReasons).toContain('PREMATURE_CLOSURE_NOT_YET_ELIGIBLE');

    await expect(
      prematureCloseEnrollment(
        String(enrollment._id),
        {
          settlementAsset: 'CASH',
          payoutDate: new Date(),
          reason: 'Immediate early request',
          idempotencyKey: 'ee-day1-0001',
        },
        adminCtx(String(admin._id), 'ee-day1'),
      ),
    ).rejects.toMatchObject({ code: 'PREMATURE_CLOSURE_NOT_YET_ELIGIBLE' });
  });

  it('rejects EARLY before 6 months even after many Month-1 payments', async () => {
    const admin = await seedAdmin();
    const plan = await seedCashPlan();
    const customer = await seedVerifiedCustomer('+917184900102');
    const start = monthStartIst();
    const enrollment = await enroll(String(customer._id), String(plan._id), start, 'ee-many');
    for (let i = 0; i < 10; i += 1) {
      await payMonth1(
        String(admin._id),
        String(customer._id),
        String(enrollment._id),
        start,
        MIN,
        `ee-many-pay-${i}`,
      );
    }

    const preview = await previewPrematureClosure(String(enrollment._id), 'CASH');
    expect(preview.eligible).toBe(false);
    expect(preview.paymentsCompleted).toBe(1);
    expect(preview.totalPaidPaise).toBe(10 * MIN);
    expect(preview.blockingReasons).toContain('PREMATURE_CLOSURE_NOT_YET_ELIGIBLE');
  });

  it('rejects just before the 6-month boundary and allows exactly at and after it', async () => {
    const admin = await seedAdmin();
    const plan = await seedCashPlan();
    const customer = await seedVerifiedCustomer('+917184900103');
    const start = new Date('2026-01-10T00:00:00.000+05:30');
    const enrollment = await enroll(String(customer._id), String(plan._id), start, 'ee-boundary');
    await Payment.create([
      {
        customerId: customer._id,
        schemeId: enrollment._id,
        amountPaise: MIN,
        method: 'CASH',
        status: 'SUCCESS',
        paymentDate: monthDate(start, 0),
        schemeMonth: 1,
        receiptNumber: `NKS-EE-BND-${Date.now()}`,
        collectorRole: 'ADMIN',
        collectedBy: admin._id,
        createdBy: admin._id,
        goldWeightMg: 0,
      },
    ]);

    const boundary = prematureClosureEligibilityBoundary(start, 6);
    expect(boundary.toISOString()).toBe(new Date('2026-07-10T00:00:00.000+05:30').toISOString());
    expect(isPrematureClosureTimeEligible(start, 6, new Date(boundary.getTime() - 1))).toBe(false);
    expect(isPrematureClosureTimeEligible(start, 6, boundary)).toBe(true);

    const before = await previewSchemeSettlement({
      enrollmentId: String(enrollment._id),
      kind: 'PREMATURE_CLOSE',
      settlementAsset: 'CASH',
      at: new Date(boundary.getTime() - 1),
    });
    expect(before.eligible).toBe(false);
    expect(before.allowedSettlementModes).toEqual([]);
    expect(before.reason).toBe('PREMATURE_CLOSURE_NOT_YET_ELIGIBLE');

    const atBoundary = await previewSchemeSettlement({
      enrollmentId: String(enrollment._id),
      kind: 'PREMATURE_CLOSE',
      settlementAsset: 'CASH',
      at: boundary,
    });
    expect(atBoundary.eligible).toBe(true);
    expect(atBoundary.allowedSettlementModes).toEqual(['CASH']);

    const after = await previewSchemeSettlement({
      enrollmentId: String(enrollment._id),
      kind: 'PREMATURE_CLOSE',
      settlementAsset: 'CASH',
      at: new Date(boundary.getTime() + 24 * 60 * 60 * 1000),
    });
    expect(after.eligible).toBe(true);
    expect(admin.role).toBe('ADMIN');
  });

  it('allows skipped paid months once six scheme months have elapsed', async () => {
    const admin = await seedAdmin();
    const plan = await seedCashPlan();
    const customer = await seedVerifiedCustomer('+917184900104');
    const start = startMonthsAgo(6);
    const enrollment = await enroll(String(customer._id), String(plan._id), start, 'ee-skip');
    await Payment.create(
      [1, 4].map((month) => ({
        customerId: customer._id,
        schemeId: enrollment._id,
        amountPaise: MIN,
        method: 'CASH',
        status: 'SUCCESS',
        paymentDate: monthDate(start, month - 1),
        schemeMonth: month,
        receiptNumber: `NKS-EE-SKIP-${month}-${Date.now()}`,
        collectorRole: 'ADMIN',
        collectedBy: admin._id,
        createdBy: admin._id,
        goldWeightMg: 0,
      })),
    );

    const preview = await previewPrematureClosure(String(enrollment._id), 'CASH');
    expect(preview.eligible).toBe(true);
    expect(preview.paymentsCompleted).toBe(2);
    const payout = await prematureCloseEnrollment(
      String(enrollment._id),
      {
        settlementAsset: 'CASH',
        payoutDate: new Date(),
        reason: 'Skipped months but six elapsed',
        idempotencyKey: 'ee-skip-0001',
      },
      adminCtx(String(admin._id), 'ee-skip'),
    );
    expect(payout.amountPaise).toBe(2 * MIN);
  });

  it('allows EARLY CASH after six months with only one valid payment', async () => {
    const admin = await seedAdmin();
    const plan = await seedCashPlan();
    const customer = await seedVerifiedCustomer('+917184900105');
    const start = startMonthsAgo(6);
    const enrollment = await enroll(String(customer._id), String(plan._id), start, 'ee-one');
    await payMonth1(
      String(admin._id),
      String(customer._id),
      String(enrollment._id),
      start,
      MIN,
      'ee-one-pay',
    );

    const payout = await prematureCloseEnrollment(
      String(enrollment._id),
      {
        settlementAsset: 'CASH',
        payoutDate: new Date(),
        reason: 'One payment after six months',
        idempotencyKey: 'ee-one-0001',
      },
      adminCtx(String(admin._id), 'ee-one'),
    );
    expect(payout.amountPaise).toBe(MIN);
    expect(payout.settlementPrincipalPaise).toBe(MIN);
    expect(await Payout.countDocuments({ schemeId: enrollment._id, status: 'SUCCESS' })).toBe(1);
  });

  it('still rejects EARLY + JEWELLERY after six elapsed months', async () => {
    const admin = await seedAdmin();
    const plan = await seedCashPlan();
    const customer = await seedVerifiedCustomer('+917184900106');
    const start = startMonthsAgo(6);
    const enrollment = await enroll(String(customer._id), String(plan._id), start, 'ee-jew');
    await payMonth1(
      String(admin._id),
      String(customer._id),
      String(enrollment._id),
      start,
      MIN,
      'ee-jew-pay',
    );

    const preview = await previewPrematureClosure(String(enrollment._id), 'JEWELLERY');
    expect(preview.eligible).toBe(false);
    expect(preview.allowedSettlementModes).toEqual(['CASH']);
    expect(preview.blockingReasons).toContain('SETTLEMENT_ASSET_NOT_ALLOWED');
    await expect(
      prematureCloseEnrollment(
        String(enrollment._id),
        {
          settlementAsset: 'JEWELLERY',
          payoutDate: new Date(),
          reason: 'Jewellery after six months',
          idempotencyKey: 'ee-jew-0001',
        },
        adminCtx(String(admin._id), 'ee-jew'),
      ),
    ).rejects.toMatchObject({ code: 'SETTLEMENT_ASSET_NOT_ALLOWED' });
  });

  it('leaves maturity CASH/JEWELLERY unaffected and rejects zero-entitlement early close', async () => {
    const admin = await seedAdmin();
    const plan = await seedCashPlan();
    const matureCustomer = await seedVerifiedCustomer('+917184900107');
    const matureStart = startMonthsAgo(11);
    const mature = await enroll(
      String(matureCustomer._id),
      String(plan._id),
      matureStart,
      'ee-mat',
    );
    await Payment.create(
      [1, 2, 3].map((month) => ({
        customerId: matureCustomer._id,
        schemeId: mature._id,
        amountPaise: MIN,
        method: 'CASH',
        status: 'SUCCESS',
        paymentDate: monthDate(matureStart, month - 1),
        schemeMonth: month,
        receiptNumber: `NKS-EE-MAT-${month}-${Date.now()}`,
        collectorRole: 'ADMIN',
        collectedBy: admin._id,
        createdBy: admin._id,
        goldWeightMg: 0,
      })),
    );
    const maturityPreview = await previewRedemption(String(mature._id));
    expect(maturityPreview.redemptionType).toBe('MATURITY');
    expect(maturityPreview.allowedSettlementModes).toEqual(['CASH', 'JEWELLERY']);
    const cash = await createPayout(
      {
        customerId: String(matureCustomer._id),
        schemeId: String(mature._id),
        payoutDate: new Date(),
        payoutType: 'PAYOUT',
        settlementAsset: 'CASH',
        idempotencyKey: 'ee-mat-cash-0001',
      },
      adminCtx(String(admin._id), 'ee-mat-cash'),
    );
    expect(cash.amountPaise).toBe(3 * MIN);

    const emptyCustomer = await seedVerifiedCustomer('+917184900108');
    const emptyStart = startMonthsAgo(6);
    const empty = await enroll(String(emptyCustomer._id), String(plan._id), emptyStart, 'ee-empty');
    await expect(
      prematureCloseEnrollment(
        String(empty._id),
        {
          settlementAsset: 'CASH',
          payoutDate: new Date(),
          reason: 'No principal',
          idempotencyKey: 'ee-empty-0001',
        },
        adminCtx(String(admin._id), 'ee-empty'),
      ),
    ).rejects.toMatchObject({ code: 'INSUFFICIENT_SCHEME_BALANCE' });
  });

  it('does not let UTC midnight shift the Asia/Kolkata eligibility boundary', async () => {
    const admin = await seedAdmin();
    const plan = await seedCashPlan();
    const customer = await seedVerifiedCustomer('+917184900109');
    const start = new Date('2026-01-10T00:00:00.000+05:30');
    const enrollment = await enroll(String(customer._id), String(plan._id), start, 'ee-ist');
    await Payment.create([
      {
        customerId: customer._id,
        schemeId: enrollment._id,
        amountPaise: MIN,
        method: 'CASH',
        status: 'SUCCESS',
        paymentDate: monthDate(start, 0),
        schemeMonth: 1,
        receiptNumber: `NKS-EE-IST-${Date.now()}`,
        collectorRole: 'ADMIN',
        collectedBy: admin._id,
        createdBy: admin._id,
        goldWeightMg: 0,
      },
    ]);

    const beforeIstMidnight = await previewSchemeSettlement({
      enrollmentId: String(enrollment._id),
      kind: 'PREMATURE_CLOSE',
      settlementAsset: 'CASH',
      at: new Date('2026-07-09T18:29:59.999Z'),
    });
    const atIstMidnight = await previewSchemeSettlement({
      enrollmentId: String(enrollment._id),
      kind: 'PREMATURE_CLOSE',
      settlementAsset: 'CASH',
      at: new Date('2026-07-09T18:30:00.000Z'),
    });
    expect(beforeIstMidnight.eligible).toBe(false);
    expect(atIstMidnight.eligible).toBe(true);
    expect(admin.role).toBe('ADMIN');
    expect(plan.prematureClosureMinElapsedMonths).toBe(6);
  });

  it('adds six calendar months for a 31 January start using the scheme-date utility', async () => {
    const start = new Date('2026-01-31T00:00:00.000+05:30');
    const boundary = addSchemeMonths(start, 6);
    expect(boundary.toISOString()).toBe(new Date('2026-07-31T00:00:00.000+05:30').toISOString());

    const admin = await seedAdmin();
    const plan = await seedCashPlan();
    const customer = await seedVerifiedCustomer('+917184900110');
    const enrollment = await enroll(String(customer._id), String(plan._id), start, 'ee-eom');
    await Payment.create([
      {
        customerId: customer._id,
        schemeId: enrollment._id,
        amountPaise: MIN,
        method: 'CASH',
        status: 'SUCCESS',
        paymentDate: monthDate(start, 0),
        schemeMonth: 1,
        receiptNumber: `NKS-EE-EOM-${Date.now()}`,
        collectorRole: 'ADMIN',
        collectedBy: admin._id,
        createdBy: admin._id,
        goldWeightMg: 0,
      },
    ]);

    const before = await previewSchemeSettlement({
      enrollmentId: String(enrollment._id),
      kind: 'PREMATURE_CLOSE',
      settlementAsset: 'CASH',
      at: new Date(boundary.getTime() - 1),
    });
    const atBoundary = await previewSchemeSettlement({
      enrollmentId: String(enrollment._id),
      kind: 'PREMATURE_CLOSE',
      settlementAsset: 'CASH',
      at: boundary,
    });
    expect(before.eligible).toBe(false);
    expect(atBoundary.eligible).toBe(true);
  });
});
