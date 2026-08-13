import mongoose from 'mongoose';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import { withMongoTransaction } from '../../src/utils/transaction.js';

let replSet: MongoMemoryReplSet | undefined;

/** Start an in-memory replica set so MongoDB transactions work in tests. */
export async function startTestMongo() {
  if (mongoose.connection.readyState === 1) return mongoose.connection;
  replSet = await MongoMemoryReplSet.create({
    replSet: { count: 1, storageEngine: 'wiredTiger' },
  });
  const uri = replSet.getUri();
  process.env.MONGODB_URI = uri;
  await mongoose.connect(uri);
  // mongoose builds indexes in the background (autoIndex) after connecting —
  // unawaited by default. Concurrency tests that race inserts against a
  // brand-new unique index (e.g. PaymentIntent.activeAttemptKey) right after
  // startup can otherwise run before that index finishes building, letting
  // duplicates through that the index is supposed to prevent. Wait for every
  // registered model's indexes explicitly so uniqueness is actually enforced
  // from the first test onward.
  await Promise.all(Object.values(mongoose.connection.models).map((model) => model.init()));
  return mongoose.connection;
}

export async function stopTestMongo() {
  if (mongoose.connection.readyState !== 0) {
    await mongoose.disconnect();
  }
  if (replSet) {
    await replSet.stop();
    replSet = undefined;
  }
}

export async function clearTestMongo() {
  const collections = mongoose.connection.collections;
  for (const collection of Object.values(collections)) {
    await collection.deleteMany({});
  }
}

/** Run work inside the project's transaction helper (replica-set required). */
export async function withTestTransaction<T>(
  work: Parameters<typeof withMongoTransaction<T>>[0],
  requestId = 'test',
) {
  return withMongoTransaction(work, requestId);
}
