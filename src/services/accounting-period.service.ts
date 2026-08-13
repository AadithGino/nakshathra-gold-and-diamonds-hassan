import { format } from 'date-fns';
import { fromZonedTime, toZonedTime } from 'date-fns-tz';
import type { ClientSession } from 'mongoose';
import mongoose from 'mongoose';
import {
  AccountingPeriod,
  FinancialException,
  GatewaySettlement,
  Payment,
  PaymentIntent,
  Payout,
  Refund,
  SuspenseEntry,
} from '../models/index.js';
import { AppError } from '../utils/AppError.js';
import { BUSINESS_TZ } from '../utils/time.js';
import { withMongoTransaction } from '../utils/transaction.js';
import { audit, type AuditContext } from './audit.service.js';
import {
  getGoldLiabilityMgAsOf,
  getPhysicalGoldInventoryMgAsOf,
} from './gold-control.service.js';

export function toPeriodKey(date: Date) {
  return format(toZonedTime(date, BUSINESS_TZ), 'yyyy-MM');
}

export function periodBounds(periodKey: string) {
  if (!/^\d{4}-\d{2}$/.test(periodKey)) {
    throw new AppError('VALIDATION_ERROR', 'periodKey must be YYYY-MM', 422);
  }
  const parts = periodKey.split('-').map(Number);
  const year = parts[0]!;
  const month = parts[1]!;
  if (month < 1 || month > 12) {
    throw new AppError('VALIDATION_ERROR', 'periodKey month must be between 01 and 12', 422);
  }
  const startsAt = fromZonedTime(new Date(year, month - 1, 1, 0, 0, 0, 0), BUSINESS_TZ);
  const endsAt = fromZonedTime(new Date(year, month, 1, 0, 0, 0, 0), BUSINESS_TZ);
  return { startsAt, endsAt };
}

/**
 * Suspense remaining open as of exclusive period end.
 * Resolved-after-end items still count toward the earlier closing balance.
 */
export async function getSuspenseBalancePaiseAsOf(endsAt: Date, session?: ClientSession) {
  const agg = SuspenseEntry.aggregate([
    {
      $match: {
        createdAt: { $lt: endsAt },
        $or: [{ resolvedAt: null }, { resolvedAt: { $exists: false } }, { resolvedAt: { $gte: endsAt } }],
      },
    },
    { $group: { _id: null, closingSuspensePaise: { $sum: '$amountPaise' } } },
  ]);
  if (session) agg.session(session);
  const [row] = await agg;
  return Number(row?.closingSuspensePaise ?? 0);
}

export type ExceptionStatusHistoryEvent = {
  status?: string;
  at?: Date;
};

/**
 * Whether an exception was open at exclusive period end.
 * Prefers immutable statusHistory so reopen cannot rewrite earlier periods.
 */
export function wasFinancialExceptionOpenAsOf(
  exception: {
    firstSeenAt: Date;
    resolvedAt?: Date | null;
    statusHistory?: ExceptionStatusHistoryEvent[] | null;
  },
  endsAt: Date,
) {
  if (new Date(exception.firstSeenAt).getTime() >= endsAt.getTime()) return false;
  const history = Array.isArray(exception.statusHistory) ? exception.statusHistory : [];
  if (history.length > 0) {
    let open = true;
    const sorted = [...history].sort(
      (a, b) => new Date(a.at ?? 0).getTime() - new Date(b.at ?? 0).getTime(),
    );
    for (const event of sorted) {
      const at = event.at ? new Date(event.at) : null;
      if (!at || at.getTime() >= endsAt.getTime()) break;
      if (event.status === 'RESOLVED' || event.status === 'IGNORED') open = false;
      else if (event.status === 'OPEN' || event.status === 'ACKNOWLEDGED') open = true;
    }
    return open;
  }
  // Legacy documents without statusHistory.
  return !exception.resolvedAt || new Date(exception.resolvedAt).getTime() >= endsAt.getTime();
}

/**
 * Exceptions still open as of exclusive period end (resolved later still count).
 * Reopening after resolve must not erase earlier closed periods.
 */
export async function getOpenFinancialExceptionCountAsOf(endsAt: Date, session?: ClientSession) {
  const candidates = await FinancialException.find(
    mongoose.trusted({
      firstSeenAt: mongoose.trusted({ $lt: endsAt }),
    }),
  )
    .select('firstSeenAt resolvedAt statusHistory')
    .session(session ?? null)
    .lean();

  let open = 0;
  for (const exception of candidates) {
    if (wasFinancialExceptionOpenAsOf(exception, endsAt)) open += 1;
  }
  return open;
}

