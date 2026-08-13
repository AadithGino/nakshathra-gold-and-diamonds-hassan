import { createHash, randomUUID } from 'node:crypto';
import mongoose from 'mongoose';
import { formatMerchantTransactionId } from '../config/business.js';
import { env } from '../config/env.js';
import { logger } from '../config/logger.js';
import { AppError } from '../utils/AppError.js';
import { sha256Canonical } from '../utils/canonical-hash.js';
import {
  Customer,
  Payment,
  PaymentGatewayEvent,
  PaymentIntent,
  Payout,
  Refund,
  SchemeEnrollment,
  SystemSetting,
  User,
  type PhonePeIdempotencyScope,
} from '../models/index.js';
import { getPaymentRules, PAYMENT_QUOTE_TTL_MS, resolveTargetSchemeMonth } from './scheme.service.js';
import { finalizeGatewayPayment } from './payment.service.js';
import { reconcileRefundStatus } from './refund.service.js';
import { phonePeProvider } from './phonepe.provider.js';
import { withMongoTransaction } from '../utils/transaction.js';
import {
  claimEnrollmentSettlementLock,
  clearEnrollmentSettlementLock,
  SETTLEMENT_LOCK_PAYMENT_STATUSES,
} from '../utils/enrollment-ledger.js';
import {
  computeConfirmationMeta,
  isPaymentPendingTooLong,
  nextPaymentRecoveryCheckAt,
  scheduleInitialStatusCheck,
} from '../utils/payment-recovery.js';
import type { GatewayStatus, VerifiedGatewayWebhook } from './payment-gateway.js';
import {
  PAYMENT_INTENT_ACTIVE_ATTEMPT_STATUSES,
  type PaymentFinalStatusSource,
} from '../models/enums.js';
import { reportPaymentIntentException, upsertFinancialException } from './financial-exception.service.js';
import { assertCustomerCanStartFinancialActivity } from './customer-financial-policy.service.js';

type InitiatePhonePeInput = {
  schemeId: string;
  amountPaise: number;
  idempotencyKey: string;
  schemeMonth?: number;
};

type PhonePeIntentHashInput = {
  customerId: string;
  schemeId: string;
  amountPaise: number;
  schemeMonth: number;
  checkoutChannel: 'WEB' | 'SDK';
  collectorRole: 'CUSTOMER' | 'STAFF';
};

function phonePeIdempotencyScope(
  channel: 'WEB' | 'SDK',
  collectorRole: 'CUSTOMER' | 'STAFF' = 'CUSTOMER',
): PhonePeIdempotencyScope {
  if (collectorRole === 'STAFF') {
    return channel === 'WEB' ? 'PHONEPE_STAFF_WEB' : 'PHONEPE_STAFF_SDK';
  }
  return channel === 'WEB' ? 'PHONEPE_CUSTOMER_WEB' : 'PHONEPE_CUSTOMER_SDK';
}

function phonePeRequestHash(input: PhonePeIntentHashInput) {
  return sha256Canonical(input);
}

function assertSameRequestHash(existing: { requestHash?: string }, requestHash: string) {
  if (existing.requestHash !== requestHash) {
    throw new AppError(
      'IDEMPOTENCY_KEY_REUSED',
      'Idempotency key was reused with different payment data',
      409,
    );
  }
}

/** Compare stable client fields against a stored intent (no re-resolution of month/rate). */
function assertCompatibleIdempotentRetry(
  existing: {
    schemeId: unknown;
    amountPaise: number;
    schemeMonth?: number | null;
    requestedSchemeMonth?: number | null;
    checkoutChannel?: string | null;
  },
  input: InitiatePhonePeInput,
  checkoutChannel: 'WEB' | 'SDK',
) {
  if (String(existing.schemeId) !== String(input.schemeId)) {
    throw new AppError(
      'IDEMPOTENCY_KEY_REUSED',
      'Idempotency key was reused with different payment data',
      409,
    );
  }
  if (existing.amountPaise !== input.amountPaise) {
    throw new AppError(
      'IDEMPOTENCY_KEY_REUSED',
      'Idempotency key was reused with different payment data',
      409,
    );
  }
  if (existing.checkoutChannel && existing.checkoutChannel !== checkoutChannel) {
    throw new AppError(
      'IDEMPOTENCY_KEY_REUSED',
      'Idempotency key was reused with different payment data',
      409,
    );
  }
  if (input.schemeMonth != null && existing.schemeMonth !== input.schemeMonth) {
    throw new AppError(
      'IDEMPOTENCY_KEY_REUSED',
      'Idempotency key was reused with different payment data',
      409,
    );
  }
}

const PROVIDER_LAUNCH_LEASE_MS = 45_000;
const PROVIDER_LAUNCH_POLL_MS = 200;
const PROVIDER_LAUNCH_POLL_ATTEMPTS = 50;

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isDuplicateKeyError(error: unknown) {
  return Boolean(error && typeof error === 'object' && (error as { code?: number }).code === 11000);
}

/**
 * At most one live PhonePe attempt may exist per (provider, schemeId,
 * schemeMonth), regardless of idempotency key, checkout channel, or client
 * retries. Enforced primarily by the unique sparse `activeAttemptKey` index
 * on PaymentIntent; this key format is shared by every write path that sets
 * or reads it.
 */
function phonePeActiveAttemptKey(schemeId: unknown, schemeMonth: number) {
  return `PHONEPE:${String(schemeId)}:${schemeMonth}`;
}

function isActiveAttemptStatus(status: string) {
  return (PAYMENT_INTENT_ACTIVE_ATTEMPT_STATUSES as readonly string[]).includes(status);
}

function activeAttemptConflictError(existing: {
  merchantTransactionId: string;
  status: string;
  checkoutUrl?: string | null;
  expiresAt?: Date | null;
}) {
  return new AppError(
    'PAYMENT_ATTEMPT_ALREADY_ACTIVE',
    'An active payment attempt already exists for this installment. Query it and retry once it reaches a terminal state.',
    409,
    true,
    [
      {
        merchantTransactionId: existing.merchantTransactionId,
        status: existing.status,
      },
    ],
  );
}

/**
 * Look for a live PhonePe attempt on this scheme month. If the attempt
 * belongs to this exact (customerId, idempotencyScope, idempotencyKey)
 * family, it is the caller's own sibling request racing to create the same
 * document — hand it back rather than rejecting, so concurrent identical
 * requests still coalesce onto one intent exactly as before this guard
 * existed. Only a genuinely different family blocks the caller. If a
 * different attempt is due for a status check, reconcile it first so a
 * genuinely finished attempt does not block a fresh one. Never calls PhonePe
 * `create*` here — only status reconciliation.
 */
async function guardAgainstConcurrentActiveAttempt(
  schemeId: unknown,
  schemeMonth: number,
  identity: { customerId: unknown; idempotencyScope: PhonePeIdempotencyScope; idempotencyKey: string },
  requestId: string | undefined,
) {
  const key = phonePeActiveAttemptKey(schemeId, schemeMonth);
  let active = await PaymentIntent.findOne({ activeAttemptKey: key });
  if (!active) return undefined;

  const isSameFamily = (candidate: typeof active) =>
    String(candidate.customerId) === String(identity.customerId) &&
    candidate.idempotencyScope === identity.idempotencyScope &&
    candidate.idempotencyKey === identity.idempotencyKey;

  if (isSameFamily(active)) return active;

  const now = new Date();
  const dueForCheck =
    active.status !== 'PROVIDER_CREATING' &&
    active.nextStatusCheckAt != null &&
    new Date(active.nextStatusCheckAt).getTime() <= now.getTime();
  if (dueForCheck) {
    try {
      await reconcilePaymentIntentStatus(
        String(active._id),
        'CUSTOMER_STATUS_CHECK',
        requestId ?? `active-attempt-guard:${String(active._id)}`,
      );
    } catch {
      // Reconciliation failure here is non-fatal — fall through with last-known state.
    }
    active = (await PaymentIntent.findById(active._id)) ?? active;
    if (isSameFamily(active)) return active;
  }

  if (isActiveAttemptStatus(active.status)) {
    throw activeAttemptConflictError(active);
  }
  // Terminal now (e.g. SUCCESS/FAILED/REVIEW_REQUIRED) — activeAttemptKey has
  // already been cleared by the transition that got it there, so the caller
  // may proceed to create a new intent.
  return undefined;
}

