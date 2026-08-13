import { hostname } from 'node:os';
import { randomUUID } from 'node:crypto';
import { PaymentIntent } from '../models/index.js';
import { logger } from '../config/logger.js';
import {
  claimablePaymentRecoveryFilter,
  staleProviderCreatingFilter,
} from '../utils/mongo-filter.js';
import {
  PAYMENT_RECOVERY_BATCH_SIZE,
  PAYMENT_RECOVERY_LEASE_MS,
  nextPaymentRecoveryCheckAt,
} from '../utils/payment-recovery.js';
import {
  convertStaleProviderCreatingToUncertain,
  reconcilePaymentIntentStatus,
} from '../services/gateway.service.js';
import { reportPaymentIntentException } from '../services/financial-exception.service.js';

let timer: NodeJS.Timeout | undefined;
let running = false;
let workerId = createPaymentRecoveryWorkerId();

export function createPaymentRecoveryWorkerId() {
  return `${hostname()}:${process.pid}:${randomUUID()}`;
}

export function setPaymentRecoveryWorkerId(id: string) {
  workerId = id;
}

export function getPaymentRecoveryWorkerId() {
  return workerId;
}

export async function claimNextPaymentRecovery(ownerId: string, at = new Date()) {
  return PaymentIntent.findOneAndUpdate(
    claimablePaymentRecoveryFilter(at),
    {
      $set: {
        recoveryLockedAt: at,
        recoveryLockUntil: new Date(at.getTime() + PAYMENT_RECOVERY_LEASE_MS),
        recoveryLockedBy: ownerId,
      },
    },
    { sort: { nextStatusCheckAt: 1, createdAt: 1 }, new: true },
  );
}

async function clearRecoveryLease(intentId: unknown, ownerId: string) {
  await PaymentIntent.updateOne(
    { _id: intentId, recoveryLockedBy: ownerId },
    {
      $set: {
        recoveryLockedAt: null,
        recoveryLockUntil: null,
        recoveryLockedBy: null,
      },
    },
  );
}

/**
 * Convert expired PROVIDER_CREATING leases to PROVIDER_CREATE_UNCERTAIN.
 * Never calls PhonePe create — only prepares status recovery.
 */
export async function repairStaleProviderCreatingIntents(
  limit = PAYMENT_RECOVERY_BATCH_SIZE,
  at = new Date(),
) {
  let repaired = 0;
  for (let count = 0; count < limit; count++) {
    try {
      const stale = await PaymentIntent.findOne(staleProviderCreatingFilter(at))
        .sort({ updatedAt: 1, createdAt: 1 })
        .select('_id')
        .lean();
      if (!stale) break;
      const converted = await convertStaleProviderCreatingToUncertain(stale._id);
      if (!converted) continue;
      repaired += 1;
    } catch (error) {
      logger.error({ err: error }, 'stale PROVIDER_CREATING repair failed; continuing');
    }
  }
  return repaired;
}

export async function processClaimedPaymentRecovery(
  intent: {
    _id: unknown;
    customerId?: unknown;
    schemeId?: unknown;
    amountPaise?: number;
    merchantTransactionId?: string;
    quoteCreatedAt?: Date;
    createdAt?: Date;
  },
  ownerId: string,
) {
  try {
    return await reconcilePaymentIntentStatus(
      String(intent._id),
      'RECOVERY_WORKER',
      `payment-recovery:${ownerId}`,
    );
  } catch (error) {
    const message = String((error as { message?: string })?.message ?? error).slice(0, 500);
    logger.error({ err: error, paymentIntentId: intent._id }, 'payment recovery failed');
    const started = intent.quoteCreatedAt ?? intent.createdAt ?? new Date();
    await PaymentIntent.updateOne(
      { _id: intent._id },
      {
        $set: {
          lastGatewayError: message,
          nextStatusCheckAt: nextPaymentRecoveryCheckAt(started),
        },
      },
    );
    await reportPaymentIntentException(intent, 'PAYMENT_FINALIZATION_FAILED', message);
    return { state: 'PENDING' as const, recoveryError: true as const };
  } finally {
    await clearRecoveryLease(intent._id, ownerId);
  }
}

export async function processPaymentRecoveryBatch(
  ownerId = workerId,
  limit = PAYMENT_RECOVERY_BATCH_SIZE,
  at = new Date(),
) {
  let processed = 0;
  try {
    await repairStaleProviderCreatingIntents(limit, at);
  } catch (error) {
    logger.error({ err: error }, 'stale PROVIDER_CREATING batch failed; continuing');
  }
  for (let count = 0; count < limit; count++) {
    try {
      const intent = await claimNextPaymentRecovery(ownerId, at);
      if (!intent) break;
      await processClaimedPaymentRecovery(intent, ownerId);
      processed += 1;
    } catch (error) {
      logger.error({ err: error }, 'payment recovery batch item failed; continuing');
    }
  }
  return processed;
}

async function processBatch() {
  if (running) return;
  running = true;
  try {
    await processPaymentRecoveryBatch(workerId);
  } catch (error) {
    logger.error({ err: error }, 'payment recovery batch failed');
  } finally {
    running = false;
  }
}

function safeProcessBatch() {
  void processBatch().catch((error) =>
    logger.error({ err: error }, 'payment recovery timer failed'),
  );
}

/**
 * PhonePe's UAT cadence requires 3-second recovery polling in the busiest
 * window, so the worker tick must be well under that — 1 second — while
 * `nextStatusCheckAt` (persisted in MongoDB) remains the source of truth for
 * which intents are actually due. The in-memory timer only decides how often
 * we *look*; it never decides *what* is due.
 */
const WORKER_TICK_MS = 1_000;

export function startPaymentRecoveryWorker() {
  if (timer) return;
  workerId = createPaymentRecoveryWorkerId();
  timer = setInterval(safeProcessBatch, WORKER_TICK_MS);
  timer.unref();
  safeProcessBatch();
}

export function stopPaymentRecoveryWorker() {
  if (timer) clearInterval(timer);
  timer = undefined;
  running = false;
}
