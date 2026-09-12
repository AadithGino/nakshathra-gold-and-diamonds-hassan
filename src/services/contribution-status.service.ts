import mongoose, { type ClientSession } from 'mongoose';
import { Payment, SchemeEnrollment } from '../models/index.js';
import { AppError } from '../utils/AppError.js';
import {
  averageSuccessfulPaymentCapPaise,
  financiallyValidSuccessMatch,
  flexibleMonthCount,
  resolveContributionPhase,
  type ContributionPhase,
  type ContributionPolicySource,
} from '../utils/contribution-policy.js';
import { schemeMonth } from '../utils/time.js';
import {
  getPaymentRules,
  PAYMENT_QUOTE_TTL_MS,
  previewContributionPayment,
  type ContributionPaymentPreview,
} from './scheme.service.js';

export type ContributionStatus = {
  schemeMonth: number | null;
  phase: ContributionPhase | 'REDEMPTION';
  phaseLabel: string;
  minimumPaymentPaise: number;
  monthlyCapPaise: number | null;
  capPaise: number | null;
  paidThisMonthPaise: number;
  remainingCapPaise: number | null;
  remainingPaise: number | null;
  capApplies: boolean;
  capStrategy: string | null;
  firstPeriodEmpty: boolean;
  computedAverageCapPaise: number | null;
  installmentAlreadyPaid: boolean;
  totalContributedPaise?: number;
  calculatedAt: string;
};

export type ContributionPhaseCounts = {
  flexible: number;
  capped: number;
  redemption: number;
};

async function sumFirstPeriodPayments(
  schemeId: string,
  enrollment: ContributionPolicySource,
  session?: ClientSession,
) {
  const flexibleMonths = flexibleMonthCount(enrollment);
  const rows = await Payment.aggregate([
    {
      $match: financiallyValidSuccessMatch(schemeId, {
        schemeMonth: mongoose.trusted({ $gte: 1, $lte: flexibleMonths }),
      }),
    },
    { $group: { _id: null, total: { $sum: '$amountPaise' }, count: { $sum: 1 } } },
  ]).session(session ?? null);
  return { totalPaise: rows[0]?.total ?? 0, count: rows[0]?.count ?? 0 };
}

export async function computeFirstPeriodAverageCapPaise(
  schemeId: string,
  enrollment: ContributionPolicySource,
  session?: ClientSession,
): Promise<number | null> {
  const firstPeriod = await sumFirstPeriodPayments(schemeId, enrollment, session);
  if (firstPeriod.count === 0) return null;
  return averageSuccessfulPaymentCapPaise(firstPeriod.totalPaise, firstPeriod.count);
}

export function mapRulesToContributionStatus(
  rules: Awaited<ReturnType<typeof getPaymentRules>>,
  opts: {
    totalContributedPaise?: number;
    calculatedAt?: Date;
    computedAverageCapPaise?: number | null;
  } = {},
): ContributionStatus {
  const monthlyCap = rules.capPaise ?? null;
  const remaining = rules.remainingPaise ?? null;
  return {
    schemeMonth: rules.schemeMonth,
    phase: rules.phase,
    phaseLabel: rules.phaseLabel,
    minimumPaymentPaise: rules.minimumPaymentPaise,
    monthlyCapPaise: monthlyCap,
    capPaise: monthlyCap,
    paidThisMonthPaise: rules.paidThisMonthPaise,
    remainingCapPaise: remaining,
    remainingPaise: remaining,
    capApplies: rules.capApplies,
    capStrategy: rules.capStrategy,
    firstPeriodEmpty: rules.firstPeriodEmpty,
    computedAverageCapPaise: opts.computedAverageCapPaise ?? monthlyCap,
    installmentAlreadyPaid: rules.installmentAlreadyPaid,
    ...(opts.totalContributedPaise != null
      ? { totalContributedPaise: opts.totalContributedPaise }
      : {}),
    calculatedAt: (opts.calculatedAt ?? new Date()).toISOString(),
  };
}

function redemptionContributionStatus(
  enrollment: ContributionPolicySource & {
    startDate: Date | string;
    totalPaidPaise?: number | null;
    monthlyInstallmentPaise?: number;
  },
  at: Date,
): ContributionStatus {
  const startDate = new Date(enrollment.startDate);
  const month = schemeMonth(startDate, at);
  const phaseInfo = resolveContributionPhase(enrollment, month);
  const minimumPaymentPaise = Number(enrollment.monthlyInstallmentPaise ?? 0);
  return {
    schemeMonth: month,
    phase: 'REDEMPTION',
    phaseLabel: phaseInfo.phaseLabel,
    minimumPaymentPaise,
    monthlyCapPaise: null,
    capPaise: null,
    paidThisMonthPaise: 0,
    remainingCapPaise: null,
    remainingPaise: null,
    capApplies: false,
    capStrategy: 'AVERAGE_SUCCESSFUL_PAYMENT_FIRST_6',
    firstPeriodEmpty: false,
    computedAverageCapPaise: null,
    installmentAlreadyPaid: true,
    totalContributedPaise: Number(enrollment.totalPaidPaise ?? 0),
    calculatedAt: at.toISOString(),
  };
}

