import { z } from 'zod';

export const updateSettingsSchema = z.object({
  businessName: z.string().trim().min(2).max(120),
  supportPhone: z.string().trim().max(30),
  supportEmail: z.union([z.literal(''), z.string().email().max(160)]),
  businessAddress: z.string().trim().max(1_000),
  receiptFooter: z.string().trim().max(500),
  customerPhonePeEnabled: z.boolean(),
});

export type UpdateSettingsInput = z.infer<typeof updateSettingsSchema>;
