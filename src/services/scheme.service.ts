import mongoose, { type ClientSession } from 'mongoose';
import { addMonths } from 'date-fns';
import { fromZonedTime, toZonedTime } from 'date-fns-tz';
import { NAKSHATHRA_MINIMUM_PAYMENT_PAISE } from '../config/business.js';
import { AppError } from '../utils/AppError.js';
import { paise } from '../utils/money.js';
import { GoldRate, Payment, SchemeEnrollment } from '../models/index.js';
import { BUSINESS_TZ, businessDayRange, schemeMonth } from '../utils/time.js';
import {
  averageSuccessfulPaymentCapPaise,
  contributionSchemeMonth,
  durationMonthCount,
  financiallyValidSuccessMatch,
  flexibleMonthCount,
  previewPhase,
  resolveContributionPhase,
  usesNakshathraContributionPolicy,
  type ContributionPhase,
} from '../utils/contribution-policy.js';

export const PAYMENT_QUOTE_TTL_MS = 15 * 60_000;

export type PaymentPhase = ContributionPhase;

export function resolvePaymentPhase(
  enrollment: {
    durationMonths?: number;
    flexibleMonths?: number;
    capMonths?: number;
    capStrategy?: string | null;
    schemeType?: string | null;
    planSnapshot?: {
      capStrategy?: string | null;
      flexibleMonths?: number | null;
      capMonths?: number | null;
      durationMonths?: number | null;
    } | null;
  },
  schemeMonthValue: number,
) {
  return resolveContributionPhase(enrollment, schemeMonthValue);
}

async function sumFinanciallyValidPayments(
  schemeId: unknown,
  extra: Record<string, unknown>,
  session?: ClientSession,
) {
  const rows = await Payment.aggregate([
    { $match: financiallyValidSuccessMatch(schemeId, extra) },
    {
      $group: {
        _id: null,
        total: { $sum: '$amountPaise' },
        count: { $sum: 1 },
      },
    },
  ]).session(session ?? null);
  return {
    totalPaise: rows[0]?.total ?? 0,
    count: rows[0]?.count ?? 0,
  };
}

