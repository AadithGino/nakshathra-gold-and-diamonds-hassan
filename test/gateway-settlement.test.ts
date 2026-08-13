import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AuditLog, GatewaySettlement, Payment, User } from '../src/models/index.js';
import {
  closeGatewaySettlement,
  confirmGatewaySettlementBankCredit,
  createGatewaySettlement,
  expectedNetSettlementPaise,
  getGatewaySettlementLedgerSummary,
} from '../src/services/gateway-settlement.service.js';
import { clearTestMongo, startTestMongo, stopTestMongo } from './helpers/mongo.js';

describe('gateway settlements', () => {
  beforeAll(async () => {
    await startTestMongo();
  });
  afterAll(async () => {
    await stopTestMongo();
  });
  beforeEach(async () => {
    await clearTestMongo();
  });

  it('balances the settlement formula exactly', () => {
    expect(
      expectedNetSettlementPaise({
        grossCollectionPaise: 100_000,
        refundDeductionPaise: 10_000,
        chargebackDeductionPaise: 5_000,
        gatewayFeePaise: 2_000,
        gatewayFeeGstPaise: 360,
        otherAdjustmentPaise: -100,
      }),
    ).toBe(82_540);
  });

  it('records, confirms, and closes a settlement without touching payments', async () => {
    const [admin] = await User.create([
      {
        name: 'Settlement Admin',
        phone: '+919911100001',
        passwordHash: 'hash',
        role: 'ADMIN',
        status: 'ACTIVE',
      },
    ]);

    const [payment] = await Payment.create([
      {
        customerId: admin._id,
        schemeId: admin._id,
        amountPaise: 100_000,
        goldWeightMg: 142,
        method: 'PHONEPE',
        status: 'SUCCESS',
        paymentDate: new Date(),
        schemeMonth: 1,
        receiptNumber: 'RCP-SET-1',
        merchantTransactionId: 'KRL-SET-1',
        collectorRole: 'ADMIN',
        createdBy: admin._id,
      },
    ]);

    const net = expectedNetSettlementPaise({
      grossCollectionPaise: 100_000,
      gatewayFeePaise: 2_000,
      gatewayFeeGstPaise: 360,
      otherAdjustmentPaise: -40,
    });

    await expect(
      createGatewaySettlement(
        {
          settlementId: 'SET-FAIL',
          periodFrom: new Date('2026-01-01'),
          periodTo: new Date('2026-01-07'),
          settlementDate: new Date('2026-01-08'),
          grossCollectionPaise: 100_000,
          gatewayFeePaise: 2_000,
          gatewayFeeGstPaise: 360,
          otherAdjustmentPaise: -40,
          netSettlementPaise: net + 1,
          source: 'PHONEPE_DASHBOARD',
        },
        { actorId: String(admin._id), actorRole: 'ADMIN', requestId: 'bad-net' },
      ),
    ).rejects.toMatchObject({ code: 'GATEWAY_SETTLEMENT_IMBALANCE' });

    const settlement = await createGatewaySettlement(
      {
        settlementId: 'SET-1',
        periodFrom: new Date('2026-01-01'),
        periodTo: new Date('2026-01-07'),
        settlementDate: new Date('2026-01-08'),
        grossCollectionPaise: 100_000,
        gatewayFeePaise: 2_000,
        gatewayFeeGstPaise: 360,
        otherAdjustmentPaise: -40,
        netSettlementPaise: net,
        source: 'PHONEPE_DASHBOARD',
      },
      { actorId: String(admin._id), actorRole: 'ADMIN', requestId: 'create' },
    );

    expect(settlement.status).toBe('RECORDED');
    expect(settlement.netSettlementPaise).toBe(net);

    await expect(
      createGatewaySettlement(
        {
          settlementId: 'SET-1',
          periodFrom: new Date('2026-01-01'),
          periodTo: new Date('2026-01-07'),
          settlementDate: new Date('2026-01-08'),
          grossCollectionPaise: 100_000,
          gatewayFeePaise: 2_000,
          gatewayFeeGstPaise: 360,
          otherAdjustmentPaise: -40,
          netSettlementPaise: net,
          source: 'MANUAL',
        },
        { actorId: String(admin._id), actorRole: 'ADMIN', requestId: 'dup' },
      ),
    ).rejects.toMatchObject({ code: 'GATEWAY_SETTLEMENT_DUPLICATE' });

    await expect(
      confirmGatewaySettlementBankCredit(
        String(settlement._id),
        { bankCreditedAt: new Date() },
        { actorId: String(admin._id), actorRole: 'ADMIN', requestId: 'no-ref' },
      ),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });

    const confirmed = await confirmGatewaySettlementBankCredit(
      String(settlement._id),
      {
        providerUtr: 'UTR-1',
        bankCreditedAt: new Date('2026-01-09'),
        notes: 'Seen in bank',
      },
      { actorId: String(admin._id), actorRole: 'ADMIN', requestId: 'confirm' },
    );
    expect(confirmed.status).toBe('BANK_CONFIRMED');

    const closed = await closeGatewaySettlement(
      String(settlement._id),
      { notes: 'Month closed' },
      { actorId: String(admin._id), actorRole: 'ADMIN', requestId: 'close' },
    );
    expect(closed.status).toBe('CLOSED');

    await expect(
      confirmGatewaySettlementBankCredit(
        String(settlement._id),
        { providerUtr: 'UTR-2', bankCreditedAt: new Date() },
        { actorId: String(admin._id), actorRole: 'ADMIN', requestId: 'edit-closed' },
      ),
    ).rejects.toMatchObject({ code: 'GATEWAY_SETTLEMENT_CLOSED' });

    const refreshedPayment = await Payment.findById(payment._id);
    expect(refreshedPayment?.amountPaise).toBe(100_000);
    expect(refreshedPayment?.goldWeightMg).toBe(142);
    expect(refreshedPayment?.status).toBe('SUCCESS');

    const summary = await getGatewaySettlementLedgerSummary();
    expect(summary.bankConfirmedNetPaise).toBe(net);
    expect(summary.totalGatewayFeePaise).toBe(2_000);
    expect(summary.totalGatewayFeeGstPaise).toBe(360);

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
    expect(await GatewaySettlement.countDocuments()).toBe(1);
  });
});
