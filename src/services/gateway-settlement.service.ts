import { GatewaySettlement } from '../models/index.js';
import { AppError } from '../utils/AppError.js';
import {
  buildCursorPage,
  buildOffsetPage,
  coerceBoundedListQuery,
  cursorFetchLimit,
  offsetSkip,
  type ListPageResult,
  type ListQuery,
  withKeysetFilter,
} from '../utils/cursor-pagination.js';
import { withMongoTransaction } from '../utils/transaction.js';
import { audit, type AuditContext } from './audit.service.js';
import { assertDateInOpenPeriod } from './accounting-period.service.js';

export function expectedNetSettlementPaise(input: {
  grossCollectionPaise: number;
  refundDeductionPaise?: number;
  chargebackDeductionPaise?: number;
  gatewayFeePaise?: number;
  gatewayFeeGstPaise?: number;
  otherAdjustmentPaise?: number;
}) {
  return (
    input.grossCollectionPaise -
    (input.refundDeductionPaise ?? 0) -
    (input.chargebackDeductionPaise ?? 0) -
    (input.gatewayFeePaise ?? 0) -
    (input.gatewayFeeGstPaise ?? 0) +
    (input.otherAdjustmentPaise ?? 0)
  );
}

function assertNotClosed(settlement: { status: string }) {
  if (settlement.status === 'CLOSED') {
    throw new AppError(
      'GATEWAY_SETTLEMENT_CLOSED',
      'Closed settlements cannot be edited',
      409,
    );
  }
}

export async function createGatewaySettlement(
  input: {
    settlementId: string;
    periodFrom: Date;
    periodTo: Date;
    settlementDate: Date;
    grossCollectionPaise: number;
    refundDeductionPaise?: number;
    chargebackDeductionPaise?: number;
    gatewayFeePaise?: number;
    gatewayFeeGstPaise?: number;
    otherAdjustmentPaise?: number;
    netSettlementPaise: number;
    providerUtr?: string;
    bankReferenceId?: string;
    source: string;
    notes?: string;
  },
  context: AuditContext & { actorId: string },
) {
  const expected = expectedNetSettlementPaise(input);
  if (expected !== input.netSettlementPaise) {
    throw new AppError(
      'GATEWAY_SETTLEMENT_IMBALANCE',
      `netSettlementPaise must equal ${expected}`,
      422,
    );
  }
  if (expected < 0) {
    throw new AppError(
      'GATEWAY_SETTLEMENT_IMBALANCE',
      'Computed net settlement cannot be negative',
      422,
    );
  }

  return withMongoTransaction(async (session) => {
    await assertDateInOpenPeriod(input.settlementDate, session);
    try {
      const [settlement] = await GatewaySettlement.create(
        [
          {
            provider: 'PHONEPE',
            settlementId: input.settlementId.trim(),
            periodFrom: input.periodFrom,
            periodTo: input.periodTo,
            settlementDate: input.settlementDate,
            grossCollectionPaise: input.grossCollectionPaise,
            refundDeductionPaise: input.refundDeductionPaise ?? 0,
            chargebackDeductionPaise: input.chargebackDeductionPaise ?? 0,
            gatewayFeePaise: input.gatewayFeePaise ?? 0,
            gatewayFeeGstPaise: input.gatewayFeeGstPaise ?? 0,
            otherAdjustmentPaise: input.otherAdjustmentPaise ?? 0,
            netSettlementPaise: input.netSettlementPaise,
            providerUtr: input.providerUtr,
            bankReferenceId: input.bankReferenceId,
            status: 'RECORDED',
            source: input.source,
            notes: input.notes,
            createdBy: context.actorId,
          },
        ],
        { session },
      );

      await audit(
        session,
        context,
        'GATEWAY_SETTLEMENT_RECORDED',
        'GatewaySettlement',
        settlement._id,
        undefined,
        {
          settlementId: settlement.settlementId,
          netSettlementPaise: settlement.netSettlementPaise,
          gatewayFeePaise: settlement.gatewayFeePaise,
          gatewayFeeGstPaise: settlement.gatewayFeeGstPaise,
        },
      );

      return settlement;
    } catch (error: any) {
      if (error?.code === 11000) {
        throw new AppError(
          'GATEWAY_SETTLEMENT_DUPLICATE',
          'A settlement with this settlementId already exists',
          409,
        );
      }
      throw error;
    }
  }, context.requestId ?? 'gateway-settlement-create');
}

export async function listGatewaySettlements(
  listQuery: ListQuery,
): Promise<ListPageResult<any>> {
  const query = coerceBoundedListQuery(listQuery);
  const sortField = 'settlementDate';
  const filter = withKeysetFilter({}, query, sortField);
  const baseQuery = GatewaySettlement.find(filter)
    .populate('createdBy', 'name phone')
    .populate('confirmedBy', 'name phone');

  if (query.mode === 'cursor') {
    const rows = await baseQuery
      .sort({ [sortField]: -1, _id: -1 })
      .limit(cursorFetchLimit(query))
      .lean();
    return buildCursorPage(
      rows,
      query.limit,
      sortField,
      (row) => new Date(row.settlementDate),
      (row) => row._id,
    );
  }
  const [items, total] = await Promise.all([
    baseQuery
      .sort({ [sortField]: -1, _id: -1 })
      .skip(offsetSkip(query))
      .limit(query.limit)
      .lean(),
    GatewaySettlement.countDocuments(),
  ]);
  return buildOffsetPage(items, total, query.page, query.limit);
}

