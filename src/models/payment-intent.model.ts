import { createSchema, objectIdField, registerModel } from './model-helpers.js';
import {
  PAYMENT_FINAL_STATUS_SOURCES,
  PAYMENT_INTENT_STATUSES,
  PHONEPE_CHECKOUT_CHANNELS,
  PHONEPE_IDEMPOTENCY_SCOPES,
  ROLES,
} from './enums.js';

const paymentIntentSchema = createSchema({
  customerId: objectIdField('Customer'),
  schemeId: objectIdField('SchemeEnrollment'),
  amountPaise: { type: Number, required: true },
  merchantTransactionId: { type: String, required: true },
  provider: { type: String, enum: ['PHONEPE'], default: 'PHONEPE' },
  checkoutChannel: { type: String, enum: PHONEPE_CHECKOUT_CHANNELS },
  status: { type: String, enum: PAYMENT_INTENT_STATUSES, default: 'INITIATED' },
  providerOrderId: String,
  checkoutUrl: String,
  sdkToken: String,
  expiresAt: Date,
  idempotencyKey: { type: String, required: true },
  idempotencyScope: { type: String, enum: PHONEPE_IDEMPOTENCY_SCOPES, required: true },
  requestHash: { type: String, required: true },
  goldRateId: objectIdField('GoldRate', false),
  goldRatePerGramPaise: Number,
  goldWeightMg: { type: Number, min: 0 },
  goldPurity: { type: String, enum: ['916'] },
  /** Client-supplied month when present; omitted means backend resolved `schemeMonth`. */
  requestedSchemeMonth: { type: Number, min: 1, max: 11 },
  schemeMonth: { type: Number, min: 1, max: 11 },
  quoteCreatedAt: Date,
  quoteExpiresAt: Date,
  collectedBy: objectIdField('User', false),
  collectorRole: { type: String, enum: ROLES, default: 'CUSTOMER' },
  createdBy: objectIdField('User'),
  lastStatusCheckedAt: Date,
  nextStatusCheckAt: { type: Date, index: true },
  statusCheckAttempts: { type: Number, default: 0 },
  recoveryLockedAt: Date,
  recoveryLockUntil: Date,
  recoveryLockedBy: String,
  providerLaunchLockedAt: Date,
  providerLaunchLockUntil: Date,
  providerLaunchLockedBy: String,
  lastGatewayError: String,
  finalStatusSource: { type: String, enum: PAYMENT_FINAL_STATUS_SOURCES },
  providerCompletedAt: Date,
  confirmedAt: Date,
  wasLateConfirmation: { type: Boolean, default: false },
  confirmationDelaySeconds: Number,
  /**
   * `PHONEPE:<schemeId>:<schemeMonth>` while this intent holds the only live
   * PhonePe attempt for that installment. Present only while status is one of
   * INITIATED / PROVIDER_CREATING / PROVIDER_CREATE_UNCERTAIN / PENDING;
   * removed (never set to null — sparse index requires absence) once the
   * attempt reaches a definitively terminal state. Enforced by the unique
   * sparse index below so at most one live attempt can exist per installment
   * regardless of idempotency key.
   */
  activeAttemptKey: { type: String },
});

paymentIntentSchema.index(
  { merchantTransactionId: 1 },
  { unique: true, name: 'PAYMENT_INTENT_MERCHANT_TXN_UNIQUE' },
);
paymentIntentSchema.index(
  { customerId: 1, idempotencyScope: 1, idempotencyKey: 1 },
  { unique: true, name: 'PAYMENT_INTENT_IDEMPOTENCY_UNIQUE' },
);
paymentIntentSchema.index({ createdAt: -1 });
paymentIntentSchema.index({ status: 1, createdAt: -1 });
paymentIntentSchema.index(
  { status: 1, nextStatusCheckAt: 1, recoveryLockUntil: 1 },
  { name: 'PAYMENT_INTENT_RECOVERY' },
);
paymentIntentSchema.index(
  { activeAttemptKey: 1 },
  { unique: true, sparse: true, name: 'PAYMENT_INTENT_ACTIVE_ATTEMPT_UNIQUE' },
);

export const PaymentIntent = registerModel('PaymentIntent', paymentIntentSchema);
