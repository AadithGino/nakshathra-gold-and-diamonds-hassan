import { z } from "zod";
import { indianPhoneSchema, optionalIndianPhoneSchema } from "./phone.schema.js";

const aadhaarKeysSchema = z
  .object({
    frontKey: z.string().trim().min(1).max(500).optional(),
    backKey: z.string().trim().min(1).max(500).optional(),
  })
  .optional();

export const createCustomerSchema = z.object({
  name: z.string().trim().min(2).max(120),
  phone: indianPhoneSchema,
  password: z.string().min(10).max(128),
  address: z.record(z.string(), z.string()).optional(),
  aadhaar: aadhaarKeysSchema,
  nominee: z
    .object({
      name: z.string().trim().min(2).max(120),
      relationship: z.string().trim().min(2).max(50),
      phone: optionalIndianPhoneSchema,
    })
    .optional(),
  enrollment: z
    .object({
      schemePlanId: z.string().min(1),
      startDate: z.coerce.date(),
      monthlyInstallmentPaise: z.number().int().min(100_000),
    })
    .optional(),
});

const addressSchema = z
  .object({
    line1: z.string().max(200).optional(),
    line2: z.string().max(200).optional(),
    city: z.string().max(100).optional(),
    district: z.string().max(100).optional(),
    state: z.string().max(100).optional(),
    postalCode: z.string().max(20).optional(),
  })
  .optional();

export const updateCustomerSchema = z
  .object({
    name: z.string().trim().min(2).max(120).optional(),
    phone: optionalIndianPhoneSchema,
    address: addressSchema,
    aadhaar: aadhaarKeysSchema,
    status: z.enum(["ACTIVE", "INACTIVE"]).optional(),
    nominee: z
      .object({
        name: z.string().trim().min(2).max(120),
        relationship: z.string().trim().min(2).max(50),
        phone: optionalIndianPhoneSchema,
      })
      .optional(),
  })
  .refine(
    (value) => Object.keys(value).length > 0,
    "At least one field is required",
  );

export type CreateCustomerInput = z.infer<typeof createCustomerSchema>;
export type UpdateCustomerInput = z.infer<typeof updateCustomerSchema>;

export const rejectCustomerKycSchema = z.object({
  reason: z.string().trim().min(3).max(500),
});
export type RejectCustomerKycInput = z.infer<typeof rejectCustomerKycSchema>;
