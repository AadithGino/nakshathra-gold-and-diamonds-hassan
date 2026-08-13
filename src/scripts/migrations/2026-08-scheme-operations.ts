/**
 * Backfill scheme-operations fields: payment windows, settlement policy,
 * and payout settlementPrincipalPaise. Detects duplicate SUCCESS payouts
 * without deleting financial rows.
 *
 * Existing enrollment snapshots stay conservative (no premature close, GOLD-only
 * maturity). Plans may receive future-enrollment defaults. Do not apply this
 * against an unknown/production database from this workspace.
 *
 * Usage:
 *   npm run migrate:scheme-operations -- --dry-run
 *   MIGRATE_SCHEME_OPERATIONS_ACK=I_UNDERSTAND npm run migrate:scheme-operations -- --apply
 *   npm run migrate:scheme-operations -- --verify
 *   npm run migrate:scheme-operations -- --dry-run --legacy-settlement-policy=ENABLE_PHASE9_POLICY
 */
import mongoose from 'mongoose';
import { connectDatabase, disconnectDatabase } from '../../config/database.js';
import { Payout, SchemeEnrollment, SchemePlan } from '../../models/index.js';
import { buildPlanSnapshot } from '../../utils/scheme-contract.js';
import {
  DEFAULT_SETTLEMENT_POLICY,
  LEGACY_ENROLLMENT_SETTLEMENT_POLICY,
  paymentWindowFromStartDate,
  validatePaymentWindow,
  validateSettlementPolicy,
} from '../../utils/payment-window.js';

export const MIGRATION_ID = '2026-08-scheme-operations';
export const MIGRATION_ACK_VALUE = 'I_UNDERSTAND';
export const LEGACY_POLICY_UPGRADE = 'ENABLE_PHASE9_POLICY';

export type EnrollmentLegacyPolicy = 'CONSERVATIVE' | 'ENABLE_PHASE9_POLICY';

export type SchemeOperationsReport = {
  mode: 'dry-run' | 'apply' | 'verify';
  scannedPlans: number;
  updatedPlans: number;
  scannedEnrollments: number;
  updatedEnrollments: number;
  scannedPayouts: number;
  updatedPayouts: number;
  duplicateSuccessPayoutSchemes: number;
  verificationErrors: string[];
  ok: boolean;
  enrollmentPolicy?: EnrollmentLegacyPolicy;
  paymentWindowBackfills?: number;
  legacyCompatibilityPolicy?: number;
  payoutPrincipalBackfills?: number;
  plansUpdated?: number;
  rightsUpgradeWarning?: string;
};

async function db() {
  if (!mongoose.connection.db) throw new Error('MongoDB connection is not ready');
  return mongoose.connection.db;
}

function needsPlanUpdate(plan: any) {
  return plan.paymentWindowType == null || plan.prematureClosureSettlementAssets == null;
}

function hasIntentionalPhase9Snapshot(enrollment: any) {
  return (
    typeof enrollment.prematureClosureEnabled === 'boolean' &&
    enrollment.paymentWindowType != null &&
    Array.isArray(enrollment.maturitySettlementAssets) &&
    enrollment.maturitySettlementAssets.length > 0
  );
}

function needsEnrollmentUpdate(enrollment: any) {
  return !hasIntentionalPhase9Snapshot(enrollment);
}

const PENDING_ENROLLMENT_FILTER = {
  $or: [
    { prematureClosureEnabled: { $exists: false } },
    { paymentWindowType: { $exists: false } },
    { maturitySettlementAssets: { $exists: false } },
    { maturitySettlementAssets: { $size: 0 } },
  ],
};

export async function inspectSchemeOperations() {
  const database = await db();
  const plans = database.collection(SchemePlan.collection.collectionName);
  const enrollments = database.collection(SchemeEnrollment.collection.collectionName);
  const payouts = database.collection(Payout.collection.collectionName);
  const duplicate = await payouts
    .aggregate([
      { $match: { status: 'SUCCESS' } },
      { $group: { _id: '$schemeId', count: { $sum: 1 } } },
      { $match: { count: { $gt: 1 } } },
    ])
    .toArray();
  return {
    scannedPlans: await plans.countDocuments({}),
    pendingPlans: await plans.countDocuments({
      $or: [{ paymentWindowType: { $exists: false } }, { prematureClosureSettlementAssets: { $exists: false } }],
    }),
    scannedEnrollments: await enrollments.countDocuments({}),
    pendingEnrollments: await enrollments.countDocuments(PENDING_ENROLLMENT_FILTER),
    scannedPayouts: await payouts.countDocuments({}),
    pendingPayouts: await payouts.countDocuments({
      $or: [{ settlementPrincipalPaise: { $exists: false } }, { settlementPrincipalPaise: null }],
    }),
    duplicateSuccessPayoutSchemes: duplicate.length,
  };
}

