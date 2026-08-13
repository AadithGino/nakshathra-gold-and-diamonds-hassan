import { z } from 'zod';
import { GATEWAY_SETTLEMENT_SOURCES } from '../models/enums.js';

const nonNegInt = z.number().int().min(0);
const signedInt = z.number().int();

export const createGatewaySettlementSchema = z
  .object({
    settlementId: z.string().trim().min(3).max(120),
    periodFrom: z.coerce.date(),
    periodTo: z.coerce.date(),
    settlementDate: z.coerce.date(),
    grossCollectionPaise: nonNegInt,
    refundDeductionPaise: nonNegInt.default(0),
    chargebackDeductionPaise: nonNegInt.default(0),
    gatewayFeePaise: nonNegInt.default(0),
    gatewayFeeGstPaise: nonNegInt.default(0),
    otherAdjustmentPaise: signedInt.default(0),
    netSettlementPaise: nonNegInt,
    providerUtr: z.string().trim().max(120).optional(),
    bankReferenceId: z.string().trim().max(120).optional(),
    source: z.enum(GATEWAY_SETTLEMENT_SOURCES),
    notes: z.string().trim().max(2000).optional(),
  })
  .superRefine((body, ctx) => {
    if (body.periodTo.getTime() < body.periodFrom.getTime()) {
      ctx.addIssue({
        code: 'custom',
        path: ['periodTo'],
        message: 'periodTo must be on or after periodFrom',
      });
    }
    const expected =
      body.grossCollectionPaise -
      body.refundDeductionPaise -
      body.chargebackDeductionPaise -
      body.gatewayFeePaise -
      body.gatewayFeeGstPaise +
      body.otherAdjustmentPaise;
    if (expected !== body.netSettlementPaise) {
      ctx.addIssue({
        code: 'custom',
        path: ['netSettlementPaise'],
        message: `netSettlementPaise must equal ${expected} (exact formula balance)`,
      });
    }
    if (expected < 0) {
      ctx.addIssue({
        code: 'custom',
        path: ['netSettlementPaise'],
        message: 'Computed net settlement cannot be negative',
      });
    }
  });

export const confirmGatewaySettlementSchema = z
  .object({
    providerUtr: z.string().trim().max(120).optional(),
    bankReferenceId: z.string().trim().max(120).optional(),
    bankCreditedAt: z.coerce.date(),
    notes: z.string().trim().max(2000).optional(),
  })
  .superRefine((body, ctx) => {
    if (!body.providerUtr && !body.bankReferenceId) {
      ctx.addIssue({
        code: 'custom',
        path: ['providerUtr'],
        message: 'providerUtr or bankReferenceId is required',
      });
    }
  });

export const closeGatewaySettlementSchema = z.object({
  notes: z.string().trim().max(2000).optional(),
});
