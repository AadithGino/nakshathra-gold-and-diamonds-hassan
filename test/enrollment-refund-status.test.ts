import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import mongoose from 'mongoose';
import { Payment, Payout } from '../src/models/index.js';
import { aggregateEnrollmentLedger } from '../src/utils/enrollment-ledger.js';
import { clearTestMongo, startTestMongo, stopTestMongo } from './helpers/mongo.js';

describe('enrollment ledger refund/reversal status exclusion', () => {
  beforeAll(async () => {
    await startTestMongo();
  }, 120_000);

  afterAll(async () => {
    await stopTestMongo();
  });

  beforeEach(async () => {
    await clearTestMongo();
  });

  it('computes enrollment totals from SUCCESS payments only', async () => {
    const schemeId = new mongoose.Types.ObjectId();
    const customerId = new mongoose.Types.ObjectId();
    const actorId = new mongoose.Types.ObjectId();
    const base = {
      customerId,
      schemeId,
      amountPaise: 100_000,
      method: 'UPI' as const,
      paymentDate: new Date(),
      collectorRole: 'CUSTOMER' as const,
      createdBy: actorId,
      goldWeightMg: 133,
      goldRatePerGramPaise: 750_000,
    };

    await Payment.create([
      { ...base, status: 'SUCCESS', schemeMonth: 1, merchantTransactionId: 'ok-1' },
      { ...base, status: 'SUCCESS', schemeMonth: 2, merchantTransactionId: 'ok-2', goldWeightMg: 140 },
      {
        ...base,
        status: 'REFUNDED',
        schemeMonth: 3,
        merchantTransactionId: 'refunded-1',
        amountPaise: 100_000,
        goldWeightMg: 150,
      },
      {
        ...base,
        status: 'REVERSED',
        schemeMonth: 4,
        merchantTransactionId: 'reversed-1',
        amountPaise: 100_000,
        goldWeightMg: 160,
      },
      {
        ...base,
        status: 'FAILED',
        schemeMonth: 5,
        merchantTransactionId: 'failed-1',
        amountPaise: 100_000,
        goldWeightMg: 170,
      },
    ]);

    await Payout.create({
      customerId,
      schemeId,
      amountPaise: 50_000,
      goldWeightMg: 50,
      status: 'SUCCESS',
      payoutDate: new Date(),
      payoutType: 'REDEEM',
      method: 'GOLD',
      createdBy: actorId,
    });

    const ledger = await aggregateEnrollmentLedger(String(schemeId));

    expect(ledger.totalPaidPaise).toBe(200_000);
    expect(ledger.totalGoldWeightMg).toBe(273);
    expect(ledger.paymentsCompleted).toBe(2);
    expect(ledger.totalPayoutPaise).toBe(50_000);
    expect(ledger.totalPayoutGoldWeightMg).toBe(50);
    expect(ledger.availablePaise).toBe(150_000);
    expect(ledger.availableGoldWeightMg).toBe(223);
  });

  it('excludes REFUNDED and REVERSED payments from current enrollment totals', async () => {
    const schemeId = new mongoose.Types.ObjectId();
    const customerId = new mongoose.Types.ObjectId();
    const actorId = new mongoose.Types.ObjectId();

    await Payment.create([
      {
        customerId,
        schemeId,
        amountPaise: 100_000,
        method: 'UPI',
        status: 'REFUNDED',
        paymentDate: new Date(),
        schemeMonth: 1,
        collectorRole: 'CUSTOMER',
        createdBy: actorId,
        goldWeightMg: 133,
        merchantTransactionId: 'only-refunded',
      },
      {
        customerId,
        schemeId,
        amountPaise: 100_000,
        method: 'CASH',
        status: 'REVERSED',
        paymentDate: new Date(),
        schemeMonth: 2,
        collectorRole: 'ADMIN',
        createdBy: actorId,
        goldWeightMg: 140,
      },
    ]);

    const ledger = await aggregateEnrollmentLedger(String(schemeId));
    expect(ledger.totalPaidPaise).toBe(0);
    expect(ledger.totalGoldWeightMg).toBe(0);
    expect(ledger.paymentsCompleted).toBe(0);
  });
});
