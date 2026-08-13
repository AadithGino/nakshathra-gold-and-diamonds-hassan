import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from '@jest/globals';
import {
  api,
  clearJestMongo,
  connectJestMongo,
  seedCustomerPortalFixture,
} from './helpers/http.js';
import { Payment, PaymentIntent } from '../../src/models/index.js';
import { finalizeGatewayPayment } from '../../src/services/payment.service.js';
import { aggregateEnrollmentLedger } from '../../src/utils/enrollment-ledger.js';

describe('Phase 0 — baseline HTTP + ledger regression', () => {
  beforeAll(async () => {
    await connectJestMongo();
  });

  beforeEach(async () => {
    await clearJestMongo();
  });

  afterAll(async () => {
    // Connection stays open for the suite; global teardown stops Mongo.
  });

  it('GET /health returns ok', async () => {
    const res = await api().get('/health').expect(200);
    expect(res.body).toMatchObject({ status: 'ok', service: 'nakshathra-api' });
  });

  it('GET /ready is ready after DB connect', async () => {
    const res = await api().get('/ready').expect(200);
    expect(res.body).toMatchObject({ status: 'ready' });
  });

  it('finalization is idempotent and ledger ignores non-SUCCESS payments', async () => {
    const { user, enrollment } = await seedCustomerPortalFixture();
    const goldRate = await (
      await import('../../src/models/index.js')
    ).GoldRate.findOne({ status: 'ACTIVE' });
    const merchantTransactionId = `KRL-JEST-P0-${Date.now()}`;
    const [intent] = await PaymentIntent.create([
      {
        customerId: enrollment.customerId,
        schemeId: enrollment._id,
        amountPaise: 100_000,
        merchantTransactionId,
        checkoutChannel: 'WEB',
        status: 'PENDING',
        idempotencyKey: `p0-${merchantTransactionId}`,
        idempotencyScope: 'PHONEPE_CUSTOMER_WEB',
        requestHash: 'phase0-jest-hash',
        goldRateId: goldRate!._id,
        goldRatePerGramPaise: 700_000,
        goldWeightMg: 142,
        goldPurity: '916',
        schemeMonth: 1,
        collectorRole: 'CUSTOMER',
        createdBy: user._id,
      },
    ]);

    const first = await finalizeGatewayPayment(
      intent,
      { transactionId: 'PP-1', amountPaise: 100_000 },
      { actorId: String(user._id), actorRole: 'CUSTOMER', requestId: 'jest-p0' },
    );
    const second = await finalizeGatewayPayment(
      intent,
      { transactionId: 'PP-1', amountPaise: 100_000 },
      { actorId: String(user._id), actorRole: 'CUSTOMER', requestId: 'jest-p0-b' },
    );

    expect(String(second._id)).toBe(String(first._id));
    expect(first.goldRatePerGramPaise).toBe(700_000);
    expect(first.goldWeightMg).toBe(142);
    expect(await Payment.countDocuments({ merchantTransactionId })).toBe(1);

    await Payment.create({
      customerId: enrollment.customerId,
      schemeId: enrollment._id,
      amountPaise: 100_000,
      method: 'UPI',
      status: 'REFUNDED',
      paymentDate: new Date(),
      schemeMonth: 2,
      collectorRole: 'CUSTOMER',
      createdBy: user._id,
      goldWeightMg: 150,
      merchantTransactionId: `${merchantTransactionId}-refunded`,
    });

    const ledger = await aggregateEnrollmentLedger(String(enrollment._id));
    expect(ledger.totalPaidPaise).toBe(100_000);
    expect(ledger.totalGoldWeightMg).toBe(142);
    expect(ledger.paymentsCompleted).toBe(1);
  });
});
