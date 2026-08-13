/**
 * Nakshathra 6+5 scheme engine:
 * - drop the unique SUCCESS scheme-month payment index (multi-pay is required)
 * - create a non-unique SUCCESS scheme-month lookup index
 * - update live CASH plans to 6 flexible + 5 capped + AVERAGE_SUCCESSFUL_PAYMENT_FIRST_6
 *
 * Does not rewrite enrollment snapshots. Historical contracts stay as stored.
 *
 * Usage:
 *   npm run migrate:nakshathra-scheme-engine -- --dry-run
 *   MIGRATE_NAKSHATHRA_SCHEME_ENGINE_ACK=I_UNDERSTAND npm run migrate:nakshathra-scheme-engine -- --apply
 *   npm run migrate:nakshathra-scheme-engine -- --verify
 */
import {
  NAKSHATHRA_CAP_STRATEGY,
  NAKSHATHRA_CAPPED_MONTHS,
  NAKSHATHRA_CONTRIBUTION_POLICY_VERSION,
  NAKSHATHRA_FLEXIBLE_MONTHS,
  LIVE_SCHEME_TYPE,
} from '../../config/business.js';
import { connectDatabase, disconnectDatabase } from '../../config/database.js';
import { Payment, SchemePlan } from '../../models/index.js';

export const MIGRATION_ID = '2026-08-nakshathra-scheme-engine';
export const MIGRATION_ACK_VALUE = 'I_UNDERSTAND';
export const LEGACY_SUCCESS_MONTH_UNIQUE = 'PAYMENT_SUCCESS_SCHEME_MONTH_UNIQUE';
export const SUCCESS_MONTH_LOOKUP = 'PAYMENT_SUCCESS_SCHEME_MONTH';

export type NakshathraSchemeEngineReport = {
  mode: 'dry-run' | 'apply' | 'verify';
  uniqueIndexPresent: boolean;
  lookupIndexPresent: boolean;
  lookupIndexUnique: boolean | null;
  cashPlansScanned: number;
  cashPlansNeedingUpdate: number;
  cashPlansUpdated: number;
  uniqueIndexDropped: boolean;
  lookupIndexCreated: boolean;
  verificationErrors: string[];
  ok: boolean;
};

function liveCashPlanNeedsUpdate(plan: {
  type?: string;
  flexibleMonths?: number;
  capMonths?: number;
  capStrategy?: string;
  contributionPolicyVersion?: number;
}) {
  return (
    plan.type === LIVE_SCHEME_TYPE &&
    (plan.flexibleMonths !== NAKSHATHRA_FLEXIBLE_MONTHS ||
      plan.capMonths !== NAKSHATHRA_CAPPED_MONTHS ||
      plan.capStrategy !== NAKSHATHRA_CAP_STRATEGY ||
      plan.contributionPolicyVersion !== NAKSHATHRA_CONTRIBUTION_POLICY_VERSION)
  );
}

async function inspectIndexes() {
  const indexes = await Payment.collection.indexes();
  const unique = indexes.find(
    (index: { name?: string; unique?: boolean; key?: unknown; partialFilterExpression?: unknown }) =>
      index.name === LEGACY_SUCCESS_MONTH_UNIQUE ||
      (Boolean(index.unique) &&
        JSON.stringify(index.key) === JSON.stringify({ schemeId: 1, schemeMonth: 1 }) &&
        JSON.stringify(index.partialFilterExpression) === JSON.stringify({ status: 'SUCCESS' })),
  );
  const lookup = indexes.find(
    (index: { name?: string; unique?: boolean; key?: unknown; partialFilterExpression?: unknown }) =>
      index.name === SUCCESS_MONTH_LOOKUP ||
      (!index.unique &&
        JSON.stringify(index.key) === JSON.stringify({ schemeId: 1, schemeMonth: 1 }) &&
        JSON.stringify(index.partialFilterExpression) === JSON.stringify({ status: 'SUCCESS' })),
  );
  return {
    uniqueIndexPresent: Boolean(unique),
    uniqueIndexName: unique?.name,
    lookupIndexPresent: Boolean(lookup),
    lookupIndexUnique: lookup ? Boolean(lookup.unique) : null,
  };
}

export async function inspectNakshathraSchemeEngine() {
  const [indexState, cashPlans] = await Promise.all([
    inspectIndexes(),
    SchemePlan.find({ type: LIVE_SCHEME_TYPE, deletedAt: null }).lean(),
  ]);
  const cashPlansNeedingUpdate = cashPlans.filter(liveCashPlanNeedsUpdate).length;
  return {
    ...indexState,
    cashPlansScanned: cashPlans.length,
    cashPlansNeedingUpdate,
  };
}

export async function runNakshathraSchemeEngineDryRun(): Promise<NakshathraSchemeEngineReport> {
  const inspect = await inspectNakshathraSchemeEngine();
  const verificationErrors: string[] = [];
  if (inspect.uniqueIndexPresent) {
    verificationErrors.push('Unique SUCCESS scheme-month index is still present');
  }
  if (!inspect.lookupIndexPresent || inspect.lookupIndexUnique) {
    verificationErrors.push('Non-unique SUCCESS scheme-month lookup index is missing');
  }
  if (inspect.cashPlansNeedingUpdate > 0) {
    verificationErrors.push(`${inspect.cashPlansNeedingUpdate} live CASH plans still use 11-flex / no cap`);
  }
  return {
    mode: 'dry-run',
    ...inspect,
    cashPlansUpdated: 0,
    uniqueIndexDropped: false,
    lookupIndexCreated: false,
    verificationErrors,
    ok: verificationErrors.length === 0,
  };
}

