/**
 * Backfill SchemeEnrollment.planSnapshot from the referenced SchemePlan.
 *
 * Usage:
 *   npm run migrate:enrollment-plan-snapshots -- --dry-run
 *   MIGRATE_ENROLLMENT_PLAN_SNAPSHOTS_ACK=I_UNDERSTAND npm run migrate:enrollment-plan-snapshots -- --apply
 *   MIGRATE_ENROLLMENT_PLAN_SNAPSHOTS_ACK=I_UNDERSTAND npm run migrate:enrollment-plan-snapshots -- --resume
 *   npm run migrate:enrollment-plan-snapshots -- --verify
 *
 * Does not modify payments, gold, installment amount, status, or dates.
 * Legacy snapshots are current plan values, not historically reconstructed terms.
 */
import mongoose from 'mongoose';
import { connectDatabase, disconnectDatabase } from '../../config/database.js';
import { SchemeEnrollment, SchemePlan } from '../../models/index.js';
import { buildPlanSnapshot } from '../../utils/scheme-contract.js';

export const MIGRATION_ID = '2026-08-enrollment-plan-snapshots';
export const MIGRATION_ACK_VALUE = 'I_UNDERSTAND';
export const MIGRATION_STALE_LOCK_MS = 30 * 60_000;

const NEEDS_BACKFILL = {
  $or: [
    { planSnapshot: { $exists: false } },
    { planSnapshot: null },
    { 'planSnapshot.version': { $exists: false } },
    { schemePlanVersion: { $exists: false } },
    { schemePlanVersion: null },
  ],
};

export type EnrollmentPlanSnapshotReport = {
  mode: 'dry-run' | 'apply' | 'verify' | 'resume';
  resumed?: boolean;
  staleLockReclaimed?: boolean;
  scanned: number;
  updated: number;
  skipped: number;
  verificationErrors: string[];
  ok: boolean;
};

async function enrollmentsCollection() {
  const db = mongoose.connection.db;
  if (!db) throw new Error('MongoDB connection is not ready');
  return db.collection(SchemeEnrollment.collection.collectionName);
}

async function plansCollection() {
  const db = mongoose.connection.db;
  if (!db) throw new Error('MongoDB connection is not ready');
  return db.collection(SchemePlan.collection.collectionName);
}

async function locksCollection() {
  const db = mongoose.connection.db;
  if (!db) throw new Error('MongoDB connection is not ready');
  return db.collection('migration_locks');
}

async function migrationsCollection() {
  const db = mongoose.connection.db;
  if (!db) throw new Error('MongoDB connection is not ready');
  return db.collection('schema_migrations');
}

function needsUpdate(doc: {
  planSnapshot?: { version?: number } | null;
  schemePlanVersion?: number | null;
}) {
  return doc.planSnapshot?.version == null || doc.schemePlanVersion == null;
}

export async function inspectEnrollmentPlanSnapshots() {
  const enrollments = await enrollmentsCollection();
  const scanned = await enrollments.countDocuments({});
  const pending = await enrollments.countDocuments(NEEDS_BACKFILL);
  return { scanned, pending, skipped: scanned - pending };
}

export async function backfillEnrollmentPlanSnapshots(dryRun: boolean) {
  const enrollments = await enrollmentsCollection();
  const plans = await plansCollection();
  const cursor = enrollments.find(NEEDS_BACKFILL);
  let scanned = 0;
  let updated = 0;
  let skipped = 0;
  const capturedAt = new Date();

  for await (const raw of cursor) {
    scanned += 1;
    const doc = raw as {
      _id: mongoose.Types.ObjectId;
      schemePlanId?: mongoose.Types.ObjectId;
      planSnapshot?: { version?: number } | null;
      schemePlanVersion?: number | null;
    };
    if (!needsUpdate(doc)) {
      skipped += 1;
      continue;
    }
    if (!doc.schemePlanId) {
      skipped += 1;
      continue;
    }
    const plan = await plans.findOne({ _id: doc.schemePlanId });
    if (!plan) {
      skipped += 1;
      continue;
    }
    const planSnapshot = buildPlanSnapshot(plan as any);
    if (dryRun) {
      updated += 1;
      continue;
    }
    const result = await enrollments.updateOne(
      {
        _id: doc._id,
        $or: [
          { planSnapshot: { $exists: false } },
          { planSnapshot: null },
          { 'planSnapshot.version': { $exists: false } },
          { schemePlanVersion: { $exists: false } },
          { schemePlanVersion: null },
        ],
      },
      {
        $set: {
          planSnapshot,
          schemePlanVersion: planSnapshot.version,
          snapshotSource: 'LEGACY_BACKFILL',
          snapshotCapturedAt: capturedAt,
        },
      },
    );
    if (result.modifiedCount > 0) updated += 1;
    else skipped += 1;
  }

  return { scanned, updated, skipped };
}

