import { z } from 'zod';

export const createGoldInventoryMovementSchema = z.object({
  movementType: z.enum([
    'OPENING_STOCK',
    'PURCHASE',
    'RETURN_FROM_CUSTOMER',
    'POSITIVE_ADJUSTMENT',
    'NEGATIVE_ADJUSTMENT',
  ]),
  goldWeightMg: z.number().int().positive(),
  movementDate: z.coerce.date(),
  purity: z.literal('916').default('916'),
  referenceNumber: z.string().trim().max(120).optional(),
  reason: z.string().trim().min(3).max(1000),
});
