import mongoose from 'mongoose';
import {
  Customer,
  Payment,
  PaymentCorrection,
  PaymentIntent,
  Payout,
  Refund,
  SchemeEnrollment,
  User,
} from '../models/index.js';
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
  buildInstallmentSchedule,
  summarizeInstallmentSchedule,
  type InstallmentScheduleItem,
  type InstallmentStatus,
} from './installment-schedule.service.js';
import {
  buildContributionStatus,
  buildContributionStatusMap,
  contributionListFields,
} from './contribution-status.service.js';
import {
  aggregateEnrollmentLedger,
  aggregateEnrollmentLedgerFromRecords,
  type EnrollmentLedger,
} from '../utils/enrollment-ledger.js';
import { withEnrollmentContract } from '../utils/scheme-contract.js';
import {
  collectSettlementBlockersFromState,
  SETTLEMENT_BLOCKING_INTENT_STATUSES,
  type SettlementActivityFlags,
} from './scheme-settlement.service.js';
import { resolveSettlementPolicy } from '../utils/payment-window.js';
import { AppError } from '../utils/AppError.js';

const SCAN_BATCH = 50;

export function escapeRegex(input: string) {
  return input.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export type EnrollmentListFilters = {
  status?: string;
  schemePlanId?: string;
  customerId?: string;
  schemeType?: string;
  search?: string;
  startDateFrom?: Date;
  startDateTo?: Date;
  maturityFrom?: Date;
  maturityTo?: Date;
  installmentStatus?: InstallmentStatus;
  redemptionReady?: boolean;
  prematureClosureEligible?: boolean;
  paymentsCompletedMin?: number;
  paymentsCompletedMax?: number;
};

function objectIdOrThrow(value: string, label: string) {
  if (!mongoose.isValidObjectId(value)) {
    throw new AppError('VALIDATION_ERROR', `${label} is not a valid id`, 422);
  }
  return new mongoose.Types.ObjectId(value);
}

async function customerIdsMatchingSearch(search: string) {
  const rx = new RegExp(escapeRegex(search), 'i');
  const users = await User.find(
    mongoose.trusted({
      role: 'CUSTOMER',
      $or: [{ name: rx }, { phone: rx }],
    }),
  )
    .select('_id')
    .lean();
  const customers = await Customer.find(
    mongoose.trusted({
      userId: mongoose.trusted({ $in: users.map((user: { _id: unknown }) => user._id) }),
    }),
  )
    .select('_id')
    .lean();
  return customers.map((row: { _id: unknown }) => row._id);
}

export async function enrollmentMongoFilter(filters: EnrollmentListFilters = {}) {
  const match: Record<string, unknown> = {};
  if (filters.status) match.status = filters.status;
  if (filters.schemePlanId) match.schemePlanId = objectIdOrThrow(filters.schemePlanId, 'schemePlanId');
  if (filters.customerId) match.customerId = objectIdOrThrow(filters.customerId, 'customerId');
  if (filters.schemeType) match.schemeType = filters.schemeType;
  if (filters.startDateFrom || filters.startDateTo) {
    match.startDate = mongoose.trusted({
      ...(filters.startDateFrom ? { $gte: filters.startDateFrom } : {}),
      ...(filters.startDateTo ? { $lte: filters.startDateTo } : {}),
    });
  }
  if (filters.maturityFrom || filters.maturityTo) {
    match.maturityDate = mongoose.trusted({
      ...(filters.maturityFrom ? { $gte: filters.maturityFrom } : {}),
      ...(filters.maturityTo ? { $lte: filters.maturityTo } : {}),
    });
  }
  if (filters.paymentsCompletedMin != null || filters.paymentsCompletedMax != null) {
    match.paymentsCompleted = mongoose.trusted({
      ...(filters.paymentsCompletedMin != null ? { $gte: filters.paymentsCompletedMin } : {}),
      ...(filters.paymentsCompletedMax != null ? { $lte: filters.paymentsCompletedMax } : {}),
    });
  }
  if (filters.search?.trim()) {
    const search = filters.search.trim();
    const customerIds = await customerIdsMatchingSearch(search);
    match.$or = [
      { enrollmentNumber: new RegExp(escapeRegex(search), 'i') },
      { customerId: mongoose.trusted({ $in: customerIds }) },
    ];
  }
  return match;
}

async function paymentsByEnrollment(ids: unknown[]) {
  if (!ids.length) return new Map<string, any[]>();
  const payments = await Payment.find(
    mongoose.trusted({
      schemeId: mongoose.trusted({ $in: ids }),
      status: 'SUCCESS',
    }),
  )
    .select('schemeId schemeMonth status paymentDate amountPaise receiptNumber goldWeightMg')
    .lean();
  const map = new Map<string, any[]>();
  for (const payment of payments) {
    const key = String(payment.schemeId);
    map.set(key, [...(map.get(key) ?? []), payment]);
  }
  return map;
}

function populateEnrollmentQuery(filter: Record<string, unknown>) {
  return SchemeEnrollment.find(filter)
    .populate({
      path: 'customerId',
      populate: { path: 'userId', select: 'name phone' },
    })
    .populate(
      'schemePlanId',
      'name type status minimumPaymentPaise durationMonths makingChargeWaiverPercent gstRateBasisPoints',
    );
}

function customerPayload(enrollment: any) {
  const customer = enrollment.customerId;
  const user = customer?.userId;
  return {
    id: customer?._id ? String(customer._id) : null,
    name: user?.name ?? null,
    phone: user?.phone ?? null,
  };
}

function planPayload(enrollment: any) {
  const plan = enrollment.schemePlanId;
  return {
    id: plan?._id ? String(plan._id) : String(enrollment.schemePlanId ?? ''),
    name: plan?.name ?? enrollment.planSnapshot?.name ?? null,
  };
}

export function getEnrollmentInstallmentState(
  enrollment: any,
  payments: any[],
  at = new Date(),
) {
  const schedule = buildInstallmentSchedule(enrollment, payments, at);
  const summary = summarizeInstallmentSchedule(schedule);
  return { schedule, summary };
}

export function overdueSummaryFromSchedule(enrollment: any, schedule: InstallmentScheduleItem[]) {
  const overdue = schedule.filter((item) => item.status === 'OVERDUE');
  const next = schedule.find((item) => item.status === 'OVERDUE' || item.status === 'DUE') ?? null;
  const oldest = overdue.reduce<InstallmentScheduleItem | null>((current, item) => {
    if (!current) return item;
    return item.daysOverdue > current.daysOverdue ? item : current;
  }, null);
  return {
    enrollmentId: String(enrollment._id),
    enrollmentNumber: enrollment.enrollmentNumber,
    customer: customerPayload(enrollment),
    schemePlan: planPayload(enrollment),
    monthlyInstallmentPaise: enrollment.monthlyInstallmentPaise,
    overdueInstallments: overdue.map((item) => ({
      schemeMonth: item.schemeMonth,
      amountPaise: item.amountPaise,
      dueDate: item.dueDate,
      paymentWindowStartDate: item.paymentWindowStartDate,
      paymentWindowEndDate: item.paymentWindowEndDate,
      daysOverdue: item.daysOverdue,
    })),
    overdueCount: overdue.length,
    totalOverduePaise: overdue.reduce((sum, item) => sum + item.amountPaise, 0),
    oldestOverdueDate: oldest?.dueDate ?? null,
    oldestDaysOverdue: oldest?.daysOverdue ?? 0,
    nextPayableSchemeMonth: next?.schemeMonth ?? null,
  };
}

export function dueSummaryFromSchedule(enrollment: any, schedule: InstallmentScheduleItem[]) {
  const due = schedule.filter((item) => item.status === 'DUE');
  const overdue = schedule.filter((item) => item.status === 'OVERDUE');
  const next = schedule.find((item) => item.status === 'OVERDUE' || item.status === 'DUE') ?? null;
  return due.map((item) => ({
    enrollmentId: String(enrollment._id),
    enrollmentNumber: enrollment.enrollmentNumber,
    customer: customerPayload(enrollment),
    schemePlan: planPayload(enrollment),
    schemeMonth: item.schemeMonth,
    amountPaise: item.amountPaise,
    dueDate: item.dueDate,
    paymentWindowStartDate: item.paymentWindowStartDate,
    paymentWindowEndDate: item.paymentWindowEndDate,
    hasOlderOverdue: overdue.length > 0,
    overdueCount: overdue.length,
    nextPayableSchemeMonth: next?.schemeMonth ?? item.schemeMonth,
  }));
}

type EligibilityState = {
  customer: { kycStatus?: string } | null;
  ledger: EnrollmentLedger;
  activity: SettlementActivityFlags;
};

type ScanBatchContext = {
  paymentsByScheme: Map<string, any[]>;
  eligibilityByScheme: Map<string, EligibilityState>;
};

function groupBySchemeId(rows: any[]) {
  const map = new Map<string, any[]>();
  for (const row of rows) {
    const key = String(row.schemeId);
    map.set(key, [...(map.get(key) ?? []), row]);
  }
  return map;
}

async function loadScanBatchContext(enrollments: any[]): Promise<ScanBatchContext> {
  const ids = enrollments.map((row) => row._id);
  const customerIds = [
    ...new Set(
      enrollments.map((row) =>
        String(row.customerId?._id ?? row.customerId ?? ''),
      ),
    ),
  ].filter(Boolean);
  const emptyPayments = new Map<string, any[]>();
  const emptyEligibility = new Map<string, EligibilityState>();
  if (!ids.length) {
    return { paymentsByScheme: emptyPayments, eligibilityByScheme: emptyEligibility };
  }

  const [payments, payouts, pendingRefunds, blockingIntents, customers] = await Promise.all([
    Payment.find(mongoose.trusted({ schemeId: mongoose.trusted({ $in: ids }) }))
      .select(
        'schemeId schemeMonth status paymentDate amountPaise receiptNumber goldWeightMg refundStatus',
      )
      .lean(),
    Payout.find(mongoose.trusted({ schemeId: mongoose.trusted({ $in: ids }) }))
      .select('schemeId status amountPaise settlementPrincipalPaise goldWeightMg')
      .lean(),
    Refund.find(
      mongoose.trusted({
        schemeId: mongoose.trusted({ $in: ids }),
        status: mongoose.trusted({ $in: ['INITIATED', 'PENDING', 'REVIEW_REQUIRED'] }),
      }),
    )
      .select('schemeId')
      .lean(),
    PaymentIntent.find(
      mongoose.trusted({
        schemeId: mongoose.trusted({ $in: ids }),
        status: mongoose.trusted({ $in: [...SETTLEMENT_BLOCKING_INTENT_STATUSES] }),
      }),
    )
      .select('schemeId')
      .lean(),
    Customer.find(mongoose.trusted({ _id: mongoose.trusted({ $in: customerIds }) }))
      .select('_id kycStatus')
      .lean(),
  ]);

  const paymentIds = payments.map((row: { _id: unknown }) => row._id);
  const pendingCorrections = paymentIds.length
    ? await PaymentCorrection.find(
        mongoose.trusted({
          paymentId: mongoose.trusted({ $in: paymentIds }),
          status: 'PENDING',
        }),
      )
        .select('paymentId')
        .lean()
    : [];

  const paymentsByScheme = groupBySchemeId(payments);
  const payoutsByScheme = groupBySchemeId(payouts);
  const refundsByScheme = groupBySchemeId(pendingRefunds);
  const intentsByScheme = groupBySchemeId(blockingIntents);
  const customerById = new Map(
    customers.map((row: { _id: unknown; kycStatus?: string }) => [String(row._id), row]),
  );
  const paymentIdToScheme = new Map<string, string>();
  for (const row of payments as Array<{ _id?: unknown; schemeId?: unknown }>) {
    paymentIdToScheme.set(String(row._id), String(row.schemeId));
  }
  const correctionsByScheme = new Map<string, unknown[]>();
  for (const correction of pendingCorrections) {
    const schemeId = paymentIdToScheme.get(String((correction as { paymentId?: unknown }).paymentId));
    if (!schemeId) continue;
    correctionsByScheme.set(schemeId, [...(correctionsByScheme.get(schemeId) ?? []), correction]);
  }

  const eligibilityByScheme = new Map<string, EligibilityState>();
  for (const enrollment of enrollments) {
    const schemeId = String(enrollment._id);
    const schemePayments = paymentsByScheme.get(schemeId) ?? [];
    const schemePayouts = payoutsByScheme.get(schemeId) ?? [];
    const customerId = String(enrollment.customerId?._id ?? enrollment.customerId);
    const populatedCustomer =
      enrollment.customerId && typeof enrollment.customerId === 'object'
        ? enrollment.customerId
        : null;
    eligibilityByScheme.set(schemeId, {
      customer: populatedCustomer ?? customerById.get(customerId) ?? null,
      ledger: aggregateEnrollmentLedgerFromRecords(schemeId, schemePayments, schemePayouts),
      activity: {
        pendingRefundOnPayment: schemePayments.find(
          (row: { refundStatus?: string }) =>
            row.refundStatus === 'PENDING' || row.refundStatus === 'REVIEW_REQUIRED',
        ),
        pendingRefund: refundsByScheme.get(schemeId)?.[0],
        blockingIntent: intentsByScheme.get(schemeId)?.[0],
        pendingCorrection: correctionsByScheme.get(schemeId)?.[0],
        successPayout: schemePayouts.find((row: { status?: string }) => row.status === 'SUCCESS'),
      },
    });
  }

  const successPaymentsByScheme = new Map<string, any[]>();
  for (const [schemeId, rows] of paymentsByScheme) {
    successPaymentsByScheme.set(
      schemeId,
      rows.filter((row: { status?: string }) => row.status === 'SUCCESS'),
    );
  }

  return { paymentsByScheme: successPaymentsByScheme, eligibilityByScheme };
}

function isRedemptionReadyFromState(
  enrollment: any,
  state: EligibilityState,
  at = new Date(),
) {
  const blockers = collectSettlementBlockersFromState({
    kind: 'REDEEM',
    enrollment,
    customer: state.customer,
    ledger: state.ledger,
    policy: resolveSettlementPolicy(enrollment),
    at,
    activity: state.activity,
  });
  return blockers.length === 0;
}

function isPrematureEligibleFromState(
  enrollment: any,
  state: EligibilityState,
  at = new Date(),
) {
  const blockers = collectSettlementBlockersFromState({
    kind: 'PREMATURE_CLOSE',
    enrollment,
    customer: state.customer,
    ledger: state.ledger,
    policy: resolveSettlementPolicy(enrollment),
    at,
    activity: state.activity,
  });
  return blockers.length === 0;
}

type ScanSort = 'oldest' | 'newest' | 'highestAmount';

function sortSpec(sort: ScanSort): { field: string; direction: 1 | -1 } {
  if (sort === 'newest') return { field: 'startDate', direction: -1 };
  if (sort === 'highestAmount') return { field: 'monthlyInstallmentPaise', direction: -1 };
  return { field: 'startDate', direction: 1 };
}

function afterCursorFilter(
  base: Record<string, unknown>,
  cursor: { field: string; value: unknown; id: mongoose.Types.ObjectId } | null,
  direction: 1 | -1,
) {
  if (!cursor) return base;
  const cmp = direction === 1 ? '$gt' : '$lt';
  return {
    ...base,
    $and: [
      ...(Array.isArray(base.$and) ? base.$and : []),
      {
        $or: [
          { [cursor.field]: mongoose.trusted({ [cmp]: cursor.value }) },
          {
            [cursor.field]: cursor.value,
            _id: mongoose.trusted({ [cmp]: cursor.id }),
          },
        ],
      },
    ],
  };
}

function decodeScanCursor(raw: string | null) {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as {
      field: string;
      value: string;
      id: string;
    };
    return {
      field: parsed.field,
      value: parsed.field === 'monthlyInstallmentPaise' ? Number(parsed.value) : new Date(parsed.value),
      id: new mongoose.Types.ObjectId(parsed.id),
    };
  } catch {
    throw new AppError('INVALID_CURSOR', 'Pagination cursor is invalid or expired', 422);
  }
}