export async function getPaymentRules(
  schemeId: string,
  paymentDate: Date,
  amountPaise: number,
  session?: ClientSession,
  options: {
    enforceLimit?: boolean;
    requireGoldRate?: boolean;
    targetSchemeMonth?: number;
  } = {},
) {
  const enforceLimit = options.enforceLimit !== false;
  const requireGoldRate = options.requireGoldRate !== false;
  const enrollment = await SchemeEnrollment.findById(schemeId).session(session ?? null);
  if (!enrollment) throw new AppError('SCHEME_NOT_FOUND', 'Scheme enrollment not found', 404);
  if (enrollment.status !== 'ACTIVE')
    throw new AppError('SCHEME_NOT_ACTIVE', 'Scheme is not active', 409);

  const durationMonths = durationMonthCount(enrollment);
  const nakshathra = usesNakshathraContributionPolicy(enrollment);
  const calendarMonth = schemeMonth(enrollment.startDate, paymentDate);
  const contributionWindowEnd =
    enrollment.maturityDate <= enrollment.redemptionStartDate
      ? enrollment.maturityDate
      : enrollment.redemptionStartDate;

  if (
    paymentDate >= contributionWindowEnd ||
    calendarMonth < 1 ||
    calendarMonth > durationMonths
  ) {
    throw new AppError('SCHEME_MATURED', 'Payment date is outside the active scheme period', 409);
  }

  let month: number;
  if (nakshathra) {
    month = contributionSchemeMonth(enrollment.startDate, paymentDate, durationMonths);
    if (options.targetSchemeMonth != null && options.targetSchemeMonth !== month) {
      throw new AppError(
        'INVALID_SCHEME_MONTH',
        'Scheme month is determined by the payment date in Asia/Kolkata',
        422,
      );
    }
  } else {
    month = options.targetSchemeMonth ?? calendarMonth;
    if (month < 1 || month > durationMonths) {
      throw new AppError(
        'INVALID_SCHEME_MONTH',
        `Scheme month must be between 1 and ${durationMonths}`,
        422,
      );
    }
  }

  const installmentPaise = Number(enrollment.monthlyInstallmentPaise);
  if (!Number.isSafeInteger(installmentPaise) || installmentPaise < NAKSHATHRA_MINIMUM_PAYMENT_PAISE) {
    throw new AppError('INVALID_INSTALLMENT', 'Enrollment has an invalid monthly installment', 409);
  }

  const paidThisMonth = await sumFinanciallyValidPayments(
    enrollment._id,
    { schemeMonth: month },
    session,
  );
  const paidThisMonthPaise = paidThisMonth.totalPaise;
  const phase = resolvePaymentPhase(enrollment, month);

  let capPaise: number | null = installmentPaise;
  let remainingPaise = paidThisMonthPaise > 0 ? 0 : installmentPaise;
  let firstPeriodEmpty = false;

  if (nakshathra && phase.phase === 'FLEXIBLE') {
    capPaise = null;
    remainingPaise = null as unknown as number;
    if (enforceLimit && amountPaise < installmentPaise) {
      throw new AppError(
        'PAYMENT_BELOW_MINIMUM',
        `Minimum payment is ₹${(installmentPaise / 100).toLocaleString('en-IN')}`,
        422,
        false,
        [{ minimumPaymentPaise: installmentPaise, schemeMonth: month }],
      );
    }
  } else if (nakshathra && phase.phase === 'CAPPED') {
    const firstPeriod = await sumFinanciallyValidPayments(
      enrollment._id,
      { schemeMonth: { $gte: 1, $lte: flexibleMonthCount(enrollment) } },
      session,
    );
    if (firstPeriod.count === 0) {
      firstPeriodEmpty = true;
      capPaise = null;
      remainingPaise = 0;
      if (enforceLimit) {
        throw new AppError(
          'FIRST_PERIOD_EMPTY',
          'No successful payments in the first six months, so the monthly cap cannot be calculated',
          409,
        );
      }
    } else {
      capPaise = averageSuccessfulPaymentCapPaise(firstPeriod.totalPaise, firstPeriod.count);
      remainingPaise = Math.max(0, capPaise - paidThisMonthPaise);
      if (enforceLimit && amountPaise < installmentPaise) {
        throw new AppError(
          'PAYMENT_BELOW_MINIMUM',
          `Minimum payment is ₹${(installmentPaise / 100).toLocaleString('en-IN')}`,
          422,
          false,
          [{ minimumPaymentPaise: installmentPaise, schemeMonth: month }],
        );
      }
      if (enforceLimit && amountPaise > remainingPaise) {
        throw new AppError(
          'PAYMENT_LIMIT_EXCEEDED',
          `This payment would exceed the monthly cap of ₹${(capPaise / 100).toLocaleString('en-IN')}`,
          409,
          false,
          [
            {
              monthlyCapPaise: capPaise,
              paidThisMonthPaise,
              remainingPaise,
              schemeMonth: month,
            },
          ],
        );
      }
    }
  } else {
    if (enforceLimit && amountPaise !== installmentPaise) {
      throw new AppError(
        'FIXED_INSTALLMENT_REQUIRED',
        `The fixed monthly installment is ₹${(installmentPaise / 100).toLocaleString('en-IN')}`,
        422,
        false,
        [{ installmentPaise, schemeMonth: month }],
      );
    }
    if (enforceLimit && paidThisMonthPaise > 0) {
      throw new AppError(
        'INSTALLMENT_ALREADY_PAID',
        `Installment for scheme month ${month} is already paid`,
        409,
        false,
        [{ installmentPaise, paidThisMonthPaise, schemeMonth: month }],
      );
    }
  }

  let rate: Awaited<ReturnType<typeof activeGoldRate>> | null = null;
  if (enrollment.schemeType === 'GOLD_WEIGHT') {
    if (requireGoldRate) {
      rate = await activeGoldRate(paymentDate, session);
    } else {
      try {
        rate = await activeGoldRate(paymentDate, session);
      } catch (error) {
        if (!(error instanceof AppError) || error.code !== 'GOLD_RATE_NOT_AVAILABLE') throw error;
        rate = null;
      }
    }
  }
  return {
    enrollment,
    schemeMonth: month,
    phase: phase.phase,
    phaseLabel: phase.phaseLabel,
    flexibleThroughout: phase.flexibleThroughout,
    installmentPaise,
    minimumPaymentPaise: installmentPaise,
    installmentAlreadyPaid:
      nakshathra && phase.phase === 'FLEXIBLE'
        ? false
        : nakshathra && phase.phase === 'CAPPED'
          ? remainingPaise === 0
          : paidThisMonthPaise > 0,
    capApplies: nakshathra && phase.phase === 'CAPPED',
    capPaise,
    paidThisMonthPaise,
    remainingPaise: nakshathra && phase.phase === 'FLEXIBLE' ? null : remainingPaise,
    firstPeriodEmpty,
    capStrategy: nakshathra
      ? 'AVERAGE_SUCCESSFUL_PAYMENT_FIRST_6'
      : (enrollment.capStrategy ?? enrollment.planSnapshot?.capStrategy ?? null),
    goldRateId: rate?._id ?? null,
    goldRatePerGramPaise: rate?.ratePerGramPaise ?? null,
    goldPurity: rate?.purity ?? (enrollment.schemeType === 'GOLD_WEIGHT' ? '916' : null),
    goldWeightMg:
      enrollment.schemeType === 'GOLD_WEIGHT' && rate
        ? goldWeightMg(amountPaise, rate.ratePerGramPaise)
        : null,
  };
}

