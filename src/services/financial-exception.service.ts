import {
  DisputeCase,
  FinancialException,
  Notification,
  Payment,
  PaymentIntent,
  Refund,
  SuspenseEntry,
  User,
  type FinancialExceptionAgingBucket,
  type FinancialExceptionSeverity,
  type FinancialExceptionType,
} from '../models/index.js';
import mongoose from 'mongoose';
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
import {
  computeAgingBucket,
  defaultSeverityForType,
  isHigherAgingBucket,
  maxAgingBucket,
  nextReviewAtForBucket,
} from '../utils/financial-aging.js';
import { withMongoTransaction } from '../utils/transaction.js';
import { audit, type AuditContext } from './audit.service.js';
import { logger } from '../config/logger.js';

export type UpsertFinancialExceptionInput = {
  dedupeKey: string;
  type: FinancialExceptionType;
  severity?: FinancialExceptionSeverity;
  title: string;
  description?: string;
  sourceType?: string;
  sourceId?: unknown;
  paymentId?: unknown;
  paymentIntentId?: unknown;
  refundId?: unknown;
  disputeId?: unknown;
  customerId?: unknown;
  schemeId?: unknown;
  amountPaise?: number;
  providerReference?: string;
  metadata?: Record<string, unknown>;
  responseDueAt?: Date | null;
  now?: Date;
};

function titleForType(type: FinancialExceptionType) {
  return type.replaceAll('_', ' ');
}

async function notifyAdminsOfBucketEscalation(
  exception: {
    _id: unknown;
    type: string;
    agingBucket: string;
    severity: string;
    title?: string;
    dedupeKey: string;
  },
  previousBucket: string | undefined,
) {
  const admins = await User.find({ role: 'ADMIN', status: 'ACTIVE' }).select('_id').lean();
  if (!admins.length) return;

  const title = `Financial exception ${exception.agingBucket}`;
  const body = `${exception.title ?? exception.type} moved ${previousBucket ? `from ${previousBucket} ` : ''}to ${exception.agingBucket}`;
  await Notification.insertMany(
    admins.map((admin: { _id: unknown }) => ({
      userId: admin._id,
      type: 'FINANCIAL_EXCEPTION_AGING',
      title,
      body,
      data: {
        exceptionId: exception._id,
        dedupeKey: exception.dedupeKey,
        type: exception.type,
        agingBucket: exception.agingBucket,
        severity: exception.severity,
        previousBucket,
      },
    })),
  );
}

function isVersionError(error: unknown) {
  return Boolean(
    error &&
      typeof error === 'object' &&
      ((error as { name?: string }).name === 'VersionError' ||
        (error as { code?: number }).code === 11000),
  );
}

