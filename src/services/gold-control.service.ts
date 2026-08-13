import type { ClientSession } from 'mongoose';
import mongoose from 'mongoose';
import {
  GoldInventoryMovement,
  Payment,
  Payout,
  Refund,
  type GoldInventoryDirection,
  type GoldInventoryMovementType,
} from '../models/index.js';
import { AppError } from '../utils/AppError.js';
import {
  buildCursorPage,
  buildOffsetPage,
  coerceBoundedListQuery,
  cursorFetchLimit,
  offsetSkip,
  type ListPageResult,
  type ListQuery,
  withKeysetFilter,
} from '../utils/cursor-pagination.js';
import { withMongoTransaction } from '../utils/transaction.js';
import { audit, type AuditContext } from './audit.service.js';
import { upsertFinancialException } from './financial-exception.service.js';
import { assertDateInOpenPeriod } from './accounting-period.service.js';

const IN_TYPES = new Set<GoldInventoryMovementType>([
  'OPENING_STOCK',
  'PURCHASE',
  'RETURN_FROM_CUSTOMER',
  'POSITIVE_ADJUSTMENT',
]);

const OUT_TYPES = new Set<GoldInventoryMovementType>([
  'ISSUE_TO_CUSTOMER',
  'NEGATIVE_ADJUSTMENT',
]);

export function directionForMovementType(
  movementType: GoldInventoryMovementType,
): GoldInventoryDirection {
  if (IN_TYPES.has(movementType)) return 'IN';
  if (OUT_TYPES.has(movementType)) return 'OUT';
  throw new AppError('VALIDATION_ERROR', `Unknown inventory movement type ${movementType}`, 422);
}

export async function getCurrentGoldLiabilityMg(session?: ClientSession) {
  const paymentAgg = Payment.aggregate([
    { $match: { status: 'SUCCESS' } },
    {
      $group: {
        _id: null,
        totalMg: { $sum: { $ifNull: ['$goldWeightMg', 0] } },
      },
    },
  ]);
  const payoutAgg = Payout.aggregate([
    { $match: { status: 'SUCCESS' } },
    {
      $group: {
        _id: null,
        totalMg: { $sum: { $ifNull: ['$goldWeightMg', 0] } },
      },
    },
  ]);
  if (session) {
    paymentAgg.session(session);
    payoutAgg.session(session);
  }
  const [[payments], [payouts]] = await Promise.all([paymentAgg, payoutAgg]);
  const liabilityMg = Number(payments?.totalMg ?? 0) - Number(payouts?.totalMg ?? 0);
  if (liabilityMg < 0) {
    await upsertFinancialException({
      dedupeKey: 'gold:liability:NEGATIVE_GOLD_LIABILITY',
      type: 'NEGATIVE_GOLD_LIABILITY',
      title: 'Negative gold liability',
      description: `Computed gold liability is ${liabilityMg} mg`,
      metadata: {
        liabilityMg,
        paymentGoldMg: Number(payments?.totalMg ?? 0),
        payoutGoldMg: Number(payouts?.totalMg ?? 0),
      },
    });
  }
  return liabilityMg;
}

/**
 * Historical gold liability as of an exclusive period end (`endsAt`).
 * Credits successful payment-dated gold; debits refunds/reversals/payouts completed before endsAt.
 * Later events must not change earlier period closing liability.
 */
export async function getGoldLiabilityMgAsOf(endsAt: Date, session?: ClientSession) {
  const withSession = <T extends { session: (s: ClientSession) => T }>(query: T) =>
    session ? query.session(session) : query;

  const [credits, refundDebits, reversalDebits, payoutDebits] = await Promise.all([
    withSession(
      Payment.aggregate([
        {
          $match: {
            status: { $in: ['SUCCESS', 'REFUNDED', 'REVERSED'] },
            paymentDate: { $lt: endsAt },
          },
        },
        {
          $group: {
            _id: null,
            totalMg: { $sum: { $ifNull: ['$goldWeightMg', 0] } },
          },
        },
      ]),
    ),
    withSession(
      Refund.aggregate([
        {
          $match: {
            status: 'SUCCESS',
            completedAt: { $lt: endsAt },
          },
        },
        {
          $lookup: {
            from: 'payments',
            localField: 'paymentId',
            foreignField: '_id',
            as: 'payment',
          },
        },
        { $unwind: '$payment' },
        {
          $group: {
            _id: null,
            totalMg: { $sum: { $ifNull: ['$payment.goldWeightMg', 0] } },
          },
        },
      ]),
    ),
    withSession(
      Payment.aggregate([
        {
          $match: {
            status: 'REVERSED',
            reversedAt: { $lt: endsAt },
          },
        },
        {
          $group: {
            _id: null,
            totalMg: { $sum: { $ifNull: ['$goldWeightMg', 0] } },
          },
        },
      ]),
    ),
    withSession(
      Payout.aggregate([
        {
          $match: {
            status: 'SUCCESS',
            payoutDate: { $lt: endsAt },
          },
        },
        {
          $group: {
            _id: null,
            totalMg: { $sum: { $ifNull: ['$goldWeightMg', 0] } },
          },
        },
      ]),
    ),
  ]);

  return (
    Number(credits[0]?.totalMg ?? 0) -
    Number(refundDebits[0]?.totalMg ?? 0) -
    Number(reversalDebits[0]?.totalMg ?? 0) -
    Number(payoutDebits[0]?.totalMg ?? 0)
  );
}

