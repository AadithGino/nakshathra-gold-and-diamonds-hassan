import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { app } from '../src/app.js';
import { Customer, User } from '../src/models/index.js';
import { hashPassword, login } from '../src/services/auth.service.js';
import { createCustomer } from '../src/services/customer.service.js';
import { createStaff } from '../src/services/staff.service.js';
import { normalizeIndianPhone } from '../src/utils/phone.js';
import { clearTestMongo, startTestMongo, stopTestMongo } from './helpers/mongo.js';

const ADMIN_PHONE = '+917182900001';
const ADMIN_PASSWORD = 'AdminPass123!';
const STAFF_PHONE = '+917182900002';
const STAFF_PASSWORD = 'StaffPass123!';
const CUSTOMER_PASSWORD = 'CustomerPass123!';

function adminCtx(actorId: string, requestId: string) {
  return { actorId, actorRole: 'ADMIN' as const, requestId };
}

function cookieHeader(access: string) {
  return `access_token=${access}`;
}

async function seedAdmin() {
  const [admin] = await User.create([
    {
      name: 'Dup Mobile Admin',
      phone: ADMIN_PHONE,
      passwordHash: await hashPassword(ADMIN_PASSWORD),
      role: 'ADMIN',
      status: 'ACTIVE',
    },
  ]);
  return admin;
}

async function seedStaff() {
  const admin = await User.findOne({ role: 'ADMIN' });
  return createStaff(
    {
      name: 'Dup Mobile Staff',
      phone: STAFF_PHONE,
      password: STAFF_PASSWORD,
      employeeCode: 'NKS-DUP-S1',
      permissions: ['canCreateCustomer', 'canViewCustomers'],
    },
    adminCtx(String(admin!._id), 'dup-staff'),
  );
}

