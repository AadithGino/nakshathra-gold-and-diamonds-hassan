import { business } from './business.js';

const staffSecurity = [{ cookieAuth: [] }];

export const openapi = {
  openapi: '3.1.0',
  info: {
    title: business.apiTitle,
    version: '1.0.0',
    description:
      'Nakshathra Jewellers live API. Current live product is CASH schemes only. GOLD_WEIGHT creation, contribution, and redemption are disabled/dormant and are not part of the live Nakshathra product.',
  },
  servers: [{ url: '/api/v1' }],
  components: {
    securitySchemes: { cookieAuth: { type: 'apiKey', in: 'cookie', name: 'access_token' } },
    schemas: {
      Error: {
        type: 'object',
        properties: {
          success: { const: false },
          error: { type: 'object' },
          requestId: { type: 'string' },
        },
      },
    },
  },
  paths: {
    '/auth/login': { post: { summary: 'Admin, staff, or customer secure login' } },
    '/auth/me': { get: { summary: 'Current authenticated session' } },
    '/admin/dashboard': {
      get: { summary: 'Admin financial dashboard', security: staffSecurity },
    },
    '/admin/staff': {
      get: { summary: 'List staff', security: staffSecurity },
      post: { summary: 'Create staff with granular permissions', security: staffSecurity },
    },
    '/admin/staff/{id}': {
      get: { summary: 'Staff detail, collection summary, cash held, and correction history', security: staffSecurity },
      patch: { summary: 'Update staff profile or permissions', security: staffSecurity },
    },
    '/admin/users/{id}/status': {
      patch: { summary: 'Enable or disable a staff or customer user', security: staffSecurity },
    },
    '/admin/users/{id}/reset-password': {
      post: { summary: 'Reset staff or customer credentials', security: staffSecurity },
    },
    '/admin/customers': {
      get: { summary: 'Search and list customers', security: staffSecurity },
      post: { summary: 'Create a customer', security: staffSecurity },
    },
    '/admin/enrollments': {
      get: { summary: 'List enrollments', security: staffSecurity },
      post: { summary: 'Enroll a verified customer on a live CASH plan', security: staffSecurity },
    },
    '/admin/payments/manual': {
      post: {
        summary:
          'Owner manual collection. schemeMonth is derived server-side in Asia/Kolkata and is not client-authoritative.',
        security: staffSecurity,
      },
    },
    '/admin/payments': {
      get: { summary: 'List payments', security: staffSecurity },
    },
    '/admin/corrections': {
      get: { summary: 'List payment correction requests', security: staffSecurity },
    },
    '/admin/corrections/{id}': {
      patch: { summary: 'Approve or reject a staff correction request', security: staffSecurity },
    },
    '/admin/cash-held': {
      get: { summary: 'Staff cash held balances', security: staffSecurity },
    },
    '/admin/cash-submissions': {
      get: { summary: 'Cash handover history', security: staffSecurity },
      post: { summary: 'Record a staff cash handover', security: staffSecurity },
    },
    '/admin/payouts': {
      get: { summary: 'List CASH payouts and GOLD_WEIGHT redemptions', security: staffSecurity },
      post: {
        summary: 'CASH or JEWELLERY maturity PAYOUT (live) or GOLD_WEIGHT REDEEM (dormant)',
        security: staffSecurity,
      },
    },
    '/admin/enrollments/{id}/premature-close': {
      post: { summary: 'Premature CASH closure at contribution value', security: staffSecurity },
    },
    '/admin/reports/collection': {
      get: { summary: 'Collection report with payment-method breakdown', security: staffSecurity },
    },
    '/admin/reports/daily-collection': {
      get: { summary: 'Daily collections using Asia/Kolkata business dates', security: staffSecurity },
    },
    '/admin/reports/monthly-collection': {
      get: { summary: 'Monthly collections using Asia/Kolkata business months', security: staffSecurity },
    },
    '/admin/reports/scheme-collection': {
      get: { summary: 'Scheme-plan collection totals', security: staffSecurity },
    },
    '/admin/reports/attribution': {
      get: { summary: 'Customer self-payment vs staff-collected totals', security: staffSecurity },
    },
    '/admin/reports/staff-performance': {
      get: { summary: 'Staff-wise collection and cash held', security: staffSecurity },
    },
    '/admin/reports/corrections': {
      get: { summary: 'Correction request status and history', security: staffSecurity },
    },
    '/admin/reports/payout-totals': {
      get: { summary: 'Payout and premature-closure totals', security: staffSecurity },
    },
    '/admin/audit-logs': {
      get: { summary: 'Audit records', security: staffSecurity },
    },
    '/staff/dashboard': {
      get: { summary: 'Staff dashboard', security: staffSecurity },
    },
    '/staff/customers': {
      get: { summary: 'Staff customer search', security: staffSecurity },
      post: { summary: 'Staff customer creation when permitted', security: staffSecurity },
    },
    '/staff/enrollments': {
      post: { summary: 'Staff enrollment when permitted', security: staffSecurity },
    },
    '/staff/schemes/{id}/payment-preview': {
      get: { summary: 'Authoritative payment preview for staff collection', security: staffSecurity },
    },
    '/staff/payments': {
      get: { summary: 'Own staff collections', security: staffSecurity },
      post: { summary: 'Staff manual collection', security: staffSecurity },
    },
    '/staff/payments/phonepe': {
      post: { summary: 'Staff PhonePe web checkout for a customer', security: staffSecurity },
    },
    '/staff/payments/phonepe/create-order': {
      post: { summary: 'Staff PhonePe SDK order for a customer', security: staffSecurity },
    },
    '/staff/cash-held': {
      get: { summary: 'Own cash held', security: staffSecurity },
    },
    '/staff/cash-submissions': {
      get: { summary: 'Own cash handover history', security: staffSecurity },
    },
    '/staff/payments/{id}/corrections': {
      post: {
        summary:
          'Submit a correction request for an own collection. Allowed types: CHANGE_AMOUNT, CHANGE_METHOD, CHANGE_REFERENCE, CHANGE_NOTES, REVERSE_PAYMENT. CHANGE_DATE is not allowed.',
        security: staffSecurity,
      },
    },
    '/staff/corrections': {
      get: { summary: 'Own correction requests', security: staffSecurity },
    },
    '/admin/gold-rates': {
      get: {
        summary: 'List authorised gold rates used for jewellery settlement valuation',
        security: staffSecurity,
      },
      post: {
        summary: 'Publish an authorised gold rate for jewellery settlement valuation',
        security: staffSecurity,
      },
    },
    '/customer/gold-rates': {
      get: {
        summary: 'Customer gold rates. Dormant while GOLD_WEIGHT is disabled.',
        security: staffSecurity,
      },
    },
    '/customer/home': {
      get: { summary: 'Customer-owned home data', security: staffSecurity },
    },
    '/customer/payments/phonepe': {
      post: {
        summary: 'Initiate PhonePe checkout for owned scheme',
        security: staffSecurity,
      },
    },
    '/customer/payments/phonepe/create-order': {
      post: {
        summary: 'Create PhonePe SDK order token for Flutter/mobile checkout',
        security: staffSecurity,
      },
    },
    '/webhooks/phonepe': { post: { summary: 'Verified PhonePe webhook' } },
    '/payments/phonepe/config': {
      get: {
        summary:
          'PhonePe client credentials and SDK init config for authenticated customer, staff, or admin apps',
        security: staffSecurity,
      },
    },
  },
};
