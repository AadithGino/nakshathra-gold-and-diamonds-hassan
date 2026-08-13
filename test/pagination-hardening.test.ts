import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import mongoose from 'mongoose';
import request from 'supertest';
import { app } from '../src/app.js';
import {
  AuditLog,
  CashSubmission,
  Customer,
  FinancialException,
  Payment,
  PaymentCorrection,
  PaymentIntent,
  Payout,
  Refund,
  SchemeEnrollment,
  StaffProfile,
  User,
} from '../src/models/index.js';
import { hashPassword, login } from '../src/services/auth.service.js';
import { listCustomers } from '../src/services/customer.service.js';
import { listPayments } from '../src/services/finance.service.js';
import { coerceBoundedListQuery } from '../src/utils/cursor-pagination.js';
import { clearTestMongo, startTestMongo, stopTestMongo } from './helpers/mongo.js';

const ADMIN_PHONE = '+917191000001';
const ADMIN_PASSWORD = 'AdminPass123!';
const STAFF_PHONE = '+917191000002';
const STAFF_PASSWORD = 'StaffPass123!';
const CUSTOMER_PHONE = '+917191000003';
const CUSTOMER_PASSWORD = 'CustomerPass123!';

function cookieHeader(access: string) {
  return `access_token=${access}`;
}

function oid() {
  return new mongoose.Types.ObjectId();
}

async function seedCore() {
  const [admin] = await User.create([
    {
      name: 'Page Admin',
      phone: ADMIN_PHONE,
      passwordHash: await hashPassword(ADMIN_PASSWORD),
      role: 'ADMIN',
      status: 'ACTIVE',
    },
  ]);
  const [staffUser] = await User.create([
    {
      name: 'Page Staff',
      phone: STAFF_PHONE,
      passwordHash: await hashPassword(STAFF_PASSWORD),
      role: 'STAFF',
      status: 'ACTIVE',
    },
  ]);
  await StaffProfile.create([
    {
      userId: staffUser._id,
      employeeCode: 'EMP-PAGE-1',
      permissions: ['canViewCustomers', 'canCollectPayment', 'canSubmitCorrectionRequest'],
      createdBy: admin._id,
    },
  ]);
  const [customerUser] = await User.create([
    {
      name: 'Page Customer',
      phone: CUSTOMER_PHONE,
      passwordHash: await hashPassword(CUSTOMER_PASSWORD),
      role: 'CUSTOMER',
      status: 'ACTIVE',
    },
  ]);
  const [customer] = await Customer.create([
    {
      userId: customerUser._id,
      customerCode: 'CUST-PAGE-1',
      status: 'ACTIVE',
      kycStatus: 'VERIFIED',
      createdBy: admin._id,
    },
  ]);
  const start = new Date('2026-01-01T00:00:00.000Z');
  const [enrollment] = await SchemeEnrollment.create([
    {
      customerId: customer._id,
      schemePlanId: admin._id,
      enrollmentNumber: 'ENR-PAGE-1',
      schemeType: 'CASH',
      startDate: start,
      flexiblePeriodEndDate: new Date('2026-12-01T00:00:00.000Z'),
      maturityDate: new Date('2026-12-01T00:00:00.000Z'),
      redemptionStartDate: new Date('2026-12-01T00:00:00.000Z'),
      redemptionEndDate: new Date('2027-12-01T00:00:00.000Z'),
      durationMonths: 11,
      flexibleMonths: 11,
      monthlyInstallmentPaise: 100_000,
      makingChargeWaiverPercent: 100,
      gstRateBasisPoints: 300,
      prematureClosureEnabled: true,
      prematureClosureMinPaidInstallments: 1,
      prematureClosureSettlementAssets: ['CASH'],
      maturitySettlementAssets: ['CASH'],
      paymentsCompleted: 1,
      status: 'ACTIVE',
      createdBy: admin._id,
    },
  ]);
  return { admin, staffUser, customerUser, customer, enrollment };
}

async function loginAdmin() {
  const issued = await login(ADMIN_PHONE, ADMIN_PASSWORD, { ip: '127.0.0.1' });
  return cookieHeader(issued.tokens.access);
}

