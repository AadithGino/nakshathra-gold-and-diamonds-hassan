export const ROLES = ['ADMIN', 'STAFF', 'CUSTOMER'] as const;
export type Role = (typeof ROLES)[number];

export const PAYMENT_METHODS = ['CASH', 'PHONEPE', 'UPI', 'BANK', 'CARD'] as const;
export type PaymentMethod = (typeof PAYMENT_METHODS)[number];

export const PAYMENT_STATUSES = [
  'INITIATED',
  'PENDING',
  'SUCCESS',
  'FAILED',
  'EXPIRED',
  'CANCELLED',
  'REVERSED',
  'REFUNDED',
] as const;
export type PaymentStatus = (typeof PAYMENT_STATUSES)[number];

/** PaymentIntent lifecycle includes a short-lived provider-create claim state. */
export const PAYMENT_INTENT_STATUSES = [
  'INITIATED',
  'PROVIDER_CREATING',
  'PROVIDER_CREATE_UNCERTAIN',
  'PENDING',
  'SUCCESS',
  'FAILED',
  'EXPIRED',
  'CANCELLED',
  'REVERSED',
  'REFUNDED',
  /**
   * Terminal-for-recovery operational state: PhonePe reported SUCCESS but the
   * amount could not be safely applied (e.g. another PaymentIntent already
   * owns the scheme month). Never polled again; requires manual ops review.
   */
  'REVIEW_REQUIRED',
] as const;
export type PaymentIntentStatus = (typeof PAYMENT_INTENT_STATUSES)[number];

/** PaymentIntent statuses that still hold an active PHONEPE checkout attempt. */
export const PAYMENT_INTENT_ACTIVE_ATTEMPT_STATUSES = [
  'INITIATED',
  'PROVIDER_CREATING',
  'PROVIDER_CREATE_UNCERTAIN',
  'PENDING',
] as const;

/** PaymentIntent statuses that stop all further automatic status polling. */
export const PAYMENT_INTENT_TERMINAL_STATUSES = [
  'SUCCESS',
  'FAILED',
  'EXPIRED',
  'CANCELLED',
  'REVERSED',
  'REFUNDED',
  'REVIEW_REQUIRED',
] as const;

export const PHONEPE_CHECKOUT_CHANNELS = ['WEB', 'SDK'] as const;
export type PhonePeCheckoutChannel = (typeof PHONEPE_CHECKOUT_CHANNELS)[number];

export const PHONEPE_IDEMPOTENCY_SCOPES = [
  'PHONEPE_CUSTOMER_WEB',
  'PHONEPE_CUSTOMER_SDK',
  'PHONEPE_STAFF_WEB',
  'PHONEPE_STAFF_SDK',
] as const;
export type PhonePeIdempotencyScope = (typeof PHONEPE_IDEMPOTENCY_SCOPES)[number];

export const PAYMENT_FINAL_STATUS_SOURCES = [
  'WEBHOOK',
  'CUSTOMER_STATUS_CHECK',
  'RECOVERY_WORKER',
  'DEV_AUTO_SUCCESS',
] as const;
export type PaymentFinalStatusSource = (typeof PAYMENT_FINAL_STATUS_SOURCES)[number];

/** Refund attempt lifecycle. REVIEW_REQUIRED is terminal for recovery (manual ops). */
export const REFUND_STATUSES = [
  'INITIATED',
  'PENDING',
  'SUCCESS',
  'FAILED',
  'REVIEW_REQUIRED',
] as const;
export type RefundStatus = (typeof REFUND_STATUSES)[number];

export const PAYMENT_REFUND_STATUSES = [
  'PENDING',
  'SUCCESS',
  'FAILED',
  'REVIEW_REQUIRED',
] as const;
export type PaymentRefundStatus = (typeof PAYMENT_REFUND_STATUSES)[number];

export const SCHEME_TYPES = ['GOLD_WEIGHT', 'CASH'] as const;

