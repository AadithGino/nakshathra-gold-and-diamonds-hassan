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

describe('Phase 4 — refund initiation (jest/supertest)', () => {
  beforeAll(async () => {
    await connectJestMongo();
  });

  beforeEach(async () => {
    await clearJestMongo();
    await seedAdminGatewayPaymentFixture();
    jest.spyOn(phonePeProvider, 'initiateRefund').mockResolvedValue({
      state: 'PENDING',
      amountPaise: 100_000,
      providerRefundId: 'PRV-JEST-1',
      raw: { state: 'PENDING' },
    });
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('admin can initiate a full refund and list it', async () => {
    const { cookies } = await loginAsAdmin();
    const payment = await Payment.findOne({ status: 'SUCCESS' });
    expect(payment).toBeTruthy();

    const created = await api()
      .post(`/api/v1/admin/payments/${payment!._id}/refund`)
      .set('Cookie', cookies)
      .set('Origin', 'http://localhost:5173')
      .send({
        reason: 'Customer requested cancellation',
        idempotencyKey: 'jest-admin-refund-0001',
      })
      .expect(201);

    expect(created.body.data.status).toBe('PENDING');
    expect(created.body.data.amountPaise).toBe(100_000);

    const listed = await api()
      .get('/api/v1/admin/refunds?cursor=')
      .set('Cookie', cookies)
      .expect(200);
    expect(listed.body.data).toHaveLength(1);
    expect(listed.body.meta.mode).toBe('cursor');

    const detail = await api()
      .get(`/api/v1/admin/refunds/${created.body.data.refundId}`)
      .set('Cookie', cookies)
      .expect(200);
    expect(detail.body.data.merchantRefundId).toBe(created.body.data.merchantRefundId);

    const refreshed = await Payment.findById(payment!._id);
    expect(refreshed?.status).toBe('SUCCESS');
    expect(refreshed?.amountPaise).toBe(100_000);
    expect(refreshed?.goldWeightMg).toBe(142);
    expect(refreshed?.refundStatus).toBe('PENDING');
    expect(await Refund.countDocuments({})).toBe(1);
  });

  it('rejects partial amount through the admin API', async () => {
    const { cookies } = await loginAsAdmin();
    const payment = await Payment.findOne({ status: 'SUCCESS' });
    const res = await api()
      .post(`/api/v1/admin/payments/${payment!._id}/refund`)
      .set('Cookie', cookies)
      .set('Origin', 'http://localhost:5173')
      .send({
        reason: 'Partial not allowed',
        idempotencyKey: 'jest-admin-partial-0001',
        amountPaise: 50_000,
      })
      .expect(422);
    expect(res.body.error.code).toBe('PARTIAL_REFUND_NOT_SUPPORTED');
  });
});
