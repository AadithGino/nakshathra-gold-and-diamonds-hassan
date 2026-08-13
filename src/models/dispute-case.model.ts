import { createSchema, objectIdField, registerModel } from './model-helpers.js';
import { DISPUTE_DETECTED_VIA, DISPUTE_STATUSES } from './enums.js';

const disputeCaseSchema = createSchema({
  paymentId: objectIdField('Payment'),
  customerId: objectIdField('Customer'),
  schemeId: objectIdField('SchemeEnrollment'),
  provider: { type: String, enum: ['PHONEPE'], default: 'PHONEPE' },
  providerCaseId: String,
  amountPaise: { type: Number, required: true, min: 1 },
  reasonCode: String,
  reason: String,
  status: {
    type: String,
    enum: DISPUTE_STATUSES,
    default: 'OPEN',
    index: true,
  },
  detectedVia: {
    type: String,
    enum: DISPUTE_DETECTED_VIA,
    required: true,
  },
  notifiedAt: Date,
  responseDueAt: Date,
  evidenceNotes: String,
  resolutionReference: String,
  resolvedAt: Date,
  createdBy: objectIdField('User'),
  updatedBy: objectIdField('User', false),
  financialExceptionId: objectIdField('FinancialException', false),
});

disputeCaseSchema.index({ paymentId: 1, status: 1 });
disputeCaseSchema.index({ providerCaseId: 1 }, { sparse: true });
disputeCaseSchema.index({ responseDueAt: 1, status: 1 });

export const DisputeCase = registerModel('DisputeCase', disputeCaseSchema);
