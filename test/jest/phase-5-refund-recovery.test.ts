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
  api,
  clearJestMongo,
  connectJestMongo,
  loginAsAdmin,
  seedAdminGatewayPaymentFixture,
} from './helpers/http.js';
import { Payment, Refund } from '../../src/models/index.js';
import { phonePeProvider } from '../../src/services/phonepe.provider.js';
import { processRefundRecoveryBatch } from '../../src/workers/refund-recovery.worker.js';

describe('Phase 5 — refund recovery (jest/supertest)', () => {
  beforeAll(async () => {
    await connectJestMongo();
  });

  beforeEach(async () => {
    await clearJestMongo();
    await seedAdminGatewayPaymentFixture();
    jest.spyOn(phonePeProvider, 'initiateRefund').mockResolvedValue({
      state: 'PENDING',
      amountPaise: 100_000,
      providerRefundId: 'PRV-JEST-P5',
      raw: { state: 'PENDING' },
    });
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('recovers a pending refund to SUCCESS and exposes it via status check', async () => {
    const { cookies } = await loginAsAdmin();
    const payment = await Payment.findOne({ status: 'SUCCESS' });

    const created = await api()
      .post(`/api/v1/admin/payments/${payment!._id}/refund`)
      .set('Cookie', cookies)
      .set('Origin', 'http://localhost:5173')
      .send({
        reason: 'Phase 5 recovery path',
        idempotencyKey: 'jest-phase5-refund-0001',
      })
      .expect(201);

    expect(created.body.data.status).toBe('PENDING');

    await Refund.updateOne(
      { _id: created.body.data.refundId },
      { $set: { nextStatusCheckAt: new Date(0) } },
    );

    jest.spyOn(phonePeProvider, 'checkRefundStatus').mockResolvedValue({
      state: 'SUCCESS',
      amountPaise: 100_000,
      providerRefundId: 'PRV-JEST-OK',
      bankReferenceId: 'UTR-JEST-1',
      raw: { state: 'COMPLETED' },
    });

    expect(await processRefundRecoveryBatch('jest-rr')).toBe(1);

    const refreshed = await Payment.findById(payment!._id);
    expect(refreshed?.status).toBe('REFUNDED');
    expect(refreshed?.amountPaise).toBe(100_000);
    expect(refreshed?.goldWeightMg).toBe(142);

    const checked = await api()
      .post(`/api/v1/admin/refunds/${created.body.data.refundId}/check-status`)
      .set('Cookie', cookies)
      .expect(200);
    expect(checked.body.data.state).toBe('SUCCESS');
    expect(checked.body.data.skipped).toBe(true);
  });
});