export async function runNakshathraSchemeEngineApply(input: {
  ack?: string;
}): Promise<NakshathraSchemeEngineReport> {
  if (input.ack !== MIGRATION_ACK_VALUE) {
    throw new Error(
      `Refusing apply: set MIGRATE_NAKSHATHRA_SCHEME_ENGINE_ACK=${MIGRATION_ACK_VALUE}`,
    );
  }

  const before = await inspectNakshathraSchemeEngine();
  let uniqueIndexDropped = false;
  let lookupIndexCreated = false;

  if (before.uniqueIndexPresent && before.uniqueIndexName) {
    await Payment.collection.dropIndex(before.uniqueIndexName);
    uniqueIndexDropped = true;
  }

  const afterDrop = await inspectIndexes();
  if (!afterDrop.lookupIndexPresent) {
    await Payment.collection.createIndex(
      { schemeId: 1, schemeMonth: 1 },
      {
        unique: false,
        name: SUCCESS_MONTH_LOOKUP,
        partialFilterExpression: { status: 'SUCCESS' },
      },
    );
    lookupIndexCreated = true;
  }

  const update = await SchemePlan.updateMany(
    {
      type: LIVE_SCHEME_TYPE,
      deletedAt: null,
      $or: [
        { flexibleMonths: { $ne: NAKSHATHRA_FLEXIBLE_MONTHS } },
        { capMonths: { $ne: NAKSHATHRA_CAPPED_MONTHS } },
        { capStrategy: { $ne: NAKSHATHRA_CAP_STRATEGY } },
        { contributionPolicyVersion: { $ne: NAKSHATHRA_CONTRIBUTION_POLICY_VERSION } },
        { capStrategy: { $exists: false } },
        { contributionPolicyVersion: { $exists: false } },
      ],
    },
    {
      $set: {
        flexibleMonths: NAKSHATHRA_FLEXIBLE_MONTHS,
        capMonths: NAKSHATHRA_CAPPED_MONTHS,
        capStrategy: NAKSHATHRA_CAP_STRATEGY,
        contributionPolicyVersion: NAKSHATHRA_CONTRIBUTION_POLICY_VERSION,
      },
    },
  );

  const after = await inspectNakshathraSchemeEngine();
  const verificationErrors: string[] = [];
  if (after.uniqueIndexPresent) {
    verificationErrors.push('Unique SUCCESS scheme-month index is still present');
  }
  if (!after.lookupIndexPresent || after.lookupIndexUnique) {
    verificationErrors.push('Non-unique SUCCESS scheme-month lookup index is missing');
  }
  if (after.cashPlansNeedingUpdate > 0) {
    verificationErrors.push(`${after.cashPlansNeedingUpdate} live CASH plans still use 11-flex / no cap`);
  }

  return {
    mode: 'apply',
    ...after,
    cashPlansUpdated: update.modifiedCount,
    uniqueIndexDropped,
    lookupIndexCreated,
    verificationErrors,
    ok: verificationErrors.length === 0,
  };
}

export async function runNakshathraSchemeEngineVerify(): Promise<NakshathraSchemeEngineReport> {
  const inspect = await inspectNakshathraSchemeEngine();
  const verificationErrors: string[] = [];
  if (inspect.uniqueIndexPresent) {
    verificationErrors.push('Unique SUCCESS scheme-month index is still present');
  }
  if (!inspect.lookupIndexPresent || inspect.lookupIndexUnique) {
    verificationErrors.push('Non-unique SUCCESS scheme-month lookup index is missing');
  }
  if (inspect.cashPlansNeedingUpdate > 0) {
    verificationErrors.push(`${inspect.cashPlansNeedingUpdate} live CASH plans still use 11-flex / no cap`);
  }
  return {
    mode: 'verify',
    ...inspect,
    cashPlansUpdated: 0,
    uniqueIndexDropped: false,
    lookupIndexCreated: false,
    verificationErrors,
    ok: verificationErrors.length === 0,
  };
}

async function main() {
  const argv = process.argv.slice(2);
  const mode = argv.includes('--apply')
    ? 'apply'
    : argv.includes('--verify')
      ? 'verify'
      : argv.includes('--dry-run')
        ? 'dry-run'
        : undefined;
  if (!mode) {
    console.error('Usage: --dry-run | --apply | --verify');
    process.exit(2);
  }
  await connectDatabase();
  try {
    let report: NakshathraSchemeEngineReport;
    if (mode === 'dry-run') report = await runNakshathraSchemeEngineDryRun();
    else if (mode === 'apply') {
      report = await runNakshathraSchemeEngineApply({
        ack: process.env.MIGRATE_NAKSHATHRA_SCHEME_ENGINE_ACK,
      });
    } else report = await runNakshathraSchemeEngineVerify();
    console.log(JSON.stringify({ migrationId: MIGRATION_ID, ...report }, null, 2));
    if (!report.ok) process.exit(1);
  } finally {
    await disconnectDatabase();
  }
}

const isDirectRun =
  process.argv[1]?.includes('2026-08-nakshathra-scheme-engine') ||
  process.argv[1]?.includes('migrate-nakshathra-scheme-engine');

if (isDirectRun) {
  main().catch(async (error) => {
    console.error(error);
    await disconnectDatabase().catch(() => undefined);
    process.exit(1);
  });
}