/** Exported for Phase 1 concurrency/idempotency tests. */
export async function getOrCreatePaymentIntent(args: {
  customerId: unknown;
  schemeId: unknown;
  input: InitiatePhonePeInput;
  targetSchemeMonth: number;
  checkoutChannel: 'WEB' | 'SDK';
  quotedAt: Date;
  quoteExpiresAt: Date;
  rules: Awaited<ReturnType<typeof getPaymentRules>>;
  actorUserId: string;
  requestId: string;
  collectorRole?: 'CUSTOMER' | 'STAFF';
}) {
  const {
    customerId,
    schemeId,
    input,
    targetSchemeMonth,
    checkoutChannel,
    quotedAt,
    quoteExpiresAt,
    rules,
    actorUserId,
    collectorRole = 'CUSTOMER',
  } = args;
  const idempotencyScope = phonePeIdempotencyScope(checkoutChannel, collectorRole);
  const requestHash = phonePeRequestHash({
    customerId: String(customerId),
    schemeId: String(schemeId),
    amountPaise: input.amountPaise,
    schemeMonth: targetSchemeMonth,
    checkoutChannel,
    collectorRole,
  });
  const filter = {
    customerId,
    idempotencyScope,
    idempotencyKey: input.idempotencyKey,
  };

  const existing = await PaymentIntent.findOne(filter);
  if (existing) {
    assertSameRequestHash(existing, requestHash);
    return existing;
  }

  // A genuinely different idempotency key must not be able to open a second
  // live PhonePe attempt for the same installment while one is already
  // active. A same-family sibling (this exact key racing itself) is handed
  // back directly instead of being rejected.
  const sibling = await guardAgainstConcurrentActiveAttempt(
    schemeId,
    targetSchemeMonth,
    { customerId, idempotencyScope, idempotencyKey: input.idempotencyKey },
    args.requestId,
  );
  if (sibling) {
    assertSameRequestHash(sibling, requestHash);
    return sibling;
  }

  const merchantTransactionId = formatMerchantTransactionId();
  const draft = buildIntentDraft(
    customerId,
    schemeId,
    input,
    targetSchemeMonth,
    merchantTransactionId,
    quotedAt,
    quoteExpiresAt,
    rules,
    { userId: actorUserId, collectorRole },
    {
      idempotencyScope,
      requestHash,
      checkoutChannel,
    },
  );

  const enrollment = await SchemeEnrollment.findById(schemeId);
  if (!enrollment) {
    return persistPaymentIntent(filter, draft, requestHash);
  }

  return createPaymentIntentUnderFinancialLock({
    schemeId,
    requestId: args.requestId,
    filter,
    draft,
    requestHash,
  });
}

/**
 * Serialize new PhonePe intent creation with settlement using the existing
 * enrollment lock. Provider create stays outside this transaction.
 */
async function createPaymentIntentUnderFinancialLock(args: {
  schemeId: unknown;
  requestId: string;
  filter: Record<string, unknown>;
  draft: Record<string, unknown>;
  requestHash: string;
}) {
  const { schemeId, requestId, filter, draft, requestHash } = args;
  try {
    return await withMongoTransaction(async (session) => {
      const lockOwner = `payment-init:${requestId}`;
      await claimEnrollmentSettlementLock(
        schemeId,
        lockOwner,
        session,
        SETTLEMENT_LOCK_PAYMENT_STATUSES,
      );
      const enrollment = await SchemeEnrollment.findById(schemeId).session(session);
      if (!enrollment || enrollment.status !== 'ACTIVE') {
        throw new AppError('SCHEME_NOT_ACTIVE', 'Scheme is not active', 409);
      }
      const successPayout = await Payout.findOne({
        schemeId,
        status: 'SUCCESS',
      }).session(session);
      if (successPayout) {
        throw new AppError('SCHEME_ALREADY_SETTLED', 'Scheme is already settled', 409);
      }
      const intent = await persistPaymentIntent(filter, draft, requestHash, session);
      await clearEnrollmentSettlementLock(schemeId, lockOwner, session);
      return intent;
    }, requestId);
  } catch (error) {
    if (isDuplicateKeyError(error)) {
      const existing = await PaymentIntent.findOne(filter);
      if (existing) {
        assertSameRequestHash(existing, requestHash);
        return existing;
      }
      const activeAttemptKey = (draft as { activeAttemptKey?: string }).activeAttemptKey;
      if (activeAttemptKey) {
        const winner = await PaymentIntent.findOne({ activeAttemptKey });
        if (winner) throw activeAttemptConflictError(winner);
      }
    }
    throw error;
  }
}

async function assertGatewayEnabled() {
  const settings = await SystemSetting.findOne({ singletonKey: 'GLOBAL' })
    .select('customerPhonePeEnabled')
    .lean();
  if (settings?.customerPhonePeEnabled === false)
    throw new AppError(
      'CUSTOMER_PAYMENTS_DISABLED',
      'Customer PhonePe payments are temporarily disabled',
      503,
      true,
    );
}

function paymentIntentPayload(intent: any) {
  return {
    merchantTransactionId: intent.merchantTransactionId,
    checkoutUrl: intent.checkoutUrl,
    status: intent.status,
    quoteExpiresAt: intent.quoteExpiresAt,
    expiresAt: intent.expiresAt,
    goldRatePerGramPaise: intent.goldRatePerGramPaise ?? null,
    goldWeightMg: intent.goldWeightMg ?? null,
    goldPurity: intent.goldPurity ?? null,
  };
}

function phonePeSdkOrderPayload(intent: any) {
  return {
    merchantOrderId: intent.merchantTransactionId,
    orderId: intent.providerOrderId,
    token: intent.sdkToken,
  };
}

function resolveCheckoutChannel(intent: any): 'WEB' | 'SDK' | null {
  if (intent.checkoutChannel) return intent.checkoutChannel;
  if (intent.sdkToken) return 'SDK';
  if (intent.checkoutUrl) return 'WEB';
  return null;
}

function assertMatchingCheckoutChannel(
  existing: any,
  expected: 'WEB' | 'SDK',
  alternateLabel: string,
) {
  const channel = resolveCheckoutChannel(existing);
  if (channel && channel !== expected) {
    throw new AppError(
      'PAYMENT_INTENT_INCOMPLETE',
      `Payment attempt was started via ${alternateLabel}. Use a new idempotency key for this checkout type.`,
      409,
    );
  }
}

function shouldAutoSuccessPhonePeInDev() {
  return env.PHONEPE_DEV_AUTO_SUCCESS;
}

function resolvePhonePeWebOrigin(webOrigin?: string) {
  if (webOrigin && env.origins.includes(webOrigin)) return webOrigin;
  if (shouldAutoSuccessPhonePeInDev()) {
    return env.origins[0] ?? 'http://localhost:5173';
  }
  return new URL(env.PHONEPE_REDIRECT_URL).origin;
}

function phonePeRedirectUrl(merchantTransactionId: string, webOrigin?: string) {
  const origin = resolvePhonePeWebOrigin(webOrigin);
  return `${origin}/customer/payments/return?order=${merchantTransactionId}`;
}

async function reloadPaymentIntent(intent: { _id: unknown }) {
  const fresh = await PaymentIntent.findById(intent._id);
  if (!fresh) {
    throw new AppError('PAYMENT_INTENT_NOT_FOUND', 'Payment attempt not found', 404);
  }
  return fresh;
}

async function autoFinalizeDevPhonePeIntent(intent: any, requestId?: string) {
  await finalizeGatewayPayment(
    intent,
    {
      transactionId: `DEV-AUTO-${intent.merchantTransactionId}`,
      amountPaise: intent.amountPaise,
    },
    {
      requestId,
      actorId: String(intent.createdBy),
      actorRole: intent.collectorRole ?? 'CUSTOMER',
    },
  );
  const completedAt = new Date();
  const meta = computeConfirmationMeta(intent, completedAt);
  await PaymentIntent.updateOne(
    { _id: intent._id },
    {
      $set: {
        finalStatusSource: 'DEV_AUTO_SUCCESS',
        providerCompletedAt: meta.providerCompletedAt,
        wasLateConfirmation: meta.wasLateConfirmation,
        confirmationDelaySeconds: meta.confirmationDelaySeconds,
        nextStatusCheckAt: null,
        recoveryLockedAt: null,
        recoveryLockUntil: null,
        recoveryLockedBy: null,
        lastGatewayError: null,
      },
    },
  );
  logger.info(
    { merchantTransactionId: intent.merchantTransactionId },
    'Dev PhonePe auto-success: payment marked SUCCESS and gold credited',
  );
}

async function resolveExistingPhonePeIntent(existing: any, requestId?: string) {
  assertMatchingCheckoutChannel(existing, 'WEB', 'mobile SDK');
  if (shouldAutoSuccessPhonePeInDev() && existing.status === 'PENDING') {
    await autoFinalizeDevPhonePeIntent(existing, requestId);
    return paymentIntentPayload(await reloadPaymentIntent(existing));
  }
  return paymentIntentPayload(existing);
}

