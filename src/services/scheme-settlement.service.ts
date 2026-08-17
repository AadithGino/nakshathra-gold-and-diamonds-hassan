import type { ClientSession } from 'mongoose';
import mongoose from 'mongoose';
import { randomUUID } from 'node:crypto';
import { AppError } from '../utils/AppError.js';
import { sha256Canonical } from '../utils/canonical-hash.js';
import { paise } from '../utils/money.js';
import { businessDayRange, BUSINESS_TZ } from '../utils/time.js';
import { toZonedTime } from 'date-fns-tz';
import {
  aggregateEnrollmentLedger,
  claimEnrollmentSettlementLock,
  clearEnrollmentSettlementLock,
  SETTLEMENT_LOCK_REDEMPTION_STATUSES,
  syncEnrollmentFromLedger,
  type EnrollmentLedger,
} from '../utils/enrollment-ledger.js';
import { withMongoTransaction } from '../utils/transaction.js';
import {
  Customer,
  Payment,
  PaymentCorrection,
  PaymentIntent,
  Payout,
  Refund,
  SchemeEnrollment,
  GoldRate,
} from '../models/index.js';
import type { PayoutMethod, PayoutType, SettlementAsset, SettlementMode } from '../models/enums.js';
import { SETTLEMENT_ASSETS } from '../models/enums.js';
import { NAKSHATHRA_PREMATURE_CLOSURE_MIN_ELAPSED_MONTHS } from '../config/business.js';
import { env } from '../config/env.js';
import { audit, outbox, type AuditContext } from './audit.service.js';
import { assertDateInOpenPeriod } from './accounting-period.service.js';
import { assertCustomerKycVerified } from './customer-financial-policy.service.js';
import { recordPayoutGoldIssue, reportNegativeInventoryException } from './gold-control.service.js';
import { activeGoldRate, goldWeightMg } from './scheme.service.js';
import { buildPlanSnapshot } from '../utils/scheme-contract.js';
import {
  calculatePrematureClosureSettlement,
  isPrematureClosureTimeEligible,
  prematureClosureEligibilityBoundary,
} from '../utils/premature-closure-policy.js';
import {
  resolvePaymentWindow,
  resolveSettlementPolicy,
  type SettlementPolicy,
} from '../utils/payment-window.js';

export const SETTLEMENT_BLOCKING_INTENT_STATUSES = [
  'INITIATED',
  'PROVIDER_CREATING',
  'PROVIDER_CREATE_UNCERTAIN',
  'PENDING',
  'REVIEW_REQUIRED',
] as const;

const TERMINAL_ENROLLMENT = new Set(['REDEEMED', 'CLOSED', 'WITHDRAWN', 'CANCELLED']);

export type SettlementKind = 'REDEEM' | 'PREMATURE_CLOSE';

export type SettlementValuation = {
  goldRateId: string;
  ratePerGramPaise: number;
  purity: '916';
  goldWeightMg: number;
};

export type SchemeSettlementCalculation = {
  settlementAsset: SettlementAsset;
  method: PayoutMethod;
  payoutType: PayoutType;
  cashBasis?: 'CONTRIBUTION_VALUE' | 'CURRENT_GOLD_VALUE';
  settlementPrincipalPaise: number;
  amountPaise: number;
  goldWeightMg: number;
  valuation: SettlementValuation | null;
  settlementMode?: SettlementMode;
};

export type JewellerySettlementInput = {
  billNumber: string;
  billAmountPaise: number;
  extraPaymentMethod?: 'CASH' | 'UPI' | 'CARD' | 'BANK';
  extraPaymentReference?: string;
};

export type JewellerySettlementFields = {
  settlementMode: 'JEWELLERY';
  billNumber: string;
  billAmountPaise: number;
  schemeValueAppliedPaise: number;
  extraPaidPaise: number;
  extraPaymentMethod?: 'CASH' | 'UPI' | 'CARD' | 'BANK';
  extraPaymentReference?: string;
};

export function parseSettlementAsset(value: unknown): SettlementAsset | undefined {
  const asset = String(value ?? '').trim().toUpperCase();
  return (SETTLEMENT_ASSETS as readonly string[]).includes(asset)
    ? (asset as SettlementAsset)
    : undefined;
}

function allowedSettlementModesFor(
  kind: SettlementKind,
  policy: SettlementPolicy,
): SettlementMode[] {
  const assets =
    kind === 'PREMATURE_CLOSE'
      ? policy.prematureClosureSettlementAssets
      : policy.maturitySettlementAssets;
  return assets.filter((asset): asset is SettlementMode => asset === 'CASH' || asset === 'JEWELLERY');
}

