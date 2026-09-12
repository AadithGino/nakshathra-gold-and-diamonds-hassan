import { z } from 'zod';

export const maturityCalendarQuerySchema = z.object({
  from: z.string().trim().min(1).optional(),
  to: z.string().trim().min(1).optional(),
  status: z.enum(['ACTIVE', 'MATURED', 'REDEEMED', 'CLOSED']).optional(),
  schemeType: z.enum(['CASH', 'GOLD_WEIGHT']).optional(),
});

export const adminPaymentPreviewQuerySchema = z.object({
  amountPaise: z.coerce.number().int().positive(),
  paymentDate: z.coerce.date().optional(),
  schemeMonth: z.coerce.number().int().min(1).max(11).optional(),
});
