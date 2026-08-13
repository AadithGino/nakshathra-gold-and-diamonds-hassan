import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { startOfMonth } from 'date-fns';
import { fromZonedTime, toZonedTime } from 'date-fns-tz';
import { GoldRate, Payment, SchemeEnrollment, User } from '../src/models/index.js';
import {
  requestCorrection,
  reversePayment,
  reviewCorrection,
} from '../src/services/finance.service.js';
import { enrollmentDates } from '../src/services/scheme.service.js';
import { BUSINESS_TZ, businessDayRange } from '../src/utils/time.js';
import { clearTestMongo, startTestMongo, stopTestMongo } from './helpers/mongo.js';

const INSTALLMENT = 100_000;
let phoneSeq = 0;
function nextPhone(prefix: '+9188' | '+9189') {
  phoneSeq += 1;
  return `${prefix}${String(phoneSeq).padStart(8, '0')}`;
}

async function seedSchemeWithPayment(paymentOverrides: Record<string, unknown> = {}) {
  const [actor] = await User.create([
    {
      name: 'Gateway Protect Admin',
      phone: nextPhone('+9188'),
      passwordHash: 'hash',
      role: 'ADMIN',
      status: 'ACTIVE',
    },
  ]);
  const [reviewer] = await User.create([
    {
      name: 'Gateway Protect Reviewer',
      phone: nextPhone('+9189'),
      passwordHash: 'hash',
      role: 'ADMIN',
      status: 'ACTIVE',
    },
  ]);
  const now = new Date();
  const startLocal = startOfMonth(toZonedTime(now, BUSINESS_TZ));
  const startDate = fromZonedTime(startLocal, BUSINESS_TZ);
  const dates = enrollmentDates(startDate, 11, 11);
  const [enrollment] = await SchemeEnrollment.create([
    {
      customerId: actor._id,
      schemePlanId: actor._id,
      enrollmentNumber: `ENR-GP-${Date.now()}-${Math.random().toString(16).slice(2, 6)}`,
      schemeType: 'GOLD_WEIGHT',
      startDate,
      ...dates,
      durationMonths: 11,
      flexibleMonths: 11,
      monthlyInstallmentPaise: INSTALLMENT,
      makingChargeWaiverPercent: 100,
      gstRateBasisPoints: 300,
      status: 'ACTIVE',
      createdBy: actor._id,
    },
  ]);
  const { start: todayStart } = businessDayRange(now);
  let rate = await GoldRate.findOne({ effectiveFrom: todayStart, status: 'ACTIVE' });
  if (!rate) {
    [rate] = await GoldRate.create([
      {
        ratePerGramPaise: 750_000,
        purity: '916',
        effectiveFrom: todayStart,
        status: 'ACTIVE',
        createdBy: actor._id,
      },
    ]);
  }
  const [payment] = await Payment.create([
    {
      customerId: actor._id,
      schemeId: enrollment._id,
      amountPaise: INSTALLMENT,
      method: 'UPI',
      status: 'SUCCESS',
      paymentDate: now,
      schemeMonth: 1,
      collectorRole: 'ADMIN',
      goldRateId: rate._id,
      goldRatePerGramPaise: 750_000,
      goldWeightMg: 133,
      goldPurity: '916',
      createdBy: actor._id,
      collectedBy: actor._id,
      ...paymentOverrides,
    },
  ]);
  return { actor, reviewer, enrollment, payment };
}

async function seedGatewayPayment() {
  const merchantTransactionId = `KRL-GP-${Date.now()}-${Math.random().toString(16).slice(2, 6)}`;
  return seedSchemeWithPayment({
    merchantTransactionId,
    providerTransactionId: `PP-GP-${Date.now()}`,
    method: 'UPI',
  });
}

async function seedManualPayment() {
  return seedSchemeWithPayment({ method: 'CASH' });
}