export function jewelleryPurchaseTopUp(input: {
  billAmountPaise: number;
  schemeValueAppliedPaise: number;
  extraPaymentMethod?: 'CASH' | 'UPI' | 'CARD' | 'BANK';
  extraPaymentReference?: string;
}): { extraPaidPaise: number; extraPaymentMethod?: 'CASH' | 'UPI' | 'CARD' | 'BANK'; extraPaymentReference?: string } {
  paise(input.billAmountPaise);
  paise(input.schemeValueAppliedPaise);
  if (input.billAmountPaise < input.schemeValueAppliedPaise) {
    throw new AppError(
      'JEWELLERY_BILL_BELOW_ENTITLEMENT',
      'Jewellery bill amount cannot be below the remaining scheme entitlement',
      422,
      false,
      [
        {
          billAmountPaise: input.billAmountPaise,
          schemeValueAppliedPaise: input.schemeValueAppliedPaise,
        },
      ],
    );
  }
  const extraPaidPaise = input.billAmountPaise - input.schemeValueAppliedPaise;
  if (extraPaidPaise === 0) {
    return { extraPaidPaise: 0 };
  }
  if (!input.extraPaymentMethod) {
    throw new AppError(
      'JEWELLERY_EXTRA_PAYMENT_REQUIRED',
      'extraPaymentMethod is required when the jewellery bill exceeds scheme entitlement',
      422,
    );
  }
  const extraPaymentReference = input.extraPaymentReference?.trim() || undefined;
  if (input.extraPaymentMethod !== 'CASH' && !extraPaymentReference) {
    throw new AppError(
      'JEWELLERY_EXTRA_PAYMENT_REFERENCE_REQUIRED',
      'extraPaymentReference is required for non-cash jewellery top-up payments',
      422,
    );
  }
  return {
    extraPaidPaise,
    extraPaymentMethod: input.extraPaymentMethod,
    extraPaymentReference,
  };
}

function assertJewelleryBillPresent(input: JewellerySettlementInput | undefined) {
  const billNumber = input?.billNumber?.trim();
  if (!billNumber || input?.billAmountPaise == null) {
    throw new AppError(
      'JEWELLERY_BILL_REQUIRED',
      'Jewellery settlement requires billNumber and billAmountPaise',
      422,
    );
  }
  paise(input.billAmountPaise);
  return { billNumber, billAmountPaise: input.billAmountPaise };
}

function randomLockId() {
  return randomUUID().slice(0, 8);
}

export function cashValueFromGoldWeightMg(goldWeightMg: number, ratePerGramPaise: number) {
  paise(ratePerGramPaise);
  if (!Number.isSafeInteger(goldWeightMg) || goldWeightMg < 0) {
    throw new AppError('LEDGER_INTEGRITY_ERROR', 'goldWeightMg is invalid for cash valuation', 500, true);
  }
  const cashAmountPaise = Number((BigInt(goldWeightMg) * BigInt(ratePerGramPaise)) / 1000n);
  if (!Number.isSafeInteger(cashAmountPaise) || cashAmountPaise < 0) {
    throw new AppError('LEDGER_INTEGRITY_ERROR', 'Cash valuation overflowed safe integer range', 500, true);
  }
  return cashAmountPaise;
}

export type CashDisbursementMethod = Exclude<PayoutMethod, 'GOLD' | 'JEWELLERY'>;

export function calculateSchemeSettlement(input: {
  kind: SettlementKind;
  settlementAsset: SettlementAsset;
  ledger: EnrollmentLedger;
  policy: SettlementPolicy;
  goldRate?: { _id: unknown; ratePerGramPaise: number; purity?: string } | null;
  schemeType?: string | null;
  disbursementMethod?: CashDisbursementMethod;
}): SchemeSettlementCalculation {
  const { kind, settlementAsset, ledger, policy, goldRate, schemeType } = input;
  const cashMethod: CashDisbursementMethod = input.disbursementMethod ?? 'CASH';
  const payoutType: PayoutType =
    kind === 'PREMATURE_CLOSE' ? 'PREMATURE_CLOSE' : schemeType === 'CASH' ? 'PAYOUT' : 'REDEEM';
  if (ledger.availablePaise <= 0) {
    throw new AppError(
      'INSUFFICIENT_SCHEME_BALANCE',
      'This scheme has no remaining amount available for settlement',
      409,
      false,
      [{ availablePaise: ledger.availablePaise }],
    );
  }

  if (schemeType === 'CASH') {
    if (settlementAsset === 'JEWELLERY') {
      if (kind === 'PREMATURE_CLOSE') {
        throw new AppError(
          'SETTLEMENT_ASSET_NOT_ALLOWED',
          'Early Nakshathra redemption is cash only',
          409,
        );
      }
      if (!goldRate) {
        throw new AppError(
          'GOLD_RATE_REQUIRED_FOR_JEWELLERY_SETTLEMENT',
          'An active 916 gold rate is required for jewellery settlement',
          409,
        );
      }
      const amountPaise = ledger.availablePaise;
      return {
        settlementAsset: 'JEWELLERY',
        method: 'JEWELLERY',
        payoutType,
        cashBasis: 'CONTRIBUTION_VALUE',
        settlementPrincipalPaise: amountPaise,
        amountPaise,
        goldWeightMg: 0,
        settlementMode: 'JEWELLERY',
        valuation: {
          goldRateId: String(goldRate._id),
          ratePerGramPaise: goldRate.ratePerGramPaise,
          purity: '916',
          goldWeightMg: goldWeightMg(amountPaise, goldRate.ratePerGramPaise),
        },
      };
    }
    if (settlementAsset !== 'CASH') {
      throw new AppError(
        'SETTLEMENT_ASSET_NOT_ALLOWED',
        'Live CASH schemes settle in cash or jewellery at maturity only',
        409,
      );
    }
    const premature =
      kind === 'PREMATURE_CLOSE' ? calculatePrematureClosureSettlement({ schemeType, ledger }) : null;
    const amountPaise = premature?.amountPaise ?? ledger.availablePaise;
    return {
      settlementAsset: 'CASH',
      method: cashMethod,
      payoutType,
      cashBasis: 'CONTRIBUTION_VALUE',
      settlementPrincipalPaise: amountPaise,
      amountPaise,
      goldWeightMg: 0,
      settlementMode: 'CASH',
      valuation: null,
    };
  }

  if (settlementAsset === 'JEWELLERY') {
    throw new AppError(
      'SETTLEMENT_ASSET_NOT_ALLOWED',
      'Jewellery settlement is only available for matured Nakshathra CASH schemes',
      409,
    );
  }

  if (settlementAsset === 'GOLD') {
    if (ledger.availableGoldWeightMg <= 0) {
      throw new AppError(
        'NO_GOLD_AVAILABLE',
        'This scheme has no accumulated gold available to redeem',
        409,
      );
    }
    return {
      settlementAsset: 'GOLD',
      method: 'GOLD',
      payoutType,
      settlementPrincipalPaise: ledger.availablePaise,
      amountPaise: ledger.availablePaise,
      goldWeightMg: ledger.availableGoldWeightMg,
      valuation: null,
    };
  }

  const cashBasis =
    kind === 'PREMATURE_CLOSE' ? policy.prematureClosureCashBasis : policy.maturityCashBasis;
  if (cashBasis === 'CONTRIBUTION_VALUE') {
    return {
      settlementAsset: 'CASH',
      method: cashMethod,
      payoutType,
      cashBasis,
      settlementPrincipalPaise: ledger.availablePaise,
      amountPaise: ledger.availablePaise,
      goldWeightMg: ledger.availableGoldWeightMg,
      valuation: null,
    };
  }

  if (!goldRate) {
    throw new AppError(
      'GOLD_RATE_REQUIRED_FOR_CASH_SETTLEMENT',
      'An active 916 gold rate is required for current-gold-value cash settlement',
      409,
    );
  }
  const cashAmountPaise = cashValueFromGoldWeightMg(
    ledger.availableGoldWeightMg,
    goldRate.ratePerGramPaise,
  );
  if (cashAmountPaise < 1) {
    throw new AppError(
      'INSUFFICIENT_SCHEME_BALANCE',
      'Current gold value for this scheme is too small to settle in cash',
      409,
    );
  }
  return {
    settlementAsset: 'CASH',
    method: cashMethod,
    payoutType,
    cashBasis,
    settlementPrincipalPaise: ledger.availablePaise,
    amountPaise: cashAmountPaise,
    goldWeightMg: ledger.availableGoldWeightMg,
    valuation: {
      goldRateId: String(goldRate._id),
      ratePerGramPaise: goldRate.ratePerGramPaise,
      purity: '916',
      goldWeightMg: ledger.availableGoldWeightMg,
    },
  };
}

