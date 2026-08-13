/**
 * Backfill Payment.accountingDate and Payment.recognizedAt.
 *
 * Usage:
 *   npm run migrate:payment-accounting-dates -- --dry-run
 *   MIGRATE_PAYMENT_ACCOUNTING_DATES_ACK=I_UNDERSTAND npm run migrate:payment-accounting-dates -- --apply
 *   MIGRATE_PAYMENT_ACCOUNTING_DATES_ACK=I_UNDERSTAND npm run migrate:payment-accounting-dates -- --resume
 *   npm run migrate:payment-accounting-dates -- --verify
 *
 * Does not modify amount, status, gold, or provider transaction identifiers.
 */
import mongoose from 'mongoose';
import { connectDatabase, disconnectDatabase } from '../../config/database.js';

export const MIGRATION_ID = '2026-08-payment-accounting-dates';
export const MIGRATION_ACK_VALUE = 'I_UNDERSTAND';
export const MIGRATION_STALE_LOCK_MS = 30 * 60_000;

const NEEDS_BACKFILL = {
  $or: [
    { accountingDate: { $exists: false } },
    { accountingDate: null },
    { recognizedAt: { $exists: false } },
    { recognizedAt: null },
  ],
};

export type PaymentAccountingDatesReport = {
  mode: 'dry-run' | 'apply' | 'verify' | 'resume';
  resumed?: boolean;
  staleLockReclaimed?: boolean;
  scanned: number;
  updated: number;
  skipped: number;
  verificationErrors: string[];
  ok: boolean;
};

async function paymentsCollection() {
  const db = mongoose.connection.db;
  if (!db) throw new Error('MongoDB connection is not ready');
  return db.collection('payments');
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
  accountingDate?: Date | null;
  recognizedAt?: Date | null;
}) {
  return doc.accountingDate == null || doc.recognizedAt == null;
}

export async function inspectPaymentAccountingDates() {
  const payments = await paymentsCollection();
  const scanned = await payments.countDocuments({});
  const pending = await payments.countDocuments(NEEDS_BACKFILL);
  return { scanned, pending, skipped: scanned - pending };
}

export async function backfillPaymentAccountingDates(dryRun: boolean) {
  const payments = await paymentsCollection();
  const cursor = payments.find(NEEDS_BACKFILL);
  let scanned = 0;
  let updated = 0;
  let skipped = 0;

  for await (const raw of cursor) {
    scanned += 1;
    const doc = raw as {
      _id: mongoose.Types.ObjectId;
      accountingDate?: Date | null;
      recognizedAt?: Date | null;
      paymentDate?: Date;
      createdAt?: Date;
    };
    if (!needsUpdate(doc)) {
      skipped += 1;
      continue;
    }
    const accountingDate = doc.accountingDate ?? doc.paymentDate;
    const recognizedAt = doc.recognizedAt ?? doc.createdAt ?? doc.paymentDate;
    if (!accountingDate || !recognizedAt) {
      skipped += 1;
      continue;
    }
    if (dryRun) {
      updated += 1;
      continue;
    }
    const result = await payments.updateOne(
      {
        _id: doc._id,
        $or: [
          { accountingDate: { $exists: false } },
          { accountingDate: null },
          { recognizedAt: { $exists: false } },
          { recognizedAt: null },
        ],
      },
      {
        $set: {
          ...(doc.accountingDate == null ? { accountingDate } : {}),
          ...(doc.recognizedAt == null ? { recognizedAt } : {}),
        },
      },
    );
    if (result.modifiedCount > 0) updated += 1;
    else skipped += 1;
  }

  const remaining = await payments.countDocuments(NEEDS_BACKFILL);
  return { scanned, updated, skipped, remaining };
}

export async function verifyPaymentAccountingDates() {
  const payments = await paymentsCollection();
  const errors: string[] = [];
  const missing = await payments
    .find(NEEDS_BACKFILL)
    .project({ _id: 1, amountPaise: 1, status: 1, goldWeightMg: 1 })
    .limit(20)
    .toArray();
  for (const row of missing) {
    errors.push(`Payment ${row._id} is missing accountingDate or recognizedAt`);
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

export async function runPaymentAccountingDatesDryRun(): Promise<PaymentAccountingDatesReport> {
  const { scanned, pending, skipped } = await inspectPaymentAccountingDates();
  return {
    mode: 'dry-run',
    scanned,
    updated: pending,
    skipped,
    verificationErrors: [],
    ok: true,
  };
}

export async function runPaymentAccountingDatesApply(input: {
  ack?: string;
  resume?: boolean;
}): Promise<PaymentAccountingDatesReport> {
  if (input.ack !== MIGRATION_ACK_VALUE) {
    throw new Error(`Set MIGRATE_PAYMENT_ACCOUNTING_DATES_ACK=${MIGRATION_ACK_VALUE} to apply`);
  }
  const { resumed, staleLockReclaimed } = await acquireLock(Boolean(input.resume));
  const locks = await locksCollection();
  try {
    const result = await backfillPaymentAccountingDates(false);
    const verificationErrors = await verifyPaymentAccountingDates();
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

export async function runPaymentAccountingDatesVerify(): Promise<PaymentAccountingDatesReport> {
  const { scanned, pending, skipped } = await inspectPaymentAccountingDates();
  const verificationErrors = await verifyPaymentAccountingDates();
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
    let report: PaymentAccountingDatesReport;
    if (mode === 'dry-run') report = await runPaymentAccountingDatesDryRun();
    else if (mode === 'apply') {
      report = await runPaymentAccountingDatesApply({
        ack: process.env.MIGRATE_PAYMENT_ACCOUNTING_DATES_ACK,
        resume: argv.includes('--resume'),
      });
    } else report = await runPaymentAccountingDatesVerify();
    console.log(JSON.stringify({ migrationId: MIGRATION_ID, ...report }, null, 2));
    if (!report.ok) process.exit(1);
  } finally {
    await disconnectDatabase();
  }
}

const isDirectRun =
  process.argv[1]?.includes('2026-08-payment-accounting-dates') ||
  process.argv[1]?.includes('migrate-payment-accounting-dates');

if (isDirectRun) {
  main().catch(async (error) => {
    console.error(error);
    await disconnectDatabase().catch(() => undefined);
    process.exit(1);
  });
}
