import { createSchema, registerModel } from './model-helpers.js';

const receiptCounterSchema = createSchema({
  scope: { type: String, required: true },
  value: { type: Number, default: 0 },
});

receiptCounterSchema.index({ scope: 1 }, { unique: true, name: 'RECEIPT_COUNTER_SCOPE_UNIQUE' });

export const ReceiptCounter = registerModel('ReceiptCounter', receiptCounterSchema);
