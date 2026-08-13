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
  AuditLog,
  FinancialException,
  Notification,
  Payment,
} from '../../src/models/index.js';
import {
  ageOpenFinancialExceptions,
  upsertFinancialException,
} from '../../src/services/financial-exception.service.js';

describe('Phase 6 — financial exceptions / suspense / disputes (jest/supertest)', () => {
  beforeAll(async () => {
    await connectJestMongo();
  });

  beforeEach(async () => {
    await clearJestMongo();
    await seedAdminGatewayPaymentFixture();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('records a dispute without mutating payment gold and surfaces it in the exception queue', async () => {
    const { cookies } = await loginAsAdmin();
    const payment = await Payment.findOne({ status: 'SUCCESS' });
    expect(payment).toBeTruthy();

    const created = await api()
      .post('/api/v1/admin/finance/disputes')
      .set('Cookie', cookies)
      .set('Origin', 'http://localhost:5173')
      .send({
        paymentId: String(payment!._id),
        reason: 'Chargeback reported by PhonePe support',
        detectedVia: 'PHONEPE_SUPPORT',
        providerCaseId: 'JEST-CB-1',
      })
      .expect(201);

    expect(created.body.data.status).toBe('OPEN');

    const refreshed = await Payment.findById(payment!._id);
    expect(refreshed?.status).toBe('SUCCESS');
    expect(refreshed?.amountPaise).toBe(100_000);
    expect(refreshed?.goldWeightMg).toBe(142);

    const exceptions = await api()
      .get('/api/v1/admin/finance/exceptions')
      .set('Cookie', cookies)
      .expect(200);

    expect(exceptions.body.data.some((row: { type: string }) => row.type === 'CHARGEBACK_REPORTED')).toBe(
      true,
    );

    const suspense = await api()
      .post('/api/v1/admin/finance/suspense')
      .set('Cookie', cookies)
      .send({
        entryType: 'UNMATCHED_CREDIT',
        amountPaise: 2500,
        description: 'Unidentified dashboard credit',
        source: 'PHONEPE_DASHBOARD',
      })
      .expect(201);

    expect(suspense.body.data.status).toBe('OPEN');
    expect(suspense.body.data.financialExceptionId).toBeTruthy();

    await api()
      .post(`/api/v1/admin/finance/suspense/${suspense.body.data._id}/resolve`)
      .set('Cookie', cookies)
      .set('Origin', 'http://localhost:5173')
      .send({ resolutionNotes: 'Written off after bank recon' })
      .expect(200);

    const exception = await FinancialException.findOne({ type: 'UNMATCHED_EXTERNAL_CREDIT' });
    expect(exception?.status).toBe('RESOLVED');

    await api()
      .post(`/api/v1/admin/finance/exceptions/${exception!._id}/resolve`)
      .set('Cookie', cookies)
      .set('Origin', 'http://localhost:5173')
      .send({ resolutionNotes: 'Already closed via suspense' })
      .expect(200);

    expect(
      await AuditLog.countDocuments({
        action: { $in: ['DISPUTE_CREATED', 'SUSPENSE_CREATED', 'SUSPENSE_RESOLVED'] },
      }),
    ).toBeGreaterThanOrEqual(3);
  });

  it('alerts admins once when an aging bucket escalates', async () => {
    await upsertFinancialException({
      dedupeKey: 'jest:aging:1',
      type: 'PAYMENT_PENDING_TOO_LONG',
      title: 'Stuck payment',
      now: new Date(Date.now() - 4 * 24 * 60 * 60_000),
    });
    await FinancialException.updateOne(
      { dedupeKey: 'jest:aging:1' },
      {
        $set: {
          firstSeenAt: new Date(Date.now() - 4 * 24 * 60 * 60_000),
          agingBucket: 'NEW',
          lastAlertedAt: null,
          nextReviewAt: new Date(Date.now() - 60_000),
        },
      },
    );

    const first = await ageOpenFinancialExceptions(new Date());
    expect(first.alerted).toBeGreaterThanOrEqual(1);
    const countAfterFirst = await Notification.countDocuments({
      type: 'FINANCIAL_EXCEPTION_AGING',
    });
    expect(countAfterFirst).toBeGreaterThanOrEqual(1);

    const second = await ageOpenFinancialExceptions(new Date());
    expect(second.alerted).toBe(0);
    expect(await Notification.countDocuments({ type: 'FINANCIAL_EXCEPTION_AGING' })).toBe(
      countAfterFirst,
    );
  });
});