describe('gateway payment reversal / correction protection', () => {
  beforeAll(async () => {
    await startTestMongo();
  }, 120_000);

  afterAll(async () => {
    await stopTestMongo();
  });

  beforeEach(async () => {
    await clearTestMongo();
  });

  it('reversing a gateway payment => GATEWAY_PAYMENT_REQUIRES_REFUND', async () => {
    const { actor, payment } = await seedGatewayPayment();
    await expect(
      reversePayment(String(payment._id), 'test reversal', {
        actorId: String(actor._id),
        requestId: 'r-gp-1',
      }),
    ).rejects.toMatchObject({ code: 'GATEWAY_PAYMENT_REQUIRES_REFUND', statusCode: 409 });
    expect((await Payment.findById(payment._id))?.status).toBe('SUCCESS');
  });

  it('manual CASH payment can still be locally reversed', async () => {
    const { actor, payment } = await seedManualPayment();
    const reversed = await reversePayment(String(payment._id), 'test reversal', {
      actorId: String(actor._id),
      requestId: 'r-gp-2',
    });
    expect(reversed.status).toBe('REVERSED');
  });

  async function approveGatewayCorrection(correctionType: string, requestedChanges: unknown) {
    const { actor, reviewer, payment } = await seedGatewayPayment();
    const correction = await requestCorrection(
      String(payment._id),
      { correctionType, requestedChanges, reason: 'test correction' },
      { actorId: String(actor._id), requestId: `r-corr-${correctionType}` },
    );
    return { actor, reviewer, payment, correction };
  }

  it('gateway CHANGE_AMOUNT correction => rejected', async () => {
    const { reviewer, correction, payment } = await approveGatewayCorrection('CHANGE_AMOUNT', {
      amountPaise: INSTALLMENT + 1,
    });
    await expect(
      reviewCorrection(String(correction._id), 'APPROVED', 'ok', {
        actorId: String(reviewer._id),
        requestId: 'rc-amount',
      }),
    ).rejects.toMatchObject({ code: 'GATEWAY_PAYMENT_REQUIRES_REFUND', statusCode: 409 });
    expect((await Payment.findById(payment._id))?.status).toBe('SUCCESS');
  });

  it('gateway CHANGE_METHOD correction => rejected', async () => {
    const { reviewer, correction, payment } = await approveGatewayCorrection('CHANGE_METHOD', {
      method: 'CASH',
    });
    await expect(
      reviewCorrection(String(correction._id), 'APPROVED', 'ok', {
        actorId: String(reviewer._id),
        requestId: 'rc-method',
      }),
    ).rejects.toMatchObject({ code: 'GATEWAY_PAYMENT_REQUIRES_REFUND', statusCode: 409 });
    expect((await Payment.findById(payment._id))?.status).toBe('SUCCESS');
  });

  it('gateway CHANGE_DATE correction => rejected at request', async () => {
    const { actor, payment } = await seedGatewayPayment();
    await expect(
      requestCorrection(
        String(payment._id),
        {
          correctionType: 'CHANGE_DATE',
          requestedChanges: { paymentDate: new Date().toISOString() },
          reason: 'test correction',
        },
        { actorId: String(actor._id), requestId: 'r-corr-CHANGE_DATE' },
      ),
    ).rejects.toMatchObject({ code: 'CORRECTION_TYPE_DISABLED', statusCode: 422 });
    expect((await Payment.findById(payment._id))?.status).toBe('SUCCESS');
  });

  it('gateway REVERSE_PAYMENT correction => rejected', async () => {
    const { reviewer, correction, payment } = await approveGatewayCorrection('REVERSE_PAYMENT', {});
    await expect(
      reviewCorrection(String(correction._id), 'APPROVED', 'ok', {
        actorId: String(reviewer._id),
        requestId: 'rc-reverse',
      }),
    ).rejects.toMatchObject({ code: 'GATEWAY_PAYMENT_REQUIRES_REFUND', statusCode: 409 });
    expect((await Payment.findById(payment._id))?.status).toBe('SUCCESS');
  });

  it('gateway notes-only correction is applied without reversing/recreating the payment', async () => {
    const { reviewer, correction, payment } = await approveGatewayCorrection('CHANGE_NOTES', {
      notes: 'corrected note text',
    });
    const { correction: reviewed, replacement } = await reviewCorrection(
      String(correction._id),
      'APPROVED',
      'ok',
      { actorId: String(reviewer._id), requestId: 'rc-notes' },
    );
    expect(reviewed.status).toBe('APPROVED');
    expect(replacement).toBeNull();
    const after = await Payment.findById(payment._id);
    expect(after?.status).toBe('SUCCESS');
    expect(after?.notes).toBe('corrected note text');
    expect(after?.amountPaise).toBe(INSTALLMENT);
    expect(await Payment.countDocuments({ schemeId: payment.schemeId })).toBe(1);
  });

  it('gateway reference-only correction is applied without reversing/recreating the payment', async () => {
    const { reviewer, correction, payment } = await approveGatewayCorrection('CHANGE_REFERENCE', {
      referenceNumber: 'REF-CORRECTED-001',
    });
    const { replacement } = await reviewCorrection(String(correction._id), 'APPROVED', 'ok', {
      actorId: String(reviewer._id),
      requestId: 'rc-reference',
    });
    expect(replacement).toBeNull();
    const after = await Payment.findById(payment._id);
    expect(after?.status).toBe('SUCCESS');
    expect(after?.referenceNumber).toBe('REF-CORRECTED-001');
    // Gateway identity is never touched by a reference correction.
    expect(after?.merchantTransactionId).toBe(payment.merchantTransactionId);
  });

  it('manual CASH CHANGE_AMOUNT correction still reverses and recreates the payment', async () => {
    const { actor, reviewer, payment } = await seedManualPayment();
    const correction = await requestCorrection(
      String(payment._id),
      { correctionType: 'CHANGE_AMOUNT', requestedChanges: { amountPaise: INSTALLMENT }, reason: 'fix' },
      { actorId: String(actor._id), requestId: 'r-manual-amount' },
    );
    const { correction: reviewed, replacement } = await reviewCorrection(
      String(correction._id),
      'APPROVED',
      'ok',
      { actorId: String(reviewer._id), requestId: 'rc-manual-amount' },
    );
    expect(reviewed.status).toBe('APPROVED');
    expect(replacement).toBeTruthy();
    expect((await Payment.findById(payment._id))?.status).toBe('REVERSED');
    expect(replacement.status).toBe('SUCCESS');
  });
});
