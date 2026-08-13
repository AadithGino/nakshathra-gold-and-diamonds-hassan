import { createSchema, objectIdField, registerModel } from './model-helpers.js';
import {
  SUSPENSE_ENTRY_SOURCES,
  SUSPENSE_ENTRY_STATUSES,
  SUSPENSE_ENTRY_TYPES,
} from './enums.js';

const suspenseEntrySchema = createSchema({
  entryType: { type: String, enum: SUSPENSE_ENTRY_TYPES, required: true },
  status: { type: String, enum: SUSPENSE_ENTRY_STATUSES, default: 'OPEN', index: true },
  amountPaise: { type: Number, required: true, min: 1 },
  provider: String,
  providerReference: String,
  bankReference: String,
  transactionDate: Date,
  description: String,
  source: { type: String, enum: SUSPENSE_ENTRY_SOURCES, required: true },
  financialExceptionId: objectIdField('FinancialException', false),
  resolvedPaymentId: objectIdField('Payment', false),
  resolvedRefundId: objectIdField('Refund', false),
  resolvedAt: Date,
  resolvedBy: objectIdField('User', false),
  resolutionNotes: String,
  createdBy: objectIdField('User'),
});

suspenseEntrySchema.index({ status: 1, createdAt: -1 });
suspenseEntrySchema.index({ providerReference: 1 }, { sparse: true });

export const SuspenseEntry = registerModel('SuspenseEntry', suspenseEntrySchema);
