import { addMonths, startOfMonth } from 'date-fns';
import { fromZonedTime, toZonedTime } from 'date-fns-tz';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { app } from '../src/app.js';
import { NAKSHATHRA_MINIMUM_PAYMENT_PAISE } from '../src/config/business.js';
import {
  AuditLog,
  Customer,
  GoldRate,
  Payment,
  Payout,
  SchemeEnrollment,
  User,
} from '../src/models/index.js';
import { hashPassword, login } from '../src/services/auth.service.js';
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
import { goldWeightMg } from '../src/services/scheme.service.js';
import {
  calculateSchemeSettlement,
  jewelleryPurchaseTopUp,
} from '../src/services/scheme-settlement.service.js';
import { aggregateEnrollmentLedger } from '../src/utils/enrollment-ledger.js';
import { LIVE_CASH_SETTLEMENT_POLICY } from '../src/utils/payment-window.js';
import { BUSINESS_TZ, businessDayRange } from '../src/utils/time.js';
import { payoutSchema } from '../src/validators/finance.validators.js';
import { createEnrollmentSchema, createSchemePlanSchema } from '../src/validators/scheme.validators.js';
import { clearTestMongo, startTestMongo, stopTestMongo } from './helpers/mongo.js';

const ADMIN_PHONE = '+917184800001';
const ADMIN_PASSWORD = 'AdminPass123!';
const CUSTOMER_PASSWORD = 'CustomerPass123!';
const MIN = 100_000;
const ENTITLEMENT = 11_000_000;
const BILL_EQUAL = 11_000_000;
const BILL_HIGHER = 13_200_000;
const EXTRA = 2_200_000;
const RATE = 7_500_000;
const EARLY_PRINCIPAL = 4_200_000;

function cookieHeader(access: string) {
  return `access_token=${access}`;
}

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
      name: 'Redemption Admin',
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
    { name: 'Redemption Customer', phone, password: CUSTOMER_PASSWORD },
    adminCtx(actorId, `rd-customer-${phone}`),
  );
  await Customer.updateOne({ _id: created.customer._id }, { $set: { kycStatus: 'VERIFIED' } });
  return created.customer;
}

async function seedCashPlan(minimumPaymentPaise = MIN) {
  const admin = await User.findOne({ role: 'ADMIN' });
  const actorId = String(admin?._id ?? (await seedAdmin())._id);
  return createSchemePlan(
    {
      name: 'Redemption Cash',
      type: 'CASH',
      durationMonths: 11,
      minimumPaymentPaise,
      termsText: 'Eleven contribution months then cash or jewellery settlement.',
    },
    adminCtx(actorId, 'rd-plan'),
  );
}

async function enrollCustomer(
  customerId: string,
  planId: string,
  startDate: Date,
  requestId: string,
  monthlyInstallmentPaise = MIN,
) {
  const admin = await User.findOne({ role: 'ADMIN' });
  return createEnrollment(
    { customerId, schemePlanId: planId, startDate, monthlyInstallmentPaise },
    adminCtx(String(admin!._id), requestId),
  );
}

async function seedPaidMonths(
  customerId: string,
  schemeId: string,
  start: Date,
  actorId: string,
  months: number[],
  amountPaise = MIN,
) {
  await Payment.create(
    months.map((month) => ({
      customerId,
      schemeId,
      amountPaise,
      method: 'CASH',
      status: 'SUCCESS',
      paymentDate: monthDate(start, month - 1),
      schemeMonth: month,
      receiptNumber: `NKS-RD-${String(schemeId).slice(-8)}-${month}-${Date.now()}`,
      collectorRole: 'ADMIN',
      collectedBy: actorId,
      createdBy: actorId,
      goldWeightMg: 0,
    })),
  );
}

async function seedTodayGoldRate(actorId: string, ratePerGramPaise = RATE) {
  const { start } = businessDayRange(new Date());
  const [rate] = await GoldRate.create([
    {
      ratePerGramPaise,
      purity: '916',
      effectiveFrom: start,
      status: 'ACTIVE',
      createdBy: actorId,
    },
  ]);
  return rate;
}