async function upsertFinancialExceptionOnce(input: UpsertFinancialExceptionInput) {
  const now = input.now ?? new Date();
  const severity = input.severity ?? defaultSeverityForType(input.type);

  let existing = await FinancialException.findOne({ dedupeKey: input.dedupeKey });

  if (!existing) {
    const firstSeenAt = now;
    const agingBucket = computeAgingBucket(input.type, firstSeenAt, now, {
      responseDueAt: input.responseDueAt,
    });
    const draft = {
      dedupeKey: input.dedupeKey,
      type: input.type,
      severity,
      status: 'OPEN' as const,
      title: input.title || titleForType(input.type),
      description: input.description,
      sourceType: input.sourceType,
      sourceId: input.sourceId,
      paymentId: input.paymentId,
      paymentIntentId: input.paymentIntentId,
      refundId: input.refundId,
      disputeId: input.disputeId,
      customerId: input.customerId,
      schemeId: input.schemeId,
      amountPaise: input.amountPaise,
      providerReference: input.providerReference,
      firstSeenAt,
      lastSeenAt: now,
      occurrenceCount: 1,
      agingBucket,
      nextReviewAt: nextReviewAtForBucket(agingBucket, now),
      statusHistory: [{ status: 'OPEN' as const, at: firstSeenAt, note: 'created' }],
      metadata: input.metadata,
    };

    try {
      const [created] = await FinancialException.create([draft]);
      if (agingBucket !== 'NEW') {
        await notifyAdminsOfBucketEscalation(created, undefined);
        created.lastAlertedAt = now;
        await created.save();
        return { exception: created, created: true as const, alerted: true };
      }
      return { exception: created, created: true as const, alerted: false };
    } catch (error: unknown) {
      // Duplicate-key races must refetch outside any failed write session.
      if ((error as { code?: number })?.code === 11000) {
        existing = await FinancialException.findOne({ dedupeKey: input.dedupeKey });
        if (!existing) throw error;
      } else {
        throw error;
      }
    }
  }

  const wasTerminal = existing.status === 'RESOLVED' || existing.status === 'IGNORED';
  if (wasTerminal) {
    // Re-open if the same problem reappears — never erase prior resolvedAt from history.
    existing.status = 'OPEN';
  }

  const rank = { LOW: 0, MEDIUM: 1, HIGH: 2, CRITICAL: 3 } as const;
  const nextSeverity =
    rank[severity] > rank[existing.severity as keyof typeof rank] ? severity : existing.severity;

  const computed = computeAgingBucket(
    existing.type as FinancialExceptionType,
    existing.firstSeenAt,
    now,
    { responseDueAt: input.responseDueAt },
  );
  const previousBucket = existing.agingBucket as FinancialExceptionAgingBucket;
  const nextBucket = maxAgingBucket(previousBucket ?? 'NEW', computed);
  let alerted = false;

  const $set: Record<string, unknown> = {
    status: existing.status,
    lastSeenAt: now,
    severity: nextSeverity,
  };
  if (input.description) $set.description = input.description;
  if (input.title) $set.title = input.title;
  if (input.metadata) $set.metadata = { ...(existing.metadata ?? {}), ...input.metadata };
  if (input.amountPaise != null) $set.amountPaise = input.amountPaise;
  if (input.providerReference) $set.providerReference = input.providerReference;
  if (input.paymentId) $set.paymentId = input.paymentId;
  if (input.paymentIntentId) $set.paymentIntentId = input.paymentIntentId;
  if (input.refundId) $set.refundId = input.refundId;
  if (input.disputeId) $set.disputeId = input.disputeId;
  if (input.customerId) $set.customerId = input.customerId;
  if (input.schemeId) $set.schemeId = input.schemeId;

  // Live pointer fields may clear for UI, but statusHistory keeps immutable resolved moments.
  const $unset: Record<string, 1> = {};
  const historyPush: Array<Record<string, unknown>> = [];
  if (wasTerminal) {
    const history = Array.isArray(existing.statusHistory) ? existing.statusHistory : [];
    const hasResolvedEvent = history.some(
      (event: { status?: string; at?: Date }) =>
        (event.status === 'RESOLVED' || event.status === 'IGNORED') &&
        existing.resolvedAt &&
        event.at &&
        Math.abs(new Date(event.at).getTime() - new Date(existing.resolvedAt).getTime()) < 1000,
    );
    if (existing.resolvedAt && !hasResolvedEvent) {
      historyPush.push({
        status: existing.status === 'IGNORED' ? 'IGNORED' : 'RESOLVED',
        at: existing.resolvedAt,
        actorId: existing.resolvedBy,
        note: existing.resolutionNotes ?? 'legacy_resolution_preserved',
      });
    }
    historyPush.push({
      status: 'OPEN',
      at: now,
      note: 'reopened_by_upsert',
    });
    $unset.resolvedAt = 1;
    $unset.resolvedBy = 1;
    $unset.resolutionNotes = 1;
    $unset.acknowledgedAt = 1;
    $unset.acknowledgedBy = 1;
  }

  if (isHigherAgingBucket(nextBucket, previousBucket)) {
    $set.agingBucket = nextBucket;
    $set.nextReviewAt = nextReviewAtForBucket(nextBucket, now);
  } else if (!existing.nextReviewAt) {
    $set.nextReviewAt = nextReviewAtForBucket(existing.agingBucket ?? 'NEW', now);
  }

  const update: Record<string, unknown> = {
    $set,
    $inc: { occurrenceCount: 1 },
  };
  if (Object.keys($unset).length) update.$unset = $unset;
  if (historyPush.length === 1) {
    update.$push = { statusHistory: historyPush[0] };
  } else if (historyPush.length > 1) {
    update.$push = { statusHistory: { $each: historyPush } };
  }

  // Atomic update avoids optimistic-concurrency collisions under concurrent reporters.
  await FinancialException.updateOne({ _id: existing._id }, update);
  const refreshed = await FinancialException.findById(existing._id);
  if (!refreshed) {
    throw new AppError('FINANCIAL_EXCEPTION_NOT_FOUND', 'Financial exception not found', 404);
  }

  if (isHigherAgingBucket(nextBucket, previousBucket)) {
    await notifyAdminsOfBucketEscalation(refreshed, previousBucket);
    refreshed.lastAlertedAt = now;
    await FinancialException.updateOne(
      { _id: refreshed._id },
      { $set: { lastAlertedAt: now } },
    );
    alerted = true;
  }

  return { exception: refreshed, created: false as const, alerted };
}

