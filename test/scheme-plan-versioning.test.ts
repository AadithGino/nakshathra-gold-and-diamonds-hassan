import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Customer, SchemeEnrollment, SchemePlan, User } from '../src/models/index.js';
import {
  createEnrollment,
  createSchemePlan,
  updateSchemePlan,
} from '../src/services/scheme-management.service.js';
import { buildInstallmentSchedule } from '../src/services/installment-schedule.service.js';
import { resolveSettlementPolicy } from '../src/utils/payment-window.js';
import { clearTestMongo, startTestMongo, stopTestMongo } from './helpers/mongo.js';

describe('scheme plan versioning for payment window and settlement policy', () => {
  beforeAll(async () => {
    await startTestMongo();
  }, 120_000);
  afterAll(async () => {
    await stopTestMongo();
  });
  beforeEach(async () => {
    await clearTestMongo();
  });

  it('keeps enrollment A on v1 terms after the plan is edited to v2', async () => {
    const [actor] = await User.create([
      {
        name: 'Version Admin',
        phone: '+917730000001',
        passwordHash: 'hash',
        role: 'ADMIN',
        status: 'ACTIVE',
      },
    ]);
    const [userA] = await User.create([
      {
        name: 'Customer A',
        phone: '+917730000002',
        passwordHash: 'hash',
        role: 'CUSTOMER',
        status: 'ACTIVE',
      },
    ]);
    const [userB] = await User.create([
      {
        name: 'Customer B',
        phone: '+917730000003',
        passwordHash: 'hash',
        role: 'CUSTOMER',
        status: 'ACTIVE',
      },
    ]);
    const [customerA] = await Customer.create([
      {
        userId: userA._id,
        customerCode: 'CUST-VER-A',
        status: 'ACTIVE',
        kycStatus: 'VERIFIED',
        createdBy: actor._id,
      },
    ]);
    const [customerB] = await Customer.create([
      {
        userId: userB._id,
        customerCode: 'CUST-VER-B',
        status: 'ACTIVE',
        kycStatus: 'VERIFIED',
        createdBy: actor._id,
      },
    ]);

    const ctx = { actorId: String(actor._id), actorRole: 'ADMIN' as const, requestId: 'plan-v' };
    const plan = await createSchemePlan(
      {
        name: 'Nakshathra Cash',
        type: 'CASH',
        durationMonths: 11,
        minimumPaymentPaise: 100_000,
        termsText: 'Eleven installments then redemption.',
        paymentWindowType: 'FIXED_DAY',
        fixedPaymentDay: 5,
        prematureClosureCashBasis: 'CONTRIBUTION_VALUE',
      },
      ctx,
    );

    const enrollmentA = await createEnrollment(
      {
        customerId: String(customerA._id),
        schemePlanId: String(plan._id),
        startDate: new Date('2026-01-01T00:00:00+05:30'),
        monthlyInstallmentPaise: 100_000,
      },
      { ...ctx, requestId: 'enroll-a' },
    );

    await updateSchemePlan(
      String(plan._id),
      {
        paymentWindowType: 'DATE_RANGE',
        paymentWindowStartDay: 1,
        paymentWindowEndDay: 10,
        prematureClosureCashBasis: 'CURRENT_GOLD_VALUE',
      },
      { ...ctx, requestId: 'plan-v2' },
    );

    const enrollmentB = await createEnrollment(
      {
        customerId: String(customerB._id),
        schemePlanId: String(plan._id),
        startDate: new Date('2026-02-01T00:00:00+05:30'),
        monthlyInstallmentPaise: 100_000,
      },
      { ...ctx, requestId: 'enroll-b' },
    );

    const storedA = await SchemeEnrollment.findById(enrollmentA._id);
    const storedB = await SchemeEnrollment.findById(enrollmentB._id);
    expect(storedA?.paymentWindowType).toBe('FIXED_DAY');
    expect(storedA?.fixedPaymentDay).toBe(5);
    expect(resolveSettlementPolicy(storedA!.toObject()).prematureClosureCashBasis).toBe(
      'CONTRIBUTION_VALUE',
    );
    expect(storedB?.paymentWindowType).toBe('DATE_RANGE');
    expect(storedB?.paymentWindowStartDay).toBe(1);
    expect(storedB?.paymentWindowEndDay).toBe(10);
    expect(resolveSettlementPolicy(storedB!.toObject()).prematureClosureCashBasis).toBe(
      'CONTRIBUTION_VALUE',
    );

    const scheduleA = buildInstallmentSchedule(
      storedA!.toObject(),
      [],
      new Date('2026-01-11T12:00:00+05:30'),
    );
    const scheduleB = buildInstallmentSchedule(
      storedB!.toObject(),
      [],
      new Date('2026-02-11T12:00:00+05:30'),
    );
    expect(scheduleA[0]?.status).toBe('OVERDUE');
    expect(scheduleB[0]?.status).toBe('OVERDUE');
    const livePlan = await SchemePlan.findById(plan._id);
    expect(livePlan?.version).toBe(2);
    expect(storedA?.schemePlanVersion).toBe(1);
    expect(storedB?.schemePlanVersion).toBe(2);
  });
});