export type ContributionPaymentPreview = {
  enrollmentId: string;
  schemeMonth: number | null;
  phase: 'FLEXIBLE' | 'CAPPED' | 'NOT_PAYABLE';
  requestedAmountPaise: number;
  allowed: boolean;
  minimumPaymentPaise: number | null;
  monthlyCapPaise: number | null;
  paidThisMonthPaise: number;
  remainingPaise: number | null;
  reasonCode: string | null;
  reasonMessage: string | null;
  capStrategy: string | null;
  capApplies: boolean;
};

export async function previewContributionPayment(
  schemeId: string,
  amountPaise: number,
  at = new Date(),
  requestedSchemeMonth?: number,
): Promise<ContributionPaymentPreview> {
  const enrollment = await SchemeEnrollment.findById(schemeId);
  if (!enrollment) throw new AppError('SCHEME_NOT_FOUND', 'Scheme enrollment not found', 404);

  const base = {
    enrollmentId: String(enrollment._id),
    requestedAmountPaise: amountPaise,
    paidThisMonthPaise: 0,
    remainingPaise: null as number | null,
    monthlyCapPaise: null as number | null,
    minimumPaymentPaise: Number.isSafeInteger(Number(enrollment.monthlyInstallmentPaise))
      ? Number(enrollment.monthlyInstallmentPaise)
      : null,
    capStrategy: usesNakshathraContributionPolicy(enrollment)
      ? 'AVERAGE_SUCCESSFUL_PAYMENT_FIRST_6'
      : (enrollment.capStrategy ?? enrollment.planSnapshot?.capStrategy ?? null),
    capApplies: false,
  };

  const reject = (
    phase: 'FLEXIBLE' | 'CAPPED' | 'NOT_PAYABLE',
    schemeMonthValue: number | null,
    code: string,
    message: string,
    extra: Partial<ContributionPaymentPreview> = {},
  ): ContributionPaymentPreview => ({
    ...base,
    schemeMonth: schemeMonthValue,
    phase,
    allowed: false,
    reasonCode: code,
    reasonMessage: message,
    ...extra,
  });

  try {
    const rules = await getPaymentRules(schemeId, at, amountPaise, undefined, {
      enforceLimit: false,
      requireGoldRate: false,
      targetSchemeMonth: requestedSchemeMonth,
    });
    const phase = previewPhase(rules.phase);
    const extra = {
      schemeMonth: rules.schemeMonth,
      phase,
      minimumPaymentPaise: rules.minimumPaymentPaise,
      monthlyCapPaise: rules.capPaise,
      paidThisMonthPaise: rules.paidThisMonthPaise,
      remainingPaise: rules.remainingPaise,
      capApplies: rules.capApplies,
      capStrategy: rules.capStrategy,
    };

    if (rules.firstPeriodEmpty) {
      return reject(
        'CAPPED',
        rules.schemeMonth,
        'FIRST_PERIOD_EMPTY',
        'No successful payments in the first six months, so the monthly cap cannot be calculated',
        extra,
      );
    }
    if (rules.phase === 'FIXED' && amountPaise !== rules.installmentPaise) {
      return reject(
        'NOT_PAYABLE',
        rules.schemeMonth,
        'FIXED_INSTALLMENT_REQUIRED',
        `The fixed monthly installment is ₹${(rules.installmentPaise / 100).toLocaleString('en-IN')}`,
        extra,
      );
    }
    if (
      (rules.phase === 'FLEXIBLE' || rules.phase === 'CAPPED') &&
      amountPaise < rules.installmentPaise
    ) {
      return reject(
        phase,
        rules.schemeMonth,
        'PAYMENT_BELOW_MINIMUM',
        `Minimum payment is ₹${(rules.installmentPaise / 100).toLocaleString('en-IN')}`,
        extra,
      );
    }
    if (rules.phase === 'FIXED' && rules.installmentAlreadyPaid) {
      return reject(
        'NOT_PAYABLE',
        rules.schemeMonth,
        'INSTALLMENT_ALREADY_PAID',
        `Installment for scheme month ${rules.schemeMonth} is already paid`,
        extra,
      );
    }
    if (
      rules.phase === 'CAPPED' &&
      rules.remainingPaise != null &&
      amountPaise > rules.remainingPaise
    ) {
      return reject(
        'CAPPED',
        rules.schemeMonth,
        'PAYMENT_LIMIT_EXCEEDED',
        `This payment would exceed the monthly cap of ₹${((rules.capPaise ?? 0) / 100).toLocaleString('en-IN')}`,
        extra,
      );
    }
    if (enrollment.schemeType === 'GOLD_WEIGHT' && !rules.goldRatePerGramPaise) {
      return reject(
        phase,
        rules.schemeMonth,
        'GOLD_RATE_NOT_AVAILABLE',
        'Current 916 gold rate is unavailable. Try again shortly.',
        extra,
      );
    }
    if (!Number.isInteger(amountPaise) || amountPaise < 1) {
      return reject(
        phase,
        rules.schemeMonth,
        'INVALID_AMOUNT',
        'Enter a valid payment amount.',
        extra,
      );
    }
    return {
      ...base,
      ...extra,
      allowed: true,
      reasonCode: null,
      reasonMessage: null,
    };
  } catch (error) {
    if (!(error instanceof AppError)) throw error;
    const calendarMonth = schemeMonth(enrollment.startDate, at);
    const phaseInfo = resolvePaymentPhase(enrollment, calendarMonth);
    return reject(
      previewPhase(phaseInfo.phase),
      Number.isInteger(calendarMonth) ? calendarMonth : null,
      error.code,
      error.message,
    );
  }
}