export async function ensureAccountingPeriod(periodKey: string, session?: ClientSession) {
  const bounds = periodBounds(periodKey);
  const existing = await AccountingPeriod.findOne({ periodKey }).session(session ?? null);
  if (existing) return existing;
  const [created] = await AccountingPeriod.create(
    [
      {
        periodKey,
        startsAt: bounds.startsAt,
        endsAt: bounds.endsAt,
        status: 'OPEN',
      },
    ],
    session ? { session } : undefined,
  );
  return created;
}

export async function assertDateInOpenPeriod(date: Date, session?: ClientSession) {
  const periodKey = toPeriodKey(date);
  const period = await AccountingPeriod.findOne({ periodKey }).session(session ?? null);
  if (period?.status === 'CLOSED') {
    throw new AppError(
      'ACCOUNTING_PERIOD_CLOSED',
      `Accounting period ${periodKey} is closed; backdated changes are blocked`,
      409,
      false,
      [{ periodKey }],
    );
  }
}

export async function isAccountingPeriodClosed(date: Date, session?: ClientSession) {
  const periodKey = toPeriodKey(date);
  const period = await AccountingPeriod.findOne({ periodKey }).session(session ?? null);
  return period?.status === 'CLOSED';
}

/**
 * Gateway success still credits the customer when the provider period is closed.
 * Collections are assigned to an OPEN recognition period instead of mutating the
 * closed snapshot. Manual callers should keep accountingDate = paymentDate.
 */
export async function resolveGatewayAccountingDate(
  providerCompletedAt: Date | undefined,
  recognizedAt: Date,
  session?: ClientSession,
) {
  const paymentDate = providerCompletedAt ?? recognizedAt;
  const providerPeriodKey = toPeriodKey(paymentDate);
  const lateRecognition = await isAccountingPeriodClosed(paymentDate, session);
  const accountingDate = lateRecognition ? recognizedAt : paymentDate;
  await assertDateInOpenPeriod(accountingDate, session);
  return {
    paymentDate,
    accountingDate,
    lateRecognition,
    providerPeriodKey,
    recognitionPeriodKey: toPeriodKey(recognizedAt),
    accountingPeriodKey: toPeriodKey(accountingDate),
  };
}