export async function getPhysicalGoldInventoryMg(session?: ClientSession, asOfExclusive?: Date) {
  const pipeline: Record<string, unknown>[] = [];
  if (asOfExclusive) {
    pipeline.push({ $match: { movementDate: { $lt: asOfExclusive } } });
  }
  pipeline.push({
    $group: {
      _id: null,
      inventoryMg: {
        $sum: {
          $cond: [
            { $eq: ['$direction', 'IN'] },
            '$goldWeightMg',
            { $multiply: ['$goldWeightMg', -1] },
          ],
        },
      },
    },
  });
  const agg = GoldInventoryMovement.aggregate(pipeline);
  if (session) agg.session(session);
  const [row] = await agg;
  return Number(row?.inventoryMg ?? 0);
}

/** Physical inventory as of exclusive period end. */
export async function getPhysicalGoldInventoryMgAsOf(endsAt: Date, session?: ClientSession) {
  return getPhysicalGoldInventoryMg(session, endsAt);
}


export async function getGoldControlSummary() {
  const [liabilityMg, inventoryMg] = await Promise.all([
    getCurrentGoldLiabilityMg(),
    getPhysicalGoldInventoryMg(),
  ]);
  const coverageMg = inventoryMg - liabilityMg;
  const coveragePercent =
    liabilityMg > 0 ? Math.round((inventoryMg / liabilityMg) * 10_000) / 100 : null;
  return {
    liabilityMg,
    inventoryMg,
    coverageMg,
    coveragePercent,
    purity: '916' as const,
  };
}

export type GoldLiabilityMovement = {
  kind: 'PAYMENT_CREDIT' | 'REFUND_DEBIT' | 'PAYOUT_DEBIT' | 'REVERSAL_DEBIT';
  at: Date;
  goldWeightMg: number;
  signedMg: number;
  paymentId?: unknown;
  refundId?: unknown;
  payoutId?: unknown;
  receiptNumber?: string | null;
  merchantRefundId?: string | null;
};

