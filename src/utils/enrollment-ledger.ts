import type { ClientSession } from 'mongoose';
import mongoose from 'mongoose';
import { Payment, Payout, SchemeEnrollment } from '../models/index.js';
import { AppError } from './AppError.js';

export type EnrollmentLedger = {
  totalPaidPaise: number;
  totalGoldWeightMg: number;
  totalPayoutPaise: number;
  totalSettlementPrincipalPaise: number;
  totalPayoutGoldWeightMg: number;
  paymentsCompleted: number;
  availablePaise: number;
  availableGoldWeightMg: number;
};

const MAX_INSTALLMENTS = 11;

function assertSafeLedgerField(value: number, label: string) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new AppError(
      'LEDGER_INTEGRITY_ERROR',
      `${label} is invalid after ledger aggregation`,
      500,
      true,
    );
  }
}

/** Validate aggregated ledger values before writing them to enrollment cache. */
export function assertLedgerInvariants(ledger: EnrollmentLedger, schemeId: string) {
  assertSafeLedgerField(ledger.totalPaidPaise, 'totalPaidPaise');
  assertSafeLedgerField(ledger.totalGoldWeightMg, 'totalGoldWeightMg');
  assertSafeLedgerField(ledger.totalPayoutPaise, 'totalPayoutPaise');
  assertSafeLedgerField(ledger.totalSettlementPrincipalPaise, 'totalSettlementPrincipalPaise');
  assertSafeLedgerField(ledger.totalPayoutGoldWeightMg, 'totalPayoutGoldWeightMg');
  assertSafeLedgerField(ledger.availablePaise, 'availablePaise');
  assertSafeLedgerField(ledger.availableGoldWeightMg, 'availableGoldWeightMg');
  assertSafeLedgerField(ledger.paymentsCompleted, 'paymentsCompleted');

  if (ledger.paymentsCompleted > MAX_INSTALLMENTS) {
    throw new AppError(
      'LEDGER_INTEGRITY_ERROR',
      `Scheme ${schemeId} has more than ${MAX_INSTALLMENTS} paid installments in the ledger`,
      500,
      true,
    );
  }
  if (ledger.totalSettlementPrincipalPaise > ledger.totalPaidPaise) {
    throw new AppError(
      'LEDGER_INTEGRITY_ERROR',
      `Scheme ${schemeId} settlement principal exceeds paid total`,
      500,
      true,
    );
  }
  if (ledger.totalPayoutGoldWeightMg > ledger.totalGoldWeightMg) {
    throw new AppError(
      'LEDGER_INTEGRITY_ERROR',
      `Scheme ${schemeId} payout gold exceeds accumulated gold`,
      500,
      true,
    );
  }
  if (ledger.availablePaise !== ledger.totalPaidPaise - ledger.totalSettlementPrincipalPaise) {
    throw new AppError('LEDGER_INTEGRITY_ERROR', `Scheme ${schemeId} available paise mismatch`, 500, true);
  }
  if (
    ledger.availableGoldWeightMg !==
    ledger.totalGoldWeightMg - ledger.totalPayoutGoldWeightMg
  ) {
    throw new AppError('LEDGER_INTEGRITY_ERROR', `Scheme ${schemeId} available gold mismatch`, 500, true);
  }
}

