import mongoose from 'mongoose';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  AccountingPeriod,
  AuditLog,
  Payment,
  User,
} from '../src/models/index.js';
import {
  assertDateInOpenPeriod,
  closeAccountingPeriod,
  getPeriodSummary,
  reopenAccountingPeriod,
  toPeriodKey,
} from '../src/services/accounting-period.service.js';
import { recordGoldInventoryMovement } from '../src/services/gold-control.service.js';
import { clearTestMongo, startTestMongo, stopTestMongo } from './helpers/mongo.js';

describe('accounting periods', () => {
  beforeAll(async () => {
    await startTestMongo();
  });
  afterAll(async () => {
    await stopTestMongo();
  });
  beforeEach(async () => {
    await clearTestMongo();
  });

  it('blocks backdated writes in a closed period and preserves closed snapshots after later refunds', async () => {
    const [admin] = await User.create([
      {
        name: 'Period Admin',
        phone: '+919922200001',
        passwordHash: 'hash',
        role: 'ADMIN',
        status: 'ACTIVE',
      },
    ]);

    const julyPaymentDate = new Date('2026-07-15T10:00:00+05:30');
    const periodKey = toPeriodKey(julyPaymentDate);
    expect(periodKey).toBe('2026-07');

    await Payment.create([
      {
        customerId: admin._id,
        schemeId: admin._id,
        amountPaise: 100_000,
        goldWeightMg: 142,
        method: 'PHONEPE',
        status: 'SUCCESS',
        paymentDate: julyPaymentDate,
        accountingDate: julyPaymentDate,
        schemeMonth: 1,
        receiptNumber: 'RCP-JUL-1',
        collectorRole: 'ADMIN',
        createdBy: admin._id,
      },
    ]);

    const closed = await closeAccountingPeriod(
      periodKey,
      { closeNotes: 'July month-end', overrideReason: 'Test close with no blockers' },
      { actorId: String(admin._id), actorRole: 'ADMIN', requestId: 'close-july' },
    );
    expect(closed.status).toBe('CLOSED');
    expect(closed.snapshot?.successfulCollectionPaise).toBe(100_000);
    expect(closed.snapshot?.successfulPaymentCount).toBe(1);
    expect(Number.isInteger(closed.snapshot?.successfulCollectionPaise)).toBe(true);

    await expect(assertDateInOpenPeriod(julyPaymentDate)).rejects.toMatchObject({
      code: 'ACCOUNTING_PERIOD_CLOSED',
    });

    await expect(
      recordGoldInventoryMovement(
        {
          movementType: 'OPENING_STOCK',
          goldWeightMg: 50,
          movementDate: julyPaymentDate,
          reason: 'Backdated stock',
        },
        { actorId: String(admin._id), actorRole: 'ADMIN', requestId: 'blocked' },
      ),
    ).rejects.toMatchObject({ code: 'ACCOUNTING_PERIOD_CLOSED' });

    // Simulate August refund of the July payment — payment marked REFUNDED now.
    await Payment.updateOne(
      { receiptNumber: 'RCP-JUL-1' },
      { $set: { status: 'REFUNDED', refundStatus: 'SUCCESS', refundedAt: new Date('2026-08-05') } },
    );

    const summary = await getPeriodSummary(periodKey);
    expect(summary.source).toBe('SNAPSHOT');
    expect(summary.snapshot.successfulCollectionPaise).toBe(100_000);

    await expect(
      reopenAccountingPeriod(periodKey, '', {
        actorId: String(admin._id),
        actorRole: 'ADMIN',
        requestId: 'bad-reopen',
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });

    const reopened = await reopenAccountingPeriod(
      periodKey,
      'Need correction for audit',
      { actorId: String(admin._id), actorRole: 'ADMIN', requestId: 'reopen' },
    );
    expect(reopened.status).toBe('OPEN');
    expect(reopened.snapshot?.successfulCollectionPaise).toBe(100_000);

    expect(
      await AuditLog.countDocuments({
        action: { $in: ['ACCOUNTING_PERIOD_CLOSED', 'ACCOUNTING_PERIOD_REOPENED'] },
      }),
    ).toBe(2);
    expect(await AccountingPeriod.countDocuments({ periodKey })).toBe(1);
  });

  it('keeps July gross collection after August refund and after reopen/reclose', async () => {
    const [admin] = await User.create([
      {
        name: 'Gross Admin',
        phone: '+919922200002',
        passwordHash: 'hash',
        role: 'ADMIN',
        status: 'ACTIVE',
      },
    ]);

    const julyPaymentDate = new Date('2026-07-15T10:00:00+05:30');
    const augustRefundAt = new Date('2026-08-05T12:00:00+05:30');
    const julyKey = toPeriodKey(julyPaymentDate);
    const augustKey = toPeriodKey(augustRefundAt);

    const [payment] = await Payment.create([
      {
        customerId: admin._id,
        schemeId: admin._id,
        amountPaise: 100_000,
        goldWeightMg: 142,
        method: 'PHONEPE',
        status: 'SUCCESS',
        paymentDate: julyPaymentDate,
        accountingDate: julyPaymentDate,
        schemeMonth: 1,
        receiptNumber: 'RCP-GROSS-1',
        merchantTransactionId: 'KRL-GROSS-1',
        collectorRole: 'ADMIN',
        createdBy: admin._id,
      },
    ]);

    // Mark refunded in August (immutable original amount/rate/weight preserved).
    await Payment.updateOne(
      { _id: payment._id },
      {
        $set: {
          status: 'REFUNDED',
          refundStatus: 'SUCCESS',
          refundedAt: augustRefundAt,
        },
      },
    );
    const { Refund } = await import('../src/models/index.js');
    await Refund.create([
      {
        paymentId: payment._id,
        customerId: admin._id,
        schemeId: admin._id,
        merchantRefundId: 'RFD-GROSS-1',
        originalMerchantOrderId: 'KRL-GROSS-1',
        amountPaise: 100_000,
        status: 'SUCCESS',
        attemptNumber: 1,
        active: false,
        reason: 'Customer cancel',
        idempotencyKey: 'gross-refund-0001',
        requestHash: 'hash',
        requestedBy: admin._id,
        requestedAt: augustRefundAt,
        completedAt: augustRefundAt,
      },
    ]);

    const julyLive = await getPeriodSummary(julyKey);
    expect(julyLive.source).toBe('LIVE');
    expect(julyLive.snapshot.successfulCollectionPaise).toBe(100_000);
    expect(julyLive.snapshot.refundCompletedPaise).toBe(0);
    expect(julyLive.snapshot.netCollectionMovementPaise).toBe(100_000);

    const augustLive = await getPeriodSummary(augustKey);
    expect(augustLive.snapshot.successfulCollectionPaise).toBe(0);
    expect(augustLive.snapshot.refundCompletedPaise).toBe(100_000);
    expect(augustLive.snapshot.netCollectionMovementPaise).toBe(-100_000);

    const closedJuly = await closeAccountingPeriod(
      julyKey,
      { closeNotes: 'July after August refund', overrideReason: 'Test' },
      { actorId: String(admin._id), actorRole: 'ADMIN', requestId: 'close-j' },
    );
    expect(closedJuly.snapshot?.successfulCollectionPaise).toBe(100_000);

    await reopenAccountingPeriod(julyKey, 'Recompute after audit', {
      actorId: String(admin._id),
      actorRole: 'ADMIN',
      requestId: 'reopen-j',
    });
    const reclosed = await closeAccountingPeriod(
      julyKey,
      { closeNotes: 'Reclose July', overrideReason: 'Test' },
      { actorId: String(admin._id), actorRole: 'ADMIN', requestId: 'reclose-j' },
    );
    expect(reclosed.snapshot?.successfulCollectionPaise).toBe(100_000);
    expect(reclosed.snapshot?.refundCompletedPaise).toBe(0);
    // As-of liability: July credit remains; August refund must not reduce July closing liability.
    expect(reclosed.snapshot?.closingGoldLiabilityMg).toBe(142);
  });

  it('keeps July gross collection after August reversal', async () => {
    const [admin] = await User.create([
      {
        name: 'Reversal Admin',
        phone: '+919922200003',
        passwordHash: 'hash',
        role: 'ADMIN',
        status: 'ACTIVE',
      },
    ]);

    const julyPaymentDate = new Date('2026-07-20T10:00:00+05:30');
    const augustReversedAt = new Date('2026-08-10T12:00:00+05:30');
    const julyKey = toPeriodKey(julyPaymentDate);
    const augustKey = toPeriodKey(augustReversedAt);

    await Payment.create([
      {
        customerId: admin._id,
        schemeId: admin._id,
        amountPaise: 100_000,
        goldWeightMg: 142,
        method: 'CASH',
        status: 'REVERSED',
        paymentDate: julyPaymentDate,
        accountingDate: julyPaymentDate,
        reversedAt: augustReversedAt,
        schemeMonth: 1,
        receiptNumber: 'RCP-REV-1',
        collectorRole: 'ADMIN',
        createdBy: admin._id,
      },
    ]);

    const july = await getPeriodSummary(julyKey);
    expect(july.snapshot.successfulCollectionPaise).toBe(100_000);
    expect(july.snapshot.reversalPaise).toBe(0);
    expect(july.snapshot.closingGoldLiabilityMg).toBe(142);

    const august = await getPeriodSummary(augustKey);
    expect(august.snapshot.successfulCollectionPaise).toBe(0);
    expect(august.snapshot.reversalPaise).toBe(100_000);
    expect(august.snapshot.reversalCount).toBe(1);
    expect(august.snapshot.netCollectionMovementPaise).toBe(-100_000);
    expect(august.snapshot.closingGoldLiabilityMg).toBe(0);
  });

  it('preserves July closing balances after later refund, inventory, suspense, exception, and payout events', async () => {
    const [admin] = await User.create([
      {
        name: 'AsOf Admin',
        phone: '+919922200004',
        passwordHash: 'hash',
        role: 'ADMIN',
        status: 'ACTIVE',
      },
    ]);

    const julyPaymentDate = new Date('2026-07-12T10:00:00+05:30');
    const julyInventoryDate = new Date('2026-07-14T10:00:00+05:30');
    const julyPayoutDate = new Date('2026-07-25T10:00:00+05:30');
    const augustAt = new Date('2026-08-08T12:00:00+05:30');
    const julyKey = toPeriodKey(julyPaymentDate);

    const [payment] = await Payment.create([
      {
        customerId: admin._id,
        schemeId: admin._id,
        amountPaise: 100_000,
        goldWeightMg: 1000,
        method: 'PHONEPE',
        status: 'SUCCESS',
        paymentDate: julyPaymentDate,
        accountingDate: julyPaymentDate,
        schemeMonth: 1,
        receiptNumber: 'RCP-ASOF-1',
        merchantTransactionId: 'KRL-ASOF-1',
        collectorRole: 'ADMIN',
        createdBy: admin._id,
      },
    ]);

    await recordGoldInventoryMovement(
      {
        movementType: 'PURCHASE',
        goldWeightMg: 500,
        movementDate: julyInventoryDate,
        reason: 'July stock',
      },
      { actorId: String(admin._id), actorRole: 'ADMIN', requestId: 'inv-july' },
    );

    const { Payout, SuspenseEntry, FinancialException, GoldInventoryMovement, Refund } =
      await import('../src/models/index.js');

    await Payout.create([
      {
        customerId: admin._id,
        schemeId: admin._id,
        amountPaise: 50_000,
        goldWeightMg: 200,
        payoutType: 'REDEEM',
        method: 'GOLD',
        status: 'SUCCESS',
        payoutDate: julyPayoutDate,
        createdBy: admin._id,
      },
    ]);

    const [suspense] = await SuspenseEntry.create([
      {
        entryType: 'UNMATCHED_CREDIT',
        status: 'OPEN',
        amountPaise: 25_000,
        source: 'MANUAL',
        description: 'July suspense',
        createdBy: admin._id,
        createdAt: julyPaymentDate,
        updatedAt: julyPaymentDate,
      },
    ]);

    const [exception] = await FinancialException.create([
      {
        type: 'PAYMENT_STATUS_CHECK_FAILED',
        severity: 'HIGH',
        status: 'OPEN',
        dedupeKey: 'asof-exception-july-1',
        title: 'July exception',
        description: 'Open in July',
        firstSeenAt: julyPaymentDate,
        lastSeenAt: julyPaymentDate,
      },
    ]);

    const closed = await closeAccountingPeriod(
      julyKey,
      { closeNotes: 'July as-of baseline', overrideReason: 'Test' },
      { actorId: String(admin._id), actorRole: 'ADMIN', requestId: 'close-asof' },
    );

    expect(closed.snapshot?.successfulCollectionPaise).toBe(100_000);
    expect(closed.snapshot?.closingGoldLiabilityMg).toBe(800); // 1000 - 200 payout
    expect(closed.snapshot?.closingGoldInventoryMg).toBe(500);
    expect(closed.snapshot?.closingSuspensePaise).toBe(25_000);
    expect(closed.snapshot?.openExceptionCount).toBe(1);

    // August events that must not rewrite July closing balances on reclose.
    await Payment.updateOne(
      { _id: payment._id },
      {
        $set: {
          status: 'REFUNDED',
          refundStatus: 'SUCCESS',
          refundedAt: augustAt,
        },
      },
    );
    await Refund.create([
      {
        paymentId: payment._id,
        customerId: admin._id,
        schemeId: admin._id,
        merchantRefundId: 'RFD-ASOF-1',
        originalMerchantOrderId: 'KRL-ASOF-1',
        amountPaise: 100_000,
        status: 'SUCCESS',
        attemptNumber: 1,
        active: false,
        reason: 'August refund',
        idempotencyKey: 'asof-refund-0001',
        requestHash: 'hash',
        requestedBy: admin._id,
        requestedAt: augustAt,
        completedAt: augustAt,
      },
    ]);

    await GoldInventoryMovement.create([
      {
        movementType: 'PURCHASE',
        direction: 'IN',
        goldWeightMg: 900,
        purity: '916',
        movementDate: augustAt,
        reason: 'August receipt',
        createdBy: admin._id,
      },
    ]);

    await Payout.create([
      {
        customerId: admin._id,
        schemeId: new mongoose.Types.ObjectId(),
        amountPaise: 10_000,
        goldWeightMg: 50,
        payoutType: 'REDEEM',
        method: 'GOLD',
        status: 'SUCCESS',
        payoutDate: augustAt,
        createdBy: admin._id,
      },
    ]);

    await SuspenseEntry.updateOne(
      { _id: suspense._id },
      {
        $set: {
          status: 'RESOLVED',
          resolvedAt: augustAt,
          resolvedBy: admin._id,
          resolutionNotes: 'Cleared in August',
        },
      },
    );
    await FinancialException.updateOne(
      { _id: exception._id },
      {
        $set: {
          status: 'RESOLVED',
          resolvedAt: augustAt,
          resolvedBy: admin._id,
          resolutionNotes: 'Cleared in August',
        },
      },
    );

    await reopenAccountingPeriod(julyKey, 'Recompute as-of balances', {
      actorId: String(admin._id),
      actorRole: 'ADMIN',
      requestId: 'reopen-asof',
    });
    const reclosed = await closeAccountingPeriod(
      julyKey,
      { closeNotes: 'Reclose July after August events', overrideReason: 'Test' },
      { actorId: String(admin._id), actorRole: 'ADMIN', requestId: 'reclose-asof' },
    );

    expect(reclosed.snapshot?.successfulCollectionPaise).toBe(100_000);
    expect(reclosed.snapshot?.refundCompletedPaise).toBe(0);
    expect(reclosed.snapshot?.closingGoldLiabilityMg).toBe(800);
    expect(reclosed.snapshot?.closingGoldInventoryMg).toBe(500);
    expect(reclosed.snapshot?.closingSuspensePaise).toBe(25_000);
    expect(reclosed.snapshot?.openExceptionCount).toBe(1);
  });

  it('reduces closing liability only for payouts completed before period end', async () => {
    const [admin] = await User.create([
      {
        name: 'Payout Timing Admin',
        phone: '+919922200005',
        passwordHash: 'hash',
        role: 'ADMIN',
        status: 'ACTIVE',
      },
    ]);

    const julyPaymentDate = new Date('2026-07-05T10:00:00+05:30');
    const julyKey = toPeriodKey(julyPaymentDate);
    const { Payout } = await import('../src/models/index.js');

    await Payment.create([
      {
        customerId: admin._id,
        schemeId: admin._id,
        amountPaise: 100_000,
        goldWeightMg: 1000,
        method: 'CASH',
        status: 'SUCCESS',
        paymentDate: julyPaymentDate,
        accountingDate: julyPaymentDate,
        schemeMonth: 1,
        receiptNumber: 'RCP-PAYOUT-TIMING-1',
        collectorRole: 'ADMIN',
        createdBy: admin._id,
      },
    ]);

    await Payout.create([
      {
        customerId: admin._id,
        schemeId: new mongoose.Types.ObjectId(),
        amountPaise: 20_000,
        goldWeightMg: 100,
        payoutType: 'REDEEM',
        method: 'GOLD',
        status: 'SUCCESS',
        payoutDate: new Date('2026-07-28T10:00:00+05:30'),
        createdBy: admin._id,
      },
      {
        customerId: admin._id,
        schemeId: new mongoose.Types.ObjectId(),
        amountPaise: 30_000,
        goldWeightMg: 150,
        payoutType: 'REDEEM',
        method: 'GOLD',
        status: 'SUCCESS',
        payoutDate: new Date('2026-08-02T10:00:00+05:30'),
        createdBy: admin._id,
      },
    ]);

    const july = await getPeriodSummary(julyKey);
    expect(july.snapshot.closingGoldLiabilityMg).toBe(900);
  });
});
