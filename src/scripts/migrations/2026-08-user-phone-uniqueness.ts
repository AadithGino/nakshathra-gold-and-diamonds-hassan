/**
 * Detect duplicate User.phone values that would block USER_PHONE_UNIQUE.
 * Does not delete, merge, or rewrite financial history.
 *
 * Usage:
 *   npm run migrate:user-phone-uniqueness -- --dry-run
 *   npm run migrate:user-phone-uniqueness -- --verify
 *
 * --apply is intentionally a no-op mutation path: uniqueness is restored only after
 * operators manually resolve reported duplicates, then `npm run indexes`.
 */
import mongoose from 'mongoose';
import { connectDatabase, disconnectDatabase } from '../../config/database.js';
import { User } from '../../models/index.js';

export const MIGRATION_ID = '2026-08-user-phone-uniqueness';

export type DuplicatePhoneGroup = {
  phone: string;
  userIds: string[];
  roles: string[];
  count: number;
};

export type UserPhoneUniquenessReport = {
  mode: 'dry-run' | 'apply' | 'verify';
  scannedUsers: number;
  duplicatePhoneGroups: number;
  duplicates: DuplicatePhoneGroup[];
  uniquePhoneIndexPresent: boolean;
  verificationErrors: string[];
  ok: boolean;
};

async function listDuplicatePhones(): Promise<DuplicatePhoneGroup[]> {
  const rows = await User.aggregate([
    { $match: { phone: { $type: 'string', $ne: '' } } },
    {
      $group: {
        _id: '$phone',
        count: { $sum: 1 },
        userIds: { $push: '$_id' },
        roles: { $push: '$role' },
      },
    },
    { $match: { count: { $gt: 1 } } },
    { $sort: { count: -1, _id: 1 } },
  ]);
  return rows.map((row: any) => ({
    phone: String(row._id),
    userIds: (row.userIds ?? []).map((id: unknown) => String(id)),
    roles: (row.roles ?? []).map((role: unknown) => String(role)),
    count: Number(row.count ?? 0),
  }));
}

async function hasUniquePhoneIndex(): Promise<boolean> {
  const indexes = await User.collection.indexes();
  return indexes.some((index: { key?: Record<string, unknown>; unique?: boolean }) => {
    const keys = Object.keys(index.key ?? {});
    return keys.length === 1 && keys[0] === 'phone' && index.unique === true;
  });
}

export async function runUserPhoneUniquenessMigration(
  mode: 'dry-run' | 'apply' | 'verify' = 'dry-run',
): Promise<UserPhoneUniquenessReport> {
  const scannedUsers = await User.countDocuments({});
  const duplicates = await listDuplicatePhones();
  const uniquePhoneIndexPresent = await hasUniquePhoneIndex();
  const verificationErrors: string[] = [];

  if (duplicates.length) {
    verificationErrors.push(
      `${duplicates.length} duplicate phone group(s) found. Resolve manually before applying USER_PHONE_UNIQUE. Do not auto-merge users/customers/payments.`,
    );
  }
  if (mode === 'verify' && !uniquePhoneIndexPresent) {
    verificationErrors.push('USER_PHONE_UNIQUE (phone unique index) is missing');
  }
  if (mode === 'apply' && duplicates.length) {
    verificationErrors.push(
      'Refusing to create/sync unique phone index while duplicate phones exist',
    );
  }

  return {
    mode,
    scannedUsers,
    duplicatePhoneGroups: duplicates.length,
    duplicates: duplicates.map((row) => ({
      phone: row.phone,
      userIds: row.userIds,
      roles: row.roles,
      count: row.count,
    })),
    uniquePhoneIndexPresent,
    verificationErrors,
    ok: verificationErrors.length === 0 && (mode !== 'verify' || uniquePhoneIndexPresent),
  };
}

async function main() {
  const args = process.argv.slice(2);
  const mode = args.includes('--verify')
    ? 'verify'
    : args.includes('--apply')
      ? 'apply'
      : 'dry-run';

  await connectDatabase();
  try {
    const report = await runUserPhoneUniquenessMigration(mode);
    console.log(JSON.stringify({ migrationId: MIGRATION_ID, ...report }, null, 2));
    if (!report.ok) process.exitCode = 1;
  } finally {
    await disconnectDatabase();
  }
}

const isDirect =
  process.argv[1]?.includes('2026-08-user-phone-uniqueness') ||
  process.argv[1]?.endsWith('user-phone-uniqueness.ts');
if (isDirect) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}

export { mongoose };
