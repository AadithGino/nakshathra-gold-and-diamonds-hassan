import { createSchema, objectIdField, registerModel, Schema } from './model-helpers.js';
import {
  CASH_SETTLEMENT_BASES,
  JEWELLERY_EXTRA_PAYMENT_METHODS,
  PAYOUT_METHODS,
  PAYOUT_TYPES,
  SETTLEMENT_MODES,
} from './enums.js';

const payoutSchema = createSchema({
  customerId: objectIdField('Customer'),
  schemeId: { ...objectIdField('SchemeEnrollment'), index: true },
  amountPaise: { type: Number, required: true, min: 1 },
  settlementPrincipalPaise: { type: Number, required: true, min: 0 },
  goldWeightMg: { type: Number, default: 0, min: 0 },
  makingChargeWaiverPercent: { type: Number, default: 100, min: 100, max: 100 },
  gstRateBasisPoints: { type: Number, default: 300, min: 300, max: 300 },
  payoutType: {
    type: String,
    enum: PAYOUT_TYPES,
    required: true,
  },
  method: {
    type: String,
    enum: PAYOUT_METHODS,
    default: 'GOLD',
    required: true,
  },
  cashBasis: { type: String, enum: CASH_SETTLEMENT_BASES },
  valuationGoldRateId: objectIdField('GoldRate', false),
  valuationGoldRatePerGramPaise: { type: Number, min: 1 },
  valuationGoldWeightMg: { type: Number, min: 0 },
  settlementMode: { type: String, enum: SETTLEMENT_MODES },
  billNumber: { type: String, maxlength: 80 },
  billAmountPaise: { type: Number, min: 1 },
  schemeValueAppliedPaise: { type: Number, min: 0 },
  extraPaidPaise: { type: Number, min: 0 },
  extraPaymentMethod: { type: String, enum: JEWELLERY_EXTRA_PAYMENT_METHODS },
  extraPaymentReference: { type: String, maxlength: 120 },
  policySnapshot: Schema.Types.Mixed,
  idempotencyKey: { type: String, maxlength: 120 },
  requestHash: { type: String, maxlength: 64 },
  reason: { type: String, maxlength: 500 },
  payoutDate: { type: Date, required: true },
  referenceNumber: String,
  notes: String,
  status: { type: String, enum: ['SUCCESS', 'REVERSED'], default: 'SUCCESS' },
  createdBy: objectIdField('User'),
  reversedAt: Date,
});

payoutSchema.pre('validate', function defaultSettlementPrincipal(this: any) {
  if (this.settlementPrincipalPaise == null && this.amountPaise != null) {
    this.settlementPrincipalPaise = this.amountPaise;
  }
});

payoutSchema.index({ customerId: 1, payoutDate: -1 });
payoutSchema.index({ payoutDate: -1 });
payoutSchema.index({ schemeId: 1, payoutDate: -1 });
payoutSchema.index(
  { schemeId: 1 },
  {
    unique: true,
    name: 'payout_one_success_per_scheme',
    partialFilterExpression: { status: 'SUCCESS' },
  },
);
payoutSchema.index(
  { schemeId: 1, idempotencyKey: 1 },
  {
    unique: true,
    sparse: true,
    name: 'PAYOUT_SCHEME_IDEMPOTENCY_UNIQUE',
  },
);

export const Payout = registerModel('Payout', payoutSchema);
