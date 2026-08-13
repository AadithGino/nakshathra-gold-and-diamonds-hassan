import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { app } from '../src/app.js';
import {
  business,
  formatCustomerCode,
  formatEnrollmentNumber,
  formatMerchantTransactionId,
  formatReceiptNumber,
  LIVE_SCHEME_TYPE,
} from '../src/config/business.js';
import { openapi } from '../src/config/openapi.js';
import {
  Customer,
  SystemSetting,
  User,
} from '../src/models/index.js';
import { hashPassword, login } from '../src/services/auth.service.js';
import { createCustomer } from '../src/services/customer.service.js';
import { allocateReceiptNumber } from '../src/services/payment.service.js';
import {
  allocateEnrollmentNumber,
  createSchemePlan,
} from '../src/services/scheme-management.service.js';
import { getSettings } from '../src/services/settings.service.js';
import { createStaff, updateStaff, updateUserStatus } from '../src/services/staff.service.js';
import type { CreateStaffInput } from '../src/validators/staff.validators.js';
import {
  MIGRATION_ACK_VALUE,
  runNakshathraDomainConfigApply,
  runNakshathraDomainConfigDryRun,
  runNakshathraDomainConfigVerify,
} from '../src/scripts/migrations/2026-08-nakshathra-domain-config.js';
import { BUSINESS_TZ } from '../src/utils/time.js';
import { createSchemePlanSchema } from '../src/validators/scheme.validators.js';
import { clearTestMongo, startTestMongo, stopTestMongo, withTestTransaction } from './helpers/mongo.js';

const ADMIN_PHONE = '+917181000001';
const ADMIN_PASSWORD = 'AdminPass123!';
const STAFF_PHONE = '+917181000002';
const STAFF_PASSWORD = 'StaffPass123!';
const CUSTOMER_PHONE = '+917181000003';
const CUSTOMER_PASSWORD = 'CustomerPass123!';

const ALL_PERMISSIONS = [
  'canCreateCustomer',
  'canViewCustomers',
  'canEnrollScheme',
  'canCollectPayment',
  'canSubmitCorrectionRequest',
] as const;

function cookieHeader(access: string) {
  return `access_token=${access}`;
}

async function seedAdmin() {
  const [admin] = await User.create([
    {
      name: 'Phase1 Admin',
      phone: ADMIN_PHONE,
      passwordHash: await hashPassword(ADMIN_PASSWORD),
      role: 'ADMIN',
      status: 'ACTIVE',
    },
  ]);
  return admin;
}

async function seedCustomerUser() {
  const [user] = await User.create([
    {
      name: 'Phase1 Customer',
      phone: CUSTOMER_PHONE,
      passwordHash: await hashPassword(CUSTOMER_PASSWORD),
      role: 'CUSTOMER',
      status: 'ACTIVE',
    },
  ]);
  await Customer.create([
    {
      userId: user._id,
      customerCode: 'NKS-C999001',
      status: 'ACTIVE',
      kycStatus: 'VERIFIED',
      createdBy: user._id,
    },
  ]);
  return user;
}

async function seedStaff(permissions: CreateStaffInput['permissions'] = []) {
  const admin = await User.findOne({ role: 'ADMIN' });
  const actorId = String(admin?._id ?? (await seedAdmin())._id);
  return createStaff(
    {
      name: 'Phase1 Staff',
      phone: STAFF_PHONE,
      password: STAFF_PASSWORD,
      employeeCode: 'NKS-S001',
      permissions,
    },
    { actorId, actorRole: 'ADMIN', requestId: 'p1-staff' },
  );
}

