import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  jest,
} from '@jest/globals';
import {
  INSTALLMENT_PAISE,
  api,
  clearJestMongo,
  connectJestMongo,
  loginAsCustomer,
  seedCustomerPortalFixture,
} from './helpers/http.js';
import { PaymentIntent } from '../../src/models/index.js';
import { phonePeProvider } from '../../src/services/phonepe.provider.js';

describe('Phase 1 — PhonePe initiation idempotency (supertest)', () => {
  beforeAll(async () => {
    await connectJestMongo();
  });

  beforeEach(async () => {
    await clearJestMongo();
    await seedCustomerPortalFixture();
    jest.spyOn(phonePeProvider, 'createPayment').mockImplementation(async (input: any) => ({
      providerOrderId: `ORD-${input.merchantOrderId}`,
      state: 'PENDING',
      redirectUrl: 'https://phonepe.test/checkout',
      expiresAt: new Date(Date.now() + 600_000),
    }));
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('retries with the same key return the same merchantTransactionId', async () => {
    const { cookies } = await loginAsCustomer();
    const { enrollment } = await (
      await import('../../src/models/index.js')
    ).SchemeEnrollment.findOne({ enrollmentNumber: 'ENR-JEST-001' }).then((doc) => ({
      enrollment: doc!,
    }));

    const body = {
      schemeId: String(enrollment._id),
      amountPaise: INSTALLMENT_PAISE,
      schemeMonth: 1,
      idempotencyKey: 'jest-phonepe-same-key-0001',
    };

    const first = await api()
      .post('/api/v1/customer/payments/phonepe')
      .set('Cookie', cookies)
      .set('Origin', 'http://localhost:5173')
      .send(body)
      .expect(201);

    const second = await api()
      .post('/api/v1/customer/payments/phonepe')
      .set('Cookie', cookies)
      .set('Origin', 'http://localhost:5173')
      .send(body)
      .expect(201);

    expect(second.body.data.merchantTransactionId).toBe(
      first.body.data.merchantTransactionId,
    );
    expect(
      await PaymentIntent.countDocuments({
        idempotencyKey: body.idempotencyKey,
        idempotencyScope: 'PHONEPE_CUSTOMER_WEB',
      }),
    ).toBe(1);
  });

  it('rejects reused key with a different scheme month', async () => {
    const { cookies } = await loginAsCustomer();
    const enrollment = await (
      await import('../../src/models/index.js')
    ).SchemeEnrollment.findOne({ enrollmentNumber: 'ENR-JEST-001' });

    const key = 'jest-phonepe-month-key-0001';
    await api()
      .post('/api/v1/customer/payments/phonepe')
      .set('Cookie', cookies)
      .set('Origin', 'http://localhost:5173')
      .send({
        schemeId: String(enrollment!._id),
        amountPaise: INSTALLMENT_PAISE,
        schemeMonth: 1,
        idempotencyKey: key,
      })
      .expect(201);

    const conflict = await api()
      .post('/api/v1/customer/payments/phonepe')
      .set('Cookie', cookies)
      .set('Origin', 'http://localhost:5173')
      .send({
        schemeId: String(enrollment!._id),
        amountPaise: INSTALLMENT_PAISE,
        schemeMonth: 2,
        idempotencyKey: key,
      })
      .expect(409);

    expect(conflict.body.error.code).toBe('IDEMPOTENCY_KEY_REUSED');
  });

  it('blocks a second live SDK attempt while a WEB attempt is still active for the same installment (Phase 1: at most one active PhonePe attempt per installment, regardless of channel)', async () => {
    const { cookies } = await loginAsCustomer();
    const enrollment = await (
      await import('../../src/models/index.js')
    ).SchemeEnrollment.findOne({ enrollmentNumber: 'ENR-JEST-001' });
    jest.spyOn(phonePeProvider, 'createSdkOrder').mockImplementation(async (input: any) => ({
      orderId: `SDK-${input.merchantOrderId}`,
      state: 'PENDING',
      token: `TOK-${input.merchantOrderId}`,
      expiresAt: new Date(Date.now() + 600_000),
    }));

    const key = 'jest-phonepe-channel-key-0001';
    const web = await api()
      .post('/api/v1/customer/payments/phonepe')
      .set('Cookie', cookies)
      .set('Origin', 'http://localhost:5173')
      .send({
        schemeId: String(enrollment!._id),
        amountPaise: INSTALLMENT_PAISE,
        schemeMonth: 1,
        idempotencyKey: key,
      })
      .expect(201);
    expect(web.body.data.status).toBe('PENDING');

    // Same idempotency key text, but a different scope (SDK) — still the
    // same installment while the WEB attempt is still live, so this must
    // not open a second live provider order.
    const conflict = await api()
      .post('/api/v1/customer/payments/phonepe/create-order')
      .set('Cookie', cookies)
      .set('Origin', 'http://localhost:5173')
      .send({
        schemeId: String(enrollment!._id),
        amountPaise: INSTALLMENT_PAISE,
        schemeMonth: 1,
        idempotencyKey: key,
      })
      .expect(409);

    expect(conflict.body.error.code).toBe('PAYMENT_ATTEMPT_ALREADY_ACTIVE');
    expect(await PaymentIntent.countDocuments({ idempotencyKey: key })).toBe(1);
  });

  it('concurrent incomplete launches call PhonePe createPayment once', async () => {
    const { cookies } = await loginAsCustomer();
    const enrollment = await (
      await import('../../src/models/index.js')
    ).SchemeEnrollment.findOne({ enrollmentNumber: 'ENR-JEST-001' });

    let createCalls = 0;
    jest.spyOn(phonePeProvider, 'createPayment').mockImplementation(async (input: any) => {
      createCalls += 1;
      await new Promise((r) => setTimeout(r, 200));
      return {
        providerOrderId: `ORD-${input.merchantOrderId}`,
        state: 'PENDING',
        redirectUrl: 'https://phonepe.test/checkout',
        expiresAt: new Date(Date.now() + 600_000),
      };
    });

    const body = {
      schemeId: String(enrollment!._id),
      amountPaise: INSTALLMENT_PAISE,
      schemeMonth: 1,
      idempotencyKey: 'jest-phonepe-launch-lease-0001',
    };

    const settled = await Promise.all(
      Array.from({ length: 8 }, () =>
        api()
          .post('/api/v1/customer/payments/phonepe')
          .set('Cookie', cookies)
          .set('Origin', 'http://localhost:5173')
          .send(body),
      ),
    );

    for (const res of settled) {
      expect(res.status).toBe(201);
    }
    const ids = new Set(settled.map((r) => r.body.data.merchantTransactionId));
    expect(ids.size).toBe(1);
    expect(createCalls).toBe(1);
  });
});
