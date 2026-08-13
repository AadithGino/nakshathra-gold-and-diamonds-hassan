import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import mongoose from 'mongoose';
import { PaymentIntent } from '../src/models/index.js';
import { getOrCreatePaymentIntent } from '../src/services/gateway.service.js';
import { AppError } from '../src/utils/AppError.js';
import { clearTestMongo, startTestMongo, stopTestMongo } from './helpers/mongo.js';

const INSTALLMENT = 100_000;

function rulesStub() {
  return {
    goldRateId: new mongoose.Types.ObjectId(),
    goldRatePerGramPaise: 750_000,
    goldWeightMg: 133,
    goldPurity: '916',
  } as any;
}

describe('PhonePe initiation idempotency', () => {
  const customerId = new mongoose.Types.ObjectId();
  const schemeId = new mongoose.Types.ObjectId();
  const otherSchemeId = new mongoose.Types.ObjectId();
  const actorUserId = new mongoose.Types.ObjectId().toString();
  const quotedAt = new Date();
  const quoteExpiresAt = new Date(quotedAt.getTime() + 15 * 60_000);

  beforeAll(async () => {
    await startTestMongo();
  }, 120_000);

  afterAll(async () => {
    await stopTestMongo();
  });

  beforeEach(async () => {
    await clearTestMongo();
  });

  it('returns the same merchant transaction ID for the same key and request', async () => {
    const input = {
      schemeId: String(schemeId),
      amountPaise: INSTALLMENT,
      idempotencyKey: 'same-key-retry-0001',
      schemeMonth: 1,
    };
    const first = await getOrCreatePaymentIntent({
      customerId,
      schemeId,
      input,
      targetSchemeMonth: 1,
      checkoutChannel: 'WEB',
      quotedAt,
      quoteExpiresAt,
      rules: rulesStub(),
      actorUserId,
      requestId: 'r1',
    });
    const second = await getOrCreatePaymentIntent({
      customerId,
      schemeId,
      input,
      targetSchemeMonth: 1,
      checkoutChannel: 'WEB',
      quotedAt,
      quoteExpiresAt,
      rules: rulesStub(),
      actorUserId,
      requestId: 'r2',
    });
    expect(second.merchantTransactionId).toBe(first.merchantTransactionId);
    expect(await PaymentIntent.countDocuments({})).toBe(1);
  });

  it('rejects same key with different amount', async () => {
    await getOrCreatePaymentIntent({
      customerId,
      schemeId,
      input: {
        schemeId: String(schemeId),
        amountPaise: INSTALLMENT,
        idempotencyKey: 'amount-key-0001',
        schemeMonth: 1,
      },
      targetSchemeMonth: 1,
      checkoutChannel: 'WEB',
      quotedAt,
      quoteExpiresAt,
      rules: rulesStub(),
      actorUserId,
      requestId: 'r1',
    });

    await expect(
      getOrCreatePaymentIntent({
        customerId,
        schemeId,
        input: {
          schemeId: String(schemeId),
          amountPaise: INSTALLMENT + 100_000,
          idempotencyKey: 'amount-key-0001',
          schemeMonth: 1,
        },
        targetSchemeMonth: 1,
        checkoutChannel: 'WEB',
        quotedAt,
        quoteExpiresAt,
        rules: rulesStub(),
        actorUserId,
        requestId: 'r2',
      }),
    ).rejects.toMatchObject({
      code: 'IDEMPOTENCY_KEY_REUSED',
      statusCode: 409,
    } satisfies Partial<AppError>);
  });

  it('rejects same key with different scheme', async () => {
    await getOrCreatePaymentIntent({
      customerId,
      schemeId,
      input: {
        schemeId: String(schemeId),
        amountPaise: INSTALLMENT,
        idempotencyKey: 'scheme-key-0001',
        schemeMonth: 1,
      },
      targetSchemeMonth: 1,
      checkoutChannel: 'WEB',
      quotedAt,
      quoteExpiresAt,
      rules: rulesStub(),
      actorUserId,
      requestId: 'r1',
    });

    await expect(
      getOrCreatePaymentIntent({
        customerId,
        schemeId: otherSchemeId,
        input: {
          schemeId: String(otherSchemeId),
          amountPaise: INSTALLMENT,
          idempotencyKey: 'scheme-key-0001',
          schemeMonth: 1,
        },
        targetSchemeMonth: 1,
        checkoutChannel: 'WEB',
        quotedAt,
        quoteExpiresAt,
        rules: rulesStub(),
        actorUserId,
        requestId: 'r2',
      }),
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_KEY_REUSED', statusCode: 409 });
  });

  it('rejects same key with different scheme month', async () => {
    await getOrCreatePaymentIntent({
      customerId,
      schemeId,
      input: {
        schemeId: String(schemeId),
        amountPaise: INSTALLMENT,
        idempotencyKey: 'month-key-0001',
        schemeMonth: 1,
      },
      targetSchemeMonth: 1,
      checkoutChannel: 'WEB',
      quotedAt,
      quoteExpiresAt,
      rules: rulesStub(),
      actorUserId,
      requestId: 'r1',
    });

    await expect(
      getOrCreatePaymentIntent({
        customerId,
        schemeId,
        input: {
          schemeId: String(schemeId),
          amountPaise: INSTALLMENT,
          idempotencyKey: 'month-key-0001',
          schemeMonth: 2,
        },
        targetSchemeMonth: 2,
        checkoutChannel: 'WEB',
        quotedAt,
        quoteExpiresAt,
        rules: rulesStub(),
        actorUserId,
        requestId: 'r2',
      }),
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_KEY_REUSED', statusCode: 409 });
  });

  it('blocks a WEB and SDK intent from both being live for the same scheme month (Phase 1: at most one active PhonePe attempt per installment, regardless of channel)', async () => {
    const key = 'cross-channel-key-0001';
    const web = await getOrCreatePaymentIntent({
      customerId,
      schemeId,
      input: { schemeId: String(schemeId), amountPaise: INSTALLMENT, idempotencyKey: key, schemeMonth: 1 },
      targetSchemeMonth: 1,
      checkoutChannel: 'WEB',
      quotedAt,
      quoteExpiresAt,
      rules: rulesStub(),
      actorUserId,
      requestId: 'web',
    });
    expect(web.idempotencyScope).toBe('PHONEPE_CUSTOMER_WEB');
    expect(web.activeAttemptKey).toBeTruthy();

    // Same idempotency key text, but a different scope (SDK) — still the
    // same installment, so it must not create a second live attempt.
    await expect(
      getOrCreatePaymentIntent({
        customerId,
        schemeId,
        input: { schemeId: String(schemeId), amountPaise: INSTALLMENT, idempotencyKey: key, schemeMonth: 1 },
        targetSchemeMonth: 1,
        checkoutChannel: 'SDK',
        quotedAt,
        quoteExpiresAt,
        rules: rulesStub(),
        actorUserId,
        requestId: 'sdk',
      }),
    ).rejects.toMatchObject({ code: 'PAYMENT_ATTEMPT_ALREADY_ACTIVE', statusCode: 409 });

    expect(await PaymentIntent.countDocuments({})).toBe(1);
  });

  it('creates only one intent under concurrent identical requests', async () => {
    const input = {
      schemeId: String(schemeId),
      amountPaise: INSTALLMENT,
      idempotencyKey: 'concurrent-same-0001',
      schemeMonth: 1,
    };
    const args = {
      customerId,
      schemeId,
      input,
      targetSchemeMonth: 1 as const,
      checkoutChannel: 'WEB' as const,
      quotedAt,
      quoteExpiresAt,
      rules: rulesStub(),
      actorUserId,
    };

    const results = await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        getOrCreatePaymentIntent({ ...args, requestId: `c-${i}` }),
      ),
    );
    const ids = new Set(results.map((intent) => intent.merchantTransactionId));
    expect(ids.size).toBe(1);
    expect(await PaymentIntent.countDocuments({})).toBe(1);
  });

  it('under concurrent conflicting requests, one succeeds and others get 409', async () => {
    const key = 'concurrent-conflict-0001';
    const base = {
      customerId,
      schemeId,
      targetSchemeMonth: 1 as const,
      checkoutChannel: 'WEB' as const,
      quotedAt,
      quoteExpiresAt,
      rules: rulesStub(),
      actorUserId,
    };

    const settled = await Promise.allSettled([
      getOrCreatePaymentIntent({
        ...base,
        input: {
          schemeId: String(schemeId),
          amountPaise: INSTALLMENT,
          idempotencyKey: key,
          schemeMonth: 1,
        },
        requestId: 'a',
      }),
      getOrCreatePaymentIntent({
        ...base,
        input: {
          schemeId: String(schemeId),
          amountPaise: INSTALLMENT + 100_000,
          idempotencyKey: key,
          schemeMonth: 1,
        },
        requestId: 'b',
      }),
    ]);

    const fulfilled = settled.filter((r) => r.status === 'fulfilled');
    const rejected = settled.filter((r) => r.status === 'rejected');
    expect(fulfilled.length).toBe(1);
    expect(rejected.length).toBe(1);
    expect(rejected[0]).toMatchObject({
      status: 'rejected',
      reason: expect.objectContaining({ code: 'IDEMPOTENCY_KEY_REUSED', statusCode: 409 }),
    });
    expect(await PaymentIntent.countDocuments({})).toBe(1);
  });
});