export async function buildContributionStatus(
  schemeId: string,
  at = new Date(),
): Promise<ContributionStatus | null> {
  const enrollment = await SchemeEnrollment.findById(schemeId).lean();
  if (!enrollment) return null;

  const calendarMonth = schemeMonth(enrollment.startDate, at);
  const phaseInfo = resolveContributionPhase(enrollment, calendarMonth);
  if (phaseInfo.phase === 'REDEMPTION') {
    return redemptionContributionStatus(enrollment, at);
  }
  if (enrollment.status !== 'ACTIVE') return null;

  try {
    const [rules, computedAverageCapPaise] = await Promise.all([
      getPaymentRules(String(schemeId), at, 0, undefined, {
        enforceLimit: false,
        requireGoldRate: false,
      }),
      computeFirstPeriodAverageCapPaise(String(schemeId), enrollment),
    ]);
    return mapRulesToContributionStatus(rules, {
      totalContributedPaise: Number(enrollment.totalPaidPaise ?? 0),
      calculatedAt: at,
      computedAverageCapPaise,
    });
  } catch (error) {
    if (error instanceof AppError && error.code === 'SCHEME_MATURED') {
      return redemptionContributionStatus(enrollment, at);
    }
    throw error;
  }
}

export async function buildContributionStatusMap(
  enrollmentIds: string[],
  at = new Date(),
): Promise<Map<string, ContributionStatus>> {
  const unique = [...new Set(enrollmentIds.filter(Boolean))];
  const entries = await Promise.all(
    unique.map(async (id) => [id, await buildContributionStatus(id, at)] as const),
  );
  const map = new Map<string, ContributionStatus>();
  for (const [id, status] of entries) {
    if (status) map.set(id, status);
  }
  return map;
}

export function contributionPhaseBucket(
  enrollment: ContributionPolicySource & { status?: string; startDate: Date | string },
  at = new Date(),
): keyof ContributionPhaseCounts | null {
  if (enrollment.status !== 'ACTIVE') return null;
  const month = schemeMonth(new Date(enrollment.startDate), at);
  const { phase } = resolveContributionPhase(enrollment, month);
  if (phase === 'FLEXIBLE') return 'flexible';
  if (phase === 'CAPPED') return 'capped';
  if (phase === 'REDEMPTION') return 'redemption';
  return null;
}

export async function countContributionPhaseCounts(at = new Date()): Promise<ContributionPhaseCounts> {
  const enrollments = await SchemeEnrollment.find({ status: 'ACTIVE' })
    .select('startDate status flexibleMonths capMonths capStrategy planSnapshot durationMonths schemeType')
    .lean();
  const counts: ContributionPhaseCounts = { flexible: 0, capped: 0, redemption: 0 };
  for (const enrollment of enrollments) {
    const bucket = contributionPhaseBucket(enrollment, at);
    if (bucket) counts[bucket] += 1;
  }
  return counts;
}

export function buildSchemeSummaryFromEnrollment(enrollment: Record<string, any> | null) {
  if (!enrollment) return null;
  return {
    enrollmentId: String(enrollment._id),
    enrollmentNumber: enrollment.enrollmentNumber,
    schemeName: enrollment.schemeName ?? enrollment.schemePlanId?.name ?? null,
    schemeType: enrollment.schemeType,
    status: enrollment.status,
    startDate: enrollment.startDate,
    maturityDate: enrollment.maturityDate,
    monthlyInstallmentPaise: enrollment.monthlyInstallmentPaise,
    totalContributedPaise: enrollment.totalPaidPaise ?? 0,
    durationMonths: enrollment.durationMonths,
    flexibleMonths: enrollment.flexibleMonths,
    capMonths: enrollment.capMonths,
  };
}

export async function previewAdminContributionPayment(
  schemeId: string,
  amountPaise: number,
  paymentDate = new Date(),
  requestedSchemeMonth?: number,
) {
  const calculatedAt = paymentDate;
  const quoteExpiresAt = new Date(calculatedAt.getTime() + PAYMENT_QUOTE_TTL_MS);
  const preview = await previewContributionPayment(
    schemeId,
    amountPaise,
    calculatedAt,
    requestedSchemeMonth,
  );
  return formatAdminPaymentPreview(schemeId, preview, calculatedAt, quoteExpiresAt);
}

export function formatAdminPaymentPreview(
  schemeId: string,
  preview: ContributionPaymentPreview,
  calculatedAt: Date,
  quoteExpiresAt = new Date(calculatedAt.getTime() + PAYMENT_QUOTE_TTL_MS),
) {
  return {
    enrollmentId: schemeId,
    schemeId,
    schemeMonth: preview.schemeMonth,
    phase: preview.phase,
    phaseLabel:
      preview.phase === 'FLEXIBLE'
        ? 'Flexible contribution month'
        : preview.phase === 'CAPPED'
          ? 'Capped contribution month'
          : 'Not payable',
    requestedAmountPaise: preview.requestedAmountPaise,
    minimumPaymentPaise: preview.minimumPaymentPaise,
    monthlyCapPaise: preview.monthlyCapPaise,
    paidThisMonthPaise: preview.paidThisMonthPaise,
    remainingCapPaise: preview.remainingPaise,
    remainingPaise: preview.remainingPaise,
    capApplies: preview.capApplies,
    capStrategy: preview.capStrategy,
    allowed: preview.allowed,
    paymentAllowed: preview.allowed,
    reasonCode: preview.reasonCode,
    reasonMessage: preview.reasonMessage,
    calculatedAt: calculatedAt.toISOString(),
    quoteExpiresAt: quoteExpiresAt.toISOString(),
  };
}

export function contributionListFields(status: ContributionStatus | undefined) {
  if (!status) return {};
  return {
    phase: status.phase,
    phaseLabel: status.phaseLabel,
    schemeMonth: status.schemeMonth,
    monthlyCapPaise: status.monthlyCapPaise,
    remainingCapPaise: status.remainingCapPaise,
    paidThisMonthPaise: status.paidThisMonthPaise,
    capApplies: status.capApplies,
  };
}
