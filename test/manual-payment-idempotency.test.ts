import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { startOfMonth } from 'date-fns';
import { fromZonedTime, toZonedTime } from 'date-fns-tz';
import {
  Customer,
  GoldRate,
  IdempotencyRecord,
  Payment,
  SchemeEnrollment,
  SystemSetting,
  User,
} from '../src/models/index.js';
import { createManualPayment } from '../src/services/payment.service.js';
import { enrollmentDates } from '../src/services/scheme.service.js';
import { BUSINESS_TZ, businessDayRange } from '../src/utils/time.js';
import { clearTestMongo, startTestMongo, stopTestMongo } from './helpers/mongo.js';

const INSTALLMENT = 100_000;

async function seedManualFixture() {
  const [admin] = await User.create([
    {
      name: 'Manual Admin',
      phone: `+9177${String(Date.now()).slice(-8)}`,
      passwordHash: 'hash',
      role: 'ADMIN',
      status: 'ACTIVE',
    },
  ]);
  const [customerUser] = await User.create([
    {
      name: 'Manual Customer',
      phone: `+9178${String(Date.now()).slice(-8)}`,
      passwordHash: 'hash',
      role: 'CUSTOMER',
      status: 'ACTIVE',
    },
  ]);
  const [customer] = await Customer.create([
    {
      userId: customerUser._id,
      customerCode: `CUST-MAN-${Date.now()}`,
      status: 'ACTIVE',
      kycStatus: 'VERIFIED',
      createdBy: admin._id,
    },
  ]);

  const now = new Date();
  const startLocal = startOfMonth(toZonedTime(now, BUSINESS_TZ));
  const startDate = fromZonedTime(startLocal, BUSINESS_TZ);
  const dates = enrollmentDates(startDate, 11, 11);
  const [enrollment] = await SchemeEnrollment.create([
    {
      customerId: customer._id,
      schemePlanId: admin._id,
      enrollmentNumber: `ENR-MAN-${Date.now()}`,
      schemeType: 'GOLD_WEIGHT',
      startDate,
      ...dates,
      durationMonths: 11,
      flexibleMonths: 11,
      monthlyInstallmentPaise: INSTALLMENT,
      makingChargeWaiverPercent: 100,
      gstRateBasisPoints: 300,
      status: 'ACTIVE',
      createdBy: admin._id,
    },
  ]);

  const { start: todayStart } = businessDayRange(now);
  await GoldRate.create([
    {
      ratePerGramPaise: 700_000,
      purity: '916',
      effectiveFrom: todayStart,
      status: 'ACTIVE',
      createdBy: admin._id,
    },
  ]);
  await SystemSetting.create([{ singletonKey: 'GLOBAL', customerPhonePeEnabled: true }]);

  return { admin, customer, enrollment, paymentDate: now };
}

