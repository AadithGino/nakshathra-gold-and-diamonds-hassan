import request from 'supertest';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { app } from '../src/app.js';
import {
  NAKSHATHRA_CAP_STRATEGY,
  NAKSHATHRA_CONTRIBUTION_POLICY_VERSION,
  formatCustomerCode,
} from '../src/config/business.js';
import { REQUIRED_INDEXES, verifyRequiredIndexes } from '../src/indexes/critical-indexes.js';
import { Customer, SchemeEnrollment, SchemePlan, User } from '../src/models/index.js';
import { hashPassword, login } from '../src/services/auth.service.js';
import { createCustomer } from '../src/services/customer.service.js';
import {
  createEnrollment,
  createSchemePlan,
  listActiveSchemePlans,
  updateSchemePlan,
} from '../src/services/scheme-management.service.js';
import { createStaff, updateUserStatus } from '../src/services/staff.service.js';
import * as storageService from '../src/services/storage.service.js';
import { buildObjectKey } from '../src/services/storage.service.js';
import { AppError } from '../src/utils/AppError.js';
import type { CreateStaffInput } from '../src/validators/staff.validators.js';
import { clearTestMongo, startTestMongo, stopTestMongo } from './helpers/mongo.js';

const ADMIN_PHONE = '+917181300001';
const ADMIN_PASSWORD = 'AdminPass123!';
const STAFF_PHONE = '+917181300002';
const STAFF_PASSWORD = 'StaffPass123!';
const VIEW_STAFF_PHONE = '+917181300003';
const ENROLL_STAFF_PHONE = '+917181300004';
const CUSTOMER_PASSWORD = 'CustomerPass123!';
const AADHAAR_FRONT = 'jewellers/nakshathra-jewellery/aadhaar-front/front.jpg';
const AADHAAR_BACK = 'jewellers/nakshathra-jewellery/aadhaar-back/back.jpg';

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

function adminCtx(actorId: string, requestId: string) {
  return { actorId, actorRole: 'ADMIN' as const, requestId };
}

