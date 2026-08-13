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
  GoldRate,
  Notification,
  Payment,
  PaymentIntent,
  Payout,
  SchemeEnrollment,
} from '../models/index.js';
import {
  activeGoldRate,
  getPaymentRules,
  listUnpaidSchemeMonths,
  PAYMENT_QUOTE_TTL_MS,
  previewContributionPayment,
  resolvePaymentPhase,
} from './scheme.service.js';
import { getOwnedCustomer } from './customer-access.service.js';
import { withEnrollmentContract, enrollmentContract } from '../utils/scheme-contract.js';
import { reconcilePaymentIntentStatus } from './gateway.service.js';
import { PAYMENT_INTENT_ACTIVE_ATTEMPT_STATUSES } from '../models/enums.js';
import { isGoldWeightEnabled } from '../config/business.js';
import { usesNakshathraContributionPolicy } from '../utils/contribution-policy.js';
import { schemeMonth } from '../utils/time.js';
import {
  buildInstallmentSchedule,
  summarizeInstallmentSchedule,
} from './installment-schedule.service.js';

async function goldRateForSchemeType(schemeType?: string) {
  if (schemeType === 'GOLD_WEIGHT' || isGoldWeightEnabled()) {
    return activeGoldRate(new Date()).catch(() => null);
  }
  return null;
}

function timeProgressPercent(startDate: Date, maturityDate: Date, at = new Date()) {
  const startedAt = new Date(startDate).getTime();
  const completesAt = new Date(maturityDate).getTime();
  return Math.max(
    0,
    Math.min(100, ((at.getTime() - startedAt) / Math.max(1, completesAt - startedAt)) * 100),
  );
}

async function buildSchemeStatus(scheme: any, currentGoldRate: any | null) {
  const now = new Date();
  const calendarMonth = schemeMonth(scheme.startDate, now);
  const phase = resolvePaymentPhase(scheme, calendarMonth);
  const unpaidMonths = await listUnpaidSchemeMonths(scheme);
  const nextUnpaidMonth = unpaidMonths[0] ?? null;
  const nakshathra = usesNakshathraContributionPolicy(scheme);
  let monthlyCapPaise: number | null = scheme.monthlyInstallmentPaise ?? null;
  let paidInCurrentMonthPaise = 0;
  let remainingCapPaise: number | null = scheme.monthlyInstallmentPaise ?? null;
  let minimumPaymentPaise: number | null = scheme.monthlyInstallmentPaise ?? null;
  let installmentAlreadyPaid = nextUnpaidMonth == null;
  const previewMonth = nakshathra ? calendarMonth : nextUnpaidMonth;

  if (previewMonth != null && previewMonth >= 1 && previewMonth <= (scheme.durationMonths ?? 11)) {
    try {
      const rules = await getPaymentRules(String(scheme._id), now, 0, undefined, {
        enforceLimit: false,
        requireGoldRate: false,
        targetSchemeMonth: nakshathra ? undefined : previewMonth,
      });
      monthlyCapPaise = rules.capPaise;
      paidInCurrentMonthPaise = rules.paidThisMonthPaise;
      remainingCapPaise = rules.remainingPaise;
      minimumPaymentPaise = rules.minimumPaymentPaise;
      installmentAlreadyPaid = rules.installmentAlreadyPaid;
    } catch {
      /* status stays partial when rules are unavailable */
    }
  }

  return {
    schemeId: String(scheme._id),
    schemeName: enrollmentContract(scheme)?.name ?? scheme.schemePlanId?.name ?? null,
    enrollmentNumber: scheme.enrollmentNumber,
    schemeType: scheme.schemeType,
    status: scheme.status,
    schemeMonth: calendarMonth,
    nextUnpaidMonth,
    unpaidMonths,
    durationMonths: scheme.durationMonths,
    contributionMonthCount: 11,
    redemptionMonth: 12,
    phase: phase.phase,
    phaseLabel: phase.phaseLabel,
    flexibleThroughout: phase.flexibleThroughout,
    timeProgressPercent: Math.floor(timeProgressPercent(scheme.startDate, scheme.maturityDate, now)),
    totalPaidPaise: scheme.totalPaidPaise ?? 0,
    totalGoldWeightMg: scheme.totalGoldWeightMg ?? 0,
    monthlyCapPaise,
    paidInCurrentMonthPaise,
    remainingCapPaise,
    minimumPaymentPaise,
    monthlyInstallmentPaise: scheme.monthlyInstallmentPaise,
    installmentAlreadyPaid,
    paymentsCompleted: scheme.paymentsCompleted ?? 0,
    installmentsRemaining: unpaidMonths.length,
    paymentWindowOpen: nakshathra
      ? scheme.status === 'ACTIVE' && calendarMonth >= 1 && calendarMonth <= (scheme.durationMonths ?? 11)
      : scheme.status === 'ACTIVE' && unpaidMonths.length > 0,
    redemptionWindowOpen:
      scheme.schemeType === 'CASH'
        ? ['ACTIVE', 'MATURED'].includes(scheme.status) &&
          now.getTime() >= new Date(scheme.redemptionStartDate).getTime()
        : calendarMonth === 12 && (scheme.paymentsCompleted ?? 0) === 11,
    makingChargeWaiverPercent: scheme.makingChargeWaiverPercent ?? 100,
    gstRateBasisPoints: scheme.gstRateBasisPoints ?? 300,
    currentGoldRate:
      scheme.schemeType === 'GOLD_WEIGHT'
        ? currentGoldRate
          ? {
              ratePerGramPaise: currentGoldRate.ratePerGramPaise,
              purity: currentGoldRate.purity,
              effectiveFrom: currentGoldRate.effectiveFrom,
            }
          : null
        : null,
    startDate: scheme.startDate,
    completionDate: scheme.maturityDate,
    redemptionStartDate: scheme.redemptionStartDate,
    redemptionEndDate: scheme.redemptionEndDate,
  };
}