export async function verifyEnrollmentPlanSnapshots() {
  const enrollments = await enrollmentsCollection();
  const errors: string[] = [];
  const missing = await enrollments
    .find(NEEDS_BACKFILL)
    .project({
      _id: 1,
      totalPaidPaise: 1,
      totalGoldWeightMg: 1,
      monthlyInstallmentPaise: 1,
      status: 1,
    })
    .limit(20)
    .toArray();
  for (const row of missing) {
    errors.push(`Enrollment ${row._id} is missing planSnapshot or schemePlanVersion`);
  }
  return errors;
}

async function acquireLock(resume: boolean) {
  const locks = await locksCollection();
  const now = new Date();
  const existing = await locks.findOne({ _id: MIGRATION_ID } as Record<string, unknown>);
  const stale =
    existing &&
    !existing.releasedAt &&
    existing.heartbeatAt &&
    now.getTime() - new Date(existing.heartbeatAt).getTime() > MIGRATION_STALE_LOCK_MS;

  if (existing && !existing.releasedAt && !stale && !resume) {
    throw new Error(`Migration ${MIGRATION_ID} is already locked`);
  }

  const staleLockReclaimed = Boolean(stale);
  await locks.updateOne(
    { _id: MIGRATION_ID } as Record<string, unknown>,
    {
      $set: {
        migrationId: MIGRATION_ID,
        heartbeatAt: now,
        acquiredAt: now,
        releasedAt: null,
        phase: 'starting',
        resume,
        staleLockReclaimed,
      },
    },
    { upsert: true },
  );
  return { resumed: resume, staleLockReclaimed };
}

export async function runEnrollmentPlanSnapshotsDryRun(): Promise<EnrollmentPlanSnapshotReport> {
  const { scanned, pending, skipped } = await inspectEnrollmentPlanSnapshots();
  return {
    mode: 'dry-run',
    scanned,
    updated: pending,
    skipped,
    verificationErrors: [],
    ok: true,
  };
}

export async function runEnrollmentPlanSnapshotsApply(input: {
  ack?: string;
  resume?: boolean;
}): Promise<EnrollmentPlanSnapshotReport> {
  if (input.ack !== MIGRATION_ACK_VALUE) {
    throw new Error(`Set MIGRATE_ENROLLMENT_PLAN_SNAPSHOTS_ACK=${MIGRATION_ACK_VALUE} to apply`);
  }
  const { resumed, staleLockReclaimed } = await acquireLock(Boolean(input.resume));
  const locks = await locksCollection();
  try {
    const result = await backfillEnrollmentPlanSnapshots(false);
    const verificationErrors = await verifyEnrollmentPlanSnapshots();
    await (await migrationsCollection()).updateOne(
      { _id: MIGRATION_ID } as Record<string, unknown>,
      {
        $set: {
          migrationId: MIGRATION_ID,
          completedAt: new Date(),
          scanned: result.scanned,
          updated: result.updated,
          skipped: result.skipped,
        },
      },
      { upsert: true },
    );
    return {
      mode: input.resume ? 'resume' : 'apply',
      resumed,
      staleLockReclaimed,
      scanned: result.scanned,
      updated: result.updated,
      skipped: result.skipped,
      verificationErrors,
      ok: verificationErrors.length === 0,
    };
  } finally {
    await locks.updateOne(
      { _id: MIGRATION_ID } as Record<string, unknown>,
      { $set: { releasedAt: new Date(), heartbeatAt: new Date(), phase: 'released' } },
    );
  }
}

export async function runEnrollmentPlanSnapshotsVerify(): Promise<EnrollmentPlanSnapshotReport> {
  const { scanned, pending, skipped } = await inspectEnrollmentPlanSnapshots();
  const verificationErrors = await verifyEnrollmentPlanSnapshots();
  return {
    mode: 'verify',
    scanned,
    updated: 0,
    skipped,
    verificationErrors,
    ok: verificationErrors.length === 0 && pending === 0,
  };
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
    let report: EnrollmentPlanSnapshotReport;
    if (mode === 'dry-run') report = await runEnrollmentPlanSnapshotsDryRun();
    else if (mode === 'apply') {
      report = await runEnrollmentPlanSnapshotsApply({
        ack: process.env.MIGRATE_ENROLLMENT_PLAN_SNAPSHOTS_ACK,
        resume: argv.includes('--resume'),
      });
    } else report = await runEnrollmentPlanSnapshotsVerify();
    console.log(JSON.stringify({ migrationId: MIGRATION_ID, ...report }, null, 2));
    if (!report.ok) process.exit(1);
  } finally {
    await disconnectDatabase();
  }
}

const isDirectRun =
  process.argv[1]?.includes('2026-08-enrollment-plan-snapshots') ||
  process.argv[1]?.includes('migrate-enrollment-plan-snapshots');

if (isDirectRun) {
  main().catch(async (error) => {
    console.error(error);
    await disconnectDatabase().catch(() => undefined);
    process.exit(1);
  });
}