export async function upsertFinancialException(input: UpsertFinancialExceptionInput) {
  let lastError: unknown;
  for (let attempt = 0; attempt < 8; attempt++) {
    try {
      return await upsertFinancialExceptionOnce(input);
    } catch (error) {
      lastError = error;
      if (!isVersionError(error)) throw error;
    }
  }
  throw lastError;
}

export async function listFinancialExceptions(
  listQuery: ListQuery,
  filters: {
    status?: string;
    severity?: string;
    type?: string;
    agingBucket?: string;
  } = {},
): Promise<ListPageResult<any>> {
  const query = coerceBoundedListQuery(listQuery);
  const sortField = 'firstSeenAt';
  const baseFilter: Record<string, unknown> = {};
  if (filters.status) baseFilter.status = filters.status;
  if (filters.severity) baseFilter.severity = filters.severity;
  if (filters.type) baseFilter.type = filters.type;
  if (filters.agingBucket) baseFilter.agingBucket = filters.agingBucket;

  const filter = withKeysetFilter(baseFilter, query, sortField);
  const baseQuery = FinancialException.find(filter)
    .populate('customerId', 'customerCode')
    .populate('paymentId', 'receiptNumber status amountPaise')
    .populate('refundId', 'merchantRefundId status amountPaise');

  if (query.mode === 'cursor') {
    const rows = await baseQuery
      .sort({ [sortField]: -1, _id: -1 })
      .limit(cursorFetchLimit(query))
      .lean();
    return buildCursorPage(
      rows,
      query.limit,
      sortField,
      (row) => new Date(row.firstSeenAt),
      (row) => row._id,
    );
  }

  const [items, total] = await Promise.all([
    baseQuery
      .sort({ [sortField]: -1, _id: -1 })
      .skip(offsetSkip(query))
      .limit(query.limit)
      .lean(),
    FinancialException.countDocuments(baseFilter),
  ]);
  return buildOffsetPage(items, total, query.page, query.limit);
}

export async function getFinancialExceptionDetail(id: string) {
  const row = await FinancialException.findById(id)
    .populate('customerId')
    .populate('paymentId')
    .populate('paymentIntentId')
    .populate('refundId')
    .populate('disputeId')
    .populate('acknowledgedBy', 'name phone')
    .populate('resolvedBy', 'name phone')
    .lean();
  if (!row) throw new AppError('FINANCIAL_EXCEPTION_NOT_FOUND', 'Financial exception not found', 404);
  return row;
}

export async function acknowledgeFinancialException(
  id: string,
  context: AuditContext & { actorId: string },
  notes?: string,
) {
  return withMongoTransaction(async (session) => {
    const exception = await FinancialException.findById(id).session(session);
    if (!exception) {
      throw new AppError('FINANCIAL_EXCEPTION_NOT_FOUND', 'Financial exception not found', 404);
    }
    if (exception.status === 'RESOLVED' || exception.status === 'IGNORED') {
      throw new AppError(
        'FINANCIAL_EXCEPTION_CLOSED',
        'Closed exceptions cannot be acknowledged',
        409,
      );
    }

    const before = exception.toObject();
    const now = new Date();
    exception.status = 'ACKNOWLEDGED';
    exception.acknowledgedAt = now;
    exception.acknowledgedBy = context.actorId;
    if (notes) {
      exception.metadata = { ...(exception.metadata ?? {}), acknowledgeNotes: notes };
    }
    exception.statusHistory = [
      ...(exception.statusHistory ?? []),
      { status: 'ACKNOWLEDGED', at: now, actorId: context.actorId, note: notes },
    ];
    await exception.save({ session });
    await audit(
      session,
      context,
      'FINANCIAL_EXCEPTION_ACKNOWLEDGED',
      'FinancialException',
      exception._id,
      before,
      exception.toObject(),
    );
    return exception;
  }, context.requestId ?? 'exception-ack');
}

