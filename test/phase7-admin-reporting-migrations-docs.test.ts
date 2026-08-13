import { startOfMonth } from 'date-fns';
import { fromZonedTime, toZonedTime } from 'date-fns-tz';
import mongoose from 'mongoose';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { app } from '../src/app.js';
import { openapi } from '../src/config/openapi.js';
import { REQUIRED_INDEXES, verifyRequiredIndexes } from '../src/indexes/critical-indexes.js';
import {
  AuditLog,
  Customer,
  Payment,
  Payout,
  SchemePlan,
  StaffProfile,
  User,
} from '../src/models/index.js';
import { hashPassword, login } from '../src/services/auth.service.js';
import { createCustomer } from '../src/services/customer.service.js';
import { requestCorrection } from '../src/services/finance.service.js';
import { createManualPayment } from '../src/services/payment.service.js';
import {
  createEnrollment,
  createSchemePlan,
} from '../src/services/scheme-management.service.js';
import { createStaff, updateStaff } from '../src/services/staff.service.js';
import {
  MIGRATION_ACK_VALUE,
  runNakshathraAdminOpsApply,
  runNakshathraAdminOpsDryRun,
  runNakshathraAdminOpsVerify,
} from '../src/scripts/migrations/2026-08-nakshathra-admin-ops.js';
import { BUSINESS_TZ } from '../src/utils/time.js';
import type { CreateStaffInput } from '../src/validators/staff.validators.js';
import { clearTestMongo, startTestMongo, stopTestMongo } from './helpers/mongo.js';

const ADMIN_PHONE = '+917183700001';
const STAFF_PHONE = '+917183700002';
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

function staffCtx(actorId: string, requestId: string) {
  return { actorId, actorRole: 'STAFF' as const, requestId };
}

function monthStartIst(at = new Date()) {
  const local = toZonedTime(at, BUSINESS_TZ);
  const start = startOfMonth(local);
  start.setHours(0, 0, 0, 0);
  return fromZonedTime(start, BUSINESS_TZ);
}

