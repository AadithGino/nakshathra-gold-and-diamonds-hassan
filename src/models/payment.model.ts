import { createSchema, objectIdField, registerModel, Schema } from './model-helpers.js';
import { PAYMENT_METHODS, PAYMENT_REFUND_STATUSES, PAYMENT_STATUSES, ROLES } from './enums.js';

const paymentSchema = createSchema({
  customerId: { ...objectIdField('Customer'), index: true },
  schemeId: { ...objectIdField('SchemeEnrollment'), index: true },
  amountPaise: { type: Number, required: true, min: 1 },
  method: { type: String, enum: PAYMENT_METHODS, required: true, index: true },
  status: { type: String, enum: PAYMENT_STATUSES, required: true, index: true },
  paymentDate: { type: Date, required: true, index: true },
  /**
   * Operational accounting period assignment. May differ from paymentDate when
   * a PhonePe success is recognized after that provider period has closed.
   */
  accountingDate: { type: Date, index: true },
  schemeMonth: { type: Number, required: true, min: 1 },
  receiptNumber: { type: String },
  referenceNumber: String,
  notes: String,
  collectedBy: objectIdField('User', false),
  collectorRole: { type: String, enum: ROLES, required: true },
  supersedesPaymentId: objectIdField('Payment', false),
  correctionId: objectIdField('PaymentCorrection', false),
  merchantTransactionId: { type: String },
  providerTransactionId: { type: String },
  idempotencyKey: String,
  goldRateId: objectIdField('GoldRate', false),
  goldRatePerGramPaise: Number,
  goldPurity: String,
  goldWeightMg: { type: Number, min: 0 },
  reversedAt: Date,
  reversedBy: objectIdField('User', false),
  reversalReason: String,
  originalSnapshot: Schema.Types.Mixed,
  refundId: objectIdField('Refund', false),
  refundStatus: { type: String, enum: PAYMENT_REFUND_STATUSES },
  refundRequestedAt: Date,
  refundedAt: Date,
  /** PhonePe's own reported completion time (Phase 4 accounting groundwork; not yet used for period assignment). */
  providerCompletedAt: Date,
  /** Backend time at which this payment's successful state was accepted. */
  recognizedAt: Date,
  createdBy: objectIdField('User'),
  updatedBy: objectIdField('User', false),
});

paymentSchema.index({ schemeId: 1, schemeMonth: 1, status: 1 });
paymentSchema.index(
  { schemeId: 1, schemeMonth: 1 },
  {
    unique: false,
    name: 'PAYMENT_SUCCESS_SCHEME_MONTH',
    partialFilterExpression: { status: 'SUCCESS' },
  },
);
paymentSchema.index(
  { merchantTransactionId: 1 },
  { unique: true, sparse: true, name: 'PAYMENT_MERCHANT_TXN_UNIQUE' },
);
paymentSchema.index(
  { providerTransactionId: 1 },
  { unique: true, sparse: true, name: 'PAYMENT_PROVIDER_TXN_UNIQUE' },
);
paymentSchema.index(
  { receiptNumber: 1 },
  { unique: true, sparse: true, name: 'PAYMENT_RECEIPT_NUMBER_UNIQUE' },
);
paymentSchema.index({ collectedBy: 1, method: 1, status: 1 });
paymentSchema.index(
  { collectedBy: 1, paymentDate: -1 },
  { name: 'PAYMENT_COLLECTOR_DATE' },
);
paymentSchema.index({ customerId: 1, paymentDate: -1 });
paymentSchema.index({ accountingDate: 1, status: 1 });

export const Payment = registerModel('Payment', paymentSchema);
