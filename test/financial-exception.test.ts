import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  AuditLog,
  FinancialException,
  Notification,
  Payment,
  SchemeEnrollment,
  SuspenseEntry,
  User,
} from '../src/models/index.js';
import {
  ageOpenFinancialExceptions,
  createDisputeCase,
  createSuspenseEntry,
  resolveFinancialException,
  resolveSuspenseEntry,
  upsertFinancialException,
} from '../src/services/financial-exception.service.js';
import {
  computeAgingBucket,
  isHigherAgingBucket,
} from '../src/utils/financial-aging.js';
import { clearTestMongo, startTestMongo, stopTestMongo } from './helpers/mongo.js';

describe('financial exception queue', () => {
  beforeAll(async () => {
    await startTestMongo();
  });

  afterAll(async () => {
    await stopTestMongo();
  });

  beforeEach(async () => {
    await clearTestMongo();
  });

  it('dedupes repeated detections onto one record', async () => {
    const first = await upsertFinancialException({
      dedupeKey: 'payment-intent:abc:PAYMENT_AMOUNT_MISMATCH',
      type: 'PAYMENT_AMOUNT_MISMATCH',
      title: 'Amount mismatch',
      amountPaise: 100_000,
    });
    expect(first.created).toBe(true);

    const second = await upsertFinancialException({
      dedupeKey: 'payment-intent:abc:PAYMENT_AMOUNT_MISMATCH',
      type: 'PAYMENT_AMOUNT_MISMATCH',
      title: 'Amount mismatch again',
      amountPaise: 100_000,
    });
    expect(second.created).toBe(false);
    expect(second.exception.occurrenceCount).toBe(2);
    expect(await FinancialException.countDocuments()).toBe(1);
  });

  it('only moves aging buckets forward and alerts once per escalation', async () => {
    expect(isHigherAgingBucket('WARNING', 'NEW')).toBe(true);
    expect(isHigherAgingBucket('NEW', 'WARNING')).toBe(false);
    expect(isHigherAgingBucket('CRITICAL', 'OVERDUE')).toBe(true);

    const [admin] = await User.create([
      {
        name: 'Aging Admin',
        phone: '+919900000001',
        passwordHash: 'hash',
        role: 'ADMIN',
        status: 'ACTIVE',
      },
    ]);

    const old = new Date(Date.now() - 4 * 24 * 60 * 60_000);
    const { exception } = await upsertFinancialException({
      dedupeKey: 'refund:old:REFUND_PENDING_TOO_LONG',
      type: 'REFUND_PENDING_TOO_LONG',
      title: 'Old refund',
      now: old,
    });

    // Force firstSeenAt in the past so aging computes CRITICAL.
    await FinancialException.updateOne(
      { _id: exception._id },
      {
        $set: {
          firstSeenAt: old,
          agingBucket: 'NEW',
          lastAlertedAt: null,
          nextReviewAt: old,
        },
      },
    );

    const aged = await ageOpenFinancialExceptions(new Date());
    expect(aged.alerted).toBeGreaterThanOrEqual(1);

    const refreshed = await FinancialException.findById(exception._id);
    expect(refreshed?.agingBucket).toBe('CRITICAL');

    const notices = await Notification.countDocuments({
      userId: admin._id,
      type: 'FINANCIAL_EXCEPTION_AGING',
      'data.agingBucket': 'CRITICAL',
    });
    expect(notices).toBe(1);

    const agedAgain = await ageOpenFinancialExceptions(new Date());
    expect(agedAgain.alerted).toBe(0);
    expect(
      await Notification.countDocuments({
        userId: admin._id,
        type: 'FINANCIAL_EXCEPTION_AGING',
      }),
    ).toBe(1);
  });

  it('computes type-specific aging buckets', () => {
    const now = new Date('2026-01-10T12:00:00.000Z');
    expect(
      computeAgingBucket('PAYMENT_PENDING_TOO_LONG', new Date('2026-01-10T11:50:00.000Z'), now),
    ).toBe('NEW');
    expect(
      computeAgingBucket('PAYMENT_PENDING_TOO_LONG', new Date('2026-01-10T10:00:00.000Z'), now),
    ).toBe('WARNING');
    expect(
      computeAgingBucket('REFUND_PENDING_TOO_LONG', new Date('2026-01-10T10:00:00.000Z'), now),
    ).toBe('NEW');
    expect(
      computeAgingBucket('REFUND_PENDING_TOO_LONG', new Date('2026-01-10T04:00:00.000Z'), now),
    ).toBe('WARNING');
    expect(
      computeAgingBucket('UNMATCHED_EXTERNAL_CREDIT', new Date('2026-01-01T12:00:00.000Z'), now),
    ).toBe('CRITICAL');
    expect(
      computeAgingBucket('CHARGEBACK_REPORTED', new Date('2026-01-10T11:00:00.000Z'), now, {
        responseDueAt: new Date('2026-01-10T18:00:00.000Z'),
      }),
    ).toBe('CRITICAL');
  });

  it('creates suspense without crediting a scheme and requires notes to resolve', async () => {
    const [admin] = await User.create([
      {
        name: 'Suspense Admin',
        phone: '+919900000002',
        passwordHash: 'hash',
        role: 'ADMIN',
        status: 'ACTIVE',
      },
    ]);

    const entry = await createSuspenseEntry(
      {
        entryType: 'UNMATCHED_CREDIT',
        amountPaise: 50_000,
        description: 'Unknown PhonePe credit',
        source: 'PHONEPE_DASHBOARD',
        providerReference: 'UNK-1',
      },
      { actorId: String(admin._id), actorRole: 'ADMIN', requestId: 'suspense-test' },
    );

    expect(entry.status).toBe('OPEN');
    expect(entry.financialExceptionId).toBeTruthy();
    expect(await SchemeEnrollment.countDocuments()).toBe(0);
    expect(await Payment.countDocuments()).toBe(0);

    await expect(
      resolveSuspenseEntry(
        String(entry._id),
        { resolutionNotes: '' },
        { actorId: String(admin._id), actorRole: 'ADMIN', requestId: 'bad' },
      ),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });

    const resolved = await resolveSuspenseEntry(
      String(entry._id),
      { resolutionNotes: 'Matched to bank residual after review' },
      { actorId: String(admin._id), actorRole: 'ADMIN', requestId: 'ok' },
    );
    expect(resolved.status).toBe('RESOLVED');
    expect(resolved.resolvedBy).toBeTruthy();
    expect(await SchemeEnrollment.countDocuments()).toBe(0);
  });

  it('opens a dispute on a gateway payment without mutating payment/gold', async () => {
    const [admin] = await User.create([
      {
        name: 'Dispute Admin',
        phone: '+919900000003',
        passwordHash: 'hash',
        role: 'ADMIN',
        status: 'ACTIVE',
      },
    ]);
    const [customer] = await User.create([
      {
        name: 'Dispute Customer',
        phone: '+919900000004',
        passwordHash: 'hash',
        role: 'CUSTOMER',
        status: 'ACTIVE',
      },
    ]);

    const [enrollment] = await SchemeEnrollment.create([
      {
        customerId: customer._id,
        schemePlanId: admin._id,
        enrollmentNumber: 'ENR-DISP-1',
        schemeType: 'GOLD_WEIGHT',
        startDate: new Date(),
        flexiblePeriodEndDate: new Date(),
        maturityDate: new Date(),
        redemptionStartDate: new Date(),
        redemptionEndDate: new Date(),
        durationMonths: 11,
        flexibleMonths: 11,
        monthlyInstallmentPaise: 100_000,
        makingChargeWaiverPercent: 100,
        gstRateBasisPoints: 300,
        status: 'ACTIVE',
        totalPaidPaise: 100_000,
        totalGoldWeightMg: 142,
        createdBy: admin._id,
      },
    ]);

    const [payment] = await Payment.create([
      {
        customerId: customer._id,
        schemeId: enrollment._id,
        amountPaise: 100_000,
        goldWeightMg: 142,
        goldRatePerGramPaise: 700_000,
        method: 'PHONEPE',
        status: 'SUCCESS',
        paymentDate: new Date(),
        schemeMonth: 1,
        receiptNumber: 'RCP-DISP-1',
        merchantTransactionId: 'KRL-DISP-1',
        providerTransactionId: 'PRV-DISP-1',
        collectorRole: 'ADMIN',
        createdBy: admin._id,
      },
    ]);

    const dispute = await createDisputeCase(
      {
        paymentId: String(payment._id),
        reason: 'Customer disputed via PhonePe dashboard',
        detectedVia: 'PHONEPE_DASHBOARD',
        providerCaseId: 'CB-1',
        responseDueAt: new Date(Date.now() + 48 * 60 * 60_000),
      },
      { actorId: String(admin._id), actorRole: 'ADMIN', requestId: 'dispute-test' },
    );

    expect(dispute.status).toBe('OPEN');
    expect(dispute.financialExceptionId).toBeTruthy();

    const unchanged = await Payment.findById(payment._id);
    expect(unchanged?.status).toBe('SUCCESS');
    expect(unchanged?.amountPaise).toBe(100_000);
    expect(unchanged?.goldWeightMg).toBe(142);

    const enrollmentAfter = await SchemeEnrollment.findById(enrollment._id);
    expect(enrollmentAfter?.totalPaidPaise).toBe(100_000);
    expect(enrollmentAfter?.totalGoldWeightMg).toBe(142);

    expect(await FinancialException.countDocuments({ type: 'CHARGEBACK_REPORTED' })).toBe(1);
  });

  it('audits exception resolution', async () => {
    const [admin] = await User.create([
      {
        name: 'Resolve Admin',
        phone: '+919900000005',
        passwordHash: 'hash',
        role: 'ADMIN',
        status: 'ACTIVE',
      },
    ]);
    const { exception } = await upsertFinancialException({
      dedupeKey: 'test:resolve:1',
      type: 'OUTBOX_DELIVERY_FAILED',
      title: 'Outbox failed',
    });

    await resolveFinancialException(
      String(exception._id),
      { resolutionNotes: 'Retried and delivered' },
      { actorId: String(admin._id), actorRole: 'ADMIN', requestId: 'resolve-test' },
    );

    expect(
      await AuditLog.countDocuments({
        action: 'FINANCIAL_EXCEPTION_RESOLVED',
        entityType: 'FinancialException',
      }),
    ).toBe(1);
    expect((await FinancialException.findById(exception._id))?.status).toBe('RESOLVED');
  });

  it('preserves resolution history on reopen so July as-of stays closed', async () => {
    const julySeen = new Date('2026-07-10T10:00:00+05:30');
    const julyResolved = new Date('2026-07-20T10:00:00+05:30');
    const augustReopen = new Date('2026-08-05T10:00:00+05:30');
    const julyEndsAt = new Date('2026-08-01T00:00:00+05:30');

    const { exception } = await upsertFinancialException({
      dedupeKey: 'history:reopen:1',
      type: 'OUTBOX_DELIVERY_FAILED',
      title: 'July issue',
      now: julySeen,
    });

    const [admin] = await User.create([
      {
        name: 'History Admin',
        phone: '+919900000099',
        passwordHash: 'hash',
        role: 'ADMIN',
        status: 'ACTIVE',
      },
    ]);
    await resolveFinancialException(
      String(exception._id),
      { resolutionNotes: 'Fixed in July' },
      { actorId: String(admin._id), actorRole: 'ADMIN', requestId: 'resolve-july' },
    );

    // Pin historical timestamps for as-of assertions.
    await FinancialException.updateOne(
      { _id: exception._id },
      {
        $set: {
          firstSeenAt: julySeen,
          resolvedAt: julyResolved,
          statusHistory: [
            { status: 'OPEN', at: julySeen, note: 'created' },
            {
              status: 'RESOLVED',
              at: julyResolved,
              actorId: admin._id,
              note: 'Fixed in July',
            },
          ],
        },
      },
    );

    const {
      wasFinancialExceptionOpenAsOf,
      getOpenFinancialExceptionCountAsOf,
    } = await import('../src/services/accounting-period.service.js');

    const resolved = await FinancialException.findById(exception._id).lean();
    expect(wasFinancialExceptionOpenAsOf(resolved!, julyEndsAt)).toBe(false);
    expect(await getOpenFinancialExceptionCountAsOf(julyEndsAt)).toBe(0);

    await upsertFinancialException({
      dedupeKey: 'history:reopen:1',
      type: 'OUTBOX_DELIVERY_FAILED',
      title: 'Reappeared in August',
      now: augustReopen,
    });

    const reopened = await FinancialException.findById(exception._id).lean();
    expect(reopened?.status).toBe('OPEN');
    expect(reopened?.resolvedAt).toBeFalsy();
    expect(reopened?.statusHistory?.some((e) => e.status === 'RESOLVED')).toBe(true);
    expect(
      reopened?.statusHistory?.some((e) => e.status === 'OPEN' && e.note === 'reopened_by_upsert'),
    ).toBe(true);
    expect(wasFinancialExceptionOpenAsOf(reopened!, julyEndsAt)).toBe(false);
    expect(await getOpenFinancialExceptionCountAsOf(julyEndsAt)).toBe(0);
  });

  it('does not auto-link suspense to scheme credits', async () => {
    expect(SuspenseEntry.schema.path('resolvedPaymentId')).toBeTruthy();
    const paths = Object.keys(SuspenseEntry.schema.paths);
    expect(paths).not.toContain('schemeId');
    expect(paths).not.toContain('customerId');
  });

  it('survives concurrent duplicate-key upsert races', async () => {
    const key = 'concurrent:upsert:PAYMENT_AMOUNT_MISMATCH';
    const results = await Promise.all(
      Array.from({ length: 12 }, (_, i) =>
        upsertFinancialException({
          dedupeKey: key,
          type: 'PAYMENT_AMOUNT_MISMATCH',
          title: `Race ${i}`,
          amountPaise: 100_000,
        }),
      ),
    );
    expect(await FinancialException.countDocuments({ dedupeKey: key })).toBe(1);
    expect(results.some((r) => r.created)).toBe(true);
    const winner = await FinancialException.findOne({ dedupeKey: key });
    expect(winner?.occurrenceCount).toBeGreaterThanOrEqual(1);
  });

  it('ages only due exceptions and does not starve older due rows', async () => {
    const dueOld = new Date(Date.now() - 5 * 24 * 60 * 60_000);
    const future = new Date(Date.now() + 6 * 60 * 60_000);

    // Not-yet-due rows that would previously occupy the first-200 scan.
    for (let i = 0; i < 5; i++) {
      const { exception } = await upsertFinancialException({
        dedupeKey: `future:${i}`,
        type: 'OUTBOX_DELIVERY_FAILED',
        title: `Future ${i}`,
      });
      await FinancialException.updateOne(
        { _id: exception._id },
        { $set: { nextReviewAt: future, firstSeenAt: new Date() } },
      );
    }

    const { exception: due } = await upsertFinancialException({
      dedupeKey: 'due:old:REFUND_PENDING_TOO_LONG',
      type: 'REFUND_PENDING_TOO_LONG',
      title: 'Due old',
      now: dueOld,
    });
    await FinancialException.updateOne(
      { _id: due._id },
      {
        $set: {
          firstSeenAt: dueOld,
          agingBucket: 'NEW',
          nextReviewAt: dueOld,
          lastAlertedAt: null,
        },
      },
    );

    const aged = await ageOpenFinancialExceptions(new Date(), 3);
    expect(aged.updated).toBeGreaterThanOrEqual(1);
    const refreshed = await FinancialException.findById(due._id);
    expect(refreshed?.agingBucket).not.toBe('NEW');
  });
});