export async function findBlockingSettlementActivity(schemeId: unknown, session?: ClientSession) {
  const schemeObjectId = schemeId;
  const schemePayments = await Payment.find({ schemeId: schemeObjectId })
    .session(session ?? null)
    .select('_id')
    .lean();
  const paymentIds = schemePayments.map((row: { _id: unknown }) => row._id);
  const [pendingRefundOnPayment, pendingRefund, blockingIntent, pendingCorrection, successPayout] =
    await Promise.all([
      Payment.findOne(
        mongoose.trusted({
          schemeId: schemeObjectId,
          refundStatus: mongoose.trusted({ $in: ['PENDING', 'REVIEW_REQUIRED'] }),
        }),
      )
        .session(session ?? null)
        .select('_id')
        .lean(),
      Refund.findOne(
        mongoose.trusted({
          schemeId: schemeObjectId,
          status: mongoose.trusted({ $in: ['INITIATED', 'PENDING', 'REVIEW_REQUIRED'] }),
        }),
      )
        .session(session ?? null)
        .select('_id')
        .lean(),
      PaymentIntent.findOne(
        mongoose.trusted({
          schemeId: schemeObjectId,
          status: mongoose.trusted({ $in: [...SETTLEMENT_BLOCKING_INTENT_STATUSES] }),
        }),
      )
        .session(session ?? null)
        .select('_id status')
        .lean(),
      paymentIds.length
        ? PaymentCorrection.findOne(
            mongoose.trusted({
              paymentId: mongoose.trusted({ $in: paymentIds }),
              status: 'PENDING',
            }),
          )
            .session(session ?? null)
            .select('_id')
            .lean()
        : null,
      Payout.findOne({ schemeId: schemeObjectId, status: 'SUCCESS' })
        .session(session ?? null)
        .select('_id')
        .lean(),
    ]);

  return {
    pendingRefundOnPayment,
    pendingRefund,
    blockingIntent,
    pendingCorrection,
    successPayout,
  };
}

function lockStillHeld(enrollment: { settlementLockUntil?: Date | null }, at = new Date()) {
  return Boolean(
    enrollment.settlementLockUntil && new Date(enrollment.settlementLockUntil).getTime() > at.getTime(),
  );
}

export type SettlementActivityFlags = {
  pendingRefundOnPayment?: unknown;
  pendingRefund?: unknown;
  blockingIntent?: unknown;
  pendingCorrection?: unknown;
  successPayout?: unknown;
};

