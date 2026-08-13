import { AppError } from './AppError.js';
import { BUSINESS_TZ } from './time.js';
import { toZonedTime } from 'date-fns-tz';
import type { CashSettlementBasis, PaymentWindowType, SettlementAsset } from '../models/enums.js';

export type PaymentWindowConfig = {
  paymentWindowType: PaymentWindowType;
  fixedPaymentDay?: number;
  paymentWindowStartDay?: number;
  paymentWindowEndDay?: number;
};

export type SettlementPolicy = {
  prematureClosureEnabled: boolean;
  prematureClosureMinPaidInstallments: number;
  prematureClosureSettlementAssets: SettlementAsset[];
  maturitySettlementAssets: SettlementAsset[];
  prematureClosureCashBasis: CashSettlementBasis;
  maturityCashBasis: CashSettlementBasis;
};

export const DEFAULT_PAYMENT_WINDOW: PaymentWindowConfig = {
  paymentWindowType: 'FIXED_DAY',
  fixedPaymentDay: 5,
};

export const DEFAULT_SETTLEMENT_POLICY: SettlementPolicy = {
  prematureClosureEnabled: true,
  prematureClosureMinPaidInstallments: 1,
  prematureClosureSettlementAssets: ['GOLD', 'CASH'],
  maturitySettlementAssets: ['GOLD', 'CASH'],
  prematureClosureCashBasis: 'CONTRIBUTION_VALUE',
  maturityCashBasis: 'CONTRIBUTION_VALUE',
};

/** Live Nakshathra CASH schemes settle in cash at contribution value. No gold, no invented penalty. */
export const LIVE_CASH_SETTLEMENT_POLICY: SettlementPolicy = {
  prematureClosureEnabled: true,
  prematureClosureMinPaidInstallments: 1,
  prematureClosureSettlementAssets: ['CASH'],
  maturitySettlementAssets: ['CASH'],
  prematureClosureCashBasis: 'CONTRIBUTION_VALUE',
  maturityCashBasis: 'CONTRIBUTION_VALUE',
};

/** Historical enrollments must not gain premature-close or CASH maturity rights by backfill. */
export const LEGACY_ENROLLMENT_SETTLEMENT_POLICY: SettlementPolicy = {
  prematureClosureEnabled: false,
  prematureClosureMinPaidInstallments: 1,
  prematureClosureSettlementAssets: [],
  maturitySettlementAssets: ['GOLD'],
  prematureClosureCashBasis: 'CONTRIBUTION_VALUE',
  maturityCashBasis: 'CONTRIBUTION_VALUE',
};

function asDay(value: unknown): number | undefined {
  if (value == null || value === '') return undefined;
  const day = Number(value);
  if (!Number.isInteger(day) || day < 1 || day > 31) return undefined;
  return day;
}

export function lastCalendarDayOfMonth(year: number, monthIndex0: number) {
  return new Date(Date.UTC(year, monthIndex0 + 1, 0)).getUTCDate();
}

export function clampDayOfMonth(year: number, monthIndex0: number, day: number) {
  return Math.min(day, lastCalendarDayOfMonth(year, monthIndex0));
}

export function validatePaymentWindow(input: Partial<PaymentWindowConfig>): PaymentWindowConfig {
  const paymentWindowType = input.paymentWindowType ?? 'FIXED_DAY';
  if (paymentWindowType === 'FIXED_DAY') {
    const fixedPaymentDay = asDay(input.fixedPaymentDay) ?? DEFAULT_PAYMENT_WINDOW.fixedPaymentDay;
    if (fixedPaymentDay == null) {
      throw new AppError('VALIDATION_ERROR', 'fixedPaymentDay is required for FIXED_DAY windows', 422);
    }
    if (input.paymentWindowStartDay != null || input.paymentWindowEndDay != null) {
      throw new AppError(
        'VALIDATION_ERROR',
        'DATE_RANGE days are not allowed when paymentWindowType is FIXED_DAY',
        422,
      );
    }
    return { paymentWindowType, fixedPaymentDay };
  }
  if (paymentWindowType === 'DATE_RANGE') {
    const paymentWindowStartDay = asDay(input.paymentWindowStartDay);
    const paymentWindowEndDay = asDay(input.paymentWindowEndDay);
    if (paymentWindowStartDay == null || paymentWindowEndDay == null) {
      throw new AppError(
        'VALIDATION_ERROR',
        'paymentWindowStartDay and paymentWindowEndDay are required for DATE_RANGE windows',
        422,
      );
    }
    if (paymentWindowStartDay > paymentWindowEndDay) {
      throw new AppError(
        'VALIDATION_ERROR',
        'paymentWindowStartDay must be less than or equal to paymentWindowEndDay',
        422,
      );
    }
    if (input.fixedPaymentDay != null) {
      throw new AppError(
        'VALIDATION_ERROR',
        'fixedPaymentDay is not allowed when paymentWindowType is DATE_RANGE',
        422,
      );
    }
    return { paymentWindowType, paymentWindowStartDay, paymentWindowEndDay };
  }
  throw new AppError('VALIDATION_ERROR', 'paymentWindowType is invalid', 422);
}