export async function getGoldLiabilityMovements(from?: Date, to?: Date) {
  const movements: GoldLiabilityMovement[] = [];
  const paymentDateFilter =
    from || to
      ? {
          paymentDate: mongoose.trusted({
            ...(from ? { $gte: from } : {}),
            ...(to ? { $lte: to } : {}),
          }),
        }
      : {};

  // Credits keep original payment-date history even after refund/reversal.
  const creditedPayments = await Payment.find(
    mongoose.trusted({
      status: mongoose.trusted({ $in: ['SUCCESS', 'REFUNDED', 'REVERSED'] }),
      ...paymentDateFilter,
    }),
  )
    .select('_id paymentDate goldWeightMg receiptNumber status')
    .sort({ paymentDate: -1, _id: -1 })
    .limit(500)
    .lean();

  for (const payment of creditedPayments) {
    const mg = Number(payment.goldWeightMg ?? 0);
    if (mg <= 0) continue;
    movements.push({
      kind: 'PAYMENT_CREDIT',
      at: payment.paymentDate,
      goldWeightMg: mg,
      signedMg: mg,
      paymentId: payment._id,
      receiptNumber: payment.receiptNumber,
    });
  }

  const reversed = await Payment.find(
    mongoose.trusted({
      status: 'REVERSED',
      ...(from || to
        ? {
            reversedAt: mongoose.trusted({
              ...(from ? { $gte: from } : {}),
              ...(to ? { $lte: to } : {}),
            }),
          }
        : {}),
    }),
  )
    .select('_id reversedAt goldWeightMg receiptNumber')
    .sort({ reversedAt: -1, _id: -1 })
    .limit(500)
    .lean();

  for (const payment of reversed) {
    const mg = Number(payment.goldWeightMg ?? 0);
    if (mg <= 0) continue;
    movements.push({
      kind: 'REVERSAL_DEBIT',
      at: payment.reversedAt ?? new Date(0),
      goldWeightMg: mg,
      signedMg: -mg,
      paymentId: payment._id,
      receiptNumber: payment.receiptNumber,
    });
  }

  const refunds = await Refund.find(
    mongoose.trusted({
      status: 'SUCCESS',
      ...(from || to
        ? {
            completedAt: mongoose.trusted({
              ...(from ? { $gte: from } : {}),
              ...(to ? { $lte: to } : {}),
            }),
          }
        : {}),
    }),
  )
    .select('_id paymentId completedAt merchantRefundId')
    .sort({ completedAt: -1, _id: -1 })
    .limit(500)
    .lean();

  for (const refund of refunds) {
    const payment = await Payment.findById(refund.paymentId)
      .select('goldWeightMg receiptNumber')
      .lean();
    const mg = Number(payment?.goldWeightMg ?? 0);
    if (mg <= 0) continue;
    movements.push({
      kind: 'REFUND_DEBIT',
      at: refund.completedAt ?? new Date(0),
      goldWeightMg: mg,
      signedMg: -mg,
      paymentId: refund.paymentId,
      refundId: refund._id,
      receiptNumber: payment?.receiptNumber,
      merchantRefundId: refund.merchantRefundId,
    });
  }

  const payouts = await Payout.find(
    mongoose.trusted({
      status: 'SUCCESS',
      ...(from || to
        ? {
            payoutDate: mongoose.trusted({
              ...(from ? { $gte: from } : {}),
              ...(to ? { $lte: to } : {}),
            }),
          }
        : {}),
    }),
  )
    .select('_id payoutDate goldWeightMg')
    .sort({ payoutDate: -1, _id: -1 })
    .limit(500)
    .lean();

  for (const payout of payouts) {
    const mg = Number(payout.goldWeightMg ?? 0);
    if (mg <= 0) continue;
    movements.push({
      kind: 'PAYOUT_DEBIT',
      at: payout.payoutDate,
      goldWeightMg: mg,
      signedMg: -mg,
      payoutId: payout._id,
    });
  }

  movements.sort((a, b) => a.at.getTime() - b.at.getTime());
  return movements;
}

async function createInventoryMovementDoc(
  input: {
    movementType: GoldInventoryMovementType;
    goldWeightMg: number;
    movementDate: Date;
    purity?: string;
    payoutId?: unknown;
    referenceNumber?: string;
    reason: string;
    createdBy: string;
  },
  session?: ClientSession,
) {
  if (!Number.isInteger(input.goldWeightMg) || input.goldWeightMg < 1) {
    throw new AppError('VALIDATION_ERROR', 'goldWeightMg must be a positive integer', 422);
  }
  const direction = directionForMovementType(input.movementType);
  const docs = await GoldInventoryMovement.create(
    [
      {
        movementType: input.movementType,
        direction,
        goldWeightMg: input.goldWeightMg,
        purity: input.purity ?? '916',
        movementDate: input.movementDate,
        payoutId: input.payoutId,
        referenceNumber: input.referenceNumber,
        reason: input.reason.trim(),
        createdBy: input.createdBy,
      },
    ],
    session ? { session } : undefined,
  );
  return docs[0];
}

export async function recordGoldInventoryMovement(
  input: {
    movementType: Exclude<GoldInventoryMovementType, 'ISSUE_TO_CUSTOMER'>;
    goldWeightMg: number;
    movementDate: Date;
    purity?: string;
    referenceNumber?: string;
    reason: string;
  },
  context: AuditContext & { actorId: string },
) {
  if (!input.reason?.trim()) {
    throw new AppError('VALIDATION_ERROR', 'Adjustment reason is required', 422);
  }
  if (input.movementType === ('ISSUE_TO_CUSTOMER' as string)) {
    throw new AppError(
      'VALIDATION_ERROR',
      'ISSUE_TO_CUSTOMER is created only via payout redemption',
      422,
    );
  }

  return withMongoTransaction(async (session) => {
    await assertDateInOpenPeriod(input.movementDate, session);
    const movement = await createInventoryMovementDoc(
      { ...input, createdBy: context.actorId },
      session,
    );
    await audit(
      session,
      context,
      'GOLD_INVENTORY_MOVEMENT_RECORDED',
      'GoldInventoryMovement',
      movement._id,
      undefined,
      movement.toObject(),
    );
    return movement;
  }, context.requestId ?? 'gold-inventory-move');
}