export function collectSettlementBlockersFromState(input: {
  kind: SettlementKind;
  enrollment: any;
  customer: any;
  ledger: EnrollmentLedger;
  policy: SettlementPolicy;
  settlementAsset?: SettlementAsset;
  at?: Date;
  activity: SettlementActivityFlags;
}): string[] {
  const at = input.at ?? new Date();
  const reasons: string[] = [];
  const { enrollment, customer, ledger, policy, kind, activity } = input;

  if (TERMINAL_ENROLLMENT.has(enrollment.status)) reasons.push('SCHEME_ALREADY_SETTLED');
  if (!['ACTIVE', 'MATURED'].includes(enrollment.status)) reasons.push('SCHEME_NOT_REDEEMABLE');
  if (env.KYC_REQUIRED && customer?.kycStatus && customer.kycStatus !== 'VERIFIED') {
    reasons.push('KYC_VERIFICATION_REQUIRED');
  }
  if (lockStillHeld(enrollment, at)) reasons.push('SCHEME_SETTLEMENT_IN_PROGRESS');
  if (ledger.availablePaise <= 0) reasons.push('INSUFFICIENT_SCHEME_BALANCE');

  if (activity.pendingRefundOnPayment || activity.pendingRefund) {
    reasons.push('REDEMPTION_BLOCKED_PENDING_REFUND');
  }
  if (activity.blockingIntent) reasons.push('SCHEME_SETTLEMENT_BLOCKED_PENDING_PAYMENT');
  if (activity.pendingCorrection) reasons.push('SCHEME_SETTLEMENT_BLOCKED_PENDING_CORRECTION');
  if (activity.successPayout) reasons.push('SCHEME_ALREADY_SETTLED');

  const redemptionStart = new Date(enrollment.redemptionStartDate);
  const redemptionEnd = new Date(enrollment.redemptionEndDate);

  if (kind === 'PREMATURE_CLOSE') {
    if (!policy.prematureClosureEnabled) reasons.push('PREMATURE_CLOSURE_DISABLED');
    if (at.getTime() >= redemptionStart.getTime()) reasons.push('USE_MATURITY_REDEMPTION_FLOW');
    if (enrollment.schemeType === 'CASH') {
      const elapsedMonths =
        policy.prematureClosureMinElapsedMonths ?? NAKSHATHRA_PREMATURE_CLOSURE_MIN_ELAPSED_MONTHS;
      if (!isPrematureClosureTimeEligible(enrollment.startDate, elapsedMonths, at)) {
        reasons.push('PREMATURE_CLOSURE_NOT_YET_ELIGIBLE');
      }
    } else if (ledger.paymentsCompleted < policy.prematureClosureMinPaidInstallments) {
      reasons.push('PREMATURE_CLOSURE_MIN_INSTALLMENTS');
    }
    if (
      input.settlementAsset &&
      !policy.prematureClosureSettlementAssets.includes(input.settlementAsset)
    ) {
      reasons.push('SETTLEMENT_ASSET_NOT_ALLOWED');
    }
  } else {
    const cashScheme = enrollment.schemeType === 'CASH';
    if (at.getTime() < redemptionStart.getTime()) {
      reasons.push('REDEMPTION_WINDOW_CLOSED');
    } else if (!cashScheme && at.getTime() >= redemptionEnd.getTime()) {
      reasons.push('REDEMPTION_WINDOW_CLOSED');
    }
    if (!cashScheme && ledger.paymentsCompleted !== 11) {
      reasons.push('INSTALLMENTS_INCOMPLETE');
    }
    if (
      input.settlementAsset &&
      !policy.maturitySettlementAssets.includes(input.settlementAsset)
    ) {
      reasons.push('SETTLEMENT_ASSET_NOT_ALLOWED');
    }
  }

  return [...new Set(reasons)];
}

export async function collectSettlementBlockers(input: {
  kind: SettlementKind;
  enrollment: any;
  customer: any;
  ledger: EnrollmentLedger;
  policy: SettlementPolicy;
  settlementAsset?: SettlementAsset;
  at?: Date;
  session?: ClientSession;
}): Promise<string[]> {
  const activity = await findBlockingSettlementActivity(input.enrollment._id, input.session);
  return collectSettlementBlockersFromState({ ...input, activity });
}

export function settlementRequestHash(input: {
  customerId: string;
  schemeId: string;
  kind: SettlementKind;
  settlementAsset: SettlementAsset;
  payoutDate: Date;
  jewellery?: {
    billNumber?: string;
    billAmountPaise?: number;
    extraPaymentMethod?: string;
    extraPaymentReference?: string;
  };
}) {
  const zoned = toZonedTime(input.payoutDate, BUSINESS_TZ);
  const payoutBusinessDate = `${zoned.getFullYear()}-${String(zoned.getMonth() + 1).padStart(2, '0')}-${String(zoned.getDate()).padStart(2, '0')}`;
  return sha256Canonical({
    customerId: input.customerId,
    schemeId: input.schemeId,
    kind: input.kind,
    settlementAsset: input.settlementAsset,
    payoutBusinessDate,
    ...(input.settlementAsset === 'JEWELLERY'
      ? {
          billNumber: input.jewellery?.billNumber?.trim() ?? '',
          billAmountPaise: input.jewellery?.billAmountPaise ?? 0,
          extraPaymentMethod: input.jewellery?.extraPaymentMethod ?? '',
          extraPaymentReference: input.jewellery?.extraPaymentReference?.trim() ?? '',
        }
      : {}),
  });
}

export function defaultMaturityIdempotencyKey(
  schemeId: string,
  settlementAsset: SettlementAsset,
  schemeType?: string | null,
) {
  return schemeType === 'CASH'
    ? `PAYOUT:${schemeId}:${settlementAsset}`
    : `REDEEM:${schemeId}:${settlementAsset}`;
}

function assertPayoutDateNotInFuture(payoutDate: Date, now = new Date()) {
  const { end } = businessDayRange(now);
  if (payoutDate.getTime() >= end.getTime()) {
    throw new AppError(
      'PAYOUT_DATE_IN_FUTURE',
      'payoutDate cannot be after the current business day',
      422,
    );
  }
}

