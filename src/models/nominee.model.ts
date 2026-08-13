import { createSchema, objectIdField, registerModel } from './model-helpers.js';

const nomineeSchema = createSchema({
  name: { type: String, required: true },
  relationship: { type: String, required: true },
  phone: String,
  dateOfBirth: Date,
  createdBy: objectIdField('User', false),
  updatedBy: objectIdField('User', false),
});

export const Nominee = registerModel('Nominee', nomineeSchema);