export async function resolveFinancialException(
  id: string,
  input: { resolutionNotes: string; status?: 'RESOLVED' | 'IGNORED' },
  context: AuditContext & { actorId: string },
) {
  return withMongoTransaction(async (session) => {
    const exception = await FinancialException.findById(id).session(session);
    if (!exception) {
      throw new AppError('FINANCIAL_EXCEPTION_NOT_FOUND', 'Financial exception not found', 404);
    }
    if (exception.status === 'RESOLVED' || exception.status === 'IGNORED') {
      return exception;
    }

    const before = exception.toObject();
    const now = new Date();
    exception.status = input.status ?? 'RESOLVED';
    exception.resolvedAt = now;
    exception.resolvedBy = context.actorId;
    exception.resolutionNotes = input.resolutionNotes.trim();
    exception.statusHistory = [
      ...(exception.statusHistory ?? []),
      {
        status: exception.status,
        at: now,
        actorId: context.actorId,
        note: exception.resolutionNotes,
      },
    ];
    await exception.save({ session });
    await audit(
      session,
      context,
      exception.status === 'IGNORED'
        ? 'FINANCIAL_EXCEPTION_IGNORED'
        : 'FINANCIAL_EXCEPTION_RESOLVED',
      'FinancialException',
      exception._id,
      before,
      exception.toObject(),
    );
    return exception;
  }, context.requestId ?? 'exception-resolve');
}

export async function createSuspenseEntry(
  input: {
    entryType: 'UNMATCHED_CREDIT' | 'UNMATCHED_DEBIT';
    amountPaise: number;
    provider?: string;
    providerReference?: string;
    bankReference?: string;
    transactionDate?: Date;
    description: string;
    source: string;
  },
  context: AuditContext & { actorId: string },
) {
  const entry = await withMongoTransaction(async (session) => {
    const [created] = await SuspenseEntry.create(
      [
        {
          ...input,
          status: 'OPEN',
          createdBy: context.actorId,
        },
      ],
      { session },
    );
    await audit(session, context, 'SUSPENSE_CREATED', 'SuspenseEntry', created._id, undefined, {
      entryType: created.entryType,
      amountPaise: created.amountPaise,
    });
    return created;
  }, context.requestId ?? 'suspense-create');

  const exceptionType =
    input.entryType === 'UNMATCHED_CREDIT'
      ? ('UNMATCHED_EXTERNAL_CREDIT' as const)
      : ('UNMATCHED_EXTERNAL_DEBIT' as const);

  const { exception } = await upsertFinancialException({
    dedupeKey: `suspense:${entry._id}:${exceptionType}`,
    type: exceptionType,
    title: titleForType(exceptionType),
    description: input.description,
    sourceType: 'SuspenseEntry',
    sourceId: entry._id,
    amountPaise: input.amountPaise,
    providerReference: input.providerReference ?? input.bankReference,
    metadata: { source: input.source, provider: input.provider },
  });

  entry.financialExceptionId = exception._id;
  await entry.save();
  return entry;
}

export async function listSuspenseEntries(listQuery: ListQuery): Promise<ListPageResult<any>> {
  const query = coerceBoundedListQuery(listQuery);
  const sortField = 'createdAt';
  const filter = withKeysetFilter({}, query, sortField);
  const baseQuery = SuspenseEntry.find(filter)
    .populate('createdBy', 'name phone')
    .populate('resolvedBy', 'name phone')
    .populate('financialExceptionId', 'status severity agingBucket');

  if (query.mode === 'cursor') {
    const rows = await baseQuery
      .sort({ [sortField]: -1, _id: -1 })
      .limit(cursorFetchLimit(query))
      .lean();
    return buildCursorPage(
      rows,
      query.limit,
      sortField,
      (row) => new Date(row.createdAt),
      (row) => row._id,
    );
  }
  const [items, total] = await Promise.all([
    baseQuery
      .sort({ [sortField]: -1, _id: -1 })
      .skip(offsetSkip(query))
      .limit(query.limit)
      .lean(),
    SuspenseEntry.countDocuments(),
  ]);
  return buildOffsetPage(items, total, query.page, query.limit);
}

/**
 * Resolve suspense without auto-crediting any customer/scheme ledger.
 * Optional payment/refund links are reference-only.
 */