export async function backfillSchemeOperations(
  dryRun: boolean,
  enrollmentPolicy: EnrollmentLegacyPolicy = 'CONSERVATIVE',
) {
  const database = await db();
  const plans = database.collection(SchemePlan.collection.collectionName);
  const enrollments = database.collection(SchemeEnrollment.collection.collectionName);
  const payouts = database.collection(Payout.collection.collectionName);
  let updatedPlans = 0;
  let scannedPlans = 0;
  let updatedEnrollments = 0;
  let scannedEnrollments = 0;
  let updatedPayouts = 0;
  let scannedPayouts = 0;
  const enrollmentPolicySnapshot =
    enrollmentPolicy === 'ENABLE_PHASE9_POLICY'
      ? { ...DEFAULT_SETTLEMENT_POLICY }
      : { ...LEGACY_ENROLLMENT_SETTLEMENT_POLICY };

  for await (const plan of plans.find({})) {
    scannedPlans += 1;
    if (!needsPlanUpdate(plan)) continue;
    const window = validatePaymentWindow({
      paymentWindowType: plan.paymentWindowType ?? 'FIXED_DAY',
      fixedPaymentDay: plan.fixedPaymentDay ?? 5,
      paymentWindowStartDay: plan.paymentWindowStartDay,
      paymentWindowEndDay: plan.paymentWindowEndDay,
    });
    const policy = validateSettlementPolicy(plan as any);
    if (dryRun) {
      updatedPlans += 1;
      continue;
    }
    const result = await plans.updateOne({ _id: plan._id }, { $set: { ...window, ...policy } });
    if (result.modifiedCount) updatedPlans += 1;
  }

  for await (const enrollment of enrollments.find({})) {
    scannedEnrollments += 1;
    if (!needsEnrollmentUpdate(enrollment)) continue;
    const window = enrollment.startDate
      ? paymentWindowFromStartDate(enrollment.startDate)
      : validatePaymentWindow({ paymentWindowType: 'FIXED_DAY', fixedPaymentDay: 5 });
    const policy = { ...enrollmentPolicySnapshot };
    const snapshot = buildPlanSnapshot({
      ...(enrollment.planSnapshot ?? {}),
      ...window,
      ...policy,
      startDate: enrollment.startDate,
    });
    if (dryRun) {
      updatedEnrollments += 1;
      continue;
    }
    const result = await enrollments.updateOne(
      {
        _id: enrollment._id,
        ...PENDING_ENROLLMENT_FILTER,
      },
      {
        $set: {
          ...window,
          ...policy,
          planSnapshot: { ...(enrollment.planSnapshot ?? {}), ...snapshot },
        },
      },
    );
    if (result.modifiedCount) updatedEnrollments += 1;
  }

  for await (const payout of payouts.find({})) {
    scannedPayouts += 1;
    if (payout.settlementPrincipalPaise != null) continue;
    if (dryRun) {
      updatedPayouts += 1;
      continue;
    }
    const result = await payouts.updateOne(
      {
        _id: payout._id,
        $or: [{ settlementPrincipalPaise: { $exists: false } }, { settlementPrincipalPaise: null }],
      },
      { $set: { settlementPrincipalPaise: payout.amountPaise } },
    );
    if (result.modifiedCount) updatedPayouts += 1;
  }

  const duplicates = await payouts
    .aggregate([
      { $match: { status: 'SUCCESS' } },
      { $group: { _id: '$schemeId', count: { $sum: 1 } } },
      { $match: { count: { $gt: 1 } } },
    ])
    .toArray();

  return {
    scannedPlans,
    updatedPlans,
    scannedEnrollments,
    updatedEnrollments,
    scannedPayouts,
    updatedPayouts,
    duplicateSuccessPayoutSchemes: duplicates.length,
    enrollmentPolicy,
    paymentWindowBackfills: updatedEnrollments,
    legacyCompatibilityPolicy: updatedEnrollments,
    payoutPrincipalBackfills: updatedPayouts,
    plansUpdated: updatedPlans,
  };
}

export async function verifySchemeOperations() {
  const inspect = await inspectSchemeOperations();
  const errors: string[] = [];
  if (inspect.pendingPlans) errors.push(`${inspect.pendingPlans} scheme plans missing operations fields`);
  if (inspect.pendingEnrollments) {
    errors.push(`${inspect.pendingEnrollments} enrollments missing payment-window/settlement snapshot`);
  }
  if (inspect.pendingPayouts) errors.push(`${inspect.pendingPayouts} payouts missing settlementPrincipalPaise`);
  if (inspect.duplicateSuccessPayoutSchemes) {
    errors.push(
      `${inspect.duplicateSuccessPayoutSchemes} schemes have duplicate SUCCESS payouts; unique index cannot be created. Do not auto-delete.`,
    );
  }
  return { inspect, errors };
}

function reportExtras(enrollmentPolicy: EnrollmentLegacyPolicy, counts: {
  pendingPlans: number;
  pendingEnrollments: number;
  pendingPayouts: number;
}) {
  return {
    enrollmentPolicy,
    paymentWindowBackfills: counts.pendingEnrollments,
    legacyCompatibilityPolicy: counts.pendingEnrollments,
    payoutPrincipalBackfills: counts.pendingPayouts,
    plansUpdated: counts.pendingPlans,
    rightsUpgradeWarning:
      enrollmentPolicy === 'ENABLE_PHASE9_POLICY'
        ? 'ENABLE_PHASE9_POLICY grants premature-close and CASH maturity rights to historical enrollments'
        : undefined,
  };
}

