import { z } from 'zod';
import { paiseAmount } from '../utils/zod-money.js';

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
    settlementAsset: z.enum(['GOLD', 'CASH']).optional(),
    method: z.enum(['CASH', 'BANK', 'UPI']).optional(),
    idempotencyKey: z.string().min(8).max(120).optional(),
  })
  .strict();

export const correctionDecisionSchema = z.object({
  decision: z.enum(['APPROVED', 'REJECTED']),
  reviewNotes: z.string().trim().min(3).max(500),
});