export async function resolveSuspenseEntry(
  id: string,
  input: {
    resolutionNotes: string;
    status?: 'RESOLVED' | 'WRITTEN_OFF';
    resolvedPaymentId?: string;
    resolvedRefundId?: string;
  },
  context: AuditContext & { actorId: string },
) {
  return withMongoTransaction(async (session) => {
    const entry = await SuspenseEntry.findById(id).session(session);
    if (!entry) throw new AppError('SUSPENSE_NOT_FOUND', 'Suspense entry not found', 404);
    if (entry.status !== 'OPEN') return entry;

    const notes = input.resolutionNotes.trim();
    if (!notes) {
      throw new AppError('VALIDATION_ERROR', 'Resolution notes are required', 422);
    }

    if (input.resolvedPaymentId) {
      const payment = await Payment.findById(input.resolvedPaymentId).session(session);
      if (!payment) throw new AppError('PAYMENT_NOT_FOUND', 'Payment not found', 404);
      entry.resolvedPaymentId = payment._id;
    }
    if (input.resolvedRefundId) {
      const refund = await Refund.findById(input.resolvedRefundId).session(session);
      if (!refund) throw new AppError('REFUND_NOT_FOUND', 'Refund not found', 404);
      entry.resolvedRefundId = refund._id;
    }

    const before = entry.toObject();
    const now = new Date();
    entry.status = input.status ?? 'RESOLVED';
    entry.resolvedAt = now;
    entry.resolvedBy = context.actorId;
    entry.resolutionNotes = notes;
    await entry.save({ session });

    if (entry.financialExceptionId) {
      await FinancialException.updateOne(
        mongoose.trusted({
          _id: entry.financialExceptionId,
          status: mongoose.trusted({ $in: ['OPEN', 'ACKNOWLEDGED'] }),
        }),
        {
          $set: {
            status: 'RESOLVED',
            resolvedAt: now,
            resolvedBy: context.actorId,
            resolutionNotes: notes,
          },
          $push: {
            statusHistory: {
              status: 'RESOLVED',
              at: now,
              actorId: context.actorId,
              note: notes,
            },
          },
        },
        { session },
      );
    }

    await audit(
      session,
      context,
      'SUSPENSE_RESOLVED',
      'SuspenseEntry',
      entry._id,
      before,
      entry.toObject(),
    );
    return entry;
  }, context.requestId ?? 'suspense-resolve');
}

export async function createDisputeCase(
  input: {
    paymentId: string;
    providerCaseId?: string;
    amountPaise?: number;
    reasonCode?: string;
    reason: string;
    detectedVia: string;
    notifiedAt?: Date;
    responseDueAt?: Date;
    evidenceNotes?: string;
  },
  context: AuditContext & { actorId: string },
) {
  const payment = await Payment.findById(input.paymentId);
  if (!payment) throw new AppError('PAYMENT_NOT_FOUND', 'Payment not found', 404);
  if (!payment.merchantTransactionId) {
    throw new AppError(
      'DISPUTE_REQUIRES_GATEWAY_PAYMENT',
      'Disputes require an existing gateway payment',
      409,
    );
  }

  const paymentSnapshot = {
    status: payment.status,
    amountPaise: payment.amountPaise,
    goldWeightMg: payment.goldWeightMg,
  };
  const amountPaise = input.amountPaise ?? payment.amountPaise;

  const dispute = await withMongoTransaction(async (session) => {
    const [created] = await DisputeCase.create(
      [
        {
          paymentId: payment._id,
          customerId: payment.customerId,
          schemeId: payment.schemeId,
          provider: 'PHONEPE',
          providerCaseId: input.providerCaseId,
          amountPaise,
          reasonCode: input.reasonCode,
          reason: input.reason.trim(),
          status: 'OPEN',
          detectedVia: input.detectedVia,
          notifiedAt: input.notifiedAt,
          responseDueAt: input.responseDueAt,
          evidenceNotes: input.evidenceNotes,
          createdBy: context.actorId,
        },
      ],
      { session },
    );

    await audit(session, context, 'DISPUTE_CREATED', 'DisputeCase', created._id, undefined, {
      paymentId: payment._id,
      amountPaise,
    });
    return created;
  }, context.requestId ?? 'dispute-create');

  // Opening a dispute must not mutate payment status or gold ledger.
  const refreshedPayment = await Payment.findById(payment._id);
  if (
    !refreshedPayment ||
    refreshedPayment.status !== paymentSnapshot.status ||
    refreshedPayment.amountPaise !== paymentSnapshot.amountPaise ||
    refreshedPayment.goldWeightMg !== paymentSnapshot.goldWeightMg
  ) {
    throw new AppError(
      'LEDGER_INTEGRITY_ERROR',
      'Dispute creation must not mutate payment or gold',
      500,
      true,
    );
  }

  const { exception } = await upsertFinancialException({
    dedupeKey: `dispute:${dispute._id}:CHARGEBACK_REPORTED`,
    type: 'CHARGEBACK_REPORTED',
    title: 'Chargeback / dispute reported',
    description: input.reason,
    sourceType: 'DisputeCase',
    sourceId: dispute._id,
    paymentId: payment._id,
    disputeId: dispute._id,
    customerId: payment.customerId,
    schemeId: payment.schemeId,
    amountPaise,
    providerReference: input.providerCaseId ?? payment.merchantTransactionId,
    responseDueAt: input.responseDueAt,
    metadata: { detectedVia: input.detectedVia, paymentSnapshot },
  });

  dispute.financialExceptionId = exception._id;
  await dispute.save();
  return dispute;
}