/** Named cap formulas. Nakshathra live CASH uses AVERAGE_SUCCESSFUL_PAYMENT_FIRST_6. */
export const CAP_STRATEGIES = ['AVERAGE_SUCCESSFUL_PAYMENT_FIRST_6', 'NONE'] as const;
export type CapStrategy = (typeof CAP_STRATEGIES)[number];
export const PAYMENT_WINDOW_TYPES = ['FIXED_DAY', 'DATE_RANGE'] as const;
export type PaymentWindowType = (typeof PAYMENT_WINDOW_TYPES)[number];
export const SETTLEMENT_ASSETS = ['GOLD', 'CASH', 'JEWELLERY'] as const;
export type SettlementAsset = (typeof SETTLEMENT_ASSETS)[number];
export const SETTLEMENT_MODES = ['CASH', 'JEWELLERY'] as const;
export type SettlementMode = (typeof SETTLEMENT_MODES)[number];
export const REDEMPTION_TYPES = ['EARLY', 'MATURITY'] as const;
export type RedemptionType = (typeof REDEMPTION_TYPES)[number];
export const JEWELLERY_EXTRA_PAYMENT_METHODS = ['CASH', 'UPI', 'CARD', 'BANK'] as const;
export type JewelleryExtraPaymentMethod = (typeof JEWELLERY_EXTRA_PAYMENT_METHODS)[number];
export const CASH_SETTLEMENT_BASES = ['CONTRIBUTION_VALUE', 'CURRENT_GOLD_VALUE'] as const;
export type CashSettlementBasis = (typeof CASH_SETTLEMENT_BASES)[number];
export const PAYOUT_TYPES = ['PAYOUT', 'REDEEM', 'PREMATURE_CLOSE'] as const;
export type PayoutType = (typeof PAYOUT_TYPES)[number];
export const PAYOUT_METHODS = ['GOLD', 'CASH', 'BANK', 'UPI', 'JEWELLERY'] as const;
export type PayoutMethod = (typeof PAYOUT_METHODS)[number];
export const CASH_DISBURSEMENT_METHODS = ['CASH', 'BANK', 'UPI'] as const;
export type CashDisbursementMethod = (typeof CASH_DISBURSEMENT_METHODS)[number];
export const ENROLLMENT_STATUSES = [
  'ACTIVE',
  'MATURED',
  'REDEEMED',
  'CLOSED',
  'WITHDRAWN',
  'CANCELLED',
] as const;

export const FINANCIAL_EXCEPTION_TYPES = [
  'PAYMENT_PENDING_TOO_LONG',
  'PAYMENT_STATUS_CHECK_FAILED',
  'PAYMENT_AMOUNT_MISMATCH',
  'PAYMENT_FINALIZATION_FAILED',
  'REFUND_PENDING_TOO_LONG',
  'REFUND_STATUS_CHECK_FAILED',
  'REFUND_AMOUNT_MISMATCH',
  'REFUND_FAILED',
  'REFUND_BLOCKED_AFTER_REDEMPTION',
  'REFUND_COMPLETED_AFTER_REDEMPTION',
  'REFUND_MISSING_RECOVERY_SCHEDULE',
  'CHARGEBACK_REPORTED',
  'UNMATCHED_EXTERNAL_CREDIT',
  'UNMATCHED_EXTERNAL_DEBIT',
  'OUTBOX_DELIVERY_FAILED',
  'NEGATIVE_GOLD_INVENTORY',
  'NEGATIVE_GOLD_LIABILITY',
  'DUPLICATE_GATEWAY_CAPTURE',
  'LATE_GATEWAY_PAYMENT_AFTER_PERIOD_CLOSE',
] as const;
export type FinancialExceptionType = (typeof FINANCIAL_EXCEPTION_TYPES)[number];

export const FINANCIAL_EXCEPTION_SEVERITIES = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'] as const;
export type FinancialExceptionSeverity = (typeof FINANCIAL_EXCEPTION_SEVERITIES)[number];

