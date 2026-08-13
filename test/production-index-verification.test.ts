import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import mongoose from 'mongoose';
import {
  Payment,
  PaymentIntent,
  Refund,
} from '../src/models/index.js';
import {
  REQUIRED_INDEXES,
  assertCriticalIndexesPresent,
  findMatchingIndex,
  verifyRequiredIndexes,
} from '../src/indexes/critical-indexes.js';
import { AppError } from '../src/utils/AppError.js';
import { clearTestMongo, startTestMongo, stopTestMongo } from './helpers/mongo.js';

async function dropMatchingIndex(id: string) {
  const spec = REQUIRED_INDEXES.find((index) => index.id === id);
  if (!spec) throw new Error(`Unknown index ${id}`);
  const collection = mongoose.models[spec.model].collection;
  const indexes = await collection.indexes();
  for (const index of findMatchingIndex(indexes, spec)) {
    if (index.name && index.name !== '_id_') await collection.dropIndex(index.name);
  }
}

async function restoreFinancialIndexes() {
  await Promise.all([
    Payment.syncIndexes(),
    PaymentIntent.syncIndexes(),
    Refund.syncIndexes(),
  ]);
}

describe('Phase 6 — production index verification', () => {
  beforeAll(async () => {
    await startTestMongo();
  }, 120_000);

  afterAll(async () => {
    await stopTestMongo();
  });

  beforeEach(async () => {
    await clearTestMongo();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    if (mongoose.connection.readyState !== 1 && process.env.MONGODB_URI) {
      await mongoose.connect(process.env.MONGODB_URI);
    }
    await restoreFinancialIndexes();
  }, 30_000);

  it('passes when required financial indexes are present', async () => {
    const report = await verifyRequiredIndexes();
    expect(report.ok).toBe(true);
    expect(report.mismatches).toEqual([]);
    expect(report.checked).toBe(REQUIRED_INDEXES.length);
  });

  it('fails when the successful-payment lookup index is missing', async () => {
    await dropMatchingIndex('PAYMENT_SUCCESS_SCHEME_MONTH');
    const report = await verifyRequiredIndexes();
    expect(report.ok).toBe(false);
    expect(report.mismatches.some((row) => row.id === 'PAYMENT_SUCCESS_SCHEME_MONTH')).toBe(true);
  });

  it('fails when the PaymentIntent idempotency unique index is missing', async () => {
    await dropMatchingIndex('PAYMENT_INTENT_IDEMPOTENCY_UNIQUE');
    const report = await verifyRequiredIndexes();
    expect(report.ok).toBe(false);
    expect(report.mismatches.some((row) => row.id === 'PAYMENT_INTENT_IDEMPOTENCY_UNIQUE')).toBe(
      true,
    );
  });

  it('fails when the activeAttemptKey unique index is missing', async () => {
    await dropMatchingIndex('PAYMENT_INTENT_ACTIVE_ATTEMPT_UNIQUE');
    const report = await verifyRequiredIndexes();
    expect(report.ok).toBe(false);
    expect(
      report.mismatches.some((row) => row.id === 'PAYMENT_INTENT_ACTIVE_ATTEMPT_UNIQUE'),
    ).toBe(true);
  });

  it('fails when the Refund active partial unique index is missing', async () => {
    await dropMatchingIndex('REFUND_ACTIVE_PER_PAYMENT');
    const report = await verifyRequiredIndexes();
    expect(report.ok).toBe(false);
    expect(report.mismatches.some((row) => row.id === 'REFUND_ACTIVE_PER_PAYMENT')).toBe(true);
  });

  it('fails when a uniqueness index exists only as a non-unique index', async () => {
    await dropMatchingIndex('PAYMENT_MERCHANT_TXN_UNIQUE');
    await Payment.collection.createIndex(
      { merchantTransactionId: 1 },
      {
        unique: false,
        sparse: true,
        name: 'PAYMENT_MERCHANT_TXN_NOT_UNIQUE',
      },
    );
    const report = await verifyRequiredIndexes();
    expect(report.ok).toBe(false);
    const mismatch = report.mismatches.find((row) => row.id === 'PAYMENT_MERCHANT_TXN_UNIQUE');
    expect(mismatch?.reason).toMatch(/not unique/i);
  });

  it('fails when the SUCCESS scheme-month lookup index is still unique', async () => {
    await dropMatchingIndex('PAYMENT_SUCCESS_SCHEME_MONTH');
    await Payment.collection.createIndex(
      { schemeId: 1, schemeMonth: 1 },
      {
        unique: true,
        name: 'PAYMENT_SUCCESS_SCHEME_MONTH_STILL_UNIQUE',
        partialFilterExpression: { status: 'SUCCESS' },
      },
    );
    const report = await verifyRequiredIndexes();
    expect(report.ok).toBe(false);
    const mismatch = report.mismatches.find((row) => row.id === 'PAYMENT_SUCCESS_SCHEME_MONTH');
    expect(mismatch?.reason).toMatch(/unique/i);
  });

  it('does not call syncIndexes during a normal database connection', async () => {
    const { readFile } = await import('node:fs/promises');
    const source = await readFile(new URL('../src/config/database.ts', import.meta.url), 'utf8');
    expect(source).not.toMatch(/syncIndexes/);
    expect(source).toMatch(/autoIndex: env\.NODE_ENV !== 'production'/);
    expect(source).toMatch(/assertCriticalIndexesPresent/);

    const spies = Object.values(mongoose.models).map((model) => vi.spyOn(model, 'syncIndexes'));
    const uri = process.env.MONGODB_URI;
    expect(uri).toBeTruthy();
    await mongoose.disconnect();
    await mongoose.connect(uri!, {
      serverSelectionTimeoutMS: 10_000,
      autoIndex: false,
    });
    await Promise.all(Object.values(mongoose.connection.models).map((model) => model.init()));
    for (const spy of spies) {
      expect(spy).not.toHaveBeenCalled();
    }
  });

  it('refuses financial traffic when a critical uniqueness index is absent', async () => {
    await dropMatchingIndex('PAYMENT_INTENT_ACTIVE_ATTEMPT_UNIQUE');
    await expect(assertCriticalIndexesPresent()).rejects.toMatchObject({
      code: 'INDEX_DEPLOYMENT_INCOMPLETE',
      statusCode: 503,
    });
    try {
      await assertCriticalIndexesPresent();
    } catch (error) {
      expect(error).toBeInstanceOf(AppError);
      expect(String((error as AppError).message)).toMatch(/index deployment is incomplete/i);
      expect((error as AppError).details).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: 'PAYMENT_INTENT_ACTIVE_ATTEMPT_UNIQUE' }),
        ]),
      );
    }
  });

  it('allows multiple SUCCESS payments in the same scheme month', async () => {
    const customerId = new mongoose.Types.ObjectId();
    const schemeId = new mongoose.Types.ObjectId();
    const actorId = new mongoose.Types.ObjectId();
    const doc = {
      customerId,
      schemeId,
      amountPaise: 100_000,
      method: 'CASH',
      status: 'SUCCESS',
      paymentDate: new Date(),
      schemeMonth: 1,
      collectorRole: 'ADMIN',
      createdBy: actorId,
    };

    const results = await Promise.allSettled([
      Payment.create({ ...doc, receiptNumber: 'P6-A' }),
      Payment.create({ ...doc, receiptNumber: 'P6-B' }),
    ]);
    const fulfilled = results.filter((row) => row.status === 'fulfilled');
    const rejected = results.filter((row) => row.status === 'rejected');
    expect(fulfilled).toHaveLength(2);
    expect(rejected).toHaveLength(0);
    expect(await Payment.countDocuments({ schemeId, status: 'SUCCESS', schemeMonth: 1 })).toBe(2);
  });
});