export async function listDisputeCases(listQuery: ListQuery): Promise<ListPageResult<any>> {
  const query = coerceBoundedListQuery(listQuery);
  const sortField = 'createdAt';
  const filter = withKeysetFilter({}, query, sortField);
  const baseQuery = DisputeCase.find(filter)
    .populate('paymentId', 'receiptNumber status amountPaise merchantTransactionId')
    .populate('customerId', 'customerCode')
    .populate('createdBy', 'name phone');

  if (query.mode === 'cursor') {
    const rows = await baseQuery
      .sort({ [sortField]: -1, _id: -1 })
      .limit(cursorFetchLimit(query))
      .lean();
    return buildCursorPage(
      rows,
      query.limit,
      sortField,
      (row) => new Date(row.createdAt),
      (row) => row._id,
    );
  }
  const [items, total] = await Promise.all([
    baseQuery
      .sort({ [sortField]: -1, _id: -1 })
      .skip(offsetSkip(query))
      .limit(query.limit)
      .lean(),
    DisputeCase.countDocuments(),
  ]);
  return buildOffsetPage(items, total, query.page, query.limit);
}

export async function getDisputeCaseDetail(id: string) {
  const row = await DisputeCase.findById(id)
    .populate('paymentId')
    .populate('customerId')
    .populate('schemeId', 'enrollmentNumber status')
    .populate('createdBy', 'name phone')
    .populate('updatedBy', 'name phone')
    .populate('financialExceptionId')
    .lean();
  if (!row) throw new AppError('DISPUTE_NOT_FOUND', 'Dispute case not found', 404);
  return row;
}

export async function updateDisputeCase(
  id: string,
  input: {
    status?: string;
    providerCaseId?: string;
    reasonCode?: string;
    reason?: string;
    evidenceNotes?: string;
    resolutionReference?: string;
    responseDueAt?: Date;
    notifiedAt?: Date;
  },
  context: AuditContext & { actorId: string },
) {
  const dispute = await withMongoTransaction(async (session) => {
    const row = await DisputeCase.findById(id).session(session);
    if (!row) throw new AppError('DISPUTE_NOT_FOUND', 'Dispute case not found', 404);

    const before = row.toObject();
    const paymentBefore = await Payment.findById(row.paymentId).session(session);
    const goldBefore = paymentBefore
      ? {
          status: paymentBefore.status,
          amountPaise: paymentBefore.amountPaise,
          goldWeightMg: paymentBefore.goldWeightMg,
        }
      : null;

    if (input.status) row.status = input.status;
    if (input.providerCaseId !== undefined) row.providerCaseId = input.providerCaseId;
    if (input.reasonCode !== undefined) row.reasonCode = input.reasonCode;
    if (input.reason !== undefined) row.reason = input.reason;
    if (input.evidenceNotes !== undefined) row.evidenceNotes = input.evidenceNotes;
    if (input.resolutionReference !== undefined) {
      row.resolutionReference = input.resolutionReference;
    }
    if (input.responseDueAt !== undefined) row.responseDueAt = input.responseDueAt;
    if (input.notifiedAt !== undefined) row.notifiedAt = input.notifiedAt;

    if (['WON', 'LOST', 'CLOSED'].includes(String(row.status)) && !row.resolvedAt) {
      row.resolvedAt = new Date();
    }
    row.updatedBy = context.actorId;
    await row.save({ session });

    if (goldBefore && paymentBefore) {
      const paymentAfter = await Payment.findById(row.paymentId).session(session);
      if (
        !paymentAfter ||
        paymentAfter.status !== goldBefore.status ||
        paymentAfter.amountPaise !== goldBefore.amountPaise ||
        paymentAfter.goldWeightMg !== goldBefore.goldWeightMg
      ) {
        throw new AppError(
          'LEDGER_INTEGRITY_ERROR',
          'Dispute update must not mutate payment or gold',
          500,
          true,
        );
      }
    }

    await audit(
      session,
      context,
      'DISPUTE_UPDATED',
      'DisputeCase',
      row._id,
      before,
      row.toObject(),
    );
    return row;
  }, context.requestId ?? 'dispute-update');

  if (dispute.status === 'LOST') {
    await upsertFinancialException({
      dedupeKey: `dispute:${dispute._id}:CHARGEBACK_REPORTED`,
      type: 'CHARGEBACK_REPORTED',
      title: 'Chargeback lost — manual financial resolution required',
      description:
        'Dispute marked LOST. Do not silently change customer gold; resolve via approved workflow.',
      sourceType: 'DisputeCase',
      sourceId: dispute._id,
      paymentId: dispute.paymentId,
      disputeId: dispute._id,
      customerId: dispute.customerId,
      schemeId: dispute.schemeId,
      amountPaise: dispute.amountPaise,
      providerReference: dispute.providerCaseId,
      responseDueAt: dispute.responseDueAt,
      metadata: { disputeStatus: 'LOST', requiresManualResolution: true },
      severity: 'CRITICAL',
    });
  } else if (dispute.financialExceptionId || dispute.status === 'OPEN') {
    await upsertFinancialException({
      dedupeKey: `dispute:${dispute._id}:CHARGEBACK_REPORTED`,
      type: 'CHARGEBACK_REPORTED',
      title: 'Chargeback / dispute reported',
      description: dispute.reason,
      sourceType: 'DisputeCase',
      sourceId: dispute._id,
      paymentId: dispute.paymentId,
      disputeId: dispute._id,
      customerId: dispute.customerId,
      schemeId: dispute.schemeId,
      amountPaise: dispute.amountPaise,
      providerReference: dispute.providerCaseId,
      responseDueAt: dispute.responseDueAt,
    });
  }

  return dispute;
}

