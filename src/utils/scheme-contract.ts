import type {
  CapStrategy,
  CashSettlementBasis,
  PaymentWindowType,
  SettlementAsset,
} from '../models/enums.js';
import {
  DEFAULT_PAYMENT_WINDOW,
  DEFAULT_SETTLEMENT_POLICY,
  paymentWindowFromStartDate,
  validatePaymentWindow,
  validateSettlementPolicy,
  type PaymentWindowConfig,
  type SettlementPolicy,
} from './payment-window.js';

export type PlanSnapshot = {
  name: string;
  type: string;
  version: number;
  durationMonths: number;
  redemptionMonth: number;
  flexibleMonths: number;
  capMonths: number;
  capStrategy?: CapStrategy;
  contributionPolicyVersion?: number;
  minimumPaymentPaise: number;
  makingChargeWaiverPercent: number;
  gstRateBasisPoints: number;
  makingChargeBenefit?: string;
  wastageBenefit?: string;
  benefitText?: string;
  termsText: string;
  paymentWindowType: PaymentWindowType;
  fixedPaymentDay?: number;
  paymentWindowStartDay?: number;
  paymentWindowEndDay?: number;
  prematureClosureEnabled: boolean;
  prematureClosureMinPaidInstallments: number;
  prematureClosureMinElapsedMonths?: number;
  prematureClosureSettlementAssets: SettlementAsset[];
  maturitySettlementAssets: SettlementAsset[];
  prematureClosureCashBasis: CashSettlementBasis;
  maturityCashBasis: CashSettlementBasis;
};

function asPlanWindow(plan: Record<string, unknown>): PaymentWindowConfig {
  if (plan.paymentWindowType == null) {
    if (plan.startDate) return paymentWindowFromStartDate(plan.startDate as Date | string);
    return { ...DEFAULT_PAYMENT_WINDOW };
  }
  if (plan.paymentWindowType === 'DATE_RANGE') {
    return validatePaymentWindow({
      paymentWindowType: 'DATE_RANGE',
      paymentWindowStartDay: plan.paymentWindowStartDay as number | undefined,
      paymentWindowEndDay: plan.paymentWindowEndDay as number | undefined,
    });
  }
  return validatePaymentWindow({
    paymentWindowType: plan.paymentWindowType as PaymentWindowType,
    fixedPaymentDay: plan.fixedPaymentDay as number | undefined,
  });
}

function asPlanPolicy(plan: Record<string, unknown>): SettlementPolicy {
  return validateSettlementPolicy({
    prematureClosureEnabled: plan.prematureClosureEnabled as boolean | undefined,
    prematureClosureMinPaidInstallments: plan.prematureClosureMinPaidInstallments as
      | number
      | undefined,
    prematureClosureMinElapsedMonths: plan.prematureClosureMinElapsedMonths as number | undefined,
    prematureClosureSettlementAssets: plan.prematureClosureSettlementAssets as
      | SettlementAsset[]
      | undefined,
    maturitySettlementAssets: plan.maturitySettlementAssets as SettlementAsset[] | undefined,
    prematureClosureCashBasis: plan.prematureClosureCashBasis as CashSettlementBasis | undefined,
    maturityCashBasis: plan.maturityCashBasis as CashSettlementBasis | undefined,
  });
}

export function buildPlanSnapshot(plan: Record<string, any>): PlanSnapshot {
  const window = asPlanWindow(plan);
  const policy = asPlanPolicy(plan);
  return {
    name: plan.name ?? '',
    type: plan.type ?? 'GOLD_WEIGHT',
    version: plan.version ?? 1,
    durationMonths: plan.durationMonths ?? 11,
    redemptionMonth: plan.redemptionMonth ?? 12,
    flexibleMonths: plan.flexibleMonths ?? 11,
    capMonths: plan.capMonths ?? 0,
    capStrategy: plan.capStrategy,
    contributionPolicyVersion: plan.contributionPolicyVersion,
    minimumPaymentPaise: plan.minimumPaymentPaise ?? 100_000,
    makingChargeWaiverPercent: plan.makingChargeWaiverPercent ?? 100,
    gstRateBasisPoints: plan.gstRateBasisPoints ?? 300,
    makingChargeBenefit: plan.makingChargeBenefit,
    wastageBenefit: plan.wastageBenefit,
    benefitText: plan.benefitText,
    termsText: plan.termsText ?? '',
    ...window,
    ...policy,
  };
}

