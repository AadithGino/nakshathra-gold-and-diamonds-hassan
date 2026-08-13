import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { app } from '../src/app.js';
import { business, LIVE_SCHEME_TYPE } from '../src/config/business.js';
import { openapi } from '../src/config/openapi.js';
import { REQUIRED_INDEXES, verifyRequiredIndexes } from '../src/indexes/critical-indexes.js';
import { Payment, User } from '../src/models/index.js';
import { runFinancialIntegrityChecks } from '../src/scripts/financial-integrity-check.js';
import { hashPassword, login } from '../src/services/auth.service.js';
import { periodBounds } from '../src/services/accounting-period.service.js';
import { createStaff } from '../src/services/staff.service.js';
import { AppError } from '../src/utils/AppError.js';
import { paise, paiseFromUnknown } from '../src/utils/money.js';
import { paiseAmount } from '../src/utils/zod-money.js';
import { clearTestMongo, startTestMongo, stopTestMongo } from './helpers/mongo.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const ADMIN_PHONE = '+917181800001';
const ADMIN_PASSWORD = 'AdminPass123!';
const STAFF_PHONE = '+917181800002';
const STAFF_PASSWORD = 'StaffPass123!';
const LOCK_PHONE = '+917181800099';
const LOCK_PASSWORD = 'LockPass123!';

function cookieHeader(access: string) {
  return `access_token=${access}`;
}

async function seedAdmin() {
  const [admin] = await User.create([
    {
      name: 'Phase8 Admin',
      phone: ADMIN_PHONE,
      passwordHash: await hashPassword(ADMIN_PASSWORD),
      role: 'ADMIN',
      status: 'ACTIVE',
    },
  ]);
  return admin;
}

