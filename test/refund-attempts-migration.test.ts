import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import mongoose from 'mongoose';
import { Payment, Refund, User } from '../src/models/index.js';
import {
  findLegacyUniquePaymentIdIndex,
  listRefundIndexes,
  MIGRATION_ACK_VALUE,
  MIGRATION_ID,
  runRefundAttemptsApply,
  runRefundAttemptsDryRun,
  runRefundAttemptsVerify,
} from '../src/scripts/migrations/2026-08-refund-attempts.js';
import { clearTestMongo, startTestMongo, stopTestMongo } from './helpers/mongo.js';

async function refundNative() {
  const db = mongoose.connection.db;
  if (!db) throw new Error('no db');
  return db.collection('refunds');
}

async function seedAdmin() {
  const [admin] = await User.create([
    {
      name: 'Migration Admin',
      phone: '+919933300001',
      passwordHash: 'hash',
      role: 'ADMIN',
      status: 'ACTIVE',
    },
  ]);
  return admin;
}

async function seedPayment(
  adminId: unknown,
  receipt: string,
  amountPaise = 100_000,
  schemeMonth = 1,
) {
  const [payment] = await Payment.create([
    {
      customerId: adminId,
      schemeId: adminId,
      amountPaise,
      goldWeightMg: 142,
      goldRatePerGramPaise: 700_000,
      method: 'PHONEPE',
      status: 'SUCCESS',
      paymentDate: new Date('2026-07-01T10:00:00+05:30'),
      schemeMonth,
      receiptNumber: receipt,
      merchantTransactionId: `KRL-${receipt}`,
      collectorRole: 'ADMIN',
      createdBy: adminId,
    },
  ]);
  return payment;
}

async function insertLegacyRefund(doc: Record<string, unknown>) {
  const collection = await refundNative();
  // Bypass Mongoose defaults to simulate pre-attempt schema documents.
  const { attemptNumber: _a, active: _b, ...rest } = doc as {
    attemptNumber?: unknown;
    active?: unknown;
  } & Record<string, unknown>;
  await collection.insertOne({
    ...rest,
    provider: 'PHONEPE',
    createdAt: new Date(),
    updatedAt: new Date(),
  });
}

async function ensureLegacyUniquePaymentIdIndex() {
  const collection = await refundNative();
  const indexes = await collection.indexes();
  // Drop new-style partial unique so we can install the legacy unique paymentId index.
  for (const index of indexes) {
    const key = index.key as Record<string, number>;
    if (
      index.name &&
      index.name !== '_id_' &&
      key.paymentId === 1 &&
      Object.keys(key).length === 1
    ) {
      await collection.dropIndex(index.name);
    }
  }
  await collection.createIndex({ paymentId: 1 }, { unique: true, name: 'paymentId_1_legacy' });
}

