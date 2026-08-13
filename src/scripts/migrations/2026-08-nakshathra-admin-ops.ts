/**
 * Nakshathra owner-ops data normalization.
 *
 * Additive, rerunnable backfill for:
 * - payment collectorRole attribution
 * - missing StaffProfile rows for STAFF users
 * - CASH / GOLD_WEIGHT type aliases on plans and enrollments
 * - missing/invalid payout type and method enums
 *
 * Does not rewrite amounts, receipts, historical KRL prefixes, or valid enums.
 *
 * Rollback notes:
 * - collectorRole backfill is additive; restore from backup if a guessed role is wrong
 * - created StaffProfile rows are tagged in notes and can be deleted if unused
 * - scheme type / payout enum updates only touch invalid aliases, not valid live values
 *
 * Usage:
 *   npm run migrate:nakshathra-admin-ops -- --dry-run
 *   MIGRATE_NAKSHATHRA_ADMIN_OPS_ACK=I_UNDERSTAND npm run migrate:nakshathra-admin-ops -- --apply
 *   npm run migrate:nakshathra-admin-ops -- --verify
 */
import mongoose from 'mongoose';
import { connectDatabase, disconnectDatabase } from '../../config/database.js';
import {
  Payment,
  Payout,
  SchemeEnrollment,
  SchemePlan,
  StaffProfile,
  User,
} from '../../models/index.js';
import { PAYOUT_METHODS, PAYOUT_TYPES } from '../../models/enums.js';

export const MIGRATION_ID = '2026-08-nakshathra-admin-ops';
export const MIGRATION_ACK_VALUE = 'I_UNDERSTAND';
export const STAFF_PROFILE_MIGRATION_NOTE =
  'Created by Nakshathra admin reporting migration; review permissions before production use.';

const VALID_SCHEME_TYPES = new Set(['CASH', 'GOLD_WEIGHT']);
const VALID_PAYOUT_TYPES = new Set<string>(PAYOUT_TYPES);
const VALID_PAYOUT_METHODS = new Set<string>(PAYOUT_METHODS);

export type NakshathraAdminOpsReport = {
  mode: 'dry-run' | 'apply' | 'verify';
  paymentsScanned: number;
  paymentsMissingCollectorRole: number;
  paymentsUpdated: number;
  staffUsersScanned: number;
  staffProfilesCreated: number;
  plansNormalized: number;
  enrollmentsNormalized: number;
  payoutsNormalized: number;
  verificationErrors: string[];
  ok: boolean;
};

function native(model: { collection: { collectionName: string } }) {
  const db = mongoose.connection.db;
  if (!db) throw new Error('MongoDB connection is not ready');
  return db.collection(model.collection.collectionName);
}

export function normalizeSchemeType(value: unknown): 'CASH' | 'GOLD_WEIGHT' | null {
  const raw = String(value ?? '').trim();
  if (!raw) return null;
  const upper = raw.toUpperCase().replace(/[\s-]+/g, '_');
  if (upper === 'CASH') return 'CASH';
  if (upper === 'GOLD' || upper === 'GOLD_WEIGHT' || upper === 'GOLDWEIGHT') return 'GOLD_WEIGHT';
  return null;
}

export function normalizePayoutType(
  payoutType: unknown,
  method: unknown,
): string | null {
  const current = String(payoutType ?? '');
  if (VALID_PAYOUT_TYPES.has(current)) return null;
  return String(method ?? '') === 'GOLD' ? 'REDEEM' : 'PAYOUT';
}

export function normalizePayoutMethod(method: unknown, goldWeightMg: unknown): string | null {
  const current = String(method ?? '');
  if (VALID_PAYOUT_METHODS.has(current)) return null;
  return Number(goldWeightMg) > 0 ? 'GOLD' : 'CASH';
}

async function collectorRoleForPayment(doc: {
  collectedBy?: unknown;
  collectorRole?: unknown;
}) {
  if (doc.collectorRole) return null;
  if (!doc.collectedBy) return 'CUSTOMER';
  const user = await native(User).findOne(
    { _id: doc.collectedBy },
    { projection: { role: 1 } },
  );
  const role = String(user?.role ?? '');
  if (role === 'STAFF' || role === 'ADMIN' || role === 'CUSTOMER') return role;
  return 'CUSTOMER';
}

