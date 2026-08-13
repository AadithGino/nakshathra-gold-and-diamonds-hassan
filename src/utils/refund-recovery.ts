export const REFUND_RECOVERY_LEASE_MS = 300_000;
export const REFUND_RECOVERY_BATCH_SIZE = 25;

/** First status poll one minute after local refund record creation (before/around provider call). */
export function scheduleInitialRefundStatusCheck(now = new Date()) {
  return new Date(now.getTime() + 60_000);
}

/** Age-based backoff for pending/initiated refund status polls. */
export function nextRefundRecoveryCheckAt(refundStartedAt: Date, now = new Date()) {
  const ageMs = Math.max(0, now.getTime() - refundStartedAt.getTime());
  let delayMs: number;
  if (ageMs < 30 * 60_000) delayMs = 2 * 60_000;
  else if (ageMs < 6 * 60 * 60_000) delayMs = 15 * 60_000;
  else if (ageMs < 24 * 60 * 60_000) delayMs = 60 * 60_000;
  else if (ageMs < 7 * 24 * 60 * 60_000) delayMs = 6 * 60 * 60_000;
  else delayMs = 24 * 60 * 60_000;
  return new Date(now.getTime() + delayMs);
}

export function isRefundPendingTooLong(refundStartedAt: Date, now = new Date()) {
  return now.getTime() - refundStartedAt.getTime() >= 7 * 24 * 60 * 60_000;
}