function encodeScanCursor(field: string, value: unknown, id: unknown) {
  const serialized = value instanceof Date ? value.toISOString() : String(value);
  return Buffer.from(
    JSON.stringify({ field, value: serialized, id: String(id) }),
    'utf8',
  ).toString('base64url');
}

async function scanEnrollments<T>(input: {
  match: Record<string, unknown>;
  listQuery: ListQuery;
  sort?: ScanSort;
  at?: Date;
  mapRow: (
    enrollment: any,
    schedule: InstallmentScheduleItem[],
    ctx: ScanBatchContext,
  ) => T[] | T | null;
}) {
  const at = input.at ?? new Date();
  const sort = input.sort ?? 'oldest';
  const { field, direction } = sortSpec(sort);
  const listQuery = coerceBoundedListQuery(input.listQuery);
  const limit = listQuery.limit;
  const page = listQuery.mode === 'offset' ? listQuery.page : 1;
  const skip = listQuery.mode === 'offset' ? (page - 1) * limit : 0;
  let cursor = listQuery.mode === 'cursor' ? decodeScanCursor(listQuery.cursor) : null;
  const collected: T[] = [];
  let scannedPastSkip = 0;
  let lastEnrollment: any = null;
  let exhausted = false;

  while (collected.length < limit && !exhausted) {
    const filter = afterCursorFilter(input.match, cursor, direction);
    const batch = await populateEnrollmentQuery(filter)
      .sort({ [field]: direction, _id: direction })
      .limit(SCAN_BATCH)
      .lean();
    if (!batch.length) {
      exhausted = true;
      break;
    }
    const ctx = await loadScanBatchContext(batch);
    for (const enrollment of batch) {
      lastEnrollment = enrollment;
      cursor = { field, value: enrollment[field], id: enrollment._id };
      const { schedule } = getEnrollmentInstallmentState(
        enrollment,
        ctx.paymentsByScheme.get(String(enrollment._id)) ?? [],
        at,
      );
      const mapped = input.mapRow(enrollment, schedule, ctx);
      const rows = mapped == null ? [] : Array.isArray(mapped) ? mapped : [mapped];
      if (!rows.length) continue;
      for (const row of rows) {
        if (scannedPastSkip < skip) {
          scannedPastSkip += 1;
          continue;
        }
        collected.push(row);
        if (collected.length >= limit) break;
      }
      if (collected.length >= limit) break;
    }
    if (batch.length < SCAN_BATCH) exhausted = true;
  }

  const hasMore = collected.length >= limit && !exhausted;
  const nextCursor =
    hasMore && lastEnrollment
      ? encodeScanCursor(field, lastEnrollment[field], lastEnrollment._id)
      : null;
  return {
    items: collected,
    meta:
      listQuery.mode === 'offset'
        ? { mode: 'offset' as const, page, limit, total: collected.length + skip + (hasMore ? 1 : 0) }
        : { mode: 'cursor' as const, limit, nextCursor, hasMore },
  };
}

