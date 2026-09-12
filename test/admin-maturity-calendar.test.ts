import { startOfMonth } from 'date-fns';
import { fromZonedTime, toZonedTime } from 'date-fns-tz';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { app } from '../src/app.js';
import { Customer, User } from '../src/models/index.js';
import { hashPassword, login } from '../src/services/auth.service.js';
import { createCustomer } from '../src/services/customer.service.js';
import {
  createEnrollment,
  createSchemePlan,
} from '../src/services/scheme-management.service.js';
import { BUSINESS_TZ } from '../src/utils/time.js';
import { clearTestMongo, startTestMongo, stopTestMongo } from './helpers/mongo.js';

const ADMIN_PHONE = '+917181600001';
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

async function seedAdmin() {
  const existing = await User.findOne({ phone: ADMIN_PHONE });
  if (existing) return existing;
  const [admin] = await User.create([
    {
      name: 'Maturity Calendar Admin',
      phone: ADMIN_PHONE,
      passwordHash: await hashPassword(ADMIN_PASSWORD),
      role: 'ADMIN',
      status: 'ACTIVE',
    },
  ]);
  return admin;
}

async function seedVerifiedCustomer(phone: string, actorId: string) {
  const created = await createCustomer(
    {
      name: 'Maturity Calendar Customer',
      phone,
      password: 'CustomerPass123!',
    },
    adminCtx(actorId, `maturity-cal-${phone}`),
  );
  await Customer.updateOne({ _id: created.customer._id }, { $set: { kycStatus: 'VERIFIED' } });
  return created.customer;
}

describe('admin maturity calendar API', () => {
  beforeAll(async () => {
    await startTestMongo();
  });

  afterAll(async () => {
    await stopTestMongo();
  });

  beforeEach(async () => {
    await clearTestMongo();
    await seedAdmin();
  });

  it('returns enrollments in the requested maturity date range', async () => {
    const admin = await seedAdmin();
    const actorId = String(admin._id);
    const customer = await seedVerifiedCustomer('+917181600101', actorId);
    const plan = await createSchemePlan(
      {
        name: 'Maturity Calendar Cash',
        type: 'CASH',
        durationMonths: 11,
        minimumPaymentPaise: MIN,
        termsText: 'Eleven contribution months then settlement.',
      },
      adminCtx(actorId, 'maturity-cal-plan'),
    );
    const start = monthStartIst(new Date('2026-01-01T00:00:00.000Z'));
    const enrollment = await createEnrollment(
      {
        customerId: String(customer._id),
        schemePlanId: String(plan._id),
        startDate: start,
        monthlyInstallmentPaise: MIN,
      },
      adminCtx(actorId, 'maturity-cal-enroll'),
    );
    const issued = await login(ADMIN_PHONE, ADMIN_PASSWORD, { ip: '127.0.0.1' });

    const res = await request(app)
      .get('/api/v1/admin/maturity-calendar')
      .query({ from: '2026-12-01', to: '2026-12-31' })
      .set('Cookie', cookieHeader(issued.tokens.access))
      .expect(200);

    expect(res.body.meta.from).toBeTruthy();
    expect(res.body.meta.to).toBeTruthy();
    expect(res.body.meta.total).toBeGreaterThanOrEqual(1);
    expect(res.body.data).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          enrollmentId: String(enrollment._id),
          enrollmentNumber: enrollment.enrollmentNumber,
          customer: expect.objectContaining({ phone: '+917181600101' }),
          schemePlan: expect.objectContaining({ name: 'Maturity Calendar Cash', type: 'CASH' }),
          status: 'ACTIVE',
          maturityDate: enrollment.maturityDate.toISOString(),
        }),
      ]),
    );
  });

  it('rejects invalid date ranges', async () => {
    const issued = await login(ADMIN_PHONE, ADMIN_PASSWORD, { ip: '127.0.0.1' });
    const res = await request(app)
      .get('/api/v1/admin/maturity-calendar')
      .query({ from: '2026-12-31', to: '2026-01-01' })
      .set('Cookie', cookieHeader(issued.tokens.access))
      .expect(422);

    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });
});
