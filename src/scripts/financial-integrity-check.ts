/**
 * Read-only financial integrity checks for restore drills / ops.
 * Usage: MONGODB_URI=... npm run integrity-check
 * Exits non-zero on issues. Never auto-fixes production data.
 */
import mongoose from 'mongoose';
import { connectDatabase, disconnectDatabase } from '../config/database.js';
import {
  FinancialException,
  GatewaySettlement,
  GoldInventoryMovement,
  OutboxEvent,
  Payment,
  PaymentIntent,
  Payout,
  Refund,
} from '../models/index.js';
import { expectedNetSettlementPaise } from '../services/gateway-settlement.service.js';
import {
  getCurrentGoldLiabilityMg,
  getPhysicalGoldInventoryMg,
} from '../services/gold-control.service.js';

export type FinancialIntegrityReport = {
  ok: boolean;
  errors: string[];
  counts: Record<string, number>;
};

/** Read-only checks. Caller must already be connected. Never mutates data. */
export async function runFinancialIntegrityChecks(): Promise<FinancialIntegrityReport> {
  const errors: string[] = [];

  const payments = await Payment.find({})
    .select('amountPaise goldWeightMg status refundId refundStatus merchantTransactionId')
    .lean();
  for (const payment of payments) {
    if (!Number.isInteger(payment.amountPaise)) {
      errors.push(`Payment ${payment._id} amountPaise not integer`);
    }
    if (payment.goldWeightMg != null && !Number.isInteger(payment.goldWeightMg)) {
      errors.push(`Payment ${payment._id} goldWeightMg not integer`);
    }
    if (payment.status === 'REFUNDED' && !payment.refundId) {
      errors.push(`REFUNDED payment ${payment._id} missing refundId`);
    }
  }

  const successRefunds = await Refund.find({ status: 'SUCCESS' })
    .select('_id paymentId')
    .lean();
  for (const refund of successRefunds) {
    const payment = await Payment.findById(refund.paymentId).select('status').lean();
    if (!payment || payment.status !== 'REFUNDED') {
      errors.push(`Successful refund ${refund._id} payment is not REFUNDED`);
    }
  }

  const refundedPayments = await Payment.find({ status: 'REFUNDED' })
    .select('_id refundId')
    .lean();
  for (const payment of refundedPayments) {
    if (!payment.refundId) continue;
    const refund = await Refund.findById(payment.refundId).select('status').lean();
    if (!refund || refund.status !== 'SUCCESS') {
      errors.push(`REFUNDED payment ${payment._id} lacks successful Refund`);
    }
  }

  const settlements = await GatewaySettlement.find({}).lean();
  for (const settlement of settlements) {
    const expected = expectedNetSettlementPaise(settlement);
    if (expected !== settlement.netSettlementPaise) {
      errors.push(`Settlement ${settlement.settlementId} formula imbalance`);
    }
  }

  const pendingIntents = await PaymentIntent.countDocuments(
    mongoose.trusted({
      status: 'PENDING',
      lastGatewayError: mongoose.trusted({ $ne: 'PROVIDER_ORDER_ABSENT_ALLOW_CREATE_RETRY' }),
      $or: [
        { nextStatusCheckAt: null },
        { nextStatusCheckAt: mongoose.trusted({ $exists: false }) },
      ],
    }),
  );
  if (pendingIntents > 0) {
    errors.push(`${pendingIntents} PENDING payment intents missing nextStatusCheckAt`);
  }

  const uncertainMissingSchedule = await PaymentIntent.countDocuments(
    mongoose.trusted({
      status: 'PROVIDER_CREATE_UNCERTAIN',
      $or: [
        { nextStatusCheckAt: null },
        { nextStatusCheckAt: mongoose.trusted({ $exists: false }) },
      ],
    }),
  );
  if (uncertainMissingSchedule > 0) {
    errors.push(
      `${uncertainMissingSchedule} PROVIDER_CREATE_UNCERTAIN intents missing nextStatusCheckAt`,
    );
  }

  const now = new Date();
  const staleCreating = await PaymentIntent.countDocuments(
    mongoose.trusted({
      status: 'PROVIDER_CREATING',
      $or: [
        { providerLaunchLockUntil: null },
        { providerLaunchLockUntil: mongoose.trusted({ $exists: false }) },
        { providerLaunchLockUntil: mongoose.trusted({ $lte: now }) },
      ],
    }),
  );
  if (staleCreating > 0) {
    errors.push(`${staleCreating} PROVIDER_CREATING intents with expired or missing launch lease`);
  }

  const creatingWithoutLease = await PaymentIntent.countDocuments(
    mongoose.trusted({
      status: 'PROVIDER_CREATING',
      $or: [
        { providerLaunchLockUntil: null },
        { providerLaunchLockUntil: mongoose.trusted({ $exists: false }) },
      ],
    }),
  );
  if (creatingWithoutLease > 0) {
    errors.push(`${creatingWithoutLease} PROVIDER_CREATING intents without a valid lease`);
  }

  const launchableWithProviderOrder = await PaymentIntent.countDocuments(
    mongoose.trusted({
      status: mongoose.trusted({ $in: ['INITIATED', 'PENDING'] }),
      providerOrderId: mongoose.trusted({ $nin: [null, ''] }),
      $and: [
        mongoose.trusted({
          $or: [
            { checkoutUrl: null },
            { checkoutUrl: '' },
            { checkoutUrl: mongoose.trusted({ $exists: false }) },
          ],
        }),
        mongoose.trusted({
          $or: [
            { sdkToken: null },
            { sdkToken: '' },
            { sdkToken: mongoose.trusted({ $exists: false }) },
          ],
        }),
      ],
    }),
  );
  if (launchableWithProviderOrder > 0) {
    errors.push(
      `${launchableWithProviderOrder} launchable intents already have a provider order reference`,
    );
  }

  const providerOrderAllowsCreate = await PaymentIntent.countDocuments(
    mongoose.trusted({
      status: mongoose.trusted({ $in: ['INITIATED', 'PENDING'] }),
      providerOrderId: mongoose.trusted({ $nin: [null, ''] }),
      lastGatewayError: 'PROVIDER_ORDER_ABSENT_ALLOW_CREATE_RETRY',
    }),
  );
  if (providerOrderAllowsCreate > 0) {
    errors.push(
      `${providerOrderAllowsCreate} intents allow create while still holding a provider order reference`,
    );
  }

  const uncertainMissingMerchantOrder = await PaymentIntent.countDocuments(
    mongoose.trusted({
      status: 'PROVIDER_CREATE_UNCERTAIN',
      $or: [
        { merchantTransactionId: null },
        { merchantTransactionId: '' },
        { merchantTransactionId: mongoose.trusted({ $exists: false }) },
      ],
    }),
  );
  if (uncertainMissingMerchantOrder > 0) {
    errors.push(
      `${uncertainMissingMerchantOrder} uncertain intents missing merchant order ID`,
    );
  }

  const duplicateIdempotency = await PaymentIntent.aggregate([
    {
      $match: {
        idempotencyKey: { $exists: true, $nin: [null, ''] },
      },
    },
    {
      $group: {
        _id: {
          customerId: '$customerId',
          idempotencyScope: '$idempotencyScope',
          idempotencyKey: '$idempotencyKey',
        },
        count: { $sum: 1 },
      },
    },
    { $match: { count: { $gt: 1 } } },
  ]);
  if (duplicateIdempotency.length) {
    errors.push(
      `${duplicateIdempotency.length} PaymentIntent idempotency commands have multiple documents`,
    );
  }

  const pendingRefunds = await Refund.countDocuments(
    mongoose.trusted({
      status: mongoose.trusted({ $in: ['INITIATED', 'PENDING'] }),
      active: true,
      $or: [
        { nextStatusCheckAt: null },
        { nextStatusCheckAt: mongoose.trusted({ $exists: false }) },
      ],
    }),
  );
  if (pendingRefunds > 0) {
    errors.push(`${pendingRefunds} active refunds missing nextStatusCheckAt`);
  }

  const activeMissingMerchant = await Refund.countDocuments(
    mongoose.trusted({
      active: true,
      $or: [
        { merchantRefundId: null },
        { merchantRefundId: '' },
        { merchantRefundId: mongoose.trusted({ $exists: false }) },
      ],
    }),
  );
  if (activeMissingMerchant > 0) {
    errors.push(`${activeMissingMerchant} active refunds missing merchantRefundId`);
  }

  const multiActive = await Refund.aggregate([
    { $match: { active: true } },
    { $group: { _id: '$paymentId', count: { $sum: 1 } } },
    { $match: { count: { $gt: 1 } } },
  ]);
  if (multiActive.length) {
    errors.push(`${multiActive.length} payments have more than one active refund attempt`);
  }

  const activeTerminal = await Refund.countDocuments(
    mongoose.trusted({
      active: true,
      status: mongoose.trusted({ $in: ['SUCCESS', 'FAILED', 'REVIEW_REQUIRED'] }),
    }),
  );
  if (activeTerminal > 0) {
    errors.push(`${activeTerminal} terminal refunds still marked active`);
  }

  const successStillActive = await Refund.countDocuments({ status: 'SUCCESS', active: true });
  if (successStillActive > 0) {
    errors.push(`${successStillActive} SUCCESS refunds still marked active`);
  }

  const amountMismatches = await Refund.aggregate([
    {
      $lookup: {
        from: 'payments',
        localField: 'paymentId',
        foreignField: '_id',
        as: 'payment',
      },
    },
    { $unwind: '$payment' },
    { $match: { $expr: { $ne: ['$amountPaise', '$payment.amountPaise'] } } },
    { $limit: 20 },
  ]);
  for (const row of amountMismatches) {
    errors.push(`Refund ${row._id} amount differs from payment ${row.paymentId}`);
  }

  const staleOutbox = await OutboxEvent.countDocuments(
    mongoose.trusted({
      status: 'PROCESSING',
      $or: [
        { lockUntil: null },
        { lockUntil: mongoose.trusted({ $exists: false }) },
        { lockUntil: mongoose.trusted({ $lt: new Date(Date.now() - 24 * 60 * 60_000) }) },
      ],
    }),
  );
  if (staleOutbox > 0) {
    errors.push(`${staleOutbox} PROCESSING outbox events look lease-stale`);
  }

  const payouts = await Payout.find(
    mongoose.trusted({ status: 'SUCCESS', method: 'GOLD', goldWeightMg: mongoose.trusted({ $gt: 0 }) }),
  )
    .select('_id')
    .lean();
  for (const payout of payouts) {
    const movement = await GoldInventoryMovement.findOne({ payoutId: payout._id })
      .select('_id')
      .lean();
    if (!movement) {
      errors.push(`Payout ${payout._id} missing ISSUE_TO_CUSTOMER inventory movement`);
    }
  }

  const inventoryMg = await getPhysicalGoldInventoryMg();
  const liabilityMg = await getCurrentGoldLiabilityMg();
  if (!Number.isInteger(inventoryMg) || !Number.isInteger(liabilityMg)) {
    errors.push('Gold control totals are not integers');
  }
  if (inventoryMg < 0) {
    const open = await FinancialException.countDocuments(
      mongoose.trusted({
        type: 'NEGATIVE_GOLD_INVENTORY',
        status: mongoose.trusted({ $in: ['OPEN', 'ACKNOWLEDGED'] }),
      }),
    );
    if (!open) errors.push('Negative inventory without open CRITICAL exception');
  }

  const duplicateMerchant = await Payment.aggregate([
    {
      $match: {
        merchantTransactionId: { $exists: true, $nin: [null, ''] },
      },
    },
    { $group: { _id: '$merchantTransactionId', count: { $sum: 1 } } },
    { $match: { count: { $gt: 1 } } },
  ]);
  if (duplicateMerchant.length) {
    errors.push(`${duplicateMerchant.length} duplicate merchantTransactionId values`);
  }

  const duplicatePayouts = await Payout.aggregate([
    { $match: { status: 'SUCCESS' } },
    { $group: { _id: '$schemeId', count: { $sum: 1 } } },
    { $match: { count: { $gt: 1 } } },
  ]);
  if (duplicatePayouts.length) {
    errors.push(`${duplicatePayouts.length} schemes have more than one SUCCESS payout`);
  }

  const counts = {
    payments: await Payment.countDocuments(),
    refunds: await Refund.countDocuments(),
    payouts: await Payout.countDocuments(),
    goldInventoryMovements: await GoldInventoryMovement.countDocuments(),
    gatewaySettlements: await GatewaySettlement.countDocuments(),
    financialExceptions: await FinancialException.countDocuments(),
    inventoryMg,
    liabilityMg,
  };

  return {
    ok: errors.length === 0,
    counts,
    errors,
  };
}

async function main() {
  await connectDatabase();
  try {
    const report = await runFinancialIntegrityChecks();
    console.log(JSON.stringify(report, null, 2));
    if (!report.ok) process.exit(1);
  } finally {
    await disconnectDatabase();
  }
}

const isDirectRun =
  process.argv[1]?.includes('financial-integrity-check') ||
  process.argv[1]?.includes('integrity-check');

if (isDirectRun) {
  main().catch(async (error) => {
    console.error(error);
    await disconnectDatabase().catch(() => undefined);
    process.exit(1);
  });
}
