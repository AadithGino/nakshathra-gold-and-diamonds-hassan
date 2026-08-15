import { z } from 'zod';
import { NAKSHATHRA_MINIMUM_PAYMENT_PAISE } from '../config/business.js';

export const initiatePhonePeSchema = z.object({
  schemeId: z.string().min(1),
  amountPaise: z.number().int().min(NAKSHATHRA_MINIMUM_PAYMENT_PAISE),
  schemeMonth: z.number().int().min(1).max(11).optional(),
  idempotencyKey: z.string().min(8).max(120),
});
