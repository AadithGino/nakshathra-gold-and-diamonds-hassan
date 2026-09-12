import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  AuditLog,
  Customer,
  OutboxEvent,
  Payment,
  PaymentIntent,
  Payout,
  Refund,
  SchemeEnrollment,
  User,
} from '../src/models/index.js';
import {
  countRedemptionReadyEnrollments,
  listDueEnrollments,
  listOverdueEnrollments,
  listRedemptionReadyEnrollments,
} from '../src/services/enrollment-collection.service.js';
import {
  cancelEnrollment,
  updateEnrollmentStatus,
} from '../src/services/scheme-management.service.js';
import { financialDashboard } from '../src/services/report.service.js';
import { enrollmentDates } from '../src/services/scheme.service.js';
import { AppError } from '../src/utils/AppError.js';
import { schemeAdminRouter } from '../src/routes/admin/scheme-admin.routes.js';
import { clearTestMongo, startTestMongo, stopTestMongo } from './helpers/mongo.js';

let seq = 0;
function phone() {
  seq += 1;
  return `+917700${String(seq).padStart(6, '0')}`;
}

function routeIndex(path: string) {
  return schemeAdminRouter.stack.findIndex((layer: any) => layer.route?.path === path);
}

async function seedActor() {
  const suffix = `${Date.now()}-${seq}`;
  const [actor] = await User.create([
    { name: 'Ops Admin', phone: phone(), passwordHash: 'hash', role: 'ADMIN', status: 'ACTIVE' },
  ]);
  const [customerUser] = await User.create([
    { name: 'Ops Customer', phone: phone(), passwordHash: 'hash', role: 'CUSTOMER', status: 'ACTIVE' },
  ]);
  const [customer] = await Customer.create([
    {
      userId: customerUser._id,
      customerCode: `CUST-OPS-${suffix}`,
      status: 'ACTIVE',
      kycStatus: 'VERIFIED',
      createdBy: actor._id,
    },
  ]);
  return { actor, customerUser, customer, suffix };
}

async function seedEnrollment(opts: {
  startDate: Date;
  paidMonths?: number[];
  status?: 'ACTIVE' | 'MATURED' | 'REDEEMED' | 'CLOSED' | 'CANCELLED';
  enrollmentNumber?: string;
  paymentsCompleted?: number;
  redemptionStartDate?: Date;
  redemptionEndDate?: Date;
  phoneName?: { name: string; phone: string };
  schemeType?: 'CASH' | 'GOLD_WEIGHT';
}) {
  const { actor, customerUser, customer, suffix } = await seedActor();
  if (opts.phoneName) {
    customerUser.name = opts.phoneName.name;
    customerUser.phone = opts.phoneName.phone;
    await customerUser.save();
  }
  const dates = enrollmentDates(opts.startDate, 11, 11);
  const [enrollment] = await SchemeEnrollment.create([
    {
      customerId: customer._id,
      schemePlanId: actor._id,
      enrollmentNumber: opts.enrollmentNumber ?? `ENR-OPS-${suffix}`,
      schemeType: opts.schemeType ?? 'GOLD_WEIGHT',
      startDate: opts.startDate,
      ...dates,
      ...(opts.redemptionStartDate ? { redemptionStartDate: opts.redemptionStartDate } : {}),
      ...(opts.redemptionEndDate ? { redemptionEndDate: opts.redemptionEndDate } : {}),
      durationMonths: 11,
      flexibleMonths: 11,
      monthlyInstallmentPaise: 100_000,
      makingChargeWaiverPercent: 100,
      gstRateBasisPoints: 300,
      paymentWindowType: 'FIXED_DAY',
      fixedPaymentDay: 5,
      prematureClosureEnabled: true,
      prematureClosureMinPaidInstallments: 1,
      prematureClosureSettlementAssets: ['GOLD', 'CASH'],
      maturitySettlementAssets: ['GOLD', 'CASH'],
      prematureClosureCashBasis: 'CONTRIBUTION_VALUE',
      maturityCashBasis: 'CONTRIBUTION_VALUE',
      paymentsCompleted: opts.paymentsCompleted ?? opts.paidMonths?.length ?? 0,
      status: opts.status ?? 'ACTIVE',
      createdBy: actor._id,
    },
  ]);
  for (const month of opts.paidMonths ?? []) {
    await Payment.create([
      {
        customerId: customer._id,
        schemeId: enrollment._id,
        amountPaise: 100_000,
        method: 'UPI',
        status: 'SUCCESS',
        paymentDate: opts.startDate,
        schemeMonth: month,
        receiptNumber: `KRL-OPS-${suffix}-${month}`,
        goldWeightMg: 142,
        goldRatePerGramPaise: 700_000,
        collectorRole: 'ADMIN',
        createdBy: actor._id,
      },
    ]);
  }
  return { actor, customer, customerUser, enrollment };
}