function assertIdempotentPayoutReplay(
  existing: { requestHash?: string | null },
  requestHash: string,
) {
  if (existing.requestHash && existing.requestHash !== requestHash) {
    throw new AppError(
      'IDEMPOTENCY_KEY_REUSED',
      'Idempotency key was reused with a different settlement request',
      409,
    );
  }
}

function throwFirstBlocker(reasons: string[]) {
  const code = reasons[0];
  if (!code) return;
  const messages: Record<string, string> = {
    SCHEME_ALREADY_SETTLED: 'Scheme is already settled',
    SCHEME_NOT_REDEEMABLE: 'Scheme must be active or matured to settle',
    KYC_VERIFICATION_REQUIRED: 'KYC must be verified before this action',
    SCHEME_SETTLEMENT_IN_PROGRESS:
      'Another refund or redemption is already in progress for this scheme. Retry shortly.',
    INSUFFICIENT_SCHEME_BALANCE: 'This scheme has no remaining amount available for settlement',
    REDEMPTION_BLOCKED_PENDING_REFUND:
      'Redemption is blocked while a refund is in progress for this scheme',
    SCHEME_SETTLEMENT_BLOCKED_PENDING_PAYMENT:
      'Settlement is blocked while a payment attempt is still pending or uncertain',
    SCHEME_SETTLEMENT_BLOCKED_PENDING_CORRECTION:
      'Settlement is blocked while a payment correction is pending',
    PREMATURE_CLOSURE_DISABLED: 'Premature closure is not enabled for this scheme',
    USE_MATURITY_REDEMPTION_FLOW:
      'This scheme is in its redemption window. Use the maturity redemption flow',
    PREMATURE_CLOSURE_MIN_INSTALLMENTS:
      'This scheme has not reached the minimum paid installments for premature closure',
    PREMATURE_CLOSURE_NOT_YET_ELIGIBLE:
      'Early redemption is available only after 6 elapsed scheme months',
    SETTLEMENT_ASSET_NOT_ALLOWED: 'This settlement asset is not allowed by the scheme contract',
    REDEMPTION_WINDOW_CLOSED: 'Gold can be redeemed only during month 12 of the scheme',
    INSTALLMENTS_INCOMPLETE: 'All 11 monthly installments must be completed before redemption',
    GOLD_RATE_REQUIRED_FOR_JEWELLERY_SETTLEMENT:
      'An active 916 gold rate is required for jewellery settlement',
    GOLD_RATE_REQUIRED_FOR_CASH_SETTLEMENT:
      'An active 916 gold rate is required for current-gold-value cash settlement',
  };
  throw new AppError(code, messages[code] ?? code, 409, code === 'SCHEME_SETTLEMENT_IN_PROGRESS');
}

async function loadEnrollmentBundle(enrollmentId: string, session?: ClientSession) {
  const enrollment = await SchemeEnrollment.findById(enrollmentId).session(session ?? null);
  if (!enrollment) throw new AppError('SCHEME_NOT_FOUND', 'Enrollment not found', 404);
  const customer = await Customer.findById(enrollment.customerId).session(session ?? null);
  if (!customer) throw new AppError('CUSTOMER_NOT_FOUND', 'Customer not found', 404);
  const ledger = await aggregateEnrollmentLedger(String(enrollment._id), session);
  const policy = resolveSettlementPolicy({
    ...enrollment.toObject(),
    planSnapshot: enrollment.planSnapshot,
  });
  return { enrollment, customer, ledger, policy };
}

function previewPayload(
  enrollment: any,
  ledger: EnrollmentLedger,
  policy: SettlementPolicy,
  kind: SettlementKind,
  calculation: SchemeSettlementCalculation | null,
  blockingReasons: string[],
  settlementAsset?: SettlementAsset,
  extras?: {
    currentGoldRate?: {
      goldRateId: string;
      ratePerGramPaise: number;
      purity: '916';
      effectiveFrom?: Date;
    } | null;
    goldWeightEquivalentMg?: number | null;
  },
) {
  const earlyTimeBlocked =
    kind === 'PREMATURE_CLOSE' &&
    (blockingReasons.includes('PREMATURE_CLOSURE_NOT_YET_ELIGIBLE') ||
      blockingReasons.includes('USE_MATURITY_REDEMPTION_FLOW') ||
      blockingReasons.includes('PREMATURE_CLOSURE_DISABLED'));
  const allowedSettlementModes = earlyTimeBlocked ? [] : allowedSettlementModesFor(kind, policy);
  const jewelleryAllowed = allowedSettlementModes.includes('JEWELLERY');
  const elapsedMonthsForPreview =
    policy.prematureClosureMinElapsedMonths ??
    (enrollment.schemeType === 'CASH' ? NAKSHATHRA_PREMATURE_CLOSURE_MIN_ELAPSED_MONTHS : undefined);
  const prematureClosureEligibleAt =
    kind === 'PREMATURE_CLOSE' && elapsedMonthsForPreview && enrollment.startDate
      ? prematureClosureEligibilityBoundary(new Date(enrollment.startDate), elapsedMonthsForPreview)
      : null;
  return {
    eligible: blockingReasons.length === 0,
    enrollmentId: String(enrollment._id),
    enrollmentNumber: enrollment.enrollmentNumber,
    status: enrollment.status,
    paymentsCompleted: ledger.paymentsCompleted,
    totalPaidPaise: ledger.totalPaidPaise,
    availablePrincipalPaise: ledger.availablePaise,
    availableGoldWeightMg: ledger.availableGoldWeightMg,
    redemptionType: kind === 'PREMATURE_CLOSE' ? ('EARLY' as const) : ('MATURITY' as const),
    settlementMode:
      settlementAsset === 'JEWELLERY' || settlementAsset === 'CASH' ? settlementAsset : null,
    allowedSettlementModes,
    schemeEntitlementPaise: ledger.availablePaise,
    settlementAsset: settlementAsset ?? null,
    cashBasis: calculation?.cashBasis ?? null,
    settlementPrincipalPaise: calculation?.settlementPrincipalPaise ?? null,
    cashAmountPaise:
      calculation?.settlementAsset === 'CASH' || calculation?.settlementAsset === 'JEWELLERY'
        ? calculation.amountPaise
        : null,
    goldWeightMg: calculation?.goldWeightMg ?? null,
    goldWeightEquivalentMg: extras?.goldWeightEquivalentMg ?? calculation?.valuation?.goldWeightMg ?? null,
    currentGoldRate: jewelleryAllowed ? extras?.currentGoldRate ?? null : null,
    valuation: calculation?.valuation ?? null,
    allowedSettlementAssets:
      kind === 'PREMATURE_CLOSE'
        ? policy.prematureClosureSettlementAssets
        : policy.maturitySettlementAssets,
    policy: {
      prematureClosureEnabled: policy.prematureClosureEnabled,
      minimumPaidInstallments: policy.prematureClosureMinPaidInstallments,
      prematureClosureMinElapsedMonths: policy.prematureClosureMinElapsedMonths ?? null,
      prematureClosureCashBasis: policy.prematureClosureCashBasis,
      maturityCashBasis: policy.maturityCashBasis,
    },
    prematureClosureEligibleAt,
    reason: blockingReasons[0] ?? null,
    makingChargeWaiverPercent: enrollment.makingChargeWaiverPercent,
    gstRateBasisPoints: enrollment.gstRateBasisPoints,
    blockingReasons,
  };
}

