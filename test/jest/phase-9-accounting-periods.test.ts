import { beforeAll, beforeEach, describe, expect, it } from '@jest/globals';
import {
  api,
  clearJestMongo,
  connectJestMongo,
  loginAsAdmin,
  seedAdminGatewayPaymentFixture,
} from './helpers/http.js';
import { AccountingPeriod, Payment } from '../../src/models/index.js';
import { toPeriodKey } from '../../src/services/accounting-period.service.js';

describe('Phase 9 — accounting periods / operational reports (jest/supertest)', () => {
  beforeAll(async () => {
    await connectJestMongo();
  });

  beforeEach(async () => {
    await clearJestMongo();
    await seedAdminGatewayPaymentFixture();
  });

  it('closes a period snapshot, blocks backdated inventory, and serves operational reports', async () => {
    const { cookies } = await loginAsAdmin();
    const payment = await Payment.findOne({ status: 'SUCCESS' });
    const endedAt = new Date('2026-07-15T10:00:00+05:30');
    await Payment.updateOne(
      { _id: payment!._id },
      { $set: { paymentDate: endedAt, accountingDate: endedAt, recognizedAt: endedAt } },
    );
    const periodKey = toPeriodKey(endedAt);

    const closed = await api()
      .post(`/api/v1/admin/finance/accounting-periods/${periodKey}/close`)
      .set('Cookie', cookies)
      .set('Origin', 'http://localhost:5173')
      .send({
        closeNotes: 'Month close',
        overrideReason: 'Jest gate override for empty blockers',
      })
      .expect(200);

    expect(closed.body.data.status).toBe('CLOSED');
    expect(closed.body.data.snapshot.successfulPaymentCount).toBeGreaterThanOrEqual(1);

    await api()
      .post('/api/v1/admin/finance/gold-inventory/movements')
      .set('Cookie', cookies)
      .set('Origin', 'http://localhost:5173')
      .send({
        movementType: 'OPENING_STOCK',
        goldWeightMg: 100,
        movementDate: endedAt.toISOString(),
        reason: 'Backdated into closed period',
      })
      .expect(409);

    const periodReport = await api()
      .get(`/api/v1/admin/reports/financial-periods/${periodKey}`)
      .set('Cookie', cookies)
      .expect(200);
    expect(periodReport.body.data.source).toBe('SNAPSHOT');
    expect(periodReport.body.data.label).toMatch(/not a statutory trial balance/i);

    await api().get('/api/v1/admin/reports/gold-control').set('Cookie', cookies).expect(200);
    await api().get('/api/v1/admin/reports/gateway-expenses').set('Cookie', cookies).expect(200);
    await api().get('/api/v1/admin/reports/refunds').set('Cookie', cookies).expect(200);
    await api()
      .get('/api/v1/admin/reports/financial-exceptions-aging')
      .set('Cookie', cookies)
      .expect(200);

    await api()
      .post(`/api/v1/admin/finance/accounting-periods/${periodKey}/reopen`)
      .set('Cookie', cookies)
      .set('Origin', 'http://localhost:5173')
      .send({ reason: 'Need inventory opening stock' })
      .expect(200);

    expect((await AccountingPeriod.findOne({ periodKey }))?.status).toBe('OPEN');
  });
});
