import { beforeAll, beforeEach, describe, expect, it } from '@jest/globals';
import mongoose from 'mongoose';
import { clearJestMongo, connectJestMongo, api } from './helpers/http.js';
import { Notification, OutboxEvent } from '../../src/models/index.js';
import {
  claimNextOutboxEvent,
  deliverOutboxNotification,
  processOutboxBatch,
} from '../../src/workers/outbox.worker.js';

describe('Phase 2 — recoverable outbox (jest)', () => {
  beforeAll(async () => {
    await connectJestMongo();
  });

  beforeEach(async () => {
    await clearJestMongo();
  });

  it('GET /health still works with outbox worker code loaded', async () => {
    await api().get('/health').expect(200);
  });

  it('processes a pending outbox event exactly once', async () => {
    const userId = new mongoose.Types.ObjectId();
    const [event] = await OutboxEvent.create([
      {
        type: 'PAYMENT_RECEIPT_READY',
        aggregateType: 'Payment',
        aggregateId: new mongoose.Types.ObjectId(),
        payload: { userId },
        status: 'PENDING',
        availableAt: new Date(0),
      },
    ]);

    expect(await processOutboxBatch('jest-worker', 5)).toBe(1);
    expect(await processOutboxBatch('jest-worker', 5)).toBe(0);

    const updated = await OutboxEvent.findById(event._id).lean();
    expect(updated?.status).toBe('SENT');
    expect(await Notification.countDocuments({ outboxEventId: event._id })).toBe(1);
  });

  it('does not duplicate notifications after a crash mid-delivery', async () => {
    const userId = new mongoose.Types.ObjectId();
    const [event] = await OutboxEvent.create([
      {
        type: 'PAYMENT_RECEIPT_READY',
        aggregateType: 'Payment',
        aggregateId: new mongoose.Types.ObjectId(),
        payload: { userId },
        status: 'PENDING',
        availableAt: new Date(0),
      },
    ]);

    const claimed = await claimNextOutboxEvent('worker-1');
    await deliverOutboxNotification(claimed!);
    await OutboxEvent.updateOne(
      { _id: event._id },
      {
        $set: {
          status: 'PROCESSING',
          lockedBy: 'worker-1',
          lockUntil: new Date(Date.now() - 1),
        },
      },
    );

    await processOutboxBatch('worker-2', 5);
    expect(await Notification.countDocuments({ outboxEventId: event._id })).toBe(1);
    expect((await OutboxEvent.findById(event._id).lean())?.status).toBe('SENT');
  });
});