export async function previewSchemeSettlement(input: {
  enrollmentId: string;
  kind: SettlementKind;
  settlementAsset?: SettlementAsset;
  at?: Date;
}) {
  const at = input.at ?? new Date();
  const { enrollment, customer, ledger, policy } = await loadEnrollmentBundle(input.enrollmentId);
  const blockingReasons = await collectSettlementBlockers({
    kind: input.kind,
    enrollment: enrollment.toObject(),
    customer,
    ledger,
    policy,
    settlementAsset: input.settlementAsset,
    at,
  });
  const jewelleryAllowed = allowedSettlementModesFor(input.kind, policy).includes('JEWELLERY');
  const needsGoldWeightCashRate =
    enrollment.schemeType !== 'CASH' &&
    input.settlementAsset === 'CASH' &&
    (input.kind === 'PREMATURE_CLOSE'
      ? policy.prematureClosureCashBasis
      : policy.maturityCashBasis) === 'CURRENT_GOLD_VALUE';
  const needsJewelleryRate =
    enrollment.schemeType === 'CASH' &&
    (jewelleryAllowed || input.settlementAsset === 'JEWELLERY');

  let goldRate: Awaited<ReturnType<typeof activeGoldRate>> | null = null;
  if (needsGoldWeightCashRate || needsJewelleryRate) {
    try {
      goldRate = await activeGoldRate(at);
    } catch {
      goldRate = null;
    }
  }
  if (input.settlementAsset === 'JEWELLERY' && !goldRate) {
    blockingReasons.push('GOLD_RATE_REQUIRED_FOR_JEWELLERY_SETTLEMENT');
  }
  if (needsGoldWeightCashRate && !goldRate) {
    blockingReasons.push('GOLD_RATE_REQUIRED_FOR_CASH_SETTLEMENT');
  }

  let calculation: SchemeSettlementCalculation | null = null;
  if (input.settlementAsset && !blockingReasons.length) {
    try {
      calculation = calculateSchemeSettlement({
        kind: input.kind,
        settlementAsset: input.settlementAsset,
        ledger,
        policy,
        goldRate,
        schemeType: enrollment.schemeType,
      });
    } catch (error: any) {
      blockingReasons.push(error?.code ?? 'SETTLEMENT_CALCULATION_FAILED');
      calculation = null;
    }
  }

  const goldWeightEquivalentMg =
    jewelleryAllowed && goldRate && ledger.availablePaise > 0
      ? goldWeightMg(ledger.availablePaise, goldRate.ratePerGramPaise)
      : (calculation?.valuation?.goldWeightMg ?? null);

  return previewPayload(
    enrollment,
    ledger,
    policy,
    input.kind,
    calculation,
    blockingReasons,
    input.settlementAsset,
    {
      currentGoldRate: goldRate
        ? {
            goldRateId: String(goldRate._id),
            ratePerGramPaise: goldRate.ratePerGramPaise,
            purity: '916',
            effectiveFrom: goldRate.effectiveFrom,
          }
        : null,
      goldWeightEquivalentMg,
    },
  );
}

