/**
 * PhonePe UAT status-check cadence
 * (https://developer.phonepe.com/payment-gateway/uat-testing-go-live/uat-checklist):
 *   - first check ~20-25s after transaction initiation
 *   - every 3s for the next 30s
 *   - every 6s for the next 60s
 *   - every 10s for the next 60s
 *   - every 30s for the next 60s
 *   - every 60s after that
 *
 * All calculations key off the intent/order start time (age-based), never off
 * a raw attempt counter, so a worker restart or a delayed first tick cannot
 * desynchronize the schedule.
 */
export const PAYMENT_RECOVERY_LEASE_MS = 300_000;
export const PAYMENT_RECOVERY_BATCH_SIZE = 25;

/** Midpoint of PhonePe's documented 20-25s first-check window. */
const FIRST_CHECK_DELAY_MS = 22_500;
const WINDOW_3S_END_MS = FIRST_CHECK_DELAY_MS + 30_000; // 52.5s
const WINDOW_6S_END_MS = WINDOW_3S_END_MS + 60_000; // 112.5s
const WINDOW_10S_END_MS = WINDOW_6S_END_MS + 60_000; // 172.5s
const WINDOW_30S_END_MS = WINDOW_10S_END_MS + 60_000; // 232.5s

/** First status poll ~20-25 seconds after checkout creation (PhonePe UAT requirement). */
export function scheduleInitialStatusCheck(now = new Date()) {
  return new Date(now.getTime() + FIRST_CHECK_DELAY_MS);
}

/**
 * Age-based PhonePe recovery cadence. `intentStartedAt` is the intent/order
 * start time (quote creation), not the last poll — the schedule is always
 * derived from elapsed age, never from a mere attempt count.
 */
export function nextPaymentRecoveryCheckAt(intentStartedAt: Date, now = new Date()) {
  const ageMs = Math.max(0, now.getTime() - intentStartedAt.getTime());
  let delayMs: number;
  if (ageMs < FIRST_CHECK_DELAY_MS) delayMs = FIRST_CHECK_DELAY_MS - ageMs;
  else if (ageMs < WINDOW_3S_END_MS) delayMs = 3_000;
  else if (ageMs < WINDOW_6S_END_MS) delayMs = 6_000;
  else if (ageMs < WINDOW_10S_END_MS) delayMs = 10_000;
  else if (ageMs < WINDOW_30S_END_MS) delayMs = 30_000;
  else delayMs = 60_000;
  return new Date(now.getTime() + delayMs);
}

export function isPaymentPendingTooLong(intentStartedAt: Date, now = new Date()) {
  return now.getTime() - intentStartedAt.getTime() >= 7 * 24 * 60 * 60_000;
}

export function computeConfirmationMeta(
  intent: { quoteCreatedAt?: Date; createdAt?: Date; expiresAt?: Date; quoteExpiresAt?: Date },
  completedAt: Date,
) {
  const lockedAt = intent.quoteCreatedAt ?? intent.createdAt ?? completedAt;
  const confirmationDelaySeconds = Math.max(
    0,
    Math.floor((completedAt.getTime() - new Date(lockedAt).getTime()) / 1000),
  );
  const expiry = intent.expiresAt ?? intent.quoteExpiresAt;
  const wasLateConfirmation = expiry
    ? completedAt.getTime() > new Date(expiry).getTime()
    : false;
  return {
    providerCompletedAt: completedAt,
    confirmationDelaySeconds,
    wasLateConfirmation,
  };
}