export async function activeGoldRate(at: Date, session?: ClientSession) {
  const { start, end } = businessDayRange(at);
  const rate = await GoldRate.findOne({
    status: 'ACTIVE',
    effectiveFrom: mongoose.trusted({ $gte: start, $lt: end }),
  })
    .sort({ effectiveFrom: -1 })
    .session(session ?? null);
  if (!rate)
    throw new AppError(
      'GOLD_RATE_NOT_AVAILABLE',
      'Gold board rate is not published for this payment date',
      409,
    );
  return rate;
}
export const goldWeightMg = (amountPaise: number, ratePerGramPaise: number) => {
  paise(amountPaise);
  paise(ratePerGramPaise);
  return Number((BigInt(amountPaise) * 1000n) / BigInt(ratePerGramPaise));
};

/** @deprecated Month-count division. Do not use for Nakshathra; cap is amount/payment-count. */
export const averageMonthlyCapPaise = (firstPeriodTotalPaise: number, flexibleMonths: number) => {
  if (
    !Number.isSafeInteger(firstPeriodTotalPaise) ||
    firstPeriodTotalPaise < 0 ||
    !Number.isInteger(flexibleMonths) ||
    flexibleMonths < 1
  )
    throw new AppError('INVALID_SCHEME_CAP_INPUT', 'Invalid cap calculation input', 422);
  return Math.floor(firstPeriodTotalPaise / flexibleMonths);
};
export const remainingUnderCapPaise = (capPaise: number, paidThisMonthPaise: number) =>
  Math.max(0, capPaise - paidThisMonthPaise);