export async function aggregateEnrollmentLedger(
  schemeId: string,
  session?: ClientSession,
): Promise<EnrollmentLedger> {
  const schemeObjectId = new mongoose.Types.ObjectId(schemeId);
  const [paymentAgg, payoutAgg, paidMonths] = await Promise.all([
    Payment.aggregate([
      { $match: { schemeId: schemeObjectId, status: 'SUCCESS' } },
      {
        $group: {
          _id: null,
          totalPaidPaise: { $sum: '$amountPaise' },
          totalGoldWeightMg: { $sum: { $ifNull: ['$goldWeightMg', 0] } },
        },
      },
    ]).session(session ?? null),
    Payout.aggregate([
      { $match: { schemeId: schemeObjectId, status: 'SUCCESS' } },
      {
        $group: {
          _id: null,
          totalPayoutPaise: { $sum: '$amountPaise' },
          totalSettlementPrincipalPaise: {
            $sum: { $ifNull: ['$settlementPrincipalPaise', '$amountPaise'] },
          },
          totalPayoutGoldWeightMg: { $sum: { $ifNull: ['$goldWeightMg', 0] } },
        },
      },
    ]).session(session ?? null),
    Payment.distinct('schemeMonth', {
      schemeId: schemeObjectId,
      status: 'SUCCESS',
    }).session(session ?? null),
  ]);

  const ledger: EnrollmentLedger = {
    totalPaidPaise: paymentAgg[0]?.totalPaidPaise ?? 0,
    totalGoldWeightMg: paymentAgg[0]?.totalGoldWeightMg ?? 0,
    totalPayoutPaise: payoutAgg[0]?.totalPayoutPaise ?? 0,
    totalSettlementPrincipalPaise: payoutAgg[0]?.totalSettlementPrincipalPaise ?? 0,
    totalPayoutGoldWeightMg: payoutAgg[0]?.totalPayoutGoldWeightMg ?? 0,
    paymentsCompleted: paidMonths.filter((month: unknown): month is number =>
      Number.isInteger(month),
    ).length,
    availablePaise: 0,
    availableGoldWeightMg: 0,
  };
  ledger.availablePaise = ledger.totalPaidPaise - ledger.totalSettlementPrincipalPaise;
  ledger.availableGoldWeightMg = ledger.totalGoldWeightMg - ledger.totalPayoutGoldWeightMg;
  assertLedgerInvariants(ledger, schemeId);
  return ledger;
}

/** Pure ledger from already-loaded payment/payout rows — same invariants as aggregateEnrollmentLedger. */
export function aggregateEnrollmentLedgerFromRecords(
  schemeId: string,
  payments: Array<{
    status?: string;
    amountPaise?: number;
    goldWeightMg?: number | null;
    schemeMonth?: number | null;
  }>,
  payouts: Array<{
    status?: string;
    amountPaise?: number;
    settlementPrincipalPaise?: number | null;
    goldWeightMg?: number | null;
  }>,
): EnrollmentLedger {
  const successPayments = payments.filter((row) => row.status === 'SUCCESS');
  const successPayouts = payouts.filter((row) => row.status === 'SUCCESS');
  const paidMonths = new Set(
    successPayments
      .map((row) => row.schemeMonth)
      .filter((month): month is number => Number.isInteger(month)),
  );
  const ledger: EnrollmentLedger = {
    totalPaidPaise: successPayments.reduce((sum, row) => sum + (row.amountPaise ?? 0), 0),
    totalGoldWeightMg: successPayments.reduce((sum, row) => sum + (row.goldWeightMg ?? 0), 0),
    totalPayoutPaise: successPayouts.reduce((sum, row) => sum + (row.amountPaise ?? 0), 0),
    totalSettlementPrincipalPaise: successPayouts.reduce(
      (sum, row) => sum + (row.settlementPrincipalPaise ?? row.amountPaise ?? 0),
      0,
    ),
    totalPayoutGoldWeightMg: successPayouts.reduce((sum, row) => sum + (row.goldWeightMg ?? 0), 0),
    paymentsCompleted: paidMonths.size,
    availablePaise: 0,
    availableGoldWeightMg: 0,
  };
  ledger.availablePaise = ledger.totalPaidPaise - ledger.totalSettlementPrincipalPaise;
  ledger.availableGoldWeightMg = ledger.totalGoldWeightMg - ledger.totalPayoutGoldWeightMg;
  assertLedgerInvariants(ledger, schemeId);
  return ledger;
}

/**
 * Recompute enrollment cached totals exclusively from payment/payout ledger rows.
 * This is the only supported way to mutate financial totals on SchemeEnrollment.
 */
export async function syncEnrollmentFromLedger(
  schemeId: string,
  session: ClientSession,
  expectedVersion?: number,
) {
  const ledger = await aggregateEnrollmentLedger(schemeId, session);
  const filter: Record<string, unknown> = { _id: schemeId };
  if (expectedVersion != null) filter.__v = expectedVersion;

  const update = await SchemeEnrollment.updateOne(
    filter,
    {
      $set: {
        totalPaidPaise: ledger.totalPaidPaise,
        totalGoldWeightMg: ledger.availableGoldWeightMg,
        totalPayoutPaise: ledger.totalPayoutPaise,
        paymentsCompleted: ledger.paymentsCompleted,
      },
    },
    { session },
  );
  if (expectedVersion != null && update.modifiedCount !== 1) {
    throw new AppError(
      'ENROLLMENT_CONCURRENTLY_UPDATED',
      'The scheme changed while processing. Retry the operation.',
      409,
      true,
    );
  }
  return ledger;
}

