import { addMonths, startOfMonth } from 'date-fns';
import { fromZonedTime, toZonedTime } from 'date-fns-tz';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { app } from '../src/app.js';
import { Payment, User, Customer } from '../src/models/index.js';
import { hashPassword, login } from '../src/services/auth.service.js';
import { createCustomer } from '../src/services/customer.service.js';
import { createManualPayment } from '../src/services/payment.service.js';
import {
  createEnrollment,
  createSchemePlan,
  getEnrollmentDetails,
} from '../src/services/scheme-management.service.js';
import { financialDashboard } from '../src/services/report.service.js';
import { BUSINESS_TZ } from '../src/utils/time.js';
import { clearTestMongo, startTestMongo, stopTestMongo } from './helpers/mongo.js';

const ADMIN_PHONE = '+917181500001';
const ADMIN_PASSWORD = 'AdminPass123!';
const MIN = 100_000;

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

function monthDate(start: Date, monthOffset: number, day = 10) {
  const local = toZonedTime(start, BUSINESS_TZ);
  const shifted = addMonths(startOfMonth(local), monthOffset);
  shifted.setDate(day);
  shifted.setHours(12, 0, 0, 0);
  return fromZonedTime(shifted, BUSINESS_TZ);
}

async function seedAdmin() {
  const existing = await User.findOne({ phone: ADMIN_PHONE });
  if (existing) return existing;
  const [admin] = await User.create([
    {
      name: 'Admin Contribution Test',
      phone: ADMIN_PHONE,
      passwordHash: await hashPassword(ADMIN_PASSWORD),
      role: 'ADMIN',
      status: 'ACTIVE',
    },
  ]);
  return admin;
}

async function getAdmin() {
  const admin = await User.findOne({ phone: ADMIN_PHONE });
  if (!admin) throw new Error('Admin not seeded');
  return admin;
}

async function seedVerifiedCustomer(phone: string) {
  const admin = await User.findOne({ role: 'ADMIN' });
  const actorId = String(admin?._id ?? (await seedAdmin())._id);
  const created = await createCustomer(
    {
      name: 'Contribution Customer',
      phone,
      password: 'CustomerPass123!',
    },
    adminCtx(actorId, `admin-contrib-${phone}`),
  );
  await Customer.updateOne({ _id: created.customer._id }, { $set: { kycStatus: 'VERIFIED' } });
  return { customer: created.customer, actorId };
}

async function seedCashPlan(actorId: string) {
  return createSchemePlan(
    {
      name: 'Admin Contribution Cash',
      type: 'CASH',
      durationMonths: 11,
      minimumPaymentPaise: MIN,
      termsText: 'Eleven contribution months then settlement.',
    },
    adminCtx(actorId, 'admin-contrib-plan'),
  );
}