describe('Phase 1 — domain, role and configuration conversion', () => {
  beforeAll(async () => {
    await startTestMongo();
  }, 120_000);

  afterAll(async () => {
    await stopTestMongo();
  });

  beforeEach(async () => {
    await clearTestMongo();
  });

  it('uses Asia/Kolkata as the business timezone', () => {
    expect(business.timezone).toBe('Asia/Kolkata');
    expect(BUSINESS_TZ).toBe('Asia/Kolkata');
  });

  it('enables CASH and rejects GOLD_WEIGHT for new live schemes', () => {
    expect(createSchemePlanSchema.safeParse({
      name: 'Nakshathra Cash',
      type: 'CASH',
      durationMonths: 11,
      minimumPaymentPaise: 100_000,
      termsText: 'Eleven contribution months then settlement.',
    }).success).toBe(true);
    expect(createSchemePlanSchema.safeParse({
      name: 'Gold dormant',
      type: 'GOLD_WEIGHT',
      durationMonths: 11,
      minimumPaymentPaise: 100_000,
      termsText: 'Gold weight must stay dormant for live creation.',
    }).success).toBe(false);
  });

  it('keeps Kairali branding out of new Nakshathra outputs', async () => {
    const health = await request(app).get('/health').expect(200);
    expect(health.body.service).toBe(business.serviceName);
    expect(JSON.stringify(health.body)).not.toMatch(/kairali/i);

    expect(openapi.info.title).toBe(business.apiTitle);
    expect(openapi.info.title).not.toMatch(/kairali/i);

    const settings = await getSettings();
    expect(settings.businessName).toBe('Nakshathra Jewellers');
    expect(settings.receiptFooter).toContain('Nakshathra Jewellers');
    expect(JSON.stringify(settings)).not.toMatch(/kairali/i);

    const receipt = await withTestTransaction(async (session) =>
      allocateReceiptNumber(session, new Date('2026-08-13T10:00:00+05:30')),
    );
    const enrollment = await withTestTransaction(async (session) =>
      allocateEnrollmentNumber(session, new Date('2026-08-13T10:00:00+05:30')),
    );
    expect(receipt).toBe(formatReceiptNumber(2026, 1));
    expect(enrollment).toBe(formatEnrollmentNumber(2026, 1));
    expect(receipt).not.toMatch(/KRL/);
    expect(enrollment).not.toMatch(/KRL/);
    expect(formatMerchantTransactionId(1, 'abcd1234')).toMatch(/^NKS-1-abcd1234$/);
    expect(formatCustomerCode(1)).toBe('NKS-C000001');
  });

  it('allocates prefixed customer codes for new customers', async () => {
    const admin = await seedAdmin();
    const created = await createCustomer(
      {
        name: 'Passbook Customer',
        phone: '+917181000010',
        password: 'Password123!',
      },
      { actorId: String(admin._id), actorRole: 'ADMIN', requestId: 'p1-cust' },
    );
    expect(created.customer.customerCode).toBe('NKS-C000001');
  });

  it('allows STAFF login and rejects disabled STAFF', async () => {
    const admin = await seedAdmin();
    await seedStaff(['canViewCustomers']);
    const issued = await login(STAFF_PHONE, STAFF_PASSWORD, { ip: '127.0.0.1' });
    expect(issued.data.user.role).toBe('STAFF');
    expect(issued.data.user.permissions).toEqual(['canViewCustomers']);
    expect(issued.data.redirectTo).toBe('/staff');

    const http = await request(app)
      .post('/api/v1/auth/login')
      .send({ phone: STAFF_PHONE, password: STAFF_PASSWORD })
      .expect(200);
    expect(http.body.data.user.role).toBe('STAFF');

    const staffUser = await User.findOne({ phone: STAFF_PHONE });
    await updateUserStatus(String(staffUser!._id), 'INACTIVE', {
      actorId: String(admin._id),
      actorRole: 'ADMIN',
      requestId: 'p1-disable',
    });
    await expect(login(STAFF_PHONE, STAFF_PASSWORD, { ip: '127.0.0.1' })).rejects.toMatchObject({
      code: 'ACCOUNT_INACTIVE',
      statusCode: 403,
    });
  });

  it('keeps ADMIN and CUSTOMER authentication working', async () => {
    await seedAdmin();
    await seedCustomerUser();
    const adminIssued = await login(ADMIN_PHONE, ADMIN_PASSWORD, { ip: '127.0.0.1' });
    const customerIssued = await login(CUSTOMER_PHONE, CUSTOMER_PASSWORD, { ip: '127.0.0.1' });
    await request(app)
      .get('/api/v1/admin/dashboard')
      .set('Cookie', cookieHeader(adminIssued.tokens.access))
      .expect(200);
    await request(app)
      .get('/api/v1/customer/home')
      .set('Cookie', cookieHeader(customerIssued.tokens.access))
      .expect(200);
  });

  it('blocks CUSTOMER from STAFF endpoints and STAFF from ADMIN endpoints', async () => {
    await seedAdmin();
    await seedCustomerUser();
    await seedStaff(['canViewCustomers']);
    const customerIssued = await login(CUSTOMER_PHONE, CUSTOMER_PASSWORD, { ip: '127.0.0.1' });
    const staffIssued = await login(STAFF_PHONE, STAFF_PASSWORD, { ip: '127.0.0.1' });

    const customerOnStaff = await request(app)
      .get('/api/v1/staff/customers')
      .set('Cookie', cookieHeader(customerIssued.tokens.access));
    expect(customerOnStaff.status).toBe(403);

    const staffOnAdmin = await request(app)
      .get('/api/v1/admin/dashboard')
      .set('Cookie', cookieHeader(staffIssued.tokens.access));
    expect(staffOnAdmin.status).toBe(403);

    const staffOnAdminStaff = await request(app)
      .get('/api/v1/admin/staff')
      .set('Cookie', cookieHeader(staffIssued.tokens.access));
    expect(staffOnAdminStaff.status).toBe(403);
  });

  it('denies each staff permission when it is false', async () => {
    await seedAdmin();
    await seedStaff([]);
    const issued = await login(STAFF_PHONE, STAFF_PASSWORD, { ip: '127.0.0.1' });
    const cookie = cookieHeader(issued.tokens.access);

    const denied = await Promise.all([
      request(app).get('/api/v1/staff/customers').set('Cookie', cookie),
      request(app)
        .post('/api/v1/staff/customers')
        .set('Cookie', cookie)
        .send({ name: 'Denied', phone: '+917181000020', password: 'Password123!' }),
      request(app)
        .post('/api/v1/staff/enrollments')
        .set('Cookie', cookie)
        .send({
          customerId: '000000000000000000000001',
          schemePlanId: '000000000000000000000002',
          startDate: '2026-08-01',
          monthlyInstallmentPaise: 100_000,
        }),
      request(app)
        .post('/api/v1/staff/payments')
        .set('Cookie', cookie)
        .send({
          customerId: '000000000000000000000001',
          schemeId: '000000000000000000000002',
          amountPaise: 100_000,
          method: 'CASH',
          paymentDate: '2026-08-01',
          idempotencyKey: 'denied-collect-1',
        }),
      request(app)
        .post('/api/v1/staff/payments/000000000000000000000099/corrections')
        .set('Cookie', cookie)
        .send({ correctionType: 'REVERSE_PAYMENT', reason: 'Need to reverse this cash entry' }),
    ]);

    for (const res of denied) {
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('PERMISSION_DENIED');
    }
  });

  it('allows each staff permission when it is true', async () => {
    const admin = await seedAdmin();
    await seedStaff([...ALL_PERMISSIONS]);
    const issued = await login(STAFF_PHONE, STAFF_PASSWORD, { ip: '127.0.0.1' });
    const cookie = cookieHeader(issued.tokens.access);

    const view = await request(app).get('/api/v1/staff/customers').set('Cookie', cookie);
    expect(view.status).toBe(200);

    const created = await request(app)
      .post('/api/v1/staff/customers')
      .set('Cookie', cookie)
      .send({ name: 'Staff Created', phone: '+917181000021', password: 'Password123!' });
    expect(created.status).toBe(201);
    expect(created.body.data.customer.customerCode).toMatch(/^NKS-C/);

    await Customer.updateOne(
      { _id: created.body.data.customer._id ?? created.body.data.customer.id },
      { $set: { kycStatus: 'VERIFIED' } },
    );
    const customerId = String(
      created.body.data.customer._id ?? created.body.data.customer.id,
    );

    const plan = await createSchemePlan(
      {
        name: 'Nakshathra Cash Live',
        type: LIVE_SCHEME_TYPE,
        durationMonths: 11,
        minimumPaymentPaise: 100_000,
        termsText: 'Live CASH plan for permission tests.',
      },
      { actorId: String(admin._id), actorRole: 'ADMIN', requestId: 'p1-plan' },
    );
    expect(plan.type).toBe('CASH');

    const enroll = await request(app)
      .post('/api/v1/staff/enrollments')
      .set('Cookie', cookie)
      .send({
        customerId,
        schemePlanId: String(plan._id),
        startDate: '2026-08-01',
        monthlyInstallmentPaise: 100_000,
      });
    expect(enroll.status).toBe(201);
    expect(enroll.body.data.enrollmentNumber).toMatch(/^NKS-ENR-/);

    const enrollmentId = String(enroll.body.data._id ?? enroll.body.data.id);
    const preview = await request(app)
      .get(`/api/v1/staff/schemes/${enrollmentId}/payment-preview`)
      .query({ amountPaise: 100_000 })
      .set('Cookie', cookie);
    expect(preview.status).toBe(200);
    expect(preview.status).not.toBe(403);

    const correction = await request(app)
      .post('/api/v1/staff/payments/000000000000000000000099/corrections')
      .set('Cookie', cookie)
      .send({ correctionType: 'REVERSE_PAYMENT', reason: 'Need to reverse this cash entry' });
    expect(correction.status).not.toBe(403);
    expect(correction.status).toBe(404);
  });

  it('lets ADMIN create staff and reloads live permissions after a change', async () => {
    const admin = await seedAdmin();
    const adminIssued = await login(ADMIN_PHONE, ADMIN_PASSWORD, { ip: '127.0.0.1' });
    const created = await request(app)
      .post('/api/v1/admin/staff')
      .set('Cookie', cookieHeader(adminIssued.tokens.access))
      .send({
        name: 'Counter Staff',
        phone: '+917181000030',
        password: STAFF_PASSWORD,
        employeeCode: 'NKS-S002',
        permissions: ['canViewCustomers'],
      })
      .expect(201);

    const staffIssued = await login('+917181000030', STAFF_PASSWORD, { ip: '127.0.0.1' });
    await request(app)
      .get('/api/v1/staff/customers')
      .set('Cookie', cookieHeader(staffIssued.tokens.access))
      .expect(200);

    await updateStaff(
      String(created.body.data.userId),
      { permissions: [] },
      { actorId: String(admin._id), actorRole: 'ADMIN', requestId: 'p1-perm-revoke' },
    );

    const afterRevoke = await request(app)
      .get('/api/v1/staff/customers')
      .set('Cookie', cookieHeader(staffIssued.tokens.access));
    expect(afterRevoke.status).toBe(401);
  });

  it('rejects GOLD_WEIGHT on the live scheme-plan HTTP API', async () => {
    await seedAdmin();
    const adminIssued = await login(ADMIN_PHONE, ADMIN_PASSWORD, { ip: '127.0.0.1' });
    const rejected = await request(app)
      .post('/api/v1/admin/scheme-plans')
      .set('Cookie', cookieHeader(adminIssued.tokens.access))
      .send({
        name: 'Dormant Gold',
        type: 'GOLD_WEIGHT',
        durationMonths: 11,
        minimumPaymentPaise: 100_000,
        termsText: 'Gold weight is not selectable for new live schemes.',
      });
    expect(rejected.status).toBe(422);

    const created = await request(app)
      .post('/api/v1/admin/scheme-plans')
      .set('Cookie', cookieHeader(adminIssued.tokens.access))
      .send({
        name: 'Nakshathra Cash HTTP',
        type: 'CASH',
        durationMonths: 11,
        minimumPaymentPaise: 100_000,
        termsText: 'Cash is the live Nakshathra scheme type.',
      });
    expect(created.status).toBe(201);
    expect(created.body.data.type).toBe('CASH');
  });

  it('migrates Kairali settings without touching financial records', async () => {
    const admin = await seedAdmin();
    await SystemSetting.create([
      {
        singletonKey: 'GLOBAL',
        businessName: 'Kairali Gold & Diamonds',
        receiptFooter: 'Thank you for saving with Kairali Gold & Diamonds.',
        updatedBy: admin._id,
      },
    ]);
    const dry = await runNakshathraDomainConfigDryRun();
    expect(dry.settingsWouldUpdate).toBe(true);
    expect(dry.ok).toBe(true);
    expect(dry.invalidRoleUsers).toBe(0);

    const applied = await runNakshathraDomainConfigApply({ ack: MIGRATION_ACK_VALUE });
    expect(applied.settingsUpdated).toBe(1);
    expect(applied.settingsWouldUpdate).toBe(false);
    expect(applied.ok).toBe(true);

    const verified = await runNakshathraDomainConfigVerify();
    expect(verified.ok).toBe(true);
    const settings = await SystemSetting.findOne({ singletonKey: 'GLOBAL' }).lean();
    expect(settings?.businessName).toBe('Nakshathra Jewellers');
  });
});
