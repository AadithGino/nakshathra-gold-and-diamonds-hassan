import { addMonths, startOfMonth } from 'date-fns';
import { fromZonedTime, toZonedTime } from 'date-fns-tz';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { app } from '../src/app.js';
import { isGoldWeightEnabled } from '../src/config/business.js';
import {
  Customer,
  GoldRate,
  Payment,
  PaymentCorrection,
  Payout,
  SchemeEnrollment,
  User,
} from '../src/models/index.js';
import { hashPassword, login } from '../src/services/auth.service.js';
import { createCustomer } from '../src/services/customer.service.js';
import { getCustomerHome } from '../src/services/customer-portal.service.js';
import {
  createPayout,
  requestCorrection,
  reviewCorrection,
} from '../src/services/finance.service.js';
import { createManualPayment } from '../src/services/payment.service.js';
import {
  createEnrollment,
  createGoldRate,
  createSchemePlan,
  listGoldRates,
  prematureCloseEnrollment,
} from '../src/services/scheme-management.service.js';
import * as schemeService from '../src/services/scheme.service.js';
import { createStaff } from '../src/services/staff.service.js';
import { aggregateEnrollmentLedger } from '../src/utils/enrollment-ledger.js';
import { calculatePrematureClosureSettlement } from '../src/utils/premature-closure-policy.js';
import { BUSINESS_TZ } from '../src/utils/time.js';
import { correctionRequestSchema } from '../src/validators/staff-portal.validators.js';
import { clearTestMongo, startTestMongo, stopTestMongo } from './helpers/mongo.js';

const ADMIN_PHONE = '+917183700001';
const ADMIN2_PHONE = '+917183700091';
const STAFF_PHONE = '+917183700002';
const ADMIN_PASSWORD = 'AdminPass123!';
const STAFF_PASSWORD = 'StaffPass123!';
const CUSTOMER_PASSWORD = 'CustomerPass123!';
const MIN = 100_000;
const PRINCIPAL_42000_RUPEES = 4_200_000;

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

function lastInstantOfSchemeMonth(start: Date, monthOffset: number) {
  const local = toZonedTime(start, BUSINESS_TZ);
  const next = addMonths(startOfMonth(local), monthOffset + 1);
  next.setMilliseconds(-1);
  return fromZonedTime(next, BUSINESS_TZ);
}

function firstInstantOfSchemeMonth(start: Date, monthOffset: number) {
  const local = toZonedTime(start, BUSINESS_TZ);
  const month = addMonths(startOfMonth(local), monthOffset);
  month.setHours(0, 0, 0, 0);
  return fromZonedTime(month, BUSINESS_TZ);
}

async function seedAdmin(phone = ADMIN_PHONE) {
  const [admin] = await User.create([
    {
      name: `Correction Admin ${phone.slice(-4)}`,
      phone,
      passwordHash: await hashPassword(ADMIN_PASSWORD),
      role: 'ADMIN',
      status: 'ACTIVE',
    },
  ]);
  return admin;
}

async function seedStaff() {
  const admin = await User.findOne({ role: 'ADMIN' });
  const actorId = String(admin?._id ?? (await seedAdmin())._id);
  return createStaff(
    {
      name: 'Correction Staff',
      phone: STAFF_PHONE,
      password: STAFF_PASSWORD,
      employeeCode: 'NKS-S701',
      permissions: ['canViewCustomers', 'canCollectPayment', 'canSubmitCorrectionRequest'],
    },
    adminCtx(actorId, 'corr-staff'),
  );
}

async function seedVerifiedCustomer(opts: { name?: string; phone: string }) {
  const admin = await User.findOne({ role: 'ADMIN' });
  const actorId = String(admin?._id ?? (await seedAdmin())._id);
  const created = await createCustomer(
    {
      name: opts.name ?? 'Correction Customer',
      phone: opts.phone,
      password: CUSTOMER_PASSWORD,
    },
    adminCtx(actorId, `corr-customer-${opts.phone}`),
  );
  await Customer.updateOne({ _id: created.customer._id }, { $set: { kycStatus: 'VERIFIED' } });
  return created.customer;
}