export async function getCustomerPaymentPreview(
  userId: string,
  schemeId: string,
  amountPaise: number,
  requestedSchemeMonth?: number,
) {
  const customer = await getOwnedCustomer(userId);
  const scheme = await SchemeEnrollment.findOne({
    _id: schemeId,
    customerId: customer._id,
  })
    .populate('schemePlanId')
    .lean();
  if (!scheme) throw new AppError('SCHEME_NOT_FOUND', 'Scheme not found', 404);
  if (scheme.status !== 'ACTIVE')
    throw new AppError('SCHEME_NOT_ACTIVE', 'Scheme is not active', 409);

  const calculatedAt = new Date();
  const quoteExpiresAt = new Date(calculatedAt.getTime() + PAYMENT_QUOTE_TTL_MS);
  const preview = await previewContributionPayment(
    schemeId,
    amountPaise,
    calculatedAt,
    requestedSchemeMonth,
  );
  const unpaidMonths = await listUnpaidSchemeMonths(scheme);
  let goldRateId: string | null = null;
  let goldRatePerGramPaise: number | null = null;
  let goldWeightMg: number | null = null;
  try {
    const rules = await getPaymentRules(schemeId, calculatedAt, amountPaise, undefined, {
      enforceLimit: false,
      requireGoldRate: false,
      targetSchemeMonth: preview.schemeMonth ?? undefined,
    });
    goldRateId = rules.goldRateId ? String(rules.goldRateId) : null;
    goldRatePerGramPaise = rules.goldRatePerGramPaise;
    goldWeightMg = rules.goldWeightMg;
  } catch {
    /* gold quote is optional on CASH preview */
  }

  return {
    enrollmentId: String(scheme._id),
    schemeId: String(scheme._id),
    schemeName: enrollmentContract(scheme)?.name ?? scheme.schemePlanId?.name ?? null,
    schemeType: scheme.schemeType,
    enrollmentNumber: scheme.enrollmentNumber,
    schemeMonth: preview.schemeMonth,
    unpaidMonths,
    nextUnpaidMonth: unpaidMonths[0] ?? null,
    phase: preview.phase,
    phaseLabel:
      preview.phase === 'FLEXIBLE'
        ? 'Flexible contribution month'
        : preview.phase === 'CAPPED'
          ? 'Capped contribution month'
          : 'Not payable',
    flexibleThroughout: false,
    amountPaise,
    requestedAmountPaise: amountPaise,
    minimumPaymentPaise: preview.minimumPaymentPaise,
    monthlyInstallmentPaise: Number(scheme.monthlyInstallmentPaise),
    capApplies: preview.capApplies,
    monthlyCapPaise: preview.monthlyCapPaise,
    paidInCurrentMonthPaise: preview.paidThisMonthPaise,
    paidThisMonthPaise: preview.paidThisMonthPaise,
    remainingCapPaise: preview.remainingPaise,
    remainingPaise: preview.remainingPaise,
    paymentAllowed: preview.allowed,
    allowed: preview.allowed,
    validationMessage: preview.reasonMessage,
    reasonCode: preview.reasonCode,
    reasonMessage: preview.reasonMessage,
    capStrategy: preview.capStrategy,
    purity: '916' as const,
    goldRateId,
    goldRatePerGramPaise,
    goldWeightMg,
    calculatedAt: calculatedAt.toISOString(),
    quoteExpiresAt: quoteExpiresAt.toISOString(),
    totalPaidPaise: scheme.totalPaidPaise ?? 0,
    totalGoldWeightMg: scheme.totalGoldWeightMg ?? 0,
    durationMonths: scheme.durationMonths,
    status: scheme.status,
  };
}