const listQuery = { mode: 'offset' as const, page: 1, limit: 50 };

describe('scheme collection APIs and cancellation', () => {
  beforeAll(async () => {
    await startTestMongo();
  }, 120_000);
  afterAll(async () => {
    await stopTestMongo();
  });
  beforeEach(async () => {
    await clearTestMongo();
  });

  it('registers literal overdue/due/redemption-ready routes before :id', () => {
    expect(routeIndex('/enrollments/overdue')).toBeGreaterThanOrEqual(0);
    expect(routeIndex('/enrollments/due')).toBeGreaterThanOrEqual(0);
    expect(routeIndex('/enrollments/redemption-ready')).toBeGreaterThanOrEqual(0);
    expect(routeIndex('/enrollments/overdue')).toBeLessThan(routeIndex('/enrollments/:id'));
    expect(routeIndex('/enrollments/due')).toBeLessThan(routeIndex('/enrollments/:id'));
    expect(routeIndex('/enrollments/redemption-ready')).toBeLessThan(routeIndex('/enrollments/:id'));
  });

  it('returns every overdue month with counts and oldest days', async () => {
    const { enrollment, customer } = await seedEnrollment({
      startDate: new Date('2026-01-01T00:00:00+05:30'),
      paidMonths: [1],
    });
    const at = new Date('2026-03-20T12:00:00+05:30');
    const page = await listOverdueEnrollments(listQuery, {}, at);
    const row = page.items.find((item) => item.enrollmentId === String(enrollment._id));
    expect(row).toBeTruthy();
    expect(row.overdueCount).toBe(2);
    expect(row.totalOverduePaise).toBe(200_000);
    expect(row.oldestDaysOverdue).toBeGreaterThan(0);
    expect(row.overdueInstallments.map((item: any) => item.schemeMonth)).toEqual([2, 3]);
    expect(row.nextPayableSchemeMonth).toBe(2);

    const filtered = await listOverdueEnrollments(listQuery, { customerId: String(customer._id) }, at);
    expect(filtered.items).toHaveLength(1);
  });

  it('excludes paid installments, terminal enrollments, and supports search', async () => {
    const live = await seedEnrollment({
      startDate: new Date('2026-01-01T00:00:00+05:30'),
      paidMonths: [1, 2],
      enrollmentNumber: 'ENR-SEARCH-77',
      phoneName: { name: 'Kavya Nair', phone: '+919876543210' },
    });
    await seedEnrollment({
      startDate: new Date('2026-01-01T00:00:00+05:30'),
      status: 'CANCELLED',
      enrollmentNumber: 'ENR-DEAD-01',
    });
    const page = await listOverdueEnrollments(
      listQuery,
      { search: 'ENR-SEARCH-77' },
      new Date('2026-03-20T12:00:00+05:30'),
    );
    expect(page.items).toHaveLength(1);
    expect(page.items[0].overdueInstallments.every((item: any) => item.schemeMonth !== 1)).toBe(true);
    const byPhone = await listOverdueEnrollments(
      listQuery,
      { search: '9876543210' },
      new Date('2026-03-20T12:00:00+05:30'),
    );
    expect(byPhone.items.some((item) => item.enrollmentId === String(live.enrollment._id))).toBe(true);
    const dead = await listOverdueEnrollments(
      listQuery,
      { search: 'ENR-DEAD-01' },
      new Date('2026-03-20T12:00:00+05:30'),
    );
    expect(dead.items).toHaveLength(0);
  });

  it('lists currently due months and flags older overdue', async () => {
    await seedEnrollment({
      startDate: new Date('2026-01-01T00:00:00+05:30'),
      paidMonths: [],
    });
    const page = await listDueEnrollments(
      listQuery,
      {},
      new Date('2026-03-05T12:00:00+05:30'),
    );
    const dueRows = page.items.filter((item) => item.schemeMonth === 3);
    expect(dueRows.length).toBeGreaterThan(0);
    expect(dueRows[0].hasOlderOverdue).toBe(true);
    expect(dueRows[0].nextPayableSchemeMonth).toBe(1);
  });

  it('includes objectively ready enrollments in redemption-ready and excludes incomplete/blocked', async () => {
    const now = new Date();
    const ready = await seedEnrollment({
      startDate: new Date('2025-08-01T00:00:00+05:30'),
      paidMonths: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11],
      paymentsCompleted: 11,
      status: 'MATURED',
      redemptionStartDate: new Date(now.getTime() - 86_400_000),
      redemptionEndDate: new Date(now.getTime() + 10 * 86_400_000),
    });
    await seedEnrollment({
      startDate: new Date('2025-08-01T00:00:00+05:30'),
      paidMonths: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
      paymentsCompleted: 10,
      redemptionStartDate: new Date(now.getTime() - 86_400_000),
      redemptionEndDate: new Date(now.getTime() + 10 * 86_400_000),
    });
    const page = await listRedemptionReadyEnrollments(listQuery, {});
    expect(page.items.some((item) => item.enrollmentId === String(ready.enrollment._id))).toBe(true);
    expect(page.items.every((item) => item.paymentsCompleted === 11)).toBe(true);
    expect(page.items[0]?.allowedSettlementAssets).toEqual(expect.arrayContaining(['GOLD', 'CASH']));
  });

  it('keeps dashboard redemption-ready count aligned with the redemption-ready list', async () => {
    const now = new Date();
    await seedEnrollment({
      startDate: new Date('2025-08-01T00:00:00+05:30'),
      paidMonths: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11],
      paymentsCompleted: 11,
      status: 'MATURED',
      redemptionStartDate: new Date(now.getTime() - 86_400_000),
      redemptionEndDate: new Date(now.getTime() + 10 * 86_400_000),
    });
    await seedEnrollment({
      schemeType: 'CASH',
      startDate: new Date('2025-09-01T00:00:00+05:30'),
      paidMonths: [],
      paymentsCompleted: 0,
      redemptionStartDate: new Date(now.getTime() - 86_400_000),
      redemptionEndDate: new Date(now.getTime() + 10 * 86_400_000),
    });

    const page = await listRedemptionReadyEnrollments(listQuery, {});
    const count = await countRedemptionReadyEnrollments();
    const dashboard = await financialDashboard();

    expect(count).toBe(page.items.length);
    expect(dashboard.redemptionReadySchemes).toBe(count);
    expect(count).toBe(1);
  });

  it('cancels an unused ACTIVE enrollment with audit and outbox', async () => {
    const { actor, enrollment } = await seedEnrollment({
      startDate: new Date('2026-01-01T00:00:00+05:30'),
    });
    const cancelled = await cancelEnrollment(String(enrollment._id), 'Wrong scheme selected', {
      actorId: String(actor._id),
      actorRole: 'ADMIN',
      requestId: 'cancel-1',
    });
    expect(cancelled.status).toBe('CANCELLED');
    const audit = await AuditLog.findOne({ action: 'ENROLLMENT_CANCELLED' });
    const event = await OutboxEvent.findOne({ type: 'ENROLLMENT_CANCELLED' });
    expect(audit).toBeTruthy();
    expect(event).toBeTruthy();
    await expect(
      cancelEnrollment(String(enrollment._id), 'Wrong scheme selected', {
        actorId: String(actor._id),
        actorRole: 'ADMIN',
        requestId: 'cancel-2',
      }),
    ).rejects.toMatchObject({ code: 'ENROLLMENT_CANCELLATION_REQUIRES_SETTLEMENT' });
  });

  it('rejects cancellation once money or gateway activity exists', async () => {
    const paid = await seedEnrollment({
      startDate: new Date('2026-01-01T00:00:00+05:30'),
      paidMonths: [1],
    });
    await expect(
      cancelEnrollment(String(paid.enrollment._id), 'Try cancel', {
        actorId: String(paid.actor._id),
        actorRole: 'ADMIN',
        requestId: 'cancel-paid',
      }),
    ).rejects.toBeInstanceOf(AppError);

    const pending = await seedEnrollment({ startDate: new Date('2026-01-01T00:00:00+05:30') });
    await PaymentIntent.create([
      {
        customerId: pending.customer._id,
        schemeId: pending.enrollment._id,
        amountPaise: 100_000,
        merchantTransactionId: `KRL-CAN-${pending.enrollment._id}`,
        checkoutChannel: 'WEB',
        status: 'PENDING',
        idempotencyKey: 'cancel-pending',
        idempotencyScope: 'PHONEPE_CUSTOMER_WEB',
        requestHash: 'hash',
        schemeMonth: 1,
        collectorRole: 'CUSTOMER',
        createdBy: pending.actor._id,
      },
    ]);
    await expect(
      cancelEnrollment(String(pending.enrollment._id), 'Try cancel', {
        actorId: String(pending.actor._id),
        actorRole: 'ADMIN',
        requestId: 'cancel-intent',
      }),
    ).rejects.toMatchObject({ code: 'ENROLLMENT_CANCELLATION_REQUIRES_SETTLEMENT' });
  });

  it('rejects generic PATCH CANCELLED', async () => {
    const { actor, enrollment } = await seedEnrollment({
      startDate: new Date('2026-01-01T00:00:00+05:30'),
    });
    await expect(
      updateEnrollmentStatus(String(enrollment._id), 'CANCELLED', 'bypass', {
        actorId: String(actor._id),
        actorRole: 'ADMIN',
        requestId: 'patch-cancel',
      }),
    ).rejects.toMatchObject({ code: 'USE_ENROLLMENT_CANCELLATION_FLOW' });
  });
});