export async function getGatewaySettlementDetail(id: string) {
  const row = await GatewaySettlement.findById(id)
    .populate('createdBy', 'name phone')
    .populate('confirmedBy', 'name phone')
    .populate('closedBy', 'name phone')
    .lean();
  if (!row) throw new AppError('GATEWAY_SETTLEMENT_NOT_FOUND', 'Gateway settlement not found', 404);
  return row;
}

export async function confirmGatewaySettlementBankCredit(
  id: string,
  input: {
    providerUtr?: string;
    bankReferenceId?: string;
    bankCreditedAt: Date;
    notes?: string;
  },
  context: AuditContext & { actorId: string },
) {
  if (!input.providerUtr && !input.bankReferenceId) {
    throw new AppError(
      'VALIDATION_ERROR',
      'providerUtr or bankReferenceId is required',
      422,
    );
  }

  return withMongoTransaction(async (session) => {
    const settlement = await GatewaySettlement.findById(id).session(session);
    if (!settlement) {
      throw new AppError('GATEWAY_SETTLEMENT_NOT_FOUND', 'Gateway settlement not found', 404);
    }
    assertNotClosed(settlement);
    await assertDateInOpenPeriod(settlement.settlementDate, session);
    if (settlement.status === 'BANK_CONFIRMED') return settlement;

    const before = settlement.toObject();
    const now = new Date();
    settlement.status = 'BANK_CONFIRMED';
    settlement.providerUtr = input.providerUtr ?? settlement.providerUtr;
    settlement.bankReferenceId = input.bankReferenceId ?? settlement.bankReferenceId;
    settlement.bankCreditedAt = input.bankCreditedAt;
    settlement.confirmedBy = context.actorId;
    settlement.confirmedAt = now;
    if (input.notes) {
      settlement.notes = [settlement.notes, input.notes].filter(Boolean).join('\n');
    }
    await settlement.save({ session });

    await audit(
      session,
      context,
      'GATEWAY_SETTLEMENT_BANK_CONFIRMED',
      'GatewaySettlement',
      settlement._id,
      before,
      settlement.toObject(),
    );
    return settlement;
  }, context.requestId ?? 'gateway-settlement-confirm');
}

export async function closeGatewaySettlement(
  id: string,
  input: { notes?: string },
  context: AuditContext & { actorId: string },
) {
  return withMongoTransaction(async (session) => {
    const settlement = await GatewaySettlement.findById(id).session(session);
    if (!settlement) {
      throw new AppError('GATEWAY_SETTLEMENT_NOT_FOUND', 'Gateway settlement not found', 404);
    }
    // Settlement records in RECORDED status also block accounting-period close until
    // bank confirmation (or an audited overrideReason is supplied).
    if (settlement.status === 'CLOSED') return settlement;
    if (settlement.status !== 'BANK_CONFIRMED') {
      throw new AppError(
        'GATEWAY_SETTLEMENT_NOT_CONFIRMED',
        'Settlement must be bank-confirmed before closing',
        409,
      );
    }

    const before = settlement.toObject();
    settlement.status = 'CLOSED';
    settlement.closedBy = context.actorId;
    settlement.closedAt = new Date();
    if (input.notes) {
      settlement.notes = [settlement.notes, input.notes].filter(Boolean).join('\n');
    }
    await settlement.save({ session });

    await audit(
      session,
      context,
      'GATEWAY_SETTLEMENT_CLOSED',
      'GatewaySettlement',
      settlement._id,
      before,
      settlement.toObject(),
    );
    return settlement;
  }, context.requestId ?? 'gateway-settlement-close');
}

/** Derived bank-settlement ledger totals — does not mutate customer payments. */
export async function getGatewaySettlementLedgerSummary() {
  const [rows] = await GatewaySettlement.aggregate([
    {
      $group: {
        _id: null,
        bankConfirmedNetPaise: {
          $sum: {
            $cond: [
              { $in: ['$status', ['BANK_CONFIRMED', 'CLOSED']] },
              '$netSettlementPaise',
              0,
            ],
          },
        },
        outstandingRecordedNetPaise: {
          $sum: {
            $cond: [{ $eq: ['$status', 'RECORDED'] }, '$netSettlementPaise', 0],
          },
        },
        totalGatewayFeePaise: { $sum: '$gatewayFeePaise' },
        totalGatewayFeeGstPaise: { $sum: '$gatewayFeeGstPaise' },
        totalRefundDeductionPaise: { $sum: '$refundDeductionPaise' },
        totalChargebackDeductionPaise: { $sum: '$chargebackDeductionPaise' },
        count: { $sum: 1 },
      },
    },
  ]);

  return {
    bankConfirmedNetPaise: rows?.bankConfirmedNetPaise ?? 0,
    outstandingRecordedNetPaise: rows?.outstandingRecordedNetPaise ?? 0,
    totalGatewayFeePaise: rows?.totalGatewayFeePaise ?? 0,
    totalGatewayFeeGstPaise: rows?.totalGatewayFeeGstPaise ?? 0,
    totalRefundDeductionPaise: rows?.totalRefundDeductionPaise ?? 0,
    totalChargebackDeductionPaise: rows?.totalChargebackDeductionPaise ?? 0,
    settlementCount: rows?.count ?? 0,
  };
}