async function countScannedEnrollments(input: {
  match: Record<string, unknown>;
  sort?: ScanSort;
  at?: Date;
  include: (
    enrollment: any,
    schedule: InstallmentScheduleItem[],
    ctx: ScanBatchContext,
  ) => boolean;
}) {
  const at = input.at ?? new Date();
  const sort = input.sort ?? 'oldest';
  const { field, direction } = sortSpec(sort);
  let cursor: { field: string; value: unknown; id: mongoose.Types.ObjectId } | null = null;
  let count = 0;
  let exhausted = false;

  while (!exhausted) {
    const filter = afterCursorFilter(input.match, cursor, direction);
    const batch = await populateEnrollmentQuery(filter)
      .sort({ [field]: direction, _id: direction })
      .limit(SCAN_BATCH)
      .lean();
    if (!batch.length) break;

    const ctx = await loadScanBatchContext(batch);
    for (const enrollment of batch) {
      cursor = { field, value: enrollment[field], id: enrollment._id };
      const { schedule } = getEnrollmentInstallmentState(
        enrollment,
        ctx.paymentsByScheme.get(String(enrollment._id)) ?? [],
        at,
      );
      if (input.include(enrollment, schedule, ctx)) count += 1;
    }
    if (batch.length < SCAN_BATCH) exhausted = true;
  }

  return count;
}

