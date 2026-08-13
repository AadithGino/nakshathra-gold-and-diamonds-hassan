import { createSchema, objectIdField, registerModel } from './model-helpers.js';
import {
  GOLD_INVENTORY_DIRECTIONS,
  GOLD_INVENTORY_MOVEMENT_TYPES,
} from './enums.js';

const goldInventoryMovementSchema = createSchema({
  movementType: {
    type: String,
    enum: GOLD_INVENTORY_MOVEMENT_TYPES,
    required: true,
  },
  direction: { type: String, enum: GOLD_INVENTORY_DIRECTIONS, required: true },
  goldWeightMg: { type: Number, required: true, min: 1 },
  purity: { type: String, enum: ['916'], default: '916' },
  movementDate: { type: Date, required: true, index: true },
  payoutId: objectIdField('Payout', false),
  referenceNumber: String,
  reason: { type: String, required: true },
  createdBy: objectIdField('User'),
  accountingPeriodId: objectIdField('AccountingPeriod', false),
});

goldInventoryMovementSchema.index({ movementDate: -1 });
goldInventoryMovementSchema.index({ movementType: 1, movementDate: -1 });
goldInventoryMovementSchema.index(
  { payoutId: 1 },
  { unique: true, sparse: true, name: 'GOLD_INVENTORY_PAYOUT_UNIQUE' },
);

export const GoldInventoryMovement = registerModel(
  'GoldInventoryMovement',
  goldInventoryMovementSchema,
);