export async function inspectNakshathraAdminOps() {
  const payments = native(Payment);
  const users = native(User);
  const profiles = native(StaffProfile);
  const plans = native(SchemePlan);
  const enrollments = native(SchemeEnrollment);
  const payouts = native(Payout);

  const [paymentsScanned, paymentsMissingCollectorRole, staffUsers, profileUserIds] =
    await Promise.all([
      payments.countDocuments({}),
      payments.countDocuments({
        $or: [{ collectorRole: { $exists: false } }, { collectorRole: null }, { collectorRole: '' }],
      }),
      users.find({ role: 'STAFF' }).project({ _id: 1 }).toArray(),
      profiles.find({}).project({ userId: 1 }).toArray(),
    ]);
  const profileSet = new Set(profileUserIds.map((row) => String(row.userId)));
  const staffMissingProfiles = staffUsers.filter((user) => !profileSet.has(String(user._id))).length;

  const planDocs = await plans.find({}).project({ type: 1 }).toArray();
  const enrollmentDocs = await enrollments.find({}).project({ schemeType: 1 }).toArray();
  const payoutDocs = await payouts
    .find({})
    .project({ payoutType: 1, method: 1, goldWeightMg: 1 })
    .toArray();

  const plansNeedNormalize = planDocs.filter(
    (row) => !VALID_SCHEME_TYPES.has(String(row.type ?? '')) && normalizeSchemeType(row.type),
  ).length;
  const enrollmentsNeedNormalize = enrollmentDocs.filter(
    (row) =>
      !VALID_SCHEME_TYPES.has(String(row.schemeType ?? '')) && normalizeSchemeType(row.schemeType),
  ).length;
  const payoutsNeedNormalize = payoutDocs.filter(
    (row) =>
      normalizePayoutType(row.payoutType, row.method) != null ||
      normalizePayoutMethod(row.method, row.goldWeightMg) != null,
  ).length;

  return {
    paymentsScanned,
    paymentsMissingCollectorRole,
    staffUsersScanned: staffUsers.length,
    staffMissingProfiles,
    plansNeedNormalize,
    enrollmentsNeedNormalize,
    payoutsNeedNormalize,
  };
}

async function applyCollectorRoles(dryRun: boolean) {
  const payments = native(Payment);
  const cursor = payments.find({
    $or: [{ collectorRole: { $exists: false } }, { collectorRole: null }, { collectorRole: '' }],
  });
  let updated = 0;
  for await (const raw of cursor) {
    const role = await collectorRoleForPayment(raw as { collectedBy?: unknown; collectorRole?: unknown });
    if (!role) continue;
    updated += 1;
    if (dryRun) continue;
    await payments.updateOne({ _id: raw._id }, { $set: { collectorRole: role } });
  }
  return updated;
}