async function resolveExistingPhonePeSdkIntent(existing: any, requestId?: string) {
  assertMatchingCheckoutChannel(existing, 'SDK', 'web checkout');
  if (shouldAutoSuccessPhonePeInDev() && existing.status === 'PENDING') {
    await autoFinalizeDevPhonePeIntent(existing, requestId);
    return phonePeSdkOrderPayload(await reloadPaymentIntent(existing));
  }
  if (!existing.sdkToken || !existing.providerOrderId) {
    throw new AppError(
      'PAYMENT_INTENT_INCOMPLETE',
      'Payment attempt exists but SDK order details are unavailable. Use a new idempotency key.',
      409,
    );
  }
  return phonePeSdkOrderPayload(existing);
}

function isIntentCheckoutIncomplete(intent: {
  status: string;
  checkoutUrl?: string | null;
  sdkToken?: string | null;
}) {
  if (intent.status === 'SUCCESS' || intent.status === 'FAILED' || intent.status === 'REVIEW_REQUIRED')
    return false;
  return !intent.checkoutUrl && !intent.sdkToken;
}

/**
 * Upsert a payment intent. When `session` is set (financial lock TX), duplicate-key
 * is rethrown so the transaction aborts and the caller refetches without that session.
 */
async function persistPaymentIntent(
  filter: Record<string, unknown>,
  draft: Record<string, unknown>,
  requestHash: string,
  session?: import('mongoose').ClientSession,
) {
  try {
    const intent = await PaymentIntent.findOneAndUpdate(
      filter,
      { $setOnInsert: draft },
      { upsert: true, new: true, ...(session ? { session } : {}) },
    );
    if (!intent) {
      throw new AppError('PAYMENT_INTENT_NOT_FOUND', 'Payment attempt not found', 404);
    }
    assertSameRequestHash(intent, requestHash);
    return intent;
  } catch (error: unknown) {
    if (session && isDuplicateKeyError(error)) throw error;
    if (isDuplicateKeyError(error)) {
      const existing = await PaymentIntent.findOne(filter);
      if (existing) {
        assertSameRequestHash(existing, requestHash);
        return existing;
      }
      // No row under the idempotency-key filter — this was a race on the
      // activeAttemptKey unique index (two different idempotency keys hitting
      // the same schemeId+schemeMonth simultaneously). Surface a retryable
      // 409 pointing at whichever attempt won, instead of a raw Mongo error.
      const activeAttemptKey = (draft as { activeAttemptKey?: string }).activeAttemptKey;
      if (activeAttemptKey) {
        const winner = await PaymentIntent.findOne({ activeAttemptKey });
        if (winner) throw activeAttemptConflictError(winner);
      }
    }
    if (error instanceof AppError) throw error;
    throw error;
  }
}

function buildIntentDraft(
  customerId: unknown,
  schemeId: unknown,
  input: InitiatePhonePeInput,
  targetSchemeMonth: number,
  merchantTransactionId: string,
  quotedAt: Date,
  quoteExpiresAt: Date,
  rules: Awaited<ReturnType<typeof getPaymentRules>>,
  actor: { userId: string; collectorRole: 'CUSTOMER' | 'STAFF' },
  idempotency: {
    idempotencyScope: PhonePeIdempotencyScope;
    requestHash: string;
    checkoutChannel?: 'WEB' | 'SDK';
  },
) {
  return {
    customerId,
    schemeId,
    amountPaise: input.amountPaise,
    requestedSchemeMonth: input.schemeMonth,
    schemeMonth: targetSchemeMonth,
    merchantTransactionId,
    idempotencyKey: input.idempotencyKey,
    idempotencyScope: idempotency.idempotencyScope,
    requestHash: idempotency.requestHash,
    checkoutChannel: idempotency.checkoutChannel,
    createdBy: actor.userId,
    goldRateId: rules.goldRateId ?? undefined,
    goldRatePerGramPaise: rules.goldRatePerGramPaise ?? undefined,
    goldWeightMg: rules.goldWeightMg ?? undefined,
    goldPurity: rules.goldPurity ?? undefined,
    quoteCreatedAt: quotedAt,
    quoteExpiresAt,
    collectedBy: actor.userId,
    collectorRole: actor.collectorRole,
    activeAttemptKey: phonePeActiveAttemptKey(schemeId, targetSchemeMonth),
  };
}

function clearProviderLaunchLeaseSet() {
  return {
    providerLaunchLockedAt: null,
    providerLaunchLockUntil: null,
    providerLaunchLockedBy: null,
  };
}

/** Provider create may have succeeded — poll status; do not call create again. */
async function markProviderCreateUncertain(
  intentId: unknown,
  error: unknown,
  extras?: { providerOrderId?: string },
) {
  const message = String((error as { message?: string })?.message ?? error).slice(0, 500);
  await PaymentIntent.updateOne(
    { _id: intentId },
    {
      $set: {
        status: 'PROVIDER_CREATE_UNCERTAIN',
        nextStatusCheckAt: scheduleInitialStatusCheck(),
        lastGatewayError: message,
        ...(extras?.providerOrderId ? { providerOrderId: extras.providerOrderId } : {}),
        ...clearProviderLaunchLeaseSet(),
      },
    },
  );
}

async function ensureUncertainAfterLaunchFailure(intentId: unknown, error: unknown) {
  const intent = await PaymentIntent.findById(intentId).select('status').lean();
  if (!intent) return;
  if (intent.status === 'PROVIDER_CREATE_UNCERTAIN') return;
  if (intent.status === 'PROVIDER_CREATING' || intent.status === 'PENDING') {
    await markProviderCreateUncertain(intentId, error);
  }
}

/**
 * Authoritative order absence only — never treat timeouts, auth failures, or
 * generic 5xx / empty responses as order-not-found.
 */
export function isProviderOrderAbsentError(error: unknown) {
  const details = (error as { details?: Array<{ providerCode?: string; httpStatus?: number }> })
    ?.details;
  const providerCode = String(details?.[0]?.providerCode ?? '').toUpperCase();
  const httpStatus = details?.[0]?.httpStatus;
  if (httpStatus === 404) return true;
  return /^(ORDER_NOT_FOUND|ORDER_DOES_NOT_EXIST|INVALID_ORDER_ID|NO_ORDER)$/.test(providerCode);
}

/**
 * Prefer the completion timestamp the provider adapter already mapped onto
 * `GatewayStatus.providerCompletedAt` (phonepe.provider.ts checkStatus()).
 * Falls back to parsing `raw` directly for any status object that didn't go
 * through the adapter (defensive only — never invents a timestamp).
 */
function extractProviderCompletedAt(status: GatewayStatus): Date | undefined {
  if (status.providerCompletedAt) return new Date(status.providerCompletedAt);
  const raw = status.raw as
    | {
        completedAt?: unknown;
        paymentDetails?: Array<{ state?: string; timestamp?: unknown; completedAt?: unknown }>;
      }
    | null
    | undefined;
  if (!raw || typeof raw !== 'object') return undefined;
  const completedCandidates: unknown[] = [];
  if (raw.completedAt != null) completedCandidates.push(raw.completedAt);
  const detail = Array.isArray(raw.paymentDetails)
    ? raw.paymentDetails.find((x) => String(x?.state ?? '').toUpperCase() === 'COMPLETED')
    : undefined;
  if (detail?.completedAt != null) completedCandidates.push(detail.completedAt);
  if (detail?.timestamp != null) completedCandidates.push(detail.timestamp);
  for (const candidate of completedCandidates) {
    const asNumber = typeof candidate === 'number' ? candidate : Number(candidate);
    if (Number.isFinite(asNumber) && asNumber > 0) {
      // PhonePe often uses epoch millis; treat small values as seconds.
      const ms = asNumber < 1_000_000_000_000 ? asNumber * 1000 : asNumber;
      const date = new Date(ms);
      if (!Number.isNaN(date.getTime())) return date;
    }
    if (typeof candidate === 'string') {
      const date = new Date(candidate);
      if (!Number.isNaN(date.getTime())) return date;
    }
  }
  return undefined;
}

export async function convertStaleProviderCreatingToUncertain(intentId: unknown) {
  const now = new Date();
  return PaymentIntent.findOneAndUpdate(
    mongoose.trusted({
      _id: intentId,
      status: 'PROVIDER_CREATING',
      $or: [
        { providerLaunchLockUntil: null },
        { providerLaunchLockUntil: mongoose.trusted({ $exists: false }) },
        { providerLaunchLockUntil: mongoose.trusted({ $lte: now }) },
      ],
    }),
    {
      $set: {
        status: 'PROVIDER_CREATE_UNCERTAIN',
        nextStatusCheckAt: scheduleInitialStatusCheck(now),
        lastGatewayError: 'STALE_PROVIDER_CREATING_LEASE',
        ...clearProviderLaunchLeaseSet(),
      },
    },
    { new: true },
  );
}