async function buildPeriodSnapshot(periodKey: string, session?: ClientSession) {
  const { startsAt, endsAt } = periodBounds(periodKey);
  const withSession = <T extends { session: (s: ClientSession) => T }>(query: T) =>
    session ? query.session(session) : query;

  const [
    collections,
    refunds,
    reversals,
    payouts,
    settlements,
    closingSuspensePaise,
    openExceptionCount,
    liabilityMg,
    inventoryMg,
  ] = await Promise.all([
    withSession(
      Payment.aggregate([
        {
          $match: {
            // Gross original collections: keep once-successful payments even after later refund/reversal.
            status: { $in: ['SUCCESS', 'REFUNDED', 'REVERSED'] },
            accountingDate: { $gte: startsAt, $lt: endsAt },
          },
        },
        {
          $group: {
            _id: null,
            successfulCollectionPaise: { $sum: '$amountPaise' },
            successfulPaymentCount: { $sum: 1 },
          },
        },
      ]),
    ),
    withSession(
      Refund.aggregate([
        {
          $match: {
            status: 'SUCCESS',
            completedAt: { $gte: startsAt, $lt: endsAt },
          },
        },
        {
          $group: {
            _id: null,
            refundCompletedPaise: { $sum: '$amountPaise' },
            refundCount: { $sum: 1 },
          },
        },
      ]),
    ),
    withSession(
      Payment.aggregate([
        {
          $match: {
            status: 'REVERSED',
            reversedAt: { $gte: startsAt, $lt: endsAt },
          },
        },
        {
          $group: {
            _id: null,
            reversalPaise: { $sum: '$amountPaise' },
            reversalCount: { $sum: 1 },
          },
        },
      ]),
    ),
    withSession(
      Payout.aggregate([
        {
          $match: {
            status: 'SUCCESS',
            payoutDate: { $gte: startsAt, $lt: endsAt },
          },
        },
        {
          $group: {
            _id: null,
            payoutPaise: { $sum: '$amountPaise' },
            payoutGoldWeightMg: { $sum: { $ifNull: ['$goldWeightMg', 0] } },
          },
        },
      ]),
    ),
    withSession(
      GatewaySettlement.aggregate([
        {
          $match: {
            settlementDate: { $gte: startsAt, $lt: endsAt },
          },
        },
        {
          $group: {
            _id: null,
            gatewayFeePaise: { $sum: '$gatewayFeePaise' },
            gatewayFeeGstPaise: { $sum: '$gatewayFeeGstPaise' },
            bankSettlementPaise: {
              $sum: {
                $cond: [
                  { $in: ['$status', ['BANK_CONFIRMED', 'CLOSED']] },
                  '$netSettlementPaise',
                  0,
                ],
              },
            },
          },
        },
      ]),
    ),
    getSuspenseBalancePaiseAsOf(endsAt, session),
    getOpenFinancialExceptionCountAsOf(endsAt, session),
    getGoldLiabilityMgAsOf(endsAt, session),
    getPhysicalGoldInventoryMgAsOf(endsAt, session),
  ]);

  const successfulCollectionPaise = Number(collections[0]?.successfulCollectionPaise ?? 0);
  const successfulPaymentCount = Number(collections[0]?.successfulPaymentCount ?? 0);
  const refundCompletedPaise = Number(refunds[0]?.refundCompletedPaise ?? 0);
  const refundCount = Number(refunds[0]?.refundCount ?? 0);
  const reversalPaise = Number(reversals[0]?.reversalPaise ?? 0);
  const reversalCount = Number(reversals[0]?.reversalCount ?? 0);

  const snapshot = {
    successfulCollectionPaise,
    successfulPaymentCount,
    refundCompletedPaise,
    refundCount,
    reversalPaise,
    reversalCount,
    /** Gross collections minus refunds/reversals dated in this period (reporting view). */
    netCollectionMovementPaise:
      successfulCollectionPaise - refundCompletedPaise - reversalPaise,
    payoutPaise: Number(payouts[0]?.payoutPaise ?? 0),
    payoutGoldWeightMg: Number(payouts[0]?.payoutGoldWeightMg ?? 0),
    gatewayFeePaise: Number(settlements[0]?.gatewayFeePaise ?? 0),
    gatewayFeeGstPaise: Number(settlements[0]?.gatewayFeeGstPaise ?? 0),
    bankSettlementPaise: Number(settlements[0]?.bankSettlementPaise ?? 0),
    closingGoldLiabilityMg: Number(liabilityMg),
    closingGoldInventoryMg: Number(inventoryMg),
    closingSuspensePaise: Number(closingSuspensePaise),
    openExceptionCount: Number(openExceptionCount),
  };

  for (const [key, value] of Object.entries(snapshot)) {
    if (!Number.isInteger(value)) {
      throw new AppError(
        'LEDGER_INTEGRITY_ERROR',
        `Period snapshot field ${key} is not an integer`,
        500,
        true,
      );
    }
  }

  return snapshot;
}

