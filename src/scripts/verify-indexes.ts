/**
 * Read-only verification of required financial MongoDB indexes.
 *
 * Usage: npm run indexes:verify
 *
 * Does not create, drop, or sync indexes.
 */
import { connectDatabase, disconnectDatabase } from '../config/database.js';
import { verifyRequiredIndexes } from '../indexes/critical-indexes.js';

export async function main() {
  await connectDatabase();
  try {
    const report = await verifyRequiredIndexes();
    console.log(
      JSON.stringify(
        {
          ok: report.ok,
          checked: report.checked,
          mismatches: report.mismatches,
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
  process.argv[1]?.includes('verify-indexes') || process.argv[1]?.includes('indexes:verify');

if (isDirectRun) {
  main().catch(async (error) => {
    console.error(error);
    await disconnectDatabase().catch(() => undefined);
    process.exit(1);
  });
}