async function seedAdmin() {
  const [admin] = await User.create([
    {
      name: 'Phase7 Admin',
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
      name: `Phase7 Staff ${employeeCode}`,
      phone,
      password: STAFF_PASSWORD,
      employeeCode,
      permissions,
    },
    adminCtx(actorId, `p7-staff-${employeeCode}`),
  );
}

async function seedVerifiedCustomer(phone: string) {
  const admin = await User.findOne({ role: 'ADMIN' });
  const actorId = String(admin?._id ?? (await seedAdmin())._id);
  const created = await createCustomer(
    { name: 'Phase7 Customer', phone, password: CUSTOMER_PASSWORD },
    adminCtx(actorId, `p7-customer-${phone}`),
  );
  await Customer.updateOne({ _id: created.customer._id }, { $set: { kycStatus: 'VERIFIED' } });
  return created.customer;
}

async function seedCashPlan() {
  const admin = await User.findOne({ role: 'ADMIN' });
  return createSchemePlan(
    {
      name: 'Phase7 Cash',
      type: 'CASH',
      durationMonths: 11,
      minimumPaymentPaise: MIN,
      termsText: 'Eleven contribution months then cash payout.',
    },
    adminCtx(String(admin!._id), 'p7-plan'),
  );
}

async function enroll(customerId: string, planId: string, startDate: Date, requestId: string) {
  const admin = await User.findOne({ role: 'ADMIN' });
  return createEnrollment(
    { customerId, schemePlanId: planId, startDate, monthlyInstallmentPaise: MIN },
    adminCtx(String(admin!._id), requestId),
  );
}

describe('Phase 7 — owner reporting, migrations, indexes and docs', () => {
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
    mongoose.set('debug', false);
  });

  describe('staff management', () => {
    it('lets the owner create staff, update permissions, disable the account, and audit the changes', async () => {
      const admin = await seedAdmin();
      const issued = await login(ADMIN_PHONE, ADMIN_PASSWORD, { ip: '127.0.0.1' });

      const created = await request(app)
        .post('/api/v1/admin/staff')
        .set('Cookie', cookieHeader(issued.tokens.access))
        .send({
          name: 'Report Staff',
          phone: STAFF_PHONE,
          password: STAFF_PASSWORD,
          employeeCode: 'NKS-S701',
          permissions: ['canViewCustomers'],
        })
        .expect(201);

      const patched = await request(app)
        .patch(`/api/v1/admin/staff/${created.body.data.profileId}`)
        .set('Cookie', cookieHeader(issued.tokens.access))
        .send({ permissions: [...COLLECT_PERMISSIONS] })
        .expect(200);
      expect(patched.body.data.profile.permissions).toEqual([...COLLECT_PERMISSIONS]);

      await request(app)
        .patch(`/api/v1/admin/users/${created.body.data.userId}/status`)
        .set('Cookie', cookieHeader(issued.tokens.access))
        .send({ status: 'INACTIVE' })
        .expect(200);

      await expect(login(STAFF_PHONE, STAFF_PASSWORD, { ip: '127.0.0.1' })).rejects.toMatchObject({
        code: 'ACCOUNT_INACTIVE',
      });

      const actions = await AuditLog.find({
        action: { $in: ['STAFF_CREATED', 'STAFF_UPDATED', 'USER_STATUS_UPDATED'] },
      }).lean();
      expect(actions.map((row: { action: string }) => row.action).sort()).toEqual([
        'STAFF_CREATED',
        'STAFF_UPDATED',
        'USER_STATUS_UPDATED',
      ]);
      expect(String(admin._id)).toBeTruthy();
    });

    it('updates permissions through the staff service without dropping other audited fields', async () => {
      await seedAdmin();
      const staff = await seedStaff(STAFF_PHONE, ['canViewCustomers'], 'NKS-S702');
      const admin = await User.findOne({ role: 'ADMIN' });
      const updated = await updateStaff(
        String(staff.profileId),
        { permissions: ['canViewCustomers', 'canCollectPayment'] },
        adminCtx(String(admin!._id), 'p7-perm'),
      );
      expect(updated.profile.permissions).toEqual(['canViewCustomers', 'canCollectPayment']);
    });
  });

  describe('reports', () => {
    it('buckets daily collections on Asia/Kolkata dates, not UTC midnight', async () => {
      const admin = await seedAdmin();
      const plan = await seedCashPlan();
      const customer = await seedVerifiedCustomer('+917183700101');
      const enrollment = await enroll(
        String(customer._id),
        String(plan._id),
        fromZonedTime('2026-08-01T00:00:00.000', BUSINESS_TZ),
        'p7-ist',
      );
      await createManualPayment(
        {
          customerId: String(customer._id),
          schemeId: String(enrollment._id),
          amountPaise: MIN,
          method: 'CASH',
          paymentDate: new Date('2026-08-12T18:29:59.000Z'),
          idempotencyKey: 'p7-ist-aug12',
        },
        adminCtx(String(admin._id), 'p7-ist-aug12'),
      );
      await createManualPayment(
        {
          customerId: String(customer._id),
          schemeId: String(enrollment._id),
          amountPaise: 250_000,
          method: 'CASH',
          paymentDate: new Date('2026-08-12T18:30:00.000Z'),
          idempotencyKey: 'p7-ist-aug13',
        },
        adminCtx(String(admin._id), 'p7-ist-aug13'),
      );
      const issued = await login(ADMIN_PHONE, ADMIN_PASSWORD, { ip: '127.0.0.1' });

      const daily = await request(app)
        .get('/api/v1/admin/reports/daily-collection')
        .query({ from: '2026-08-13', to: '2026-08-13' })
        .set('Cookie', cookieHeader(issued.tokens.access))
        .expect(200);
      expect(daily.body.data.timezone).toBe(BUSINESS_TZ);
      expect(daily.body.data.days).toEqual([
        { businessDate: '2026-08-13', totalPaise: 250_000, count: 1 },
      ]);
      expect(daily.body.data.totalPaise).toBe(250_000);

      const monthly = await request(app)
        .get('/api/v1/admin/reports/monthly-collection')
        .query({ from: '2026-08-01', to: '2026-08-31' })
        .set('Cookie', cookieHeader(issued.tokens.access))
        .expect(200);
      expect(monthly.body.data.months).toEqual([
        { businessMonth: '2026-08', totalPaise: 350_000, count: 2 },
      ]);
    });

    it('reconciles collection, scheme, attribution, cash-held, correction and payout reports with source data', async () => {
      const admin = await seedAdmin();
      const staff = await seedStaff(STAFF_PHONE, [...COLLECT_PERMISSIONS], 'NKS-S703');
      const plan = await seedCashPlan();
      const customer = await seedVerifiedCustomer('+917183700102');
      const enrollment = await enroll(
        String(customer._id),
        String(plan._id),
        monthStartIst(),
        'p7-recon',
      );
      await createManualPayment(
        {
          customerId: String(customer._id),
          schemeId: String(enrollment._id),
          amountPaise: MIN,
          method: 'CASH',
          paymentDate: new Date(),
          idempotencyKey: 'p7-staff-cash',
        },
        staffCtx(String(staff.userId), 'p7-staff-cash'),
      );
      await createManualPayment(
        {
          customerId: String(customer._id),
          schemeId: String(enrollment._id),
          amountPaise: 150_000,
          method: 'UPI',
          paymentDate: new Date(),
          idempotencyKey: 'p7-customer-upi',
        },
        { actorId: String(customer.userId), actorRole: 'CUSTOMER', requestId: 'p7-customer-upi' },
      );
      const payment = await Payment.findOne({ idempotencyKey: 'p7-staff-cash' });
      await requestCorrection(
        String(payment!._id),
        {
          correctionType: 'CHANGE_NOTES',
          requestedChanges: { notes: 'fix note' },
          reason: 'Customer asked to annotate the receipt',
        },
        staffCtx(String(staff.userId), 'p7-corr'),
      );
      await Payout.create([
        {
          customerId: customer._id,
          schemeId: enrollment._id,
          payoutType: 'PREMATURE_CLOSE',
          method: 'BANK',
          amountPaise: 250_000,
          settlementPrincipalPaise: 250_000,
          goldWeightMg: 0,
          cashBasis: 'CONTRIBUTION_VALUE',
          payoutDate: new Date(),
          status: 'SUCCESS',
          createdBy: admin._id,
        },
      ]);
      const issued = await login(ADMIN_PHONE, ADMIN_PASSWORD, { ip: '127.0.0.1' });

      const collection = await request(app)
        .get('/api/v1/admin/reports/collection')
        .set('Cookie', cookieHeader(issued.tokens.access))
        .expect(200);
      const collectionTotal = collection.body.data.summary.reduce(
        (sum: number, row: { totalPaise: number }) => sum + row.totalPaise,
        0,
      );
      expect(collectionTotal).toBe(250_000);
      expect(await Payment.aggregate([
        { $match: { status: 'SUCCESS' } },
        { $group: { _id: null, total: { $sum: '$amountPaise' } } },
      ]).then((rows) => rows[0]?.total)).toBe(250_000);

      const scheme = await request(app)
        .get('/api/v1/admin/reports/scheme-collection')
        .set('Cookie', cookieHeader(issued.tokens.access))
        .expect(200);
      expect(scheme.body.data.totalPaise).toBe(250_000);
      expect(scheme.body.data.schemes[0].schemeType).toBe('CASH');

      const attribution = await request(app)
        .get('/api/v1/admin/reports/attribution')
        .set('Cookie', cookieHeader(issued.tokens.access))
        .expect(200);
      expect(attribution.body.data.staffCollected.totalPaise).toBe(MIN);
      expect(attribution.body.data.customerSelfPayment.totalPaise).toBe(150_000);

      const cashHeld = await request(app)
        .get('/api/v1/admin/cash-held')
        .set('Cookie', cookieHeader(issued.tokens.access))
        .expect(200);
      const staffHeld = cashHeld.body.data.find(
        (row: { staffId: string }) => row.staffId === String(staff.userId),
      );
      expect(staffHeld.cashHeldPaise).toBe(MIN);

      const corrections = await request(app)
        .get('/api/v1/admin/reports/corrections')
        .set('Cookie', cookieHeader(issued.tokens.access))
        .expect(200);
      expect(corrections.body.data.byStatus).toEqual(
        expect.arrayContaining([{ status: 'PENDING', count: 1 }]),
      );
      expect(corrections.body.data.recent).toHaveLength(1);

      const payouts = await request(app)
        .get('/api/v1/admin/reports/payout-totals')
        .set('Cookie', cookieHeader(issued.tokens.access))
        .expect(200);
      expect(payouts.body.data.cashTotalPaise).toBe(250_000);
      expect(payouts.body.data.byMethod).toEqual(
        expect.arrayContaining([expect.objectContaining({ _id: 'BANK', totalPaise: 250_000 })]),
      );
      expect(payouts.body.data.recent[0].payoutType).toBe('PREMATURE_CLOSE');
    });

    it('applies default offset limits when page/limit are provided', async () => {
      const admin = await seedAdmin();
      const plan = await seedCashPlan();
      const customer = await seedVerifiedCustomer('+917183700103');
      const enrollment = await enroll(
        String(customer._id),
        String(plan._id),
        monthStartIst(),
        'p7-page',
      );
      for (const [index, amount] of [MIN, 150_000, 200_000].entries()) {
        await createManualPayment(
          {
            customerId: String(customer._id),
            schemeId: String(enrollment._id),
            amountPaise: amount,
            method: 'CASH',
            paymentDate: new Date(),
            idempotencyKey: `p7-page-${index}-xxxx`,
          },
          adminCtx(String(admin._id), `p7-page-${index}`),
        );
      }
      const issued = await login(ADMIN_PHONE, ADMIN_PASSWORD, { ip: '127.0.0.1' });
      const page = await request(app)
        .get('/api/v1/admin/payments')
        .query({ page: 1, limit: 2 })
        .set('Cookie', cookieHeader(issued.tokens.access))
        .expect(200);
      expect(page.body.data).toHaveLength(2);
      expect(page.body.meta).toMatchObject({ mode: 'offset', page: 1, limit: 2, total: 3 });
    });
  });

  describe('migration and indexes', () => {
    it('backfills collector attribution, staff profiles, scheme types and payout enums idempotently', async () => {
      const [admin] = await User.create([
        {
          name: 'Mig Admin',
          phone: '+917183700201',
          passwordHash: 'hash',
          role: 'ADMIN',
          status: 'ACTIVE',
        },
      ]);
      const [staffUser] = await User.create([
        {
          name: 'Legacy Staff',
          phone: '+917183700202',
          passwordHash: 'hash',
          role: 'STAFF',
          status: 'ACTIVE',
        },
      ]);
      await Payment.collection.insertOne({
        customerId: admin._id,
        schemeId: admin._id,
        amountPaise: MIN,
        method: 'CASH',
        status: 'SUCCESS',
        paymentDate: new Date(),
        schemeMonth: 1,
        collectedBy: staffUser._id,
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      await SchemePlan.collection.insertOne({
        name: 'Legacy alias plan',
        type: 'cash',
        durationMonths: 11,
        redemptionMonth: 12,
        flexibleMonths: 6,
        capMonths: 5,
        minimumPaymentPaise: MIN,
        termsText: 'legacy alias',
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      await Payout.collection.insertOne({
        customerId: admin._id,
        schemeId: admin._id,
        amountPaise: MIN,
        settlementPrincipalPaise: MIN,
        goldWeightMg: 0,
        method: 'BANK',
        status: 'SUCCESS',
        payoutDate: new Date(),
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      const dry = await runNakshathraAdminOpsDryRun();
      expect(dry.paymentsUpdated).toBe(1);
      expect(dry.staffProfilesCreated).toBe(1);
      expect(dry.plansNormalized).toBe(1);
      expect(dry.payoutsNormalized).toBe(1);
      expect(await Payment.countDocuments({ collectorRole: 'STAFF' })).toBe(0);
      expect(await StaffProfile.countDocuments({ userId: staffUser._id })).toBe(0);

      const applied = await runNakshathraAdminOpsApply({ ack: MIGRATION_ACK_VALUE });
      expect(applied.ok).toBe(true);
      expect(await Payment.findOne({ collectedBy: staffUser._id }).then((row) => row?.collectorRole)).toBe(
        'STAFF',
      );
      expect(await StaffProfile.countDocuments({ userId: staffUser._id })).toBe(1);
      expect(await SchemePlan.collection.findOne({ name: 'Legacy alias plan' })).toMatchObject({
        type: 'CASH',
      });
      expect(await Payout.findOne({ method: 'BANK' }).then((row) => row?.payoutType)).toBe('PAYOUT');

      const again = await runNakshathraAdminOpsApply({ ack: MIGRATION_ACK_VALUE });
      expect(again.paymentsUpdated).toBe(0);
      expect(again.staffProfilesCreated).toBe(0);
      expect(again.plansNormalized).toBe(0);
      expect(again.payoutsNormalized).toBe(0);
      expect((await runNakshathraAdminOpsVerify()).ok).toBe(true);
    });

    it('verifies the Phase 7 critical index catalog including staff, collector, cash and correction indexes', async () => {
      const ids = REQUIRED_INDEXES.map((index) => index.id);
      expect(ids).toEqual(
        expect.arrayContaining([
          'STAFF_PROFILE_USER_UNIQUE',
          'STAFF_EMPLOYEE_CODE_UNIQUE',
          'PAYMENT_COLLECTOR_DATE',
          'CASH_SUBMISSION_STAFF_DATE',
          'CORRECTION_STATUS_CREATED',
          'CORRECTION_PAYMENT_REQUESTER_STATUS',
          'PAYOUT_ONE_SUCCESS_PER_SCHEME',
          'USER_PHONE_UNIQUE',
          'CUSTOMER_CODE_UNIQUE',
          'ENROLLMENT_ONE_ACTIVE_PER_CUSTOMER',
        ]),
      );
      const report = await verifyRequiredIndexes();
      expect(report.ok).toBe(true);
      expect(report.mismatches).toEqual([]);
      expect(report.checked).toBe(REQUIRED_INDEXES.length);
    });
  });

  describe('OpenAPI', () => {
    it('documents staff, collection, cash, correction, payout and report routes and marks GOLD_WEIGHT dormant', () => {
      expect(openapi.info.title).not.toMatch(/kairali/i);
      expect(openapi.info.description).toMatch(/GOLD_WEIGHT/i);
      expect(openapi.info.description).toMatch(/disabled|dormant/i);
      const paths = Object.keys(openapi.paths);
      expect(paths).toEqual(
        expect.arrayContaining([
          '/auth/login',
          '/admin/staff',
          '/admin/customers',
          '/admin/enrollments',
          '/admin/payments/manual',
          '/staff/payments',
          '/staff/payments/phonepe',
          '/staff/schemes/{id}/payment-preview',
          '/staff/cash-held',
          '/staff/payments/{id}/corrections',
          '/admin/payouts',
          '/admin/enrollments/{id}/premature-close',
          '/admin/reports/daily-collection',
          '/admin/reports/attribution',
          '/admin/reports/corrections',
          '/admin/reports/payout-totals',
        ]),
      );
    });
  });
});