async function buildRedemptionReadyMatch(filters: EnrollmentListFilters = {}, now = new Date()) {
  const match = await enrollmentMongoFilter(filters);
  match.status = mongoose.trusted({ $in: ['ACTIVE', 'MATURED'] });
  match.redemptionStartDate = mongoose.trusted({ $lte: now });
  return match;
}

/** Same eligibility as GET /admin/enrollments/redemption-ready — for dashboard KPIs. */
export async function countRedemptionReadyEnrollments(
  filters: EnrollmentListFilters = {},
  at = new Date(),
) {
  const match = await buildRedemptionReadyMatch(filters, at);
  return countScannedEnrollments({
    match,
    sort: 'oldest',
    at,
    include: (enrollment, _schedule, ctx) => {
      const state = ctx.eligibilityByScheme.get(String(enrollment._id));
      return Boolean(state && isRedemptionReadyFromState(enrollment, state, at));
    },
  });
}

export async function listOverdueEnrollments(
  listQuery: ListQuery,
  filters: EnrollmentListFilters & { minDaysOverdue?: number; maxDaysOverdue?: number; sort?: ScanSort } = {},
  at = new Date(),
) {
  const match = await enrollmentMongoFilter({
    ...filters,
    status: filters.status ?? 'ACTIVE',
  });
  const result = await scanEnrollments({
    match,
    listQuery,
    sort: filters.sort ?? 'oldest',
    at,
    mapRow: (enrollment, schedule) => {
      const summary = overdueSummaryFromSchedule(enrollment, schedule);
      if (!summary.overdueCount) return null;
      if (filters.minDaysOverdue != null && summary.oldestDaysOverdue < filters.minDaysOverdue) {
        return null;
      }
      if (filters.maxDaysOverdue != null && summary.oldestDaysOverdue > filters.maxDaysOverdue) {
        return null;
      }
      return summary;
    },
  });
  const contributionMap = await buildContributionStatusMap(
    result.items.map((row) => String(row.enrollmentId)),
    at,
  );
  return {
    items: result.items.map((row) => ({
      ...row,
      contribution: contributionMap.get(String(row.enrollmentId)) ?? null,
    })),
    meta: result.meta,
  };
}