describe('duplicate customer mobile identity', () => {
  beforeAll(async () => {
    await startTestMongo();
  }, 120_000);
  afterAll(async () => {
    await stopTestMongo();
  });
  beforeEach(async () => {
    await clearTestMongo();
  });

  it('rejects an exact ADMIN duplicate and keeps a single identity', async () => {
    await seedAdmin();
    const issued = await login(ADMIN_PHONE, ADMIN_PASSWORD, { ip: '127.0.0.1' });
    const phone = '+917182900101';
    const first = await request(app)
      .post('/api/v1/admin/customers')
      .set('Cookie', cookieHeader(issued.tokens.access))
      .send({ name: 'First', phone, password: CUSTOMER_PASSWORD });
    expect(first.status).toBe(201);

    const duplicate = await request(app)
      .post('/api/v1/admin/customers')
      .set('Cookie', cookieHeader(issued.tokens.access))
      .send({ name: 'Second', phone, password: CUSTOMER_PASSWORD });
    expect(duplicate.status).toBe(409);
    expect(duplicate.body.error?.code).toBe('DUPLICATE_PHONE');
    expect(await User.countDocuments({ phone, role: 'CUSTOMER' })).toBe(1);
    expect(await Customer.countDocuments()).toBe(1);
  });

  it('rejects ADMIN→STAFF and STAFF→ADMIN duplicate paths for the same mobile', async () => {
    await seedAdmin();
    await seedStaff();
    const adminLogin = await login(ADMIN_PHONE, ADMIN_PASSWORD, { ip: '127.0.0.1' });
    const staffLogin = await login(STAFF_PHONE, STAFF_PASSWORD, { ip: '127.0.0.1' });
    const phone = '+917182900102';

    await request(app)
      .post('/api/v1/admin/customers')
      .set('Cookie', cookieHeader(adminLogin.tokens.access))
      .send({ name: 'Admin Created', phone, password: CUSTOMER_PASSWORD })
      .expect(201);

    const viaStaff = await request(app)
      .post('/api/v1/staff/customers')
      .set('Cookie', cookieHeader(staffLogin.tokens.access))
      .send({ name: 'Staff Dup', phone, password: CUSTOMER_PASSWORD });
    expect(viaStaff.status).toBe(409);
    expect(viaStaff.body.error?.code).toBe('DUPLICATE_PHONE');

    const other = '+917182900103';
    await request(app)
      .post('/api/v1/staff/customers')
      .set('Cookie', cookieHeader(staffLogin.tokens.access))
      .send({ name: 'Staff First', phone: other, password: CUSTOMER_PASSWORD })
      .expect(201);

    const viaAdmin = await request(app)
      .post('/api/v1/admin/customers')
      .set('Cookie', cookieHeader(adminLogin.tokens.access))
      .send({ name: 'Admin Dup', phone: other, password: CUSTOMER_PASSWORD });
    expect(viaAdmin.status).toBe(409);
    expect(viaAdmin.body.error?.code).toBe('DUPLICATE_PHONE');
    expect(await User.countDocuments({ role: 'CUSTOMER' })).toBe(2);
  });

  it('rejects canonical-equivalent representations of the same Indian mobile', async () => {
    await seedAdmin();
    const issued = await login(ADMIN_PHONE, ADMIN_PASSWORD, { ip: '127.0.0.1' });
    const local = '7182900104';
    const canonical = normalizeIndianPhone(local);
    expect(canonical).toBe('+917182900104');

    await request(app)
      .post('/api/v1/admin/customers')
      .set('Cookie', cookieHeader(issued.tokens.access))
      .send({ name: 'Local Form', phone: local, password: CUSTOMER_PASSWORD })
      .expect(201);

    for (const alternate of [`91${local}`, `0${local}`, `+91${local}`, `+91 ${local}`]) {
      const duplicate = await request(app)
        .post('/api/v1/admin/customers')
        .set('Cookie', cookieHeader(issued.tokens.access))
        .send({
          name: `Alt ${alternate}`,
          phone: alternate,
          password: CUSTOMER_PASSWORD,
        });
      expect(duplicate.status).toBe(409);
      expect(duplicate.body.error?.code).toBe('DUPLICATE_PHONE');
    }
    expect(await User.countDocuments({ phone: canonical })).toBe(1);
  });

  it('allows only one winner under concurrent creates for one mobile', async () => {
    const admin = await seedAdmin();
    const phone = '+917182900105';
    const results = await Promise.allSettled(
      Array.from({ length: 8 }, (_, index) =>
        createCustomer(
          {
            name: `Race ${index}`,
            phone,
            password: CUSTOMER_PASSWORD,
          },
          adminCtx(String(admin._id), `dup-race-${index}`),
        ),
      ),
    );

    const fulfilled = results.filter((row) => row.status === 'fulfilled');
    const rejected = results.filter((row) => row.status === 'rejected');
    expect(fulfilled.length).toBe(1);
    expect(rejected.length).toBe(7);
    for (const row of rejected) {
      expect(row.status).toBe('rejected');
      if (row.status === 'rejected') {
        expect(row.reason).toMatchObject({ code: 'DUPLICATE_PHONE', statusCode: 409 });
      }
    }
    expect(await User.countDocuments({ phone, role: 'CUSTOMER' })).toBe(1);
    expect(await Customer.countDocuments()).toBe(1);
  });

  it('still allows a genuinely new STAFF-created customer and login', async () => {
    await seedAdmin();
    await seedStaff();
    const staffLogin = await login(STAFF_PHONE, STAFF_PASSWORD, { ip: '127.0.0.1' });
    const phone = '+917182900106';
    const created = await request(app)
      .post('/api/v1/staff/customers')
      .set('Cookie', cookieHeader(staffLogin.tokens.access))
      .send({ name: 'Fresh Customer', phone, password: CUSTOMER_PASSWORD });
    expect(created.status).toBe(201);

    const customerLogin = await login(phone, CUSTOMER_PASSWORD, { ip: '127.0.0.1' });
    expect(customerLogin.tokens.access).toBeTruthy();
    const user = await User.findOne({ phone, role: 'CUSTOMER' });
    expect(user).toBeTruthy();
    expect(user!.status).toBe('ACTIVE');
  });
});
