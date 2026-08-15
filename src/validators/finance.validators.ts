import { z } from 'zod';
import { paiseAmount } from '../utils/zod-money.js';
import { SETTLEMENT_ASSETS } from '../models/enums.js';

export const manualPaymentSchema = z.object({
  customerId: z.string().min(1),
  schemeId: z.string().min(1),
  amountPaise: paiseAmount(),
  schemeMonth: z.number().int().min(1).max(11).optional(),
  method: z.enum(['CASH', 'UPI', 'BANK', 'CARD']),
  paymentDate: z.coerce.date(),
  referenceNumber: z.string().max(120).optional(),
  notes: z.string().max(500).optional(),
  idempotencyKey: z.string().min(8).max(120),
});

export const reversePaymentSchema = z.object({
  reason: z.string().trim().min(5).max(500),
});

export const cashSubmissionSchema = z.object({
  staffId: z.string().min(1),
  amountPaise: paiseAmount(),
  submissionDate: z.coerce.date(),
  notes: z.string().max(500).optional(),
});

const settlementBase = {
  customerId: z.string().min(1),
  schemeId: z.string().min(1),
  payoutDate: z.coerce.date(),
  referenceNumber: z.string().max(120).optional(),
  notes: z.string().max(500).optional(),
};

export const payoutSchema = z
  .object({
    ...settlementBase,
    payoutType: z.enum(['PAYOUT', 'REDEEM']),
    settlementAsset: z.enum(SETTLEMENT_ASSETS).optional(),
    method: z.enum(['CASH', 'BANK', 'UPI']).optional(),
    idempotencyKey: z.string().min(8).max(120).optional(),
    billNumber: z.string().trim().min(1).max(80).optional(),
    billAmountPaise: z.number().int().positive().optional(),
    extraPaymentMethod: z.enum(['CASH', 'UPI', 'CARD', 'BANK']).optional(),
    extraPaymentReference: z.string().trim().min(1).max(120).optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.settlementAsset === 'JEWELLERY') {
      if (!value.billNumber) {
        ctx.addIssue({
          code: 'custom',
          path: ['billNumber'],
          message: 'billNumber is required for jewellery settlement',
        });
      }
      if (value.billAmountPaise == null) {
        ctx.addIssue({
          code: 'custom',
          path: ['billAmountPaise'],
          message: 'billAmountPaise is required for jewellery settlement',
        });
      }
    }
  });

export const correctionDecisionSchema = z.object({
  decision: z.enum(['APPROVED', 'REJECTED']),
  reviewNotes: z.string().trim().min(3).max(500),
});