export async function listDueEnrollments(
  listQuery: ListQuery,
  filters: EnrollmentListFilters & { sort?: ScanSort } = {},
  at = new Date(),
) {
  const match = await enrollmentMongoFilter({
    ...filters,
    status: filters.status ?? 'ACTIVE',
  });
  const result = await scanEnrollments({
    match,
    listQuery,
    sort: filters.sort ?? 'oldest',
    at,
    mapRow: (enrollment, schedule) => {
      const rows = dueSummaryFromSchedule(enrollment, schedule);
      return rows.length ? rows : null;
    },
  });
  const contributionMap = await buildContributionStatusMap(
    result.items.map((row) => String(row.enrollmentId)),
    at,
  );
  return {
    items: result.items.map((row) => ({
      ...row,
      ...contributionListFields(contributionMap.get(String(row.enrollmentId))),
    })),
    meta: result.meta,
  };
}

export async function listRedemptionReadyEnrollments(
  listQuery: ListQuery,
  filters: EnrollmentListFilters = {},
) {
  const now = new Date();
  const match = await buildRedemptionReadyMatch(filters, now);
  const result = await scanEnrollments({
    match,
    listQuery,
    sort: 'oldest',
    at: now,
    mapRow: (enrollment, _schedule, ctx) => {
      const state = ctx.eligibilityByScheme.get(String(enrollment._id));
      if (!state || !isRedemptionReadyFromState(enrollment, state, now)) return null;
      const policy = resolveSettlementPolicy(enrollment);
      return {
        enrollmentId: String(enrollment._id),
        enrollmentNumber: enrollment.enrollmentNumber,
        customer: customerPayload(enrollment),
        schemePlan: planPayload(enrollment),
        paymentsCompleted: state.ledger.paymentsCompleted,
        availablePaise: state.ledger.availablePaise,
        availableGoldWeightMg: state.ledger.availableGoldWeightMg,
        redemptionStartDate: enrollment.redemptionStartDate,
        redemptionEndDate: enrollment.redemptionEndDate,
        allowedSettlementAssets: policy.maturitySettlementAssets,
      };
    },
  });
  const contributionMap = await buildContributionStatusMap(
    result.items.map((row) => String(row.enrollmentId)),
    now,
  );
  return {
    items: result.items.map((row) => ({
      ...row,
      contribution: contributionMap.get(String(row.enrollmentId)) ?? null,
    })),
    meta: result.meta,
  };
}

