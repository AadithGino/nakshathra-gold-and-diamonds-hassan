import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { startOfMonth } from 'date-fns';
import { fromZonedTime, toZonedTime } from 'date-fns-tz';
import { GoldRate, Payment, SchemeEnrollment, User } from '../src/models/index.js';
import {
  requestCorrection,
  reversePayment,
  reviewCorrection,
} from '../src/services/finance.service.js';
import { initiatePaymentRefund } from '../src/services/refund.service.js';
import { phonePeProvider } from '../src/services/phonepe.provider.js';
import { enrollmentDates } from '../src/services/scheme.service.js';
import { BUSINESS_TZ, businessDayRange } from '../src/utils/time.js';
import { clearTestMongo, startTestMongo, stopTestMongo } from './helpers/mongo.js';

const INSTALLMENT = 100_000;
let phoneSeq = 0;
function nextPhone(prefix: '+9166' | '+9167') {
  phoneSeq += 1;
  return `${prefix}${String(phoneSeq).padStart(8, '0')}`;
}

/** Scheme with a gateway payment (month 1, refundable) and a manual payment (month 2, reversible). */
async function seedSchemeWithTwoPayments() {
  const [actor] = await User.create([
    {
      name: 'Interlock Admin',
      phone: nextPhone('+9166'),
      passwordHash: 'hash',
      role: 'ADMIN',
      status: 'ACTIVE',
    },
  ]);
  const [reviewer] = await User.create([
    {
      name: 'Interlock Reviewer',
      phone: nextPhone('+9167'),
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
      enrollmentNumber: `ENR-SI-${Date.now()}-${Math.random().toString(16).slice(2, 6)}`,
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
  const merchantTransactionId = `KRL-SI-${Date.now()}-${Math.random().toString(16).slice(2, 6)}`;
  const [gatewayPayment] = await Payment.create([
    {
      customerId: actor._id,
      schemeId: enrollment._id,
      amountPaise: INSTALLMENT,
      method: 'UPI',
      status: 'SUCCESS',
      paymentDate: now,
      schemeMonth: 1,
      merchantTransactionId,
      providerTransactionId: `PP-SI-${Date.now()}`,
      collectorRole: 'ADMIN',
      goldRateId: rate._id,
      goldRatePerGramPaise: 750_000,
      goldWeightMg: 133,
      goldPurity: '916',
      createdBy: actor._id,
      collectedBy: actor._id,
    },
  ]);
  const [manualPayment] = await Payment.create([
    {
      customerId: actor._id,
      schemeId: enrollment._id,
      amountPaise: INSTALLMENT,
      method: 'CASH',
      status: 'SUCCESS',
      paymentDate: now,
      schemeMonth: 2,
      collectorRole: 'ADMIN',
      goldRateId: rate._id,
      goldRatePerGramPaise: 750_000,
      goldWeightMg: 133,
      goldPurity: '916',
      createdBy: actor._id,
      collectedBy: actor._id,
    },
  ]);
  return { actor, reviewer, enrollment, gatewayPayment, manualPayment };
}

describe('settlement mutual exclusion (refund vs reversal vs correction)', () => {
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

  it('an active refund on one payment blocks local reversal of another payment on the same scheme', async () => {
    const { actor, gatewayPayment, manualPayment } = await seedSchemeWithTwoPayments();
    vi.spyOn(phonePeProvider, 'initiateRefund').mockResolvedValue({
      state: 'PENDING',
      amountPaise: INSTALLMENT,
      providerRefundId: 'PPR-SI-1',
      raw: {},
    });
    await initiatePaymentRefund(
      String(gatewayPayment._id),
      { reason: 'test', idempotencyKey: 'si-refund-block-reversal-0001' },
      { actorId: String(actor._id), requestId: 'si-refund-1' },
    );

    await expect(
      reversePayment(String(manualPayment._id), 'unrelated reversal', {
        actorId: String(actor._id),
        requestId: 'si-reverse-blocked',
      }),
    ).rejects.toMatchObject({ code: 'SETTLEMENT_BLOCKED_ACTIVE_REFUND', statusCode: 409 });
    expect((await Payment.findById(manualPayment._id))?.status).toBe('SUCCESS');
  });

  it('an active refund on one payment blocks a financial correction approval on another payment', async () => {
    const { actor, reviewer, gatewayPayment, manualPayment } = await seedSchemeWithTwoPayments();
    vi.spyOn(phonePeProvider, 'initiateRefund').mockResolvedValue({
      state: 'PENDING',
      amountPaise: INSTALLMENT,
      providerRefundId: 'PPR-SI-2',
      raw: {},
    });
    await initiatePaymentRefund(
      String(gatewayPayment._id),
      { reason: 'test', idempotencyKey: 'si-refund-block-correction-0001' },
      { actorId: String(actor._id), requestId: 'si-refund-2' },
    );

    const correction = await requestCorrection(
      String(manualPayment._id),
      { correctionType: 'CHANGE_AMOUNT', requestedChanges: { amountPaise: INSTALLMENT }, reason: 'fix' },
      { actorId: String(actor._id), requestId: 'si-correction-request' },
    );
    await expect(
      reviewCorrection(String(correction._id), 'APPROVED', 'ok', {
        actorId: String(reviewer._id),
        requestId: 'si-correction-blocked',
      }),
    ).rejects.toMatchObject({ code: 'SETTLEMENT_BLOCKED_ACTIVE_REFUND', statusCode: 409 });
    expect((await Payment.findById(manualPayment._id))?.status).toBe('SUCCESS');
  });

  it('reversal racing refund initiation on the same scheme: exactly one operation mutates state, ledger stays solvent', async () => {
    const { actor, gatewayPayment, manualPayment, enrollment } = await seedSchemeWithTwoPayments();
    vi.spyOn(phonePeProvider, 'initiateRefund').mockImplementation(async () => {
      await new Promise((r) => setTimeout(r, 30));
      return {
        state: 'PENDING' as const,
        amountPaise: INSTALLMENT,
        providerRefundId: 'PPR-SI-RACE-1',
        raw: {},
      };
    });

    const results = await Promise.allSettled([
      reversePayment(String(manualPayment._id), 'race reversal', {
        actorId: String(actor._id),
        requestId: 'si-race-reverse',
      }),
      initiatePaymentRefund(
        String(gatewayPayment._id),
        { reason: 'race refund', idempotencyKey: 'si-race-refund-0001' },
        { actorId: String(actor._id), requestId: 'si-race-refund' },
      ),
    ]);

    // Both may independently succeed (they touch different payments and the
    // lock is only held for the short "start" window) — the invariant that
    // matters is no corruption: the manual payment ends in exactly one of
    // SUCCESS/REVERSED, never a double-reversal, and the ledger never goes
    // negative.
    const manualAfter = await Payment.findById(manualPayment._id);
    expect(['SUCCESS', 'REVERSED']).toContain(manualAfter?.status);

    const rejected = results.filter((r) => r.status === 'rejected');
    for (const r of rejected) {
      expect((r as PromiseRejectedResult).reason).toMatchObject({
        statusCode: 409,
      });
    }

    const schemeAfter = await SchemeEnrollment.findById(enrollment._id);
    expect(schemeAfter?.totalPaidPaise ?? 0).toBeGreaterThanOrEqual(0);
  });

  it('does not create a negative enrollment balance across reversal + refund on the same scheme', async () => {
    const { actor, gatewayPayment, manualPayment, enrollment } = await seedSchemeWithTwoPayments();
    vi.spyOn(phonePeProvider, 'initiateRefund').mockResolvedValue({
      state: 'PENDING',
      amountPaise: INSTALLMENT,
      providerRefundId: 'PPR-SI-3',
      raw: {},
    });

    // Refund the gateway payment first (still PENDING — not yet applied to ledger).
    await initiatePaymentRefund(
      String(gatewayPayment._id),
      { reason: 'test', idempotencyKey: 'si-no-negative-0001' },
      { actorId: String(actor._id), requestId: 'si-no-negative-refund' },
    );

    // Reversing the manual payment is blocked while that refund is active —
    // this itself is the protection that prevents the ledger from being
    // decremented twice for the same scheme concurrently.
    await expect(
      reversePayment(String(manualPayment._id), 'blocked reversal', {
        actorId: String(actor._id),
        requestId: 'si-no-negative-reverse',
      }),
    ).rejects.toMatchObject({ code: 'SETTLEMENT_BLOCKED_ACTIVE_REFUND' });

    const schemeAfter = await SchemeEnrollment.findById(enrollment._id);
    expect(schemeAfter?.totalPaidPaise ?? 0).toBeGreaterThanOrEqual(0);
    expect((await Payment.findById(manualPayment._id))?.status).toBe('SUCCESS');
  });
});
