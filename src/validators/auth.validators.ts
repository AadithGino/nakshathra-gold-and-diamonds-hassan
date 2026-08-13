import { z } from 'zod';
import { indianPhoneSchema } from './phone.schema.js';

export const loginSchema = z.object({
  phone: indianPhoneSchema,
  password: z.string().min(8).max(128),
});
