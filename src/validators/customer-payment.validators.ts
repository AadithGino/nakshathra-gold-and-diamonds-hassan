import { z } from 'zod';

export const initiatePhonePeSchema = z.object({
  schemeId: z.string().min(1),
  amountPaise: z.number().int().min(100_000),
  schemeMonth: z.number().int().min(1).max(11).optional(),
  idempotencyKey: z.string().min(8).max(120),
});
