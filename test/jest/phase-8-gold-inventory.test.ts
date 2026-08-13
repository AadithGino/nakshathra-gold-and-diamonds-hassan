import { beforeAll, beforeEach, describe, expect, it } from '@jest/globals';
import {
  api,
  clearJestMongo,
  connectJestMongo,
  loginAsAdmin,
  seedAdminGatewayPaymentFixture,
} from './helpers/http.js';
import { AuditLog, Payment } from '../../src/models/index.js';

describe('Phase 8 — gold control / inventory (jest/supertest)', () => {
  beforeAll(async () => {
    await connectJestMongo();
  });

  beforeEach(async () => {
    await clearJestMongo();
    await seedAdminGatewayPaymentFixture();
  });

  it('exposes liability from SUCCESS payments and records immutable inventory movements', async () => {
    const { cookies } = await loginAsAdmin();
    const payment = await Payment.findOne({ status: 'SUCCESS' });
    expect(payment?.goldWeightMg).toBe(142);

    const summaryBefore = await api()
      .get('/api/v1/admin/finance/gold-control/summary')
      .set('Cookie', cookies)
      .expect(200);
    expect(summaryBefore.body.data.liabilityMg).toBe(142);
    expect(summaryBefore.body.data.inventoryMg).toBe(0);
    expect(summaryBefore.body.data.coverageMg).toBe(-142);

    const movement = await api()
      .post('/api/v1/admin/finance/gold-inventory/movements')
      .set('Cookie', cookies)
      .set('Origin', 'http://localhost:5173')
      .send({
        movementType: 'OPENING_STOCK',
        goldWeightMg: 1000,
        movementDate: new Date().toISOString(),
        reason: 'Vault opening stock for 916',
      })
      .expect(201);

    expect(movement.body.data.direction).toBe('IN');
    expect(movement.body.data.goldWeightMg).toBe(1000);

    await api()
      .post('/api/v1/admin/finance/gold-inventory/movements')
      .set('Cookie', cookies)
      .set('Origin', 'http://localhost:5173')
      .send({
        movementType: 'NEGATIVE_ADJUSTMENT',
        goldWeightMg: 10,
        movementDate: new Date().toISOString(),
        reason: '',
      })
      .expect(422);

    const summaryAfter = await api()
      .get('/api/v1/admin/finance/gold-control/summary')
      .set('Cookie', cookies)
      .expect(200);
    expect(summaryAfter.body.data.inventoryMg).toBe(1000);
    expect(summaryAfter.body.data.liabilityMg).toBe(142);
    expect(summaryAfter.body.data.coverageMg).toBe(858);

    const liability = await api()
      .get('/api/v1/admin/finance/gold-control/liability-movements')
      .set('Cookie', cookies)
      .expect(200);
    expect(
      liability.body.data.some(
        (row: { kind: string; goldWeightMg: number }) =>
          row.kind === 'PAYMENT_CREDIT' && row.goldWeightMg === 142,
      ),
    ).toBe(true);

    const list = await api()
      .get('/api/v1/admin/finance/gold-inventory/movements')
      .set('Cookie', cookies)
      .expect(200);
    expect(list.body.data).toHaveLength(1);

    const refreshed = await Payment.findById(payment!._id);
    expect(refreshed?.goldWeightMg).toBe(142);
    expect(refreshed?.amountPaise).toBe(100_000);

    expect(
      await AuditLog.countDocuments({ action: 'GOLD_INVENTORY_MOVEMENT_RECORDED' }),
    ).toBe(1);
  });
});
