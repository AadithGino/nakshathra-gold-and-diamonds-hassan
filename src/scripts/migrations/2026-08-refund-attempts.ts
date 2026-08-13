/**
 * Refund attempts schema migration (V4 Phase 4).
 *
 * Usage:
 *   npm run migrate:refund-attempts -- --dry-run
 *   MIGRATE_REFUND_ATTEMPTS_ACK=I_UNDERSTAND npm run migrate:refund-attempts -- --apply
 *   MIGRATE_REFUND_ATTEMPTS_ACK=I_UNDERSTAND npm run migrate:refund-attempts -- --resume
 *   npm run migrate:refund-attempts -- --verify
 *
 * Stop API financial writes and refund workers before --apply/--resume in production.
 * --resume reclaims an incomplete lock after a crash (idempotent backfill + indexes).
 * Locks with no heartbeat for MIGRATION_STALE_LOCK_MS are also reclaimable.
 */
import mongoose from 'mongoose';
import { connectDatabase, disconnectDatabase } from '../../config/database.js';
import { Payment, Refund } from '../../models/index.js';

export const MIGRATION_ID = '2026-08-refund-attempts';
export const MIGRATION_ACK_VALUE = 'I_UNDERSTAND';
/** Incomplete apply locks older than this may be reclaimed with --resume or auto-stale reclaim. */
export const MIGRATION_STALE_LOCK_MS = 30 * 60_000;

const ACTIVE_BY_STATUS: Record<string, boolean> = {
  INITIATED: true,
  PENDING: true,
  SUCCESS: false,
  FAILED: false,
  REVIEW_REQUIRED: false,
};

const REQUIRED_INDEXES: Array<{
  name: string;
  key: Record<string, number>;
  unique?: boolean;
  partialFilterExpression?: Record<string, unknown>;
}> = [
  {
    name: 'paymentId_1_attemptNumber_1',
    key: { paymentId: 1, attemptNumber: 1 },
    unique: true,
  },
  {
    name: 'paymentId_1_active_partial',
    key: { paymentId: 1 },
    unique: true,
    partialFilterExpression: { active: true },
  },
  {
    name: 'requestedBy_1_idempotencyKey_1',
    key: { requestedBy: 1, idempotencyKey: 1 },
    unique: true,
  },
  {
    name: 'merchantRefundId_1',
    key: { merchantRefundId: 1 },
    unique: true,
  },
  {
    name: 'status_1_nextStatusCheckAt_1_recoveryLockUntil_1',
    key: { status: 1, nextStatusCheckAt: 1, recoveryLockUntil: 1 },
  },
];

export type MigrationReport = {
  mode: 'dry-run' | 'apply' | 'verify' | 'resume';
  resumed?: boolean;
  staleLockReclaimed?: boolean;
  totalRefunds: number;
  missingAttemptNumber: number;
  missingActive: number;
  paymentsWithMultipleRefunds: number;
  paymentsWithMultipleNonterminal: number;
  duplicateMerchantRefundIds: number;
  duplicateAdminIdempotencyKeys: number;
  existingIndexes: Array<Record<string, unknown>>;
  legacyUniquePaymentIdIndex: string | null;
  unsafeConflicts: string[];
  proposedBackfills: Array<{ refundId: string; attemptNumber: number; active: boolean }>;
  documentsChanged: number;
  indexesDropped: string[];
  indexesCreated: string[];
  verificationErrors: string[];
  ok: boolean;
};

function sameKeyPattern(
  a: Record<string, number>,
  b: Record<string, number>,
) {
  const aKeys = Object.keys(a);
  const bKeys = Object.keys(b);
  if (aKeys.length !== bKeys.length) return false;
  return aKeys.every((key) => a[key] === b[key]);
}