export async function runSchemeOperations(
  mode: 'dry-run' | 'apply' | 'verify',
  ack?: string,
  enrollmentPolicy: EnrollmentLegacyPolicy = 'CONSERVATIVE',
) {
  if (mode === 'apply' && ack !== MIGRATION_ACK_VALUE) {
    throw new Error(`Set MIGRATE_SCHEME_OPERATIONS_ACK=${MIGRATION_ACK_VALUE} to apply`);
  }
  if (mode === 'apply' && enrollmentPolicy === 'ENABLE_PHASE9_POLICY' && ack !== MIGRATION_ACK_VALUE) {
    throw new Error(`Set MIGRATE_SCHEME_OPERATIONS_ACK=${MIGRATION_ACK_VALUE} to apply ENABLE_PHASE9_POLICY`);
  }
  if (mode === 'dry-run') {
    const inspect = await inspectSchemeOperations();
    return {
      mode,
      scannedPlans: inspect.scannedPlans,
      updatedPlans: inspect.pendingPlans,
      scannedEnrollments: inspect.scannedEnrollments,
      updatedEnrollments: inspect.pendingEnrollments,
      scannedPayouts: inspect.scannedPayouts,
      updatedPayouts: inspect.pendingPayouts,
      duplicateSuccessPayoutSchemes: inspect.duplicateSuccessPayoutSchemes,
      verificationErrors: inspect.duplicateSuccessPayoutSchemes
        ? ['Duplicate SUCCESS payouts present; unique index cannot be created']
        : [],
      ok: inspect.duplicateSuccessPayoutSchemes === 0,
      ...reportExtras(enrollmentPolicy, inspect),
    } satisfies SchemeOperationsReport;
  }
  if (mode === 'apply') {
    const result = await backfillSchemeOperations(false, enrollmentPolicy);
    const { errors } = await verifySchemeOperations();
    return {
      mode,
      ...result,
      verificationErrors: errors,
      ok: errors.length === 0,
      rightsUpgradeWarning:
        enrollmentPolicy === 'ENABLE_PHASE9_POLICY'
          ? 'ENABLE_PHASE9_POLICY grants premature-close and CASH maturity rights to historical enrollments'
          : undefined,
    } satisfies SchemeOperationsReport;
  }
  const { inspect, errors } = await verifySchemeOperations();
  return {
    mode,
    scannedPlans: inspect.scannedPlans,
    updatedPlans: 0,
    scannedEnrollments: inspect.scannedEnrollments,
    updatedEnrollments: 0,
    scannedPayouts: inspect.scannedPayouts,
    updatedPayouts: 0,
    duplicateSuccessPayoutSchemes: inspect.duplicateSuccessPayoutSchemes,
    verificationErrors: errors,
    ok: errors.length === 0,
    ...reportExtras(enrollmentPolicy, {
      pendingPlans: 0,
      pendingEnrollments: 0,
      pendingPayouts: 0,
    }),
  } satisfies SchemeOperationsReport;
}

function parseMode(argv: string[]) {
  if (argv.includes('--dry-run')) return 'dry-run' as const;
  if (argv.includes('--apply')) return 'apply' as const;
  if (argv.includes('--verify')) return 'verify' as const;
  return null;
}

function parseEnrollmentPolicy(argv: string[]): EnrollmentLegacyPolicy {
  const flag = argv.find((arg) => arg.startsWith('--legacy-settlement-policy='));
  if (!flag) return 'CONSERVATIVE';
  const value = flag.slice('--legacy-settlement-policy='.length);
  if (value === LEGACY_POLICY_UPGRADE) return 'ENABLE_PHASE9_POLICY';
  throw new Error(`Unknown --legacy-settlement-policy value: ${value}`);
}

export async function main(argv = process.argv.slice(2)) {
  const mode = parseMode(argv);
  if (!mode) {
    console.error(
      'Usage: --dry-run | --apply | --verify  [--legacy-settlement-policy=ENABLE_PHASE9_POLICY]',
    );
    process.exit(2);
  }
  const enrollmentPolicy = parseEnrollmentPolicy(argv);
  await connectDatabase();
  try {
    const report = await runSchemeOperations(
      mode,
      process.env.MIGRATE_SCHEME_OPERATIONS_ACK,
      enrollmentPolicy,
    );
    console.log(JSON.stringify({ migrationId: MIGRATION_ID, ...report }, null, 2));
    if (!report.ok) process.exit(1);
  } finally {
    await disconnectDatabase();
  }
}

const isDirectRun = process.argv[1]?.includes('2026-08-scheme-operations');
if (isDirectRun) {
  main().catch(async (error) => {
    console.error(error);
    await disconnectDatabase().catch(() => undefined);
    process.exit(1);
  });
}
