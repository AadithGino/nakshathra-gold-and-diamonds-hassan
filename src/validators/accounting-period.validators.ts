import { z } from 'zod';

export const closeAccountingPeriodSchema = z.object({
  closeNotes: z.string().trim().max(2000).optional(),
  overrideReason: z.string().trim().min(3).max(2000).optional(),
});

export const reopenAccountingPeriodSchema = z.object({
  reason: z.string().trim().min(3).max(2000),
});
