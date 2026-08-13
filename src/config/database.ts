import mongoose from 'mongoose';
import { env } from './env.js';
import { AppError } from '../utils/AppError.js';
import { logger } from './logger.js';
import { seedDemoData } from '../services/demo-seed.service.js';
import { assertCriticalIndexesPresent } from '../indexes/critical-indexes.js';

let connectionPromise: Promise<void> | null = null;

export async function connectDatabase() {
  if (mongoose.connection.readyState === 1) return;
  if (connectionPromise) return connectionPromise;
  connectionPromise = connectAndVerify();
  try {
    await connectionPromise;
  } catch (error) {
    connectionPromise = null;
    throw error;
  }
}

async function connectAndVerify() {
  mongoose.set('strictQuery', true);
  mongoose.set('sanitizeFilter', true);
  await mongoose.connect(env.MONGODB_URI, {
    serverSelectionTimeoutMS: 10_000,
    autoIndex: env.NODE_ENV !== 'production',
  });
  const admin = mongoose.connection.db?.admin();
  if (!admin) throw new Error('MongoDB admin connection unavailable');
  const hello = await admin.command({ hello: 1 });
  if (!hello.setName && !hello.msg?.includes('isdbgrid')) {
    await mongoose.disconnect();
    throw new AppError(
      'DATABASE_NOT_TRANSACTIONAL',
      'MongoDB must be Atlas, mongos, or a replica set',
      503,
      false,
    );
  }
  logger.info({ replicaSet: hello.setName ?? 'mongos' }, 'MongoDB transaction capability verified');
  if (env.NODE_ENV === 'production') {
    await assertCriticalIndexesPresent();
    logger.info('Critical financial indexes verified');
  }
  if (env.BOOTSTRAP_DEMO) {
    await seedDemoData();
    logger.info('Opt-in demo data verified');
  }
}

export async function disconnectDatabase() {
  await mongoose.disconnect();
  connectionPromise = null;
}
export const isDatabaseReady = () => mongoose.connection.readyState === 1;
