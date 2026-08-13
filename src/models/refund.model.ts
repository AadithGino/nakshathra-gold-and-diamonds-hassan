import { createSchema, objectIdField, registerModel, Schema } from './model-helpers.js';
import { REFUND_STATUSES } from './enums.js';

const refundSchema = createSchema({
  paymentId: objectIdField('Payment'),
  paymentIntentId: objectIdField('PaymentIntent', false),
  customerId: objectIdField('Customer'),
  schemeId: objectIdField('SchemeEnrollment'),
  provider: { type: String, enum: ['PHONEPE'], default: 'PHONEPE' },
  merchantRefundId: { type: String, required: true },
  providerRefundId: { type: String },
  originalMerchantOrderId: { type: String, required: true },
  amountPaise: { type: Number, required: true, min: 1 },
  status: { type: String, enum: REFUND_STATUSES, required: true, index: true },
  /** Attempt sequence per payment (1-based). Failed attempts remain immutable history. */
  attemptNumber: { type: Number, required: true, min: 1, default: 1 },
  /**
   * At most one active attempt per payment (partial unique index).
   * INITIATED/PENDING → true; SUCCESS/FAILED/REVIEW_REQUIRED → false.
   */
  active: { type: Boolean, required: true, default: true, index: true },
  reason: { type: String, required: true },
  idempotencyKey: { type: String, required: true },
  requestHash: { type: String, required: true },
  requestedBy: objectIdField('User'),
  requestedAt: { type: Date, required: true },
  /** Set only when PhonePe accepted initiation (not on uncertain network failure). */
  providerInitiatedAt: Date,
  /** Provider-supplied completion time when available from verified status. */
  providerCompletedAt: Date,
  /** Backend-verified terminal confirmation time. */
  confirmedAt: Date,
  completedAt: Date,
  failedAt: Date,
  providerBankReferenceId: String,
  providerRailType: String,
  providerErrorCode: String,
  providerDetailedErrorCode: String,
  providerErrorMessage: String,
  lastStatusCheckedAt: Date,
  nextStatusCheckAt: { type: Date, index: true },
  statusCheckAttempts: { type: Number, default: 0 },
  recoveryLockedAt: Date,
  recoveryLockUntil: Date,
  recoveryLockedBy: String,
  lastProviderResponse: Schema.Types.Mixed,
  lastProviderError: String,
  statusHistory: [
    {
      status: String,
      at: Date,
      source: String,
      note: String,
    },
  ],
});

// One in-flight attempt per payment (terminal attempts keep history with active=false).
refundSchema.index(
  { merchantRefundId: 1 },
  { unique: true, name: 'merchantRefundId_1' },
);
refundSchema.index(
  { providerRefundId: 1 },
  { unique: true, sparse: true, name: 'REFUND_PROVIDER_REFUND_ID_UNIQUE' },
);
refundSchema.index(
  { paymentId: 1 },
  {
    unique: true,
    name: 'paymentId_1_active_partial',
    partialFilterExpression: { active: true },
  },
);
refundSchema.index(
  { paymentId: 1, attemptNumber: 1 },
  { unique: true, name: 'paymentId_1_attemptNumber_1' },
);
refundSchema.index(
  { requestedBy: 1, idempotencyKey: 1 },
  { unique: true, name: 'requestedBy_1_idempotencyKey_1' },
);
refundSchema.index(
  { status: 1, nextStatusCheckAt: 1, recoveryLockUntil: 1 },
  { name: 'status_1_nextStatusCheckAt_1_recoveryLockUntil_1' },
);
refundSchema.index({ createdAt: -1 });

export const Refund = registerModel('Refund', refundSchema);