export function enrollmentContract(enrollment: any): PlanSnapshot | null {
  const snapshot = enrollment?.planSnapshot;
  if (snapshot && (snapshot.version != null || snapshot.termsText != null || snapshot.name)) {
    return buildPlanSnapshot({
      ...snapshot,
      paymentWindowType: enrollment.paymentWindowType ?? snapshot.paymentWindowType,
      fixedPaymentDay: enrollment.fixedPaymentDay ?? snapshot.fixedPaymentDay,
      paymentWindowStartDay: enrollment.paymentWindowStartDay ?? snapshot.paymentWindowStartDay,
      paymentWindowEndDay: enrollment.paymentWindowEndDay ?? snapshot.paymentWindowEndDay,
      prematureClosureEnabled:
        enrollment.prematureClosureEnabled ?? snapshot.prematureClosureEnabled,
      prematureClosureMinPaidInstallments:
        enrollment.prematureClosureMinPaidInstallments ??
        snapshot.prematureClosureMinPaidInstallments,
      prematureClosureMinElapsedMonths:
        enrollment.prematureClosureMinElapsedMonths ?? snapshot.prematureClosureMinElapsedMonths,
      prematureClosureSettlementAssets:
        enrollment.prematureClosureSettlementAssets ?? snapshot.prematureClosureSettlementAssets,
      maturitySettlementAssets:
        enrollment.maturitySettlementAssets ?? snapshot.maturitySettlementAssets,
      prematureClosureCashBasis:
        enrollment.prematureClosureCashBasis ?? snapshot.prematureClosureCashBasis,
      maturityCashBasis: enrollment.maturityCashBasis ?? snapshot.maturityCashBasis,
    });
  }
  const livePlan = enrollment?.schemePlanId;
  if (livePlan && typeof livePlan === 'object' && (livePlan.termsText != null || livePlan.name)) {
    return buildPlanSnapshot(livePlan);
  }
  return null;
}

export function withEnrollmentContract<T extends Record<string, any>>(enrollment: T) {
  const schemeContract = enrollmentContract(enrollment);
  return {
    ...enrollment,
    schemeContract,
    schemeName: schemeContract?.name ?? enrollment?.schemePlanId?.name ?? null,
  };
}

export function enrollmentWindowAndPolicy(enrollment: any): {
  window: PaymentWindowConfig;
  policy: SettlementPolicy;
} {
  const snapshot = buildPlanSnapshot({
    ...(enrollment?.planSnapshot ?? {}),
    ...enrollment,
  });
  return {
    window: {
      paymentWindowType: snapshot.paymentWindowType,
      fixedPaymentDay: snapshot.fixedPaymentDay,
      paymentWindowStartDay: snapshot.paymentWindowStartDay,
      paymentWindowEndDay: snapshot.paymentWindowEndDay,
    },
    policy: {
      prematureClosureEnabled: snapshot.prematureClosureEnabled,
      prematureClosureMinPaidInstallments: snapshot.prematureClosureMinPaidInstallments,
      prematureClosureMinElapsedMonths: snapshot.prematureClosureMinElapsedMonths,
      prematureClosureSettlementAssets: snapshot.prematureClosureSettlementAssets,
      maturitySettlementAssets: snapshot.maturitySettlementAssets,
      prematureClosureCashBasis: snapshot.prematureClosureCashBasis,
      maturityCashBasis: snapshot.maturityCashBasis,
    },
  };
}