function expectCursorPage(body: any, opts?: { max?: number; hasMore?: boolean }) {
  expect(body.success).toBe(true);
  expect(Array.isArray(body.data)).toBe(true);
  expect(body.data.length).toBeLessThanOrEqual(opts?.max ?? 50);
  expect(body.meta).toMatchObject({
    mode: 'cursor',
    limit: expect.any(Number),
    hasMore: expect.any(Boolean),
  });
  expect(body.meta.limit).toBeLessThanOrEqual(100);
  expect(body.meta.mode).not.toBe('legacy-all');
  if (opts?.hasMore === false) {
    expect(body.meta.hasMore).toBe(false);
    expect(body.meta.nextCursor == null || body.meta.nextCursor === null).toBe(true);
  }
  if (body.meta.hasMore) {
    expect(typeof body.meta.nextCursor).toBe('string');
    expect(body.meta.nextCursor.length).toBeGreaterThan(8);
  }
}

describe('production cursor pagination hardening', () => {
  beforeAll(async () => {
    await startTestMongo();
  }, 120_000);

  afterAll(async () => {
    await stopTestMongo();
  });

  beforeEach(async () => {
    await clearTestMongo();
  });

  it('HTTP list endpoints without pagination params return a bounded first cursor page', async () => {
    const { admin, staffUser, customerUser, customer, enrollment } = await seedCore();
    const now = new Date();
    await Payment.create([
      {
        customerId: customer._id,
        schemeId: enrollment._id,
        amountPaise: 100_000,
        method: 'CASH',
        status: 'SUCCESS',
        paymentDate: now,
        schemeMonth: 1,
        collectorRole: 'ADMIN',
        collectedBy: admin._id,
        createdBy: admin._id,
      },
      {
        customerId: customer._id,
        schemeId: enrollment._id,
        amountPaise: 100_000,
        method: 'CASH',
        status: 'SUCCESS',
        paymentDate: now,
        schemeMonth: 2,
        collectorRole: 'STAFF',
        collectedBy: staffUser._id,
        createdBy: staffUser._id,
      },
    ]);
    await Payout.create([
      {
        customerId: customer._id,
        schemeId: enrollment._id,
        amountPaise: 100_000,
        settlementPrincipalPaise: 100_000,
        payoutType: 'PREMATURE_CLOSE',
        method: 'CASH',
        payoutDate: now,
        status: 'SUCCESS',
        createdBy: admin._id,
      },
    ]);
    await Refund.create([
      {
        paymentId: oid(),
        customerId: customer._id,
        schemeId: enrollment._id,
        merchantRefundId: 'MRF-PAGE-1',
        originalMerchantOrderId: 'MO-PAGE-1',
        amountPaise: 100_000,
        status: 'PENDING',
        attemptNumber: 1,
        active: true,
        reason: 'test',
        idempotencyKey: 'refund-page-1',
        requestHash: 'hash-page-1',
        requestedBy: admin._id,
        requestedAt: now,
      },
    ]);
    await PaymentCorrection.create([
      {
        paymentId: oid(),
        requestedBy: staffUser._id,
        correctionType: 'CHANGE_NOTES',
        originalSnapshot: { notes: 'a' },
        requestedChanges: { notes: 'b' },
        reason: 'typo',
        status: 'PENDING',
      },
    ]);
    await CashSubmission.create([
      {
        staffId: staffUser._id,
        amountPaise: 50_000,
        submissionDate: now,
        receivedBy: admin._id,
        createdBy: staffUser._id,
        status: 'SUCCESS',
      },
    ]);
    await AuditLog.create([
      {
        actorId: admin._id,
        actorRole: 'ADMIN',
        action: 'CUSTOMER_CREATED',
        entityType: 'Customer',
        entityId: customer._id,
      },
    ]);
    await FinancialException.create([
      {
        type: 'PAYMENT_AMOUNT_MISMATCH',
        severity: 'HIGH',
        status: 'OPEN',
        dedupeKey: 'page-exception-1',
        title: 'Mismatch',
        firstSeenAt: now,
        lastSeenAt: now,
        occurrenceCount: 1,
        agingBucket: 'NEW',
      },
    ]);
    await PaymentIntent.create([
      {
        customerId: customer._id,
        schemeId: enrollment._id,
        amountPaise: 100_000,
        merchantTransactionId: 'MTX-PAGE-1',
        status: 'PENDING',
        idempotencyKey: 'intent-page-1',
        idempotencyScope: 'PHONEPE_CUSTOMER_WEB',
        requestHash: 'intent-hash-1',
        createdBy: customerUser._id,
      },
    ]);

    const adminCookie = await loginAdmin();
    const staffIssued = await login(STAFF_PHONE, STAFF_PASSWORD, { ip: '127.0.0.1' });
    const customerIssued = await login(CUSTOMER_PHONE, CUSTOMER_PASSWORD, { ip: '127.0.0.1' });
    const staffCookie = cookieHeader(staffIssued.tokens.access);
    const customerCookie = cookieHeader(customerIssued.tokens.access);

    const endpoints: Array<{ path: string; cookie: string }> = [
      { path: '/api/v1/admin/customers', cookie: adminCookie },
      { path: '/api/v1/admin/staff', cookie: adminCookie },
      { path: '/api/v1/admin/enrollments', cookie: adminCookie },
      { path: '/api/v1/admin/payments', cookie: adminCookie },
      { path: '/api/v1/customer/payments', cookie: customerCookie },
      { path: '/api/v1/admin/payouts', cookie: adminCookie },
      { path: '/api/v1/admin/refunds', cookie: adminCookie },
      { path: '/api/v1/admin/corrections', cookie: adminCookie },
      { path: '/api/v1/admin/cash-submissions', cookie: adminCookie },
      { path: '/api/v1/admin/audit-logs', cookie: adminCookie },
      { path: '/api/v1/admin/finance/exceptions', cookie: adminCookie },
      { path: '/api/v1/admin/phonepe-transactions', cookie: adminCookie },
      { path: '/api/v1/staff/customers', cookie: staffCookie },
      { path: '/api/v1/staff/payments', cookie: staffCookie },
      { path: '/api/v1/staff/corrections', cookie: staffCookie },
      { path: '/api/v1/staff/cash-submissions', cookie: staffCookie },
      { path: '/api/v1/customer/payouts', cookie: customerCookie },
      { path: '/api/v1/customer/notifications', cookie: customerCookie },
      { path: '/api/v1/admin/finance/suspense', cookie: adminCookie },
      { path: '/api/v1/admin/finance/disputes', cookie: adminCookie },
      { path: '/api/v1/admin/finance/gateway-settlements', cookie: adminCookie },
    ];

    for (const endpoint of endpoints) {
      const res = await request(app)
        .get(endpoint.path)
        .set('Cookie', endpoint.cookie)
        .expect(200);
      expectCursorPage(res.body);
      expect(res.body.data.length).toBeGreaterThanOrEqual(0);
    }
  });

  it('enforces max limit 100 and keeps offset compatibility bounded', async () => {
    const { admin } = await seedCore();
    const users = Array.from({ length: 120 }, (_, i) => ({
      name: `Bulk ${i}`,
      phone: `+917192${String(i).padStart(6, '0')}`,
      passwordHash: 'x',
      role: 'CUSTOMER' as const,
      status: 'ACTIVE' as const,
      createdBy: admin._id,
    }));
    const inserted = await User.insertMany(users);
    await Customer.insertMany(
      inserted.map((user, i) => ({
        userId: user._id,
        customerCode: `BULK-${String(i).padStart(4, '0')}`,
        status: 'ACTIVE',
        kycStatus: 'NOT_SUBMITTED',
        createdBy: admin._id,
      })),
    );
    const cookie = await loginAdmin();

    const unset = await request(app).get('/api/v1/admin/customers').set('Cookie', cookie).expect(200);
    expectCursorPage(unset.body, { max: 50 });
    expect(unset.body.data).toHaveLength(50);
    expect(unset.body.meta.hasMore).toBe(true);
    expect(unset.body.meta.limit).toBe(50);

    const fifty = await request(app)
      .get('/api/v1/admin/customers')
      .query({ limit: 50 })
      .set('Cookie', cookie)
      .expect(200);
    expect(fifty.body.data).toHaveLength(50);
    expect(fifty.body.meta.mode).toBe('cursor');
    expect(fifty.body.meta.limit).toBe(50);

    const hundred = await request(app)
      .get('/api/v1/admin/customers')
      .query({ limit: 100 })
      .set('Cookie', cookie)
      .expect(200);
    expect(hundred.body.data).toHaveLength(100);
    expect(hundred.body.meta.limit).toBe(100);

    const oversized = await request(app)
      .get('/api/v1/admin/customers')
      .query({ limit: 1000 })
      .set('Cookie', cookie)
      .expect(200);
    expect(oversized.body.data).toHaveLength(100);
    expect(oversized.body.meta.mode).toBe('cursor');
    expect(oversized.body.meta.limit).toBe(100);

    const offset = await request(app)
      .get('/api/v1/admin/customers')
      .query({ page: 1, limit: 20 })
      .set('Cookie', cookie)
      .expect(200);
    expect(offset.body.data).toHaveLength(20);
    expect(offset.body.meta).toMatchObject({ mode: 'offset', page: 1, limit: 20 });
    expect(offset.body.meta.total).toBeGreaterThan(100);
  });

  it('continues cursor pages without duplicates or skips, including tied createdAt', async () => {
    const { admin } = await seedCore();
    const tied = new Date('2026-03-01T12:00:00.000Z');
    const extraUsers = await User.insertMany(
      Array.from({ length: 7 }, (_, i) => ({
        name: `Tie ${i}`,
        phone: `+917193${String(i).padStart(6, '0')}`,
        passwordHash: 'x',
        role: 'CUSTOMER' as const,
        status: 'ACTIVE' as const,
      })),
    );
    const extraCustomers = extraUsers.map((user, i) => ({
      _id: new mongoose.Types.ObjectId(),
      userId: user._id,
      customerCode: `TIE-${String(i).padStart(3, '0')}`,
      status: 'ACTIVE',
      kycStatus: 'NOT_SUBMITTED',
      createdBy: admin._id,
      createdAt: tied,
      updatedAt: tied,
    }));
    extraCustomers.sort((a, b) => String(b._id).localeCompare(String(a._id)));
    await Customer.insertMany(extraCustomers);

    const cookie = await loginAdmin();
    const seen = new Set<string>();
    let cursor: string | null = null;
    let pages = 0;
    let hasMore = true;
    while (hasMore && pages < 10) {
      const res = await request(app)
        .get('/api/v1/admin/customers')
        .query(cursor ? { cursor, limit: 3 } : { limit: 3 })
        .set('Cookie', cookie)
        .expect(200);
      expect(res.body.meta.mode).toBe('cursor');
      expect(res.body.data.length).toBeLessThanOrEqual(3);
      for (const row of res.body.data) {
        const id = String(row._id);
        expect(seen.has(id)).toBe(false);
        seen.add(id);
      }
      hasMore = res.body.meta.hasMore;
      cursor = res.body.meta.nextCursor;
      pages += 1;
      if (!hasMore) {
        expect(cursor).toBeNull();
      }
    }
    expect(seen.size).toBe(await Customer.countDocuments());
    expect(pages).toBeGreaterThan(1);

    const first = await request(app)
      .get('/api/v1/admin/customers')
      .query({ search: 'Tie 0', limit: 10 })
      .set('Cookie', cookie)
      .expect(200);
    expect(first.body.meta.mode).toBe('cursor');
    expect(first.body.data.some((row: { customerCode: string }) => row.customerCode === 'TIE-000')).toBe(
      true,
    );
  });

  it('rejects a malformed cursor with 422 and does not crash', async () => {
    await seedCore();
    const cookie = await loginAdmin();
    const res = await request(app)
      .get('/api/v1/admin/customers')
      .query({ cursor: 'not-a-valid-cursor' })
      .set('Cookie', cookie)
      .expect(422);
    expect(res.body.error.code).toBe('INVALID_CURSOR');
  });

  it('keeps payment cursor continuation deterministic with identical paymentDate', async () => {
    const { admin, customer, enrollment } = await seedCore();
    const tied = new Date('2026-04-15T08:00:00.000Z');
    await Payment.insertMany(
      Array.from({ length: 8 }, (_, i) => ({
        customerId: customer._id,
        schemeId: enrollment._id,
        amountPaise: 100_000,
        method: 'CASH',
        status: i % 2 === 0 ? 'SUCCESS' : 'PENDING',
        paymentDate: tied,
        schemeMonth: (i % 11) + 1,
        collectorRole: 'ADMIN',
        collectedBy: admin._id,
        createdBy: admin._id,
        createdAt: tied,
        updatedAt: tied,
      })),
    );

    const page1 = await listPayments({ mode: 'cursor', cursor: null, limit: 3 });
    expect(page1.meta?.mode).toBe('cursor');
    expect(page1.items).toHaveLength(3);
    expect(page1.meta && 'hasMore' in page1.meta && page1.meta.hasMore).toBe(true);
    const page2 = await listPayments({
      mode: 'cursor',
      cursor: page1.meta && 'nextCursor' in page1.meta ? page1.meta.nextCursor : null,
      limit: 3,
    });
    const page3 = await listPayments({
      mode: 'cursor',
      cursor: page2.meta && 'nextCursor' in page2.meta ? page2.meta.nextCursor : null,
      limit: 3,
    });
    const ids = [...page1.items, ...page2.items, ...page3.items].map((row) => String(row._id));
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toHaveLength(8);
    expect(page3.meta && 'hasMore' in page3.meta && page3.meta.hasMore).toBe(false);
    expect(page3.meta && 'nextCursor' in page3.meta ? page3.meta.nextCursor : 'x').toBeNull();
  });

  it('does not enter legacy-all for HTTP or leftover internal queries', async () => {
    const { admin } = await seedCore();
    await User.insertMany(
      Array.from({ length: 60 }, (_, i) => ({
        name: `Legacy ${i}`,
        phone: `+917194${String(i).padStart(6, '0')}`,
        passwordHash: 'x',
        role: 'CUSTOMER' as const,
        status: 'ACTIVE' as const,
      })),
    ).then(async (users) => {
      await Customer.insertMany(
        users.map((user, i) => ({
          userId: user._id,
          customerCode: `LEG-${String(i).padStart(3, '0')}`,
          status: 'ACTIVE',
          kycStatus: 'NOT_SUBMITTED',
          createdBy: admin._id,
        })),
      );
    });
    const cookie = await loginAdmin();
    const res = await request(app).get('/api/v1/admin/customers').set('Cookie', cookie).expect(200);
    expect(res.body.meta.mode).toBe('cursor');
    expect(res.body.meta.mode).not.toBe('legacy-all');
    expect(res.body.data).toHaveLength(50);

    const coerced = coerceBoundedListQuery({ mode: 'legacy-all' });
    const leftover = await listCustomers(coerced, '');
    expect(leftover.meta?.mode).toBe('cursor');
    expect(leftover.items).toHaveLength(50);
    expect(leftover.items.length).toBeLessThan(await Customer.countDocuments());
  });

  it('does not materialize a large matching collection when listing customers', async () => {
    const { admin } = await seedCore();
    const batchSize = 500;
    for (let batch = 0; batch < 5; batch += 1) {
      const users = await User.insertMany(
        Array.from({ length: batchSize }, (_, i) => {
          const n = batch * batchSize + i;
          return {
            name: `Scale ${n}`,
            phone: `+917195${String(n).padStart(6, '0')}`,
            passwordHash: 'x',
            role: 'CUSTOMER' as const,
            status: 'ACTIVE' as const,
          };
        }),
      );
      await Customer.insertMany(
        users.map((user, i) => {
          const n = batch * batchSize + i;
          return {
            userId: user._id,
            customerCode: `SCL-${String(n).padStart(5, '0')}`,
            status: 'ACTIVE',
            kycStatus: 'NOT_SUBMITTED',
            createdBy: admin._id,
          };
        }),
      );
    }
    const total = await Customer.countDocuments();
    expect(total).toBeGreaterThan(2000);
    const started = Date.now();
    const page = await listCustomers({ mode: 'cursor', cursor: null, limit: 50 }, '');
    const elapsed = Date.now() - started;
    expect(page.items).toHaveLength(50);
    expect(page.meta?.mode).toBe('cursor');
    expect(page.meta && 'hasMore' in page.meta && page.meta.hasMore).toBe(true);
    expect(elapsed).toBeLessThan(15_000);
  }, 60_000);
});
