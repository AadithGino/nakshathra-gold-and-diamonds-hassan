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
import {
  AccountingPeriod,
  FinancialException,
  Payment,
  Refund,
} from '../../src/models/index.js';
import { phonePeProvider } from '../../src/services/phonepe.provider.js';
import { processRefundRecoveryBatch } from '../../src/workers/refund-recovery.worker.js';
import { expectedNetSettlementPaise } from '../../src/services/gateway-settlement.service.js';
import { toPeriodKey } from '../../src/services/accounting-period.service.js';
import { upsertFinancialException } from '../../src/services/financial-exception.service.js';
import { ageOpenFinancialExceptions } from '../../src/services/financial-exception.service.js';

describe('Phase 11 — final integration gate (jest/supertest)', () => {
  beforeAll(async () => {
    await connectJestMongo();
  });

  beforeEach(async () => {
    await clearJestMongo();
    await seedAdminGatewayPaymentFixture();
    jest.spyOn(phonePeProvider, 'initiateRefund').mockResolvedValue({
      state: 'PENDING',
      amountPaise: 100_000,
      providerRefundId: 'PRV-JEST-P11',
      raw: { state: 'PENDING' },
    });
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('covers refund recovery, settlement formula, exception aging, and closed-period snapshot stability', async () => {
    const { cookies } = await loginAsAdmin();
    const payment = await Payment.findOne({ status: 'SUCCESS' });
    expect(payment?.goldWeightMg).toBe(142);
    const endedAt = new Date('2026-07-15T10:00:00+05:30');
    await Payment.updateOne(
      { _id: payment!._id },
      { $set: { paymentDate: endedAt, accountingDate: endedAt, recognizedAt: endedAt } },
    );
    const periodKey = toPeriodKey(endedAt);

    // Settlement formula rejection + confirm path
    const net = expectedNetSettlementPaise({
      grossCollectionPaise: 100_000,
      gatewayFeePaise: 1_000,
      gatewayFeeGstPaise: 180,
    });
    await api()
      .post('/api/v1/admin/finance/gateway-settlements')
      .set('Cookie', cookies)
      .set('Origin', 'http://localhost:5173')
      .send({
        settlementId: 'P11-SET',
        periodFrom: '2026-01-01T00:00:00.000Z',
        periodTo: '2026-01-07T00:00:00.000Z',
        settlementDate: endedAt.toISOString(),
        grossCollectionPaise: 100_000,
        gatewayFeePaise: 1_000,
        gatewayFeeGstPaise: 180,
        netSettlementPaise: net + 1,
        source: 'MANUAL',
      })
      .expect(422);

    const settlement = await api()
      .post('/api/v1/admin/finance/gateway-settlements')
      .set('Cookie', cookies)
      .set('Origin', 'http://localhost:5173')
      .send({
        settlementId: 'P11-SET',
        periodFrom: '2026-01-01T00:00:00.000Z',
        periodTo: '2026-01-07T00:00:00.000Z',
        settlementDate: endedAt.toISOString(),
        grossCollectionPaise: 100_000,
        gatewayFeePaise: 1_000,
        gatewayFeeGstPaise: 180,
        netSettlementPaise: net,
        source: 'MANUAL',
      })
      .expect(201);

    await api()
      .post(
        `/api/v1/admin/finance/gateway-settlements/${settlement.body.data._id}/confirm-bank-credit`,
      )
      .set('Cookie', cookies)
      .set('Origin', 'http://localhost:5173')
      .send({
        providerUtr: 'UTR-P11',
        bankCreditedAt: new Date().toISOString(),
      })
      .expect(200);

    // Exception dedupe + aging
    await upsertFinancialException({
      dedupeKey: 'p11:mismatch',
      type: 'PAYMENT_AMOUNT_MISMATCH',
      title: 'Mismatch',
      now: new Date(Date.now() - 4 * 24 * 60 * 60_000),
    });
    await FinancialException.updateOne(
      { dedupeKey: 'p11:mismatch' },
      {
        $set: {
          firstSeenAt: new Date(Date.now() - 4 * 24 * 60 * 60_000),
          agingBucket: 'NEW',
        },
      },
    );
    await ageOpenFinancialExceptions(new Date());
    expect((await FinancialException.findOne({ dedupeKey: 'p11:mismatch' }))?.agingBucket).toBe(
      'CRITICAL',
    );

    // Close period snapshot
    const closed = await api()
      .post(`/api/v1/admin/finance/accounting-periods/${periodKey}/close`)
      .set('Cookie', cookies)
      .set('Origin', 'http://localhost:5173')
      .send({
        closeNotes: 'P11 close',
        overrideReason: 'Integration gate override',
      })
      .expect(200);
    const closedCollection = closed.body.data.snapshot.successfulCollectionPaise;

    // Refund initiation while payment period is closed is still allowed at initiation
    // (refund completion lands in current period). Pending refund keeps payment SUCCESS.
    const refund = await api()
      .post(`/api/v1/admin/payments/${payment!._id}/refund`)
      .set('Cookie', cookies)
      .set('Origin', 'http://localhost:5173')
      .send({
        reason: 'Phase 11 integration refund',
        idempotencyKey: 'jest-phase11-refund-0001',
      })
      .expect(201);
    expect(refund.body.data.status).toBe('PENDING');
    expect((await Payment.findById(payment!._id))?.status).toBe('SUCCESS');

    await Refund.updateOne(
      { _id: refund.body.data.refundId },
      { $set: { nextStatusCheckAt: new Date(0) } },
    );
    jest.spyOn(phonePeProvider, 'checkRefundStatus').mockResolvedValue({
      state: 'SUCCESS',
      amountPaise: 100_000,
      providerRefundId: 'PRV-P11-OK',
      bankReferenceId: 'UTR-RFD-P11',
      raw: { state: 'COMPLETED' },
    });
    expect(await processRefundRecoveryBatch('jest-p11')).toBe(1);

    const refunded = await Payment.findById(payment!._id);
    expect(refunded?.status).toBe('REFUNDED');
    expect(refunded?.amountPaise).toBe(100_000);
    expect(refunded?.goldWeightMg).toBe(142);

    // Closed snapshot must not shrink after later refund
    const period = await AccountingPeriod.findOne({ periodKey });
    expect(period?.status).toBe('CLOSED');
    expect(period?.snapshot?.successfulCollectionPaise).toBe(closedCollection);

    const report = await api()
      .get(`/api/v1/admin/reports/financial-periods/${periodKey}`)
      .set('Cookie', cookies)
      .expect(200);
    expect(report.body.data.source).toBe('SNAPSHOT');
    expect(report.body.data.snapshot.successfulCollectionPaise).toBe(closedCollection);

    await api().get('/api/v1/admin/reports/refunds').set('Cookie', cookies).expect(200);
    await api().get('/api/v1/admin/reports/gold-control').set('Cookie', cookies).expect(200);
  });
});