async function claimProviderLaunchLease(intentId: unknown, ownerId: string) {
  const now = new Date();
  // Only explicitly launchable states may call PhonePe create.
  // Never claim PROVIDER_CREATING (stale or live) or PROVIDER_CREATE_UNCERTAIN.
  // Never create again when a provider order reference is already present.
  return PaymentIntent.findOneAndUpdate(
    mongoose.trusted({
      _id: intentId,
      status: mongoose.trusted({ $in: ['INITIATED', 'PENDING'] }),
      $and: [
        mongoose.trusted({
          $or: [
            { checkoutUrl: null },
            { checkoutUrl: mongoose.trusted({ $exists: false }) },
            { checkoutUrl: '' },
          ],
        }),
        mongoose.trusted({
          $or: [
            { sdkToken: null },
            { sdkToken: mongoose.trusted({ $exists: false }) },
            { sdkToken: '' },
          ],
        }),
        mongoose.trusted({
          $or: [
            { providerOrderId: null },
            { providerOrderId: mongoose.trusted({ $exists: false }) },
            { providerOrderId: '' },
          ],
        }),
        mongoose.trusted({
          $or: [
            { providerLaunchLockUntil: null },
            { providerLaunchLockUntil: mongoose.trusted({ $exists: false }) },
            { providerLaunchLockUntil: mongoose.trusted({ $lte: now }) },
          ],
        }),
      ],
    }),
    {
      $set: {
        status: 'PROVIDER_CREATING',
        providerLaunchLockedAt: now,
        providerLaunchLockUntil: new Date(now.getTime() + PROVIDER_LAUNCH_LEASE_MS),
        providerLaunchLockedBy: ownerId,
      },
    },
    { new: true },
  );
}

async function acquireProviderLaunchOrWait(intent: { _id: unknown }, ownerId: string) {
  for (let attempt = 0; attempt < PROVIDER_LAUNCH_POLL_ATTEMPTS; attempt++) {
    const fresh = await PaymentIntent.findById(intent._id);
    if (!fresh) {
      throw new AppError('PAYMENT_INTENT_NOT_FOUND', 'Payment attempt not found', 404);
    }
    if (fresh.status === 'PROVIDER_CREATE_UNCERTAIN') {
      throw new AppError(
        'PAYMENT_LAUNCH_RECOVERY_PENDING',
        'Payment order is being verified. Retry shortly with the same idempotency key.',
        409,
        true,
      );
    }
    if (fresh.status === 'PROVIDER_CREATING') {
      const converted = await convertStaleProviderCreatingToUncertain(fresh._id);
      if (converted) {
        throw new AppError(
          'PAYMENT_LAUNCH_RECOVERY_PENDING',
          'Payment order is being verified. Retry shortly with the same idempotency key.',
          409,
          true,
        );
      }
      await sleep(PROVIDER_LAUNCH_POLL_MS);
      continue;
    }
    if (!isIntentCheckoutIncomplete(fresh)) {
      return { ready: fresh as typeof fresh };
    }
    const claimed = await claimProviderLaunchLease(fresh._id, ownerId);
    if (claimed) {
      return { launch: claimed };
    }
    await sleep(PROVIDER_LAUNCH_POLL_MS);
  }
  const latest = await PaymentIntent.findById(intent._id);
  if (
    latest?.status === 'PROVIDER_CREATE_UNCERTAIN' ||
    latest?.status === 'PROVIDER_CREATING'
  ) {
    throw new AppError(
      'PAYMENT_LAUNCH_RECOVERY_PENDING',
      'Payment order is being verified. Retry shortly with the same idempotency key.',
      409,
      true,
    );
  }
  if (latest && !isIntentCheckoutIncomplete(latest)) {
    return { ready: latest };
  }
  throw new AppError(
    'PAYMENT_LAUNCH_IN_PROGRESS',
    'Payment checkout is being prepared. Retry shortly with the same idempotency key.',
    409,
    true,
  );
}

type PhonePeCheckoutInput = {
  merchantOrderId: string;
  amountPaise: number;
  redirectUrl: string;
  customerPhone: string;
  customerId: string;
  schemeId: string;
  expireAfterSeconds: number;
};

type PhonePeSdkCheckoutInput = {
  merchantOrderId: string;
  amountPaise: number;
  customerId: string;
  schemeId: string;
  expireAfterSeconds: number;
};

const MIN_PHONEPE_EXPIRE_AFTER_SECONDS = 60;

/**
 * The PhonePe order must never remain payable beyond the locked financial
 * quote — one authoritative expiry duration, derived from the intent's own
 * `quoteExpiresAt`, never independently hard-coded per call site.
 */
function computeExpireAfterSeconds(intent: { quoteExpiresAt?: Date | null }, now = new Date()) {
  if (intent.quoteExpiresAt) {
    const remainingMs = new Date(intent.quoteExpiresAt).getTime() - now.getTime();
    if (remainingMs > 0) {
      return Math.max(MIN_PHONEPE_EXPIRE_AFTER_SECONDS, Math.floor(remainingMs / 1000));
    }
  }
  return Math.floor(PAYMENT_QUOTE_TTL_MS / 1000);
}

/** Never let the provider-reported expiry outlive the locked quote it was priced against. */
function clampProviderExpiry(providerExpiresAt: Date, quoteExpiresAt?: Date | null) {
  if (!quoteExpiresAt) return providerExpiresAt;
  const quote = new Date(quoteExpiresAt);
  return providerExpiresAt.getTime() > quote.getTime() ? quote : providerExpiresAt;
}

async function launchPhonePeCheckout(
  intent: any,
  input: PhonePeCheckoutInput,
  requestId?: string,
) {
  if (shouldAutoSuccessPhonePeInDev()) {
    logger.warn(
      { merchantOrderId: input.merchantOrderId },
      'PHONEPE_DEV_AUTO_SUCCESS is enabled — skipping PhonePe and marking payment SUCCESS',
    );
    await PaymentIntent.updateOne(
      { _id: intent._id },
      {
        $set: {
          providerOrderId: `DEV-${input.merchantOrderId}`,
          checkoutUrl: input.redirectUrl,
          checkoutChannel: 'WEB',
          expiresAt: intent.quoteExpiresAt,
          status: 'PENDING',
          nextStatusCheckAt: scheduleInitialStatusCheck(),
          statusCheckAttempts: 0,
          ...clearProviderLaunchLeaseSet(),
        },
      },
    );
    const reloaded = await reloadPaymentIntent(intent);
    await autoFinalizeDevPhonePeIntent(reloaded, requestId);
    return reloadPaymentIntent(intent);
  }

  let checkout: Awaited<ReturnType<typeof phonePeProvider.createPayment>>;
  try {
    checkout = await phonePeProvider.createPayment(input);
  } catch (error) {
    // Network/timeouts are ambiguous — never allow an immediate second create.
    await markProviderCreateUncertain(intent._id, error);
    throw error;
  }

  try {
    await PaymentIntent.updateOne(
      { _id: intent._id },
      {
        $set: {
          providerOrderId: checkout.providerOrderId,
          checkoutUrl: checkout.redirectUrl,
          checkoutChannel: 'WEB',
          expiresAt: clampProviderExpiry(checkout.expiresAt, intent.quoteExpiresAt),
          status: 'PENDING',
          nextStatusCheckAt: scheduleInitialStatusCheck(),
          statusCheckAttempts: 0,
          ...clearProviderLaunchLeaseSet(),
        },
      },
    );
    return reloadPaymentIntent(intent);
  } catch (error) {
    await markProviderCreateUncertain(intent._id, error, {
      providerOrderId: checkout.providerOrderId,
    });
    throw error;
  }
}

async function launchPhonePeSdkCheckout(
  intent: any,
  input: PhonePeSdkCheckoutInput,
  requestId?: string,
) {
  if (shouldAutoSuccessPhonePeInDev()) {
    logger.warn(
      { merchantOrderId: input.merchantOrderId },
      'PHONEPE_DEV_AUTO_SUCCESS is enabled — skipping PhonePe SDK and marking payment SUCCESS',
    );
    await PaymentIntent.updateOne(
      { _id: intent._id },
      {
        $set: {
          providerOrderId: `DEV-${input.merchantOrderId}`,
          sdkToken: `DEV-TOKEN-${input.merchantOrderId}`,
          checkoutChannel: 'SDK',
          expiresAt: intent.quoteExpiresAt,
          status: 'PENDING',
          nextStatusCheckAt: scheduleInitialStatusCheck(),
          statusCheckAttempts: 0,
          ...clearProviderLaunchLeaseSet(),
        },
      },
    );
    const reloaded = await reloadPaymentIntent(intent);
    await autoFinalizeDevPhonePeIntent(reloaded, requestId);
    return reloadPaymentIntent(intent);
  }

  let sdkOrder: Awaited<ReturnType<typeof phonePeProvider.createSdkOrder>>;
  try {
    sdkOrder = await phonePeProvider.createSdkOrder(input);
  } catch (error) {
    await markProviderCreateUncertain(intent._id, error);
    throw error;
  }

  try {
    await PaymentIntent.updateOne(
      { _id: intent._id },
      {
        $set: {
          providerOrderId: sdkOrder.orderId,
          sdkToken: sdkOrder.token,
          checkoutChannel: 'SDK',
          expiresAt: clampProviderExpiry(sdkOrder.expiresAt, intent.quoteExpiresAt),
          status: 'PENDING',
          nextStatusCheckAt: scheduleInitialStatusCheck(),
          statusCheckAttempts: 0,
          ...clearProviderLaunchLeaseSet(),
        },
      },
    );
    return reloadPaymentIntent(intent);
  } catch (error) {
    await markProviderCreateUncertain(intent._id, error, {
      providerOrderId: sdkOrder.orderId,
    });
    throw error;
  }
}

