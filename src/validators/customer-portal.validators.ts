import { z } from 'zod';
import { NAKSHATHRA_MINIMUM_PAYMENT_PAISE } from '../config/business.js';

export const customerPaymentPreviewQuerySchema = z.object({
  amountPaise: z.coerce.number().int().min(NAKSHATHRA_MINIMUM_PAYMENT_PAISE),
  schemeMonth: z.coerce.number().int().min(1).max(11).optional(),
});
