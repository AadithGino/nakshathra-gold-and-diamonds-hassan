import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import mongoose from 'mongoose';
import { Notification, OutboxEvent } from '../src/models/index.js';
import {
  OUTBOX_LEASE_MS,
  OUTBOX_MAX_ATTEMPTS,
  claimNextOutboxEvent,
  deliverOutboxNotification,
  markOutboxEventSent,
  outboxBackoffMs,
  processClaimedOutboxEvent,
  processOutboxBatch,
  setOutboxWorkerId,
} from '../src/workers/outbox.worker.js';
import { clearTestMongo, startTestMongo, stopTestMongo } from './helpers/mongo.js';

async function seedPendingEvent(overrides: Record<string, unknown> = {}) {
  const userId = new mongoose.Types.ObjectId();
  const [event] = await OutboxEvent.create([
    {
      type: 'PAYMENT_RECEIPT_READY',
      aggregateType: 'Payment',
      aggregateId: new mongoose.Types.ObjectId(),
      payload: { userId, receiptNumber: 'KRL-2026-0000001' },
      status: 'PENDING',
      availableAt: new Date(0),
      attempts: 0,
      ...overrides,
    },
  ]);
  return { event, userId };
}

describe('recoverable outbox worker', () => {
  beforeAll(async () => {
    await startTestMongo();
  }, 120_000);

  afterAll(async () => {
    await stopTestMongo();
  });

  beforeEach(async () => {
    await clearTestMongo();
    setOutboxWorkerId('test-worker-a');
    vi.restoreAllMocks();
  });

  it('processes a PENDING event once and creates one notification', async () => {
    const { event, userId } = await seedPendingEvent();
    const processed = await processOutboxBatch('worker-1');
    expect(processed).toBe(1);

    const updated = await OutboxEvent.findById(event._id).lean();
    expect(updated?.status).toBe('SENT');
    expect(updated?.lockedBy).toBeNull();
    expect(updated?.lockUntil).toBeNull();

    const notifications = await Notification.find({ outboxEventId: event._id }).lean();
    expect(notifications).toHaveLength(1);
    expect(String(notifications[0]?.userId)).toBe(String(userId));
  });

  it('does not claim a PROCESSING event with a future lock', async () => {
    const now = new Date();
    await seedPendingEvent({
      status: 'PROCESSING',
      lockedAt: now,
      lockUntil: new Date(now.getTime() + OUTBOX_LEASE_MS),
      lockedBy: 'other-worker',
      attempts: 1,
    });

    const claimed = await claimNextOutboxEvent('worker-1', now);
    expect(claimed).toBeNull();
    expect(await processOutboxBatch('worker-1', 5, now)).toBe(0);
  });

  it('reclaims a PROCESSING event whose lock has expired', async () => {
    const now = new Date();
    const { event } = await seedPendingEvent({
      status: 'PROCESSING',
      lockedAt: new Date(now.getTime() - OUTBOX_LEASE_MS - 1_000),
      lockUntil: new Date(now.getTime() - 1_000),
      lockedBy: 'crashed-worker',
      attempts: 1,
    });

    const claimed = await claimNextOutboxEvent('worker-2', now);
    expect(claimed).not.toBeNull();
    expect(String(claimed!._id)).toBe(String(event._id));
    expect(claimed!.lockedBy).toBe('worker-2');
    expect(claimed!.attempts).toBe(2);
  });

  it('does not create a duplicate notification after a crash mid-delivery', async () => {
    const { event, userId } = await seedPendingEvent();
    const now = new Date();

    const claimed = await claimNextOutboxEvent('worker-1', now);
    expect(claimed).not.toBeNull();
    await deliverOutboxNotification(claimed!);
    // Crash: notification exists, event still PROCESSING with an expired lease.
    await OutboxEvent.updateOne(
      { _id: event._id },
      {
        $set: {
          status: 'PROCESSING',
          lockedBy: 'worker-1',
          lockUntil: new Date(now.getTime() - 1),
          lockedAt: new Date(now.getTime() - OUTBOX_LEASE_MS),
        },
      },
    );

    expect(await Notification.countDocuments({ outboxEventId: event._id })).toBe(1);

    const reclaimed = await claimNextOutboxEvent('worker-2', new Date());
    expect(reclaimed).not.toBeNull();
    await processClaimedOutboxEvent(reclaimed!, 'worker-2');

    expect(await Notification.countDocuments({ outboxEventId: event._id })).toBe(1);
    expect(await Notification.countDocuments({ userId })).toBe(1);
    const sent = await OutboxEvent.findById(event._id).lean();
    expect(sent?.status).toBe('SENT');
  });

  it('applies exponential retry backoff on delivery failure', async () => {
    const { event } = await seedPendingEvent();
    vi.spyOn(Notification, 'updateOne').mockRejectedValueOnce(new Error('smtp down'));

    const claimed = await claimNextOutboxEvent('worker-1');
    expect(claimed?.attempts).toBe(1);
    await processClaimedOutboxEvent(claimed!, 'worker-1');

    const updated = await OutboxEvent.findById(event._id).lean();
    expect(updated?.status).toBe('PENDING');
    expect(updated?.lockedBy).toBeNull();
    expect(updated?.lastError).toMatch(/smtp down/i);
    const expectedDelay = outboxBackoffMs(1);
    const delta = (updated!.availableAt as Date).getTime() - Date.now();
    expect(delta).toBeGreaterThan(expectedDelay - 5_000);
    expect(delta).toBeLessThanOrEqual(expectedDelay + 5_000);
  });

  it('marks the event FAILED after the maximum attempts', async () => {
    const { event } = await seedPendingEvent({ attempts: OUTBOX_MAX_ATTEMPTS - 1 });
    vi.spyOn(Notification, 'updateOne').mockRejectedValueOnce(new Error('permanent failure'));

    const claimed = await claimNextOutboxEvent('worker-1');
    expect(claimed?.attempts).toBe(OUTBOX_MAX_ATTEMPTS);
    await processClaimedOutboxEvent(claimed!, 'worker-1');

    const updated = await OutboxEvent.findById(event._id).lean();
    expect(updated?.status).toBe('FAILED');
    expect(updated?.lockedBy).toBeNull();
    expect(updated?.lockUntil).toBeNull();

    const { FinancialException } = await import('../src/models/index.js');
    expect(
      await FinancialException.countDocuments({
        type: 'OUTBOX_DELIVERY_FAILED',
        dedupeKey: `outbox:${event._id}:OUTBOX_DELIVERY_FAILED`,
      }),
    ).toBe(1);
  });

  it('reclaims legacy PROCESSING events with a missing lockUntil', async () => {
    const { event, userId } = await seedPendingEvent();
    await OutboxEvent.updateOne(
      { _id: event._id },
      {
        $set: { status: 'PROCESSING', lockedBy: 'legacy-worker', attempts: 1 },
        $unset: { lockUntil: 1, lockedAt: 1 },
      },
    );

    const claimed = await claimNextOutboxEvent('worker-legacy-fix');
    expect(claimed).not.toBeNull();
    expect(String(claimed!._id)).toBe(String(event._id));
    await processClaimedOutboxEvent(claimed!, 'worker-legacy-fix');
    expect(await Notification.countDocuments({ userId })).toBe(1);
    expect((await OutboxEvent.findById(event._id))?.status).toBe('SENT');
  });

  it('prevents two workers from owning the same active lease', async () => {
    await seedPendingEvent();
    const first = await claimNextOutboxEvent('worker-a');
    const second = await claimNextOutboxEvent('worker-b');
    expect(first).not.toBeNull();
    expect(second).toBeNull();
    expect(first!.lockedBy).toBe('worker-a');

    const stolen = await markOutboxEventSent(first!._id, 'worker-b');
    expect(stolen.modifiedCount).toBe(0);
    const stillProcessing = await OutboxEvent.findById(first!._id).lean();
    expect(stillProcessing?.status).toBe('PROCESSING');
    expect(stillProcessing?.lockedBy).toBe('worker-a');

    const owned = await markOutboxEventSent(first!._id, 'worker-a');
    expect(owned.modifiedCount).toBe(1);
  });
});