export async function closeAccountingPeriod(
  periodKey: string,
  input: { closeNotes?: string; overrideReason?: string },
  context: AuditContext & { actorId: string },
) {
  const bounds = periodBounds(periodKey);
  if (Date.now() < bounds.endsAt.getTime()) {
    throw new AppError(
      'ACCOUNTING_PERIOD_NOT_ENDED',
      `Accounting period ${periodKey} has not ended in ${BUSINESS_TZ}`,
      409,
      false,
      [{ periodKey, endsAt: bounds.endsAt, businessTz: BUSINESS_TZ }],
    );
  }

  return withMongoTransaction(async (session) => {
    const earlierOpen = await AccountingPeriod.findOne(
      mongoose.trusted({
        status: 'OPEN',
        startsAt: mongoose.trusted({ $lt: bounds.startsAt }),
      }),
    ).session(session);
    if (earlierOpen) {
      throw new AppError(
        'EARLIER_PERIOD_OPEN',
        `Close earlier period ${earlierOpen.periodKey} first`,
        409,
      );
    }

    const criticalOpen = await FinancialException.countDocuments(
      mongoose.trusted({
        status: mongoose.trusted({ $in: ['OPEN', 'ACKNOWLEDGED'] }),
        severity: 'CRITICAL',
        firstSeenAt: mongoose.trusted({ $lt: bounds.endsAt }),
      }),
    ).session(session);

    const recordedSettlements = await GatewaySettlement.countDocuments(
      mongoose.trusted({
        status: 'RECORDED',
        settlementDate: mongoose.trusted({
          $gte: bounds.startsAt,
          $lt: bounds.endsAt,
        }),
      }),
    ).session(session);

    const pendingIntents = await PaymentIntent.countDocuments(
      mongoose.trusted({
        status: mongoose.trusted({
          $in: ['INITIATED', 'PENDING', 'PROVIDER_CREATING', 'PROVIDER_CREATE_UNCERTAIN'],
        }),
        createdAt: mongoose.trusted({ $lt: bounds.endsAt }),
      }),
    ).session(session);

    const pendingRefunds = await Refund.countDocuments(
      mongoose.trusted({
        status: mongoose.trusted({ $in: ['INITIATED', 'PENDING', 'REVIEW_REQUIRED'] }),
        requestedAt: mongoose.trusted({ $lt: bounds.endsAt }),
      }),
    ).session(session);

    if (
      (criticalOpen > 0 ||
        recordedSettlements > 0 ||
        pendingIntents > 0 ||
        pendingRefunds > 0) &&
      !input.overrideReason?.trim()
    ) {
      throw new AppError(
        'PERIOD_CLOSE_BLOCKED',
        'Unresolved critical exceptions, unconfirmed settlements, or pending payments/refunds block close; provide overrideReason',
        409,
        false,
        [{ criticalOpen, recordedSettlements, pendingIntents, pendingRefunds }],
      );
    }

    const period = await ensureAccountingPeriod(periodKey, session);
    if (period.status === 'CLOSED') return period;

    const snapshot = await buildPeriodSnapshot(periodKey, session);
    const before = period.toObject();
    if (period.snapshot) {
      if (!period.previousSnapshots) period.previousSnapshots = [];
      period.previousSnapshots.push({
        closedAt: period.closedAt,
        closedBy: period.closedBy,
        closeNotes: period.closeNotes,
        snapshot: period.snapshot,
      });
    }

    period.status = 'CLOSED';
    period.closedAt = new Date();
    period.closedBy = context.actorId;
    period.closeNotes = [input.closeNotes, input.overrideReason].filter(Boolean).join(' | ') || undefined;
    period.snapshot = snapshot;
    period.reopenedAt = undefined;
    period.reopenedBy = undefined;
    period.reopenReason = undefined;
    await period.save({ session });

    await audit(
      session,
      context,
      'ACCOUNTING_PERIOD_CLOSED',
      'AccountingPeriod',
      period._id,
      before,
      period.toObject(),
    );
    return period;
  }, context.requestId ?? 'period-close');
}

export async function reopenAccountingPeriod(
  periodKey: string,
  reason: string,
  context: AuditContext & { actorId: string },
) {
  periodBounds(periodKey);
  if (!reason?.trim()) {
    throw new AppError('VALIDATION_ERROR', 'Reopen reason is required', 422);
  }

  return withMongoTransaction(async (session) => {
    const period = await AccountingPeriod.findOne({ periodKey }).session(session);
    if (!period) throw new AppError('ACCOUNTING_PERIOD_NOT_FOUND', 'Accounting period not found', 404);
    if (period.status !== 'CLOSED') return period;

    const before = period.toObject();
    // Keep snapshot frozen until the next close replaces it.
    period.status = 'OPEN';
    period.reopenedAt = new Date();
    period.reopenedBy = context.actorId;
    period.reopenReason = reason.trim();
    await period.save({ session });

    await audit(
      session,
      context,
      'ACCOUNTING_PERIOD_REOPENED',
      'AccountingPeriod',
      period._id,
      before,
      period.toObject(),
    );
    return period;
  }, context.requestId ?? 'period-reopen');
}

export async function getPeriodSummary(periodKey: string) {
  const bounds = periodBounds(periodKey);
  const period = await AccountingPeriod.findOne({ periodKey }).lean();
  if (period?.status === 'CLOSED' && period.snapshot) {
    return {
      periodKey,
      status: 'CLOSED' as const,
      source: 'SNAPSHOT' as const,
      startsAt: period.startsAt,
      endsAt: period.endsAt,
      closedAt: period.closedAt,
      snapshot: period.snapshot,
      label: 'Operational period summary (not a statutory trial balance)',
    };
  }

  const live = await buildPeriodSnapshot(periodKey);
  return {
    periodKey,
    status: period?.status ?? 'OPEN',
    source: 'LIVE' as const,
    startsAt: bounds.startsAt,
    endsAt: bounds.endsAt,
    snapshot: live,
    label: 'Operational period summary (not a statutory trial balance)',
  };
}

export async function listAccountingPeriods() {
  return AccountingPeriod.find().sort({ startsAt: -1 }).lean();
}
