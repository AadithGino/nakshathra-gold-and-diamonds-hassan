import { addMonths, startOfMonth } from 'date-fns';
import { fromZonedTime, toZonedTime } from 'date-fns-tz';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { app } from '../src/app.js';
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
import { hashPassword, login } from '../src/services/auth.service.js';
import { createCustomer } from '../src/services/customer.service.js';
import { createPayout } from '../src/services/finance.service.js';
import {
  initiateStaffPhonePe,
  reconcilePaymentIntentStatus,
} from '../src/services/gateway.service.js';
import { createManualPayment } from '../src/services/payment.service.js';
import { phonePeProvider } from '../src/services/phonepe.provider.js';
import {
  createEnrollment,
  createSchemePlan,
  prematureCloseEnrollment,
  updateEnrollmentStatus,
} from '../src/services/scheme-management.service.js';
import { getPaymentRules } from '../src/services/scheme.service.js';
import { createStaff } from '../src/services/staff.service.js';
import { aggregateEnrollmentLedger } from '../src/utils/enrollment-ledger.js';
import { AppError } from '../src/utils/AppError.js';
import {
  calculatePrematureClosureSettlement,
  PREMATURE_CLOSURE_POLICY_ID,
} from '../src/utils/premature-closure-policy.js';
import { LIVE_CASH_SETTLEMENT_POLICY } from '../src/utils/payment-window.js';
import { BUSINESS_TZ } from '../src/utils/time.js';
import type { CreateStaffInput } from '../src/validators/staff.validators.js';
import { clearTestMongo, startTestMongo, stopTestMongo } from './helpers/mongo.js';

const ADMIN_PHONE = '+917182600001';
const STAFF_PHONE = '+917182600002';
const ADMIN_PASSWORD = 'AdminPass123!';
const STAFF_PASSWORD = 'StaffPass123!';
const CUSTOMER_PASSWORD = 'CustomerPass123!';
const MIN = 100_000;
const COLLECT_PERMISSIONS = ['canViewCustomers', 'canCollectPayment'] as const;

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
      name: 'Phase6 Admin',
      phone: ADMIN_PHONE,
      passwordHash: await hashPassword(ADMIN_PASSWORD),
      role: 'ADMIN',
      status: 'ACTIVE',
    },
  ]);
  return admin;
}

async function seedStaff(
  phone: string,
  permissions: CreateStaffInput['permissions'],
  employeeCode: string,
) {
  const admin = await User.findOne({ role: 'ADMIN' });
  const actorId = String(admin?._id ?? (await seedAdmin())._id);
  return createStaff(
    {
      name: `Phase6 Staff ${employeeCode}`,
      phone,
      password: STAFF_PASSWORD,
      employeeCode,
      permissions,
    },
    adminCtx(actorId, `p6-staff-${employeeCode}`),
  );
}

async function seedVerifiedCustomer(opts: { name?: string; phone: string }) {
  const admin = await User.findOne({ role: 'ADMIN' });
  const actorId = String(admin?._id ?? (await seedAdmin())._id);
  const created = await createCustomer(
    {
      name: opts.name ?? 'Phase6 Customer',
      phone: opts.phone,
      password: CUSTOMER_PASSWORD,
    },
    adminCtx(actorId, `p6-customer-${opts.phone}`),
  );
  await Customer.updateOne({ _id: created.customer._id }, { $set: { kycStatus: 'VERIFIED' } });
  return created.customer;
}

