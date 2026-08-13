import mongoose from 'mongoose';
import {
  FinancialException,
  GatewaySettlement,
  GoldInventoryMovement,
  Refund,
  SuspenseEntry,
} from '../models/index.js';
import { getGoldControlSummary, getGoldLiabilityMovements } from './gold-control.service.js';
import { getGatewaySettlementLedgerSummary } from './gateway-settlement.service.js';
import { getPeriodSummary } from './accounting-period.service.js';

export async function bankSettlementLedgerReport(filters: {
  from?: Date;
  to?: Date;
  status?: string;
}) {
  const query: Record<string, unknown> = {};
  if (filters.status) query.status = filters.status;
  if (filters.from || filters.to) {
    query.settlementDate = mongoose.trusted({
      ...(filters.from ? { $gte: filters.from } : {}),
      ...(filters.to ? { $lte: filters.to } : {}),
    });
  }
  const items = await GatewaySettlement.find(mongoose.trusted(query))
    .sort({ settlementDate: -1, _id: -1 })
    .limit(500)
    .lean();
  const summary = await getGatewaySettlementLedgerSummary();
  return { items, summary, label: 'Operational bank settlement ledger' };
}

export async function gatewayExpensesReport(filters: { from?: Date; to?: Date }) {
  const match: Record<string, unknown> = {};
  if (filters.from || filters.to) {
    match.settlementDate = {
      ...(filters.from ? { $gte: filters.from } : {}),
      ...(filters.to ? { $lte: filters.to } : {}),
    };
  }
  const [row] = await GatewaySettlement.aggregate([
    ...(Object.keys(match).length ? [{ $match: match }] : []),
    {
      $group: {
        _id: null,
        gatewayFeePaise: { $sum: '$gatewayFeePaise' },
        gatewayFeeGstPaise: { $sum: '$gatewayFeeGstPaise' },
        refundDeductionPaise: { $sum: '$refundDeductionPaise' },
        chargebackDeductionPaise: { $sum: '$chargebackDeductionPaise' },
        netSettlementPaise: { $sum: '$netSettlementPaise' },
        count: { $sum: 1 },
      },
    },
  ]);
  return {
    gatewayFeePaise: row?.gatewayFeePaise ?? 0,
    gatewayFeeGstPaise: row?.gatewayFeeGstPaise ?? 0,
    refundDeductionPaise: row?.refundDeductionPaise ?? 0,
    chargebackDeductionPaise: row?.chargebackDeductionPaise ?? 0,
    netSettlementPaise: row?.netSettlementPaise ?? 0,
    settlementCount: row?.count ?? 0,
    label: 'Operational gateway expense report (not a statutory trial balance)',
  };
}

export async function refundOperationsReport() {
  const [byStatus, aging] = await Promise.all([
    Refund.aggregate([
      {
        $group: {
          _id: '$status',
          count: { $sum: 1 },
          amountPaise: { $sum: '$amountPaise' },
        },
      },
    ]),
    Refund.aggregate([
      {
        $match: { status: { $in: ['INITIATED', 'PENDING'] } },
      },
      {
        $project: {
          amountPaise: 1,
          ageHours: {
            $divide: [{ $subtract: [new Date(), '$requestedAt'] }, 3_600_000],
          },
        },
      },
      {
        $group: {
          _id: {
            $switch: {
              branches: [
                { case: { $lt: ['$ageHours', 6] }, then: 'NEW' },
                { case: { $lt: ['$ageHours', 24] }, then: 'WARNING' },
                { case: { $lt: ['$ageHours', 72] }, then: 'OVERDUE' },
              ],
              default: 'CRITICAL',
            },
          },
          count: { $sum: 1 },
          amountPaise: { $sum: '$amountPaise' },
        },
      },
    ]),
  ]);

  const totals = Object.fromEntries(
    byStatus.map((row: { _id: string; count: number; amountPaise: number }) => [
      row._id,
      { count: row.count, amountPaise: row.amountPaise },
    ]),
  );
  return {
    byStatus: totals,
    aging,
    totalRefundedPaise: totals.SUCCESS?.amountPaise ?? 0,
    label: 'Operational refund report',
  };
}

export async function suspenseLedgerReport() {
  const items = await SuspenseEntry.find().sort({ createdAt: -1, _id: -1 }).limit(500).lean();
  const openPaise = items
    .filter((row: { status: string }) => row.status === 'OPEN')
    .reduce(
      (sum: number, row: { amountPaise: number }) => sum + Number(row.amountPaise),
      0,
    );
  return { items, openPaise, label: 'Operational suspense ledger' };
}

export async function goldControlReport(filters: { from?: Date; to?: Date }) {
  const [summary, liabilityMovements, inventoryMovements] = await Promise.all([
    getGoldControlSummary(),
    getGoldLiabilityMovements(filters.from, filters.to),
    GoldInventoryMovement.find(
      filters.from || filters.to
        ? mongoose.trusted({
            movementDate: mongoose.trusted({
              ...(filters.from ? { $gte: filters.from } : {}),
              ...(filters.to ? { $lte: filters.to } : {}),
            }),
          })
        : {},
    )
      .sort({ movementDate: -1, _id: -1 })
      .limit(500)
      .lean(),
  ]);
  return {
    ...summary,
    liabilityMovements,
    inventoryMovements,
    label: 'Operational gold control report',
  };
}

export async function financialExceptionsAgingReport() {
  const rows = await FinancialException.aggregate([
    {
      $match: {
        status: { $in: ['OPEN', 'ACKNOWLEDGED'] },
      },
    },
    {
      $group: {
        _id: {
          type: '$type',
          severity: '$severity',
          agingBucket: '$agingBucket',
        },
        count: { $sum: 1 },
        amountPaise: { $sum: { $ifNull: ['$amountPaise', 0] } },
      },
    },
    { $sort: { '_id.severity': -1, count: -1 } },
  ]);
  return { buckets: rows, label: 'Operational financial exception aging' };
}

export async function financialPeriodReport(periodKey: string) {
  return getPeriodSummary(periodKey);
}
