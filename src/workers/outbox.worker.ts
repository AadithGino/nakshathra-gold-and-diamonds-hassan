import { hostname } from 'node:os';
import { randomUUID } from 'node:crypto';
import { Customer, Notification, OutboxEvent } from '../models/index.js';
import { logger } from '../config/logger.js';
import { claimableOutboxFilter } from '../utils/mongo-filter.js';
import { formatCurrency } from '../utils/money.js';
import { reportOutboxException } from '../services/financial-exception.service.js';

export const OUTBOX_LEASE_MS = 300_000;
export const OUTBOX_MAX_ATTEMPTS = 10;
export const OUTBOX_BATCH_SIZE = 25;

let timer: NodeJS.Timeout | undefined;
let running = false;
let workerId = createOutboxWorkerId();

export function createOutboxWorkerId() {
  return `${hostname()}:${process.pid}:${randomUUID()}`;
}

/** Override the process worker id (tests / multi-instance simulation). */
export function setOutboxWorkerId(id: string) {
  workerId = id;
}

export function getOutboxWorkerId() {
  return workerId;
}

export function outboxBackoffMs(attempts: number) {
  return Math.min(3_600_000, 1000 * 2 ** attempts);
}

function clearLeaseFields() {
  return {
    lockedAt: null,
    lockUntil: null,
    lockedBy: null,
  };
}

export async function claimNextOutboxEvent(ownerId: string, at = new Date()) {
  return OutboxEvent.findOneAndUpdate(
    claimableOutboxFilter(at),
    {
      $set: {
        status: 'PROCESSING',
        lockedAt: at,
        lockUntil: new Date(at.getTime() + OUTBOX_LEASE_MS),
        lockedBy: ownerId,
      },
      $inc: { attempts: 1 },
    },
    { sort: { createdAt: 1 }, new: true },
  );
}

async function resolveNotificationUserId(event: {
  payload?: { userId?: unknown; customerUserId?: unknown; customerId?: unknown };
}) {
  let userId = event.payload?.userId ?? event.payload?.customerUserId;
  if (!userId && event.payload?.customerId) {
    userId = (await Customer.findById(event.payload.customerId).select('userId').lean())?.userId;
  }
  return userId;
}

function notificationCopy(type: string, payload?: Record<string, unknown>) {
  const month = payload?.schemeMonth;
  let amount = '₹0.00';
  try {
    amount = formatCurrency(Number(payload?.amountPaise ?? 0));
  } catch {
    amount = '₹0.00';
  }
  if (type === 'INSTALLMENT_DUE') {
    return {
      title: 'Scheme installment due',
      body: `Your month ${month} installment of ${amount} is now due.`,
    };
  }
  if (type === 'INSTALLMENT_OVERDUE') {
    return {
      title: 'Scheme installment overdue',
      body: `Your month ${month} installment of ${amount} is overdue.`,
    };
  }
  return {
    title: type.replaceAll('_', ' '),
    body: 'Your account has been updated.',
  };
}

export async function deliverOutboxNotification(event: {
  _id: unknown;
  type: string;
  payload?: Record<string, unknown>;
}) {
  const userId = await resolveNotificationUserId(event);
  if (!userId) return null;
  const copy = notificationCopy(event.type, event.payload);
  const data =
    event.type === 'INSTALLMENT_DUE' || event.type === 'INSTALLMENT_OVERDUE'
      ? {
          enrollmentId: event.payload?.enrollmentId,
          schemeMonth: event.payload?.schemeMonth,
          amountPaise: event.payload?.amountPaise,
          dueDate: event.payload?.dueDate,
          paymentWindowEndDate: event.payload?.paymentWindowEndDate,
        }
      : event.payload;
  try {
    await Notification.updateOne(
      { outboxEventId: event._id },
      {
        $setOnInsert: {
          outboxEventId: event._id,
          userId,
          type: event.type,
          title: copy.title,
          body: copy.body,
          data,
        },
      },
      { upsert: true },
    );
  } catch (error: any) {
    if (error?.code !== 11000) throw error;
  }
  return userId;
}

export async function markOutboxEventSent(eventId: unknown, ownerId: string, at = new Date()) {
  return OutboxEvent.updateOne(
    { _id: eventId, lockedBy: ownerId, status: 'PROCESSING' },
    {
      $set: {
        status: 'SENT',
        processedAt: at,
        lastError: null,
        ...clearLeaseFields(),
      },
    },
  );
}

export async function markOutboxEventDeliveryFailed(
  event: { _id: unknown; attempts: number; type: string; payload?: Record<string, unknown> },
  ownerId: string,
  error: unknown,
  at = new Date(),
) {
  const failed = event.attempts >= OUTBOX_MAX_ATTEMPTS;
  const lastError = String((error as { message?: string })?.message ?? error).slice(0, 500);
  const result = await OutboxEvent.updateOne(
    { _id: event._id, lockedBy: ownerId, status: 'PROCESSING' },
    {
      $set: {
        status: failed ? 'FAILED' : 'PENDING',
        availableAt: failed ? at : new Date(at.getTime() + outboxBackoffMs(event.attempts)),
        lastError,
        ...clearLeaseFields(),
      },
    },
  );
  if (failed) {
    await reportOutboxException(
      { _id: event._id, type: event.type, attempts: event.attempts, lastError, payload: event.payload },
      lastError,
    );
  }
  return result;
}

export async function processClaimedOutboxEvent(
  event: {
    _id: unknown;
    type: string;
    attempts: number;
    payload?: Record<string, unknown>;
  },
  ownerId: string,
) {
  try {
    await deliverOutboxNotification(event);
    const result = await markOutboxEventSent(event._id, ownerId);
    return { ok: true as const, modifiedCount: result.modifiedCount };
  } catch (error: unknown) {
    const result = await markOutboxEventDeliveryFailed(event, ownerId, error);
    logger.error({ err: error, outboxEventId: event._id }, 'outbox delivery failed');
    return { ok: false as const, modifiedCount: result.modifiedCount, error };
  }
}

export async function processOutboxBatch(
  ownerId = workerId,
  limit = OUTBOX_BATCH_SIZE,
  at = new Date(),
) {
  let processed = 0;
  for (let count = 0; count < limit; count++) {
    try {
      const event = await claimNextOutboxEvent(ownerId, at);
      if (!event) break;
      await processClaimedOutboxEvent(event, ownerId);
      processed += 1;
    } catch (error) {
      logger.error({ err: error }, 'outbox batch item failed; continuing');
    }
  }
  return processed;
}

async function processBatch() {
  if (running) return;
  running = true;
  try {
    await processOutboxBatch(workerId);
  } catch (error) {
    logger.error({ err: error }, 'outbox batch failed');
  } finally {
    running = false;
  }
}

function safeProcessBatch() {
  void processBatch().catch((error) => logger.error({ err: error }, 'outbox timer failed'));
}

export function startOutboxWorker() {
  if (timer) return;
  workerId = createOutboxWorkerId();
  timer = setInterval(safeProcessBatch, 5000);
  timer.unref();
  safeProcessBatch();
}

export function stopOutboxWorker() {
  if (timer) clearInterval(timer);
  timer = undefined;
  running = false;
}
