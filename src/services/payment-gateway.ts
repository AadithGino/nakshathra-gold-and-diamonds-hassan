export type CheckoutRequest = {
  merchantOrderId: string;
  amountPaise: number;
  redirectUrl: string;
  customerPhone: string;
  customerId: string;
  schemeId: string;
  /**
   * Authoritative provider order lifetime, in seconds. Always derived from
   * the locked gold-quote TTL by the caller (gateway.service.ts) so the
   * PhonePe order can never remain payable after the quote it was priced
   * against has expired. Must not be independently hard-coded per provider.
   */
  expireAfterSeconds: number;
};
export type CheckoutResponse = {
  providerOrderId: string;
  state: string;
  redirectUrl: string;
  expiresAt: Date;
};
export type SdkOrderRequest = {
  merchantOrderId: string;
  amountPaise: number;
  customerId: string;
  schemeId: string;
  /** See CheckoutRequest.expireAfterSeconds. */
  expireAfterSeconds: number;
};
export type SdkOrderResponse = {
  orderId: string;
  state: string;
  token: string;
  expiresAt: Date;
};
export type GatewayStatus = {
  state: 'PENDING' | 'SUCCESS' | 'FAILED';
  amountPaise: number;
  transactionId?: string;
  /** PhonePe's own reported completion time, when the provider supplies one. Never invented. */
  providerCompletedAt?: Date;
  raw: unknown;
};
export type RefundRequest = {
  merchantRefundId: string;
  originalMerchantOrderId: string;
  amountPaise: number;
};
export type GatewayRefundStatus = {
  state: 'PENDING' | 'SUCCESS' | 'FAILED';
  amountPaise: number;
  providerRefundId?: string;
  bankReferenceId?: string;
  railType?: string;
  errorCode?: string;
  detailedErrorCode?: string;
  raw: unknown;
};
export interface PaymentGatewayProvider {
  createPayment(input: CheckoutRequest): Promise<CheckoutResponse>;
  createSdkOrder(input: SdkOrderRequest): Promise<SdkOrderResponse>;
  checkStatus(merchantOrderId: string): Promise<GatewayStatus>;
  initiateRefund(input: RefundRequest): Promise<GatewayRefundStatus>;
  checkRefundStatus(merchantRefundId: string): Promise<GatewayRefundStatus>;
  verifyWebhook(authorization: string | undefined, rawBody: Buffer): VerifiedGatewayWebhook;
}

/**
 * PhonePe webhooks cover two structurally different event families —
 * `checkout.order.*` (payment) and `pg.refund.*` (refund) — and must never be
 * conflated: a payment payload has no `merchantRefundId`, a refund payload's
 * `originalMerchantOrderId` is not the refund's own identity. Anything else
 * authenticated-but-unrecognized is `UNKNOWN` and must be recorded without
 * any financial mutation, so a future PhonePe event type never crashes or is
 * silently treated as success.
 */
export type VerifiedPaymentWebhook = {
  kind: 'PAYMENT';
  event: string;
  merchantOrderId: string;
  amountPaise: number;
  state: string;
  transactionId?: string;
  raw: unknown;
};
export type VerifiedRefundWebhook = {
  kind: 'REFUND';
  event: string;
  merchantRefundId: string;
  originalMerchantOrderId: string;
  amountPaise: number;
  state: string;
  providerRefundId?: string;
  raw: unknown;
};
export type VerifiedUnknownWebhook = {
  kind: 'UNKNOWN';
  event: string;
  raw: unknown;
};
export type VerifiedGatewayWebhook =
  | VerifiedPaymentWebhook
  | VerifiedRefundWebhook
  | VerifiedUnknownWebhook;
