import { createSchema, objectIdField, registerModel, Schema } from './model-helpers.js';
import { ACCOUNTING_PERIOD_STATUSES } from './enums.js';

const accountingPeriodSchema = createSchema({
  periodKey: { type: String, required: true },
  startsAt: { type: Date, required: true },
  endsAt: { type: Date, required: true },
  status: {
    type: String,
    enum: ACCOUNTING_PERIOD_STATUSES,
    default: 'OPEN',
    index: true,
  },
  closedAt: Date,
  closedBy: objectIdField('User', false),
  closeNotes: String,
  reopenedAt: Date,
  reopenedBy: objectIdField('User', false),
  reopenReason: String,
  snapshot: {
    successfulCollectionPaise: Number,
    successfulPaymentCount: Number,
    refundCompletedPaise: Number,
    refundCount: Number,
    reversalPaise: Number,
    reversalCount: Number,
    netCollectionMovementPaise: Number,
    payoutPaise: Number,
    payoutGoldWeightMg: Number,
    gatewayFeePaise: Number,
    gatewayFeeGstPaise: Number,
    bankSettlementPaise: Number,
    closingGoldLiabilityMg: Number,
    closingGoldInventoryMg: Number,
    closingSuspensePaise: Number,
    openExceptionCount: Number,
  },
  previousSnapshots: [
    {
      closedAt: Date,
      closedBy: Schema.Types.ObjectId,
      closeNotes: String,
      snapshot: Schema.Types.Mixed,
    },
  ],
});

accountingPeriodSchema.index(
  { periodKey: 1 },
  { unique: true, name: 'ACCOUNTING_PERIOD_KEY_UNIQUE' },
);
accountingPeriodSchema.index({ status: 1, startsAt: 1 });

export const AccountingPeriod = registerModel('AccountingPeriod', accountingPeriodSchema);