async function seedCashPlan() {
  const admin = await User.findOne({ role: 'ADMIN' });
  const actorId = String(admin?._id ?? (await seedAdmin())._id);
  return createSchemePlan(
    {
      name: 'Correction Cash',
      type: 'CASH',
      durationMonths: 11,
      minimumPaymentPaise: MIN,
      termsText: 'Eleven contribution months then cash payout.',
    },
    adminCtx(actorId, 'corr-plan'),
  );
}

async function enrollCustomer(
  customerId: string,
  planId: string,
  startDate: Date,
  requestId: string,
) {
  const admin = await User.findOne({ role: 'ADMIN' });
  return createEnrollment(
    {
      customerId,
      schemePlanId: planId,
      startDate,
      monthlyInstallmentPaise: MIN,
    },
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
      receiptNumber: `NKS-CORR-${String(schemeId).slice(-8)}-${month}-${Date.now()}`,
      collectorRole: 'ADMIN',
      collectedBy: actorId,
      createdBy: actorId,
      goldWeightMg: 0,
    })),
  );
}

async function payCash(
  actorId: string,
  customerId: string,
  schemeId: string,
  amountPaise: number,
  paymentDate: Date,
  key: string,
  schemeMonth?: number,
) {
  return createManualPayment(
    {
      customerId,
      schemeId,
      amountPaise,
      method: 'CASH',
      paymentDate,
      idempotencyKey: key,
      ...(schemeMonth != null ? { schemeMonth } : {}),
    },
    adminCtx(actorId, key),
  );
}

async function maturePayout(actorId: string, customerId: string, schemeId: string, requestId: string) {
  return createPayout(
    {
      customerId,
      schemeId,
      payoutDate: new Date(),
      payoutType: 'PAYOUT',
      method: 'CASH',
    },
    adminCtx(actorId, requestId),
  );
}

