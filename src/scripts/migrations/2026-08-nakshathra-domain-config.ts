/**
 * Rebrand persisted system settings from Kairali defaults to Nakshathra
 * and verify existing user roles remain valid.
 *
 * Does not rewrite receipts, enrollments, payments, or other financial history.
 *
 * Usage:
 *   npm run migrate:nakshathra-domain-config -- --dry-run
 *   MIGRATE_NAKSHATHRA_DOMAIN_CONFIG_ACK=I_UNDERSTAND npm run migrate:nakshathra-domain-config -- --apply
 *   npm run migrate:nakshathra-domain-config -- --verify
 */
import {
  business,
  LEGACY_KAIRALI_BUSINESS_NAME,
  LEGACY_KAIRALI_RECEIPT_FOOTER,
} from '../../config/business.js';
import { connectDatabase, disconnectDatabase } from '../../config/database.js';
import { ROLES, SystemSetting, User } from '../../models/index.js';

export const MIGRATION_ID = '2026-08-nakshathra-domain-config';
export const MIGRATION_ACK_VALUE = 'I_UNDERSTAND';

export type NakshathraDomainConfigReport = {
  mode: 'dry-run' | 'apply' | 'verify';
  scannedUsers: number;
  invalidRoleUsers: number;
  invalidRoles: string[];
  settingsFound: boolean;
  settingsWouldUpdate: boolean;
  settingsUpdated: number;
  verificationErrors: string[];
  ok: boolean;
};

function needsSettingsRebrand(settings: {
  businessName?: string;
  receiptFooter?: string;
} | null) {
  if (!settings) return false;
  return (
    settings.businessName === LEGACY_KAIRALI_BUSINESS_NAME ||
    settings.receiptFooter === LEGACY_KAIRALI_RECEIPT_FOOTER
  );
}

export async function inspectNakshathraDomainConfig(): Promise<{
  scannedUsers: number;
  invalidRoleUsers: number;
  invalidRoles: string[];
  settingsFound: boolean;
  settingsWouldUpdate: boolean;
}> {
  const [settings, users] = await Promise.all([
    SystemSetting.findOne({ singletonKey: 'GLOBAL' }).lean(),
    User.find({}).select('role').lean(),
  ]);
  const allowed = new Set<string>(ROLES);
  const invalidRoles: string[] = [];
  for (const user of users as Array<{ role?: string }>) {
    const role = String(user.role ?? '');
    if (!allowed.has(role) && !invalidRoles.includes(role)) invalidRoles.push(role);
  }
  return {
    scannedUsers: users.length,
    invalidRoleUsers: (users as Array<{ role?: string }>).filter((user) => !allowed.has(String(user.role)))
      .length,
    invalidRoles,
    settingsFound: Boolean(settings),
    settingsWouldUpdate: needsSettingsRebrand(settings),
  };
}

export async function runNakshathraDomainConfigDryRun(): Promise<NakshathraDomainConfigReport> {
  const inspect = await inspectNakshathraDomainConfig();
  return {
    mode: 'dry-run',
    ...inspect,
    settingsUpdated: 0,
    verificationErrors: inspect.invalidRoles.map((role) => `Unsupported user role: ${role}`),
    ok: inspect.invalidRoleUsers === 0,
  };
}

export async function runNakshathraDomainConfigApply(input: {
  ack?: string;
}): Promise<NakshathraDomainConfigReport> {
  if (input.ack !== MIGRATION_ACK_VALUE) {
    throw new Error(
      `Refusing apply: set MIGRATE_NAKSHATHRA_DOMAIN_CONFIG_ACK=${MIGRATION_ACK_VALUE}`,
    );
  }
  const inspect = await inspectNakshathraDomainConfig();
  let settingsUpdated = 0;
  if (inspect.settingsWouldUpdate) {
    const result = await SystemSetting.updateOne(
      { singletonKey: 'GLOBAL' },
      {
        $set: {
          businessName: business.displayName,
          receiptFooter: business.receiptFooter,
        },
      },
    );
    settingsUpdated = result.modifiedCount;
  }
  const after = await inspectNakshathraDomainConfig();
  return {
    mode: 'apply',
    ...after,
    settingsUpdated,
    verificationErrors: after.invalidRoles.map((role) => `Unsupported user role: ${role}`),
    ok: after.invalidRoleUsers === 0 && !after.settingsWouldUpdate,
  };
}

export async function runNakshathraDomainConfigVerify(): Promise<NakshathraDomainConfigReport> {
  const inspect = await inspectNakshathraDomainConfig();
  const verificationErrors: string[] = inspect.invalidRoles.map(
    (role) => `Unsupported user role: ${role}`,
  );
  if (inspect.settingsWouldUpdate) {
    verificationErrors.push('System settings still use Kairali business branding');
  }
  return {
    mode: 'verify',
    ...inspect,
    settingsUpdated: 0,
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
    let report: NakshathraDomainConfigReport;
    if (mode === 'dry-run') report = await runNakshathraDomainConfigDryRun();
    else if (mode === 'apply') {
      report = await runNakshathraDomainConfigApply({
        ack: process.env.MIGRATE_NAKSHATHRA_DOMAIN_CONFIG_ACK,
      });
    } else report = await runNakshathraDomainConfigVerify();
    console.log(JSON.stringify({ migrationId: MIGRATION_ID, ...report }, null, 2));
    if (!report.ok) process.exit(1);
  } finally {
    await disconnectDatabase();
  }
}

const isDirectRun =
  process.argv[1]?.includes('2026-08-nakshathra-domain-config') ||
  process.argv[1]?.includes('migrate-nakshathra-domain-config');

if (isDirectRun) {
  main().catch(async (error) => {
    console.error(error);
    await disconnectDatabase().catch(() => undefined);
    process.exit(1);
  });
}