async function runWebCheckoutLaunch(
  intent: any,
  customer: { _id: unknown },
  amountPaise: number,
  launchOwnerId: string,
  requestId: string | undefined,
  webOrigin: string | undefined,
  phone: string,
) {
  const acquired = await acquireProviderLaunchOrWait(intent, launchOwnerId);
  if (acquired.ready) {
    return resolveExistingPhonePeIntent(acquired.ready, requestId);
  }
  try {
    const updatedIntent = await launchPhonePeCheckout(
      acquired.launch,
      {
        merchantOrderId: acquired.launch.merchantTransactionId,
        amountPaise,
        redirectUrl: phonePeRedirectUrl(acquired.launch.merchantTransactionId, webOrigin),
        customerPhone: phone,
        customerId: String(customer._id),
        schemeId: String(acquired.launch.schemeId),
        expireAfterSeconds: computeExpireAfterSeconds(acquired.launch),
      },
      requestId,
    );
    return paymentIntentPayload(updatedIntent);
  } catch (error) {
    await ensureUncertainAfterLaunchFailure(acquired.launch._id, error);
    throw error;
  }
}

async function runSdkCheckoutLaunch(
  intent: any,
  customer: { _id: unknown },
  amountPaise: number,
  launchOwnerId: string,
  requestId: string | undefined,
) {
  const acquired = await acquireProviderLaunchOrWait(intent, launchOwnerId);
  if (acquired.ready) {
    return resolveExistingPhonePeSdkIntent(acquired.ready, requestId);
  }
  try {
    const updatedIntent = await launchPhonePeSdkCheckout(
      acquired.launch,
      {
        merchantOrderId: acquired.launch.merchantTransactionId,
        amountPaise,
        customerId: String(customer._id),
        schemeId: String(acquired.launch.schemeId),
        expireAfterSeconds: computeExpireAfterSeconds(acquired.launch),
      },
      requestId,
    );
    return phonePeSdkOrderPayload(updatedIntent);
  } catch (error) {
    await ensureUncertainAfterLaunchFailure(acquired.launch._id, error);
    throw error;
  }
}

async function assertInstallmentAndGoldRules(
  scheme: { monthlyInstallmentPaise: unknown; schemeType?: string },
  amountPaise: number,
  rules: Awaited<ReturnType<typeof getPaymentRules>>,
) {
  if (rules.phase === 'FLEXIBLE' || rules.phase === 'CAPPED') {
    if (amountPaise < Number(scheme.monthlyInstallmentPaise)) {
      throw new AppError(
        'PAYMENT_BELOW_MINIMUM',
        `Minimum payment is ₹${(Number(scheme.monthlyInstallmentPaise) / 100).toLocaleString('en-IN')}`,
        422,
      );
    }
  } else {
    const installmentPaise = Number(scheme.monthlyInstallmentPaise);
    if (amountPaise !== installmentPaise)
      throw new AppError(
        'FIXED_INSTALLMENT_REQUIRED',
        `The fixed monthly installment is ₹${(installmentPaise / 100).toLocaleString('en-IN')}`,
        422,
      );
  }
  if (scheme.schemeType === 'GOLD_WEIGHT' && !rules.goldRatePerGramPaise)
    throw new AppError(
      'GOLD_RATE_NOT_AVAILABLE',
      'No gold rate is active for the payment time',
      409,
    );
}

export async function initiatePhonePe(
  userId: string,
  input: InitiatePhonePeInput,
  requestId: string,
  webOrigin?: string,
) {
  await assertGatewayEnabled();
  const customer = await Customer.findOne({ userId });
  if (!customer) throw new AppError('CUSTOMER_NOT_FOUND', 'Customer profile not found', 404);
  const scheme = await SchemeEnrollment.findOne({
    _id: input.schemeId,
    customerId: customer._id,
  }).populate('schemePlanId');
  if (!scheme) throw new AppError('SCHEME_NOT_FOUND', 'Owned scheme not found', 404);
  if (scheme.status !== 'ACTIVE')
    throw new AppError('SCHEME_NOT_ACTIVE', 'Scheme is not active', 409);

  const idempotencyScope = phonePeIdempotencyScope('WEB');
  const existing = await PaymentIntent.findOne({
    customerId: customer._id,
    idempotencyScope,
    idempotencyKey: input.idempotencyKey,
  });
  if (existing) {
    assertCompatibleIdempotentRetry(existing, input, 'WEB');
    if (!isIntentCheckoutIncomplete(existing)) {
      return resolveExistingPhonePeIntent(existing, requestId);
    }
    const user = await User.findById(userId);
    if (!user) throw new AppError('USER_NOT_FOUND', 'Customer login account not found', 404);
    return runWebCheckoutLaunch(
      existing,
      customer,
      existing.amountPaise,
      userId,
      requestId,
      webOrigin,
      user.phone,
    );
  }

  await assertCustomerCanStartFinancialActivity(String(customer._id));

  const quotedAt = new Date();
  const targetSchemeMonth = await resolveTargetSchemeMonth(
    input.schemeId,
    input.schemeMonth,
    undefined,
    quotedAt,
  );
  const rules = await getPaymentRules(input.schemeId, quotedAt, input.amountPaise, undefined, {
    targetSchemeMonth,
  });
  await assertInstallmentAndGoldRules(scheme, input.amountPaise, rules);

  const quoteExpiresAt = new Date(quotedAt.getTime() + PAYMENT_QUOTE_TTL_MS);
  const intent = await getOrCreatePaymentIntent({
    customerId: customer._id,
    schemeId: scheme._id,
    input,
    targetSchemeMonth,
    checkoutChannel: 'WEB',
    quotedAt,
    quoteExpiresAt,
    rules,
    actorUserId: userId,
    requestId,
  });

  if (!isIntentCheckoutIncomplete(intent)) {
    return resolveExistingPhonePeIntent(intent, requestId);
  }

  const user = await User.findById(userId);
  if (!user) throw new AppError('USER_NOT_FOUND', 'Customer login account not found', 404);
  return runWebCheckoutLaunch(
    intent,
    customer,
    input.amountPaise,
    userId,
    requestId,
    webOrigin,
    user.phone,
  );
}

export async function initiatePhonePeSdkOrder(
  userId: string,
  input: InitiatePhonePeInput,
  requestId: string,
) {
  await assertGatewayEnabled();
  const customer = await Customer.findOne({ userId });
  if (!customer) throw new AppError('CUSTOMER_NOT_FOUND', 'Customer profile not found', 404);
  const scheme = await SchemeEnrollment.findOne({
    _id: input.schemeId,
    customerId: customer._id,
  }).populate('schemePlanId');
  if (!scheme) throw new AppError('SCHEME_NOT_FOUND', 'Owned scheme not found', 404);
  if (scheme.status !== 'ACTIVE')
    throw new AppError('SCHEME_NOT_ACTIVE', 'Scheme is not active', 409);

  const idempotencyScope = phonePeIdempotencyScope('SDK');
  const existing = await PaymentIntent.findOne({
    customerId: customer._id,
    idempotencyScope,
    idempotencyKey: input.idempotencyKey,
  });
  if (existing) {
    assertCompatibleIdempotentRetry(existing, input, 'SDK');
    if (!isIntentCheckoutIncomplete(existing)) {
      return resolveExistingPhonePeSdkIntent(existing, requestId);
    }
    return runSdkCheckoutLaunch(existing, customer, existing.amountPaise, userId, requestId);
  }

  await assertCustomerCanStartFinancialActivity(String(customer._id));

  const quotedAt = new Date();
  const targetSchemeMonth = await resolveTargetSchemeMonth(
    input.schemeId,
    input.schemeMonth,
    undefined,
    quotedAt,
  );
  const rules = await getPaymentRules(input.schemeId, quotedAt, input.amountPaise, undefined, {
    targetSchemeMonth,
  });
  await assertInstallmentAndGoldRules(scheme, input.amountPaise, rules);

  const quoteExpiresAt = new Date(quotedAt.getTime() + PAYMENT_QUOTE_TTL_MS);
  const intent = await getOrCreatePaymentIntent({
    customerId: customer._id,
    schemeId: scheme._id,
    input,
    targetSchemeMonth,
    checkoutChannel: 'SDK',
    quotedAt,
    quoteExpiresAt,
    rules,
    actorUserId: userId,
    requestId,
  });

  if (!isIntentCheckoutIncomplete(intent)) {
    return resolveExistingPhonePeSdkIntent(intent, requestId);
  }

  return runSdkCheckoutLaunch(intent, customer, input.amountPaise, userId, requestId);
}

