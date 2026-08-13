import { createSchema, objectIdField, registerModel } from './model-helpers.js';
import { GATEWAY_SETTLEMENT_SOURCES, GATEWAY_SETTLEMENT_STATUSES } from './enums.js';

const gatewaySettlementSchema = createSchema({
  provider: { type: String, enum: ['PHONEPE'], default: 'PHONEPE' },
  settlementId: { type: String, required: true },
  periodFrom: { type: Date, required: true },
  periodTo: { type: Date, required: true },
  settlementDate: { type: Date, required: true },
  grossCollectionPaise: { type: Number, required: true, min: 0 },
  refundDeductionPaise: { type: Number, default: 0, min: 0 },
  chargebackDeductionPaise: { type: Number, default: 0, min: 0 },
  gatewayFeePaise: { type: Number, default: 0, min: 0 },
  gatewayFeeGstPaise: { type: Number, default: 0, min: 0 },
  otherAdjustmentPaise: { type: Number, default: 0 },
  netSettlementPaise: { type: Number, required: true, min: 0 },
  providerUtr: String,
  bankReferenceId: String,
  bankCreditedAt: Date,
  status: {
    type: String,
    enum: GATEWAY_SETTLEMENT_STATUSES,
    default: 'RECORDED',
    index: true,
  },
  source: { type: String, enum: GATEWAY_SETTLEMENT_SOURCES, required: true },
  notes: String,
  createdBy: objectIdField('User'),
  confirmedBy: objectIdField('User', false),
  confirmedAt: Date,
  closedBy: objectIdField('User', false),
  closedAt: Date,
});

gatewaySettlementSchema.index(
  { settlementId: 1 },
  { unique: true, name: 'GATEWAY_SETTLEMENT_ID_UNIQUE' },
);
gatewaySettlementSchema.index({ settlementDate: -1 });
gatewaySettlementSchema.index({ status: 1, settlementDate: -1 });
gatewaySettlementSchema.index({ periodFrom: 1, periodTo: 1 });

export const GatewaySettlement = registerModel('GatewaySettlement', gatewaySettlementSchema);