describe('manual payment concurrent idempotency', () => {
  beforeAll(async () => {
    await startTestMongo();
  });
  afterAll(async () => {
    await stopTestMongo();
  });
  beforeEach(async () => {
    await clearTestMongo();
  });

  it('20 simultaneous identical requests create one Payment and one receipt', async () => {
    const { admin, customer, enrollment, paymentDate } = await seedManualFixture();
    const input = {
      customerId: String(customer._id),
      schemeId: String(enrollment._id),
      amountPaise: INSTALLMENT,
      schemeMonth: 1,
      method: 'CASH' as const,
      paymentDate,
      idempotencyKey: 'manual-conc-00000001',
    };

    const settled = await Promise.allSettled(
      Array.from({ length: 20 }, (_, i) =>
        createManualPayment(input, {
          actorId: String(admin._id),
          actorRole: 'ADMIN',
          requestId: `man-${i}`,
        }),
      ),
    );

    const fulfilled = settled.filter((r) => r.status === 'fulfilled') as Array<
      PromiseFulfilledResult<{ paymentId: unknown; receiptNumber: string }>
    >;
    expect(fulfilled.length).toBe(20);
    const paymentIds = new Set(fulfilled.map((r) => String(r.value.paymentId)));
    const receipts = new Set(fulfilled.map((r) => r.value.receiptNumber));
    expect(paymentIds.size).toBe(1);
    expect(receipts.size).toBe(1);
    expect(await Payment.countDocuments({})).toBe(1);
    expect(await IdempotencyRecord.countDocuments({ key: input.idempotencyKey })).toBe(1);

    for (const r of settled) {
      if (r.status === 'rejected') {
        expect(String(r.reason)).not.toMatch(/E11000|11000/);
      }
    }
  });

  it('conflicting payloads with the same key return IDEMPOTENCY_KEY_REUSED', async () => {
    const { admin, customer, enrollment, paymentDate } = await seedManualFixture();
    const base = {
      customerId: String(customer._id),
      schemeId: String(enrollment._id),
      amountPaise: INSTALLMENT,
      schemeMonth: 1,
      method: 'CASH' as const,
      paymentDate,
      idempotencyKey: 'manual-conflict-0001',
    };

    await createManualPayment(base, {
      actorId: String(admin._id),
      actorRole: 'ADMIN',
      requestId: 'man-a',
    });

    await expect(
      createManualPayment(
        { ...base, method: 'UPI' },
        { actorId: String(admin._id), actorRole: 'ADMIN', requestId: 'man-b' },
      ),
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_KEY_REUSED' });

    expect(await Payment.countDocuments({})).toBe(1);
  });

  it('reclaims a stuck PROCESSING record without a lease after simulated crash', async () => {
    const { admin, customer, enrollment, paymentDate } = await seedManualFixture();
    const input = {
      customerId: String(customer._id),
      schemeId: String(enrollment._id),
      amountPaise: INSTALLMENT,
      schemeMonth: 1,
      method: 'CASH' as const,
      paymentDate,
      idempotencyKey: 'manual-stuck-lease-0001',
    };
    const { createHash } = await import('node:crypto');
    const hash = createHash('sha256').update(JSON.stringify(input)).digest('hex');

    await IdempotencyRecord.create([
      {
        actorId: admin._id,
        route: 'manual-payment',
        key: input.idempotencyKey,
        requestHash: hash,
        state: 'PROCESSING',
        expiresAt: new Date(Date.now() + 86_400_000),
        // Intentionally no processingLockUntil — pre-lease crash window.
      },
    ]);

    const result = await createManualPayment(input, {
      actorId: String(admin._id),
      actorRole: 'ADMIN',
      requestId: 'man-recover',
    });

    expect(result).toMatchObject({ status: 'SUCCESS', amountPaise: INSTALLMENT });
    expect(await Payment.countDocuments({})).toBe(1);
    const record = await IdempotencyRecord.findOne({ key: input.idempotencyKey });
    expect(record?.state).toBe('COMPLETED');
    expect(record?.processingLockUntil).toBeFalsy();
  });

  it('reclaims PROCESSING after an expired lease', async () => {
    const { admin, customer, enrollment, paymentDate } = await seedManualFixture();
    const input = {
      customerId: String(customer._id),
      schemeId: String(enrollment._id),
      amountPaise: INSTALLMENT,
      schemeMonth: 1,
      method: 'CASH' as const,
      paymentDate,
      idempotencyKey: 'manual-expired-lease-0001',
    };
    const { createHash } = await import('node:crypto');
    const hash = createHash('sha256').update(JSON.stringify(input)).digest('hex');

    await IdempotencyRecord.create([
      {
        actorId: admin._id,
        route: 'manual-payment',
        key: input.idempotencyKey,
        requestHash: hash,
        state: 'PROCESSING',
        processingLockedAt: new Date(Date.now() - 600_000),
        processingLockUntil: new Date(Date.now() - 60_000),
        expiresAt: new Date(Date.now() + 86_400_000),
      },
    ]);

    const result = await createManualPayment(input, {
      actorId: String(admin._id),
      actorRole: 'ADMIN',
      requestId: 'man-expired',
    });
    expect(result).toMatchObject({ status: 'SUCCESS' });
    expect(await Payment.countDocuments({})).toBe(1);
  });
});