export async function initiateStaffPhonePe(
  staffUserId: string,
  input: InitiatePhonePeInput & { customerId: string },
  requestId?: string,
  webOrigin?: string,
) {
  await assertGatewayEnabled();
  const [customer, scheme] = await Promise.all([
    Customer.findById(input.customerId).populate('userId', 'phone'),
    SchemeEnrollment.findOne({
      _id: input.schemeId,
      customerId: input.customerId,
      status: 'ACTIVE',
    }).populate('schemePlanId'),
  ]);
  if (!customer) throw new AppError('CUSTOMER_NOT_FOUND', 'Customer profile not found', 404);
  if (!scheme) throw new AppError('SCHEME_NOT_FOUND', 'Owned scheme not found', 404);

  const idempotencyScope = phonePeIdempotencyScope('WEB', 'STAFF');
  const existing = await PaymentIntent.findOne({
    customerId: customer._id,
    idempotencyScope,
    idempotencyKey: input.idempotencyKey,
  });
  if (existing) {
    assertCompatibleIdempotentRetry(existing, input, 'WEB');
    if (!isIntentCheckoutIncomplete(existing)) {
      return resolveExistingPhonePeIntent(existing, requestId);
    }
    return runWebCheckoutLaunch(
      existing,
      customer,
      existing.amountPaise,
      staffUserId,
      requestId,
      webOrigin,
      String((customer.userId as { phone?: string } | null)?.phone ?? ''),
    );
  }

  await assertCustomerCanStartFinancialActivity(String(customer._id));

  const quotedAt = new Date();
  const targetSchemeMonth = await resolveTargetSchemeMonth(
    String(scheme._id),
    input.schemeMonth,
    undefined,
    quotedAt,
  );
  const rules = await getPaymentRules(String(scheme._id), quotedAt, input.amountPaise, undefined, {
    targetSchemeMonth,
  });
  await assertInstallmentAndGoldRules(scheme, input.amountPaise, rules);

  const quoteExpiresAt = new Date(quotedAt.getTime() + PAYMENT_QUOTE_TTL_MS);
  const intent = await getOrCreatePaymentIntent({
    customerId: customer._id,
    schemeId: scheme._id,
    input,
    targetSchemeMonth,
    checkoutChannel: 'WEB',
    quotedAt,
    quoteExpiresAt,
    rules,
    actorUserId: staffUserId,
    requestId: requestId ?? randomUUID(),
    collectorRole: 'STAFF',
  });

  if (!isIntentCheckoutIncomplete(intent)) {
    return resolveExistingPhonePeIntent(intent, requestId);
  }

  return runWebCheckoutLaunch(
    intent,
    customer,
    input.amountPaise,
    staffUserId,
    requestId,
    webOrigin,
    String((customer.userId as { phone?: string } | null)?.phone ?? ''),
  );
}

export async function initiateStaffPhonePeSdkOrder(
  staffUserId: string,
  input: InitiatePhonePeInput & { customerId: string },
  requestId?: string,
) {
  await assertGatewayEnabled();
  const [customer, scheme] = await Promise.all([
    Customer.findById(input.customerId).populate('userId', 'phone'),
    SchemeEnrollment.findOne({
      _id: input.schemeId,
      customerId: input.customerId,
      status: 'ACTIVE',
    }).populate('schemePlanId'),
  ]);
  if (!customer) throw new AppError('CUSTOMER_NOT_FOUND', 'Customer profile not found', 404);
  if (!scheme) throw new AppError('SCHEME_NOT_FOUND', 'Owned scheme not found', 404);

  const idempotencyScope = phonePeIdempotencyScope('SDK', 'STAFF');
  const existing = await PaymentIntent.findOne({
    customerId: customer._id,
    idempotencyScope,
    idempotencyKey: input.idempotencyKey,
  });
  if (existing) {
    assertCompatibleIdempotentRetry(existing, input, 'SDK');
    if (!isIntentCheckoutIncomplete(existing)) {
      return resolveExistingPhonePeSdkIntent(existing, requestId);
    }
    return runSdkCheckoutLaunch(
      existing,
      customer,
      existing.amountPaise,
      staffUserId,
      requestId,
    );
  }

  await assertCustomerCanStartFinancialActivity(String(customer._id));

  const quotedAt = new Date();
  const targetSchemeMonth = await resolveTargetSchemeMonth(
    String(scheme._id),
    input.schemeMonth,
    undefined,
    quotedAt,
  );
  const rules = await getPaymentRules(String(scheme._id), quotedAt, input.amountPaise, undefined, {
    targetSchemeMonth,
  });
  await assertInstallmentAndGoldRules(scheme, input.amountPaise, rules);

  const quoteExpiresAt = new Date(quotedAt.getTime() + PAYMENT_QUOTE_TTL_MS);
  const intent = await getOrCreatePaymentIntent({
    customerId: customer._id,
    schemeId: scheme._id,
    input,
    targetSchemeMonth,
    checkoutChannel: 'SDK',
    quotedAt,
    quoteExpiresAt,
    rules,
    actorUserId: staffUserId,
    requestId: requestId ?? randomUUID(),
    collectorRole: 'STAFF',
  });

  if (!isIntentCheckoutIncomplete(intent)) {
    return resolveExistingPhonePeSdkIntent(intent, requestId);
  }

  return runSdkCheckoutLaunch(intent, customer, input.amountPaise, staffUserId, requestId);
}

export async function getStaffPaymentIntent(staffUserId: string, orderId: string) {
  const intent = await PaymentIntent.findOne({
    merchantTransactionId: orderId,
    createdBy: staffUserId,
    collectorRole: 'STAFF',
  })
    .select(
      'merchantTransactionId status expiresAt quoteExpiresAt checkoutUrl checkoutChannel amountPaise goldRatePerGramPaise goldWeightMg goldPurity',
    )
    .lean();
  if (!intent) throw new AppError('PAYMENT_INTENT_NOT_FOUND', 'Payment attempt not found', 404);
  const payment =
    intent.status === 'SUCCESS'
      ? await Payment.findOne({
          merchantTransactionId: orderId,
          collectedBy: staffUserId,
          collectorRole: 'STAFF',
        })
          .select(
            '_id receiptNumber amountPaise paymentDate status method referenceNumber goldRatePerGramPaise goldWeightMg goldPurity',
          )
          .lean()
      : null;
  return { ...intent, payment };
}

function intentStartedAt(intent: { quoteCreatedAt?: Date; createdAt?: Date }) {
  return intent.quoteCreatedAt ?? intent.createdAt ?? new Date();
}

/**
 * Shared PhonePe status reconciliation for webhook and recovery worker.
 * Never fails a payment solely due to age/network; only PhonePe FAILED is terminal failure.
 */
