/**
 * Controlled deployment action: create schema indexes and DROP obsolete ones.
 *
 * This is NOT run on API startup. Production sequence:
 *   migration scripts
 *   npm run indexes
 *   npm run indexes:verify
 *   application release
 *
 * `syncIndexes()` may drop indexes that are no longer in the mongoose schemas.
 * Do not run against an unknown production database from local tooling.
 */
import mongoose from 'mongoose';
import { connectDatabase, disconnectDatabase } from '../config/database.js';
import '../models/index.js';

await connectDatabase();

process.stdout.write(
  'WARNING: syncIndexes() may DROP indexes not present in current mongoose schemas.\n',
);

for (const model of Object.values(mongoose.models)) {
  await model.syncIndexes();
  process.stdout.write(`Indexes synchronized: ${model.modelName}\n`);
}

await disconnectDatabase();
