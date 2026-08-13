import { hostname } from 'node:os';
import { randomUUID } from 'node:crypto';
import { Refund } from '../models/index.js';
import { logger } from '../config/logger.js';
import {
  claimableRefundRecoveryFilter,
  legacyUnscheduledActiveRefundFilter,
} from '../utils/mongo-filter.js';
import {
  REFUND_RECOVERY_BATCH_SIZE,
  REFUND_RECOVERY_LEASE_MS,
  nextRefundRecoveryCheckAt,
  scheduleInitialRefundStatusCheck,
} from '../utils/refund-recovery.js';
import { reconcileRefundStatus } from '../services/refund.service.js';
import { reportRefundException } from '../services/financial-exception.service.js';

let timer: NodeJS.Timeout | undefined;
let running = false;
let workerId = createRefundRecoveryWorkerId();

export function createRefundRecoveryWorkerId() {
  return `${hostname()}:${process.pid}:${randomUUID()}`;
}

export function setRefundRecoveryWorkerId(id: string) {
  workerId = id;
}

export function getRefundRecoveryWorkerId() {
  return workerId;
}

export async function claimNextRefundRecovery(ownerId: string, at = new Date()) {
  return Refund.findOneAndUpdate(
    claimableRefundRecoveryFilter(at),
    {
      $set: {
        recoveryLockedAt: at,
        recoveryLockUntil: new Date(at.getTime() + REFUND_RECOVERY_LEASE_MS),
        recoveryLockedBy: ownerId,
      },
    },
    { sort: { nextStatusCheckAt: 1, createdAt: 1 }, new: true },
  );
}

/**
 * Repair legacy active refunds that were committed before nextStatusCheckAt existed.
 * Schedules an immediate check and records an exception — never initiates a second provider refund.
 */
export async function repairUnscheduledActiveRefunds(limit = 25) {
  let repaired = 0;
  for (let i = 0; i < limit; i++) {
    const refund = await Refund.findOneAndUpdate(
      legacyUnscheduledActiveRefundFilter(),
      {
        $set: {
          nextStatusCheckAt: scheduleInitialRefundStatusCheck(new Date(0)),
          lastProviderResponse: {
            repaired: 'REFUND_MISSING_RECOVERY_SCHEDULE',
            at: new Date(),
          },
        },
      },
      { sort: { createdAt: 1 }, new: true },
    );
    if (!refund) break;
    try {
      await reportRefundException(
        refund,
        'REFUND_MISSING_RECOVERY_SCHEDULE',
        'Active refund was missing nextStatusCheckAt; scheduled status recovery without re-initiating',
      );
    } catch (error) {
      logger.error({ err: error, refundId: refund._id }, 'failed to report missing schedule exception');
    }
    repaired += 1;
  }
  return repaired;
}

async function clearRefundRecoveryLease(refundId: unknown, ownerId: string) {
  await Refund.updateOne(
    { _id: refundId, recoveryLockedBy: ownerId },
    {
      $set: {
        recoveryLockedAt: null,
        recoveryLockUntil: null,
        recoveryLockedBy: null,
      },
    },
  );
}

export async function processClaimedRefundRecovery(
  refund: {
    _id: unknown;
    paymentId?: unknown;
    customerId?: unknown;
    schemeId?: unknown;
    amountPaise?: number;
    merchantRefundId?: string;
    requestedAt?: Date;
    createdAt?: Date;
  },
  ownerId: string,
) {
  try {
    return await reconcileRefundStatus(String(refund._id), {
      actorId: undefined,
      actorRole: 'ADMIN',
      requestId: `refund-recovery:${ownerId}`,
    });
  } catch (error) {
    const code = (error as { code?: string })?.code;
    // Terminal conflict already committed — never reschedule polling.
    if (code === 'REFUND_COMPLETED_AFTER_REDEMPTION') {
      logger.warn(
        { refundId: refund._id },
        'refund recovery hit committed post-redemption conflict; stopping polls',
      );
      return { state: 'REVIEW_REQUIRED' as const, conflict: true as const };
    }
    const message = String((error as { message?: string })?.message ?? error).slice(0, 500);
    logger.error({ err: error, refundId: refund._id }, 'refund recovery failed');
    const started = refund.requestedAt ?? refund.createdAt ?? new Date();
    await Refund.updateOne(
      { _id: refund._id, status: { $in: ['INITIATED', 'PENDING'] }, active: true },
      {
        $set: {
          providerErrorCode: 'RECOVERY_ERROR',
          lastProviderError: message,
          nextStatusCheckAt: nextRefundRecoveryCheckAt(started),
          lastProviderResponse: { recoveryError: message },
        },
      },
    );
    await reportRefundException(refund, 'REFUND_STATUS_CHECK_FAILED', message);
    return { state: 'PENDING' as const, recoveryError: true as const };
  } finally {
    await clearRefundRecoveryLease(refund._id, ownerId);
  }
}

export async function processRefundRecoveryBatch(
  ownerId = workerId,
  limit = REFUND_RECOVERY_BATCH_SIZE,
  at = new Date(),
) {
  try {
    await repairUnscheduledActiveRefunds(Math.min(10, limit));
  } catch (error) {
    logger.error({ err: error }, 'legacy refund schedule repair failed; continuing batch');
  }

  let processed = 0;
  for (let count = 0; count < limit; count++) {
    try {
      const refund = await claimNextRefundRecovery(ownerId, at);
      if (!refund) break;
      await processClaimedRefundRecovery(refund, ownerId);
      processed += 1;
    } catch (error) {
      logger.error({ err: error }, 'refund recovery batch item failed; continuing');
    }
  }
  return processed;
}

async function processBatch() {
  if (running) return;
  running = true;
  try {
    await processRefundRecoveryBatch(workerId);
  } catch (error) {
    logger.error({ err: error }, 'refund recovery batch failed');
  } finally {
    running = false;
  }
}

function safeProcessBatch() {
  void processBatch().catch((error) =>
    logger.error({ err: error }, 'refund recovery timer failed'),
  );
}

export function startRefundRecoveryWorker() {
  if (timer) return;
  workerId = createRefundRecoveryWorkerId();
  timer = setInterval(safeProcessBatch, 30_000);
  timer.unref();
  safeProcessBatch();
}

export function stopRefundRecoveryWorker() {
  if (timer) clearInterval(timer);
  timer = undefined;
  running = false;
}