export function enrollmentDates(startDate: Date, flexibleMonths: number, durationMonths: number) {
  const local = toZonedTime(startDate, BUSINESS_TZ);
  const redemptionStartDate = fromZonedTime(addMonths(local, durationMonths), BUSINESS_TZ);
  return {
    flexiblePeriodEndDate: fromZonedTime(addMonths(local, flexibleMonths), BUSINESS_TZ),
    maturityDate: redemptionStartDate,
    redemptionStartDate,
    redemptionEndDate: fromZonedTime(addMonths(local, durationMonths + 1), BUSINESS_TZ),
  };
}

export async function getPaidSchemeMonths(
  schemeId: string,
  session?: ClientSession,
): Promise<Set<number>> {
  const rows: Array<{ schemeMonth?: number }> = await Payment.find({
    schemeId,
    status: 'SUCCESS',
  })
    .select('schemeMonth')
    .session(session ?? null)
    .lean();

  return new Set(
    rows
      .map((row) => row.schemeMonth)
      .filter((value): value is number => Number.isInteger(value)),
  );
}

export async function listUnpaidSchemeMonths(
  enrollment: { _id: unknown; durationMonths?: number },
  session?: ClientSession,
): Promise<number[]> {
  const durationMonths = enrollment.durationMonths ?? 11;
  const paid = await getPaidSchemeMonths(String(enrollment._id), session);
  return Array.from({ length: durationMonths }, (_, index) => index + 1).filter(
    (month) => !paid.has(month),
  );
}

export async function resolveTargetSchemeMonth(
  schemeId: string,
  requestedMonth: number | undefined,
  session?: ClientSession,
  paymentDate: Date = new Date(),
): Promise<number> {
  const enrollment = await SchemeEnrollment.findById(schemeId).session(session ?? null);
  if (!enrollment) throw new AppError('SCHEME_NOT_FOUND', 'Scheme enrollment not found', 404);
  if (usesNakshathraContributionPolicy(enrollment)) {
    const month = contributionSchemeMonth(
      enrollment.startDate,
      paymentDate,
      durationMonthCount(enrollment),
    );
    if (requestedMonth != null && requestedMonth !== month) {
      throw new AppError(
        'INVALID_SCHEME_MONTH',
        'Scheme month is determined by the payment date in Asia/Kolkata',
        422,
      );
    }
    return month;
  }
  const unpaid = await listUnpaidSchemeMonths(enrollment, session);
  if (!unpaid.length) {
    throw new AppError('ALL_INSTALLMENTS_PAID', 'All installments are already paid', 409);
  }
  if (requestedMonth == null) return unpaid[0]!;
  if (!unpaid.includes(requestedMonth)) {
    if ((await getPaidSchemeMonths(schemeId, session)).has(requestedMonth)) {
      throw new AppError(
        'INSTALLMENT_ALREADY_PAID',
        `Installment for scheme month ${requestedMonth} is already paid`,
        409,
      );
    }
    throw new AppError(
      'INVALID_SCHEME_MONTH',
      `Scheme month ${requestedMonth} is not payable for this enrollment`,
      422,
    );
  }
  return requestedMonth;
}
