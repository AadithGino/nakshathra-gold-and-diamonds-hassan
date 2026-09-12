import { z } from 'zod';

export const adminPaymentPreviewQuerySchema = z.object({
  amountPaise: z.coerce.number().int().positive(),
  paymentDate: z.coerce.date().optional(),
  schemeMonth: z.coerce.number().int().min(1).max(11).optional(),
});