async function seedAdmin() {
  const [admin] = await User.create([
    {
      name: 'Phase3 Admin',
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
      name: `Phase3 Staff ${employeeCode}`,
      phone,
      password: STAFF_PASSWORD,
      employeeCode,
      permissions,
    },
    adminCtx(actorId, `p3-staff-${employeeCode}`),
  );
}

async function seedVerifiedCustomer(opts?: {
  name?: string;
  phone?: string;
  password?: string;
  aadhaar?: { frontKey?: string; backKey?: string };
}) {
  const admin = await User.findOne({ role: 'ADMIN' });
  const actorId = String(admin?._id ?? (await seedAdmin())._id);
  const created = await createCustomer(
    {
      name: opts?.name ?? 'Phase3 Customer',
      phone: opts?.phone ?? '+917181300101',
      password: opts?.password ?? CUSTOMER_PASSWORD,
      aadhaar: opts?.aadhaar,
    },
    adminCtx(actorId, 'p3-customer'),
  );
  await Customer.updateOne({ _id: created.customer._id }, { $set: { kycStatus: 'VERIFIED' } });
  return created.customer;
}

async function seedCashPlan() {
  const admin = await User.findOne({ role: 'ADMIN' });
  const actorId = String(admin?._id ?? (await seedAdmin())._id);
  return createSchemePlan(
    {
      name: 'Nakshathra Cash Live',
      type: 'CASH',
      durationMonths: 11,
      minimumPaymentPaise: 100_000,
      termsText: 'Eleven contribution months then settlement.',
    },
    adminCtx(actorId, 'p3-plan'),
  );
}

describe('Phase 3 — customer creation, KYC and enrollment', () => {
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

  it('catalogs unique customerCode and user phone indexes', async () => {
    expect(REQUIRED_INDEXES.some((index) => index.id === 'CUSTOMER_CODE_UNIQUE')).toBe(true);
    expect(REQUIRED_INDEXES.some((index) => index.id === 'USER_PHONE_UNIQUE')).toBe(true);
    const report = await verifyRequiredIndexes();
    expect(report.ok).toBe(true);
    expect(report.mismatches.filter((row) => row.id.startsWith('CUSTOMER') || row.id.startsWith('USER')))
      .toEqual([]);
  });

  it('authorized staff creates a customer with a Nakshathra passbook and CUSTOMER role', async () => {
    await seedAdmin();
    await seedStaff(STAFF_PHONE, [...ALL_PERMISSIONS], 'NKS-S301');
    const issued = await login(STAFF_PHONE, STAFF_PASSWORD, { ip: '127.0.0.1' });

    const created = await request(app)
      .post('/api/v1/staff/customers')
      .set('Cookie', cookieHeader(issued.tokens.access))
      .send({
        name: 'Lakshmi Nair',
        phone: '+917181300201',
        password: CUSTOMER_PASSWORD,
        address: { city: 'Thrissur', state: 'Kerala' },
        nominee: { name: 'Ravi Nair', relationship: 'Spouse', phone: '+917181300202' },
      })
      .expect(201);

    expect(created.body.data.customer.customerCode).toMatch(/^NKS-C\d{6}$/);
    expect(created.body.data.customer.customerCode).toBe(formatCustomerCode(1));
    expect(created.body.data.customer.status).toBe('ACTIVE');
    expect(created.body.data.enrollment).toBeNull();

    const user = await User.findOne({ phone: '+917181300201' }).select('role passwordHash');
    expect(user?.role).toBe('CUSTOMER');
    expect(user?.role).not.toBe('ADMIN');
    expect(user?.role).not.toBe('STAFF');
    expect(user?.passwordHash).toBeTruthy();
  });

  it('unauthorized staff cannot create a customer', async () => {
    await seedAdmin();
    await seedStaff(VIEW_STAFF_PHONE, ['canViewCustomers'], 'NKS-S302');
    const issued = await login(VIEW_STAFF_PHONE, STAFF_PASSWORD, { ip: '127.0.0.1' });

    const denied = await request(app)
      .post('/api/v1/staff/customers')
      .set('Cookie', cookieHeader(issued.tokens.access))
      .send({
        name: 'Denied Customer',
        phone: '+917181300203',
        password: CUSTOMER_PASSWORD,
      });
    expect(denied.status).toBe(403);
    expect(denied.body.error?.code).toBe('PERMISSION_DENIED');
    expect(await User.findOne({ phone: '+917181300203' })).toBeNull();
  });

  it('rejects a duplicate mobile without creating a second account', async () => {
    await seedAdmin();
    await seedStaff(STAFF_PHONE, ['canCreateCustomer'], 'NKS-S303');
    const issued = await login(STAFF_PHONE, STAFF_PASSWORD, { ip: '127.0.0.1' });
    const payload = {
      name: 'First Customer',
      phone: '+917181300204',
      password: CUSTOMER_PASSWORD,
    };
    await request(app)
      .post('/api/v1/staff/customers')
      .set('Cookie', cookieHeader(issued.tokens.access))
      .send(payload)
      .expect(201);

    const duplicate = await request(app)
      .post('/api/v1/staff/customers')
      .set('Cookie', cookieHeader(issued.tokens.access))
      .send({ ...payload, name: 'Second Customer' });
    expect(duplicate.status).toBe(409);
    expect(duplicate.body.error?.code).toBe('DUPLICATE_PHONE');
    expect(await User.countDocuments({ phone: '+917181300204' })).toBe(1);
    expect(await Customer.countDocuments()).toBe(1);
  });

  it('cannot duplicate passbook numbers under concurrent creation', async () => {
    const admin = await seedAdmin();
    const ctx = adminCtx(String(admin._id), 'p3-passbook');
    const results = await Promise.all(
      Array.from({ length: 8 }, (_, index) =>
        createCustomer(
          {
            name: `Concurrent ${index}`,
            phone: `+91718130021${index}`,
            password: CUSTOMER_PASSWORD,
          },
          { ...ctx, requestId: `p3-passbook-${index}` },
        ),
      ),
    );
    const codes = results.map((row) => row.customer.customerCode);
    expect(new Set(codes).size).toBe(8);
    expect(codes.every((code) => /^NKS-C\d{6}$/.test(code))).toBe(true);
    expect(await Customer.countDocuments()).toBe(8);
  });

  it('denies disabled staff even with a previously issued session', async () => {
    await seedAdmin();
    const staff = await seedStaff(STAFF_PHONE, [...ALL_PERMISSIONS], 'NKS-S304');
    const issued = await login(STAFF_PHONE, STAFF_PASSWORD, { ip: '127.0.0.1' });
    const admin = await User.findOne({ role: 'ADMIN' });
    await updateUserStatus(String(staff.userId), 'INACTIVE', adminCtx(String(admin!._id), 'p3-disable'));

    await expect(login(STAFF_PHONE, STAFF_PASSWORD, { ip: '127.0.0.1' })).rejects.toMatchObject({
      code: 'ACCOUNT_INACTIVE',
      statusCode: 403,
    });

    const denied = await request(app)
      .post('/api/v1/staff/customers')
      .set('Cookie', cookieHeader(issued.tokens.access))
      .send({
        name: 'Should Fail',
        phone: '+917181300220',
        password: CUSTOMER_PASSWORD,
      });
    expect(denied.status).toBe(401);
    expect(denied.body.error?.code).toBe('SESSION_EXPIRED');
  });

  it('rejects an invalid phone without truncating to a valid mobile', async () => {
    await seedAdmin();
    await seedStaff(STAFF_PHONE, ['canCreateCustomer'], 'NKS-S305');
    const issued = await login(STAFF_PHONE, STAFF_PASSWORD, { ip: '127.0.0.1' });
    const extraDigits = '+919876543210999';

    const rejected = await request(app)
      .post('/api/v1/staff/customers')
      .set('Cookie', cookieHeader(issued.tokens.access))
      .send({
        name: 'Too Many Digits',
        phone: extraDigits,
        password: CUSTOMER_PASSWORD,
      });
    expect(rejected.status).toBe(422);
    expect(await User.findOne({ phone: '+919876543210' })).toBeNull();
    expect(await User.findOne({ phone: extraDigits })).toBeNull();
    expect(await Customer.countDocuments()).toBe(0);
  });

  it('owner enrolls a verified customer into a live CASH scheme', async () => {
    await seedAdmin();
    const plan = await seedCashPlan();
    const customer = await seedVerifiedCustomer({ phone: '+917181300230' });
    const issued = await login(ADMIN_PHONE, ADMIN_PASSWORD, { ip: '127.0.0.1' });

    const enrolled = await request(app)
      .post('/api/v1/admin/enrollments')
      .set('Cookie', cookieHeader(issued.tokens.access))
      .send({
        customerId: String(customer._id),
        schemePlanId: String(plan._id),
        startDate: '2026-01-01T00:00:00+05:30',
        monthlyInstallmentPaise: 100_000,
      })
      .expect(201);

    expect(enrolled.body.data.schemeType).toBe('CASH');
    expect(enrolled.body.data.flexibleMonths).toBe(6);
    expect(enrolled.body.data.capMonths).toBe(5);
    expect(enrolled.body.data.capStrategy).toBe(NAKSHATHRA_CAP_STRATEGY);
    expect(enrolled.body.data.contributionPolicyVersion).toBe(NAKSHATHRA_CONTRIBUTION_POLICY_VERSION);
    expect(enrolled.body.data.planSnapshot.capStrategy).toBe(NAKSHATHRA_CAP_STRATEGY);
    expect(enrolled.body.data.goldRatePerGramPaise).toBeUndefined();
    expect(enrolled.body.data.planSnapshot).not.toHaveProperty('goldRatePerGramPaise');

    const active = await request(app)
      .get(`/api/v1/admin/customers/${customer._id}/enrollment`)
      .set('Cookie', cookieHeader(issued.tokens.access))
      .expect(200);
    expect(String(active.body.data.enrollment._id)).toBe(String(enrolled.body.data._id));
    expect(active.body.data.enrollment.createdBy).toBeDefined();
  });

  it('permitted staff enrolls and staff without canEnrollScheme is denied', async () => {
    await seedAdmin();
    const plan = await seedCashPlan();
    const customer = await seedVerifiedCustomer({ phone: '+917181300231' });
    await seedStaff(ENROLL_STAFF_PHONE, ['canEnrollScheme', 'canViewCustomers'], 'NKS-S306');
    await seedStaff(VIEW_STAFF_PHONE, ['canViewCustomers'], 'NKS-S307');
    const allowed = await login(ENROLL_STAFF_PHONE, STAFF_PASSWORD, { ip: '127.0.0.1' });
    const denied = await login(VIEW_STAFF_PHONE, STAFF_PASSWORD, { ip: '127.0.0.1' });

    const payload = {
      customerId: String(customer._id),
      schemePlanId: String(plan._id),
      startDate: '2026-02-01T00:00:00+05:30',
      monthlyInstallmentPaise: 150_000,
    };

    const blocked = await request(app)
      .post('/api/v1/staff/enrollments')
      .set('Cookie', cookieHeader(denied.tokens.access))
      .send(payload);
    expect(blocked.status).toBe(403);
    expect(blocked.body.error?.code).toBe('PERMISSION_DENIED');

    const enrolled = await request(app)
      .post('/api/v1/staff/enrollments')
      .set('Cookie', cookieHeader(allowed.tokens.access))
      .send(payload)
      .expect(201);
    expect(enrolled.body.data.schemeType).toBe('CASH');
    expect(enrolled.body.data.monthlyInstallmentPaise).toBe(150_000);

    const active = await request(app)
      .get(`/api/v1/staff/customers/${customer._id}/enrollment`)
      .set('Cookie', cookieHeader(allowed.tokens.access))
      .expect(200);
    expect(String(active.body.data.enrollment._id)).toBe(String(enrolled.body.data._id));
  });

  it('rejects a second active enrollment', async () => {
    const admin = await seedAdmin();
    const plan = await seedCashPlan();
    const customer = await seedVerifiedCustomer({ phone: '+917181300232' });
    const ctx = adminCtx(String(admin._id), 'p3-enroll-1');
    await createEnrollment(
      {
        customerId: String(customer._id),
        schemePlanId: String(plan._id),
        startDate: new Date('2026-01-01T00:00:00+05:30'),
        monthlyInstallmentPaise: 100_000,
      },
      ctx,
    );

    await expect(
      createEnrollment(
        {
          customerId: String(customer._id),
          schemePlanId: String(plan._id),
          startDate: new Date('2026-02-01T00:00:00+05:30'),
          monthlyInstallmentPaise: 100_000,
        },
        { ...ctx, requestId: 'p3-enroll-2' },
      ),
    ).rejects.toMatchObject({ code: 'CUSTOMER_ALREADY_ENROLLED', statusCode: 409 });
    expect(await SchemeEnrollment.countDocuments({ customerId: customer._id, status: 'ACTIVE' })).toBe(
      1,
    );
  });

  it('cannot create two active enrollments under concurrency', async () => {
    const admin = await seedAdmin();
    const plan = await seedCashPlan();
    const customer = await seedVerifiedCustomer({ phone: '+917181300233' });
    const ctx = adminCtx(String(admin._id), 'p3-race');
    const payload = {
      customerId: String(customer._id),
      schemePlanId: String(plan._id),
      startDate: new Date('2026-03-01T00:00:00+05:30'),
      monthlyInstallmentPaise: 100_000,
    };

    const outcomes = await Promise.allSettled([
      createEnrollment(payload, { ...ctx, requestId: 'p3-race-a' }),
      createEnrollment(payload, { ...ctx, requestId: 'p3-race-b' }),
    ]);
    const fulfilled = outcomes.filter((row) => row.status === 'fulfilled');
    const rejected = outcomes.filter((row) => row.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    const reason = (rejected[0] as PromiseRejectedResult).reason as AppError;
    expect(['CUSTOMER_ALREADY_ENROLLED', 'DUPLICATE_RECORD']).toContain(reason.code);
    expect(await SchemeEnrollment.countDocuments({ customerId: customer._id, status: 'ACTIVE' })).toBe(
      1,
    );
  });

  it('keeps the enrollment snapshot unchanged after the live SchemePlan is edited', async () => {
    const admin = await seedAdmin();
    const plan = await seedCashPlan();
    const customer = await seedVerifiedCustomer({ phone: '+917181300234' });
    const enrollment = await createEnrollment(
      {
        customerId: String(customer._id),
        schemePlanId: String(plan._id),
        startDate: new Date('2026-01-01T00:00:00+05:30'),
        monthlyInstallmentPaise: 100_000,
      },
      adminCtx(String(admin._id), 'p3-snap'),
    );

    await updateSchemePlan(
      String(plan._id),
      {
        name: 'Edited Cash Plan',
        termsText: 'Changed after enrollment.',
        paymentWindowType: 'DATE_RANGE',
        paymentWindowStartDay: 1,
        paymentWindowEndDay: 10,
      },
      adminCtx(String(admin._id), 'p3-plan-edit'),
    );

    const stored = await SchemeEnrollment.findById(enrollment._id).lean();
    expect(stored?.planSnapshot?.name).toBe('Nakshathra Cash Live');
    expect(stored?.planSnapshot?.termsText).toBe('Eleven contribution months then settlement.');
    expect(stored?.planSnapshot?.capStrategy).toBe(NAKSHATHRA_CAP_STRATEGY);
    expect(stored?.flexibleMonths).toBe(6);
    expect(stored?.capMonths).toBe(5);
    expect(stored?.paymentWindowType).not.toBe('DATE_RANGE');
  });

  it('rejects GOLD_WEIGHT enrollment on the live product path', async () => {
    const admin = await seedAdmin();
    const customer = await seedVerifiedCustomer({ phone: '+917181300235' });
    const [goldPlan] = await SchemePlan.create([
      {
        name: 'Dormant Gold',
        type: 'GOLD_WEIGHT',
        durationMonths: 11,
        redemptionMonth: 12,
        flexibleMonths: 11,
        capMonths: 0,
        minimumPaymentPaise: 100_000,
        termsText: 'Dormant gold-weight plan must not be enrollable live.',
        status: 'ACTIVE',
        createdBy: admin._id,
      },
    ]);

    await expect(
      createEnrollment(
        {
          customerId: String(customer._id),
          schemePlanId: String(goldPlan._id),
          startDate: new Date('2026-01-01T00:00:00+05:30'),
          monthlyInstallmentPaise: 100_000,
        },
        adminCtx(String(admin._id), 'p3-gold'),
      ),
    ).rejects.toMatchObject({ code: 'SCHEME_TYPE_NOT_LIVE', statusCode: 422 });

    const livePlans = await listActiveSchemePlans();
    expect(livePlans.every((plan: { type: string }) => plan.type === 'CASH')).toBe(true);
    expect(livePlans.some((plan: { name: string }) => plan.name === 'Dormant Gold')).toBe(false);
  });

  it('rolls back combined create+enroll when KYC is not verified', async () => {
    const admin = await seedAdmin();
    const plan = await seedCashPlan();
    await expect(
      createCustomer(
        {
          name: 'Unverified Combined',
          phone: '+917181300236',
          password: CUSTOMER_PASSWORD,
          enrollment: {
            schemePlanId: String(plan._id),
            startDate: new Date('2026-01-01T00:00:00+05:30'),
            monthlyInstallmentPaise: 100_000,
          },
        },
        adminCtx(String(admin._id), 'p3-combined'),
      ),
    ).rejects.toMatchObject({ code: 'KYC_VERIFICATION_REQUIRED' });
    expect(await User.findOne({ phone: '+917181300236' })).toBeNull();
    expect(await Customer.countDocuments()).toBe(0);
    expect(await SchemeEnrollment.countDocuments()).toBe(0);
  });

  it('treats regex metacharacters as literals in customer search', async () => {
    await seedAdmin();
    await seedStaff(STAFF_PHONE, ['canViewCustomers', 'canCreateCustomer'], 'NKS-S308');
    await createCustomer(
      {
        name: 'Alice Nair',
        phone: '+917181300237',
        password: CUSTOMER_PASSWORD,
      },
      adminCtx(String((await User.findOne({ role: 'ADMIN' }))!._id), 'p3-search-a'),
    );
    await createCustomer(
      {
        name: 'Bob.*Wildcard',
        phone: '+917181300238',
        password: CUSTOMER_PASSWORD,
      },
      adminCtx(String((await User.findOne({ role: 'ADMIN' }))!._id), 'p3-search-b'),
    );
    const issued = await login(STAFF_PHONE, STAFF_PASSWORD, { ip: '127.0.0.1' });

    const literal = await request(app)
      .get('/api/v1/staff/customers')
      .query({ search: '.*' })
      .set('Cookie', cookieHeader(issued.tokens.access))
      .expect(200);
    expect(literal.body.data).toHaveLength(1);
    expect(literal.body.data[0].userId.name).toBe('Bob.*Wildcard');

    const byPhone = await request(app)
      .get('/api/v1/staff/customers')
      .query({ search: '7181300237' })
      .set('Cookie', cookieHeader(issued.tokens.access))
      .expect(200);
    expect(byPhone.body.data).toHaveLength(1);
    expect(byPhone.body.data[0].userId.phone).toBe('+917181300237');
  });

  it('keeps Aadhaar private: unauthorized upload is denied and the customer portal never sees keys', async () => {
    vi.spyOn(storageService, 'signAadhaarUrls').mockImplementation(async (aadhaar) => ({
      frontKey: aadhaar?.frontKey ?? null,
      backKey: aadhaar?.backKey ?? null,
      frontUrl: aadhaar?.frontKey ? 'https://signed.example/front' : null,
      backUrl: aadhaar?.backKey ? 'https://signed.example/back' : null,
    }));

    await seedAdmin();
    await seedStaff(STAFF_PHONE, [...ALL_PERMISSIONS], 'NKS-S309');
    await seedStaff(VIEW_STAFF_PHONE, ['canViewCustomers'], 'NKS-S310');
    const adminIssued = await login(ADMIN_PHONE, ADMIN_PASSWORD, { ip: '127.0.0.1' });
    const creatorIssued = await login(STAFF_PHONE, STAFF_PASSWORD, { ip: '127.0.0.1' });
    const viewerIssued = await login(VIEW_STAFF_PHONE, STAFF_PASSWORD, { ip: '127.0.0.1' });

    const unauthenticated = await request(app).post('/api/v1/uploads/presign').send({
      kind: 'aadhaar-front',
      contentType: 'image/jpeg',
    });
    expect(unauthenticated.status).toBe(401);

    const viewerUpload = await request(app)
      .post('/api/v1/uploads/presign')
      .set('Cookie', cookieHeader(viewerIssued.tokens.access))
      .send({ kind: 'aadhaar-front', contentType: 'image/jpeg' });
    expect(viewerUpload.status).toBe(403);
    expect(viewerUpload.body.error?.code).toBe('PERMISSION_DENIED');

    const created = await request(app)
      .post('/api/v1/staff/customers')
      .set('Cookie', cookieHeader(creatorIssued.tokens.access))
      .send({
        name: 'Kyc Customer',
        phone: '+917181300239',
        password: CUSTOMER_PASSWORD,
        aadhaar: { frontKey: AADHAAR_FRONT, backKey: AADHAAR_BACK },
      })
      .expect(201);
    expect(created.body.data.customer.kycStatus).toBe('PENDING');

    const customerUser = await User.findOne({ phone: '+917181300239' });
    const customerIssued = await login('+917181300239', CUSTOMER_PASSWORD, { ip: '127.0.0.1' });
    const profile = await request(app)
      .get('/api/v1/customer/profile')
      .set('Cookie', cookieHeader(customerIssued.tokens.access))
      .expect(200);
    expect(profile.body.data.aadhaar).toBeUndefined();
    expect(JSON.stringify(profile.body)).not.toMatch(/aadhaar/i);
    expect(JSON.stringify(profile.body)).not.toContain(AADHAAR_FRONT);

    const adminView = await request(app)
      .get(`/api/v1/admin/customers/${created.body.data.customer._id}`)
      .set('Cookie', cookieHeader(adminIssued.tokens.access))
      .expect(200);
    expect(adminView.body.data.customer.aadhaar.frontUrl).toMatch(/^https:\/\/signed\.example\//);
    expect(adminView.body.data.customer.aadhaar.frontUrl).not.toMatch(/amazonaws\.com\/[^?]+$/);

    expect(customerUser?.role).toBe('CUSTOMER');
    const objectKey = buildObjectKey('aadhaar-front', 'image/jpeg');
    expect(objectKey).toContain('/private/');
    expect(objectKey).not.toContain('/public/');
  });

  it('lets staff with canCreateCustomer attempt Aadhaar upload after auth', async () => {
    await seedAdmin();
    await seedStaff(STAFF_PHONE, ['canCreateCustomer'], 'NKS-S311');
    const issued = await login(STAFF_PHONE, STAFF_PASSWORD, { ip: '127.0.0.1' });
    const response = await request(app)
      .post('/api/v1/uploads/presign')
      .set('Cookie', cookieHeader(issued.tokens.access))
      .send({ kind: 'aadhaar-front', contentType: 'image/jpeg' });
    expect([200, 503]).toContain(response.status);
    if (response.status === 503) {
      expect(response.body.error?.code).toBe('STORAGE_NOT_CONFIGURED');
    } else {
      expect(response.body.data.uploadUrl).toBeTruthy();
      expect(response.body.data.key).toContain('/private/');
    }
  });
});