async function applyStaffProfiles(dryRun: boolean) {
  const users = native(User);
  const profiles = native(StaffProfile);
  const staffUsers = await users.find({ role: 'STAFF' }).toArray();
  const existing = await profiles.find({}).project({ userId: 1 }).toArray();
  const profileSet = new Set(existing.map((row) => String(row.userId)));
  let created = 0;
  for (const user of staffUsers) {
    if (profileSet.has(String(user._id))) continue;
    created += 1;
    if (dryRun) continue;
    const suffix = String(user._id).slice(-8).toUpperCase();
    await profiles.insertOne({
      userId: user._id,
      employeeCode: `NKS-MIG-${suffix}`,
      permissions: [],
      notes: STAFF_PROFILE_MIGRATION_NOTE,
      cashVersion: 0,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
  }
  return created;
}

async function applySchemeTypes(dryRun: boolean) {
  const plans = native(SchemePlan);
  const enrollments = native(SchemeEnrollment);
  let plansNormalized = 0;
  let enrollmentsNormalized = 0;
  for await (const plan of plans.find({})) {
    if (VALID_SCHEME_TYPES.has(String(plan.type ?? ''))) continue;
    const next = normalizeSchemeType(plan.type);
    if (!next) continue;
    plansNormalized += 1;
    if (!dryRun) await plans.updateOne({ _id: plan._id }, { $set: { type: next } });
  }
  for await (const enrollment of enrollments.find({})) {
    if (VALID_SCHEME_TYPES.has(String(enrollment.schemeType ?? ''))) continue;
    const next = normalizeSchemeType(enrollment.schemeType);
    if (!next) continue;
    enrollmentsNormalized += 1;
    if (!dryRun) {
      await enrollments.updateOne({ _id: enrollment._id }, { $set: { schemeType: next } });
    }
  }
  return { plansNormalized, enrollmentsNormalized };
}

async function applyPayoutEnums(dryRun: boolean) {
  const payouts = native(Payout);
  let payoutsNormalized = 0;
  for await (const payout of payouts.find({})) {
    const payoutType = normalizePayoutType(payout.payoutType, payout.method);
    const method = normalizePayoutMethod(payout.method, payout.goldWeightMg);
    if (!payoutType && !method) continue;
    payoutsNormalized += 1;
    if (dryRun) continue;
    const $set: Record<string, string> = {};
    if (payoutType) $set.payoutType = payoutType;
    if (method) $set.method = method;
    await payouts.updateOne({ _id: payout._id }, { $set });
  }
  return payoutsNormalized;
}

function reportFromInspect(
  mode: NakshathraAdminOpsReport['mode'],
  inspect: Awaited<ReturnType<typeof inspectNakshathraAdminOps>>,
  applied?: {
    paymentsUpdated: number;
    staffProfilesCreated: number;
    plansNormalized: number;
    enrollmentsNormalized: number;
    payoutsNormalized: number;
  },
): NakshathraAdminOpsReport {
  const verificationErrors: string[] = [];
  if (inspect.paymentsMissingCollectorRole > 0 && mode === 'verify') {
    verificationErrors.push(
      `${inspect.paymentsMissingCollectorRole} payments are missing collectorRole`,
    );
  }
  if (inspect.staffMissingProfiles > 0 && mode === 'verify') {
    verificationErrors.push(`${inspect.staffMissingProfiles} STAFF users are missing StaffProfile`);
  }
  return {
    mode,
    paymentsScanned: inspect.paymentsScanned,
    paymentsMissingCollectorRole: inspect.paymentsMissingCollectorRole,
    paymentsUpdated: applied?.paymentsUpdated ?? 0,
    staffUsersScanned: inspect.staffUsersScanned,
    staffProfilesCreated: applied?.staffProfilesCreated ?? 0,
    plansNormalized: applied?.plansNormalized ?? 0,
    enrollmentsNormalized: applied?.enrollmentsNormalized ?? 0,
    payoutsNormalized: applied?.payoutsNormalized ?? 0,
    verificationErrors,
    ok: verificationErrors.length === 0,
  };
}

export async function runNakshathraAdminOpsDryRun(): Promise<NakshathraAdminOpsReport> {
  const inspect = await inspectNakshathraAdminOps();
  const paymentsUpdated = await applyCollectorRoles(true);
  const staffProfilesCreated = await applyStaffProfiles(true);
  const scheme = await applySchemeTypes(true);
  const payoutsNormalized = await applyPayoutEnums(true);
  return reportFromInspect('dry-run', inspect, {
    paymentsUpdated,
    staffProfilesCreated,
    plansNormalized: scheme.plansNormalized,
    enrollmentsNormalized: scheme.enrollmentsNormalized,
    payoutsNormalized,
  });
}

export async function runNakshathraAdminOpsApply(input: {
  ack?: string;
}): Promise<NakshathraAdminOpsReport> {
  if (input.ack !== MIGRATION_ACK_VALUE) {
    throw new Error(`Refusing apply: set MIGRATE_NAKSHATHRA_ADMIN_OPS_ACK=${MIGRATION_ACK_VALUE}`);
  }
  const paymentsUpdated = await applyCollectorRoles(false);
  const staffProfilesCreated = await applyStaffProfiles(false);
  const scheme = await applySchemeTypes(false);
  const payoutsNormalized = await applyPayoutEnums(false);
  const inspect = await inspectNakshathraAdminOps();
  return reportFromInspect('apply', inspect, {
    paymentsUpdated,
    staffProfilesCreated,
    plansNormalized: scheme.plansNormalized,
    enrollmentsNormalized: scheme.enrollmentsNormalized,
    payoutsNormalized,
  });
}

export async function runNakshathraAdminOpsVerify(): Promise<NakshathraAdminOpsReport> {
  const inspect = await inspectNakshathraAdminOps();
  return reportFromInspect('verify', inspect);
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
    let report: NakshathraAdminOpsReport;
    if (mode === 'dry-run') report = await runNakshathraAdminOpsDryRun();
    else if (mode === 'apply') {
      report = await runNakshathraAdminOpsApply({
        ack: process.env.MIGRATE_NAKSHATHRA_ADMIN_OPS_ACK,
      });
    } else report = await runNakshathraAdminOpsVerify();
    console.log(JSON.stringify({ migrationId: MIGRATION_ID, ...report }, null, 2));
    if (!report.ok && mode === 'verify') process.exit(1);
  } finally {
    await disconnectDatabase();
  }
}

const isDirectRun =
  process.argv[1]?.includes('2026-08-nakshathra-admin-ops') ||
  process.argv[1]?.includes('migrate-nakshathra-admin-ops');

if (isDirectRun) {
  main().catch(async (error) => {
    console.error(error);
    await disconnectDatabase().catch(() => undefined);
    process.exit(1);
  });
}