export async function listEnrollmentsFiltered(
  listQuery: ListQuery,
  filters: EnrollmentListFilters = {},
): Promise<ListPageResult<any>> {
  const query = coerceBoundedListQuery(listQuery);
  const needsScan = Boolean(
    filters.installmentStatus ||
      filters.redemptionReady != null ||
      filters.prematureClosureEligible != null,
  );
  const match = await enrollmentMongoFilter(filters);
  if (needsScan) {
    const now = new Date();
    const result = await scanEnrollments({
      match,
      listQuery: query,
      sort: 'newest',
      at: now,
      mapRow: (enrollment, schedule, ctx) => {
        if (
          filters.installmentStatus &&
          !schedule.some((item) => item.status === filters.installmentStatus)
        ) {
          return null;
        }
        const state = ctx.eligibilityByScheme.get(String(enrollment._id));
        if (filters.redemptionReady != null) {
          const ready = Boolean(state && isRedemptionReadyFromState(enrollment, state, now));
          if (ready !== filters.redemptionReady) return null;
        }
        if (filters.prematureClosureEligible != null) {
          const eligible = Boolean(state && isPrematureEligibleFromState(enrollment, state, now));
          if (eligible !== filters.prematureClosureEligible) return null;
        }
        const { summary } = getEnrollmentInstallmentState(
          enrollment,
          ctx.paymentsByScheme.get(String(enrollment._id)) ?? [],
          now,
        );
        return {
          ...withEnrollmentContract(enrollment),
          installmentSchedule: schedule,
          installmentSummary: summary,
        };
      },
    });
    const contributionMap = await buildContributionStatusMap(
      result.items.map((item) => String(item._id)),
      now,
    );
    return {
      items: result.items.map((item) => ({
        ...item,
        contribution: contributionMap.get(String(item._id)) ?? null,
      })),
      meta: result.meta,
    };
  }

  const sortField = 'createdAt';
  const filter = withKeysetFilter(match, query, sortField);
  const baseQuery = populateEnrollmentQuery(filter);
  let items: any[];
  let meta: ListPageResult<any>['meta'];
  if (query.mode === 'cursor') {
    const rows = await baseQuery
      .sort({ [sortField]: -1, _id: -1 })
      .limit(cursorFetchLimit(query))
      .lean();
    ({ items, meta } = buildCursorPage(
      rows,
      query.limit,
      sortField,
      (row: any) => new Date(row.createdAt),
      (row: any) => row._id,
    ));
  } else {
    const [rows, total] = await Promise.all([
      baseQuery
        .sort({ [sortField]: -1, _id: -1 })
        .skip(offsetSkip(query))
        .limit(query.limit)
        .lean(),
      SchemeEnrollment.countDocuments(match),
    ]);
    ({ items, meta } = buildOffsetPage(rows, total, query.page, query.limit));
  }
  const payments = await paymentsByEnrollment(items.map((item) => item._id));
  const contributionMap = await buildContributionStatusMap(
    items.filter((item) => item.status === 'ACTIVE').map((item) => String(item._id)),
  );
  return {
    items: items.map((item) => {
      const { schedule, summary } = getEnrollmentInstallmentState(
        item,
        payments.get(String(item._id)) ?? [],
      );
      const contribution = contributionMap.get(String(item._id)) ?? null;
      return {
        ...withEnrollmentContract(item),
        installmentSchedule: schedule,
        installmentSummary: summary,
        contribution,
      };
    }),
    meta,
  };
}

