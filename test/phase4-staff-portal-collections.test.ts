import { addMonths, startOfMonth } from 'date-fns';
import { fromZonedTime, toZonedTime } from 'date-fns-tz';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { app } from '../src/app.js';
import {
  AuditLog,
  Customer,
  Payment,
  SchemeEnrollment,
  User,
} from '../src/models/index.js';
import { hashPassword, login } from '../src/services/auth.service.js';
import { createCustomer } from '../src/services/customer.service.js';
import { createManualPayment } from '../src/services/payment.service.js';
import {
  createEnrollment,
  createSchemePlan,
} from '../src/services/scheme-management.service.js';
import { createStaff, updateUserStatus } from '../src/services/staff.service.js';
import { BUSINESS_TZ } from '../src/utils/time.js';
import type { CreateStaffInput } from '../src/validators/staff.validators.js';
import { clearTestMongo, startTestMongo, stopTestMongo } from './helpers/mongo.js';

const ADMIN_PHONE = '+917181400001';
const ADMIN_PASSWORD = 'AdminPass123!';
const STAFF_PHONE = '+917181400002';
const OTHER_STAFF_PHONE = '+917181400003';
const VIEW_STAFF_PHONE = '+917181400004';
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

function ist(isoLocal: string) {
  return new Date(isoLocal);
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
      name: 'Phase4 Admin',
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
      name: `Phase4 Staff ${employeeCode}`,
      phone,
      password: STAFF_PASSWORD,
      employeeCode,
      permissions,
    },
    adminCtx(actorId, `p4-staff-${employeeCode}`),
  );
}

async function seedVerifiedCustomer(opts: { name?: string; phone: string }) {
  const admin = await User.findOne({ role: 'ADMIN' });
  const actorId = String(admin?._id ?? (await seedAdmin())._id);
  const created = await createCustomer(
    {
      name: opts.name ?? 'Phase4 Customer',
      phone: opts.phone,
      password: CUSTOMER_PASSWORD,
    },
    adminCtx(actorId, `p4-customer-${opts.phone}`),
  );
  await Customer.updateOne({ _id: created.customer._id }, { $set: { kycStatus: 'VERIFIED' } });
  return created.customer;
}

