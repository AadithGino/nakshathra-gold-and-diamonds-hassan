import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { addMonths, startOfMonth } from 'date-fns';
import { fromZonedTime, toZonedTime } from 'date-fns-tz';
import {
  AuditLog,
  Customer,
  GoldInventoryMovement,
  GoldRate,
  Payment,
  PaymentIntent,
  Payout,
  SchemeEnrollment,
  SystemSetting,
  User,
} from '../src/models/index.js';
import { createPayout } from '../src/services/finance.service.js';
import { initiatePhonePe } from '../src/services/gateway.service.js';
import { createManualPayment, finalizeGatewayPayment } from '../src/services/payment.service.js';
import { initiatePaymentRefund } from '../src/services/refund.service.js';
import { phonePeProvider } from '../src/services/phonepe.provider.js';
import { updateEnrollmentStatus } from '../src/services/scheme-management.service.js';
import { enrollmentDates, getPaymentRules } from '../src/services/scheme.service.js';
import {
  aggregateEnrollmentLedger,
  claimEnrollmentSettlementLock,
  SETTLEMENT_LOCK_REDEMPTION_STATUSES,
} from '../src/utils/enrollment-ledger.js';
import { AppError } from '../src/utils/AppError.js';
import { BUSINESS_TZ, businessDayRange, schemeMonth } from '../src/utils/time.js';
import { clearTestMongo, startTestMongo, stopTestMongo, withTestTransaction } from './helpers/mongo.js';

const INSTALLMENT = 100_000;
let phoneSeq = 0;

function nextPhone(prefix: '+9176' | '+9177') {
  phoneSeq += 1;
  return `${prefix}${String(phoneSeq).padStart(8, '0')}`;
}

function startMonthsAgo(monthsAgo: number, at = new Date()) {
  const startLocal = startOfMonth(addMonths(toZonedTime(at, BUSINESS_TZ), -monthsAgo));
  return { startLocal, startDate: fromZonedTime(startLocal, BUSINESS_TZ) };
}