/** Convert recovery markers into financial exceptions (idempotent via dedupeKey). */
export async function reportPaymentIntentException(
  intent: {
    _id: unknown;
    customerId?: unknown;
    schemeId?: unknown;
    amountPaise?: number;
    merchantTransactionId?: string;
    lastGatewayError?: string | null;
  },
  type: FinancialExceptionType,
  description?: string,
) {
  try {
    return await upsertFinancialException({
      dedupeKey: `payment-intent:${intent._id}:${type}`,
      type,
      title: titleForType(type),
      description: description ?? intent.lastGatewayError ?? type,
      sourceType: 'PaymentIntent',
      sourceId: intent._id,
      paymentIntentId: intent._id,
      customerId: intent.customerId,
      schemeId: intent.schemeId,
      amountPaise: intent.amountPaise,
      providerReference: intent.merchantTransactionId,
      metadata: { lastGatewayError: intent.lastGatewayError },
    });
  } catch (error) {
    logger.error({ err: error, intentId: intent._id, type }, 'failed to upsert payment exception');
    return null;
  }
}

export async function reportRefundException(
  refund: {
    _id: unknown;
    paymentId?: unknown;
    customerId?: unknown;
    schemeId?: unknown;
    amountPaise?: number;
    merchantRefundId?: string;
  },
  type: FinancialExceptionType,
  description?: string,
  metadata?: Record<string, unknown>,
) {
  try {
    return await upsertFinancialException({
      dedupeKey: `refund:${refund._id}:${type}`,
      type,
      title: titleForType(type),
      description: description ?? type,
      sourceType: 'Refund',
      sourceId: refund._id,
      refundId: refund._id,
      paymentId: refund.paymentId,
      customerId: refund.customerId,
      schemeId: refund.schemeId,
      amountPaise: refund.amountPaise,
      providerReference: refund.merchantRefundId,
      metadata,
    });
  } catch (error) {
    logger.error({ err: error, refundId: refund._id, type }, 'failed to upsert refund exception');
    return null;
  }
}

export async function reportOutboxException(
  event: {
    _id: unknown;
    type: string;
    attempts?: number;
    lastError?: string | null;
    payload?: Record<string, unknown>;
  },
  description?: string,
) {
  try {
    return await upsertFinancialException({
      dedupeKey: `outbox:${event._id}:OUTBOX_DELIVERY_FAILED`,
      type: 'OUTBOX_DELIVERY_FAILED',
      title: titleForType('OUTBOX_DELIVERY_FAILED'),
      description: description ?? event.lastError ?? 'Outbox delivery exhausted retries',
      sourceType: 'OutboxEvent',
      sourceId: event._id,
      metadata: {
        outboxType: event.type,
        attempts: event.attempts,
        lastError: event.lastError,
        payloadKeys: event.payload ? Object.keys(event.payload) : [],
      },
    });
  } catch (error) {
    logger.error({ err: error, outboxEventId: event._id }, 'failed to upsert outbox exception');
    return null;
  }
}