export async function reconcilePaymentIntentStatus(
  intentId: string,
  source: PaymentFinalStatusSource,
  requestId: string,
  prefetched?: GatewayStatus,
) {
  const intent = await PaymentIntent.findById(intentId);
  if (!intent) throw new AppError('PAYMENT_INTENT_NOT_FOUND', 'Payment attempt not found', 404);
  if (intent.status === 'SUCCESS' || intent.status === 'FAILED' || intent.status === 'REVIEW_REQUIRED') {
    return {
      state: intent.status as 'SUCCESS' | 'FAILED' | 'REVIEW_REQUIRED',
      skipped: true as const,
    };
  }

  let status: GatewayStatus;
  try {
    status = prefetched ?? (await phonePeProvider.checkStatus(intent.merchantTransactionId));
  } catch (error: unknown) {
    const now = new Date();
    const started = intentStartedAt(intent);

    // Definitive absence after uncertain create → allow a controlled create retry.
    if (intent.status === 'PROVIDER_CREATE_UNCERTAIN' && isProviderOrderAbsentError(error)) {
      intent.status = 'PENDING';
      intent.lastGatewayError = 'PROVIDER_ORDER_ABSENT_ALLOW_CREATE_RETRY';
      intent.lastStatusCheckedAt = now;
      intent.statusCheckAttempts = (intent.statusCheckAttempts ?? 0) + 1;
      intent.nextStatusCheckAt = undefined;
      intent.providerOrderId = null as unknown as undefined;
      intent.checkoutUrl = null as unknown as undefined;
      intent.sdkToken = null as unknown as undefined;
      intent.recoveryLockedAt = undefined;
      intent.recoveryLockUntil = undefined;
      intent.recoveryLockedBy = undefined;
      intent.providerLaunchLockedAt = null as unknown as undefined;
      intent.providerLaunchLockUntil = null as unknown as undefined;
      intent.providerLaunchLockedBy = null as unknown as undefined;
      await intent.save();
      return { state: 'PENDING' as const, allowCreateRetry: true as const };
    }

    // Uncertain / network / auth / 5xx — keep recoverable, never recreate.
    intent.lastStatusCheckedAt = now;
    intent.statusCheckAttempts = (intent.statusCheckAttempts ?? 0) + 1;
    intent.lastGatewayError = String((error as { message?: string })?.message ?? error).slice(
      0,
      500,
    );
    intent.nextStatusCheckAt = nextPaymentRecoveryCheckAt(started, now);
    await intent.save();
    void reportPaymentIntentException(
      intent,
      'PAYMENT_STATUS_CHECK_FAILED',
      intent.lastGatewayError,
    );
    return {
      state: (intent.status === 'PROVIDER_CREATE_UNCERTAIN'
        ? 'PROVIDER_CREATE_UNCERTAIN'
        : 'PENDING') as 'PROVIDER_CREATE_UNCERTAIN' | 'PENDING',
      transientError: true as const,
    };
  }

  const now = new Date();
  intent.lastStatusCheckedAt = now;
  intent.statusCheckAttempts = (intent.statusCheckAttempts ?? 0) + 1;

  if (status.amountPaise !== intent.amountPaise) {
    intent.lastGatewayError = 'GATEWAY_AMOUNT_MISMATCH';
    intent.nextStatusCheckAt = new Date(now.getTime() + 30 * 60_000);
    // Keep uncertain intents recovery-only even on amount mismatch.
    await intent.save();
    logger.error(
      {
        merchantTransactionId: intent.merchantTransactionId,
        expected: intent.amountPaise,
        actual: status.amountPaise,
      },
      'PhonePe amount mismatch during reconciliation',
    );
    void reportPaymentIntentException(
      intent,
      'PAYMENT_AMOUNT_MISMATCH',
      'PhonePe amount does not match payment intent',
    );
    return {
      state: (intent.status === 'PROVIDER_CREATE_UNCERTAIN'
        ? 'PROVIDER_CREATE_UNCERTAIN'
        : 'PENDING') as 'PROVIDER_CREATE_UNCERTAIN' | 'PENDING',
      amountMismatch: true as const,
    };
  }

  if (status.state === 'SUCCESS') {
    let result:
      | { state: 'SUCCESS'; skipped?: true; paymentId?: unknown }
      | { state: 'REVIEW_REQUIRED'; skipped?: true; conflictingPaymentId?: unknown };
    try {
      result = await withMongoTransaction(async (session) => {
        const active = await PaymentIntent.findById(intent._id).session(session);
        if (!active)
          throw new AppError('PAYMENT_INTENT_NOT_FOUND', 'Payment attempt not found', 404);
        if (active.status === 'SUCCESS') {
          return { state: 'SUCCESS' as const, skipped: true as const };
        }
        if (active.status === 'REVIEW_REQUIRED') {
          return { state: 'REVIEW_REQUIRED' as const, skipped: true as const };
        }

        try {
          const payment = await finalizeGatewayPayment(
            active,
            status,
            {
              requestId,
              actorId: String(active.createdBy),
              actorRole: active.collectorRole ?? 'CUSTOMER',
            },
            session,
          );
          const meta = computeConfirmationMeta(active, now);
          const providerCompletedAt = extractProviderCompletedAt(status);
          await PaymentIntent.updateOne(
            { _id: active._id },
            {
              $set: {
                status: 'SUCCESS',
                finalStatusSource: source,
                confirmedAt: now,
                ...(providerCompletedAt ? { providerCompletedAt } : {}),
                wasLateConfirmation: meta.wasLateConfirmation,
                confirmationDelaySeconds: meta.confirmationDelaySeconds,
                lastGatewayError: null,
                nextStatusCheckAt: null,
                recoveryLockedAt: null,
                recoveryLockUntil: null,
                recoveryLockedBy: null,
                ...clearProviderLaunchLeaseSet(),
              },
              $unset: { activeAttemptKey: '' },
            },
            { session },
          );
          return { state: 'SUCCESS' as const, paymentId: payment._id };
        } catch (finalizeError) {
          // Another PaymentIntent already owns this scheme month. Never loop
          // forever retrying a finalize that can never succeed, never mutate
          // the existing installment, never pretend PhonePe failed.
          if (
            !(
              finalizeError instanceof AppError &&
              (finalizeError.code === 'INSTALLMENT_ALREADY_PAID' ||
                finalizeError.code === 'PAYMENT_LIMIT_EXCEEDED' ||
                finalizeError.code === 'FIRST_PERIOD_EMPTY' ||
                finalizeError.code === 'SCHEME_MATURED' ||
                finalizeError.code === 'SCHEME_NOT_ACTIVE' ||
                finalizeError.code === 'SCHEME_NOT_PAYABLE' ||
                finalizeError.code === 'INVALID_SCHEME_MONTH')
            )
          ) {
            throw finalizeError;
          }
          const conflicting = await Payment.findOne({
            schemeId: active.schemeId,
            schemeMonth: active.schemeMonth,
            status: 'SUCCESS',
          })
            .select('_id')
            .session(session);
          const providerCompletedAt = extractProviderCompletedAt(status);
          await PaymentIntent.updateOne(
            { _id: active._id },
            {
              $set: {
                status: 'REVIEW_REQUIRED',
                finalStatusSource: source,
                confirmedAt: now,
                ...(providerCompletedAt ? { providerCompletedAt } : {}),
                lastGatewayError: 'DUPLICATE_GATEWAY_CAPTURE',
                nextStatusCheckAt: null,
                recoveryLockedAt: null,
                recoveryLockUntil: null,
                recoveryLockedBy: null,
                ...clearProviderLaunchLeaseSet(),
              },
              $unset: { activeAttemptKey: '' },
            },
            { session },
          );
          return {
            state: 'REVIEW_REQUIRED' as const,
            conflictingPaymentId: conflicting?._id,
          };
        }
      }, requestId);
    } catch (error) {
      const message = String((error as { message?: string })?.message ?? error).slice(0, 500);
      const started = intentStartedAt(intent);
      intent.lastGatewayError = message;
      intent.nextStatusCheckAt = nextPaymentRecoveryCheckAt(started, now);
      await intent.save();
      void reportPaymentIntentException(intent, 'PAYMENT_FINALIZATION_FAILED', message);
      throw error;
    }

    if (result.state === 'REVIEW_REQUIRED') {
      // Runs after the transaction has committed, so awaiting here is safe —
      // and necessary, since a fire-and-forget write here could still be
      // in flight when the caller (or a test) checks for the exception, or
      // even race against connection teardown between test files.
      await reportDuplicateGatewayCapture(
        {
          _id: intent._id,
          customerId: intent.customerId,
          schemeId: intent.schemeId,
          schemeMonth: intent.schemeMonth,
          amountPaise: intent.amountPaise,
          merchantTransactionId: intent.merchantTransactionId,
        },
        result.conflictingPaymentId,
      );
    }
    return result;
  }

  if (status.state === 'FAILED') {
    intent.status = 'FAILED';
    intent.finalStatusSource = source;
    intent.lastGatewayError = undefined;
    intent.nextStatusCheckAt = undefined;
    intent.recoveryLockedAt = undefined;
    intent.recoveryLockUntil = undefined;
    intent.recoveryLockedBy = undefined;
    intent.providerLaunchLockedAt = null as unknown as undefined;
    intent.providerLaunchLockUntil = null as unknown as undefined;
    intent.providerLaunchLockedBy = null as unknown as undefined;
    intent.activeAttemptKey = undefined;
    await intent.save();
    return { state: 'FAILED' as const };
  }

  // Provider order exists and is still PENDING.
  // Uncertain creates must remain recovery-only — never become launchable PENDING.
  const started = intentStartedAt(intent);
  if (intent.status === 'PROVIDER_CREATE_UNCERTAIN') {
    if (isPaymentPendingTooLong(started, now)) {
      intent.lastGatewayError = 'PAYMENT_PENDING_TOO_LONG';
    } else if (intent.lastGatewayError === 'GATEWAY_AMOUNT_MISMATCH') {
      // keep mismatch marker until resolved
    } else {
      intent.lastGatewayError = undefined;
    }
    intent.nextStatusCheckAt = nextPaymentRecoveryCheckAt(started, now);
    await intent.save();
    if (intent.lastGatewayError === 'PAYMENT_PENDING_TOO_LONG') {
      void reportPaymentIntentException(intent, 'PAYMENT_PENDING_TOO_LONG');
    }
    return { state: 'PROVIDER_CREATE_UNCERTAIN' as const };
  }

  if (isPaymentPendingTooLong(started, now)) {
    intent.lastGatewayError = 'PAYMENT_PENDING_TOO_LONG';
  } else if (intent.lastGatewayError === 'GATEWAY_AMOUNT_MISMATCH') {
    // keep mismatch marker until resolved
  } else {
    intent.lastGatewayError = undefined;
  }
  intent.nextStatusCheckAt = nextPaymentRecoveryCheckAt(started, now);
  await intent.save();
  if (intent.lastGatewayError === 'PAYMENT_PENDING_TOO_LONG') {
    void reportPaymentIntentException(intent, 'PAYMENT_PENDING_TOO_LONG');
  }
  return { state: 'PENDING' as const };
}

