import {
  NAKSHATHRA_CAP_STRATEGY,
  NAKSHATHRA_CAPPED_MONTHS,
  NAKSHATHRA_DURATION_MONTHS,
  NAKSHATHRA_FLEXIBLE_MONTHS,
} from '../config/business.js';
import type { CapStrategy } from '../models/enums.js';
import { AppError } from './AppError.js';
import { paise } from './money.js';
import { schemeMonth } from './time.js';

export type ContributionPhase = 'FLEXIBLE' | 'CAPPED' | 'FIXED' | 'REDEMPTION' | 'NOT_PAYABLE';

export type ContributionPolicySource = {
  schemeType?: string | null;
  capStrategy?: string | null;
  flexibleMonths?: number | null;
  capMonths?: number | null;
  durationMonths?: number | null;
  planSnapshot?: {
    capStrategy?: string | null;
    flexibleMonths?: number | null;
    capMonths?: number | null;
    durationMonths?: number | null;
  } | null;
};

export function contributionField<T>(
  enrollment: ContributionPolicySource,
  key: 'capStrategy' | 'flexibleMonths' | 'capMonths' | 'durationMonths',
): T | undefined {
  const own = enrollment[key];
  if (own != null) return own as T;
  return (enrollment.planSnapshot?.[key] ?? undefined) as T | undefined;
}

/** True when this enrollment uses Nakshathra 6+5 multi-pay + average-payment cap. */
export function usesNakshathraContributionPolicy(enrollment: ContributionPolicySource): boolean {
  const strategy = contributionField<string>(enrollment, 'capStrategy');
  if (strategy === NAKSHATHRA_CAP_STRATEGY) return true;
  const flexibleMonths = contributionField<number>(enrollment, 'flexibleMonths');
  const capMonths = contributionField<number>(enrollment, 'capMonths');
  return flexibleMonths === NAKSHATHRA_FLEXIBLE_MONTHS && capMonths === NAKSHATHRA_CAPPED_MONTHS;
}

export function flexibleMonthCount(enrollment: ContributionPolicySource): number {
  return contributionField<number>(enrollment, 'flexibleMonths') ?? NAKSHATHRA_DURATION_MONTHS;
}

export function durationMonthCount(enrollment: ContributionPolicySource): number {
  return contributionField<number>(enrollment, 'durationMonths') ?? NAKSHATHRA_DURATION_MONTHS;
}

/**
 * Cap = floor(sum of SUCCESS amounts in months 1–flexible / count of those payments).
 * Never divides by the flexible month count (the demo `total / 6` bug).
 */
export function averageSuccessfulPaymentCapPaise(
  firstPeriodTotalPaise: number,
  successfulPaymentCount: number,
): number {
  paise(firstPeriodTotalPaise);
  if (!Number.isInteger(successfulPaymentCount) || successfulPaymentCount < 0) {
    throw new AppError('INVALID_SCHEME_CAP_INPUT', 'Invalid cap calculation input', 422);
  }
  if (successfulPaymentCount === 0) {
    throw new AppError(
      'FIRST_PERIOD_EMPTY',
      'No successful payments in the first six months, so the monthly cap cannot be calculated',
      409,
    );
  }
  return Math.floor(firstPeriodTotalPaise / successfulPaymentCount);
}

export function resolveContributionPhase(
  enrollment: ContributionPolicySource,
  schemeMonthValue: number,
): { phase: ContributionPhase; phaseLabel: string; flexibleThroughout: boolean } {
  const durationMonths = durationMonthCount(enrollment);
  if (schemeMonthValue < 1 || schemeMonthValue > durationMonths) {
    return {
      phase: schemeMonthValue > durationMonths ? 'REDEMPTION' : 'NOT_PAYABLE',
      phaseLabel: schemeMonthValue > durationMonths ? 'Redemption month' : 'Not payable',
      flexibleThroughout: false,
    };
  }
  if (!usesNakshathraContributionPolicy(enrollment)) {
    return {
      phase: 'FIXED',
      phaseLabel: 'Fixed monthly installment',
      flexibleThroughout: false,
    };
  }
  const flexibleMonths = flexibleMonthCount(enrollment);
  if (schemeMonthValue <= flexibleMonths) {
    return {
      phase: 'FLEXIBLE',
      phaseLabel: 'Flexible contribution month',
      flexibleThroughout: false,
    };
  }
  return {
    phase: 'CAPPED',
    phaseLabel: 'Capped contribution month',
    flexibleThroughout: false,
  };
}

export function previewPhase(
  phase: ContributionPhase,
): 'FLEXIBLE' | 'CAPPED' | 'NOT_PAYABLE' {
  if (phase === 'FLEXIBLE' || phase === 'CAPPED') return phase;
  return 'NOT_PAYABLE';
}

/**
 * Calendar scheme month in Asia/Kolkata. Rejects dates before start or after
 * the 11-month contribution window. Does not invent a client-supplied month.
 */
export function contributionSchemeMonth(
  startDate: Date,
  paymentDate: Date,
  durationMonths: number = NAKSHATHRA_DURATION_MONTHS,
): number {
  const month = schemeMonth(startDate, paymentDate);
  if (month < 1) {
    throw new AppError(
      'SCHEME_NOT_STARTED',
      'Payment date is before the enrollment start',
      409,
    );
  }
  if (month > durationMonths) {
    throw new AppError(
      'SCHEME_MATURED',
      'Payment date is outside the active scheme period',
      409,
    );
  }
  return month;
}

export function financiallyValidSuccessMatch(
  schemeId: unknown,
  extra: Record<string, unknown> = {},
) {
  return {
    schemeId,
    status: 'SUCCESS',
    ...extra,
    $nor: [{ reversedAt: { $type: 'date' } }, { refundStatus: 'SUCCESS' }],
  };
}

export const LIVE_CONTRIBUTION_DEFAULTS = Object.freeze({
  durationMonths: NAKSHATHRA_DURATION_MONTHS,
  flexibleMonths: NAKSHATHRA_FLEXIBLE_MONTHS,
  capMonths: NAKSHATHRA_CAPPED_MONTHS,
  capStrategy: NAKSHATHRA_CAP_STRATEGY as CapStrategy,
  contributionPolicyVersion: 1 as const,
});
