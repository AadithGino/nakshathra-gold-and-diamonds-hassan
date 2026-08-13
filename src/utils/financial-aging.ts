import type {
  FinancialExceptionAgingBucket,
  FinancialExceptionType,
} from '../models/enums.js';

export const FINANCIAL_AGING_INTERVAL_MS = 15 * 60_000;
export const FINANCIAL_AGING_BATCH_SIZE = 100;

const BUCKET_RANK: Record<FinancialExceptionAgingBucket, number> = {
  NEW: 0,
  WARNING: 1,
  OVERDUE: 2,
  CRITICAL: 3,
};

export function isHigherAgingBucket(
  next: FinancialExceptionAgingBucket,
  current: FinancialExceptionAgingBucket | undefined | null,
) {
  if (!current) return next !== 'NEW';
  return BUCKET_RANK[next] > BUCKET_RANK[current];
}

export function maxAgingBucket(
  a: FinancialExceptionAgingBucket,
  b: FinancialExceptionAgingBucket,
): FinancialExceptionAgingBucket {
  return BUCKET_RANK[a] >= BUCKET_RANK[b] ? a : b;
}

function paymentStyleBucket(ageMs: number): FinancialExceptionAgingBucket {
  if (ageMs < 30 * 60_000) return 'NEW';
  if (ageMs < 24 * 60 * 60_000) return 'WARNING';
  if (ageMs < 3 * 24 * 60 * 60_000) return 'OVERDUE';
  return 'CRITICAL';
}

function refundStyleBucket(ageMs: number): FinancialExceptionAgingBucket {
  if (ageMs < 6 * 60 * 60_000) return 'NEW';
  if (ageMs < 24 * 60 * 60_000) return 'WARNING';
  if (ageMs < 3 * 24 * 60 * 60_000) return 'OVERDUE';
  return 'CRITICAL';
}

function suspenseStyleBucket(ageMs: number): FinancialExceptionAgingBucket {
  if (ageMs <= 24 * 60 * 60_000) return 'NEW';
  if (ageMs <= 3 * 24 * 60 * 60_000) return 'WARNING';
  if (ageMs <= 7 * 24 * 60 * 60_000) return 'OVERDUE';
  return 'CRITICAL';
}

export function computeAgingBucket(
  type: FinancialExceptionType,
  firstSeenAt: Date,
  now = new Date(),
  options?: { responseDueAt?: Date | null },
): FinancialExceptionAgingBucket {
  const ageMs = Math.max(0, now.getTime() - firstSeenAt.getTime());

  if (type === 'CHARGEBACK_REPORTED' && options?.responseDueAt) {
    const due = new Date(options.responseDueAt).getTime();
    if (due - now.getTime() <= 24 * 60 * 60_000) return 'CRITICAL';
  }

  if (
    type === 'UNMATCHED_EXTERNAL_CREDIT' ||
    type === 'UNMATCHED_EXTERNAL_DEBIT'
  ) {
    return suspenseStyleBucket(ageMs);
  }

  if (
    type.startsWith('REFUND_') ||
    type === 'REFUND_BLOCKED_AFTER_REDEMPTION'
  ) {
    return refundStyleBucket(ageMs);
  }

  return paymentStyleBucket(ageMs);
}

export function nextReviewAtForBucket(
  bucket: FinancialExceptionAgingBucket,
  now = new Date(),
) {
  const delays: Record<FinancialExceptionAgingBucket, number> = {
    NEW: 60 * 60_000,
    WARNING: 6 * 60 * 60_000,
    OVERDUE: 24 * 60 * 60_000,
    CRITICAL: 6 * 60 * 60_000,
  };
  return new Date(now.getTime() + delays[bucket]);
}

export function defaultSeverityForType(
  type: FinancialExceptionType,
): 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL' {
  switch (type) {
    case 'CHARGEBACK_REPORTED':
    case 'PAYMENT_AMOUNT_MISMATCH':
    case 'REFUND_AMOUNT_MISMATCH':
    case 'NEGATIVE_GOLD_INVENTORY':
    case 'NEGATIVE_GOLD_LIABILITY':
    case 'REFUND_BLOCKED_AFTER_REDEMPTION':
    case 'REFUND_COMPLETED_AFTER_REDEMPTION':
    case 'DUPLICATE_GATEWAY_CAPTURE':
      return 'CRITICAL';
    case 'REFUND_FAILED':
    case 'REFUND_PENDING_TOO_LONG':
    case 'PAYMENT_PENDING_TOO_LONG':
    case 'PAYMENT_FINALIZATION_FAILED':
    case 'UNMATCHED_EXTERNAL_CREDIT':
    case 'UNMATCHED_EXTERNAL_DEBIT':
    case 'LATE_GATEWAY_PAYMENT_AFTER_PERIOD_CLOSE':
      return 'HIGH';
    case 'PAYMENT_STATUS_CHECK_FAILED':
    case 'REFUND_STATUS_CHECK_FAILED':
    case 'REFUND_MISSING_RECOVERY_SCHEDULE':
      return 'MEDIUM';
    case 'OUTBOX_DELIVERY_FAILED':
    default:
      return 'LOW';
  }
}
