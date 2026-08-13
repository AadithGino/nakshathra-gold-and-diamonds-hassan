import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { addMonths, startOfMonth } from 'date-fns';
import { fromZonedTime, toZonedTime } from 'date-fns-tz';
import mongoose from 'mongoose';
import {
  AccountingPeriod,
  Customer,
  FinancialException,
  GoldRate,
  Payment,
  PaymentIntent,
  SchemeEnrollment,
  User,
} from '../src/models/index.js';
import {
  closeAccountingPeriod,
  getPeriodSummary,
  toPeriodKey,
} from '../src/services/accounting-period.service.js';
import { requestCorrection, reviewCorrection } from '../src/services/finance.service.js';
import {
  allocateReceiptNumber,
  createManualPayment,
  finalizeGatewayPayment,
} from '../src/services/payment.service.js';
import { allocateEnrollmentNumber } from '../src/services/scheme-management.service.js';
import { enrollmentDates } from '../src/services/scheme.service.js';
import {
  MIGRATION_ACK_VALUE,
  runPaymentAccountingDatesApply,
  runPaymentAccountingDatesDryRun,
  runPaymentAccountingDatesVerify,
} from '../src/scripts/migrations/2026-08-payment-accounting-dates.js';
import { BUSINESS_TZ, businessDayRange, businessYear } from '../src/utils/time.js';
import { clearTestMongo, startTestMongo, stopTestMongo, withTestTransaction } from './helpers/mongo.js';

const INSTALLMENT = 100_000;
let phoneSeq = 0;
function nextPhone(prefix: '+9188' | '+9189') {
  phoneSeq += 1;
  return `${prefix}${String(phoneSeq).padStart(8, '0')}`;
}

