import mongoose, { type ClientSession } from 'mongoose';
import { AppError } from './AppError.js';
import { logger } from '../config/logger.js';

const retryable = (error: any) =>
  error?.hasErrorLabel?.('TransientTransactionError') ||
  error?.hasErrorLabel?.('UnknownTransactionCommitResult') ||
  error?.name === 'VersionError' ||
  error?.codeName === 'WriteConflict' ||
  error?.code === 112;
export async function withMongoTransaction<T>(
  work: (session: ClientSession) => Promise<T>,
  requestId = 'system',
  maxAttempts = 3,
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const session = await mongoose.startSession();
    try {
      let result!: T;
      await session.withTransaction(
        async () => {
          result = await work(session);
        },
        {
          readConcern: { level: 'snapshot' },
          writeConcern: { w: 'majority' },
          maxCommitTimeMS: 10_000,
        },
      );
      return result;
    } catch (error) {
      lastError = error;
      if (error instanceof AppError || !retryable(error) || attempt === maxAttempts) {
        logger.error({ err: error, requestId, attempt }, 'transaction failed');
        throw error;
      }
      logger.warn({ err: error, requestId, attempt }, 'retrying transient transaction');
    } finally {
      await session.endSession();
    }
  }
  throw new AppError(
    'TRANSACTION_RETRY_REQUIRED',
    'Transaction could not be committed safely',
    503,
    true,
    [lastError],
  );
}
