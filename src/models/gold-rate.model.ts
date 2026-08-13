import { createSchema, objectIdField, registerModel } from './model-helpers.js';

const goldRateSchema = createSchema({
  ratePerGramPaise: { type: Number, required: true, min: 1 },
  purity: { type: String, enum: ['916'], default: '916', required: true, immutable: true },
  effectiveFrom: { type: Date, required: true, unique: true },
  status: { type: String, enum: ['ACTIVE', 'INACTIVE'], default: 'ACTIVE', index: true },
  notes: String,
  createdBy: objectIdField('User'),
  updatedBy: objectIdField('User', false),
  usageCount: { type: Number, default: 0, min: 0 },
});

goldRateSchema.index({ status: 1, effectiveFrom: -1 });

export const GoldRate = registerModel('GoldRate', goldRateSchema);