export function validateSettlementPolicy(input: Partial<SettlementPolicy> = {}): SettlementPolicy {
  const prematureClosureEnabled =
    input.prematureClosureEnabled ?? DEFAULT_SETTLEMENT_POLICY.prematureClosureEnabled;
  const prematureClosureSettlementAssets = resolvePrematureAssets(input, prematureClosureEnabled);
  const maturitySettlementAssets = uniqueAssets(
    input.maturitySettlementAssets?.length
      ? input.maturitySettlementAssets
      : DEFAULT_SETTLEMENT_POLICY.maturitySettlementAssets,
  );
  const minPaid =
    input.prematureClosureMinPaidInstallments ??
    DEFAULT_SETTLEMENT_POLICY.prematureClosureMinPaidInstallments;
  if (!Number.isInteger(minPaid) || minPaid < 1 || minPaid > 11) {
    throw new AppError(
      'VALIDATION_ERROR',
      'prematureClosureMinPaidInstallments must be an integer from 1 to 11',
      422,
    );
  }
  return {
    prematureClosureEnabled,
    prematureClosureMinPaidInstallments: minPaid,
    prematureClosureSettlementAssets,
    maturitySettlementAssets,
    prematureClosureCashBasis: input.prematureClosureCashBasis ?? 'CONTRIBUTION_VALUE',
    maturityCashBasis: input.maturityCashBasis ?? 'CONTRIBUTION_VALUE',
  };
}

function resolvePrematureAssets(
  input: Partial<SettlementPolicy>,
  prematureClosureEnabled: boolean,
): SettlementAsset[] {
  const raw = input.prematureClosureSettlementAssets;
  if (prematureClosureEnabled === false) {
    if (!raw || raw.length === 0) return [];
    return uniqueAssets(raw);
  }
  if (!raw || raw.length === 0) {
    return [...DEFAULT_SETTLEMENT_POLICY.prematureClosureSettlementAssets];
  }
  return uniqueAssets(raw);
}

function uniqueAssets(assets: SettlementAsset[]) {
  const unique = [...new Set(assets)];
  if (unique.length === 0 || unique.some((asset) => asset !== 'GOLD' && asset !== 'CASH')) {
    throw new AppError('VALIDATION_ERROR', 'Settlement assets must be GOLD and/or CASH', 422);
  }
  return unique;
}

export function paymentWindowFromStartDate(startDate: Date | string): PaymentWindowConfig {
  const local = toZonedTime(new Date(startDate), BUSINESS_TZ);
  return {
    paymentWindowType: 'FIXED_DAY',
    fixedPaymentDay: local.getDate(),
  };
}

type WindowSource = {
  paymentWindowType?: string;
  fixedPaymentDay?: number;
  paymentWindowStartDay?: number;
  paymentWindowEndDay?: number;
  planSnapshot?: WindowSource | null;
  startDate?: Date | string;
};

export function resolvePaymentWindow(source: WindowSource): PaymentWindowConfig {
  const raw =
    source.paymentWindowType != null
      ? source
      : source.planSnapshot?.paymentWindowType != null
        ? source.planSnapshot
        : null;
  if (raw?.paymentWindowType === 'FIXED_DAY' || raw?.paymentWindowType === 'DATE_RANGE') {
    try {
      return validatePaymentWindow({
        paymentWindowType: raw.paymentWindowType,
        fixedPaymentDay: raw.fixedPaymentDay,
        paymentWindowStartDay: raw.paymentWindowStartDay,
        paymentWindowEndDay: raw.paymentWindowEndDay,
      });
    } catch {
      // Fall through to startDate mapping for corrupt/partial legacy rows.
    }
  }
  if (source.startDate) return paymentWindowFromStartDate(source.startDate);
  return { ...DEFAULT_PAYMENT_WINDOW };
}

type PolicySource = Partial<SettlementPolicy> & {
  schemeType?: string | null;
  type?: string | null;
  planSnapshot?: (Partial<SettlementPolicy> & { type?: string | null }) | null;
};

export function resolveSettlementPolicy(source: PolicySource): SettlementPolicy {
  const snapshot = source.planSnapshot ?? {};
  const schemeType = source.schemeType ?? source.type ?? snapshot.type;
  if (schemeType === 'CASH') {
    return { ...LIVE_CASH_SETTLEMENT_POLICY };
  }
  const hasOwnPolicy =
    source.prematureClosureEnabled != null ||
    source.prematureClosureCashBasis != null ||
    source.maturityCashBasis != null ||
    (Array.isArray(source.prematureClosureSettlementAssets) &&
      source.prematureClosureSettlementAssets.length > 0) ||
    (Array.isArray(source.maturitySettlementAssets) && source.maturitySettlementAssets.length > 0);
  const raw = hasOwnPolicy ? source : snapshot;
  return validateSettlementPolicy(raw);
}