describe('admin contribution status APIs', () => {
  beforeAll(async () => {
    await startTestMongo();
  });

  afterAll(async () => {
    await stopTestMongo();
  });

  beforeEach(async () => {
    vi.useRealTimers();
    await clearTestMongo();
    await seedAdmin();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns contribution on admin enrollment, customer, preview, manual payment, and dashboard', async () => {
    const admin = await getAdmin();
    const actorId = String(admin._id);
    const { customer } = await seedVerifiedCustomer('+917181500101');
    const plan = await seedCashPlan(actorId);
    const start = monthStartIst();
    const enrollment = await createEnrollment(
      {
        customerId: String(customer._id),
        schemePlanId: String(plan._id),
        startDate: start,
        monthlyInstallmentPaise: MIN,
      },
      adminCtx(actorId, 'admin-contrib-enroll'),
    );
    const issued = await login(ADMIN_PHONE, ADMIN_PASSWORD, { ip: '127.0.0.1' });

    const enrollmentRes = await request(app)
      .get(`/api/v1/admin/enrollments/${enrollment._id}`)
      .set('Cookie', cookieHeader(issued.tokens.access))
      .expect(200);
    expect(enrollmentRes.body.data.contribution.phase).toBe('FLEXIBLE');
    expect(enrollmentRes.body.data.contribution.remainingCapPaise).toBeNull();

    const customerRes = await request(app)
      .get(`/api/v1/admin/customers/${customer._id}`)
      .set('Cookie', cookieHeader(issued.tokens.access))
      .expect(200);
    expect(customerRes.body.data.contribution.phase).toBe('FLEXIBLE');
    expect(customerRes.body.data.schemeSummary.enrollmentNumber).toBe(enrollment.enrollmentNumber);

    const activeEnrollmentRes = await request(app)
      .get(`/api/v1/admin/customers/${customer._id}/enrollment`)
      .set('Cookie', cookieHeader(issued.tokens.access))
      .expect(200);
    expect(activeEnrollmentRes.body.data.contribution.phase).toBe('FLEXIBLE');

    const preview = await request(app)
      .get(`/api/v1/admin/enrollments/${enrollment._id}/payment-preview`)
      .query({ amountPaise: MIN })
      .set('Cookie', cookieHeader(issued.tokens.access))
      .expect(200);
    expect(preview.body.data.allowed).toBe(true);
    expect(preview.body.data.paymentAllowed).toBe(true);
    expect(preview.body.data.phase).toBe('FLEXIBLE');

    const posted = await request(app)
      .post('/api/v1/admin/payments/manual')
      .set('Cookie', cookieHeader(issued.tokens.access))
      .send({
        customerId: String(customer._id),
        schemeId: String(enrollment._id),
        amountPaise: MIN,
        method: 'CASH',
        paymentDate: monthDate(start, 0, 5).toISOString(),
        idempotencyKey: 'admin-contrib-pay-1',
      })
      .expect(201);
    expect(posted.body.data.contribution.phase).toBe('FLEXIBLE');
    expect(posted.body.data.schemeMonth).toBe(1);

    const dashboard = await financialDashboard();
    expect(dashboard.contributionPhaseCounts.flexible).toBeGreaterThanOrEqual(1);
    expect(dashboard.contributionPhaseCounts.capped).toBeGreaterThanOrEqual(0);
  });

  it('returns capped-month remainingCapPaise after flexible-period payments', async () => {
    const admin = await getAdmin();
    const actorId = String(admin._id);
    const { customer } = await seedVerifiedCustomer('+917181500102');
    const plan = await seedCashPlan(actorId);
    const start = monthStartIst(new Date('2026-01-01T00:00:00.000Z'));
    const enrollment = await createEnrollment(
      {
        customerId: String(customer._id),
        schemePlanId: String(plan._id),
        startDate: start,
        monthlyInstallmentPaise: MIN,
      },
      adminCtx(actorId, 'admin-contrib-capped'),
    );

    for (let month = 0; month < 6; month += 1) {
      await createManualPayment(
        {
          customerId: String(customer._id),
          schemeId: String(enrollment._id),
          amountPaise: MIN,
          method: 'CASH',
          paymentDate: monthDate(start, month, 5),
          idempotencyKey: `admin-cap-seed-${month}`,
        },
        adminCtx(actorId, `admin-cap-seed-${month}`),
      );
    }

    const month7Date = monthDate(start, 6, 5);
    vi.setSystemTime(month7Date);
    const details = await getEnrollmentDetails(String(enrollment._id));
    expect(details.contribution?.phase).toBe('CAPPED');
    expect(details.contribution?.monthlyCapPaise).toBe(MIN);
    expect(details.contribution?.remainingCapPaise).toBe(MIN);

    const issued = await login(ADMIN_PHONE, ADMIN_PASSWORD, { ip: '127.0.0.1' });
    const preview = await request(app)
      .get(`/api/v1/admin/enrollments/${enrollment._id}/payment-preview`)
      .query({ amountPaise: MIN, paymentDate: month7Date.toISOString() })
      .set('Cookie', cookieHeader(issued.tokens.access))
      .expect(200);

    expect(preview.body.data.phase).toBe('CAPPED');
    expect(preview.body.data.monthlyCapPaise).toBe(MIN);
    expect(preview.body.data.remainingCapPaise).toBe(MIN);
    expect(preview.body.data.allowed).toBe(true);

    const overCap = await request(app)
      .get(`/api/v1/admin/enrollments/${enrollment._id}/payment-preview`)
      .query({ amountPaise: MIN + 50_000, paymentDate: month7Date.toISOString() })
      .set('Cookie', cookieHeader(issued.tokens.access))
      .expect(200);
    expect(overCap.body.data.allowed).toBe(false);
    expect(overCap.body.data.reasonCode).toBe('PAYMENT_LIMIT_EXCEEDED');

    const payments = await Payment.countDocuments({ schemeId: enrollment._id, status: 'SUCCESS' });
    expect(payments).toBe(6);
  });
});
