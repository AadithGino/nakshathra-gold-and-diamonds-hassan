import { beforeAll, beforeEach, describe, expect, it } from '@jest/globals';
import {
  api,
  clearJestMongo,
  connectJestMongo,
  loginAsAdmin,
  seedAdminGatewayPaymentFixture,
} from './helpers/http.js';
import { AuditLog, Payment } from '../../src/models/index.js';
import { expectedNetSettlementPaise } from '../../src/services/gateway-settlement.service.js';

describe('Phase 7 — gateway settlements (jest/supertest)', () => {
  beforeAll(async () => {
    await connectJestMongo();
  });

  beforeEach(async () => {
    await clearJestMongo();
    await seedAdminGatewayPaymentFixture();
  });

  it('records and bank-confirms a PhonePe settlement without changing customer payment gold', async () => {
    const { cookies } = await loginAsAdmin();
    const payment = await Payment.findOne({ status: 'SUCCESS' });
    const before = {
      amountPaise: payment!.amountPaise,
      goldWeightMg: payment!.goldWeightMg,
      status: payment!.status,
    };

    const net = expectedNetSettlementPaise({
      grossCollectionPaise: 100_000,
      refundDeductionPaise: 0,
      gatewayFeePaise: 1_800,
      gatewayFeeGstPaise: 324,
      otherAdjustmentPaise: 0,
    });

    await api()
      .post('/api/v1/admin/finance/gateway-settlements')
      .set('Cookie', cookies)
      .set('Origin', 'http://localhost:5173')
      .send({
        settlementId: 'JEST-SET-1',
        periodFrom: '2026-01-01T00:00:00.000Z',
        periodTo: '2026-01-07T23:59:59.000Z',
        settlementDate: '2026-01-08T00:00:00.000Z',
        grossCollectionPaise: 100_000,
        gatewayFeePaise: 1_800,
        gatewayFeeGstPaise: 324,
        netSettlementPaise: net + 5,
        source: 'PHONEPE_DASHBOARD',
      })
      .expect(422);

    const created = await api()
      .post('/api/v1/admin/finance/gateway-settlements')
      .set('Cookie', cookies)
      .set('Origin', 'http://localhost:5173')
      .send({
        settlementId: 'JEST-SET-1',
        periodFrom: '2026-01-01T00:00:00.000Z',
        periodTo: '2026-01-07T23:59:59.000Z',
        settlementDate: '2026-01-08T00:00:00.000Z',
        grossCollectionPaise: 100_000,
        gatewayFeePaise: 1_800,
        gatewayFeeGstPaise: 324,
        netSettlementPaise: net,
        source: 'PHONEPE_DASHBOARD',
        notes: 'Weekly PhonePe payout',
      })
      .expect(201);

    expect(created.body.data.status).toBe('RECORDED');
    expect(created.body.data.netSettlementPaise).toBe(net);

    const confirmed = await api()
      .post(`/api/v1/admin/finance/gateway-settlements/${created.body.data._id}/confirm-bank-credit`)
      .set('Cookie', cookies)
      .set('Origin', 'http://localhost:5173')
      .send({
        providerUtr: 'UTR-JEST-1',
        bankCreditedAt: '2026-01-09T10:00:00.000Z',
        notes: 'Matched bank credit',
      })
      .expect(200);

    expect(confirmed.body.data.status).toBe('BANK_CONFIRMED');

    const closed = await api()
      .post(`/api/v1/admin/finance/gateway-settlements/${created.body.data._id}/close`)
      .set('Cookie', cookies)
      .set('Origin', 'http://localhost:5173')
      .send({ notes: 'Period closed' })
      .expect(200);
    expect(closed.body.data.status).toBe('CLOSED');

    const after = await Payment.findById(payment!._id);
    expect(after?.amountPaise).toBe(before.amountPaise);
    expect(after?.goldWeightMg).toBe(before.goldWeightMg);
    expect(after?.status).toBe(before.status);

    const summary = await api()
      .get('/api/v1/admin/finance/gateway-settlements/summary')
      .set('Cookie', cookies)
      .expect(200);
    expect(summary.body.data.bankConfirmedNetPaise).toBe(net);
    expect(summary.body.data.totalGatewayFeeGstPaise).toBe(324);

    expect(
      await AuditLog.countDocuments({
        action: {
          $in: [
            'GATEWAY_SETTLEMENT_RECORDED',
            'GATEWAY_SETTLEMENT_BANK_CONFIRMED',
            'GATEWAY_SETTLEMENT_CLOSED',
          ],
        },
      }),
    ).toBe(3);
  });
});
