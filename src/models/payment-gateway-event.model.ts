import { createSchema, registerModel, Schema } from './model-helpers.js';

const paymentGatewayEventSchema = createSchema({
  provider: { type: String, required: true },
  eventType: String,
  payloadHash: { type: String, required: true },
  merchantTransactionId: String,
  /** Refund-webhook identity — set only for pg.refund.* events. */
  merchantRefundId: String,
  originalMerchantOrderId: String,
  providerEventId: String,
  verified: { type: Boolean, required: true },
  processedAt: Date,
  processingError: String,
  rawPayload: { type: Schema.Types.Mixed, required: true },
});

paymentGatewayEventSchema.index(
  { payloadHash: 1 },
  { unique: true, name: 'PAYMENT_GATEWAY_EVENT_PAYLOAD_HASH_UNIQUE' },
);

export const PaymentGatewayEvent = registerModel('PaymentGatewayEvent', paymentGatewayEventSchema);