async function seedCashPlan() {
  const admin = await User.findOne({ role: 'ADMIN' });
  const actorId = String(admin?._id ?? (await seedAdmin())._id);
  return createSchemePlan(
    {
      name: 'Phase6 Cash',
      type: 'CASH',
      durationMonths: 11,
      minimumPaymentPaise: MIN,
      termsText: 'Eleven contribution months then cash payout.',
    },
    adminCtx(actorId, 'p6-plan'),
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
      receiptNumber: `NKS-P6-${String(schemeId).slice(-8)}-${month}-${Date.now()}`,
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

async function assertCashSettlementIntegrity(schemeId: string, expectedPaise: number) {
  const duplicatePayouts = await Payout.aggregate([
    { $match: { status: 'SUCCESS' } },
    { $group: { _id: '$schemeId', count: { $sum: 1 } } },
    { $match: { count: { $gt: 1 } } },
  ]);
  expect(duplicatePayouts).toEqual([]);

  const payouts = await Payout.find({ schemeId, status: 'SUCCESS' });
  expect(payouts).toHaveLength(1);
  const payout = payouts[0];
  expect(payout.amountPaise).toBe(expectedPaise);
  expect(payout.settlementPrincipalPaise).toBe(expectedPaise);
  expect(payout.goldWeightMg).toBe(0);
  expect(payout.valuationGoldRateId).toBeFalsy();
  expect(payout.valuationGoldRatePerGramPaise).toBeFalsy();
  expect(payout.valuationGoldWeightMg).toBeFalsy();
  expect(payout.cashBasis).toBe('CONTRIBUTION_VALUE');
  expect(await GoldInventoryMovement.countDocuments({ payoutId: payout._id })).toBe(0);
  expect(await GoldInventoryMovement.countDocuments()).toBe(0);
  expect(await GoldRate.countDocuments()).toBe(0);

  const ledger = await aggregateEnrollmentLedger(schemeId);
  expect(ledger.availablePaise).toBe(0);
  expect(ledger.availableGoldWeightMg).toBe(0);
  expect(ledger.totalPaidPaise).toBe(expectedPaise);
  expect(ledger.totalSettlementPrincipalPaise).toBe(expectedPaise);
}

describe('Phase 6 — CASH maturity settlement, payout and premature closure', () => {
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

  describe('premature-closure policy boundary', () => {
    it('returns contribution value with no penalty for live CASH and leaves GOLD_WEIGHT to the existing calculator', () => {
      expect(PREMATURE_CLOSURE_POLICY_ID).toBe('CONTRIBUTION_VALUE_NO_PENALTY');
      expect(LIVE_CASH_SETTLEMENT_POLICY.prematureClosureSettlementAssets).toEqual(['CASH']);
      expect(LIVE_CASH_SETTLEMENT_POLICY.maturitySettlementAssets).toEqual(['CASH']);
      expect(LIVE_CASH_SETTLEMENT_POLICY.prematureClosureCashBasis).toBe('CONTRIBUTION_VALUE');
      expect(LIVE_CASH_SETTLEMENT_POLICY.maturityCashBasis).toBe('CONTRIBUTION_VALUE');

      const cash = calculatePrematureClosureSettlement({
        schemeType: 'CASH',
        ledger: {
          totalPaidPaise: 350_000,
          totalGoldWeightMg: 0,
          totalPayoutPaise: 0,
          totalSettlementPrincipalPaise: 0,
          totalPayoutGoldWeightMg: 0,
          paymentsCompleted: 2,
          availablePaise: 350_000,
          availableGoldWeightMg: 0,
        },
      });
      expect(cash).toMatchObject({
        policyId: PREMATURE_CLOSURE_POLICY_ID,
        cashBasis: 'CONTRIBUTION_VALUE',
        amountPaise: 350_000,
        settlementPrincipalPaise: 350_000,
        goldWeightMg: 0,
      });
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

  describe('maturity payout', () => {
    it('pays out a matured-ready CASH enrollment at contribution value with no gold fields', async () => {
      const admin = await seedAdmin();
      const plan = await seedCashPlan();
      const customer = await seedVerifiedCustomer({ phone: '+917182600101' });
      const start = startMonthsAgo(11);
      const enrollment = await enrollCustomer(
        String(customer._id),
        String(plan._id),
        start,
        'p6-mature',
      );
      await seedPaidMonths(
        String(customer._id),
        String(enrollment._id),
        start,
        String(admin._id),
        [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11],
      );

      const payout = await createPayout(
        {
          customerId: String(customer._id),
          schemeId: String(enrollment._id),
          payoutDate: new Date(),
          payoutType: 'PAYOUT',
          method: 'CASH',
        },
        adminCtx(String(admin._id), 'p6-payout-cash'),
      );

      expect(payout.payoutType).toBe('PAYOUT');
      expect(payout.method).toBe('CASH');
      expect(payout.status).toBe('SUCCESS');
      expect(payout.amountPaise).toBe(11 * MIN);
      expect(await SchemeEnrollment.findById(enrollment._id).then((row) => row?.status)).toBe(
        'CLOSED',
      );
      await assertCashSettlementIntegrity(String(enrollment._id), 11 * MIN);
    });

    it('supports CASH, BANK and UPI disbursement methods for CASH settlement', async () => {
      const admin = await seedAdmin();
      const plan = await seedCashPlan();

      const matureCustomer = await seedVerifiedCustomer({ phone: '+917182600102' });
      const matureStart = startMonthsAgo(11);
      const matureEnrollment = await enrollCustomer(
        String(matureCustomer._id),
        String(plan._id),
        matureStart,
        'p6-method-mature',
      );
      await seedPaidMonths(
        String(matureCustomer._id),
        String(matureEnrollment._id),
        matureStart,
        String(admin._id),
        [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11],
      );
      const cashPayout = await createPayout(
        {
          customerId: String(matureCustomer._id),
          schemeId: String(matureEnrollment._id),
          payoutDate: new Date(),
          payoutType: 'PAYOUT',
          method: 'CASH',
          idempotencyKey: 'p6-method-cash-01',
        },
        adminCtx(String(admin._id), 'p6-method-cash'),
      );
      expect(cashPayout.method).toBe('CASH');

      const bankCustomer = await seedVerifiedCustomer({ phone: '+917182600103' });
      const bankEnrollment = await enrollCustomer(
        String(bankCustomer._id),
        String(plan._id),
        monthStartIst(),
        'p6-method-bank',
      );
      await payCash(
        String(admin._id),
        String(bankCustomer._id),
        String(bankEnrollment._id),
        MIN,
        new Date(),
        'p6-bank-pay',
      );
      const bank = await prematureCloseEnrollment(
        String(bankEnrollment._id),
        {
          settlementAsset: 'CASH',
          payoutDate: new Date(),
          reason: 'Customer requested bank transfer',
          method: 'BANK',
          idempotencyKey: 'p6-method-bank-01',
        },
        adminCtx(String(admin._id), 'p6-method-bank-close'),
      );
      expect(bank.method).toBe('BANK');
      expect(bank.payoutType).toBe('PREMATURE_CLOSE');
      expect(bank.amountPaise).toBe(MIN);

      const upiCustomer = await seedVerifiedCustomer({ phone: '+917182600104' });
      const upiEnrollment = await enrollCustomer(
        String(upiCustomer._id),
        String(plan._id),
        monthStartIst(),
        'p6-method-upi',
      );
      await payCash(
        String(admin._id),
        String(upiCustomer._id),
        String(upiEnrollment._id),
        MIN * 2,
        new Date(),
        'p6-upi-pay',
      );
      const upi = await prematureCloseEnrollment(
        String(upiEnrollment._id),
        {
          settlementAsset: 'CASH',
          payoutDate: new Date(),
          reason: 'Customer requested UPI payout',
          method: 'UPI',
          idempotencyKey: 'p6-method-upi-01',
        },
        adminCtx(String(admin._id), 'p6-method-upi-close'),
      );
      expect(upi.method).toBe('UPI');
      expect(upi.amountPaise).toBe(MIN * 2);
    });

    it('replays a duplicate payout with the same idempotency key and rejects a second financial settlement', async () => {
      const admin = await seedAdmin();
      const plan = await seedCashPlan();
      const customer = await seedVerifiedCustomer({ phone: '+917182600105' });
      const start = startMonthsAgo(11);
      const enrollment = await enrollCustomer(
        String(customer._id),
        String(plan._id),
        start,
        'p6-dup',
      );
      await seedPaidMonths(
        String(customer._id),
        String(enrollment._id),
        start,
        String(admin._id),
        [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11],
      );

      const input = {
        customerId: String(customer._id),
        schemeId: String(enrollment._id),
        payoutDate: new Date(),
        payoutType: 'PAYOUT' as const,
        method: 'CASH' as const,
        idempotencyKey: 'p6-dup-key-0001',
      };
      const first = await createPayout(input, adminCtx(String(admin._id), 'p6-dup-1'));
      const replay = await createPayout(input, adminCtx(String(admin._id), 'p6-dup-2'));
      expect(String(replay._id)).toBe(String(first._id));
      expect(await Payout.countDocuments({ schemeId: enrollment._id, status: 'SUCCESS' })).toBe(1);

      await expect(
        createPayout(
          { ...input, idempotencyKey: 'p6-dup-key-0002' },
          adminCtx(String(admin._id), 'p6-dup-3'),
        ),
      ).rejects.toMatchObject({ code: 'SCHEME_ALREADY_SETTLED' });
    });

    it('allows only one concurrent CASH payout to succeed', async () => {
      const admin = await seedAdmin();
      const plan = await seedCashPlan();
      const customer = await seedVerifiedCustomer({ phone: '+917182600106' });
      const start = startMonthsAgo(11);
      const enrollment = await enrollCustomer(
        String(customer._id),
        String(plan._id),
        start,
        'p6-race-payout',
      );
      await seedPaidMonths(
        String(customer._id),
        String(enrollment._id),
        start,
        String(admin._id),
        [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11],
      );

      const results = await Promise.allSettled([
        createPayout(
          {
            customerId: String(customer._id),
            schemeId: String(enrollment._id),
            payoutDate: new Date(),
            payoutType: 'PAYOUT',
            method: 'CASH',
            idempotencyKey: 'p6-concurrent-a-0001',
          },
          adminCtx(String(admin._id), 'p6-concurrent-a'),
        ),
        createPayout(
          {
            customerId: String(customer._id),
            schemeId: String(enrollment._id),
            payoutDate: new Date(),
            payoutType: 'PAYOUT',
            method: 'BANK',
            idempotencyKey: 'p6-concurrent-b-0001',
          },
          adminCtx(String(admin._id), 'p6-concurrent-b'),
        ),
      ]);

      const fulfilled = results.filter((row) => row.status === 'fulfilled');
      const rejected = results.filter((row) => row.status === 'rejected');
      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);
      const rejectedCode = (rejected[0] as PromiseRejectedResult).reason?.code;
      expect(['SCHEME_ALREADY_SETTLED', 'SCHEME_SETTLEMENT_IN_PROGRESS']).toContain(rejectedCode);
      expect(await Payout.countDocuments({ schemeId: enrollment._id, status: 'SUCCESS' })).toBe(1);
      expect(await SchemeEnrollment.findById(enrollment._id).then((row) => row?.status)).toBe(
        'CLOSED',
      );
    });

    it('rejects normal-maturity PAYOUT before the redemption window', async () => {
      const admin = await seedAdmin();
      const plan = await seedCashPlan();
      const customer = await seedVerifiedCustomer({ phone: '+917182600107' });
      const start = startMonthsAgo(10);
      const enrollment = await enrollCustomer(
        String(customer._id),
        String(plan._id),
        start,
        'p6-early',
      );
      await seedPaidMonths(
        String(customer._id),
        String(enrollment._id),
        start,
        String(admin._id),
        [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11],
      );

      await expect(
        createPayout(
          {
            customerId: String(customer._id),
            schemeId: String(enrollment._id),
            payoutDate: new Date(),
            payoutType: 'PAYOUT',
          },
          adminCtx(String(admin._id), 'p6-early-payout'),
        ),
      ).rejects.toMatchObject({ code: 'REDEMPTION_WINDOW_CLOSED' });
      expect(await SchemeEnrollment.findById(enrollment._id).then((row) => row?.status)).toBe(
        'ACTIVE',
      );
      expect(await Payout.countDocuments({ schemeId: enrollment._id })).toBe(0);
    });

    it('rejects GOLD_WEIGHT REDEEM on a live CASH enrollment and does not require a gold rate', async () => {
      const admin = await seedAdmin();
      const plan = await seedCashPlan();
      const customer = await seedVerifiedCustomer({ phone: '+917182600108' });
      const start = startMonthsAgo(11);
      const enrollment = await enrollCustomer(
        String(customer._id),
        String(plan._id),
        start,
        'p6-no-gold',
      );
      await seedPaidMonths(
        String(customer._id),
        String(enrollment._id),
        start,
        String(admin._id),
        [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11],
      );

      await expect(
        createPayout(
          {
            customerId: String(customer._id),
            schemeId: String(enrollment._id),
            payoutDate: new Date(),
            payoutType: 'REDEEM',
          },
          adminCtx(String(admin._id), 'p6-redeem-cash'),
        ),
      ).rejects.toMatchObject({ code: 'USE_CASH_PAYOUT_FLOW' });
      await expect(
        createPayout(
          {
            customerId: String(customer._id),
            schemeId: String(enrollment._id),
            payoutDate: new Date(),
            payoutType: 'PAYOUT',
            settlementAsset: 'GOLD',
          },
          adminCtx(String(admin._id), 'p6-gold-asset'),
        ),
      ).rejects.toMatchObject({ code: 'SETTLEMENT_ASSET_NOT_ALLOWED' });

      const payout = await createPayout(
        {
          customerId: String(customer._id),
          schemeId: String(enrollment._id),
          payoutDate: new Date(),
          payoutType: 'PAYOUT',
        },
        adminCtx(String(admin._id), 'p6-no-gold-ok'),
      );
      expect(payout.goldWeightMg).toBe(0);
      expect(await GoldRate.countDocuments()).toBe(0);
      expect(await GoldInventoryMovement.countDocuments()).toBe(0);
    });
  });

  describe('non-payable after maturity or closure', () => {
    it('rejects new contributions once a CASH enrollment is MATURED', async () => {
      const admin = await seedAdmin();
      const plan = await seedCashPlan();
      const customer = await seedVerifiedCustomer({ phone: '+917182600109' });
      const start = startMonthsAgo(11);
      const enrollment = await enrollCustomer(
        String(customer._id),
        String(plan._id),
        start,
        'p6-matured-status',
      );
      await seedPaidMonths(
        String(customer._id),
        String(enrollment._id),
        start,
        String(admin._id),
        [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11],
      );
      await updateEnrollmentStatus(
        String(enrollment._id),
        'MATURED',
        'All 11 months paid',
        adminCtx(String(admin._id), 'p6-mark-matured'),
      );

      await expect(
        getPaymentRules(String(enrollment._id), monthDate(start, 10), MIN),
      ).rejects.toMatchObject({ code: 'SCHEME_NOT_ACTIVE' });
      await expect(
        payCash(
          String(admin._id),
          String(customer._id),
          String(enrollment._id),
          MIN,
          monthDate(start, 10),
          'p6-matured-pay',
        ),
      ).rejects.toMatchObject({
        code: expect.stringMatching(
          /^(SCHEME_NOT_ACTIVE|SCHEME_SETTLEMENT_IN_PROGRESS|SCHEME_ALREADY_SETTLED)$/,
        ),
      });
    });

    it('rejects contributions after CASH payout closes the enrollment', async () => {
      const admin = await seedAdmin();
      const plan = await seedCashPlan();
      const customer = await seedVerifiedCustomer({ phone: '+917182600110' });
      const start = startMonthsAgo(11);
      const enrollment = await enrollCustomer(
        String(customer._id),
        String(plan._id),
        start,
        'p6-closed-pay',
      );
      await seedPaidMonths(
        String(customer._id),
        String(enrollment._id),
        start,
        String(admin._id),
        [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11],
      );
      await createPayout(
        {
          customerId: String(customer._id),
          schemeId: String(enrollment._id),
          payoutDate: new Date(),
          payoutType: 'PAYOUT',
        },
        adminCtx(String(admin._id), 'p6-close-then-pay'),
      );

      await expect(
        payCash(
          String(admin._id),
          String(customer._id),
          String(enrollment._id),
          MIN,
          new Date(),
          'p6-closed-contrib',
        ),
      ).rejects.toMatchObject({
        code: expect.stringMatching(
          /^(SCHEME_NOT_ACTIVE|SCHEME_SETTLEMENT_IN_PROGRESS|SCHEME_ALREADY_SETTLED)$/,
        ),
      });
    });
  });

  describe('premature closure', () => {
    it('settles at contribution value with no invented penalty and closes the enrollment', async () => {
      const admin = await seedAdmin();
      const plan = await seedCashPlan();
      const customer = await seedVerifiedCustomer({ phone: '+917182600111' });
      const enrollment = await enrollCustomer(
        String(customer._id),
        String(plan._id),
        monthStartIst(),
        'p6-pc',
      );
      await payCash(
        String(admin._id),
        String(customer._id),
        String(enrollment._id),
        150_000,
        new Date(),
        'p6-pc-a',
      );
      await payCash(
        String(admin._id),
        String(customer._id),
        String(enrollment._id),
        250_000,
        new Date(),
        'p6-pc-b',
      );

      const payout = await prematureCloseEnrollment(
        String(enrollment._id),
        {
          settlementAsset: 'CASH',
          payoutDate: new Date(),
          reason: 'Customer requested premature closure',
          method: 'CASH',
          idempotencyKey: 'p6-pc-close-0001',
        },
        adminCtx(String(admin._id), 'p6-pc-close'),
      );

      expect(payout.payoutType).toBe('PREMATURE_CLOSE');
      expect(payout.amountPaise).toBe(400_000);
      expect(payout.settlementPrincipalPaise).toBe(400_000);
      expect(payout.goldWeightMg).toBe(0);
      expect(await SchemeEnrollment.findById(enrollment._id).then((row) => row?.status)).toBe(
        'CLOSED',
      );
      await assertCashSettlementIntegrity(String(enrollment._id), 400_000);
    });

    it('protects a payment vs premature-closure race', async () => {
      const admin = await seedAdmin();
      const plan = await seedCashPlan();
      const customer = await seedVerifiedCustomer({ phone: '+917182600112' });
      const start = startMonthsAgo(2);
      const enrollment = await enrollCustomer(
        String(customer._id),
        String(plan._id),
        start,
        'p6-race-close',
      );
      await payCash(
        String(admin._id),
        String(customer._id),
        String(enrollment._id),
        MIN,
        monthDate(start, 0),
        'p6-race-seed',
      );

      const results = await Promise.allSettled([
        payCash(
          String(admin._id),
          String(customer._id),
          String(enrollment._id),
          MIN,
          monthDate(start, 1),
          'p6-race-pay',
        ),
        prematureCloseEnrollment(
          String(enrollment._id),
          {
            settlementAsset: 'CASH',
            payoutDate: monthDate(start, 1),
            reason: 'Close during payment race',
            idempotencyKey: 'p6-race-close-0001',
          },
          adminCtx(String(admin._id), 'p6-race-close'),
        ),
      ]);

      const payResult = results[0];
      const closeResult = results[1];
      const payFailed =
        payResult.status === 'rejected' &&
        ['SCHEME_SETTLEMENT_IN_PROGRESS', 'SCHEME_NOT_ACTIVE', 'SCHEME_ALREADY_SETTLED'].includes(
          (payResult.reason as AppError)?.code,
        );
      const closeFailed =
        closeResult.status === 'rejected' &&
        ['SCHEME_SETTLEMENT_IN_PROGRESS', 'SCHEME_SETTLEMENT_BLOCKED_PENDING_PAYMENT'].includes(
          (closeResult.reason as AppError)?.code,
        );
      expect(payFailed || closeFailed || payResult.status === 'fulfilled').toBe(true);
      const stored = await SchemeEnrollment.findById(enrollment._id);
      if (stored?.status === 'CLOSED') {
        expect(
          await Payment.countDocuments({
            schemeId: enrollment._id,
            schemeMonth: 2,
            status: 'SUCCESS',
          }),
        ).toBe(0);
        expect(await Payout.countDocuments({ schemeId: enrollment._id, status: 'SUCCESS' })).toBe(
          1,
        );
      }
    });
  });

  describe('late PhonePe after closure', () => {
    it('moves late PhonePe success on a closed CASH enrollment to REVIEW_REQUIRED', async () => {
      await seedAdmin();
      const staff = await seedStaff(STAFF_PHONE, [...COLLECT_PERMISSIONS], 'NKS-S601');
      const plan = await seedCashPlan();
      const customer = await seedVerifiedCustomer({ phone: '+917182600113' });
      const enrollment = await enrollCustomer(
        String(customer._id),
        String(plan._id),
        monthStartIst(),
        'p6-pp-late',
      );
      await SystemSetting.create([{ singletonKey: 'GLOBAL', customerPhonePeEnabled: true }]);
      vi.spyOn(phonePeProvider, 'createPayment').mockImplementation(async (input: any) => ({
        providerOrderId: `ORD-${input.merchantOrderId}`,
        state: 'PENDING',
        redirectUrl: 'https://phonepe.test/checkout',
        expiresAt: new Date(Date.now() + 600_000),
      }));
      const launched = await initiateStaffPhonePe(
        String(staff.userId),
        {
          customerId: String(customer._id),
          schemeId: String(enrollment._id),
          amountPaise: MIN,
          idempotencyKey: 'p6-pp-late-0001',
        },
        'p6-pp-late',
        'http://localhost:5173',
      );
      await SchemeEnrollment.updateOne({ _id: enrollment._id }, { $set: { status: 'CLOSED' } });
      const intent = await PaymentIntent.findOne({
        merchantTransactionId: launched.merchantTransactionId,
      });

      const result = await reconcilePaymentIntentStatus(
        String(intent!._id),
        'WEBHOOK',
        'p6-pp-late-rec',
        { state: 'SUCCESS', amountPaise: MIN, transactionId: 'PP-P6-LATE', raw: {} },
      );
      expect(result.state).toBe('REVIEW_REQUIRED');
      expect((await PaymentIntent.findById(intent!._id))?.status).toBe('REVIEW_REQUIRED');
      expect(await Payment.countDocuments({ status: 'SUCCESS' })).toBe(0);
    });
  });

  describe('staff cannot settle', () => {
    it('forbids STAFF from owner-only payout and premature-close routes', async () => {
      await seedAdmin();
      await seedStaff(STAFF_PHONE, [...COLLECT_PERMISSIONS], 'NKS-S602');
      const plan = await seedCashPlan();
      const customer = await seedVerifiedCustomer({ phone: '+917182600114' });
      const enrollment = await enrollCustomer(
        String(customer._id),
        String(plan._id),
        monthStartIst(),
        'p6-staff-deny',
      );
      const issued = await login(STAFF_PHONE, STAFF_PASSWORD, { ip: '127.0.0.1' });

      const payout = await request(app)
        .post('/api/v1/admin/payouts')
        .set('Cookie', cookieHeader(issued.tokens.access))
        .send({
          customerId: String(customer._id),
          schemeId: String(enrollment._id),
          payoutDate: new Date().toISOString(),
          payoutType: 'PAYOUT',
        });
      expect(payout.status).toBe(403);
      expect(payout.body.error.code).toBe('PERMISSION_DENIED');

      const close = await request(app)
        .post(`/api/v1/admin/enrollments/${enrollment._id}/premature-close`)
        .set('Cookie', cookieHeader(issued.tokens.access))
        .send({
          settlementAsset: 'CASH',
          payoutDate: new Date().toISOString(),
          reason: 'Staff must not close',
          idempotencyKey: 'p6-staff-close-0001',
        });
      expect(close.status).toBe(403);
      expect(close.body.error.code).toBe('PERMISSION_DENIED');

      const missingStaffPayout = await request(app)
        .post('/api/v1/staff/payouts')
        .set('Cookie', cookieHeader(issued.tokens.access))
        .send({
          customerId: String(customer._id),
          schemeId: String(enrollment._id),
          payoutDate: new Date().toISOString(),
          payoutType: 'PAYOUT',
        });
      expect(missingStaffPayout.status).toBe(404);
    });
  });
});
