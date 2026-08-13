import { z } from 'zod';

export const initiateRefundSchema = z.object({
  reason: z.string().trim().min(3).max(500),
  idempotencyKey: z.string().min(8).max(120),
  /** Rejected unless equal to the payment amount — partial refunds are not supported. */
  amountPaise: z.number().int().positive().optional(),
});

export const retryFailedRefundSchema = z.object({
  idempotencyKey: z.string().min(8).max(120),
  /** Defaults to the failed attempt's reason when omitted. */
  reason: z.string().trim().min(3).max(500).optional(),
  amountPaise: z.number().int().positive().optional(),
});