describe('Phase 8 — final production verification', () => {
  beforeAll(async () => {
    await startTestMongo();
  }, 120_000);

  afterAll(async () => {
    await stopTestMongo();
  });

  beforeEach(async () => {
    await clearTestMongo();
  });

  it('locks an account atomically after five failed logins and keeps concurrent failures from skipping the lock', async () => {
    await User.create([
      {
        name: 'Lock User',
        phone: LOCK_PHONE,
        passwordHash: await hashPassword(LOCK_PASSWORD),
        role: 'ADMIN',
        status: 'ACTIVE',
      },
    ]);

    for (let attempt = 0; attempt < 5; attempt += 1) {
      await expect(login(LOCK_PHONE, 'WrongPass123!', { ip: '127.0.0.1' })).rejects.toMatchObject({
        code: 'INVALID_CREDENTIALS',
        statusCode: 401,
      });
    }

    await expect(login(LOCK_PHONE, LOCK_PASSWORD, { ip: '127.0.0.1' })).rejects.toMatchObject({
      code: 'ACCOUNT_LOCKED',
      statusCode: 429,
    });

    const locked = await User.findOne({ phone: LOCK_PHONE }).select('+failedLoginCount +lockedUntil');
    expect(locked?.failedLoginCount).toBeGreaterThanOrEqual(5);
    expect(locked?.lockedUntil).toBeInstanceOf(Date);
    expect(locked!.lockedUntil!.getTime()).toBeGreaterThan(Date.now());

    await User.updateOne(
      { phone: LOCK_PHONE },
      { $set: { failedLoginCount: 0, lockedUntil: null } },
    );

    const concurrent = await Promise.allSettled(
      Array.from({ length: 8 }, () => login(LOCK_PHONE, 'WrongPass123!', { ip: '127.0.0.1' })),
    );
    expect(concurrent.every((row) => row.status === 'rejected')).toBe(true);

    const afterRace = await User.findOne({ phone: LOCK_PHONE }).select(
      '+failedLoginCount +lockedUntil',
    );
    expect(afterRace?.failedLoginCount).toBeGreaterThanOrEqual(5);
    expect(afterRace?.lockedUntil).toBeInstanceOf(Date);

    const http = await request(app)
      .post('/api/v1/auth/login')
      .send({ phone: LOCK_PHONE, password: LOCK_PASSWORD });
    expect(http.status).toBe(429);
    expect(http.body.error?.code).toBe('ACCOUNT_LOCKED');
  });

  it('rejects non-integer and negative paise at the money helper, Zod schema, and staff collection HTTP boundary', async () => {
    expect(() => paise(100.5)).toThrow(AppError);
    expect(() => paise(-1)).toThrow(AppError);
    expect(() => paiseFromUnknown(10.25, 'Amount')).toThrow(AppError);
    expect(() => paiseFromUnknown('100.50', 'Amount')).toThrow(AppError);
    expect(() => paiseFromUnknown('1e2', 'Amount')).toThrow(AppError);
    expect(paiseFromUnknown('1000')).toBe(1000);
    expect(paiseAmount().safeParse(100.5).success).toBe(false);
    expect(paiseAmount().safeParse(0).success).toBe(false);
    expect(paiseAmount().safeParse(50000).success).toBe(true);

    const admin = await seedAdmin();
    await createStaff(
      {
        name: 'Phase8 Collector',
        phone: STAFF_PHONE,
        password: STAFF_PASSWORD,
        employeeCode: 'NKS-S801',
        permissions: ['canCollectPayment'],
      },
      { actorId: String(admin._id), actorRole: 'ADMIN', requestId: 'p8-staff' },
    );
    const issued = await login(STAFF_PHONE, STAFF_PASSWORD, { ip: '127.0.0.1' });
    const response = await request(app)
      .post('/api/v1/staff/payments')
      .set('Cookie', cookieHeader(issued.tokens.access))
      .send({
        customerId: String(admin._id),
        schemeId: String(admin._id),
        amountPaise: 100.5,
        method: 'CASH',
        paymentDate: '2026-08-13',
        idempotencyKey: 'phase8-float-amount',
      });
    expect(response.status).toBe(422);
  });

  it('rejects invalid accounting-period months instead of wrapping into the next year', () => {
    expect(() => periodBounds('2026-13')).toThrow(AppError);
    expect(() => periodBounds('2026-00')).toThrow(AppError);
    expect(() => periodBounds('2026-1')).toThrow(AppError);
    expect(() => periodBounds('August-2026')).toThrow(AppError);
    try {
      periodBounds('2026-13');
    } catch (error) {
      expect(error).toMatchObject({
        code: 'VALIDATION_ERROR',
        statusCode: 422,
      });
    }
    const august = periodBounds('2026-08');
    expect(august.endsAt.getTime()).toBeGreaterThan(august.startsAt.getTime());
  });

  it('lets the owner create a customer over HTTP with a Nakshathra passbook', async () => {
    await seedAdmin();
    const issued = await login(ADMIN_PHONE, ADMIN_PASSWORD, { ip: '127.0.0.1' });
    const created = await request(app)
      .post('/api/v1/admin/customers')
      .set('Cookie', cookieHeader(issued.tokens.access))
      .send({
        name: 'Owner Created',
        phone: '+917181800010',
        password: 'CustomerPass123!',
      })
      .expect(201);
    expect(created.body.data.customer.customerCode).toMatch(/^NKS-C\d{6}$/);
    expect(created.body.data.customer.kycStatus).toBe('NOT_SUBMITTED');
  });

  it('runs the financial integrity checker green on a valid CASH fixture and flags a blocking REFUNDED row without a refund', async () => {
    const empty = await runFinancialIntegrityChecks();
    expect(empty.ok).toBe(true);
    expect(empty.errors).toEqual([]);

    const [admin] = await User.create([
      {
        name: 'Integrity Admin',
        phone: '+917181800011',
        passwordHash: 'hash',
        role: 'ADMIN',
        status: 'ACTIVE',
      },
    ]);
    await Payment.create([
      {
        customerId: admin._id,
        schemeId: admin._id,
        amountPaise: 50_000,
        method: 'CASH',
        status: 'SUCCESS',
        paymentDate: new Date('2026-08-13T04:30:00.000Z'),
        schemeMonth: 1,
        receiptNumber: 'NKS-2026-0000001',
        collectorRole: 'ADMIN',
        createdBy: admin._id,
      },
    ]);
    const valid = await runFinancialIntegrityChecks();
    expect(valid.ok).toBe(true);
    expect(valid.counts.payments).toBe(1);

    await Payment.create([
      {
        customerId: admin._id,
        schemeId: admin._id,
        amountPaise: 10_000,
        method: 'CASH',
        status: 'REFUNDED',
        paymentDate: new Date('2026-08-13T04:30:00.000Z'),
        schemeMonth: 1,
        receiptNumber: 'NKS-2026-0000002',
        collectorRole: 'ADMIN',
        createdBy: admin._id,
      },
    ]);
    const blocked = await runFinancialIntegrityChecks();
    expect(blocked.ok).toBe(false);
    expect(blocked.errors.some((row) => /REFUNDED payment .* missing refundId/.test(row))).toBe(
      true,
    );
  });

  it('verifies critical unique indexes are physically present on a replica set', async () => {
    const report = await verifyRequiredIndexes();
    expect(report.ok).toBe(true);
    expect(report.mismatches).toEqual([]);
    const ids = REQUIRED_INDEXES.filter((index) => index.critical).map((index) => index.id);
    expect(ids).toEqual(
      expect.arrayContaining([
        'PAYMENT_MERCHANT_TXN_UNIQUE',
        'PAYMENT_RECEIPT_NUMBER_UNIQUE',
        'CUSTOMER_CODE_UNIQUE',
        'USER_PHONE_UNIQUE',
        'STAFF_PROFILE_USER_UNIQUE',
        'STAFF_EMPLOYEE_CODE_UNIQUE',
      ]),
    );
  });

  it('keeps OpenAPI CASH-only, GOLD_WEIGHT dormant, and ships in-repo backup/go-live docs', async () => {
    expect(business.enabledSchemeTypes).toEqual([LIVE_SCHEME_TYPE]);
    expect(openapi.info.title).toBe('Nakshathra Jewellers Scheme API');
    expect(openapi.info.description).toMatch(/GOLD_WEIGHT/);
    expect(openapi.info.description).toMatch(/dormant/i);
    expect(openapi.info.description).not.toMatch(/Kairali/i);
    expect(openapi.paths['/admin/reports/daily-collection']).toBeTruthy();
    expect(openapi.paths['/staff/payments']).toBeTruthy();
    expect(existsSync(join(ROOT, 'docs/BACKUP_RESTORE_RUNBOOK.md'))).toBe(true);
    expect(existsSync(join(ROOT, 'docs/PRODUCTION_GO_LIVE_CHECKLIST.md'))).toBe(true);

    const reportDate = await readFile(new URL('../src/utils/report-date.ts', import.meta.url), 'utf8');
    expect(reportDate).toContain('fromZonedTime');
    expect(reportDate).toContain('BUSINESS_TZ');
    expect(reportDate).not.toMatch(/new Date\('YYYY-MM-DDT00:00:00'\)/);
  });
});