export async function getCustomerHome(userId: string) {
  const customer = await getOwnedCustomer(userId);
  const schemes = await SchemeEnrollment.find({ customerId: customer._id })
    .populate('schemePlanId')
    .sort({ createdAt: -1 })
    .lean();
  const contracted = schemes.map((scheme: any) => withEnrollmentContract(scheme));
  const activeScheme = contracted.find((scheme: any) => scheme.status === 'ACTIVE');
  const currentGoldRate = await goldRateForSchemeType(activeScheme?.schemeType);
  const [recentPayments, activeSchemePayments] = await Promise.all([
    Payment.find({ customerId: customer._id, status: 'SUCCESS' })
      .sort({ paymentDate: -1 })
      .limit(5)
      .lean(),
    activeScheme
      ? Payment.find({ schemeId: activeScheme._id, status: 'SUCCESS' })
          .sort({ paymentDate: -1 })
          .lean()
      : [],
  ]);

  const schemeStatus = activeScheme
    ? await buildSchemeStatus(activeScheme, currentGoldRate)
    : null;
  const installmentSchedule = activeScheme
    ? buildInstallmentSchedule(activeScheme, activeSchemePayments)
    : [];
  const installmentSummary = summarizeInstallmentSchedule(installmentSchedule);

  let paymentRules = null;
  if (schemeStatus) {
    paymentRules = {
      schemeMonth: schemeStatus.schemeMonth,
      phase: schemeStatus.phase,
      phaseLabel: schemeStatus.phaseLabel,
      flexibleThroughout: schemeStatus.flexibleThroughout,
      capPaise: schemeStatus.monthlyCapPaise,
      paidThisMonthPaise: schemeStatus.paidInCurrentMonthPaise,
      remainingPaise: schemeStatus.remainingCapPaise,
      minimumPaymentPaise: schemeStatus.minimumPaymentPaise,
    };
  }

  return {
    customer,
    activeScheme,
    previousSchemes: contracted.filter(
      (scheme: any) => String(scheme._id) !== String(activeScheme?._id),
    ),
    currentGoldRate,
    recentPayments,
    paymentRules,
    schemeStatus,
    installmentSchedule,
    installmentSummary,
  };
}

export async function listCustomerSchemes(userId: string) {
  const customer = await getOwnedCustomer(userId);
  const schemes = await SchemeEnrollment.find({ customerId: customer._id })
    .populate('schemePlanId')
    .sort({ createdAt: -1 })
    .lean();
  const payments = await Payment.find({
    customerId: customer._id,
    status: 'SUCCESS',
  })
    .sort({ paymentDate: -1 })
    .lean();
  const paymentsByScheme = new Map<string, any[]>();
  for (const payment of payments) {
    const key = String(payment.schemeId);
    paymentsByScheme.set(key, [...(paymentsByScheme.get(key) ?? []), payment]);
  }

  return schemes.map((scheme: any) => {
    const installmentSchedule = buildInstallmentSchedule(
      scheme,
      paymentsByScheme.get(String(scheme._id)) ?? [],
    );
    return {
      ...withEnrollmentContract(scheme),
      installmentSchedule,
      installmentSummary: summarizeInstallmentSchedule(installmentSchedule),
    };
  });
}

