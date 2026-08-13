import { z } from 'zod';
import { indianPhoneSchema, optionalIndianPhoneSchema } from './phone.schema.js';

export const staffPermissions = z.enum([
  'canCreateCustomer',
  'canEnrollScheme',
  'canCollectPayment',
  'canViewCustomers',
  'canSubmitCorrectionRequest',
]);

export const createStaffSchema = z.object({
  name: z.string().trim().min(2).max(120),
  phone: indianPhoneSchema,
  password: z.string().min(10).max(128),
  employeeCode: z.string().trim().min(2).max(30),
  permissions: z.array(staffPermissions).default([]),
  notes: z.string().max(500).optional(),
});

export const updateStaffSchema = z
  .object({
    name: z.string().trim().min(2).max(120).optional(),
    phone: optionalIndianPhoneSchema,
    employeeCode: z.string().trim().min(2).max(30).optional(),
    permissions: z.array(staffPermissions).optional(),
    notes: z.string().max(500).optional(),
  })
  .refine((value) => Object.keys(value).length > 0, 'At least one field is required');

export const updateUserStatusSchema = z.object({
  status: z.enum(['ACTIVE', 'INACTIVE']),
});

export const resetPasswordSchema = z.object({
  newPassword: z.string().min(10).max(128),
});

export type CreateStaffInput = z.infer<typeof createStaffSchema>;
export type UpdateStaffInput = z.infer<typeof updateStaffSchema>;