async function seedAdminCustomerEnrollment(opts?: { startMonthsAgo?: number }) {
  const [admin] = await User.create([
    {
      name: 'P4 Admin',
      phone: nextPhone('+9188'),
      passwordHash: 'hash',
      role: 'ADMIN',
      status: 'ACTIVE',
    },
  ]);
  const [reviewer] = await User.create([
    {
      name: 'P4 Reviewer',
      phone: nextPhone('+9188'),
      passwordHash: 'hash',
      role: 'ADMIN',
      status: 'ACTIVE',
    },
  ]);
  const [customerUser] = await User.create([
    {
      name: 'P4 Customer',
      phone: nextPhone('+9189'),
      passwordHash: 'hash',
      role: 'CUSTOMER',
      status: 'ACTIVE',
    },
  ]);
  const [customer] = await Customer.create([
    {
      userId: customerUser._id,
      customerCode: `CUST-P4-${Date.now()}-${phoneSeq}`,
      status: 'ACTIVE',
      kycStatus: 'VERIFIED',
      createdBy: admin._id,
    },
  ]);
  const now = new Date();
  const startLocal = startOfMonth(
    addMonths(toZonedTime(now, BUSINESS_TZ), -(opts?.startMonthsAgo ?? 0)),
  );
  const startDate = fromZonedTime(startLocal, BUSINESS_TZ);
  const dates = enrollmentDates(startDate, 11, 11);
  const [enrollment] = await SchemeEnrollment.create([
    {
      customerId: customer._id,
      schemePlanId: admin._id,
      enrollmentNumber: `ENR-P4-${Date.now()}-${phoneSeq}`,
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
  let rate = await GoldRate.findOne({ effectiveFrom: todayStart, status: 'ACTIVE' });
  if (!rate) {
    [rate] = await GoldRate.create([
      {
        ratePerGramPaise: 700_000,
        purity: '916',
        effectiveFrom: todayStart,
        status: 'ACTIVE',
        createdBy: admin._id,
      },
    ]);
  }
  return { admin, reviewer, customerUser, customer, enrollment, now, startDate, rate };
}

describe('Phase 4 — admin collection / accounting / timezone', () => {
  beforeAll(async () => {
    await startTestMongo();
  });
  afterAll(async () => {
    await stopTestMongo();
  });
  beforeEach(async () => {
    await clearTestMongo();
  });

  it('records admin manual CASH, BANK, and UPI payments without treating UPI as PhonePe', async () => {
    const cash = await seedAdminCustomerEnrollment();
    const cashPay = await createManualPayment(
      {
        customerId: String(cash.customer._id),
        schemeId: String(cash.enrollment._id),
        amountPaise: INSTALLMENT,
        schemeMonth: 1,
        method: 'CASH',
        paymentDate: cash.now,
        idempotencyKey: 'p4-cash-00000001',
      },
      { actorId: String(cash.admin._id), actorRole: 'ADMIN', requestId: 'p4-cash' },
    );
    expect(cashPay.status).toBe('SUCCESS');
    expect(Number.isInteger(cashPay.goldWeightMg)).toBe(true);
    const cashDoc = await Payment.findById(cashPay.paymentId);
    expect(cashDoc?.method).toBe('CASH');
    expect(cashDoc?.accountingDate?.getTime()).toBe(cashDoc?.paymentDate.getTime());
    expect(cashDoc?.recognizedAt).toBeTruthy();
    expect(cashDoc?.providerCompletedAt).toBeFalsy();
    expect(cashDoc?.merchantTransactionId).toBeFalsy();

    const bank = await seedAdminCustomerEnrollment();
    const bankPay = await createManualPayment(
      {
        customerId: String(bank.customer._id),
        schemeId: String(bank.enrollment._id),
        amountPaise: INSTALLMENT,
        schemeMonth: 1,
        method: 'BANK',
        paymentDate: bank.now,
        referenceNumber: 'NEFT-P4-1',
        idempotencyKey: 'p4-bank-00000001',
      },
      { actorId: String(bank.admin._id), actorRole: 'ADMIN', requestId: 'p4-bank' },
    );
    expect(bankPay.method).toBe('BANK');

    const upi = await seedAdminCustomerEnrollment();
    const upiPay = await createManualPayment(
      {
        customerId: String(upi.customer._id),
        schemeId: String(upi.enrollment._id),
        amountPaise: INSTALLMENT,
        schemeMonth: 1,
        method: 'UPI',
        paymentDate: upi.now,
        idempotencyKey: 'p4-upi-000000001',
      },
      { actorId: String(upi.admin._id), actorRole: 'ADMIN', requestId: 'p4-upi' },
    );
    const upiDoc = await Payment.findById(upiPay.paymentId);
    expect(upiDoc?.method).toBe('UPI');
    expect(upiDoc?.merchantTransactionId).toBeFalsy();
    expect(upiDoc?.providerTransactionId).toBeFalsy();
  });

  it('duplicate idempotency key creates one payment', async () => {
    const fixture = await seedAdminCustomerEnrollment();
    const input = {
      customerId: String(fixture.customer._id),
      schemeId: String(fixture.enrollment._id),
      amountPaise: INSTALLMENT,
      schemeMonth: 1,
      method: 'CASH' as const,
      paymentDate: fixture.now,
      idempotencyKey: 'p4-idem-00000001',
    };
    const first = await createManualPayment(input, {
      actorId: String(fixture.admin._id),
      actorRole: 'ADMIN',
      requestId: 'p4-idem-a',
    });
    const second = await createManualPayment(input, {
      actorId: String(fixture.admin._id),
      actorRole: 'ADMIN',
      requestId: 'p4-idem-b',
    });
    expect(String(second.paymentId)).toBe(String(first.paymentId));
    expect(await Payment.countDocuments({ schemeId: fixture.enrollment._id })).toBe(1);
  });

  it('rejects month 12 manual collection', async () => {
    const fixture = await seedAdminCustomerEnrollment({ startMonthsAgo: 11 });
    await expect(
      createManualPayment(
        {
          customerId: String(fixture.customer._id),
          schemeId: String(fixture.enrollment._id),
          amountPaise: INSTALLMENT,
          schemeMonth: 5,
          method: 'CASH',
          paymentDate: fixture.now,
          idempotencyKey: 'p4-month12-0001',
        },
        { actorId: String(fixture.admin._id), actorRole: 'ADMIN', requestId: 'p4-m12' },
      ),
    ).rejects.toMatchObject({ code: 'SCHEME_MATURED' });
  });

  it('assigns accountingDate = providerCompletedAt when that period is open', async () => {
    const fixture = await seedAdminCustomerEnrollment();
    const completedAt = new Date();
    const [intent] = await PaymentIntent.create([
      {
        customerId: fixture.customer._id,
        schemeId: fixture.enrollment._id,
        amountPaise: INSTALLMENT,
        merchantTransactionId: `KRL-P4-OPEN-${Date.now()}`,
        checkoutChannel: 'WEB',
        status: 'PENDING',
        idempotencyKey: `p4-open-${Date.now()}`,
        idempotencyScope: 'PHONEPE_CUSTOMER_WEB',
        requestHash: 'p4-open',
        goldRateId: fixture.rate._id,
        goldRatePerGramPaise: 700_000,
        goldWeightMg: 142,
        goldPurity: '916',
        schemeMonth: 1,
        collectorRole: 'CUSTOMER',
        createdBy: fixture.customerUser._id,
      },
    ]);
    const payment = await finalizeGatewayPayment(
      intent,
      { transactionId: 'PP-P4-OPEN', amountPaise: INSTALLMENT, providerCompletedAt: completedAt },
      { actorId: String(fixture.customerUser._id), actorRole: 'CUSTOMER', requestId: 'p4-open' },
    );
    expect(payment.paymentDate.getTime()).toBe(completedAt.getTime());
    expect(payment.providerCompletedAt?.getTime()).toBe(completedAt.getTime());
    expect(payment.accountingDate?.getTime()).toBe(completedAt.getTime());
    expect(payment.recognizedAt).toBeTruthy();
    expect(await FinancialException.countDocuments({ type: 'LATE_GATEWAY_PAYMENT_AFTER_PERIOD_CLOSE' })).toBe(
      0,
    );
  });

  it('credits a late PhonePe success into the open recognition period without mutating the closed snapshot', async () => {
    const julyPaymentDate = new Date('2026-07-15T10:00:00+05:30');
    const baseline = await seedAdminCustomerEnrollment();
    await Payment.create([
      {
        customerId: baseline.customer._id,
        schemeId: baseline.enrollment._id,
        amountPaise: INSTALLMENT,
        goldWeightMg: 142,
        method: 'CASH',
        status: 'SUCCESS',
        paymentDate: julyPaymentDate,
        accountingDate: julyPaymentDate,
        schemeMonth: 1,
        receiptNumber: 'RCP-P4-JUL-BASE',
        collectorRole: 'ADMIN',
        createdBy: baseline.admin._id,
      },
    ]);
    const closed = await closeAccountingPeriod(
      '2026-07',
      { closeNotes: 'July close', overrideReason: 'Test' },
      { actorId: String(baseline.admin._id), actorRole: 'ADMIN', requestId: 'p4-close-jul' },
    );
    expect(closed.snapshot?.successfulCollectionPaise).toBe(INSTALLMENT);

    const late = await seedAdminCustomerEnrollment({ startMonthsAgo: 1 });
    const providerCompletedAt = new Date('2026-07-20T12:00:00+05:30');
    const [intent] = await PaymentIntent.create([
      {
        customerId: late.customer._id,
        schemeId: late.enrollment._id,
        amountPaise: INSTALLMENT,
        merchantTransactionId: `KRL-P4-LATE-${Date.now()}`,
        checkoutChannel: 'WEB',
        status: 'PENDING',
        idempotencyKey: `p4-late-${Date.now()}`,
        idempotencyScope: 'PHONEPE_CUSTOMER_WEB',
        requestHash: 'p4-late',
        goldRateId: late.rate._id,
        goldRatePerGramPaise: 700_000,
        goldWeightMg: 142,
        goldPurity: '916',
        schemeMonth: 1,
        collectorRole: 'CUSTOMER',
        createdBy: late.customerUser._id,
      },
    ]);
    const recognizedBefore = new Date();
    const payment = await finalizeGatewayPayment(
      intent,
      {
        transactionId: 'PP-P4-LATE',
        amountPaise: INSTALLMENT,
        providerCompletedAt,
      },
      { actorId: String(late.customerUser._id), actorRole: 'CUSTOMER', requestId: 'p4-late' },
    );
    expect(payment.status).toBe('SUCCESS');
    expect(payment.paymentDate.getTime()).toBe(providerCompletedAt.getTime());
    expect(payment.providerCompletedAt?.getTime()).toBe(providerCompletedAt.getTime());
    expect(payment.recognizedAt!.getTime()).toBeGreaterThanOrEqual(recognizedBefore.getTime());
    expect(toPeriodKey(payment.accountingDate!)).toBe(toPeriodKey(payment.recognizedAt!));
    expect(toPeriodKey(payment.accountingDate!)).not.toBe('2026-07');

    const julyAfter = await getPeriodSummary('2026-07');
    expect(julyAfter.source).toBe('SNAPSHOT');
    expect(julyAfter.snapshot.successfulCollectionPaise).toBe(INSTALLMENT);

    const recognitionKey = toPeriodKey(payment.recognizedAt!);
    const live = await getPeriodSummary(recognitionKey);
    expect(live.source).toBe('LIVE');
    expect(live.snapshot.successfulCollectionPaise).toBe(INSTALLMENT);

    const exception = await FinancialException.findOne({
      type: 'LATE_GATEWAY_PAYMENT_AFTER_PERIOD_CLOSE',
      paymentId: payment._id,
    });
    expect(exception?.severity).toBe('HIGH');
    expect(exception?.metadata).toMatchObject({
      providerPeriodKey: '2026-07',
      recognitionPeriodKey: recognitionKey,
    });
  });

  it('rejects CHANGE_DATE correction requests', async () => {
    const fixture = await seedAdminCustomerEnrollment();
    const created = await createManualPayment(
      {
        customerId: String(fixture.customer._id),
        schemeId: String(fixture.enrollment._id),
        amountPaise: INSTALLMENT,
        method: 'CASH',
        paymentDate: fixture.now,
        idempotencyKey: 'p4-corr-date-0001',
      },
      { actorId: String(fixture.admin._id), actorRole: 'ADMIN', requestId: 'p4-corr-create' },
    );
    await expect(
      requestCorrection(
        String(created.paymentId),
        {
          correctionType: 'CHANGE_DATE',
          requestedChanges: { paymentDate: new Date('2026-07-10T10:00:00+05:30') },
          reason: 'Move into July',
        },
        { actorId: String(fixture.admin._id), requestId: 'p4-corr-req' },
      ),
    ).rejects.toMatchObject({ code: 'CORRECTION_TYPE_DISABLED', statusCode: 422 });
    expect((await Payment.findById(created.paymentId))?.status).toBe('SUCCESS');
  });

  it('cannot close the current or a future period even with overrideReason', async () => {
    const [admin] = await User.create([
      {
        name: 'Close Admin',
        phone: nextPhone('+9188'),
        passwordHash: 'hash',
        role: 'ADMIN',
        status: 'ACTIVE',
      },
    ]);
    const currentKey = toPeriodKey(new Date());
    await expect(
      closeAccountingPeriod(
        currentKey,
        { closeNotes: 'too early', overrideReason: 'Please close anyway' },
        { actorId: String(admin._id), actorRole: 'ADMIN', requestId: 'p4-cur' },
      ),
    ).rejects.toMatchObject({ code: 'ACCOUNTING_PERIOD_NOT_ENDED' });

    await expect(
      closeAccountingPeriod(
        '2026-12',
        { closeNotes: 'future', overrideReason: 'Please close anyway' },
        { actorId: String(admin._id), actorRole: 'ADMIN', requestId: 'p4-fut' },
      ),
    ).rejects.toMatchObject({ code: 'ACCOUNTING_PERIOD_NOT_ENDED' });
  });

  it('closes a past ended period when other gates are satisfied', async () => {
    const [admin] = await User.create([
      {
        name: 'Ended Admin',
        phone: nextPhone('+9188'),
        passwordHash: 'hash',
        role: 'ADMIN',
        status: 'ACTIVE',
      },
    ]);
    const closed = await closeAccountingPeriod(
      '2026-06',
      { closeNotes: 'June month-end', overrideReason: 'Test close with no blockers' },
      { actorId: String(admin._id), actorRole: 'ADMIN', requestId: 'p4-ended' },
    );
    expect(closed.status).toBe('CLOSED');
    expect(closed.periodKey).toBe('2026-06');
  });

  it('uses Asia/Kolkata business year for receipts and enrollments', async () => {
    const kolkataNewYear = new Date('2025-12-31T18:30:00.000Z');
    expect(kolkataNewYear.getUTCFullYear()).toBe(2025);
    expect(businessYear(kolkataNewYear)).toBe(2026);

    const receipt = await withTestTransaction((session) =>
      allocateReceiptNumber(session, kolkataNewYear),
    );
    expect(receipt.startsWith('NKS-2026-')).toBe(true);

    const enrollmentNumber = await withTestTransaction((session) =>
      allocateEnrollmentNumber(session, kolkataNewYear),
    );
    expect(enrollmentNumber.startsWith('NKS-ENR-2026-')).toBe(true);
  });
});

describe('Phase 4 — payment accountingDate migration', () => {
  beforeAll(async () => {
    await startTestMongo();
  });
  afterAll(async () => {
    await stopTestMongo();
  });
  beforeEach(async () => {
    await clearTestMongo();
  });

  it('backfills accountingDate and recognizedAt without changing amount/status/gold', async () => {
    const [admin] = await User.create([
      {
        name: 'Mig Admin',
        phone: nextPhone('+9188'),
        passwordHash: 'hash',
        role: 'ADMIN',
        status: 'ACTIVE',
      },
    ]);
    const paymentDate = new Date('2026-07-15T10:00:00+05:30');
    const createdAt = new Date('2026-07-15T11:00:00+05:30');
    const collection = mongoose.connection.db!.collection('payments');
    const inserted = await collection.insertOne({
      customerId: admin._id,
      schemeId: admin._id,
      amountPaise: INSTALLMENT,
      goldWeightMg: 142,
      method: 'CASH',
      status: 'SUCCESS',
      paymentDate,
      schemeMonth: 1,
      receiptNumber: 'RCP-P4-MIG-1',
      collectorRole: 'ADMIN',
      createdBy: admin._id,
      createdAt,
      updatedAt: createdAt,
    });

    const dry = await runPaymentAccountingDatesDryRun();
    expect(dry.updated).toBe(1);
    expect(dry.ok).toBe(true);

    const applied = await runPaymentAccountingDatesApply({ ack: MIGRATION_ACK_VALUE });
    expect(applied.updated).toBe(1);
    expect(applied.ok).toBe(true);

    const doc = await collection.findOne({ _id: inserted.insertedId });
    expect(doc?.amountPaise).toBe(INSTALLMENT);
    expect(doc?.status).toBe('SUCCESS');
    expect(doc?.goldWeightMg).toBe(142);
    expect(doc?.accountingDate).toEqual(paymentDate);
    expect(doc?.recognizedAt).toEqual(createdAt);

    const rerun = await runPaymentAccountingDatesApply({ ack: MIGRATION_ACK_VALUE, resume: true });
    expect(rerun.updated).toBe(0);
    expect((await runPaymentAccountingDatesVerify()).ok).toBe(true);
  });
});