export async function listCustomerPayments(
  userId: string,
  listQuery: ListQuery,
): Promise<ListPageResult<any>> {
  const customer = await getOwnedCustomer(userId);
  const query = coerceBoundedListQuery(listQuery);
  const sortField = 'paymentDate';
  const baseFilter = { customerId: customer._id };
  const filter = withKeysetFilter(baseFilter, query, sortField);
  const baseQuery = Payment.find(filter);

  if (query.mode === 'cursor') {
    const rows = await baseQuery
      .sort({ [sortField]: -1, _id: -1 })
      .limit(cursorFetchLimit(query))
      .lean();
    return buildCursorPage(
      rows,
      query.limit,
      sortField,
      (row) => new Date(row.paymentDate),
      (row) => row._id,
    );
  }

  const [items, total] = await Promise.all([
    baseQuery
      .sort({ [sortField]: -1, _id: -1 })
      .skip(offsetSkip(query))
      .limit(query.limit)
      .lean(),
    Payment.countDocuments(baseFilter),
  ]);
  return buildOffsetPage(items, total, query.page, query.limit);
}

export async function listCustomerGoldRates(userId: string) {
  if (!isGoldWeightEnabled()) {
    throw new AppError(
      'GOLD_WEIGHT_DISABLED',
      'GOLD_WEIGHT functionality is not enabled for this deployment',
      409,
    );
  }
  await getOwnedCustomer(userId);
  return GoldRate.find({ purity: '916' })
    .select('ratePerGramPaise purity effectiveFrom status notes usageCount')
    .sort({ effectiveFrom: -1 })
    .limit(90)
    .lean();
}

const NON_TERMINAL_INTENT_STATUSES = new Set<string>(PAYMENT_INTENT_ACTIVE_ATTEMPT_STATUSES);

/** Never hammer PhonePe from repeated customer polling, even if nextStatusCheckAt is due. */
const MIN_CUSTOMER_STATUS_CHECK_INTERVAL_MS = 5_000;

function isDueForCustomerStatusCheck(
  intent: { status: string; lastStatusCheckedAt?: Date | null; nextStatusCheckAt?: Date | null },
  now: Date,
) {
  // A launch is actively in flight for this intent — let that flow own the provider call.
  if (intent.status === 'PROVIDER_CREATING') return false;
  const lastCheckedAt = intent.lastStatusCheckedAt ? new Date(intent.lastStatusCheckedAt).getTime() : null;
  if (lastCheckedAt != null && now.getTime() - lastCheckedAt < MIN_CUSTOMER_STATUS_CHECK_INTERVAL_MS) {
    return false;
  }
  const nextCheckAt = intent.nextStatusCheckAt ? new Date(intent.nextStatusCheckAt).getTime() : null;
  if (nextCheckAt != null) return nextCheckAt <= now.getTime();
  return true;
}

/**
 * Authoritative customer status lookup. Ownership is checked before any
 * provider call. For a non-terminal owned intent that is due, this performs a
 * server-side PhonePe reconciliation (throttled) instead of trusting the
 * locally cached status alone — never trusts a client-supplied success flag.
 */