function samePartialFilter(a: unknown, b: unknown) {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

export function mapActiveForStatus(status: string): boolean | null {
  if (!(status in ACTIVE_BY_STATUS)) return null;
  return ACTIVE_BY_STATUS[status]!;
}

async function refundCollection() {
  const db = mongoose.connection.db;
  if (!db) throw new Error('MongoDB connection is not ready');
  return db.collection('refunds');
}

async function migrationsCollection() {
  const db = mongoose.connection.db;
  if (!db) throw new Error('MongoDB connection is not ready');
  return db.collection('schema_migrations');
}

async function locksCollection() {
  const db = mongoose.connection.db;
  if (!db) throw new Error('MongoDB connection is not ready');
  return db.collection('migration_locks');
}

export async function listRefundIndexes() {
  const collection = await refundCollection();
  return collection.indexes();
}

export function findLegacyUniquePaymentIdIndex(
  indexes: Array<Record<string, unknown>>,
): string | null {
  for (const index of indexes) {
    const key = index.key as Record<string, number> | undefined;
    if (!key || !sameKeyPattern(key, { paymentId: 1 })) continue;
    if (!index.unique) continue;
    // New attempt model uses partial unique on active=true — that is NOT legacy.
    if (index.partialFilterExpression) continue;
    return String(index.name ?? 'paymentId_1');
  }
  return null;
}

async function collectConflicts(): Promise<string[]> {
  const conflicts: string[] = [];

  const multiActive = await Refund.aggregate([
    { $match: { active: true } },
    { $group: { _id: '$paymentId', count: { $sum: 1 }, ids: { $push: '$_id' } } },
    { $match: { count: { $gt: 1 } } },
  ]);
  for (const row of multiActive) {
    conflicts.push(
      `Payment ${row._id} has ${row.count} active refund attempts (${row.ids.join(', ')})`,
    );
  }

  const duplicateAttempts = await Refund.aggregate([
    {
      $match: {
        attemptNumber: { $exists: true, $ne: null },
      },
    },
    {
      $group: {
        _id: { paymentId: '$paymentId', attemptNumber: '$attemptNumber' },
        count: { $sum: 1 },
      },
    },
    { $match: { count: { $gt: 1 } } },
  ]);
  for (const row of duplicateAttempts) {
    conflicts.push(
      `Duplicate (paymentId, attemptNumber)=(${row._id.paymentId}, ${row._id.attemptNumber})`,
    );
  }

  const duplicateMerchants = await Refund.aggregate([
    {
      $group: {
        _id: '$merchantRefundId',
        count: { $sum: 1 },
      },
    },
    { $match: { count: { $gt: 1 }, _id: { $nin: [null, ''] } } },
  ]);
  for (const row of duplicateMerchants) {
    conflicts.push(`Duplicate merchantRefundId ${row._id}`);
  }

  const duplicateIdempotency = await Refund.aggregate([
    {
      $group: {
        _id: { requestedBy: '$requestedBy', idempotencyKey: '$idempotencyKey' },
        count: { $sum: 1 },
      },
    },
    { $match: { count: { $gt: 1 } } },
  ]);
  for (const row of duplicateIdempotency) {
    conflicts.push(
      `Duplicate (requestedBy, idempotencyKey)=(${row._id.requestedBy}, ${row._id.idempotencyKey})`,
    );
  }

  const refundedWithoutSuccess = await Payment.find({ status: 'REFUNDED' })
    .select('_id refundId')
    .lean();
  for (const payment of refundedWithoutSuccess) {
    const success = await Refund.findOne({
      paymentId: payment._id,
      status: 'SUCCESS',
    })
      .select('_id')
      .lean();
    if (!success) {
      conflicts.push(`Payment ${payment._id} is REFUNDED without a SUCCESS Refund`);
    }
  }

  const successRefunds = await Refund.find({ status: 'SUCCESS' })
    .select('_id paymentId')
    .lean();
  for (const refund of successRefunds) {
    const payment = await Payment.findById(refund.paymentId).select('status').lean();
    if (!payment || payment.status !== 'REFUNDED') {
      conflicts.push(
        `Successful refund ${refund._id} payment ${refund.paymentId} is not REFUNDED (status=${payment?.status ?? 'missing'})`,
      );
    }
  }

  const activeOnRefunded = await Refund.aggregate([
    { $match: { active: true } },
    {
      $lookup: {
        from: 'payments',
        localField: 'paymentId',
        foreignField: '_id',
        as: 'payment',
      },
    },
    { $unwind: '$payment' },
    { $match: { 'payment.status': 'REFUNDED' } },
  ]);
  for (const row of activeOnRefunded) {
    conflicts.push(
      `Active refund ${row._id} exists for already REFUNDED payment ${row.paymentId}`,
    );
  }

  const amountMismatches = await Refund.aggregate([
    {
      $lookup: {
        from: 'payments',
        localField: 'paymentId',
        foreignField: '_id',
        as: 'payment',
      },
    },
    { $unwind: '$payment' },
    { $match: { $expr: { $ne: ['$amountPaise', '$payment.amountPaise'] } } },
    { $limit: 50 },
  ]);
  for (const row of amountMismatches) {
    conflicts.push(
      `Refund ${row._id} amount ${row.amountPaise} differs from payment ${row.paymentId} amount ${row.payment.amountPaise} (partial/full mismatch)`,
    );
  }

  const unknownStatuses = await Refund.find({
    status: { $nin: Object.keys(ACTIVE_BY_STATUS) },
  })
    .select('_id status')
    .lean();
  for (const refund of unknownStatuses) {
    conflicts.push(`Refund ${refund._id} has unmapped status ${refund.status}`);
  }

  return conflicts;
}

async function buildInspection(mode: MigrationReport['mode']): Promise<MigrationReport> {
  type RefundLean = {
    _id: unknown;
    paymentId: unknown;
    status?: string;
    attemptNumber?: number | null;
    active?: boolean | null;
    requestedAt?: Date | null;
    merchantRefundId?: string;
    requestedBy?: unknown;
    idempotencyKey?: string;
  };
  const refunds = (await Refund.find({})
    .select('_id paymentId status attemptNumber active requestedAt merchantRefundId requestedBy idempotencyKey')
    .lean()) as RefundLean[];

  const missingAttemptNumber = refunds.filter((r: RefundLean) => r.attemptNumber == null).length;
  const missingActive = refunds.filter((r: RefundLean) => r.active == null).length;

  const byPayment = new Map<string, RefundLean[]>();
  for (const refund of refunds) {
    const key = String(refund.paymentId);
    const list = byPayment.get(key) ?? [];
    list.push(refund);
    byPayment.set(key, list);
  }

  let paymentsWithMultipleRefunds = 0;
  let paymentsWithMultipleNonterminal = 0;
  const proposedBackfills: MigrationReport['proposedBackfills'] = [];

  for (const [, list] of byPayment) {
    if (list.length > 1) paymentsWithMultipleRefunds += 1;
    const nonterminal = list.filter(
      (r: RefundLean) => r.status === 'INITIATED' || r.status === 'PENDING',
    );
    if (nonterminal.length > 1) paymentsWithMultipleNonterminal += 1;

    const sorted = [...list].sort((a, b) => {
      const at = new Date(a.requestedAt ?? 0).getTime() - new Date(b.requestedAt ?? 0).getTime();
      if (at !== 0) return at;
      return String(a._id).localeCompare(String(b._id));
    });
    sorted.forEach((refund, index) => {
      const active = mapActiveForStatus(String(refund.status));
      if (active == null) return;
      proposedBackfills.push({
        refundId: String(refund._id),
        attemptNumber: index + 1,
        active,
      });
    });
  }

  const duplicateMerchantRefundIds = (
    await Refund.aggregate([
      { $group: { _id: '$merchantRefundId', count: { $sum: 1 } } },
      { $match: { count: { $gt: 1 }, _id: { $nin: [null, ''] } } },
    ])
  ).length;

  const duplicateAdminIdempotencyKeys = (
    await Refund.aggregate([
      {
        $group: {
          _id: { requestedBy: '$requestedBy', idempotencyKey: '$idempotencyKey' },
          count: { $sum: 1 },
        },
      },
      { $match: { count: { $gt: 1 } } },
    ])
  ).length;

  const existingIndexes = await listRefundIndexes();
  const legacyUniquePaymentIdIndex = findLegacyUniquePaymentIdIndex(existingIndexes);
  const unsafeConflicts = await collectConflicts();

  // Pre-backfill: multiple nonterminal without active field still need reporting.
  if (paymentsWithMultipleNonterminal > 0) {
    unsafeConflicts.push(
      `${paymentsWithMultipleNonterminal} payments have more than one nonterminal Refund`,
    );
  }

  return {
    mode,
    totalRefunds: refunds.length,
    missingAttemptNumber,
    missingActive,
    paymentsWithMultipleRefunds,
    paymentsWithMultipleNonterminal,
    duplicateMerchantRefundIds,
    duplicateAdminIdempotencyKeys,
    existingIndexes,
    legacyUniquePaymentIdIndex,
    unsafeConflicts: [...new Set(unsafeConflicts)],
    proposedBackfills,
    documentsChanged: 0,
    indexesDropped: [],
    indexesCreated: [],
    verificationErrors: [],
    ok: unsafeConflicts.length === 0,
  };
}

async function backfillDocuments(report: MigrationReport) {
  let changed = 0;

  const refunds = await Refund.find({})
    .select('_id paymentId status attemptNumber active requestedAt')
    .lean();
  const grouped = new Map<string, typeof refunds>();
  for (const refund of refunds) {
    const key = String(refund.paymentId);
    const list = grouped.get(key) ?? [];
    list.push(refund);
    grouped.set(key, list);
  }

  for (const [paymentId, list] of grouped) {
    const sorted = [...list].sort((a, b) => {
      const at = new Date(a.requestedAt ?? 0).getTime() - new Date(b.requestedAt ?? 0).getTime();
      if (at !== 0) return at;
      return String(a._id).localeCompare(String(b._id));
    });

    for (let i = 0; i < sorted.length; i++) {
      const refund = sorted[i]!;
      const active = mapActiveForStatus(String(refund.status));
      if (active == null) {
        throw new Error(`Cannot map status ${refund.status} for refund ${refund._id}`);
      }
      const attemptNumber = i + 1;
      if (refund.attemptNumber === attemptNumber && refund.active === active) continue;
      await Refund.updateOne(
        { _id: refund._id },
        { $set: { attemptNumber, active } },
      );
      changed += 1;
      console.log(
        JSON.stringify({
          action: 'backfill',
          refundId: String(refund._id),
          paymentId,
          attemptNumber,
          active,
          status: refund.status,
        }),
      );
    }

    // Payment.refundId linkage — never touch amount/gold fields.
    const payment = await Payment.findById(paymentId)
      .select('status refundStatus refundId')
      .lean();
    if (!payment) continue;

    const success = sorted.find((r) => r.status === 'SUCCESS');
    const activeAttempt = sorted.find((r) => mapActiveForStatus(String(r.status)) === true);

    if (payment.status === 'REFUNDED' && success) {
      if (String(payment.refundId ?? '') !== String(success._id)) {
        await Payment.updateOne(
          { _id: payment._id },
          { $set: { refundId: success._id, refundStatus: 'SUCCESS' } },
        );
        changed += 1;
      }
    } else if (
      (payment.refundStatus === 'PENDING' || payment.refundStatus === 'INITIATED') &&
      activeAttempt
    ) {
      if (String(payment.refundId ?? '') !== String(activeAttempt._id)) {
        await Payment.updateOne(
          { _id: payment._id },
          { $set: { refundId: activeAttempt._id } },
        );
        changed += 1;
      }
    }
  }

  void report;
  return changed;
}

async function migrateIndexes(report: MigrationReport) {
  const collection = await refundCollection();
  const indexes = await collection.indexes();
  const dropped: string[] = [];
  const created: string[] = [];

  const legacyName = findLegacyUniquePaymentIdIndex(indexes);
  if (legacyName) {
    await collection.dropIndex(legacyName);
    dropped.push(legacyName);
    console.log(JSON.stringify({ action: 'dropIndex', name: legacyName }));
  }

  const afterDrop = await collection.indexes();
  for (const required of REQUIRED_INDEXES) {
    const existing = afterDrop.find((index) => {
      const key = index.key as Record<string, number>;
      if (!sameKeyPattern(key, required.key as Record<string, number>)) return false;
      if (Boolean(index.unique) !== Boolean(required.unique)) return false;
      if (required.partialFilterExpression) {
        return samePartialFilter(index.partialFilterExpression, required.partialFilterExpression);
      }
      return !index.partialFilterExpression;
    });
    if (existing) continue;

    const options: Record<string, unknown> = { name: required.name };
    if (required.unique) options.unique = true;
    if (required.partialFilterExpression) {
      options.partialFilterExpression = required.partialFilterExpression;
    }
    await collection.createIndex(required.key, options);
    created.push(required.name);
    console.log(JSON.stringify({ action: 'createIndex', name: required.name, key: required.key }));
  }

  report.indexesDropped = dropped;
  report.indexesCreated = created;
}

export async function verifyRefundAttemptsMigration(): Promise<string[]> {
  const errors: string[] = [];
  const refunds = await Refund.find({}).select('attemptNumber active status paymentId').lean();

  for (const refund of refunds) {
    if (refund.attemptNumber == null || refund.attemptNumber < 1) {
      errors.push(`Refund ${refund._id} missing attemptNumber`);
    }
    if (refund.active == null) {
      errors.push(`Refund ${refund._id} missing active`);
    }
    const expected = mapActiveForStatus(String(refund.status));
    if (expected != null && refund.active !== expected) {
      errors.push(
        `Refund ${refund._id} active=${refund.active} incompatible with status=${refund.status}`,
      );
    }
    if (['SUCCESS', 'FAILED', 'REVIEW_REQUIRED'].includes(String(refund.status)) && refund.active) {
      errors.push(`Terminal refund ${refund._id} still active`);
    }
  }

  const multiActive = await Refund.aggregate([
    { $match: { active: true } },
    { $group: { _id: '$paymentId', count: { $sum: 1 } } },
    { $match: { count: { $gt: 1 } } },
  ]);
  if (multiActive.length) {
    errors.push(`${multiActive.length} payments have more than one active attempt`);
  }

  const duplicateAttempts = await Refund.aggregate([
    {
      $group: {
        _id: { paymentId: '$paymentId', attemptNumber: '$attemptNumber' },
        count: { $sum: 1 },
      },
    },
    { $match: { count: { $gt: 1 } } },
  ]);
  if (duplicateAttempts.length) {
    errors.push(`${duplicateAttempts.length} duplicate (paymentId, attemptNumber) pairs`);
  }

  const indexes = await listRefundIndexes();
  if (findLegacyUniquePaymentIdIndex(indexes)) {
    errors.push('Legacy unique paymentId index is still present');
  }

  for (const required of REQUIRED_INDEXES) {
    const found = indexes.find((index) => {
      const key = index.key as Record<string, number>;
      if (!sameKeyPattern(key, required.key as Record<string, number>)) return false;
      if (Boolean(index.unique) !== Boolean(required.unique)) return false;
      if (required.partialFilterExpression) {
        return samePartialFilter(index.partialFilterExpression, required.partialFilterExpression);
      }
      return !index.partialFilterExpression;
    });
    if (!found) {
      errors.push(`Required index missing or mismatched: ${required.name}`);
    }
  }

  const refunded = await Payment.find({ status: 'REFUNDED' }).select('_id refundId').lean();
  for (const payment of refunded) {
    if (!payment.refundId) {
      errors.push(`REFUNDED payment ${payment._id} missing refundId`);
      continue;
    }
    const refund = await Refund.findById(payment.refundId).select('status').lean();
    if (!refund || refund.status !== 'SUCCESS') {
      errors.push(`REFUNDED payment ${payment._id} does not link to SUCCESS refund`);
    }
  }

  const pendingPayments = await Payment.find({
    refundStatus: { $in: ['PENDING', 'INITIATED'] },
  })
    .select('_id refundId')
    .lean();
  for (const payment of pendingPayments) {
    if (!payment.refundId) {
      errors.push(`Pending-refund payment ${payment._id} missing refundId`);
      continue;
    }
    const refund = await Refund.findById(payment.refundId).select('active status').lean();
    if (!refund?.active) {
      errors.push(`Pending-refund payment ${payment._id} does not link to an active attempt`);
    }
  }

  const amountMismatches = await Refund.aggregate([
    {
      $lookup: {
        from: 'payments',
        localField: 'paymentId',
        foreignField: '_id',
        as: 'payment',
      },
    },
    { $unwind: '$payment' },
    { $match: { $expr: { $ne: ['$amountPaise', '$payment.amountPaise'] } } },
    { $limit: 20 },
  ]);
  for (const row of amountMismatches) {
    errors.push(`Partial/mismatched refund amount for ${row._id}`);
  }

  return errors;
}

export async function runRefundAttemptsDryRun(): Promise<MigrationReport> {
  const report = await buildInspection('dry-run');
  report.ok = report.unsafeConflicts.length === 0;
  return report;
}

export async function runRefundAttemptsApply(options?: {
  ack?: string;
  skipAck?: boolean;
  resume?: boolean;
  staleLockMs?: number;
}): Promise<MigrationReport> {
  if (!options?.skipAck && options?.ack !== MIGRATION_ACK_VALUE) {
    throw new Error(
      `Refuse to apply: set MIGRATE_REFUND_ATTEMPTS_ACK=${MIGRATION_ACK_VALUE} (or pass matching ack)`,
    );
  }

  const resume = Boolean(options?.resume);
  const staleLockMs = options?.staleLockMs ?? MIGRATION_STALE_LOCK_MS;
  const locks = await locksCollection();
  const now = new Date();
  let staleLockReclaimed = false;
  let resumed = false;

  const activeLock = await locks.findOne({
    releasedAt: null,
  });

  if (activeLock && String(activeLock._id) !== MIGRATION_ID) {
    throw new Error(`Another migration lock exists: ${JSON.stringify(activeLock)}`);
  }

  if (activeLock && String(activeLock._id) === MIGRATION_ID) {
    const heartbeatAt = activeLock.heartbeatAt
      ? new Date(String(activeLock.heartbeatAt))
      : activeLock.lockedAt
        ? new Date(String(activeLock.lockedAt))
        : null;
    const ageMs = heartbeatAt ? now.getTime() - heartbeatAt.getTime() : Number.POSITIVE_INFINITY;
    const isStale = ageMs >= staleLockMs;

    if (!resume && !isStale) {
      throw new Error(
        `Migration ${MIGRATION_ID} is locked (incomplete prior run). ` +
          `Re-run with --resume after confirming no other apply is running, ` +
          `or wait until the lock is stale (>${Math.round(staleLockMs / 60_000)}m).`,
      );
    }

    staleLockReclaimed = isStale;
    resumed = true;
    console.log(
      JSON.stringify({
        action: 'reclaimLock',
        migrationId: MIGRATION_ID,
        resume,
        staleLockReclaimed,
        previousHeartbeatAt: heartbeatAt,
      }),
    );
  }

  const report = await buildInspection(resume || staleLockReclaimed ? 'resume' : 'apply');
  if (report.unsafeConflicts.length) {
    report.ok = false;
    report.resumed = resumed;
    report.staleLockReclaimed = staleLockReclaimed;
    return report;
  }

  await locks.replaceOne(
    { _id: MIGRATION_ID } as Record<string, unknown>,
    {
      _id: MIGRATION_ID,
      migrationId: MIGRATION_ID,
      lockedAt: activeLock?.lockedAt ? new Date(String(activeLock.lockedAt)) : now,
      heartbeatAt: now,
      releasedAt: null,
      host: process.env.HOSTNAME ?? 'local',
      resumeCount: Number(activeLock?.resumeCount ?? 0) + (resumed ? 1 : 0),
      phase: 'starting',
    } as Record<string, unknown>,
    { upsert: true },
  );

  const touchHeartbeat = async (phase: string) => {
    await locks.updateOne(
      { _id: MIGRATION_ID } as Record<string, unknown>,
      { $set: { heartbeatAt: new Date(), phase } },
    );
  };

  try {
    await touchHeartbeat('backfill');
    report.documentsChanged = await backfillDocuments(report);
    await touchHeartbeat('indexes');
    await migrateIndexes(report);
    await touchHeartbeat('record_completion');

    const migrations = await migrationsCollection();
    await migrations.updateOne(
      { _id: MIGRATION_ID } as Record<string, unknown>,
      {
        $set: {
          migrationId: MIGRATION_ID,
          completedAt: new Date(),
          documentsChanged: report.documentsChanged,
          indexesDropped: report.indexesDropped,
          indexesCreated: report.indexesCreated,
          resumed,
          staleLockReclaimed,
        },
      },
      { upsert: true },
    );

    await touchHeartbeat('verify');
    report.verificationErrors = await verifyRefundAttemptsMigration();
    report.ok = report.verificationErrors.length === 0;
    report.resumed = resumed;
    report.staleLockReclaimed = staleLockReclaimed;
    return report;
  } finally {
    await locks.updateOne(
      { _id: MIGRATION_ID } as Record<string, unknown>,
      { $set: { releasedAt: new Date(), heartbeatAt: new Date(), phase: 'released' } },
    );
  }
}

export async function runRefundAttemptsVerify(): Promise<MigrationReport> {
  const report = await buildInspection('verify');
  report.verificationErrors = await verifyRefundAttemptsMigration();
  report.ok = report.verificationErrors.length === 0 && report.unsafeConflicts.length === 0;
  return report;
}

function parseMode(argv: string[]) {
  if (argv.includes('--dry-run')) return 'dry-run' as const;
  if (argv.includes('--apply') || argv.includes('--resume')) return 'apply' as const;
  if (argv.includes('--verify')) return 'verify' as const;
  return null;
}

export async function main(argv = process.argv.slice(2)) {
  const mode = parseMode(argv);
  if (!mode) {
    console.error('Usage: --dry-run | --apply | --resume | --verify');
    process.exit(2);
  }

  await connectDatabase();
  try {
    let report: MigrationReport;
    if (mode === 'dry-run') {
      report = await runRefundAttemptsDryRun();
    } else if (mode === 'apply') {
      report = await runRefundAttemptsApply({
        ack: process.env.MIGRATE_REFUND_ATTEMPTS_ACK,
        resume: argv.includes('--resume'),
      });
    } else {
      report = await runRefundAttemptsVerify();
    }

    console.log(
      JSON.stringify(
        {
          migrationId: MIGRATION_ID,
          ...report,
          existingIndexes: report.existingIndexes.map((index) => ({
            name: index.name,
            key: index.key,
            unique: index.unique,
            partialFilterExpression: index.partialFilterExpression,
          })),
        },
        null,
        2,
      ),
    );

    if (!report.ok) process.exit(1);
  } finally {
    await disconnectDatabase();
  }
}

const isDirectRun =
  process.argv[1]?.includes('2026-08-refund-attempts') ||
  process.argv[1]?.includes('migrate-refund-attempts');

if (isDirectRun) {
  main().catch(async (error) => {
    console.error(error);
    await disconnectDatabase().catch(() => undefined);
    process.exit(1);
  });
}