export async function ageOpenFinancialExceptions(now = new Date(), limit = 200) {
  const open = await FinancialException.find(
    mongoose.trusted({
      status: mongoose.trusted({ $in: ['OPEN', 'ACKNOWLEDGED'] }),
      $or: [
        { nextReviewAt: null },
        { nextReviewAt: mongoose.trusted({ $exists: false }) },
        { nextReviewAt: mongoose.trusted({ $lte: now }) },
      ],
    }),
  )
    .sort({ nextReviewAt: 1, firstSeenAt: 1 })
    .limit(limit);


  let updated = 0;
  let alerted = 0;

  for (const exception of open) {
    let responseDueAt: Date | null | undefined;
    if (exception.disputeId) {
      const dispute = await DisputeCase.findById(exception.disputeId).select('responseDueAt').lean();
      responseDueAt = dispute?.responseDueAt;
    }

    const computed = computeAgingBucket(
      exception.type as FinancialExceptionType,
      exception.firstSeenAt,
      now,
      { responseDueAt },
    );
    const previous = exception.agingBucket as FinancialExceptionAgingBucket;
    const next = maxAgingBucket(previous ?? 'NEW', computed);
    if (next !== previous && isHigherAgingBucket(next, previous)) {
      exception.agingBucket = next;
      exception.nextReviewAt = nextReviewAtForBucket(next, now);
      await exception.save();
      await notifyAdminsOfBucketEscalation(exception, previous);
      exception.lastAlertedAt = now;
      await exception.save();
      updated += 1;
      alerted += 1;
    } else if (!exception.nextReviewAt || exception.nextReviewAt <= now) {
      exception.nextReviewAt = nextReviewAtForBucket(exception.agingBucket ?? 'NEW', now);
      await exception.save();
      updated += 1;
    }
  }

  return { updated, alerted };
}

export async function syncExceptionsFromMarkers(now = new Date()) {
  let created = 0;

  const mismatchedIntents = await PaymentIntent.find(
    mongoose.trusted({
      lastGatewayError: 'GATEWAY_AMOUNT_MISMATCH',
      status: mongoose.trusted({ $in: ['INITIATED', 'PENDING'] }),
    }),
  ).limit(100);
  for (const intent of mismatchedIntents) {
    const result = await reportPaymentIntentException(
      intent,
      'PAYMENT_AMOUNT_MISMATCH',
      'PhonePe amount does not match payment intent',
    );
    if (result?.created) created += 1;
  }

  const pendingTooLong = await PaymentIntent.find(
    mongoose.trusted({
      lastGatewayError: 'PAYMENT_PENDING_TOO_LONG',
      status: mongoose.trusted({ $in: ['INITIATED', 'PENDING'] }),
    }),
  ).limit(100);
  for (const intent of pendingTooLong) {
    const result = await reportPaymentIntentException(intent, 'PAYMENT_PENDING_TOO_LONG');
    if (result?.created) created += 1;
  }

  const refundsPending = await Refund.find(
    mongoose.trusted({
      status: mongoose.trusted({ $in: ['INITIATED', 'PENDING'] }),
      'lastProviderResponse.marker': 'REFUND_PENDING_TOO_LONG',
    }),
  ).limit(100);
  for (const refund of refundsPending) {
    const result = await reportRefundException(refund, 'REFUND_PENDING_TOO_LONG');
    if (result?.created) created += 1;
  }

  const refundMismatches = await Refund.find(
    mongoose.trusted({
      status: mongoose.trusted({ $in: ['INITIATED', 'PENDING'] }),
      'lastProviderResponse.marker': 'GATEWAY_AMOUNT_MISMATCH',
    }),
  ).limit(100);
  for (const refund of refundMismatches) {
    const result = await reportRefundException(refund, 'REFUND_AMOUNT_MISMATCH');
    if (result?.created) created += 1;
  }

  const failedRefunds = await Refund.find({ status: 'FAILED' }).limit(100);
  for (const refund of failedRefunds) {
    const result = await reportRefundException(
      refund,
      'REFUND_FAILED',
      refund.providerErrorCode ?? 'Provider failed refund',
    );
    if (result?.created) created += 1;
  }

  void now;
  return { created };
}

/** Used by assert paths that need an exception without failing the caller. */
export async function reportBlockedRefundException(
  payment: {
    _id: unknown;
    customerId?: unknown;
    schemeId?: unknown;
    amountPaise?: number;
    merchantTransactionId?: string;
  },
  reason: string,
) {
  return upsertFinancialException({
    dedupeKey: `payment:${payment._id}:REFUND_BLOCKED_AFTER_REDEMPTION`,
    type: 'REFUND_BLOCKED_AFTER_REDEMPTION',
    title: 'Refund blocked after redemption',
    description: reason,
    sourceType: 'Payment',
    sourceId: payment._id,
    paymentId: payment._id,
    customerId: payment.customerId,
    schemeId: payment.schemeId,
    amountPaise: payment.amountPaise,
    providerReference: payment.merchantTransactionId,
  });
}