/**
 * Create ISSUE_TO_CUSTOMER for a payout inside an existing transaction.
 * Does not block on insufficient stock; raises a CRITICAL exception if inventory goes negative.
 */
export async function recordPayoutGoldIssue(
  payout: { _id: unknown; goldWeightMg?: number; payoutDate?: Date; method?: string },
  context: AuditContext & { actorId: string },
  session: ClientSession,
) {
  const goldWeightMg = Number(payout.goldWeightMg ?? 0);
  const method = (payout as { method?: string }).method ?? 'GOLD';
  if (method !== 'GOLD' || goldWeightMg <= 0) {
    return { movement: null, inventoryMg: await getPhysicalGoldInventoryMg(session) };
  }

  const existing = await GoldInventoryMovement.findOne({ payoutId: payout._id }).session(session);
  if (existing) {
    return { movement: existing, inventoryMg: await getPhysicalGoldInventoryMg(session) };
  }

  let movement;
  try {
    movement = await createInventoryMovementDoc(
      {
        movementType: 'ISSUE_TO_CUSTOMER',
        goldWeightMg,
        movementDate: payout.payoutDate ?? new Date(),
        payoutId: payout._id,
        reason: `Physical gold issued for payout ${String(payout._id)}`,
        createdBy: context.actorId,
      },
      session,
    );
  } catch (error: any) {
    if (error?.code === 11000) {
      const raced = await GoldInventoryMovement.findOne({ payoutId: payout._id }).session(session);
      return {
        movement: raced,
        inventoryMg: await getPhysicalGoldInventoryMg(session),
      };
    }
    throw error;
  }

  await audit(
    session,
    context,
    'GOLD_INVENTORY_ISSUED_TO_CUSTOMER',
    'GoldInventoryMovement',
    movement._id,
    undefined,
    { payoutId: payout._id, goldWeightMg },
  );

  const inventoryMg = await getPhysicalGoldInventoryMg(session);
  if (inventoryMg < 0) {
    movement.referenceNumber = movement.referenceNumber ?? `NEG-INV:${inventoryMg}`;
    await movement.save({ session });
  }

  return { movement, inventoryMg };
}

export async function reportNegativeInventoryException(payoutId: unknown, inventoryMg: number) {
  if (inventoryMg >= 0) return null;
  return upsertFinancialException({
    dedupeKey: `payout:${payoutId}:NEGATIVE_GOLD_INVENTORY`,
    type: 'NEGATIVE_GOLD_INVENTORY',
    severity: 'CRITICAL',
    title: 'Physical gold inventory went negative',
    description: `Payout ${String(payoutId)} reduced recorded 916 inventory to ${inventoryMg} mg. Add opening stock, purchase, or correction.`,
    sourceType: 'Payout',
    sourceId: payoutId,
    metadata: { inventoryMg, payoutId: String(payoutId), coverageGap: true },
  });
}

export async function listGoldInventoryMovements(
  listQuery: ListQuery,
): Promise<ListPageResult<any>> {
  const query = coerceBoundedListQuery(listQuery);
  const sortField = 'movementDate';
  const filter = withKeysetFilter({}, query, sortField);
  const baseQuery = GoldInventoryMovement.find(filter)
    .populate('createdBy', 'name phone')
    .populate('payoutId', 'amountPaise goldWeightMg payoutDate');

  if (query.mode === 'cursor') {
    const rows = await baseQuery
      .sort({ [sortField]: -1, _id: -1 })
      .limit(cursorFetchLimit(query))
      .lean();
    return buildCursorPage(
      rows,
      query.limit,
      sortField,
      (row) => new Date(row.movementDate),
      (row) => row._id,
    );
  }
  const [items, total] = await Promise.all([
    baseQuery
      .sort({ [sortField]: -1, _id: -1 })
      .skip(offsetSkip(query))
      .limit(query.limit)
      .lean(),
    GoldInventoryMovement.countDocuments(),
  ]);
  return buildOffsetPage(items, total, query.page, query.limit);
}