/**
 * PhonePe SUCCESS arrived for a scheme month another Payment already owns.
 * Never invent ledger credit, never mutate the existing installment, never
 * pretend PhonePe failed — mark this intent REVIEW_REQUIRED and raise a
 * CRITICAL financial exception for manual ops review instead.
 */
async function reportDuplicateGatewayCapture(
  intent: {
    _id: unknown;
    customerId?: unknown;
    schemeId?: unknown;
    schemeMonth?: number;
    amountPaise?: number;
    merchantTransactionId?: string;
  },
  conflictingPaymentId?: unknown,
) {
  try {
    await upsertFinancialException({
      dedupeKey: `payment-intent:${intent._id}:DUPLICATE_GATEWAY_CAPTURE`,
      type: 'DUPLICATE_GATEWAY_CAPTURE',
      title: 'Duplicate gateway capture',
      description:
        'PhonePe reported SUCCESS for an installment that another payment already owns. Provider success was preserved but not auto-applied — requires manual review.',
      sourceType: 'PaymentIntent',
      sourceId: intent._id,
      paymentIntentId: intent._id,
      paymentId: conflictingPaymentId,
      customerId: intent.customerId,
      schemeId: intent.schemeId,
      amountPaise: intent.amountPaise,
      providerReference: intent.merchantTransactionId,
      metadata: {
        schemeMonth: intent.schemeMonth,
        conflictingPaymentId: conflictingPaymentId ? String(conflictingPaymentId) : undefined,
      },
    });
  } catch (error) {
    logger.error(
      { err: error, paymentIntentId: intent._id },
      'failed to report DUPLICATE_GATEWAY_CAPTURE exception',
    );
  }
}

/** Create-or-reuse the PaymentGatewayEvent row for this payload, then mark it processed. */
async function persistProcessedGatewayEvent(
  payloadHash: string,
  prior: { _id: unknown } | null,
  draft: Record<string, unknown>,
  session: import('mongoose').ClientSession,
) {
  let event = prior ? await PaymentGatewayEvent.findById(prior._id).session(session) : null;
  if (!event) {
    try {
      [event] = await PaymentGatewayEvent.create([draft], { session });
    } catch (error: any) {
      if (error?.code === 11000) return null;
      throw error;
    }
  }
  event.processedAt = new Date();
  await event.save({ session });
  return event;
}

async function processPaymentWebhookEvent(
  verified: Extract<VerifiedGatewayWebhook, { kind: 'PAYMENT' }>,
  payloadHash: string,
  prior: { _id: unknown; processedAt?: Date | null } | null,
  requestId: string,
) {
  const intent = await PaymentIntent.findOne({ merchantTransactionId: verified.merchantOrderId });
  if (!intent || verified.amountPaise !== intent.amountPaise)
    throw new AppError(
      'GATEWAY_VERIFICATION_FAILED',
      'Webhook does not match a payment intent',
      409,
    );

  const draft = {
    provider: 'PHONEPE',
    eventType: verified.event,
    payloadHash,
    merchantTransactionId: verified.merchantOrderId,
    verified: true,
    rawPayload: verified.raw,
  };

  if (intent.status === 'SUCCESS') {
    return withMongoTransaction(async (session) => {
      const event = await persistProcessedGatewayEvent(payloadHash, prior, draft, session);
      if (!event) return { duplicate: true };
      return { processed: true, state: intent.status };
    }, requestId);
  }

  // Server-authoritative status only — never finalize from webhook body alone.
  const serverStatus = await phonePeProvider.checkStatus(intent.merchantTransactionId);
  const reconciled = await reconcilePaymentIntentStatus(
    String(intent._id),
    'WEBHOOK',
    requestId,
    serverStatus,
  );

  return withMongoTransaction(async (session) => {
    const event = await persistProcessedGatewayEvent(payloadHash, prior, draft, session);
    if (!event) return { duplicate: true };
    return { processed: true, state: reconciled.state };
  }, requestId);
}

async function processRefundWebhookEvent(
  verified: Extract<VerifiedGatewayWebhook, { kind: 'REFUND' }>,
  payloadHash: string,
  prior: { _id: unknown; processedAt?: Date | null } | null,
  requestId: string,
) {
  const refund = await Refund.findOne({ merchantRefundId: verified.merchantRefundId });
  if (
    !refund ||
    verified.originalMerchantOrderId !== refund.originalMerchantOrderId ||
    verified.amountPaise !== refund.amountPaise
  )
    throw new AppError(
      'GATEWAY_VERIFICATION_FAILED',
      'Webhook does not match a refund record',
      409,
    );

  const draft = {
    provider: 'PHONEPE',
    eventType: verified.event,
    payloadHash,
    merchantRefundId: verified.merchantRefundId,
    originalMerchantOrderId: verified.originalMerchantOrderId,
    verified: true,
    rawPayload: verified.raw,
  };

  if (refund.status === 'SUCCESS' || refund.status === 'FAILED' || refund.status === 'REVIEW_REQUIRED') {
    return withMongoTransaction(async (session) => {
      const event = await persistProcessedGatewayEvent(payloadHash, prior, draft, session);
      if (!event) return { duplicate: true };
      return { processed: true, state: refund.status };
    }, requestId);
  }

  // Server-authoritative status only — a webhook body claiming SUCCESS is
  // never sufficient by itself; checkRefundStatus() is the source of truth
  // reconcileRefundStatus() actually finalizes against.
  const serverStatus = await phonePeProvider.checkRefundStatus(refund.merchantRefundId);
  let reconciledState: string;
  try {
    const reconciled = await reconcileRefundStatus(
      String(refund._id),
      { actorId: undefined, actorRole: 'ADMIN', requestId: `phonepe-webhook:${requestId}` },
      serverStatus,
    );
    reconciledState = reconciled.state;
  } catch (error) {
    // Terminal post-redemption conflict is already committed by reconcileRefundStatus.
    if (error instanceof AppError && error.code === 'REFUND_COMPLETED_AFTER_REDEMPTION') {
      reconciledState = 'REVIEW_REQUIRED';
    } else {
      throw error;
    }
  }

  return withMongoTransaction(async (session) => {
    const event = await persistProcessedGatewayEvent(payloadHash, prior, draft, session);
    if (!event) return { duplicate: true };
    return { processed: true, state: reconciledState };
  }, requestId);
}

async function recordUnknownWebhookEvent(
  verified: Extract<VerifiedGatewayWebhook, { kind: 'UNKNOWN' }>,
  payloadHash: string,
  prior: { _id: unknown; processedAt?: Date | null } | null,
  requestId: string,
) {
  const draft = {
    provider: 'PHONEPE',
    eventType: verified.event,
    payloadHash,
    verified: true,
    rawPayload: verified.raw,
  };
  return withMongoTransaction(async (session) => {
    const event = await persistProcessedGatewayEvent(payloadHash, prior, draft, session);
    if (!event) return { duplicate: true };
    // Authenticated but unrecognized event family — recorded and ignored,
    // never treated as a financial success.
    return { processed: true, ignored: true as const };
  }, requestId);
}

export async function processPhonePeWebhook(
  authorization: string | undefined,
  rawBody: Buffer,
  requestId: string,
) {
  const verified = phonePeProvider.verifyWebhook(authorization, rawBody);
  const payloadHash = createHash('sha256').update(rawBody).digest('hex');
  const prior = await PaymentGatewayEvent.findOne({ payloadHash });
  if (prior?.processedAt) return { duplicate: true };

  if (verified.kind === 'PAYMENT') {
    return processPaymentWebhookEvent(verified, payloadHash, prior, requestId);
  }
  if (verified.kind === 'REFUND') {
    return processRefundWebhookEvent(verified, payloadHash, prior, requestId);
  }
  return recordUnknownWebhookEvent(verified, payloadHash, prior, requestId);
}