export async function assertEnrollmentUnusedForCancel(enrollmentId: string, session?: mongoose.ClientSession) {
  const enrollment = await SchemeEnrollment.findById(enrollmentId).session(session ?? null);
  if (!enrollment) throw new AppError('SCHEME_NOT_FOUND', 'Enrollment not found', 404);
  if (enrollment.status !== 'ACTIVE') {
    throw new AppError(
      'ENROLLMENT_CANCELLATION_REQUIRES_SETTLEMENT',
      'Only unused active enrollments can be cancelled',
      409,
    );
  }
  if (enrollment.settlementLockUntil && enrollment.settlementLockUntil.getTime() > Date.now()) {
    throw new AppError(
      'ENROLLMENT_CANCELLATION_REQUIRES_SETTLEMENT',
      'This enrollment has an active settlement lock',
      409,
    );
  }
  const ledger = await aggregateEnrollmentLedger(String(enrollment._id), session);
  if (ledger.totalPaidPaise > 0 || ledger.totalGoldWeightMg > 0 || ledger.paymentsCompleted > 0) {
    throw new AppError(
      'ENROLLMENT_CANCELLATION_REQUIRES_SETTLEMENT',
      'This enrollment has financial activity and must be settled instead',
      409,
    );
  }
  const [successPayment, intent, refund, payout] = await Promise.all([
    Payment.findOne({ schemeId: enrollment._id, status: 'SUCCESS' }).session(session ?? null).select('_id'),
    PaymentIntent.findOne(
      mongoose.trusted({
        schemeId: enrollment._id,
        status: mongoose.trusted({
          $in: ['INITIATED', 'PROVIDER_CREATING', 'PROVIDER_CREATE_UNCERTAIN', 'PENDING', 'REVIEW_REQUIRED'],
        }),
      }),
    )
      .session(session ?? null)
      .select('_id'),
    Refund.findOne({ schemeId: enrollment._id }).session(session ?? null).select('_id'),
    Payout.findOne({ schemeId: enrollment._id }).session(session ?? null).select('_id'),
  ]);
  if (successPayment || intent || refund || payout) {
    throw new AppError(
      'ENROLLMENT_CANCELLATION_REQUIRES_SETTLEMENT',
      'This enrollment has financial or gateway activity and must be settled instead',
      409,
    );
  }
  return { enrollment, ledger };
}