export async function executeSchemeSettlement(
  input: {
    enrollmentId: string;
    customerId?: string;
    kind: SettlementKind;
    settlementAsset: SettlementAsset;
    payoutDate: Date;
    reason?: string;
    referenceNumber?: string;
    notes?: string;
    idempotencyKey?: string;
    disbursementMethod?: CashDisbursementMethod;
    jewellery?: JewellerySettlementInput;
  },
  context: AuditContext & { actorId: string },
) {
  const operationAt = new Date();
  const valuationAt = operationAt;
  const result = await withMongoTransaction(async (session) => {
    await assertDateInOpenPeriod(input.payoutDate, session);
    assertPayoutDateNotInFuture(input.payoutDate, operationAt);
    const { enrollment, customer, policy } = await loadEnrollmentBundle(
      input.enrollmentId,
      session,
    );
    if (input.customerId && String(customer._id) !== input.customerId) {
      throw new AppError('SCHEME_NOT_FOUND', 'Customer scheme not found', 404);
    }
    await assertCustomerKycVerified(String(customer._id), session);

    const idempotencyKey =
      input.idempotencyKey?.trim() ||
      (input.kind === 'REDEEM'
        ? defaultMaturityIdempotencyKey(
            String(enrollment._id),
            input.settlementAsset,
            enrollment.schemeType,
          )
        : undefined);
    if (!idempotencyKey) {
      throw new AppError('VALIDATION_ERROR', 'idempotencyKey is required for settlement', 422);
    }
    const requestHash = settlementRequestHash({
      customerId: String(customer._id),
      schemeId: String(enrollment._id),
      kind: input.kind,
      settlementAsset: input.settlementAsset,
      payoutDate: input.payoutDate,
      jewellery: input.jewellery,
    });

    const existing = await Payout.findOne({
      schemeId: enrollment._id,
      idempotencyKey,
    }).session(session);
    if (existing) {
      assertIdempotentPayoutReplay(existing, requestHash);
      return { payout: existing, inventoryMg: null, replayed: true };
    }
    if (TERMINAL_ENROLLMENT.has(enrollment.status)) {
      throw new AppError('SCHEME_ALREADY_SETTLED', 'Scheme is already settled', 409);
    }

    const lockOwner = `settlement:${context.actorId}:${context.requestId ?? randomLockId()}`;
    await claimEnrollmentSettlementLock(
      enrollment._id,
      lockOwner,
      session,
      SETTLEMENT_LOCK_REDEMPTION_STATUSES,
    );

    try {
      const freshLedger = await aggregateEnrollmentLedger(String(enrollment._id), session);
      const blockers = await collectSettlementBlockers({
        kind: input.kind,
        enrollment: { ...enrollment.toObject(), settlementLockUntil: null },
        customer,
        ledger: freshLedger,
        policy,
        settlementAsset: input.settlementAsset,
        at: operationAt,
        session,
      });
      const withoutLock = blockers.filter((code) => code !== 'SCHEME_SETTLEMENT_IN_PROGRESS');
      throwFirstBlocker(withoutLock);

      let goldRate = null;
      const needsGoldWeightCashRate =
        enrollment.schemeType !== 'CASH' &&
        input.settlementAsset === 'CASH' &&
        (input.kind === 'PREMATURE_CLOSE'
          ? policy.prematureClosureCashBasis
          : policy.maturityCashBasis) === 'CURRENT_GOLD_VALUE';
      const needsJewelleryRate =
        enrollment.schemeType === 'CASH' && input.settlementAsset === 'JEWELLERY';
      if (needsGoldWeightCashRate || needsJewelleryRate) {
        try {
          goldRate = await activeGoldRate(valuationAt, session);
        } catch {
          throw new AppError(
            needsJewelleryRate
              ? 'GOLD_RATE_REQUIRED_FOR_JEWELLERY_SETTLEMENT'
              : 'GOLD_RATE_REQUIRED_FOR_CASH_SETTLEMENT',
            needsJewelleryRate
              ? 'An active 916 gold rate is required for jewellery settlement'
              : 'An active 916 gold rate is required for current-gold-value cash settlement',
            409,
          );
        }
      }

      const calculation = calculateSchemeSettlement({
        kind: input.kind,
        settlementAsset: input.settlementAsset,
        ledger: freshLedger,
        policy,
        goldRate,
        schemeType: enrollment.schemeType,
        disbursementMethod: input.disbursementMethod,
      });

      let jewelleryFields: Record<string, unknown> = {};
      if (calculation.settlementAsset === 'JEWELLERY') {
        const bill = assertJewelleryBillPresent(input.jewellery);
        const topUp = jewelleryPurchaseTopUp({
          billAmountPaise: bill.billAmountPaise,
          schemeValueAppliedPaise: calculation.settlementPrincipalPaise,
          extraPaymentMethod: input.jewellery?.extraPaymentMethod,
          extraPaymentReference: input.jewellery?.extraPaymentReference,
        });
        jewelleryFields = {
          settlementMode: 'JEWELLERY',
          billNumber: bill.billNumber,
          billAmountPaise: bill.billAmountPaise,
          schemeValueAppliedPaise: calculation.settlementPrincipalPaise,
          extraPaidPaise: topUp.extraPaidPaise,
          extraPaymentMethod: topUp.extraPaymentMethod,
          extraPaymentReference: topUp.extraPaymentReference,
        };
      } else if (calculation.settlementMode === 'CASH') {
        jewelleryFields = { settlementMode: 'CASH' };
      }

      const policySnapshot = buildPlanSnapshot({
        ...enrollment.planSnapshot,
        ...enrollment.toObject(),
      });

      let payout;
      try {
        [payout] = await Payout.create(
          [
            {
              customerId: customer._id,
              schemeId: enrollment._id,
              payoutType: calculation.payoutType,
              method: calculation.method,
              amountPaise: calculation.amountPaise,
              settlementPrincipalPaise: calculation.settlementPrincipalPaise,
              goldWeightMg: calculation.goldWeightMg,
              cashBasis: calculation.cashBasis,
              valuationGoldRateId: calculation.valuation?.goldRateId,
              valuationGoldRatePerGramPaise: calculation.valuation?.ratePerGramPaise,
              valuationGoldWeightMg: calculation.valuation?.goldWeightMg,
              policySnapshot,
              idempotencyKey,
              requestHash,
              reason: input.reason,
              payoutDate: input.payoutDate,
              referenceNumber: input.referenceNumber,
              notes: input.notes,
              makingChargeWaiverPercent: enrollment.makingChargeWaiverPercent,
              gstRateBasisPoints: enrollment.gstRateBasisPoints,
              createdBy: context.actorId,
              ...jewelleryFields,
            },
          ],
          { session },
        );
      } catch (error: any) {
        if (error?.code === 11000) {
          const replay = await Payout.findOne({
            schemeId: enrollment._id,
            idempotencyKey,
          }).session(session);
          if (replay) {
            assertIdempotentPayoutReplay(replay, requestHash);
            return { payout: replay, inventoryMg: null, replayed: true };
          }
          throw new AppError('SCHEME_ALREADY_SETTLED', 'Scheme is already settled', 409);
        }
        throw error;
      }

      if (calculation.settlementAsset === 'JEWELLERY' && calculation.valuation?.goldRateId) {
        await GoldRate.updateOne(
          { _id: calculation.valuation.goldRateId },
          { $inc: { usageCount: 1 } },
          { session },
        );
      }

      const afterLedger = await syncEnrollmentFromLedger(String(enrollment._id), session);
      if (afterLedger.availableGoldWeightMg !== 0 || afterLedger.availablePaise !== 0) {
        throw new AppError(
          'LEDGER_INTEGRITY_ERROR',
          'Settlement must settle the full remaining customer liability',
          500,
          true,
        );
      }

      const status =
        input.kind === 'PREMATURE_CLOSE' || enrollment.schemeType === 'CASH' ? 'CLOSED' : 'REDEEMED';
      const reason =
        input.reason ??
        (input.kind === 'PREMATURE_CLOSE'
          ? `Premature closure settled in ${calculation.method}`
          : enrollment.schemeType === 'CASH'
            ? `Cash payout of ${calculation.amountPaise} paise`
            : `Redeemed ${calculation.goldWeightMg} mg of accumulated gold`);
      await SchemeEnrollment.updateOne(
        { _id: enrollment._id },
        {
          $set: { status },
          $push: {
            statusHistory: {
              status,
              at: new Date(),
              actorId: context.actorId,
              reason,
            },
          },
        },
        { session },
      );

      let inventoryMg: number | null = null;
      if (calculation.method === 'GOLD') {
        const inventoryResult = await recordPayoutGoldIssue(payout, context, session);
        inventoryMg = inventoryResult?.inventoryMg ?? null;
      }

      await audit(session, context, 'PAYOUT_CREATED', 'Payout', payout._id, undefined, {
        ...payout.toObject(),
        redemptionType: input.kind === 'PREMATURE_CLOSE' ? 'EARLY' : 'MATURITY',
        settlementMode: payout.settlementMode ?? calculation.settlementMode ?? null,
      });
      await outbox(session, 'PAYOUT_CREATED', 'Payout', payout._id, {
        customerId: customer._id,
        schemeId: enrollment._id,
        payoutType: calculation.payoutType,
        method: calculation.method,
        settlementMode: payout.settlementMode ?? calculation.settlementMode ?? null,
        amountPaise: calculation.amountPaise,
        settlementPrincipalPaise: calculation.settlementPrincipalPaise,
        goldWeightMg: calculation.goldWeightMg,
        extraPaidPaise: payout.extraPaidPaise ?? 0,
        billNumber: payout.billNumber ?? null,
      });
      if (input.kind === 'PREMATURE_CLOSE') {
        await outbox(session, 'ENROLLMENT_PREMATURE_CLOSED', 'SchemeEnrollment', enrollment._id, {
          customerId: customer._id,
          payoutId: payout._id,
          method: calculation.method,
        });
      }

      await clearEnrollmentSettlementLock(enrollment._id, lockOwner, session);
      return { payout, inventoryMg, replayed: false };
    } catch (error) {
      await clearEnrollmentSettlementLock(enrollment._id, lockOwner, session);
      throw error;
    }
  }, context.requestId);

  if (result.inventoryMg != null && result.inventoryMg < 0) {
    await reportNegativeInventoryException(result.payout._id, result.inventoryMg);
  }
  return result.payout;
}

export function resolveRedemptionAsset(
  requested: SettlementAsset | undefined,
  policy: SettlementPolicy,
): SettlementAsset {
  if (requested) {
    if (!policy.maturitySettlementAssets.includes(requested)) {
      throw new AppError(
        'SETTLEMENT_ASSET_NOT_ALLOWED',
        'This settlement asset is not allowed by the scheme contract',
        409,
      );
    }
    return requested;
  }
  const onlyAsset = policy.maturitySettlementAssets[0];
  if (policy.maturitySettlementAssets.length === 1 && onlyAsset) return onlyAsset;
  if (policy.maturitySettlementAssets.includes('GOLD')) return 'GOLD';
  if (policy.maturitySettlementAssets.includes('CASH')) return 'CASH';
  if (policy.maturitySettlementAssets.includes('JEWELLERY')) return 'JEWELLERY';
  throw new AppError('SETTLEMENT_ASSET_NOT_ALLOWED', 'No settlement asset is allowed', 409);
}

export { resolvePaymentWindow, resolveSettlementPolicy };
