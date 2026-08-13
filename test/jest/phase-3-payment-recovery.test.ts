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
import { Payment, PaymentIntent, SchemeEnrollment } from '../../src/models/index.js';
import { phonePeProvider } from '../../src/services/phonepe.provider.js';
import { processPaymentRecoveryBatch } from '../../src/workers/payment-recovery.worker.js';

describe('Phase 3 — pending PhonePe payment recovery (jest/supertest)', () => {
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

  it('schedules recovery on PhonePe initiate and recovers SUCCESS without webhook', async () => {
    const { cookies } = await loginAsCustomer();
    const enrollment = await SchemeEnrollment.findOne({ enrollmentNumber: 'ENR-JEST-001' });

    const created = await api()
      .post('/api/v1/customer/payments/phonepe')
      .set('Cookie', cookies)
      .set('Origin', 'http://localhost:5173')
      .send({
        schemeId: String(enrollment!._id),
        amountPaise: INSTALLMENT_PAISE,
        schemeMonth: 1,
        idempotencyKey: 'jest-phase3-recover-0001',
      })
      .expect(201);

    const merchantTransactionId = created.body.data.merchantTransactionId as string;
    const intent = await PaymentIntent.findOne({ merchantTransactionId });
    expect(intent?.status).toBe('PENDING');
    expect(intent?.nextStatusCheckAt).toBeTruthy();

    await PaymentIntent.updateOne(
      { _id: intent!._id },
      { $set: { nextStatusCheckAt: new Date(0) } },
    );

    jest.spyOn(phonePeProvider, 'checkStatus').mockResolvedValue({
      state: 'SUCCESS',
      amountPaise: INSTALLMENT_PAISE,
      transactionId: 'PP-JEST-REC',
      raw: {},
    });

    expect(await processPaymentRecoveryBatch('jest-recovery')).toBe(1);
    expect((await PaymentIntent.findById(intent!._id))?.status).toBe('SUCCESS');
    expect((await PaymentIntent.findById(intent!._id))?.finalStatusSource).toBe(
      'RECOVERY_WORKER',
    );
    expect(await Payment.countDocuments({ merchantTransactionId })).toBe(1);

    const status = await api()
      .get(`/api/v1/customer/payment-intents/${merchantTransactionId}`)
      .set('Cookie', cookies)
      .expect(200);
    expect(status.body.data.status).toBe('SUCCESS');
  });
});