export async function getCustomerPaymentIntent(userId: string, orderId: string, requestId?: string) {
  const customer = await getOwnedCustomer(userId);
  let intent = await PaymentIntent.findOne({
    merchantTransactionId: orderId,
    customerId: customer._id,
  });
  if (!intent) throw new AppError('PAYMENT_INTENT_NOT_FOUND', 'Payment attempt not found', 404);

  if (NON_TERMINAL_INTENT_STATUSES.has(intent.status)) {
    const now = new Date();
    if (isDueForCustomerStatusCheck(intent, now)) {
      try {
        await reconcilePaymentIntentStatus(
          String(intent._id),
          'CUSTOMER_STATUS_CHECK',
          requestId ?? `customer-status:${String(intent._id)}`,
        );
      } catch {
        // Surface last-known state rather than failing the customer's status poll.
      }
      intent = (await PaymentIntent.findById(intent._id)) ?? intent;
    }
  }

  // Only safe, non-sensitive fields — no lastGatewayError / internal review detail.
  const safeIntent = {
    merchantTransactionId: intent.merchantTransactionId,
    status: intent.status,
    expiresAt: intent.expiresAt,
    amountPaise: intent.amountPaise,
    goldRatePerGramPaise: intent.goldRatePerGramPaise,
    goldWeightMg: intent.goldWeightMg,
    goldPurity: intent.goldPurity,
    quoteCreatedAt: intent.quoteCreatedAt,
    checkoutChannel: intent.checkoutChannel,
  };

  const payment =
    intent.status === 'SUCCESS'
      ? await Payment.findOne({
          merchantTransactionId: orderId,
          customerId: customer._id,
        })
          .select(
            '_id receiptNumber amountPaise paymentDate status goldRatePerGramPaise goldWeightMg goldPurity',
          )
          .lean()
      : null;
  return { ...safeIntent, payment };
}

export async function listCustomerPayouts(
  userId: string,
  listQuery: ListQuery,
): Promise<ListPageResult<any>> {
  const customer = await getOwnedCustomer(userId);
  const query = coerceBoundedListQuery(listQuery);
  const sortField = 'payoutDate';
  const baseFilter = { customerId: customer._id };
  const filter = withKeysetFilter(baseFilter, query, sortField);
  const baseQuery = Payout.find(filter);

  if (query.mode === 'cursor') {
    const rows = await baseQuery
      .sort({ [sortField]: -1, _id: -1 })
      .limit(cursorFetchLimit(query))
      .lean();
    return buildCursorPage(
      rows,
      query.limit,
      sortField,
      (row) => new Date(row.payoutDate),
      (row) => row._id,
    );
  }

  const [items, total] = await Promise.all([
    baseQuery
      .sort({ [sortField]: -1, _id: -1 })
      .skip(offsetSkip(query))
      .limit(query.limit)
      .lean(),
    Payout.countDocuments(baseFilter),
  ]);
  return buildOffsetPage(items, total, query.page, query.limit);
}

export async function listCustomerNotifications(
  userId: string,
  listQuery: ListQuery,
): Promise<ListPageResult<any>> {
  const query = coerceBoundedListQuery(listQuery);
  const sortField = 'createdAt';
  const match = { userId };
  const filter = withKeysetFilter(match, query, sortField);
  const baseQuery = Notification.find(filter);

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
    Notification.countDocuments(match),
  ]);
  return buildOffsetPage(items, total, query.page, query.limit);
}

export async function getOwnedSchemeDetails(userId: string, schemeId: string) {
  const customer = await getOwnedCustomer(userId);
  const scheme = await SchemeEnrollment.findOne({
    _id: schemeId,
    customerId: customer._id,
  })
    .populate('schemePlanId')
    .lean();
  if (!scheme) throw new AppError('SCHEME_NOT_FOUND', 'Scheme not found', 404);
  const [payments, payouts, currentGoldRate] = await Promise.all([
    Payment.find({ schemeId: scheme._id }).sort({ paymentDate: -1 }).lean(),
    Payout.find({ schemeId: scheme._id }).sort({ payoutDate: -1 }).lean(),
    goldRateForSchemeType(scheme.schemeType),
  ]);
  const schemeStatus = await buildSchemeStatus(scheme, currentGoldRate);
  const installmentSchedule = buildInstallmentSchedule(scheme, payments);
  return {
    scheme: withEnrollmentContract(scheme),
    payments,
    payouts,
    schemeStatus,
    currentGoldRate,
    installmentSchedule,
    installmentSummary: summarizeInstallmentSchedule(installmentSchedule),
  };
}

export async function getOwnedReceipt(userId: string, paymentId: string) {
  const customer = await getOwnedCustomer(userId);
  const payment = await Payment.findOne({
    _id: paymentId,
    customerId: customer._id,
    status: mongoose.trusted({ $in: ['SUCCESS', 'REVERSED'] }),
  }).lean();
  if (!payment) throw new AppError('RECEIPT_NOT_FOUND', 'Receipt not found', 404);
  return { receiptNumber: payment.receiptNumber, payment };
}
