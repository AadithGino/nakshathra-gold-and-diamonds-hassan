import { createSchema, objectIdField, registerModel, Schema } from './model-helpers.js';
import {
  FINANCIAL_EXCEPTION_AGING_BUCKETS,
  FINANCIAL_EXCEPTION_SEVERITIES,
  FINANCIAL_EXCEPTION_STATUSES,
  FINANCIAL_EXCEPTION_TYPES,
} from './enums.js';

const financialExceptionSchema = createSchema({
  type: { type: String, enum: FINANCIAL_EXCEPTION_TYPES, required: true },
  severity: { type: String, enum: FINANCIAL_EXCEPTION_SEVERITIES, required: true },
  status: {
    type: String,
    enum: FINANCIAL_EXCEPTION_STATUSES,
    default: 'OPEN',
    index: true,
  },
  dedupeKey: { type: String, required: true, unique: true },
  sourceType: String,
  sourceId: Schema.Types.ObjectId,
  paymentId: objectIdField('Payment', false),
  paymentIntentId: objectIdField('PaymentIntent', false),
  refundId: objectIdField('Refund', false),
  disputeId: objectIdField('DisputeCase', false),
  customerId: objectIdField('Customer', false),
  schemeId: objectIdField('SchemeEnrollment', false),
  amountPaise: Number,
  providerReference: String,
  title: String,
  description: String,
  firstSeenAt: { type: Date, required: true },
  lastSeenAt: { type: Date, required: true },
  occurrenceCount: { type: Number, default: 1 },
  agingBucket: {
    type: String,
    enum: FINANCIAL_EXCEPTION_AGING_BUCKETS,
    default: 'NEW',
  },
  nextReviewAt: Date,
  lastAlertedAt: Date,
  acknowledgedAt: Date,
  acknowledgedBy: objectIdField('User', false),
  resolvedAt: Date,
  resolvedBy: objectIdField('User', false),
  resolutionNotes: String,
  /** Immutable status timeline — never delete historical resolved/open transitions. */
  statusHistory: [
    {
      status: { type: String, enum: FINANCIAL_EXCEPTION_STATUSES },
      at: { type: Date, required: true },
      actorId: objectIdField('User', false),
      note: String,
    },
  ],
  metadata: Schema.Types.Mixed,
});

financialExceptionSchema.index({ status: 1, severity: 1, firstSeenAt: 1 });
financialExceptionSchema.index({ status: 1, nextReviewAt: 1 });
financialExceptionSchema.index({ paymentId: 1 });
financialExceptionSchema.index({ refundId: 1 });
financialExceptionSchema.index({ agingBucket: 1, status: 1 });

export const FinancialException = registerModel('FinancialException', financialExceptionSchema);