/** Guard reversals/corrections so ledger never goes negative. */
export async function assertEnrollmentSolvent(
  schemeId: string,
  session: ClientSession,
  deltas: { paidPaise?: number; goldWeightMg?: number; paymentsCompleted?: number } = {},
) {
  const ledger = await aggregateEnrollmentLedger(schemeId, session);
  if (deltas.paidPaise != null && !Number.isSafeInteger(deltas.paidPaise)) {
    throw new AppError('LEDGER_INTEGRITY_ERROR', 'paidPaise delta is invalid', 500, true);
  }
  if (deltas.goldWeightMg != null && !Number.isSafeInteger(deltas.goldWeightMg)) {
    throw new AppError('LEDGER_INTEGRITY_ERROR', 'goldWeightMg delta is invalid', 500, true);
  }
  if (deltas.paymentsCompleted != null && !Number.isSafeInteger(deltas.paymentsCompleted)) {
    throw new AppError('LEDGER_INTEGRITY_ERROR', 'paymentsCompleted delta is invalid', 500, true);
  }

  const nextPaid = ledger.totalPaidPaise + (deltas.paidPaise ?? 0);
  const nextGold = ledger.totalGoldWeightMg + (deltas.goldWeightMg ?? 0);
  const nextCompleted = ledger.paymentsCompleted + (deltas.paymentsCompleted ?? 0);
  if (nextPaid < 0 || nextGold < 0 || nextCompleted < 0) {
    throw new AppError(
      'LEDGER_UNDERFLOW',
      'This operation would make the scheme balance negative',
      409,
    );
  }
  return ledger;
}

const SETTLEMENT_LOCK_MS = 120_000;

const TERMINAL_SETTLEMENT_STATUSES = new Set(['REDEEMED', 'CLOSED', 'WITHDRAWN', 'CANCELLED']);

export const SETTLEMENT_LOCK_REDEMPTION_STATUSES = ['ACTIVE', 'MATURED'] as const;
export const SETTLEMENT_LOCK_REFUND_STATUSES = ['ACTIVE', 'MATURED'] as const;
export const SETTLEMENT_LOCK_PAYMENT_STATUSES = ['ACTIVE'] as const;

/** Mutual exclusion for new money, refunds, and settlement on the same enrollment. */
export async function claimEnrollmentSettlementLock(
  schemeId: unknown,
  ownerId: string,
  session: ClientSession,
  allowedStatuses: readonly string[] = ['ACTIVE'],
) {
  const statuses = [...new Set(allowedStatuses)].filter(
    (status) => !TERMINAL_SETTLEMENT_STATUSES.has(status),
  );
  if (statuses.length === 0) {
    throw new AppError(
      'SCHEME_SETTLEMENT_IN_PROGRESS',
      'This scheme status cannot obtain a settlement lock',
      409,
    );
  }

  const now = new Date();
  const locked = await SchemeEnrollment.findOneAndUpdate(
    mongoose.trusted({
      _id: schemeId,
      status: mongoose.trusted({ $in: statuses }),
      $or: [
        { settlementLockUntil: null },
        { settlementLockUntil: mongoose.trusted({ $exists: false }) },
        { settlementLockUntil: mongoose.trusted({ $lte: now }) },
      ],
    }),
    {
      $set: {
        settlementLockedAt: now,
        settlementLockUntil: new Date(now.getTime() + SETTLEMENT_LOCK_MS),
        settlementLockedBy: ownerId,
      },
    },
    { session, new: true },
  );
  if (!locked) {
    throw new AppError(
      'SCHEME_SETTLEMENT_IN_PROGRESS',
      'Another payment, refund, or redemption is already in progress for this scheme. Retry shortly.',
      409,
      true,
    );
  }
  return locked;
}

/** Same lock as settlement — used so payment initiation cannot race a close. */
export const claimEnrollmentFinancialMutationLock = claimEnrollmentSettlementLock;

export async function clearEnrollmentSettlementLock(
  schemeId: unknown,
  ownerId: string,
  session: ClientSession,
) {
  await SchemeEnrollment.updateOne(
    { _id: schemeId, settlementLockedBy: ownerId },
    {
      $set: {
        settlementLockedAt: null,
        settlementLockUntil: null,
        settlementLockedBy: null,
      },
    },
    { session },
  );
}
