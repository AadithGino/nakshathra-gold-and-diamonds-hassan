import { z } from 'zod';

export const customerPaymentPreviewQuerySchema = z.object({
  amountPaise: z.coerce.number().int().min(100_000),
  schemeMonth: z.coerce.number().int().min(1).max(11).optional(),
});