export const FINANCIAL_EXCEPTION_STATUSES = [
  'OPEN',
  'ACKNOWLEDGED',
  'RESOLVED',
  'IGNORED',
] as const;
export type FinancialExceptionStatus = (typeof FINANCIAL_EXCEPTION_STATUSES)[number];

export const FINANCIAL_EXCEPTION_AGING_BUCKETS = [
  'NEW',
  'WARNING',
  'OVERDUE',
  'CRITICAL',
] as const;
export type FinancialExceptionAgingBucket =
  (typeof FINANCIAL_EXCEPTION_AGING_BUCKETS)[number];

export const SUSPENSE_ENTRY_TYPES = ['UNMATCHED_CREDIT', 'UNMATCHED_DEBIT'] as const;
export type SuspenseEntryType = (typeof SUSPENSE_ENTRY_TYPES)[number];

export const SUSPENSE_ENTRY_STATUSES = ['OPEN', 'RESOLVED', 'WRITTEN_OFF'] as const;
export type SuspenseEntryStatus = (typeof SUSPENSE_ENTRY_STATUSES)[number];

export const SUSPENSE_ENTRY_SOURCES = [
  'PHONEPE_DASHBOARD',
  'BANK_STATEMENT',
  'EMAIL',
  'SUPPORT',
  'MANUAL',
] as const;
export type SuspenseEntrySource = (typeof SUSPENSE_ENTRY_SOURCES)[number];

export const DISPUTE_STATUSES = [
  'OPEN',
  'EVIDENCE_REQUIRED',
  'SUBMITTED',
  'WON',
  'LOST',
  'CLOSED',
] as const;
export type DisputeStatus = (typeof DISPUTE_STATUSES)[number];

export const DISPUTE_DETECTED_VIA = [
  'PHONEPE_DASHBOARD',
  'PHONEPE_EMAIL',
  'PHONEPE_SUPPORT',
  'SETTLEMENT_DEDUCTION',
  'BANK',
  'OTHER',
] as const;
export type DisputeDetectedVia = (typeof DISPUTE_DETECTED_VIA)[number];

export const GATEWAY_SETTLEMENT_STATUSES = ['RECORDED', 'BANK_CONFIRMED', 'CLOSED'] as const;
export type GatewaySettlementStatus = (typeof GATEWAY_SETTLEMENT_STATUSES)[number];

export const GATEWAY_SETTLEMENT_SOURCES = [
  'PHONEPE_DASHBOARD',
  'PHONEPE_REPORT',
  'MANUAL',
] as const;
export type GatewaySettlementSource = (typeof GATEWAY_SETTLEMENT_SOURCES)[number];

export const GOLD_INVENTORY_MOVEMENT_TYPES = [
  'OPENING_STOCK',
  'PURCHASE',
  'ISSUE_TO_CUSTOMER',
  'RETURN_FROM_CUSTOMER',
  'POSITIVE_ADJUSTMENT',
  'NEGATIVE_ADJUSTMENT',
] as const;
export type GoldInventoryMovementType = (typeof GOLD_INVENTORY_MOVEMENT_TYPES)[number];

export const GOLD_INVENTORY_DIRECTIONS = ['IN', 'OUT'] as const;
export type GoldInventoryDirection = (typeof GOLD_INVENTORY_DIRECTIONS)[number];

export const ACCOUNTING_PERIOD_STATUSES = ['OPEN', 'CLOSED'] as const;
export type AccountingPeriodStatus = (typeof ACCOUNTING_PERIOD_STATUSES)[number];

export const KYC_STATUSES = ['NOT_SUBMITTED', 'PENDING', 'VERIFIED', 'REJECTED'] as const;
export type KycStatus = (typeof KYC_STATUSES)[number];

export const PLAN_SNAPSHOT_SOURCES = ['ENROLLMENT', 'LEGACY_BACKFILL'] as const;
export type PlanSnapshotSource = (typeof PLAN_SNAPSHOT_SOURCES)[number];