async function seedEnrollment(opts: {
  monthsAgo: number;
  status?: 'ACTIVE' | 'MATURED' | 'REDEEMED' | 'CLOSED' | 'WITHDRAWN';
  paidMonths?: number[];
  role?: 'ADMIN' | 'CUSTOMER';
}) {
  const suffix = `${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
  const [actor] = await User.create([
    {
      name: 'Phase 3 Actor',
      phone: nextPhone('+9176'),
      passwordHash: 'hash',
      role: opts.role ?? 'ADMIN',
      status: 'ACTIVE',
    },
  ]);
  const [customerUser] = await User.create([
    {
      name: 'Phase 3 Customer',
      phone: nextPhone('+9177'),
      passwordHash: 'hash',
      role: 'CUSTOMER',
      status: 'ACTIVE',
    },
  ]);
  const [customer] = await Customer.create([
    {
      userId: customerUser._id,
      customerCode: `CUST-P3-${suffix}`,
      status: 'ACTIVE',
      kycStatus: 'VERIFIED',
      createdBy: actor._id,
    },
  ]);

  const now = new Date();
  const { startLocal, startDate } = startMonthsAgo(opts.monthsAgo, now);
  const dates = enrollmentDates(startDate, 11, 11);
  const [enrollment] = await SchemeEnrollment.create([
    {
      customerId: customer._id,
      schemePlanId: actor._id,
      enrollmentNumber: `ENR-P3-${suffix}`,
      schemeType: 'GOLD_WEIGHT',
      startDate,
      ...dates,
      durationMonths: 11,
      flexibleMonths: 11,
      monthlyInstallmentPaise: INSTALLMENT,
      makingChargeWaiverPercent: 100,
      gstRateBasisPoints: 300,
      status: opts.status ?? 'ACTIVE',
      createdBy: actor._id,
    },
  ]);

  const paidMonths = opts.paidMonths ?? [];
  const payments = [];
  for (const month of paidMonths) {
    const merchantTransactionId = `KRL-P3-${suffix}-${month}`;
    const [payment] = await Payment.create([
      {
        customerId: customer._id,
        schemeId: enrollment._id,
        amountPaise: INSTALLMENT,
        method: 'UPI',
        status: 'SUCCESS',
        paymentDate: fromZonedTime(addMonths(startLocal, month - 1), BUSINESS_TZ),
        schemeMonth: month,
        receiptNumber: `KRL-P3-${suffix}-${month}`,
        merchantTransactionId,
        providerTransactionId: `PP-${merchantTransactionId}`,
        goldRatePerGramPaise: 700_000,
        goldWeightMg: 142,
        goldPurity: '916',
        collectorRole: 'CUSTOMER',
        createdBy: actor._id,
      },
    ]);
    payments.push(payment);
  }

  const { start: todayStart } = businessDayRange(now);
  await GoldRate.create([
    {
      ratePerGramPaise: 700_000,
      purity: '916',
      effectiveFrom: todayStart,
      status: 'ACTIVE',
      createdBy: actor._id,
    },
  ]);

  return {
    actor,
    customerUser,
    customer,
    enrollment,
    payments,
    now,
    startLocal,
    startDate,
    payoutDate: now,
    calendarMonth: schemeMonth(startDate, now),
  };
}

async function redeem(fixture: Awaited<ReturnType<typeof seedEnrollment>>, requestId = 'p3-redeem') {
  return createPayout(
    {
      customerId: String(fixture.customer._id),
      schemeId: String(fixture.enrollment._id),
      payoutDate: fixture.payoutDate,
      payoutType: 'REDEEM',
    },
    { actorId: String(fixture.actor._id), actorRole: 'ADMIN', requestId },
  );
}

describe('Phase 3 — scheme lifecycle / maturity / settlement', () => {
  beforeAll(async () => {
    await startTestMongo();
  }, 120_000);

  afterAll(async () => {
    await stopTestMongo();
  });

  beforeEach(async () => {
    await clearTestMongo();
    vi.restoreAllMocks();
  });

  it('allows paying a missed month 5 while still in contribution month 11', async () => {
    const fixture = await seedEnrollment({ monthsAgo: 10, paidMonths: [1, 2, 3, 4] });
    expect(fixture.calendarMonth).toBe(11);

    const rules = await getPaymentRules(
      String(fixture.enrollment._id),
      fixture.now,
      INSTALLMENT,
      undefined,
      { targetSchemeMonth: 5 },
    );
    expect(rules.schemeMonth).toBe(5);

    const created = await createManualPayment(
      {
        customerId: String(fixture.customer._id),
        schemeId: String(fixture.enrollment._id),
        amountPaise: INSTALLMENT,
        schemeMonth: 5,
        method: 'CASH',
        paymentDate: fixture.now,
        idempotencyKey: 'p3-month11-missed-5',
      },
      { actorId: String(fixture.actor._id), actorRole: 'ADMIN', requestId: 'p3-1' },
    );
    expect(created.schemeMonth).toBe(5);
    expect(created.status).toBe('SUCCESS');
  });

  it('blocks month 12 contribution even when targetSchemeMonth is an unpaid month 5', async () => {
    const fixture = await seedEnrollment({ monthsAgo: 11, paidMonths: [1, 2, 3, 4] });
    expect(fixture.calendarMonth).toBe(12);

    await expect(
      getPaymentRules(String(fixture.enrollment._id), fixture.now, INSTALLMENT, undefined, {
        targetSchemeMonth: 5,
      }),
    ).rejects.toMatchObject({ code: 'SCHEME_MATURED' });
  });

  it('blocks month 12 contribution when no target month is supplied', async () => {
    const fixture = await seedEnrollment({ monthsAgo: 11 });
    await expect(
      getPaymentRules(String(fixture.enrollment._id), fixture.now, INSTALLMENT),
    ).rejects.toMatchObject({ code: 'SCHEME_MATURED' });
  });

  it('blocks admin manual collection in month 12', async () => {
    const fixture = await seedEnrollment({ monthsAgo: 11, paidMonths: [1, 2, 3, 4] });
    await expect(
      createManualPayment(
        {
          customerId: String(fixture.customer._id),
          schemeId: String(fixture.enrollment._id),
          amountPaise: INSTALLMENT,
          schemeMonth: 5,
          method: 'CASH',
          paymentDate: fixture.now,
          idempotencyKey: 'p3-admin-month12',
        },
        { actorId: String(fixture.actor._id), actorRole: 'ADMIN', requestId: 'p3-4' },
      ),
    ).rejects.toMatchObject({ code: 'SCHEME_MATURED' });
  });

  it('blocks PhonePe initiation in month 12', async () => {
    const fixture = await seedEnrollment({
      monthsAgo: 11,
      paidMonths: [1],
      role: 'CUSTOMER',
    });
    await SystemSetting.create([{ singletonKey: 'GLOBAL', customerPhonePeEnabled: true }]);
    vi.spyOn(phonePeProvider, 'createPayment').mockImplementation(async () => {
      throw new Error('PhonePe must not be called after contribution window closes');
    });

    await expect(
      initiatePhonePe(
        String(fixture.customerUser._id),
        {
          schemeId: String(fixture.enrollment._id),
          amountPaise: INSTALLMENT,
          schemeMonth: 5,
          idempotencyKey: 'p3-phonepe-month12',
        },
        'p3-5',
      ),
    ).rejects.toMatchObject({ code: 'SCHEME_MATURED' });
  });

  it('finalizes a PhonePe success completed before maturity even if learned afterward', async () => {
    const fixture = await seedEnrollment({ monthsAgo: 11, paidMonths: [1, 2, 3, 4] });
    const completedAt = fromZonedTime(addMonths(fixture.startLocal, 10), BUSINESS_TZ);
    expect(completedAt < fixture.enrollment.maturityDate).toBe(true);
    expect(schemeMonth(fixture.startDate, completedAt)).toBe(11);

    const goldRate = await GoldRate.findOne({ createdBy: fixture.actor._id });
    const merchantTransactionId = `KRL-P3-LATE-${Date.now()}`;
    const [intent] = await PaymentIntent.create([
      {
        customerId: fixture.customer._id,
        schemeId: fixture.enrollment._id,
        amountPaise: INSTALLMENT,
        merchantTransactionId,
        checkoutChannel: 'WEB',
        status: 'PENDING',
        idempotencyKey: `p3-late-${Date.now()}`,
        idempotencyScope: 'PHONEPE_CUSTOMER_WEB',
        requestHash: 'p3-late-hash',
        goldRateId: goldRate!._id,
        goldRatePerGramPaise: 700_000,
        goldWeightMg: 142,
        goldPurity: '916',
        schemeMonth: 5,
        collectorRole: 'CUSTOMER',
        createdBy: fixture.customerUser._id,
      },
    ]);

    const payment = await finalizeGatewayPayment(
      intent,
      {
        transactionId: 'PP-LATE-1',
        amountPaise: INSTALLMENT,
        providerCompletedAt: completedAt,
      },
      { actorId: String(fixture.customerUser._id), actorRole: 'CUSTOMER', requestId: 'p3-6' },
    );

    expect(payment.status).toBe('SUCCESS');
    expect(payment.schemeMonth).toBe(5);
    expect(payment.providerCompletedAt?.getTime()).toBe(completedAt.getTime());
    expect(payment.recognizedAt).toBeTruthy();
    expect(payment.recognizedAt!.getTime()).not.toBe(completedAt.getTime());
  });

  it('lets a MATURED enrollment acquire the redemption settlement lock', async () => {
    const fixture = await seedEnrollment({
      monthsAgo: 11,
      status: 'MATURED',
      paidMonths: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11],
    });

    const locked = await withTestTransaction(async (session) =>
      claimEnrollmentSettlementLock(
        fixture.enrollment._id,
        'payout:p3-lock',
        session,
        SETTLEMENT_LOCK_REDEMPTION_STATUSES,
      ),
    );
    expect(locked.status).toBe('MATURED');
    expect(locked.settlementLockedBy).toBe('payout:p3-lock');
  });

  it('redeems a MATURED enrollment in month 12 with 11 paid installments', async () => {
    const fixture = await seedEnrollment({
      monthsAgo: 11,
      status: 'MATURED',
      paidMonths: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11],
    });
    const payout = await redeem(fixture, 'p3-matured-redeem');
    expect(payout.status).toBe('SUCCESS');
    expect(payout.payoutType).toBe('REDEEM');
    expect((await SchemeEnrollment.findById(fixture.enrollment._id))?.status).toBe('REDEEMED');
    expect(await Payout.countDocuments({ schemeId: fixture.enrollment._id, status: 'SUCCESS' })).toBe(
      1,
    );
    expect(await GoldInventoryMovement.countDocuments({ payoutId: payout._id })).toBe(1);
    expect(await AuditLog.countDocuments({ action: 'PAYOUT_CREATED', entityId: payout._id })).toBe(1);

    const refreshed = await SchemeEnrollment.findById(fixture.enrollment._id);
    expect(refreshed?.statusHistory.some((row) => row.status === 'REDEEMED')).toBe(true);
    const ledger = await aggregateEnrollmentLedger(String(fixture.enrollment._id));
    expect(ledger.paymentsCompleted).toBe(11);
    expect(ledger.availableGoldWeightMg).toBe(0);
    expect(ledger.availablePaise).toBe(0);
  });

  it('redeems an ACTIVE enrollment in month 12 when maturity rules are already satisfied', async () => {
    const fixture = await seedEnrollment({
      monthsAgo: 11,
      status: 'ACTIVE',
      paidMonths: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11],
    });
    await redeem(fixture, 'p3-active-redeem');
    expect((await SchemeEnrollment.findById(fixture.enrollment._id))?.status).toBe('REDEEMED');
  });

  it('rejects a second redemption on an already REDEEMED enrollment', async () => {
    const fixture = await seedEnrollment({
      monthsAgo: 11,
      paidMonths: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11],
    });
    const first = await redeem(fixture, 'p3-first-redeem');
    const replay = await redeem(fixture, 'p3-second-redeem');
    expect(String(replay._id)).toBe(String(first._id));
    await expect(
      createPayout(
        {
          customerId: String(fixture.customer._id),
          schemeId: String(fixture.enrollment._id),
          payoutDate: fixture.payoutDate,
          payoutType: 'REDEEM',
          idempotencyKey: 'p3-different-key-0001',
        },
        { actorId: String(fixture.actor._id), actorRole: 'ADMIN', requestId: 'p3-second-key' },
      ),
    ).rejects.toMatchObject({
      code: 'SCHEME_ALREADY_SETTLED',
    });
    expect(await Payout.countDocuments({ schemeId: fixture.enrollment._id, status: 'SUCCESS' })).toBe(
      1,
    );
  });

  it('rejects generic CLOSED and WITHDRAWN status patches', async () => {
    const fixture = await seedEnrollment({ monthsAgo: 5, paidMonths: [1, 2] });
    const context = {
      actorId: String(fixture.actor._id),
      actorRole: 'ADMIN' as const,
      requestId: 'p3-status',
    };

    await expect(
      updateEnrollmentStatus(String(fixture.enrollment._id), 'CLOSED', 'Want to close', context),
    ).rejects.toMatchObject({ code: 'USE_PREMATURE_CLOSURE_FLOW' });
    await expect(
      updateEnrollmentStatus(String(fixture.enrollment._id), 'WITHDRAWN', 'Want to withdraw', context),
    ).rejects.toMatchObject({ code: 'USE_PREMATURE_CLOSURE_FLOW' });
    await expect(
      updateEnrollmentStatus(String(fixture.enrollment._id), 'REDEEMED', 'Want gold', context),
    ).rejects.toMatchObject({ code: 'USE_PAYOUT_FLOW' });

    expect((await SchemeEnrollment.findById(fixture.enrollment._id))?.status).toBe('ACTIVE');
  });

  it('blocks redemption while a refund is pending', async () => {
    const fixture = await seedEnrollment({
      monthsAgo: 11,
      paidMonths: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11],
    });
    vi.spyOn(phonePeProvider, 'initiateRefund').mockResolvedValue({
      state: 'PENDING',
      amountPaise: INSTALLMENT,
      providerRefundId: 'PRV-P3-1',
      raw: { state: 'PENDING' },
    });
    await initiatePaymentRefund(
      String(fixture.payments[0]!._id),
      { reason: 'Customer requested refund before redemption', idempotencyKey: 'p3-refund-block' },
      { actorId: String(fixture.actor._id), actorRole: 'ADMIN', requestId: 'p3-15' },
    );

    await expect(redeem(fixture, 'p3-blocked-redeem')).rejects.toMatchObject({
      code: 'REDEMPTION_BLOCKED_PENDING_REFUND',
    });
  });

  it('creates only one payout when two redemptions race', async () => {
    const fixture = await seedEnrollment({
      monthsAgo: 11,
      paidMonths: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11],
    });

    const settled = await Promise.allSettled([
      redeem(fixture, 'p3-race-a'),
      redeem(fixture, 'p3-race-b'),
    ]);

    const wins = settled.filter((row) => row.status === 'fulfilled');
    const losses = settled.filter((row) => row.status === 'rejected');
    expect(wins.length + losses.length).toBe(2);
    expect(wins.length).toBeGreaterThanOrEqual(1);
    const payoutIds = new Set(
      wins.map((row) => String((row as PromiseFulfilledResult<{ _id: unknown }>).value._id)),
    );
    expect(payoutIds.size).toBe(1);
    expect(await Payout.countDocuments({ schemeId: fixture.enrollment._id, status: 'SUCCESS' })).toBe(
      1,
    );
    expect((await SchemeEnrollment.findById(fixture.enrollment._id))?.status).toBe('REDEEMED');
  });
});