export type MaturityCalendarFilters = {
  from?: Date;
  to?: Date;
  status?: string[];
  schemeType?: string;
};

export type MaturityCalendarEntry = {
  enrollmentId: string;
  enrollmentNumber: string;
  customer: { id: string | null; name: string | null; phone: string | null };
  schemePlan: { id: string; name: string | null; type: string | null };
  schemeType: string;
  status: string;
  startDate: Date;
  maturityDate: Date;
  redemptionStartDate: Date | null;
  redemptionEndDate: Date | null;
  totalPaidPaise: number;
  monthlyInstallmentPaise: number;
  durationMonths: number;
};

const DEFAULT_MATURITY_CALENDAR_STATUSES = ['ACTIVE', 'MATURED'] as const;

function mapMaturityCalendarEntry(enrollment: any): MaturityCalendarEntry {
  const plan = enrollment.schemePlanId;
  return {
    enrollmentId: String(enrollment._id),
    enrollmentNumber: enrollment.enrollmentNumber,
    customer: customerPayload(enrollment),
    schemePlan: {
      ...planPayload(enrollment),
      type: plan?.type ?? enrollment.schemeType ?? null,
    },
    schemeType: enrollment.schemeType,
    status: enrollment.status,
    startDate: enrollment.startDate,
    maturityDate: enrollment.maturityDate,
    redemptionStartDate: enrollment.redemptionStartDate ?? null,
    redemptionEndDate: enrollment.redemptionEndDate ?? null,
    totalPaidPaise: Number(enrollment.totalPaidPaise ?? 0),
    monthlyInstallmentPaise: Number(enrollment.monthlyInstallmentPaise ?? 0),
    durationMonths: Number(enrollment.durationMonths ?? 0),
  };
}

export async function listMaturityCalendar(
  filters: MaturityCalendarFilters = {},
  options: { raw?: boolean } = {},
) {
  const from = filters.from ?? new Date();
  const to = filters.to ?? new Date(from.getTime() + 366 * 86_400_000);
  const statuses = filters.status?.length ? filters.status : [...DEFAULT_MATURITY_CALENDAR_STATUSES];
  const match: Record<string, unknown> = {
    maturityDate: mongoose.trusted({ $gte: from, $lte: to }),
    status: mongoose.trusted({ $in: statuses }),
  };
  if (filters.schemeType) {
    match.schemeType = filters.schemeType;
  }
  const rows = await populateEnrollmentQuery(match)
    .sort({ maturityDate: 1, _id: 1 })
    .lean();
  return {
    from,
    to,
    items: options.raw ? rows : rows.map(mapMaturityCalendarEntry),
  };
}
