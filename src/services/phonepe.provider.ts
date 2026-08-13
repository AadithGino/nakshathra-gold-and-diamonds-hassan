import { createHash, timingSafeEqual } from 'node:crypto';
import { env } from '../config/env.js';
import { AppError } from '../utils/AppError.js';
import { paiseFromUnknown } from '../utils/money.js';
import type {
  CheckoutRequest,
  CheckoutResponse,
  GatewayRefundStatus,
  GatewayStatus,
  PaymentGatewayProvider,
  RefundRequest,
  SdkOrderRequest,
  SdkOrderResponse,
  VerifiedGatewayWebhook,
} from './payment-gateway.js';

export class PhonePeProvider implements PaymentGatewayProvider {
  private token?: { value: string; expiresAt: number };
  private get base() {
    return env.PHONEPE_ENV === 'PRODUCTION'
      ? 'https://api.phonepe.com/apis/pg'
      : 'https://api-preprod.phonepe.com/apis/pg-sandbox';
  }
  private get authUrl() {
    return env.PHONEPE_ENV === 'PRODUCTION'
      ? 'https://api.phonepe.com/apis/identity-manager/v1/oauth/token'
      : 'https://api-preprod.phonepe.com/apis/pg-sandbox/v1/oauth/token';
  }
  private ensureEnabled() {
    if (!env.PHONEPE_ENABLED)
      throw new AppError('PAYMENT_GATEWAY_DISABLED', 'Online payment is not enabled', 503);
  }
  private async accessToken() {
    this.ensureEnabled();
    if (this.token && this.token.expiresAt > Date.now() + 60_000) return this.token.value;
    const body = new URLSearchParams({
      client_id: env.PHONEPE_CLIENT_ID,
      client_version: String(env.PHONEPE_CLIENT_VERSION),
      client_secret: env.PHONEPE_CLIENT_SECRET,
      grant_type: 'client_credentials',
    });
    const response = await fetch(this.authUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body,
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok)
      throw new AppError(
        'GATEWAY_AUTHENTICATION_FAILED',
        'Payment gateway authentication failed',
        502,
        true,
      );
    const data = (await response.json()) as any;
    this.token = { value: data.access_token, expiresAt: Number(data.expires_at) * 1000 };
    return this.token.value;
  }
  private async request(path: string, init: RequestInit = {}) {
    const response = await fetch(`${this.base}${path}`, {
      ...init,
      headers: {
        authorization: `O-Bearer ${await this.accessToken()}`,
        'content-type': 'application/json',
        ...init.headers,
      },
      signal: AbortSignal.timeout(15_000),
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok)
      throw new AppError('GATEWAY_REQUEST_FAILED', 'Payment gateway request failed', 502, true, [
        { providerCode: (body as any).code, httpStatus: response.status },
      ]);
    return body as any;
  }
  async createSdkOrder(input: SdkOrderRequest): Promise<SdkOrderResponse> {
    const data = await this.request('/checkout/v2/sdk/order', {
      method: 'POST',
      body: JSON.stringify({
        merchantOrderId: input.merchantOrderId,
        amount: input.amountPaise,
        expireAfter: input.expireAfterSeconds,
        paymentFlow: { type: 'PG_CHECKOUT' },
        metaInfo: { udf1: input.customerId, udf2: input.schemeId },
      }),
    });
    return {
      orderId: data.orderId,
      state: data.state,
      token: data.token,
      expiresAt: new Date(Number(data.expireAt ?? data.expiryAt)),
    };
  }
  async createPayment(input: CheckoutRequest): Promise<CheckoutResponse> {
    const data = await this.request('/checkout/v2/pay', {
      method: 'POST',
      body: JSON.stringify({
        merchantOrderId: input.merchantOrderId,
        amount: input.amountPaise,
        expireAfter: input.expireAfterSeconds,
        paymentFlow: { type: 'PG_CHECKOUT', merchantUrls: { redirectUrl: input.redirectUrl } },
        prefillUserLoginDetails: { phoneNumber: input.customerPhone },
        disablePaymentRetry: false,
        metaInfo: { udf1: input.customerId, udf2: input.schemeId },
      }),
    });
    return {
      providerOrderId: data.orderId,
      state: data.state,
      redirectUrl: data.redirectUrl,
      expiresAt: new Date(Number(data.expireAt)),
    };
  }

  /** Extract PhonePe's own completion timestamp from a verified status response. Never invents one. */
  private extractCompletedAt(data: any): Date | undefined {
    if (!data || typeof data !== 'object') return undefined;
    const candidates: unknown[] = [];
    if (data.completedAt != null) candidates.push(data.completedAt);
    const detail = Array.isArray(data.paymentDetails)
      ? data.paymentDetails.find((x: any) => String(x?.state ?? '').toUpperCase() === 'COMPLETED')
      : undefined;
    if (detail?.completedAt != null) candidates.push(detail.completedAt);
    if (detail?.timestamp != null) candidates.push(detail.timestamp);
    for (const candidate of candidates) {
      const asNumber = typeof candidate === 'number' ? candidate : Number(candidate);
      if (Number.isFinite(asNumber) && asNumber > 0) {
        // PhonePe often uses epoch millis; treat small values as seconds.
        const ms = asNumber < 1_000_000_000_000 ? asNumber * 1000 : asNumber;
        const date = new Date(ms);
        if (!Number.isNaN(date.getTime())) return date;
      }
      if (typeof candidate === 'string') {
        const date = new Date(candidate);
        if (!Number.isNaN(date.getTime())) return date;
      }
    }
    return undefined;
  }

  async checkStatus(merchantOrderId: string): Promise<GatewayStatus> {
    const data = await this.request(
      `/checkout/v2/order/${encodeURIComponent(merchantOrderId)}/status`,
    );
    const state =
      data.state === 'COMPLETED' ? 'SUCCESS' : data.state === 'FAILED' ? 'FAILED' : 'PENDING';
    return {
      state,
      amountPaise: paiseFromUnknown(data.amount, 'Gateway amount'),
      transactionId: data.paymentDetails?.find((x: any) => x.state === 'COMPLETED')?.transactionId,
      providerCompletedAt: this.extractCompletedAt(data),
      raw: data,
    };
  }

  private mapRefundState(state: unknown): GatewayRefundStatus['state'] {
    const normalized = String(state ?? '').toUpperCase();
    if (normalized === 'COMPLETED' || normalized === 'SUCCESS') return 'SUCCESS';
    if (normalized === 'FAILED') return 'FAILED';
    return 'PENDING';
  }

  private extractRefundRail(data: any): {
    railType?: string;
    bankReferenceId?: string;
    providerTransactionId?: string;
  } {
    const topRail = data?.rail && typeof data.rail === 'object' ? data.rail : null;
    const detail = Array.isArray(data?.paymentDetails)
      ? data.paymentDetails.find((x: any) => x?.rail)
      : null;
    const detailRail =
      detail?.rail && typeof detail.rail === 'object'
        ? detail.rail
        : detail?.rail
          ? { type: detail.rail }
          : null;
    const rail = topRail ?? detailRail;

    const railType =
      (rail?.type ? String(rail.type) : undefined) ??
      (typeof detail?.rail === 'string' ? detail.rail : undefined) ??
      (data.railType ? String(data.railType) : undefined);

    // Prefer documented bank references only — never treat generic PhonePe transactionId as UTR.
    const bankReferenceId =
      (rail?.utr ? String(rail.utr) : undefined) ??
      (rail?.upiTransactionId ? String(rail.upiTransactionId) : undefined) ??
      (rail?.arn ? String(rail.arn) : undefined) ??
      (data.bankReferenceId ? String(data.bankReferenceId) : undefined) ??
      (data.utr ? String(data.utr) : undefined) ??
      (data.arn ? String(data.arn) : undefined);

    const providerTransactionId =
      (detail?.transactionId ? String(detail.transactionId) : undefined) ??
      (data.transactionId ? String(data.transactionId) : undefined);

    return { railType, bankReferenceId, providerTransactionId };
  }

  private toRefundStatus(data: any): GatewayRefundStatus {
    const rail = this.extractRefundRail(data);
    return {
      state: this.mapRefundState(data.state),
      amountPaise: paiseFromUnknown(data.amount ?? data.refundAmount, 'Refund amount'),
      providerRefundId: data.refundId ? String(data.refundId) : undefined,
      bankReferenceId: rail.bankReferenceId,
      railType: rail.railType,
      errorCode: data.errorCode ? String(data.errorCode) : undefined,
      detailedErrorCode: data.detailedErrorCode ? String(data.detailedErrorCode) : undefined,
      raw: {
        ...data,
        _mapped: {
          providerTransactionId: rail.providerTransactionId,
          bankReferenceId: rail.bankReferenceId,
          railType: rail.railType,
        },
      },
    };
  }

  async initiateRefund(input: RefundRequest): Promise<GatewayRefundStatus> {
    const data = await this.request('/payments/v2/refund', {
      method: 'POST',
      body: JSON.stringify({
        merchantRefundId: input.merchantRefundId,
        originalMerchantOrderId: input.originalMerchantOrderId,
        amount: input.amountPaise,
      }),
    });
    return this.toRefundStatus(data);
  }

  async checkRefundStatus(merchantRefundId: string): Promise<GatewayRefundStatus> {
    const data = await this.request(
      `/payments/v2/refund/${encodeURIComponent(merchantRefundId)}/status`,
    );
    return this.toRefundStatus(data);
  }

  verifyWebhook(authorization: string | undefined, rawBody: Buffer): VerifiedGatewayWebhook {
    this.ensureEnabled();
    const expected = createHash('sha256')
      .update(`${env.PHONEPE_WEBHOOK_USERNAME}:${env.PHONEPE_WEBHOOK_PASSWORD}`)
      .digest('hex');
    const actual = (authorization ?? '').replace(/^SHA256\s+/i, '').trim();
    if (
      actual.length !== expected.length ||
      !timingSafeEqual(Buffer.from(actual), Buffer.from(expected))
    )
      throw new AppError('GATEWAY_VERIFICATION_FAILED', 'Invalid webhook authorization', 401);
    let raw: any;
    try {
      raw = JSON.parse(rawBody.toString('utf8'));
    } catch {
      throw new AppError('INVALID_WEBHOOK', 'Malformed webhook body', 400);
    }
    // `event`, not the deprecated `type`, is the routing field.
    const event = String(raw.event ?? raw.type ?? '');
    const payload = raw.payload ?? {};

    if (event.startsWith('checkout.order.')) {
      return {
        kind: 'PAYMENT',
        event,
        merchantOrderId: String(payload.merchantOrderId ?? payload.originalMerchantOrderId ?? ''),
        amountPaise: paiseFromUnknown(payload.amount, 'Webhook amount'),
        state: String(payload.state),
        transactionId: payload.paymentDetails?.find((x: any) => x.state === 'COMPLETED')
          ?.transactionId,
        raw,
      };
    }

    if (event.startsWith('pg.refund.')) {
      return {
        kind: 'REFUND',
        event,
        merchantRefundId: String(payload.merchantRefundId ?? ''),
        originalMerchantOrderId: String(payload.originalMerchantOrderId ?? ''),
        amountPaise: paiseFromUnknown(payload.amount ?? payload.refundAmount, 'Webhook amount'),
        state: String(payload.state),
        providerRefundId: payload.refundId ? String(payload.refundId) : undefined,
        raw,
      };
    }

    // Authenticated but unrecognized — record safely, never crash, never
    // treat as a financial success.
    return { kind: 'UNKNOWN', event, raw };
  }
}
export const phonePeProvider = new PhonePeProvider();
