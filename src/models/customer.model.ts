import { createSchema, objectIdField, registerModel } from './model-helpers.js';
import { KYC_STATUSES } from './enums.js';

const customerSchema = createSchema({
  userId: { ...objectIdField('User'), unique: true },
  customerCode: { type: String, required: true, unique: true },
  address: {
    line1: String,
    line2: String,
    city: String,
    district: String,
    state: String,
    postalCode: String,
  },
  aadhaar: {
    frontKey: String,
    backKey: String,
  },
  kycStatus: { type: String, enum: KYC_STATUSES, default: 'NOT_SUBMITTED', index: true },
  kycSubmittedAt: Date,
  kycReviewedAt: Date,
  kycReviewedBy: objectIdField('User', false),
  kycRejectionReason: String,
  nomineeId: objectIdField('Nominee', false),
  status: { type: String, enum: ['ACTIVE', 'INACTIVE'], default: 'ACTIVE', index: true },
  createdBy: objectIdField('User'),
  updatedBy: objectIdField('User', false),
});

customerSchema.index({ customerCode: 'text' });

export const Customer = registerModel('Customer', customerSchema);