async function seedCashPlan() {
  const admin = await User.findOne({ role: 'ADMIN' });
  const actorId = String(admin?._id ?? (await seedAdmin())._id);
  return createSchemePlan(
    {
      name: 'Phase4 Cash',
      type: 'CASH',
      durationMonths: 11,
      minimumPaymentPaise: MIN,
      termsText: 'Eleven contribution months then settlement.',
    },
    adminCtx(actorId, 'p4-plan'),
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

describe('Phase 4 — staff portal collections', () => {
  beforeAll(async () => {
    await startTestMongo();
  }, 120_000);

  afterAll(async () => {
    await stopTestMongo();
  });

  beforeEach(async () => {
    await clearTestMongo();
  });

  it('lets permitted staff search a customer and denies staff without canViewCustomers', async () => {
    await seedAdmin();
    await seedStaff(STAFF_PHONE, [...COLLECT_PERMISSIONS], 'NKS-S401');
    await seedStaff(VIEW_STAFF_PHONE, ['canCollectPayment'], 'NKS-S402');
    const customer = await seedVerifiedCustomer({ name: 'Meera Nair', phone: '+917181400101' });
    const allowed = await login(STAFF_PHONE, STAFF_PASSWORD, { ip: '127.0.0.1' });
    const denied = await login(VIEW_STAFF_PHONE, STAFF_PASSWORD, { ip: '127.0.0.1' });

    const found = await request(app)
      .get('/api/v1/staff/customers')
      .query({ search: 'Meera' })
      .set('Cookie', cookieHeader(allowed.tokens.access))
      .expect(200);
    expect(found.body.data).toHaveLength(1);
    expect(found.body.data[0].customerCode).toBe(customer.customerCode);
    expect(JSON.stringify(found.body)).not.toMatch(/passwordHash/i);
    expect(JSON.stringify(found.body)).not.toMatch(/aadhaar/i);

    const blocked = await request(app)
      .get('/api/v1/staff/customers')
      .query({ search: 'Meera' })
      .set('Cookie', cookieHeader(denied.tokens.access));
    expect(blocked.status).toBe(403);
    expect(blocked.body.error.code).toBe('PERMISSION_DENIED');
  });

  it('returns operational collection fields without Aadhaar or auth hashes', async () => {
    await seedAdmin();
    await seedStaff(STAFF_PHONE, [...COLLECT_PERMISSIONS], 'NKS-S403');
    const plan = await seedCashPlan();
    const customer = await seedVerifiedCustomer({ phone: '+917181400102' });
    const enrollment = await enrollCustomer(
      String(customer._id),
      String(plan._id),
      monthStartIst(),
      'p4-view',
    );
    const issued = await login(STAFF_PHONE, STAFF_PASSWORD, { ip: '127.0.0.1' });

    const view = await request(app)
      .get(`/api/v1/staff/customers/${customer._id}`)
      .set('Cookie', cookieHeader(issued.tokens.access))
      .expect(200);

    expect(view.body.data.profile.passbookNumber).toBe(customer.customerCode);
    expect(view.body.data.profile.phone).toBe('+917181400102');
    expect(String(view.body.data.activeEnrollment._id)).toBe(String(enrollment._id));
    expect(view.body.data.schemeSummary.enrollmentNumber).toBe(enrollment.enrollmentNumber);
    expect(view.body.data.contribution.schemeMonth).toBeGreaterThanOrEqual(1);
    expect(view.body.data.contribution.phase).toBe('FLEXIBLE');
    expect(view.body.data.contribution.totalContributedPaise).toBe(0);
    expect(view.body.data.customer.aadhaar).toBeUndefined();
    expect(JSON.stringify(view.body)).not.toMatch(/passwordHash/i);
  });

  it('lets staff preview a payment and ignores client-supplied month/cap on posting', async () => {
    await seedAdmin();
    await seedStaff(STAFF_PHONE, [...COLLECT_PERMISSIONS], 'NKS-S404');
    const plan = await seedCashPlan();
    const customer = await seedVerifiedCustomer({ phone: '+917181400103' });
    const start = monthStartIst();
    const enrollment = await enrollCustomer(String(customer._id), String(plan._id), start, 'p4-preview');
    const issued = await login(STAFF_PHONE, STAFF_PASSWORD, { ip: '127.0.0.1' });

    const preview = await request(app)
      .get(`/api/v1/staff/schemes/${enrollment._id}/payment-preview`)
      .query({ amountPaise: MIN })
      .set('Cookie', cookieHeader(issued.tokens.access))
      .expect(200);
    expect(preview.body.data.allowed).toBe(true);
    expect(preview.body.data.phase).toBe('FLEXIBLE');
    const serverMonth = preview.body.data.schemeMonth;

    const posted = await request(app)
      .post('/api/v1/staff/payments')
      .set('Cookie', cookieHeader(issued.tokens.access))
      .send({
        customerId: String(customer._id),
        schemeId: String(enrollment._id),
        amountPaise: MIN,
        method: 'CASH',
        paymentDate: new Date().toISOString(),
        idempotencyKey: 'preview-override-1',
        schemeMonth: 11,
        capPaise: 1,
      })
      .expect(201);

    expect(posted.body.data.schemeMonth).toBe(serverMonth);
    const stored = await Payment.findById(posted.body.data.paymentId);
    expect(stored?.schemeMonth).toBe(serverMonth);
    expect(stored?.amountPaise).toBe(MIN);
  });

  it('posts manual CASH, UPI, BANK and CARD collections with STAFF collector attribution', async () => {
    await seedAdmin();
    const staff = await seedStaff(STAFF_PHONE, [...COLLECT_PERMISSIONS], 'NKS-S405');
    const plan = await seedCashPlan();
    const customer = await seedVerifiedCustomer({ phone: '+917181400104' });
    const enrollment = await enrollCustomer(
      String(customer._id),
      String(plan._id),
      monthStartIst(),
      'p4-methods',
    );
    const issued = await login(STAFF_PHONE, STAFF_PASSWORD, { ip: '127.0.0.1' });
    const methods = ['CASH', 'UPI', 'BANK', 'CARD'] as const;

    for (const method of methods) {
      const posted = await request(app)
        .post('/api/v1/staff/payments')
        .set('Cookie', cookieHeader(issued.tokens.access))
        .send({
          customerId: String(customer._id),
          schemeId: String(enrollment._id),
          amountPaise: MIN,
          method,
          paymentDate: new Date().toISOString(),
          referenceNumber: method === 'UPI' ? 'UPI-REF-1' : undefined,
          notes: `staff ${method}`,
          idempotencyKey: `staff-method-${method}-1`,
        })
        .expect(201);
      expect(posted.body.data.status).toBe('SUCCESS');
      expect(posted.body.data.method).toBe(method);
      expect(posted.body.data.receiptNumber).toMatch(/^NKS-/);
    }

    const payments = await Payment.find({ schemeId: enrollment._id, status: 'SUCCESS' }).sort({
      createdAt: 1,
    });
    expect(payments).toHaveLength(4);
    expect(payments.every((row) => String(row.collectedBy) === String(staff.userId))).toBe(true);
    expect(payments.every((row) => row.collectorRole === 'STAFF')).toBe(true);
    expect(new Set(payments.map((row) => row.method))).toEqual(new Set(methods));

    const enrollmentAfter = await SchemeEnrollment.findById(enrollment._id);
    expect(enrollmentAfter?.totalPaidPaise).toBe(MIN * 4);
    expect(await Payment.countDocuments({ schemeId: enrollment._id, status: 'SUCCESS' })).toBe(4);

    const audits = await AuditLog.find({ action: 'PAYMENT_CREATED', actorRole: 'STAFF' });
    expect(audits).toHaveLength(4);
    expect(audits.every((row) => String(row.actorId) === String(staff.userId))).toBe(true);
  });

  it('rejects a payment below the minimum installment', async () => {
    await seedAdmin();
    await seedStaff(STAFF_PHONE, [...COLLECT_PERMISSIONS], 'NKS-S406');
    const plan = await seedCashPlan();
    const customer = await seedVerifiedCustomer({ phone: '+917181400105' });
    const enrollment = await enrollCustomer(
      String(customer._id),
      String(plan._id),
      monthStartIst(),
      'p4-min',
    );
    const issued = await login(STAFF_PHONE, STAFF_PASSWORD, { ip: '127.0.0.1' });

    const rejected = await request(app)
      .post('/api/v1/staff/payments')
      .set('Cookie', cookieHeader(issued.tokens.access))
      .send({
        customerId: String(customer._id),
        schemeId: String(enrollment._id),
        amountPaise: 50_000,
        method: 'CASH',
        paymentDate: new Date().toISOString(),
        idempotencyKey: 'staff-below-min-1',
      });
    expect(rejected.status).toBe(422);
    expect(rejected.body.error.code).toBe('PAYMENT_BELOW_MINIMUM');
    expect(await Payment.countDocuments()).toBe(0);
  });

  it('rejects a capped-month overage and accepts the exact remaining cap', async () => {
    await seedAdmin();
    await seedStaff(STAFF_PHONE, [...COLLECT_PERMISSIONS], 'NKS-S407');
    const plan = await seedCashPlan();
    const customer = await seedVerifiedCustomer({ phone: '+917181400106' });
    const start = ist('2026-01-01T00:00:00+05:30');
    const enrollment = await enrollCustomer(String(customer._id), String(plan._id), start, 'p4-cap');
    const issued = await login(STAFF_PHONE, STAFF_PASSWORD, { ip: '127.0.0.1' });

    await request(app)
      .post('/api/v1/staff/payments')
      .set('Cookie', cookieHeader(issued.tokens.access))
      .send({
        customerId: String(customer._id),
        schemeId: String(enrollment._id),
        amountPaise: MIN,
        method: 'CASH',
        paymentDate: monthDate(start, 0).toISOString(),
        idempotencyKey: 'staff-cap-first-1',
      })
      .expect(201);

    const over = await request(app)
      .post('/api/v1/staff/payments')
      .set('Cookie', cookieHeader(issued.tokens.access))
      .send({
        customerId: String(customer._id),
        schemeId: String(enrollment._id),
        amountPaise: MIN + 1,
        method: 'CASH',
        paymentDate: monthDate(start, 6).toISOString(),
        idempotencyKey: 'staff-cap-over-1',
      });
    expect(over.status).toBe(409);
    expect(over.body.error.code).toBe('PAYMENT_LIMIT_EXCEEDED');

    const exact = await request(app)
      .post('/api/v1/staff/payments')
      .set('Cookie', cookieHeader(issued.tokens.access))
      .send({
        customerId: String(customer._id),
        schemeId: String(enrollment._id),
        amountPaise: MIN,
        method: 'CASH',
        paymentDate: monthDate(start, 6).toISOString(),
        idempotencyKey: 'staff-cap-exact-1',
      })
      .expect(201);
    expect(exact.body.data.schemeMonth).toBe(7);
    expect(await Payment.countDocuments({ schemeId: enrollment._id, status: 'SUCCESS' })).toBe(2);
  });

  it('returns the original receipt for a duplicate staff idempotency key', async () => {
    await seedAdmin();
    await seedStaff(STAFF_PHONE, [...COLLECT_PERMISSIONS], 'NKS-S408');
    const plan = await seedCashPlan();
    const customer = await seedVerifiedCustomer({ phone: '+917181400107' });
    const enrollment = await enrollCustomer(
      String(customer._id),
      String(plan._id),
      monthStartIst(),
      'p4-idem',
    );
    const issued = await login(STAFF_PHONE, STAFF_PASSWORD, { ip: '127.0.0.1' });
    const payload = {
      customerId: String(customer._id),
      schemeId: String(enrollment._id),
      amountPaise: MIN,
      method: 'CASH' as const,
      paymentDate: new Date().toISOString(),
      idempotencyKey: 'staff-idempotent-key-1',
    };

    const first = await request(app)
      .post('/api/v1/staff/payments')
      .set('Cookie', cookieHeader(issued.tokens.access))
      .send(payload)
      .expect(201);
    const second = await request(app)
      .post('/api/v1/staff/payments')
      .set('Cookie', cookieHeader(issued.tokens.access))
      .send(payload)
      .expect(201);

    expect(String(second.body.data.paymentId)).toBe(String(first.body.data.paymentId));
    expect(second.body.data.receiptNumber).toBe(first.body.data.receiptNumber);
    expect(await Payment.countDocuments({ schemeId: enrollment._id })).toBe(1);
    const enrollmentAfter = await SchemeEnrollment.findById(enrollment._id);
    expect(enrollmentAfter?.totalPaidPaise).toBe(MIN);
  });

  it('rejects cross-customer scheme tampering', async () => {
    await seedAdmin();
    await seedStaff(STAFF_PHONE, [...COLLECT_PERMISSIONS], 'NKS-S409');
    const plan = await seedCashPlan();
    const owner = await seedVerifiedCustomer({ phone: '+917181400108' });
    const other = await seedVerifiedCustomer({ phone: '+917181400109' });
    const enrollment = await enrollCustomer(
      String(owner._id),
      String(plan._id),
      monthStartIst(),
      'p4-owner',
    );
    const issued = await login(STAFF_PHONE, STAFF_PASSWORD, { ip: '127.0.0.1' });

    const tampered = await request(app)
      .post('/api/v1/staff/payments')
      .set('Cookie', cookieHeader(issued.tokens.access))
      .send({
        customerId: String(other._id),
        schemeId: String(enrollment._id),
        amountPaise: MIN,
        method: 'CASH',
        paymentDate: new Date().toISOString(),
        idempotencyKey: 'staff-tamper-1',
      });
    expect(tampered.status).toBe(403);
    expect(tampered.body.error.code).toBe('SCHEME_OWNERSHIP_MISMATCH');
    expect(await Payment.countDocuments()).toBe(0);
  });

  it('rejects disabled staff and staff without canCollectPayment', async () => {
    await seedAdmin();
    const staff = await seedStaff(STAFF_PHONE, [...COLLECT_PERMISSIONS], 'NKS-S410');
    await seedStaff(VIEW_STAFF_PHONE, ['canViewCustomers'], 'NKS-S411');
    const plan = await seedCashPlan();
    const customer = await seedVerifiedCustomer({ phone: '+917181400110' });
    const enrollment = await enrollCustomer(
      String(customer._id),
      String(plan._id),
      monthStartIst(),
      'p4-deny',
    );
    const collector = await login(STAFF_PHONE, STAFF_PASSWORD, { ip: '127.0.0.1' });
    const viewer = await login(VIEW_STAFF_PHONE, STAFF_PASSWORD, { ip: '127.0.0.1' });
    const payload = {
      customerId: String(customer._id),
      schemeId: String(enrollment._id),
      amountPaise: MIN,
      method: 'CASH',
      paymentDate: new Date().toISOString(),
      idempotencyKey: 'staff-denied-1',
    };

    const noPermission = await request(app)
      .post('/api/v1/staff/payments')
      .set('Cookie', cookieHeader(viewer.tokens.access))
      .send(payload);
    expect(noPermission.status).toBe(403);

    const admin = await User.findOne({ role: 'ADMIN' });
    await updateUserStatus(String(staff.userId), 'INACTIVE', adminCtx(String(admin!._id), 'p4-off'));
    const disabled = await request(app)
      .post('/api/v1/staff/payments')
      .set('Cookie', cookieHeader(collector.tokens.access))
      .send({ ...payload, idempotencyKey: 'staff-disabled-1' });
    expect(disabled.status).toBe(401);
    expect(disabled.body.error.code).toBe('SESSION_EXPIRED');
  });

  it('isolates receipts to the collecting staff while customer and admin can still read them', async () => {
    await seedAdmin();
    await seedStaff(STAFF_PHONE, [...COLLECT_PERMISSIONS], 'NKS-S412');
    await seedStaff(OTHER_STAFF_PHONE, [...COLLECT_PERMISSIONS], 'NKS-S413');
    const plan = await seedCashPlan();
    const customer = await seedVerifiedCustomer({ phone: '+917181400111' });
    const enrollment = await enrollCustomer(
      String(customer._id),
      String(plan._id),
      monthStartIst(),
      'p4-receipt',
    );
    const collector = await login(STAFF_PHONE, STAFF_PASSWORD, { ip: '127.0.0.1' });
    const other = await login(OTHER_STAFF_PHONE, STAFF_PASSWORD, { ip: '127.0.0.1' });
    const adminIssued = await login(ADMIN_PHONE, ADMIN_PASSWORD, { ip: '127.0.0.1' });
    const customerIssued = await login('+917181400111', CUSTOMER_PASSWORD, { ip: '127.0.0.1' });

    const posted = await request(app)
      .post('/api/v1/staff/payments')
      .set('Cookie', cookieHeader(collector.tokens.access))
      .send({
        customerId: String(customer._id),
        schemeId: String(enrollment._id),
        amountPaise: MIN,
        method: 'CASH',
        paymentDate: new Date().toISOString(),
        idempotencyKey: 'staff-receipt-1',
      })
      .expect(201);
    const paymentId = posted.body.data.paymentId;

    await request(app)
      .get(`/api/v1/staff/payments/${paymentId}/receipt`)
      .set('Cookie', cookieHeader(collector.tokens.access))
      .expect(200);

    const isolated = await request(app)
      .get(`/api/v1/staff/payments/${paymentId}/receipt`)
      .set('Cookie', cookieHeader(other.tokens.access));
    expect(isolated.status).toBe(404);
    expect(isolated.body.error.code).toBe('RECEIPT_NOT_FOUND');

    await request(app)
      .get(`/api/v1/customer/payments/${paymentId}/receipt`)
      .set('Cookie', cookieHeader(customerIssued.tokens.access))
      .expect(200);
    await request(app)
      .get(`/api/v1/admin/payments/${paymentId}`)
      .set('Cookie', cookieHeader(adminIssued.tokens.access))
      .expect(200);
  });

  it('shows today staff collections on the dashboard, including method breakdown', async () => {
    await seedAdmin();
    await seedStaff(STAFF_PHONE, [...COLLECT_PERMISSIONS], 'NKS-S414');
    const plan = await seedCashPlan();
    const customer = await seedVerifiedCustomer({ phone: '+917181400112' });
    const enrollment = await enrollCustomer(
      String(customer._id),
      String(plan._id),
      monthStartIst(),
      'p4-dash',
    );
    const issued = await login(STAFF_PHONE, STAFF_PASSWORD, { ip: '127.0.0.1' });
    await request(app)
      .post('/api/v1/staff/payments')
      .set('Cookie', cookieHeader(issued.tokens.access))
      .send({
        customerId: String(customer._id),
        schemeId: String(enrollment._id),
        amountPaise: MIN,
        method: 'CASH',
        paymentDate: new Date().toISOString(),
        idempotencyKey: 'staff-dash-cash-1',
      })
      .expect(201);
    await request(app)
      .post('/api/v1/staff/payments')
      .set('Cookie', cookieHeader(issued.tokens.access))
      .send({
        customerId: String(customer._id),
        schemeId: String(enrollment._id),
        amountPaise: MIN,
        method: 'UPI',
        paymentDate: new Date().toISOString(),
        idempotencyKey: 'staff-dash-upi-1',
      })
      .expect(201);

    const dashboard = await request(app)
      .get('/api/v1/staff/dashboard')
      .set('Cookie', cookieHeader(issued.tokens.access))
      .expect(200);

    expect(dashboard.body.data.todayPaymentCount).toBe(2);
    expect(dashboard.body.data.todayCollectionPaise).toBe(MIN * 2);
    expect(dashboard.body.data.customersServedToday).toBe(1);
    const cash = dashboard.body.data.todayByMethod.find((row: { method: string }) => row.method === 'CASH');
    const upi = dashboard.body.data.todayByMethod.find((row: { method: string }) => row.method === 'UPI');
    expect(cash).toMatchObject({ method: 'CASH', totalPaise: MIN, count: 1 });
    expect(upi).toMatchObject({ method: 'UPI', totalPaise: MIN, count: 1 });
    expect(dashboard.body.data.recentPayments).toHaveLength(2);
    expect(dashboard.body.data.recentPayments.every((row: { status: string }) => row.status === 'SUCCESS')).toBe(
      true,
    );
  });

  it('does not let concurrent staff payments jointly breach the cap', async () => {
    await seedAdmin();
    const staff = await seedStaff(STAFF_PHONE, [...COLLECT_PERMISSIONS], 'NKS-S415');
    const plan = await seedCashPlan();
    const customer = await seedVerifiedCustomer({ phone: '+917181400113' });
    const start = ist('2026-01-01T00:00:00+05:30');
    const enrollment = await enrollCustomer(
      String(customer._id),
      String(plan._id),
      start,
      'p4-race-enroll',
    );
    const ctx = {
      actorId: String(staff.userId),
      actorRole: 'STAFF' as const,
      requestId: 'p4-race-seed',
    };
    await createManualPayment(
      {
        customerId: String(customer._id),
        schemeId: String(enrollment._id),
        amountPaise: MIN,
        method: 'CASH',
        paymentDate: monthDate(start, 0),
        idempotencyKey: 'staff-race-first',
      },
      ctx,
    );

    const month7 = monthDate(start, 6);
    const settled = await Promise.allSettled([
      createManualPayment(
        {
          customerId: String(customer._id),
          schemeId: String(enrollment._id),
          amountPaise: MIN,
          method: 'CASH',
          paymentDate: month7,
          idempotencyKey: 'staff-race-a',
        },
        { ...ctx, requestId: 'p4-race-a' },
      ),
      createManualPayment(
        {
          customerId: String(customer._id),
          schemeId: String(enrollment._id),
          amountPaise: MIN,
          method: 'CASH',
          paymentDate: month7,
          idempotencyKey: 'staff-race-b',
        },
        { ...ctx, requestId: 'p4-race-b' },
      ),
    ]);
    const ok = settled.filter((row) => row.status === 'fulfilled');
    const failed = settled.filter((row) => row.status === 'rejected');
    expect(ok).toHaveLength(1);
    expect(failed).toHaveLength(1);
    expect((failed[0] as PromiseRejectedResult).reason).toMatchObject({
      code: 'PAYMENT_LIMIT_EXCEEDED',
    });
    expect(await Payment.countDocuments({ schemeId: enrollment._id, status: 'SUCCESS', schemeMonth: 7 })).toBe(
      1,
    );
  });
});