describe('refund attempts migration', () => {
  beforeAll(async () => {
    await startTestMongo();
  }, 120_000);

  afterAll(async () => {
    await stopTestMongo();
  });

  beforeEach(async () => {
    await clearTestMongo();
  });

  it('dry-run inspects legacy refunds without modifying data or indexes', async () => {
    const admin = await seedAdmin();
    const payment = await seedPayment(admin._id, 'MIG-DRY-1');
    await ensureLegacyUniquePaymentIdIndex();

    await insertLegacyRefund({
      paymentId: payment._id,
      customerId: admin._id,
      schemeId: admin._id,
      merchantRefundId: 'RFD-DRY-PENDING',
      originalMerchantOrderId: payment.merchantTransactionId,
      amountPaise: 100_000,
      status: 'PENDING',
      reason: 'legacy pending',
      idempotencyKey: 'dry-pending',
      requestHash: 'hash',
      requestedBy: admin._id,
      requestedAt: new Date('2026-07-02T10:00:00+05:30'),
    });

    const beforeIndexes = await listRefundIndexes();
    const report = await runRefundAttemptsDryRun();
    expect(report.totalRefunds).toBe(1);
    expect(report.missingAttemptNumber).toBe(1);
    expect(report.missingActive).toBe(1);
    expect(report.legacyUniquePaymentIdIndex).toBe('paymentId_1_legacy');
    expect(report.proposedBackfills).toHaveLength(1);
    expect(report.proposedBackfills[0]?.attemptNumber).toBe(1);
    expect(report.proposedBackfills[0]?.active).toBe(true);

    const after = await Refund.findOne({ merchantRefundId: 'RFD-DRY-PENDING' }).lean();
    expect(after?.attemptNumber).toBeUndefined();
    expect(after?.active).toBeUndefined();
    expect(await listRefundIndexes()).toEqual(beforeIndexes);
  });

  it('applies backfill for pending, successful, and failed legacy refunds and is rerunnable', async () => {
    const admin = await seedAdmin();
    const pendingPayment = await seedPayment(admin._id, 'MIG-PEND', 100_000, 1);
    const successPayment = await seedPayment(admin._id, 'MIG-OK', 100_000, 2);
    const failedPayment = await seedPayment(admin._id, 'MIG-FAIL', 100_000, 3);
    await ensureLegacyUniquePaymentIdIndex();

    await insertLegacyRefund({
      paymentId: pendingPayment._id,
      customerId: admin._id,
      schemeId: admin._id,
      merchantRefundId: 'RFD-PEND',
      originalMerchantOrderId: pendingPayment.merchantTransactionId,
      amountPaise: 100_000,
      status: 'PENDING',
      reason: 'pending',
      idempotencyKey: 'mig-pend',
      requestHash: 'hash',
      requestedBy: admin._id,
      requestedAt: new Date('2026-07-03T10:00:00+05:30'),
    });
    await insertLegacyRefund({
      paymentId: successPayment._id,
      customerId: admin._id,
      schemeId: admin._id,
      merchantRefundId: 'RFD-OK',
      originalMerchantOrderId: successPayment.merchantTransactionId,
      amountPaise: 100_000,
      status: 'SUCCESS',
      reason: 'ok',
      idempotencyKey: 'mig-ok',
      requestHash: 'hash',
      requestedBy: admin._id,
      requestedAt: new Date('2026-07-04T10:00:00+05:30'),
      completedAt: new Date('2026-07-04T11:00:00+05:30'),
    });
    await Payment.updateOne(
      { _id: successPayment._id },
      { $set: { status: 'REFUNDED', refundStatus: 'SUCCESS' } },
    );
    await insertLegacyRefund({
      paymentId: failedPayment._id,
      customerId: admin._id,
      schemeId: admin._id,
      merchantRefundId: 'RFD-FAIL',
      originalMerchantOrderId: failedPayment.merchantTransactionId,
      amountPaise: 100_000,
      status: 'FAILED',
      reason: 'fail',
      idempotencyKey: 'mig-fail',
      requestHash: 'hash',
      requestedBy: admin._id,
      requestedAt: new Date('2026-07-05T10:00:00+05:30'),
      failedAt: new Date('2026-07-05T11:00:00+05:30'),
    });

    const applied = await runRefundAttemptsApply({ ack: MIGRATION_ACK_VALUE });
    expect(applied.ok).toBe(true);
    expect(applied.documentsChanged).toBeGreaterThan(0);
    expect(applied.indexesDropped).toContain('paymentId_1_legacy');

    const pending = await Refund.findOne({ merchantRefundId: 'RFD-PEND' });
    expect(pending?.attemptNumber).toBe(1);
    expect(pending?.active).toBe(true);

    const ok = await Refund.findOne({ merchantRefundId: 'RFD-OK' });
    expect(ok?.attemptNumber).toBe(1);
    expect(ok?.active).toBe(false);
    const linked = await Payment.findById(successPayment._id);
    expect(String(linked?.refundId)).toBe(String(ok?._id));
    expect(linked?.amountPaise).toBe(100_000);
    expect(linked?.goldWeightMg).toBe(142);
    expect(linked?.goldRatePerGramPaise).toBe(700_000);

    const failed = await Refund.findOne({ merchantRefundId: 'RFD-FAIL' });
    expect(failed?.attemptNumber).toBe(1);
    expect(failed?.active).toBe(false);

    const verified = await runRefundAttemptsVerify();
    expect(verified.ok).toBe(true);
    expect(findLegacyUniquePaymentIdIndex(await listRefundIndexes())).toBeNull();

    const reapplied = await runRefundAttemptsApply({ ack: MIGRATION_ACK_VALUE });
    expect(reapplied.ok).toBe(true);
    expect(reapplied.documentsChanged).toBe(0);
  });

  it('assigns sequential attempt numbers for multiple historical attempts', async () => {
    const admin = await seedAdmin();
    const payment = await seedPayment(admin._id, 'MIG-MULTI');
    // Legacy unique paymentId cannot store multiple docs — drop all paymentId uniques first.
    const collection = await refundNative();
    for (const index of await collection.indexes()) {
      const key = index.key as Record<string, number>;
      if (index.name && index.name !== '_id_' && key.paymentId === 1) {
        await collection.dropIndex(index.name);
      }
    }

    await insertLegacyRefund({
      paymentId: payment._id,
      customerId: admin._id,
      schemeId: admin._id,
      merchantRefundId: 'RFD-MULTI-1',
      originalMerchantOrderId: payment.merchantTransactionId,
      amountPaise: 100_000,
      status: 'FAILED',
      reason: 'first',
      idempotencyKey: 'multi-1',
      requestHash: 'hash',
      requestedBy: admin._id,
      requestedAt: new Date('2026-07-01T10:00:00+05:30'),
    });
    await insertLegacyRefund({
      paymentId: payment._id,
      customerId: admin._id,
      schemeId: admin._id,
      merchantRefundId: 'RFD-MULTI-2',
      originalMerchantOrderId: payment.merchantTransactionId,
      amountPaise: 100_000,
      status: 'SUCCESS',
      reason: 'second',
      idempotencyKey: 'multi-2',
      requestHash: 'hash',
      requestedBy: admin._id,
      requestedAt: new Date('2026-07-02T10:00:00+05:30'),
      completedAt: new Date('2026-07-02T11:00:00+05:30'),
    });
    await Payment.updateOne(
      { _id: payment._id },
      { $set: { status: 'REFUNDED', refundStatus: 'SUCCESS' } },
    );

    const applied = await runRefundAttemptsApply({ ack: MIGRATION_ACK_VALUE });
    expect(applied.ok).toBe(true);

    const attempts = await Refund.find({ paymentId: payment._id }).sort({ attemptNumber: 1 });
    expect(attempts).toHaveLength(2);
    expect(attempts[0]?.merchantRefundId).toBe('RFD-MULTI-1');
    expect(attempts[0]?.attemptNumber).toBe(1);
    expect(attempts[0]?.active).toBe(false);
    expect(attempts[1]?.merchantRefundId).toBe('RFD-MULTI-2');
    expect(attempts[1]?.attemptNumber).toBe(2);
    expect(attempts[1]?.active).toBe(false);
  });

  it('stops on conflict with two pending attempts and changes nothing', async () => {
    const admin = await seedAdmin();
    const payment = await seedPayment(admin._id, 'MIG-CONFLICT');
    const collection = await refundNative();
    for (const index of await collection.indexes()) {
      const key = index.key as Record<string, number>;
      if (index.name && index.name !== '_id_' && key.paymentId === 1) {
        await collection.dropIndex(index.name);
      }
    }

    await insertLegacyRefund({
      paymentId: payment._id,
      customerId: admin._id,
      schemeId: admin._id,
      merchantRefundId: 'RFD-CONFLICT-1',
      originalMerchantOrderId: payment.merchantTransactionId,
      amountPaise: 100_000,
      status: 'PENDING',
      reason: 'a',
      idempotencyKey: 'conflict-1',
      requestHash: 'hash',
      requestedBy: admin._id,
      requestedAt: new Date('2026-07-01T10:00:00+05:30'),
    });
    await insertLegacyRefund({
      paymentId: payment._id,
      customerId: admin._id,
      schemeId: admin._id,
      merchantRefundId: 'RFD-CONFLICT-2',
      originalMerchantOrderId: payment.merchantTransactionId,
      amountPaise: 100_000,
      status: 'PENDING',
      reason: 'b',
      idempotencyKey: 'conflict-2',
      requestHash: 'hash',
      requestedBy: admin._id,
      requestedAt: new Date('2026-07-02T10:00:00+05:30'),
    });

    const before = await Refund.find({ paymentId: payment._id }).lean();
    expect(before.every((r) => r.attemptNumber == null)).toBe(true);

    const applied = await runRefundAttemptsApply({ ack: MIGRATION_ACK_VALUE });
    expect(applied.ok).toBe(false);
    expect(applied.unsafeConflicts.length).toBeGreaterThan(0);
    expect(applied.documentsChanged).toBe(0);

    const after = await Refund.find({ paymentId: payment._id }).lean();
    expect(after.every((r) => r.attemptNumber == null && r.active == null)).toBe(true);
  });

  it('allows a new retry attempt after migration', async () => {
    const admin = await seedAdmin();
    const payment = await seedPayment(admin._id, 'MIG-RETRY');
    await ensureLegacyUniquePaymentIdIndex();
    await insertLegacyRefund({
      paymentId: payment._id,
      customerId: admin._id,
      schemeId: admin._id,
      merchantRefundId: 'RFD-RETRY-1',
      originalMerchantOrderId: payment.merchantTransactionId,
      amountPaise: 100_000,
      status: 'FAILED',
      reason: 'failed once',
      idempotencyKey: 'retry-1',
      requestHash: 'hash',
      requestedBy: admin._id,
      requestedAt: new Date('2026-07-01T10:00:00+05:30'),
      failedAt: new Date('2026-07-01T11:00:00+05:30'),
    });

    const applied = await runRefundAttemptsApply({ ack: MIGRATION_ACK_VALUE });
    expect(applied.ok).toBe(true);

    const [retry] = await Refund.create([
      {
        paymentId: payment._id,
        customerId: admin._id,
        schemeId: admin._id,
        merchantRefundId: 'RFD-RETRY-2',
        originalMerchantOrderId: payment.merchantTransactionId,
        amountPaise: 100_000,
        status: 'INITIATED',
        attemptNumber: 2,
        active: true,
        reason: 'retry',
        idempotencyKey: 'retry-2',
        requestHash: 'hash2',
        requestedBy: admin._id,
        requestedAt: new Date(),
        nextStatusCheckAt: new Date(),
        statusCheckAttempts: 0,
      },
    ]);
    expect(retry.attemptNumber).toBe(2);
    expect(retry.active).toBe(true);
    expect(await Refund.countDocuments({ paymentId: payment._id })).toBe(2);
  });

  it('blocks apply while a fresh lock is held and resumes after crash with --resume', async () => {
    const admin = await seedAdmin();
    const payment = await seedPayment(admin._id, 'MIG-RESUME');
    await ensureLegacyUniquePaymentIdIndex();
    await insertLegacyRefund({
      paymentId: payment._id,
      customerId: admin._id,
      schemeId: admin._id,
      merchantRefundId: 'RFD-RESUME',
      originalMerchantOrderId: payment.merchantTransactionId,
      amountPaise: 100_000,
      status: 'PENDING',
      reason: 'resume',
      idempotencyKey: 'resume-1',
      requestHash: 'hash',
      requestedBy: admin._id,
      requestedAt: new Date('2026-07-01T10:00:00+05:30'),
    });

    const db = mongoose.connection.db!;
    await db.collection('migration_locks').replaceOne(
      { _id: MIGRATION_ID } as any,
      {
        _id: MIGRATION_ID,
        migrationId: MIGRATION_ID,
        lockedAt: new Date(),
        heartbeatAt: new Date(),
        releasedAt: null,
        host: 'crashed-worker',
        phase: 'backfill',
      },
      { upsert: true },
    );

    await expect(runRefundAttemptsApply({ ack: MIGRATION_ACK_VALUE })).rejects.toThrow(
      /already locked|incomplete prior run|--resume/i,
    );

    const resumed = await runRefundAttemptsApply({
      ack: MIGRATION_ACK_VALUE,
      resume: true,
    });
    expect(resumed.ok).toBe(true);
    expect(resumed.resumed).toBe(true);
    const refund = await Refund.findOne({ merchantRefundId: 'RFD-RESUME' });
    expect(refund?.attemptNumber).toBe(1);
    expect(refund?.active).toBe(true);

    const lock = await db.collection('migration_locks').findOne({ _id: MIGRATION_ID } as any);
    expect(lock?.releasedAt).toBeTruthy();
  });

  it('auto-reclaims a stale migration lock without --resume', async () => {
    const admin = await seedAdmin();
    const payment = await seedPayment(admin._id, 'MIG-STALE');
    await ensureLegacyUniquePaymentIdIndex();
    await insertLegacyRefund({
      paymentId: payment._id,
      customerId: admin._id,
      schemeId: admin._id,
      merchantRefundId: 'RFD-STALE',
      originalMerchantOrderId: payment.merchantTransactionId,
      amountPaise: 100_000,
      status: 'FAILED',
      reason: 'stale',
      idempotencyKey: 'stale-1',
      requestHash: 'hash',
      requestedBy: admin._id,
      requestedAt: new Date('2026-07-01T10:00:00+05:30'),
    });

    const db = mongoose.connection.db!;
    await db.collection('migration_locks').replaceOne(
      { _id: MIGRATION_ID } as any,
      {
        _id: MIGRATION_ID,
        migrationId: MIGRATION_ID,
        lockedAt: new Date(Date.now() - 2 * 60 * 60_000),
        heartbeatAt: new Date(Date.now() - 2 * 60 * 60_000),
        releasedAt: null,
        host: 'stale-worker',
        phase: 'indexes',
      },
      { upsert: true },
    );

    const applied = await runRefundAttemptsApply({
      ack: MIGRATION_ACK_VALUE,
      staleLockMs: 30 * 60_000,
    });
    expect(applied.ok).toBe(true);
    expect(applied.staleLockReclaimed).toBe(true);
    expect(applied.resumed).toBe(true);
  });
});
