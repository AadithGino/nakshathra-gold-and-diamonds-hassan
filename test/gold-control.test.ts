import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import mongoose from 'mongoose';
import {
  FinancialException,
  GoldInventoryMovement,
  Payment,
  Payout,
  Refund,
  User,
} from '../src/models/index.js';
import {
  getCurrentGoldLiabilityMg,
  getGoldControlSummary,
  getGoldLiabilityMovements,
  recordGoldInventoryMovement,
  recordPayoutGoldIssue,
  reportNegativeInventoryException,
} from '../src/services/gold-control.service.js';
import { clearTestMongo, startTestMongo, stopTestMongo } from './helpers/mongo.js';

async function seedActor() {
  const [admin] = await User.create([
    {
      name: 'Gold Admin',
      phone: `+9199${String(Date.now()).slice(-8)}`,
      passwordHash: 'hash',
      role: 'ADMIN',
      status: 'ACTIVE',
    },
  ]);
  return admin;
}

describe('gold liability and inventory', () => {
  beforeAll(async () => {
    await startTestMongo();
  });
  afterAll(async () => {
    await stopTestMongo();
  });
  beforeEach(async () => {
    await clearTestMongo();
  });

  it('includes SUCCESS payment gold and excludes REFUNDED without mutating gold fields', async () => {
    const admin = await seedActor();
    const [payment] = await Payment.create([
      {
        customerId: admin._id,
        schemeId: admin._id,
        amountPaise: 100_000,
        goldWeightMg: 142,
        method: 'PHONEPE',
        status: 'SUCCESS',
        paymentDate: new Date(),
        schemeMonth: 1,
        receiptNumber: 'RCP-GOLD-1',
        collectorRole: 'ADMIN',
        createdBy: admin._id,
      },
    ]);

    expect(await getCurrentGoldLiabilityMg()).toBe(142);

    payment.status = 'REFUNDED';
    payment.refundStatus = 'SUCCESS';
    await payment.save();

    expect(await getCurrentGoldLiabilityMg()).toBe(0);
    const immutable = await Payment.findById(payment._id);
    expect(immutable?.goldWeightMg).toBe(142);
    expect(immutable?.amountPaise).toBe(100_000);
  });

  it('keeps original payment credits in movement history after refund', async () => {
    const admin = await seedActor();
    const payAt = new Date('2026-06-15T10:00:00.000Z');
    const refundAt = new Date('2026-07-20T10:00:00.000Z');
    const [payment] = await Payment.create([
      {
        customerId: admin._id,
        schemeId: admin._id,
        amountPaise: 100_000,
        goldWeightMg: 142,
        method: 'PHONEPE',
        status: 'REFUNDED',
        refundStatus: 'SUCCESS',
        paymentDate: payAt,
        refundedAt: refundAt,
        schemeMonth: 1,
        receiptNumber: 'RCP-GOLD-HIST',
        collectorRole: 'ADMIN',
        createdBy: admin._id,
      },
    ]);
    await Refund.create([
      {
        paymentId: payment._id,
        customerId: admin._id,
        schemeId: admin._id,
        merchantRefundId: 'RFD-HIST-1',
        originalMerchantOrderId: 'KRL-HIST-1',
        amountPaise: 100_000,
        status: 'SUCCESS',
        reason: 'History test',
        idempotencyKey: 'hist-1',
        requestHash: 'hash',
        requestedBy: admin._id,
        requestedAt: refundAt,
        completedAt: refundAt,
      },
    ]);

    const movements = await getGoldLiabilityMovements(
      new Date('2026-06-01T00:00:00.000Z'),
      new Date('2026-07-31T23:59:59.000Z'),
    );
    expect(movements.some((m) => m.kind === 'PAYMENT_CREDIT' && m.signedMg === 142)).toBe(true);
    expect(movements.some((m) => m.kind === 'REFUND_DEBIT' && m.signedMg === -142)).toBe(true);
  });

  it('returns signed negative liability and raises a critical exception', async () => {
    const admin = await seedActor();
    await Payout.create([
      {
        customerId: admin._id,
        schemeId: admin._id,
        amountPaise: 100_000,
        goldWeightMg: 50,
        payoutDate: new Date(),
        payoutType: 'REDEEM',
        method: 'GOLD',
        status: 'SUCCESS',
        createdBy: admin._id,
      },
    ]);
    expect(await getCurrentGoldLiabilityMg()).toBe(-50);
    expect(
      await FinancialException.countDocuments({ type: 'NEGATIVE_GOLD_LIABILITY' }),
    ).toBe(1);
  });

  it('records inventory movements as integer mg and requires adjustment reason', async () => {
    const admin = await seedActor();
    await expect(
      recordGoldInventoryMovement(
        {
          movementType: 'NEGATIVE_ADJUSTMENT',
          goldWeightMg: 10,
          movementDate: new Date(),
          reason: '  ',
        },
        { actorId: String(admin._id), actorRole: 'ADMIN', requestId: 'bad' },
      ),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });

    await recordGoldInventoryMovement(
      {
        movementType: 'OPENING_STOCK',
        goldWeightMg: 500,
        movementDate: new Date(),
        reason: 'Opening vault stock',
      },
      { actorId: String(admin._id), actorRole: 'ADMIN', requestId: 'open' },
    );

    const summary = await getGoldControlSummary();
    expect(summary.inventoryMg).toBe(500);
    expect(summary.liabilityMg).toBe(0);
    expect(summary.coverageMg).toBe(500);
    expect(Number.isInteger(summary.inventoryMg)).toBe(true);
  });

  it('issues payout gold once and raises CRITICAL exception when inventory goes negative', async () => {
    const admin = await seedActor();
    await Payment.create([
      {
        customerId: admin._id,
        schemeId: admin._id,
        amountPaise: 100_000,
        goldWeightMg: 200,
        method: 'PHONEPE',
        status: 'SUCCESS',
        paymentDate: new Date(),
        schemeMonth: 1,
        receiptNumber: 'RCP-GOLD-2',
        collectorRole: 'ADMIN',
        createdBy: admin._id,
      },
    ]);
    expect(await getCurrentGoldLiabilityMg()).toBe(200);

    const [payout] = await Payout.create([
      {
        customerId: admin._id,
        schemeId: admin._id,
        amountPaise: 100_000,
        goldWeightMg: 200,
        payoutType: 'REDEEM',
        method: 'GOLD',
        payoutDate: new Date(),
        status: 'SUCCESS',
        createdBy: admin._id,
      },
    ]);

    const session = await mongoose.startSession();
    session.startTransaction();
    try {
      const first = await recordPayoutGoldIssue(
        payout,
        { actorId: String(admin._id), actorRole: 'ADMIN', requestId: 'issue-1' },
        session,
      );
      const second = await recordPayoutGoldIssue(
        payout,
        { actorId: String(admin._id), actorRole: 'ADMIN', requestId: 'issue-2' },
        session,
      );
      expect(String(first.movement?._id)).toBe(String(second.movement?._id));
      expect(first.inventoryMg).toBe(-200);
      await session.commitTransaction();
      await reportNegativeInventoryException(payout._id, first.inventoryMg!);
    } finally {
      session.endSession();
    }

    expect(await GoldInventoryMovement.countDocuments({ payoutId: payout._id })).toBe(1);
    expect(await getCurrentGoldLiabilityMg()).toBe(0);
    const summary = await getGoldControlSummary();
    expect(summary.inventoryMg).toBe(-200);
    expect(summary.coverageMg).toBe(-200);

    const exception = await FinancialException.findOne({ type: 'NEGATIVE_GOLD_INVENTORY' });
    expect(exception?.severity).toBe('CRITICAL');
    expect(exception?.status).toBe('OPEN');
  });
});