describe('Nakshathra correction pass', () => {
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

  describe('CASH maturity payout never expires', () => {
    it('rejects normal maturity payout before the maturity date', async () => {
      const admin = await seedAdmin();
      const plan = await seedCashPlan();
      const customer = await seedVerifiedCustomer({ phone: '+917183700101' });
      const start = startMonthsAgo(10);
      const enrollment = await enrollCustomer(
        String(customer._id),
        String(plan._id),
        start,
        'corr-early',
      );
      await seedPaidMonths(
        String(customer._id),
        String(enrollment._id),
        start,
        String(admin._id),
        [1, 2, 4, 6, 7, 9, 11],
      );

      await expect(
        maturePayout(String(admin._id), String(customer._id), String(enrollment._id), 'corr-early-payout'),
      ).rejects.toMatchObject({ code: 'REDEMPTION_WINDOW_CLOSED' });
      expect(await Payout.countDocuments({ schemeId: enrollment._id })).toBe(0);
    });

    it.each([
      { label: 'at maturity / month 12', monthsAgo: 11, phone: '+917183700211' },
      { label: 'month 13 after redemptionEnd', monthsAgo: 12, phone: '+917183700212' },
      { label: 'much later after maturity', monthsAgo: 20, phone: '+917183700220' },
    ])('allows CASH payout $label', async ({ monthsAgo, phone }) => {
      const admin = await seedAdmin();
      const plan = await seedCashPlan();
      const customer = await seedVerifiedCustomer({ phone });
      const start = startMonthsAgo(monthsAgo);
      const enrollment = await enrollCustomer(
        String(customer._id),
        String(plan._id),
        start,
        `corr-late-${monthsAgo}`,
      );
      await seedPaidMonths(
        String(customer._id),
        String(enrollment._id),
        start,
        String(admin._id),
        [1, 3, 6, 8, 11],
      );

      const payout = await maturePayout(
        String(admin._id),
        String(customer._id),
        String(enrollment._id),
        `corr-late-payout-${monthsAgo}`,
      );
      expect(payout.payoutType).toBe('PAYOUT');
      expect(payout.amountPaise).toBe(5 * MIN);
      expect(payout.goldWeightMg).toBe(0);
      expect(payout.valuationGoldRateId).toBeFalsy();
    });

    it('blocks a second maturity payout after settlement', async () => {
      const admin = await seedAdmin();
      const plan = await seedCashPlan();
      const customer = await seedVerifiedCustomer({ phone: '+917183700121' });
      const start = startMonthsAgo(12);
      const enrollment = await enrollCustomer(
        String(customer._id),
        String(plan._id),
        start,
        'corr-dup',
      );
      await seedPaidMonths(
        String(customer._id),
        String(enrollment._id),
        start,
        String(admin._id),
        [1, 2, 3],
      );
      const first = await maturePayout(
        String(admin._id),
        String(customer._id),
        String(enrollment._id),
        'corr-dup-1',
      );
      const second = await maturePayout(
        String(admin._id),
        String(customer._id),
        String(enrollment._id),
        'corr-dup-2',
      );
      expect(String(second._id)).toBe(String(first._id));
      expect(await Payout.countDocuments({ schemeId: enrollment._id, status: 'SUCCESS' })).toBe(1);
    });
  });

  describe('skipped contribution months', () => {
    it('lets a CASH enrollment mature with payments in only 7 distinct months', async () => {
      const admin = await seedAdmin();
      const plan = await seedCashPlan();
      const customer = await seedVerifiedCustomer({ phone: '+917183700131' });
      const start = startMonthsAgo(11);
      const enrollment = await enrollCustomer(
        String(customer._id),
        String(plan._id),
        start,
        'corr-skip-7',
      );
      await seedPaidMonths(
        String(customer._id),
        String(enrollment._id),
        start,
        String(admin._id),
        [1, 2, 4, 6, 7, 9, 11],
      );
      const ledger = await aggregateEnrollmentLedger(String(enrollment._id));
      expect(ledger.paymentsCompleted).toBe(7);
      expect(ledger.paymentsCompleted).not.toBe(11);

      const payout = await maturePayout(
        String(admin._id),
        String(customer._id),
        String(enrollment._id),
        'corr-skip-7-payout',
      );
      expect(payout.amountPaise).toBe(7 * MIN);
    });

    it('lets a CASH enrollment mature with payments in only 5 distinct months, including skipped flexible and capped months', async () => {
      const admin = await seedAdmin();
      const plan = await seedCashPlan();
      const customer = await seedVerifiedCustomer({ phone: '+917183700132' });
      const start = startMonthsAgo(11);
      const enrollment = await enrollCustomer(
        String(customer._id),
        String(plan._id),
        start,
        'corr-skip-5',
      );
      await seedPaidMonths(
        String(customer._id),
        String(enrollment._id),
        start,
        String(admin._id),
        [1, 6, 7, 9, 11],
      );
      const ledger = await aggregateEnrollmentLedger(String(enrollment._id));
      expect(ledger.paymentsCompleted).toBe(5);

      const payout = await maturePayout(
        String(admin._id),
        String(customer._id),
        String(enrollment._id),
        'corr-skip-5-payout',
      );
      expect(payout.amountPaise).toBe(5 * MIN);
    });

    it('allows multiple payments in months 1–6', async () => {
      const admin = await seedAdmin();
      const plan = await seedCashPlan();
      const customer = await seedVerifiedCustomer({ phone: '+917183700133' });
      const start = monthStartIst();
      const enrollment = await enrollCustomer(
        String(customer._id),
        String(plan._id),
        start,
        'corr-multi-flex',
      );
      const first = await payCash(
        String(admin._id),
        String(customer._id),
        String(enrollment._id),
        MIN,
        new Date(),
        'corr-multi-a',
      );
      const second = await payCash(
        String(admin._id),
        String(customer._id),
        String(enrollment._id),
        MIN + 50_000,
        new Date(),
        'corr-multi-b',
      );
      expect(first.schemeMonth).toBe(1);
      expect(second.schemeMonth).toBe(1);
      const ledger = await aggregateEnrollmentLedger(String(enrollment._id));
      expect(ledger.totalPaidPaise).toBe(MIN + MIN + 50_000);
      expect(ledger.paymentsCompleted).toBe(1);
    });
  });

  describe('CASH-only gold feature gating', () => {
    it('does not fetch a gold rate for CASH payment or CASH payout', async () => {
      const spy = vi.spyOn(schemeService, 'activeGoldRate');
      const admin = await seedAdmin();
      const plan = await seedCashPlan();
      const customer = await seedVerifiedCustomer({ phone: '+917183700141' });
      const start = startMonthsAgo(11);
      const enrollment = await enrollCustomer(
        String(customer._id),
        String(plan._id),
        start,
        'corr-nogold',
      );
      await payCash(
        String(admin._id),
        String(customer._id),
        String(enrollment._id),
        MIN,
        monthDate(start, 0),
        'corr-nogold-pay',
      );
      await seedPaidMonths(
        String(customer._id),
        String(enrollment._id),
        start,
        String(admin._id),
        [2, 3],
      );
      await maturePayout(
        String(admin._id),
        String(customer._id),
        String(enrollment._id),
        'corr-nogold-payout',
      );
      expect(spy).not.toHaveBeenCalled();
      expect(await GoldRate.countDocuments()).toBe(0);
    });

    it('does not require a gold rate on the CASH customer scheme summary', async () => {
      const spy = vi.spyOn(schemeService, 'activeGoldRate');
      const admin = await seedAdmin();
      const plan = await seedCashPlan();
      const customer = await seedVerifiedCustomer({ phone: '+917183700142' });
      const enrollment = await enrollCustomer(
        String(customer._id),
        String(plan._id),
        monthStartIst(),
        'corr-home',
      );
      expect(enrollment.schemeType).toBe('CASH');
      const home = await getCustomerHome(String(customer.userId));
      expect(home.currentGoldRate).toBeNull();
      expect(home.schemeStatus?.currentGoldRate).toBeNull();
      expect(spy).not.toHaveBeenCalled();
    });

    it('rejects gold-only customer and admin gold-rate routes while GOLD_WEIGHT is disabled', async () => {
      expect(isGoldWeightEnabled()).toBe(false);
      const admin = await seedAdmin();
      await seedVerifiedCustomer({ phone: '+917183700143' });
      const adminIssued = await login(ADMIN_PHONE, ADMIN_PASSWORD, { ip: '127.0.0.1' });
      const customerIssued = await login('+917183700143', CUSTOMER_PASSWORD, { ip: '127.0.0.1' });

      const customerRates = await request(app)
        .get('/api/v1/customer/gold-rates')
        .set('Cookie', cookieHeader(customerIssued.tokens.access));
      expect(customerRates.status).toBe(409);
      expect(customerRates.body.error.code).toBe('GOLD_WEIGHT_DISABLED');

      const adminRates = await request(app)
        .get('/api/v1/admin/gold-rates')
        .set('Cookie', cookieHeader(adminIssued.tokens.access));
      expect(adminRates.status).toBe(409);
      expect(adminRates.body.error.code).toBe('GOLD_WEIGHT_DISABLED');

      const created = await request(app)
        .post('/api/v1/admin/gold-rates')
        .set('Cookie', cookieHeader(adminIssued.tokens.access))
        .send({ ratePerGramPaise: 750_000, purity: '916', effectiveFrom: new Date().toISOString() });
      expect(created.status).toBe(409);
      expect(created.body.error.code).toBe('GOLD_WEIGHT_DISABLED');

      expect(() => listGoldRates()).toThrow(/GOLD_WEIGHT functionality is not enabled/);
      await expect(
        createGoldRate(
          { ratePerGramPaise: 750_000, purity: '916', effectiveFrom: new Date() },
          adminCtx(String(admin._id), 'corr-gold-create'),
        ),
      ).rejects.toMatchObject({ code: 'GOLD_WEIGHT_DISABLED' });
    });

    it('keeps GOLD_WEIGHT conversion infrastructure available while dormant', () => {
      expect(isGoldWeightEnabled()).toBe(false);
      expect(schemeService.goldWeightMg(100_000, 700_000)).toBeGreaterThan(0);
      expect(
        calculatePrematureClosureSettlement({
          schemeType: 'GOLD_WEIGHT',
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
        }),
      ).toBeNull();
    });
  });

  describe('correction workflow', () => {
    it('accepts amount and method corrections and preserves the original through reversal', async () => {
      const admin = await seedAdmin();
      const reviewer = await seedAdmin(ADMIN2_PHONE);
      const plan = await seedCashPlan();
      const customer = await seedVerifiedCustomer({ phone: '+917183700151' });
      const enrollment = await enrollCustomer(
        String(customer._id),
        String(plan._id),
        monthStartIst(),
        'corr-amt',
      );
      const created = await payCash(
        String(admin._id),
        String(customer._id),
        String(enrollment._id),
        MIN,
        new Date(),
        'corr-amt-pay',
      );

      const amountCorrection = await requestCorrection(
        String(created.paymentId),
        {
          correctionType: 'CHANGE_AMOUNT',
          requestedChanges: { amountPaise: MIN + 25_000 },
          reason: 'customer paid extra cash',
        },
        adminCtx(String(admin._id), 'corr-amt-req'),
      );
      const amountReviewed = await reviewCorrection(
        String(amountCorrection._id),
        'APPROVED',
        'apply extra',
        adminCtx(String(reviewer._id), 'corr-amt-app'),
      );
      expect((await Payment.findById(created.paymentId))?.status).toBe('REVERSED');
      expect(amountReviewed.replacement.amountPaise).toBe(MIN + 25_000);
      expect(amountReviewed.replacement.supersedesPaymentId.toString()).toBe(String(created.paymentId));

      const methodCorrection = await requestCorrection(
        String(amountReviewed.replacement._id),
        {
          correctionType: 'CHANGE_METHOD',
          requestedChanges: { method: 'UPI' },
          reason: 'recorded as cash by mistake',
        },
        adminCtx(String(admin._id), 'corr-method-req'),
      );
      const methodReviewed = await reviewCorrection(
        String(methodCorrection._id),
        'APPROVED',
        'switch method',
        adminCtx(String(reviewer._id), 'corr-method-app'),
      );
      expect(methodReviewed.replacement.method).toBe('UPI');
      expect((await Payment.findById(amountReviewed.replacement._id))?.status).toBe('REVERSED');
    });

    it('rejects CHANGE_DATE at the API enum and in the service, including historical pending rows', async () => {
      expect(() =>
        correctionRequestSchema.parse({
          correctionType: 'CHANGE_DATE',
          requestedChanges: { paymentDate: new Date().toISOString() },
          reason: 'backdate this receipt',
        }),
      ).toThrow();
      expect(correctionRequestSchema.shape.correctionType.options).toEqual([
        'CHANGE_AMOUNT',
        'CHANGE_METHOD',
        'CHANGE_REFERENCE',
        'CHANGE_NOTES',
        'REVERSE_PAYMENT',
      ]);
      expect(correctionRequestSchema.shape.correctionType.options).not.toContain('CHANGE_DATE');

      const admin = await seedAdmin();
      await seedStaff();
      const reviewer = await seedAdmin(ADMIN2_PHONE);
      const plan = await seedCashPlan();
      const customer = await seedVerifiedCustomer({ phone: '+917183700152' });
      const enrollment = await enrollCustomer(
        String(customer._id),
        String(plan._id),
        monthStartIst(),
        'corr-date',
      );
      const created = await payCash(
        String(admin._id),
        String(customer._id),
        String(enrollment._id),
        MIN,
        new Date(),
        'corr-date-pay',
      );

      await expect(
        requestCorrection(
          String(created.paymentId),
          {
            correctionType: 'CHANGE_DATE',
            requestedChanges: { paymentDate: monthDate(monthStartIst(), 0, 2).toISOString() },
            reason: 'backdate this receipt',
          },
          adminCtx(String(admin._id), 'corr-date-req'),
        ),
      ).rejects.toMatchObject({ code: 'CORRECTION_TYPE_DISABLED', statusCode: 422 });

      const staffIssued = await login(STAFF_PHONE, STAFF_PASSWORD, { ip: '127.0.0.1' });
      const http = await request(app)
        .post(`/api/v1/staff/payments/${created.paymentId}/corrections`)
        .set('Cookie', cookieHeader(staffIssued.tokens.access))
        .send({
          correctionType: 'CHANGE_DATE',
          requestedChanges: { paymentDate: new Date().toISOString() },
          reason: 'backdate this receipt',
        });
      expect(http.status).toBe(422);
      expect(http.body.error.code).not.toBeUndefined();

      const [historical] = await PaymentCorrection.create([
        {
          paymentId: created.paymentId,
          requestedBy: admin._id,
          correctionType: 'CHANGE_DATE',
          originalSnapshot: { paymentDate: new Date() },
          requestedChanges: { paymentDate: monthDate(monthStartIst(), 0, 2).toISOString() },
          reason: 'legacy date correction still pending',
          status: 'PENDING',
        },
      ]);
      await expect(
        reviewCorrection(String(historical._id), 'APPROVED', 'no', adminCtx(String(reviewer._id), 'corr-hist-app')),
      ).rejects.toMatchObject({ code: 'CORRECTION_TYPE_DISABLED', statusCode: 422 });
      const rejected = await reviewCorrection(
        String(historical._id),
        'REJECTED',
        'date corrections disabled',
        adminCtx(String(reviewer._id), 'corr-hist-rej'),
      );
      expect(rejected.status).toBe('REJECTED');
      expect((await Payment.findById(created.paymentId))?.status).toBe('SUCCESS');
    });

    it('blocks a duplicate correction approval and enforces the scheme cap on the replacement', async () => {
      const admin = await seedAdmin();
      const reviewer = await seedAdmin(ADMIN2_PHONE);
      const otherReviewer = await seedAdmin('+917183700092');
      const plan = await seedCashPlan();
      const customer = await seedVerifiedCustomer({ phone: '+917183700153' });
      const start = startMonthsAgo(6);
      const enrollment = await enrollCustomer(
        String(customer._id),
        String(plan._id),
        start,
        'corr-cap',
      );
      await seedPaidMonths(
        String(customer._id),
        String(enrollment._id),
        start,
        String(admin._id),
        [1, 2, 3, 4, 5, 6],
      );
      const created = await payCash(
        String(admin._id),
        String(customer._id),
        String(enrollment._id),
        MIN,
        new Date(),
        'corr-cap-pay',
      );
      expect(created.schemeMonth).toBe(7);

      const overCap = await requestCorrection(
        String(created.paymentId),
        {
          correctionType: 'CHANGE_AMOUNT',
          requestedChanges: { amountPaise: MIN + 50_000 },
          reason: 'cannot exceed month-7 cap',
        },
        adminCtx(String(admin._id), 'corr-cap-req'),
      );
      await expect(
        reviewCorrection(String(overCap._id), 'APPROVED', 'over cap', adminCtx(String(reviewer._id), 'corr-cap-app')),
      ).rejects.toMatchObject({ code: 'PAYMENT_LIMIT_EXCEEDED', statusCode: 409 });
      expect((await Payment.findById(created.paymentId))?.status).toBe('SUCCESS');
      await reviewCorrection(
        String(overCap._id),
        'REJECTED',
        'over cap',
        adminCtx(String(reviewer._id), 'corr-cap-rej'),
      );

      const ok = await requestCorrection(
        String(created.paymentId),
        {
          correctionType: 'CHANGE_AMOUNT',
          requestedChanges: { amountPaise: MIN },
          reason: 'same amount after failed over-cap attempt',
        },
        adminCtx(String(admin._id), 'corr-dup-req'),
      );
      await reviewCorrection(String(ok._id), 'APPROVED', 'apply', adminCtx(String(reviewer._id), 'corr-dup-app-1'));
      await expect(
        reviewCorrection(String(ok._id), 'APPROVED', 'apply again', {
          actorId: String(otherReviewer._id),
          actorRole: 'ADMIN',
          requestId: 'corr-dup-app-2',
        }),
      ).rejects.toMatchObject({ code: 'CORRECTION_ALREADY_REVIEWED', statusCode: 409 });
      expect(await Payment.countDocuments({ schemeId: enrollment._id, status: 'SUCCESS', schemeMonth: 7 })).toBe(1);
    });
  });

  describe('admin manual payment schemeMonth is server-derived', () => {
    it('succeeds without a client schemeMonth and derives months 1, 6, 7 and 11', async () => {
      const admin = await seedAdmin();
      const plan = await seedCashPlan();

      const customer1 = await seedVerifiedCustomer({ phone: '+917183700161' });
      const month1Start = monthStartIst();
      const month1 = await enrollCustomer(
        String(customer1._id),
        String(plan._id),
        month1Start,
        'corr-m1',
      );
      const paid1 = await payCash(
        String(admin._id),
        String(customer1._id),
        String(month1._id),
        MIN,
        new Date(),
        'corr-m1-pay',
      );
      expect(paid1.schemeMonth).toBe(1);

      const customer6 = await seedVerifiedCustomer({ phone: '+917183700165' });
      const month6Start = startMonthsAgo(5);
      const month6 = await enrollCustomer(
        String(customer6._id),
        String(plan._id),
        month6Start,
        'corr-m6',
      );
      const paid6 = await payCash(
        String(admin._id),
        String(customer6._id),
        String(month6._id),
        MIN,
        new Date(),
        'corr-m6-pay',
      );
      expect(paid6.schemeMonth).toBe(6);

      const customer7 = await seedVerifiedCustomer({ phone: '+917183700166' });
      const month7Start = startMonthsAgo(6);
      const month7 = await enrollCustomer(
        String(customer7._id),
        String(plan._id),
        month7Start,
        'corr-m7',
      );
      await seedPaidMonths(String(customer7._id), String(month7._id), month7Start, String(admin._id), [1]);
      const paid7 = await payCash(
        String(admin._id),
        String(customer7._id),
        String(month7._id),
        MIN,
        new Date(),
        'corr-m7-pay',
      );
      expect(paid7.schemeMonth).toBe(7);

      const customer11 = await seedVerifiedCustomer({ phone: '+917183700167' });
      const month11Start = startMonthsAgo(10);
      const month11 = await enrollCustomer(
        String(customer11._id),
        String(plan._id),
        month11Start,
        'corr-m11',
      );
      await seedPaidMonths(String(customer11._id), String(month11._id), month11Start, String(admin._id), [1]);
      const paid11 = await payCash(
        String(admin._id),
        String(customer11._id),
        String(month11._id),
        MIN,
        new Date(),
        'corr-m11-pay',
      );
      expect(paid11.schemeMonth).toBe(11);
    });

    it('derives the IST month boundary and ignores an incorrect client schemeMonth', async () => {
      const admin = await seedAdmin();
      const plan = await seedCashPlan();
      const customer = await seedVerifiedCustomer({ phone: '+917183700162' });
      const start = startMonthsAgo(1);
      const enrollment = await enrollCustomer(
        String(customer._id),
        String(plan._id),
        start,
        'corr-ist',
      );
      const lastOfMonth1 = await payCash(
        String(admin._id),
        String(customer._id),
        String(enrollment._id),
        MIN,
        lastInstantOfSchemeMonth(start, 0),
        'corr-ist-m1',
      );
      expect(lastOfMonth1.schemeMonth).toBe(1);
      const firstOfMonth2 = await payCash(
        String(admin._id),
        String(customer._id),
        String(enrollment._id),
        MIN,
        firstInstantOfSchemeMonth(start, 1),
        'corr-ist-m2',
      );
      expect(firstOfMonth2.schemeMonth).toBe(2);

      await expect(
        payCash(
          String(admin._id),
          String(customer._id),
          String(enrollment._id),
          MIN,
          new Date(),
          'corr-ist-override',
          11,
        ),
      ).rejects.toMatchObject({ code: 'INVALID_SCHEME_MONTH', statusCode: 422 });
    });

    it('enforces the month-7 cap using the server-derived scheme month', async () => {
      const admin = await seedAdmin();
      const plan = await seedCashPlan();
      const customer = await seedVerifiedCustomer({ phone: '+917183700163' });
      const start = startMonthsAgo(6);
      const enrollment = await enrollCustomer(
        String(customer._id),
        String(plan._id),
        start,
        'corr-cap-derived',
      );
      await seedPaidMonths(String(customer._id), String(enrollment._id), start, String(admin._id), [1]);
      await expect(
        payCash(
          String(admin._id),
          String(customer._id),
          String(enrollment._id),
          MIN + 50_000,
          new Date(),
          'corr-cap-derived-pay',
        ),
      ).rejects.toMatchObject({ code: 'PAYMENT_LIMIT_EXCEEDED' });
    });

    it('accepts the admin HTTP manual payment without client schemeMonth', async () => {
      const admin = await seedAdmin();
      const plan = await seedCashPlan();
      const customer = await seedVerifiedCustomer({ phone: '+917183700164' });
      const enrollment = await enrollCustomer(
        String(customer._id),
        String(plan._id),
        monthStartIst(),
        'corr-http-m',
      );
      const issued = await login(ADMIN_PHONE, ADMIN_PASSWORD, { ip: '127.0.0.1' });
      const posted = await request(app)
        .post('/api/v1/admin/payments/manual')
        .set('Cookie', cookieHeader(issued.tokens.access))
        .send({
          customerId: String(customer._id),
          schemeId: String(enrollment._id),
          amountPaise: MIN,
          method: 'CASH',
          paymentDate: new Date().toISOString(),
          idempotencyKey: 'corr-http-manual-0001',
        });
      expect(posted.status).toBe(201);
      expect(posted.body.data.schemeMonth).toBe(1);
      expect(admin.role).toBe('ADMIN');
    });
  });

  describe('premature closure returns contributed principal', () => {
    it('settles ₹42,000 of valid contributions as ₹42,000 with no penalty or gold', async () => {
      const admin = await seedAdmin();
      const plan = await seedCashPlan();
      const customer = await seedVerifiedCustomer({ phone: '+917183700171' });
      const enrollment = await enrollCustomer(
        String(customer._id),
        String(plan._id),
        monthStartIst(),
        'corr-pc-42k',
      );
      await payCash(
        String(admin._id),
        String(customer._id),
        String(enrollment._id),
        PRINCIPAL_42000_RUPEES,
        new Date(),
        'corr-pc-42k-pay',
      );
      const payout = await prematureCloseEnrollment(
        String(enrollment._id),
        {
          settlementAsset: 'CASH',
          payoutDate: new Date(),
          reason: 'Customer requested premature closure',
          method: 'CASH',
          idempotencyKey: 'corr-pc-42k-0001',
        },
        adminCtx(String(admin._id), 'corr-pc-42k-close'),
      );
      expect(payout.amountPaise).toBe(PRINCIPAL_42000_RUPEES);
      expect(payout.settlementPrincipalPaise).toBe(PRINCIPAL_42000_RUPEES);
      expect(payout.goldWeightMg).toBe(0);
      expect(payout.cashBasis).toBe('CONTRIBUTION_VALUE');
      expect(await GoldRate.countDocuments()).toBe(0);
    });

    it('excludes reversed and failed payments and protects duplicate closure', async () => {
      const admin = await seedAdmin();
      const plan = await seedCashPlan();
      const customer = await seedVerifiedCustomer({ phone: '+917183700172' });
      const enrollment = await enrollCustomer(
        String(customer._id),
        String(plan._id),
        monthStartIst(),
        'corr-pc-ex',
      );
      const keep = await payCash(
        String(admin._id),
        String(customer._id),
        String(enrollment._id),
        250_000,
        new Date(),
        'corr-pc-keep',
      );
      const reverse = await payCash(
        String(admin._id),
        String(customer._id),
        String(enrollment._id),
        150_000,
        new Date(),
        'corr-pc-rev',
      );
      await Payment.updateOne(
        { _id: reverse.paymentId },
        { $set: { status: 'REVERSED', reversedAt: new Date(), reversalReason: 'test' } },
      );
      await Payment.create([
        {
          customerId: customer._id,
          schemeId: enrollment._id,
          amountPaise: 300_000,
          method: 'UPI',
          status: 'FAILED',
          paymentDate: new Date(),
          schemeMonth: 1,
          receiptNumber: `NKS-CORR-FAIL-${Date.now()}`,
          collectorRole: 'ADMIN',
          collectedBy: admin._id,
          createdBy: admin._id,
          goldWeightMg: 0,
        },
      ]);
      const ledger = await aggregateEnrollmentLedger(String(enrollment._id));
      expect(ledger.totalPaidPaise).toBe(250_000);
      expect(keep.amountPaise).toBe(250_000);

      const payout = await prematureCloseEnrollment(
        String(enrollment._id),
        {
          settlementAsset: 'CASH',
          payoutDate: new Date(),
          reason: 'Close after excluding invalid rows',
          method: 'CASH',
          idempotencyKey: 'corr-pc-ex-0001',
        },
        adminCtx(String(admin._id), 'corr-pc-ex-close'),
      );
      expect(payout.amountPaise).toBe(250_000);

      await expect(
        prematureCloseEnrollment(
          String(enrollment._id),
          {
            settlementAsset: 'CASH',
            payoutDate: new Date(),
            reason: 'second close',
            method: 'CASH',
            idempotencyKey: 'corr-pc-ex-0002',
          },
          adminCtx(String(admin._id), 'corr-pc-ex-dup'),
        ),
      ).rejects.toMatchObject({
        code: expect.stringMatching(/^(SCHEME_ALREADY_SETTLED|USE_MATURITY_REDEMPTION_FLOW)$/),
      });
    });
  });
});
