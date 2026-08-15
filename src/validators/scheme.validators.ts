import { z } from 'zod';
import { LIVE_SCHEME_TYPE, NAKSHATHRA_MINIMUM_PAYMENT_PAISE } from '../config/business.js';
import { CASH_SETTLEMENT_BASES, PAYMENT_WINDOW_TYPES, SETTLEMENT_ASSETS } from '../models/enums.js';
import { validatePaymentWindow, validateSettlementPolicy } from '../utils/payment-window.js';

const settlementAssetList = z.array(z.enum(SETTLEMENT_ASSETS)).min(1);

const paymentWindowFields = {
  paymentWindowType: z.enum(PAYMENT_WINDOW_TYPES).optional(),
  fixedPaymentDay: z.number().int().min(1).max(31).optional(),
  paymentWindowStartDay: z.number().int().min(1).max(31).optional(),
  paymentWindowEndDay: z.number().int().min(1).max(31).optional(),
};

const settlementPolicyFields = {
  prematureClosureEnabled: z.boolean().optional(),
  prematureClosureMinPaidInstallments: z.number().int().min(1).max(11).optional(),
  prematureClosureMinElapsedMonths: z.number().int().min(1).max(11).optional(),
  prematureClosureSettlementAssets: settlementAssetList.optional(),
  maturitySettlementAssets: settlementAssetList.optional(),
  prematureClosureCashBasis: z.enum(CASH_SETTLEMENT_BASES).optional(),
  maturityCashBasis: z.enum(CASH_SETTLEMENT_BASES).optional(),
};

const schemePlanFields = z.object({
  name: z.string().trim().min(2).max(120),
  type: z.literal(LIVE_SCHEME_TYPE).default(LIVE_SCHEME_TYPE),
  durationMonths: z.literal(11).default(11),
  minimumPaymentPaise: z.number().int().min(NAKSHATHRA_MINIMUM_PAYMENT_PAISE),
  termsText: z.string().min(5).max(10_000),
  benefitText: z.string().max(2_000).optional(),
  makingChargeBenefit: z.string().max(500).optional(),
  wastageBenefit: z.string().max(500).optional(),
  ...paymentWindowFields,
  ...settlementPolicyFields,
});

function addPlanConfigIssues(value: Partial<z.infer<typeof schemePlanFields>>, ctx: z.RefinementCtx) {
  const hasWindow =
    value.paymentWindowType != null ||
    value.fixedPaymentDay != null ||
    value.paymentWindowStartDay != null ||
    value.paymentWindowEndDay != null;
  const hasPolicy =
    value.prematureClosureEnabled != null ||
    value.prematureClosureMinPaidInstallments != null ||
    value.prematureClosureMinElapsedMonths != null ||
    value.prematureClosureSettlementAssets != null ||
    value.maturitySettlementAssets != null ||
    value.prematureClosureCashBasis != null ||
    value.maturityCashBasis != null;
  try {
    if (hasWindow || value.paymentWindowType != null) validatePaymentWindow(value);
    if (hasPolicy) validateSettlementPolicy(value);
  } catch (error: any) {
    ctx.addIssue({
      code: 'custom',
      message: error?.message ?? 'Invalid scheme plan configuration',
    });
  }
}

export const createSchemePlanSchema = schemePlanFields.superRefine((value, ctx) => {
  try {
    validatePaymentWindow(value);
    validateSettlementPolicy(value);
  } catch (error: any) {
    ctx.addIssue({
      code: 'custom',
      message: error?.message ?? 'Invalid scheme plan configuration',
    });
  }
});

export const updateSchemePlanSchema = schemePlanFields
  .partial()
  .extend({
    status: z.enum(['ACTIVE', 'INACTIVE']).optional(),
  })
  .superRefine(addPlanConfigIssues);

export const createEnrollmentSchema = z.object({
  customerId: z.string().min(1),
  schemePlanId: z.string().min(1),
  enrollmentNumber: z.string().trim().min(2).max(50).optional(),
  startDate: z.coerce.date(),
  monthlyInstallmentPaise: z.number().int().min(NAKSHATHRA_MINIMUM_PAYMENT_PAISE),
});

export const updateEnrollmentStatusSchema = z.object({
  status: z.enum(['ACTIVE', 'MATURED', 'REDEEMED', 'CLOSED', 'WITHDRAWN', 'CANCELLED']),
  reason: z.string().trim().min(3).max(500),
});

export const cancelEnrollmentSchema = z.object({
  reason: z.string().trim().min(3).max(500),
});

export const prematureCloseSchema = z.object({
  settlementAsset: z.enum(SETTLEMENT_ASSETS),
  payoutDate: z.coerce.date(),
  reason: z.string().trim().min(3).max(500),
  referenceNumber: z.string().max(120).optional(),
  notes: z.string().max(500).optional(),
  method: z.enum(['CASH', 'BANK', 'UPI']).optional(),
  idempotencyKey: z.string().min(8).max(120),
});

export const createGoldRateSchema = z.object({
  ratePerGramPaise: z.number().int().positive(),
  purity: z.literal('916').default('916'),
  effectiveFrom: z.coerce.date(),
  notes: z.string().max(500).optional(),
});

export const updateGoldRateSchema = createGoldRateSchema.partial().extend({
  status: z.enum(['ACTIVE', 'INACTIVE']).optional(),
});

export type CreateSchemePlanInput = z.infer<typeof createSchemePlanSchema>;
export type UpdateSchemePlanInput = z.infer<typeof updateSchemePlanSchema>;
export type CreateEnrollmentInput = z.infer<typeof createEnrollmentSchema>;
export type CreateGoldRateInput = z.infer<typeof createGoldRateSchema>;
export type UpdateGoldRateInput = z.infer<typeof updateGoldRateSchema>;
export type CancelEnrollmentInput = z.infer<typeof cancelEnrollmentSchema>;
export type PrematureCloseInput = z.infer<typeof prematureCloseSchema>;