async function payCash(
  actorId: string,
  customerId: string,
  schemeId: string,
  amountPaise: number,
  paymentDate: Date,
  key: string,
) {
  return createManualPayment(
    {
      customerId,
      schemeId,
      amountPaise,
      method: 'CASH',
      paymentDate,
      idempotencyKey: key,
    },
    adminCtx(actorId, key),
  );
}

describe('Nakshathra redemption modes', () => {
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

  describe('policy and validators', () => {
    it('uses 6 elapsed scheme months for early eligibility and jewellery only at maturity', () => {
      expect(LIVE_CASH_SETTLEMENT_POLICY.prematureClosureMinElapsedMonths).toBe(6);
      expect(LIVE_CASH_SETTLEMENT_POLICY.prematureClosureSettlementAssets).toEqual(['CASH']);
      expect(LIVE_CASH_SETTLEMENT_POLICY.maturitySettlementAssets).toEqual(['CASH', 'JEWELLERY']);
    });

    it('supports a configurable ₹100 plan/enrollment floor without hardcoding it in payment posting', () => {
      expect(NAKSHATHRA_MINIMUM_PAYMENT_PAISE).toBe(10_000);
      expect(
        createSchemePlanSchema.safeParse({
          name: 'Min 100',
          type: 'CASH',
          durationMonths: 11,
          minimumPaymentPaise: 10_000,
          termsText: 'Minimum one hundred rupees.',
        }).success,
      ).toBe(true);
      expect(
        createEnrollmentSchema.safeParse({
          customerId: 'customer-id',
          schemePlanId: 'plan-id',
          startDate: '2026-01-01',
          monthlyInstallmentPaise: 10_000,
        }).success,
      ).toBe(true);
      expect(
        createSchemePlanSchema.safeParse({
          name: 'Below 100',
          type: 'CASH',
          durationMonths: 11,
          minimumPaymentPaise: 9_999,
          termsText: 'Below one hundred rupees.',
        }).success,
      ).toBe(false);
    });

    it('requires jewellery bill fields and rejects client-calculated extra or gold rate', () => {
      expect(
        payoutSchema.safeParse({
          customerId: 'customer-id',
          schemeId: 'scheme-id',
          payoutDate: '2026-12-01',
          payoutType: 'PAYOUT',
          settlementAsset: 'JEWELLERY',
        }).success,
      ).toBe(false);
      expect(
        payoutSchema.safeParse({
          customerId: 'customer-id',
          schemeId: 'scheme-id',
          payoutDate: '2026-12-01',
          payoutType: 'PAYOUT',
          settlementAsset: 'JEWELLERY',
          billNumber: 'BILL-1',
          billAmountPaise: BILL_HIGHER,
          extraPaidPaise: EXTRA,
        }).success,
      ).toBe(false);
      expect(
        payoutSchema.safeParse({
          customerId: 'customer-id',
          schemeId: 'scheme-id',
          payoutDate: '2026-12-01',
          payoutType: 'PAYOUT',
          settlementAsset: 'JEWELLERY',
          billNumber: 'BILL-1',
          billAmountPaise: BILL_HIGHER,
          goldRateSnapshotPaise: 1,
        }).success,
      ).toBe(false);
      expect(
        payoutSchema.safeParse({
          customerId: 'customer-id',
          schemeId: 'scheme-id',
          payoutDate: '2026-12-01',
          payoutType: 'PAYOUT',
          settlementAsset: 'JEWELLERY',
          billNumber: 'BILL-1',
          billAmountPaise: BILL_HIGHER,
          extraPaymentMethod: 'UPI',
          extraPaymentReference: 'UPI123',
        }).success,
      ).toBe(true);
    });

    it('derives jewellery extra server-side and never treats it as a contribution', () => {
      expect(
        jewelleryPurchaseTopUp({
          billAmountPaise: BILL_EQUAL,
          schemeValueAppliedPaise: ENTITLEMENT,
        }).extraPaidPaise,
      ).toBe(0);
      expect(
        jewelleryPurchaseTopUp({
          billAmountPaise: BILL_HIGHER,
          schemeValueAppliedPaise: ENTITLEMENT,
          extraPaymentMethod: 'CASH',
        }).extraPaidPaise,
      ).toBe(EXTRA);
      expect(() =>
        jewelleryPurchaseTopUp({
          billAmountPaise: ENTITLEMENT - 1,
          schemeValueAppliedPaise: ENTITLEMENT,
        }),
      ).toThrow(/JEWELLERY_BILL_BELOW_ENTITLEMENT|below the remaining scheme entitlement/);
    });
  });

  describe('early cash', () => {
    it('rejects early withdrawal before 6 elapsed scheme months even after a payment', async () => {
      const admin = await seedAdmin();
      const plan = await seedCashPlan();
      const customer = await seedVerifiedCustomer('+917184800101');
      const enrollment = await enrollCustomer(
        String(customer._id),
        String(plan._id),
        monthStartIst(),
        'rd-early-zero',
      );
      await payCash(
        String(admin._id),
        String(customer._id),
        String(enrollment._id),
        EARLY_PRINCIPAL,
        new Date(),
        'rd-early-zero-pay',
      );

      await expect(
        prematureCloseEnrollment(
          String(enrollment._id),
          {
            settlementAsset: 'CASH',
            payoutDate: new Date(),
            reason: 'Too early',
            idempotencyKey: 'rd-early-zero-0001',
          },
          adminCtx(String(admin._id), 'rd-early-zero'),
        ),
      ).rejects.toMatchObject({ code: 'PREMATURE_CLOSURE_NOT_YET_ELIGIBLE' });
    });

    it('allows EARLY CASH at/after 6 elapsed months and returns 100% principal with no penalty', async () => {
      const admin = await seedAdmin();
      const plan = await seedCashPlan();
      const customer = await seedVerifiedCustomer('+917184800102');
      const start = startMonthsAgo(6);
      const enrollment = await enrollCustomer(
        String(customer._id),
        String(plan._id),
        start,
        'rd-early-at',
      );
      await payCash(
        String(admin._id),
        String(customer._id),
        String(enrollment._id),
        EARLY_PRINCIPAL,
        monthDate(start, 0),
        'rd-early-at-pay',
      );

      const preview = await previewPrematureClosure(String(enrollment._id), 'CASH');
      expect(preview.redemptionType).toBe('EARLY');
      expect(preview.eligible).toBe(true);
      expect(preview.allowedSettlementModes).toEqual(['CASH']);
      expect(preview.allowedSettlementModes).not.toContain('JEWELLERY');
      expect(preview.schemeEntitlementPaise).toBe(EARLY_PRINCIPAL);

      const payout = await prematureCloseEnrollment(
        String(enrollment._id),
        {
          settlementAsset: 'CASH',
          payoutDate: new Date(),
          reason: 'Eligible early cash',
          method: 'CASH',
          idempotencyKey: 'rd-early-at-0001',
        },
        adminCtx(String(admin._id), 'rd-early-at'),
      );
      expect(payout.payoutType).toBe('PREMATURE_CLOSE');
      expect(payout.amountPaise).toBe(EARLY_PRINCIPAL);
      expect(payout.settlementPrincipalPaise).toBe(EARLY_PRINCIPAL);
      expect(payout.goldWeightMg).toBe(0);
      expect(payout.settlementMode).toBe('CASH');
    });

    it('allows EARLY CASH after the 6-month threshold and before maturity', async () => {
      const admin = await seedAdmin();
      const plan = await seedCashPlan();
      const customer = await seedVerifiedCustomer('+917184800103');
      const start = startMonthsAgo(7);
      const enrollment = await enrollCustomer(
        String(customer._id),
        String(plan._id),
        start,
        'rd-early-after',
      );
      await seedPaidMonths(
        String(customer._id),
        String(enrollment._id),
        start,
        String(admin._id),
        [1, 2, 3],
        MIN,
      );

      const payout = await prematureCloseEnrollment(
        String(enrollment._id),
        {
          settlementAsset: 'CASH',
          payoutDate: new Date(),
          reason: 'After threshold before maturity',
          idempotencyKey: 'rd-early-after-0001',
        },
        adminCtx(String(admin._id), 'rd-early-after'),
      );
      expect(payout.amountPaise).toBe(3 * MIN);
      expect(payout.payoutType).toBe('PREMATURE_CLOSE');
    });

    it('rejects EARLY + JEWELLERY server-side', async () => {
      const admin = await seedAdmin();
      const plan = await seedCashPlan();
      const customer = await seedVerifiedCustomer('+917184800104');
      const start = startMonthsAgo(6);
      const enrollment = await enrollCustomer(
        String(customer._id),
        String(plan._id),
        start,
        'rd-early-jew',
      );
      await payCash(
        String(admin._id),
        String(customer._id),
        String(enrollment._id),
        EARLY_PRINCIPAL,
        monthDate(start, 0),
        'rd-early-jew-pay',
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
            reason: 'Attempt jewellery early',
            idempotencyKey: 'rd-early-jew-0001',
          },
          adminCtx(String(admin._id), 'rd-early-jew'),
        ),
      ).rejects.toMatchObject({ code: 'SETTLEMENT_ASSET_NOT_ALLOWED' });

      expect(() =>
        calculateSchemeSettlement({
          kind: 'PREMATURE_CLOSE',
          settlementAsset: 'JEWELLERY',
          ledger: {
            totalPaidPaise: EARLY_PRINCIPAL,
            totalGoldWeightMg: 0,
            totalPayoutPaise: 0,
            totalSettlementPrincipalPaise: 0,
            totalPayoutGoldWeightMg: 0,
            paymentsCompleted: 1,
            availablePaise: EARLY_PRINCIPAL,
            availableGoldWeightMg: 0,
          },
          policy: LIVE_CASH_SETTLEMENT_POLICY,
          goldRate: { _id: 'rate', ratePerGramPaise: RATE },
          schemeType: 'CASH',
        }),
      ).toThrow(/Early Nakshathra redemption is cash only/);
    });
  });

  describe('maturity cash', () => {
    it('settles remaining contributed principal and stays available after former month-12 expiry', async () => {
      const admin = await seedAdmin();
      const plan = await seedCashPlan();
      const customer = await seedVerifiedCustomer('+917184800201');
      const start = startMonthsAgo(18);
      const enrollment = await enrollCustomer(
        String(customer._id),
        String(plan._id),
        start,
        'rd-mat-cash',
      );
      await seedPaidMonths(
        String(customer._id),
        String(enrollment._id),
        start,
        String(admin._id),
        [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11],
        MIN,
      );

      const preview = await previewRedemption(String(enrollment._id));
      expect(preview.redemptionType).toBe('MATURITY');
      expect(preview.allowedSettlementModes).toEqual(['CASH', 'JEWELLERY']);
      expect(preview.schemeEntitlementPaise).toBe(11 * MIN);

      const payout = await createPayout(
        {
          customerId: String(customer._id),
          schemeId: String(enrollment._id),
          payoutDate: new Date(),
          payoutType: 'PAYOUT',
          settlementAsset: 'CASH',
          method: 'CASH',
          idempotencyKey: 'rd-mat-cash-0001',
        },
        adminCtx(String(admin._id), 'rd-mat-cash'),
      );
      expect(payout.amountPaise).toBe(11 * MIN);
      expect(payout.settlementPrincipalPaise).toBe(11 * MIN);
      expect(payout.goldWeightMg).toBe(0);
      expect(payout.valuationGoldRateId).toBeFalsy();
      expect(payout.settlementMode).toBe('CASH');
    });
  });

  describe('maturity jewellery', () => {
    it('applies full entitlement with extra 0 when the bill equals scheme value', async () => {
      const admin = await seedAdmin();
      const plan = await seedCashPlan();
      const customer = await seedVerifiedCustomer('+917184800301');
      const start = startMonthsAgo(11);
      const enrollment = await enrollCustomer(
        String(customer._id),
        String(plan._id),
        start,
        'rd-jew-eq',
      );
      await seedPaidMonths(
        String(customer._id),
        String(enrollment._id),
        start,
        String(admin._id),
        [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11],
        1_000_000,
      );
      const rate = await seedTodayGoldRate(String(admin._id));
      const expectedWeight = goldWeightMg(ENTITLEMENT, RATE);

      const preview = await previewRedemption(String(enrollment._id), 'JEWELLERY');
      expect(preview.eligible).toBe(true);
      expect(preview.currentGoldRate?.ratePerGramPaise).toBe(RATE);
      expect(preview.goldWeightEquivalentMg).toBe(expectedWeight);
      expect(preview.schemeEntitlementPaise).toBe(ENTITLEMENT);

      const payout = await createPayout(
        {
          customerId: String(customer._id),
          schemeId: String(enrollment._id),
          payoutDate: new Date(),
          payoutType: 'PAYOUT',
          settlementAsset: 'JEWELLERY',
          billNumber: 'NJ-EQ-1',
          billAmountPaise: BILL_EQUAL,
          idempotencyKey: 'rd-jew-eq-0001',
        },
        adminCtx(String(admin._id), 'rd-jew-eq'),
      );

      expect(payout.method).toBe('JEWELLERY');
      expect(payout.settlementMode).toBe('JEWELLERY');
      expect(payout.amountPaise).toBe(ENTITLEMENT);
      expect(payout.settlementPrincipalPaise).toBe(ENTITLEMENT);
      expect(payout.schemeValueAppliedPaise).toBe(ENTITLEMENT);
      expect(payout.billAmountPaise).toBe(BILL_EQUAL);
      expect(payout.extraPaidPaise).toBe(0);
      expect(payout.goldWeightMg).toBe(0);
      expect(payout.valuationGoldRatePerGramPaise).toBe(RATE);
      expect(String(payout.valuationGoldRateId)).toBe(String(rate._id));
      expect(payout.valuationGoldWeightMg).toBe(expectedWeight);

      const ledger = await aggregateEnrollmentLedger(String(enrollment._id));
      expect(ledger.totalPaidPaise).toBe(ENTITLEMENT);
      expect(ledger.availablePaise).toBe(0);
      expect(ledger.availableGoldWeightMg).toBe(0);
      expect(await Payment.countDocuments({ schemeId: enrollment._id, status: 'SUCCESS' })).toBe(11);
    });

    it('derives extra ₹22,000 server-side and does not add it to scheme contributions', async () => {
      const admin = await seedAdmin();
      const plan = await seedCashPlan();
      const customer = await seedVerifiedCustomer('+917184800302');
      const start = startMonthsAgo(11);
      const enrollment = await enrollCustomer(
        String(customer._id),
        String(plan._id),
        start,
        'rd-jew-extra',
      );
      await seedPaidMonths(
        String(customer._id),
        String(enrollment._id),
        start,
        String(admin._id),
        [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11],
        1_000_000,
      );
      await seedTodayGoldRate(String(admin._id));
      const paymentsBefore = await Payment.countDocuments({
        schemeId: enrollment._id,
        status: 'SUCCESS',
      });

      const payout = await createPayout(
        {
          customerId: String(customer._id),
          schemeId: String(enrollment._id),
          payoutDate: new Date(),
          payoutType: 'PAYOUT',
          settlementAsset: 'JEWELLERY',
          billNumber: 'NJ-EX-1',
          billAmountPaise: BILL_HIGHER,
          extraPaymentMethod: 'UPI',
          extraPaymentReference: 'UPI-TOPUP-22K',
          idempotencyKey: 'rd-jew-extra-0001',
        },
        adminCtx(String(admin._id), 'rd-jew-extra'),
      );

      expect(payout.extraPaidPaise).toBe(EXTRA);
      expect(payout.extraPaymentMethod).toBe('UPI');
      expect(payout.extraPaymentReference).toBe('UPI-TOPUP-22K');
      expect(payout.amountPaise).toBe(ENTITLEMENT);
      expect(payout.schemeValueAppliedPaise).toBe(ENTITLEMENT);

      const ledger = await aggregateEnrollmentLedger(String(enrollment._id));
      expect(ledger.totalPaidPaise).toBe(ENTITLEMENT);
      expect(ledger.totalSettlementPrincipalPaise).toBe(ENTITLEMENT);
      expect(ledger.availablePaise).toBe(0);
      expect(await Payment.countDocuments({ schemeId: enrollment._id, status: 'SUCCESS' })).toBe(
        paymentsBefore,
      );

      const audit = await AuditLog.findOne({ action: 'PAYOUT_CREATED', entityId: payout._id }).lean();
      expect(audit?.after).toMatchObject({
        redemptionType: 'MATURITY',
        settlementMode: 'JEWELLERY',
        billNumber: 'NJ-EX-1',
        billAmountPaise: BILL_HIGHER,
        extraPaidPaise: EXTRA,
        extraPaymentMethod: 'UPI',
      });
    });

    it('rejects a jewellery bill below scheme entitlement', async () => {
      const admin = await seedAdmin();
      const plan = await seedCashPlan();
      const customer = await seedVerifiedCustomer('+917184800303');
      const start = startMonthsAgo(11);
      const enrollment = await enrollCustomer(
        String(customer._id),
        String(plan._id),
        start,
        'rd-jew-low',
      );
      await seedPaidMonths(
        String(customer._id),
        String(enrollment._id),
        start,
        String(admin._id),
        [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11],
        1_000_000,
      );
      await seedTodayGoldRate(String(admin._id));

      await expect(
        createPayout(
          {
            customerId: String(customer._id),
            schemeId: String(enrollment._id),
            payoutDate: new Date(),
            payoutType: 'PAYOUT',
            settlementAsset: 'JEWELLERY',
            billNumber: 'NJ-LOW-1',
            billAmountPaise: ENTITLEMENT - 100,
            idempotencyKey: 'rd-jew-low-0001',
          },
          adminCtx(String(admin._id), 'rd-jew-low'),
        ),
      ).rejects.toMatchObject({ code: 'JEWELLERY_BILL_BELOW_ENTITLEMENT' });
      expect(await Payout.countDocuments({ schemeId: enrollment._id })).toBe(0);
    });

    it('requires a bill number and ignores a client-supplied gold rate', async () => {
      const admin = await seedAdmin();
      const issued = await login(ADMIN_PHONE, ADMIN_PASSWORD, { ip: '127.0.0.1' });
      const plan = await seedCashPlan();
      const customer = await seedVerifiedCustomer('+917184800304');
      const start = startMonthsAgo(11);
      const enrollment = await enrollCustomer(
        String(customer._id),
        String(plan._id),
        start,
        'rd-jew-http',
      );
      await seedPaidMonths(
        String(customer._id),
        String(enrollment._id),
        start,
        String(admin._id),
        [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11],
        1_000_000,
      );
      const rate = await seedTodayGoldRate(String(admin._id));

      const missingBill = await request(app)
        .post('/api/v1/admin/payouts')
        .set('Cookie', cookieHeader(issued.tokens.access))
        .send({
          customerId: String(customer._id),
          schemeId: String(enrollment._id),
          payoutDate: new Date().toISOString(),
          payoutType: 'PAYOUT',
          settlementAsset: 'JEWELLERY',
        });
      expect(missingBill.status).toBe(422);

      const created = await request(app)
        .post('/api/v1/admin/payouts')
        .set('Cookie', cookieHeader(issued.tokens.access))
        .send({
          customerId: String(customer._id),
          schemeId: String(enrollment._id),
          payoutDate: new Date().toISOString(),
          payoutType: 'PAYOUT',
          settlementAsset: 'JEWELLERY',
          billNumber: 'NJ-HTTP-1',
          billAmountPaise: BILL_HIGHER,
          extraPaymentMethod: 'CASH',
          idempotencyKey: 'rd-jew-http-0001',
        });
      expect(created.status).toBe(201);
      expect(created.body.data.valuationGoldRatePerGramPaise).toBe(RATE);
      expect(String(created.body.data.valuationGoldRateId)).toBe(String(rate._id));
      expect(created.body.data.extraPaidPaise).toBe(EXTRA);
      expect(created.body.data.goldWeightMg).toBe(0);
    });
  });

  describe('minimum ₹100 contribution', () => {
    it('lets a Nakshathra plan accept a ₹100 installment', async () => {
      const admin = await seedAdmin();
      const plan = await seedCashPlan(NAKSHATHRA_MINIMUM_PAYMENT_PAISE);
      expect(plan.minimumPaymentPaise).toBe(10_000);
      const customer = await seedVerifiedCustomer('+917184800401');
      const enrollment = await enrollCustomer(
        String(customer._id),
        String(plan._id),
        monthStartIst(),
        'rd-min-100',
        NAKSHATHRA_MINIMUM_PAYMENT_PAISE,
      );
      const payment = await payCash(
        String(admin._id),
        String(customer._id),
        String(enrollment._id),
        NAKSHATHRA_MINIMUM_PAYMENT_PAISE,
        new Date(),
        'rd-min-100-pay',
      );
      expect(payment.amountPaise).toBe(10_000);
      const ledger = await aggregateEnrollmentLedger(String(enrollment._id));
      expect(ledger.totalPaidPaise).toBe(10_000);
    });
  });

  describe('concurrency and idempotency', () => {
    it('allows only one winner for concurrent CASH, JEWELLERY, and mixed settlements', async () => {
      const admin = await seedAdmin();
      const plan = await seedCashPlan();

      async function seedMature(phone: string, requestId: string) {
        const customer = await seedVerifiedCustomer(phone);
        const start = startMonthsAgo(11);
        const enrollment = await enrollCustomer(
          String(customer._id),
          String(plan._id),
          start,
          requestId,
        );
        await seedPaidMonths(
          String(customer._id),
          String(enrollment._id),
          start,
          String(admin._id),
          [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11],
        );
        return customer;
      }

      const cashCustomer = await seedMature('+917184800501', 'rd-race-cash');
      const jewCustomer = await seedMature('+917184800502', 'rd-race-jew');
      const mixedCustomer = await seedMature('+917184800503', 'rd-race-mix');
      await seedTodayGoldRate(String(admin._id));

      const cashEnrollment = await SchemeEnrollment.findOne({ customerId: cashCustomer._id });
      const jewEnrollment = await SchemeEnrollment.findOne({ customerId: jewCustomer._id });
      const mixedEnrollment = await SchemeEnrollment.findOne({ customerId: mixedCustomer._id });

      const cashRace = await Promise.allSettled([
        createPayout(
          {
            customerId: String(cashCustomer._id),
            schemeId: String(cashEnrollment!._id),
            payoutDate: new Date(),
            payoutType: 'PAYOUT',
            settlementAsset: 'CASH',
            idempotencyKey: 'rd-cash-a-0001',
          },
          adminCtx(String(admin._id), 'rd-cash-a'),
        ),
        createPayout(
          {
            customerId: String(cashCustomer._id),
            schemeId: String(cashEnrollment!._id),
            payoutDate: new Date(),
            payoutType: 'PAYOUT',
            settlementAsset: 'CASH',
            idempotencyKey: 'rd-cash-b-0001',
          },
          adminCtx(String(admin._id), 'rd-cash-b'),
        ),
      ]);
      expect(cashRace.filter((row) => row.status === 'fulfilled')).toHaveLength(1);
      expect(await Payout.countDocuments({ schemeId: cashEnrollment!._id, status: 'SUCCESS' })).toBe(
        1,
      );

      const jewRace = await Promise.allSettled([
        createPayout(
          {
            customerId: String(jewCustomer._id),
            schemeId: String(jewEnrollment!._id),
            payoutDate: new Date(),
            payoutType: 'PAYOUT',
            settlementAsset: 'JEWELLERY',
            billNumber: 'NJ-RACE-A',
            billAmountPaise: 11 * MIN,
            idempotencyKey: 'rd-jew-a-0001',
          },
          adminCtx(String(admin._id), 'rd-jew-a'),
        ),
        createPayout(
          {
            customerId: String(jewCustomer._id),
            schemeId: String(jewEnrollment!._id),
            payoutDate: new Date(),
            payoutType: 'PAYOUT',
            settlementAsset: 'JEWELLERY',
            billNumber: 'NJ-RACE-B',
            billAmountPaise: 11 * MIN + 100,
            extraPaymentMethod: 'CASH',
            idempotencyKey: 'rd-jew-b-0001',
          },
          adminCtx(String(admin._id), 'rd-jew-b'),
        ),
      ]);
      expect(jewRace.filter((row) => row.status === 'fulfilled')).toHaveLength(1);
      expect(await Payout.countDocuments({ schemeId: jewEnrollment!._id, status: 'SUCCESS' })).toBe(1);

      const mixedRace = await Promise.allSettled([
        createPayout(
          {
            customerId: String(mixedCustomer._id),
            schemeId: String(mixedEnrollment!._id),
            payoutDate: new Date(),
            payoutType: 'PAYOUT',
            settlementAsset: 'CASH',
            idempotencyKey: 'rd-mix-cash-0001',
          },
          adminCtx(String(admin._id), 'rd-mix-cash'),
        ),
        createPayout(
          {
            customerId: String(mixedCustomer._id),
            schemeId: String(mixedEnrollment!._id),
            payoutDate: new Date(),
            payoutType: 'PAYOUT',
            settlementAsset: 'JEWELLERY',
            billNumber: 'NJ-MIX',
            billAmountPaise: 11 * MIN,
            idempotencyKey: 'rd-mix-jew-0001',
          },
          adminCtx(String(admin._id), 'rd-mix-jew'),
        ),
      ]);
      expect(mixedRace.filter((row) => row.status === 'fulfilled')).toHaveLength(1);
      expect(await Payout.countDocuments({ schemeId: mixedEnrollment!._id, status: 'SUCCESS' })).toBe(
        1,
      );
    });

    it('replays the same jewellery idempotency key and rejects a second key after settlement', async () => {
      const admin = await seedAdmin();
      const plan = await seedCashPlan();
      const customer = await seedVerifiedCustomer('+917184800504');
      const start = startMonthsAgo(11);
      const enrollment = await enrollCustomer(
        String(customer._id),
        String(plan._id),
        start,
        'rd-idem',
      );
      await seedPaidMonths(
        String(customer._id),
        String(enrollment._id),
        start,
        String(admin._id),
        [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11],
      );
      await seedTodayGoldRate(String(admin._id));
      const input = {
        customerId: String(customer._id),
        schemeId: String(enrollment._id),
        payoutDate: new Date(),
        payoutType: 'PAYOUT' as const,
        settlementAsset: 'JEWELLERY' as const,
        billNumber: 'NJ-IDEM',
        billAmountPaise: 11 * MIN,
        idempotencyKey: 'rd-idem-0001',
      };
      const first = await createPayout(input, adminCtx(String(admin._id), 'rd-idem-1'));
      const replay = await createPayout(input, adminCtx(String(admin._id), 'rd-idem-2'));
      expect(String(replay._id)).toBe(String(first._id));
      await expect(
        createPayout(
          { ...input, idempotencyKey: 'rd-idem-0002' },
          adminCtx(String(admin._id), 'rd-idem-3'),
        ),
      ).rejects.toMatchObject({ code: 'SCHEME_ALREADY_SETTLED' });
    });

    it('protects a payment vs jewellery settlement race', async () => {
      const admin = await seedAdmin();
      const plan = await seedCashPlan();
      const customer = await seedVerifiedCustomer('+917184800505');
      const start = startMonthsAgo(11);
      const enrollment = await enrollCustomer(
        String(customer._id),
        String(plan._id),
        start,
        'rd-pay-race',
      );
      await seedPaidMonths(
        String(customer._id),
        String(enrollment._id),
        start,
        String(admin._id),
        [1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
        MIN,
      );
      await seedTodayGoldRate(String(admin._id));

      const results = await Promise.allSettled([
        payCash(
          String(admin._id),
          String(customer._id),
          String(enrollment._id),
          MIN,
          monthDate(start, 10),
          'rd-pay-race-pay',
        ),
        createPayout(
          {
            customerId: String(customer._id),
            schemeId: String(enrollment._id),
            payoutDate: new Date(),
            payoutType: 'PAYOUT',
            settlementAsset: 'JEWELLERY',
            billNumber: 'NJ-PAY-RACE',
            billAmountPaise: 10 * MIN,
            idempotencyKey: 'rd-pay-race-0001',
          },
          adminCtx(String(admin._id), 'rd-pay-race'),
        ),
      ]);

      const fulfilled = results.filter((row) => row.status === 'fulfilled');
      expect(fulfilled.length).toBeGreaterThanOrEqual(1);
      const successPayouts = await Payout.countDocuments({
        schemeId: enrollment._id,
        status: 'SUCCESS',
      });
      expect(successPayouts).toBeLessThanOrEqual(1);
      if (successPayouts === 1) {
        const ledger = await aggregateEnrollmentLedger(String(enrollment._id));
        expect(ledger.availablePaise).toBe(0);
      }
    });
  });
});
