import { randomUUID } from 'node:crypto';
import type { Role } from '../models/enums.js';

/** Live Nakshathra scheme type. GOLD_WEIGHT remains modeled but dormant. */
export const LIVE_SCHEME_TYPE = 'CASH' as const;
export const DORMANT_SCHEME_TYPE = 'GOLD_WEIGHT' as const;

/** Live Nakshathra 6+5 CASH contribution contract. */
export const NAKSHATHRA_DURATION_MONTHS = 11 as const;
export const NAKSHATHRA_FLEXIBLE_MONTHS = 6 as const;
export const NAKSHATHRA_CAPPED_MONTHS = 5 as const;
export const NAKSHATHRA_REDEMPTION_MONTH = 12 as const;
export const NAKSHATHRA_CAP_STRATEGY = 'AVERAGE_SUCCESSFUL_PAYMENT_FIRST_6' as const;
export const NAKSHATHRA_CONTRIBUTION_POLICY_VERSION = 1 as const;

export const business = Object.freeze({
  displayName: 'Nakshathra Jewellers',
  serviceName: 'nakshathra-api',
  apiTitle: 'Nakshathra Jewellers Scheme API',
  receiptFooter: 'Thank you for saving with Nakshathra Jewellers.',
  timezone: 'Asia/Kolkata' as const,
  currency: 'INR' as const,
  receiptPrefix: 'NKS',
  enrollmentPrefix: 'NKS-ENR',
  customerPrefix: 'NKS-C',
  transactionPrefix: 'NKS',
  enabledSchemeTypes: [LIVE_SCHEME_TYPE] as const,
  enabledRoles: ['ADMIN', 'STAFF', 'CUSTOMER'] as const satisfies readonly Role[],
});

export const PORTAL_ROLES: readonly Role[] = business.enabledRoles;

export const LEGACY_KAIRALI_BUSINESS_NAME = 'Kairali Gold & Diamonds';
export const LEGACY_KAIRALI_RECEIPT_FOOTER = 'Thank you for saving with Kairali Gold & Diamonds.';

export function isLiveSchemeType(type: string | undefined | null): type is typeof LIVE_SCHEME_TYPE {
  return type === LIVE_SCHEME_TYPE;
}

export function isGoldWeightEnabled() {
  return (business.enabledSchemeTypes as readonly string[]).includes(DORMANT_SCHEME_TYPE);
}

export function isCashSchemeType(type: string | undefined | null) {
  return type === LIVE_SCHEME_TYPE;
}

export function formatReceiptNumber(year: number, value: number) {
  return `${business.receiptPrefix}-${year}-${String(value).padStart(7, '0')}`;
}

export function formatEnrollmentNumber(year: number, value: number) {
  return `${business.enrollmentPrefix}-${year}-${String(value).padStart(6, '0')}`;
}

export function formatCustomerCode(value: number) {
  return `${business.customerPrefix}${String(value).padStart(6, '0')}`;
}

export function formatMerchantTransactionId(
  now = Date.now(),
  nonce = randomUUID().slice(0, 8),
) {
  return `${business.transactionPrefix}-${now}-${nonce}`;
}

export function customerCodeFloorRegex() {
  const prefix = business.customerPrefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^(?:${prefix})?\\d+$`);
}
