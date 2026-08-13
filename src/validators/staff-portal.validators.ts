import { z } from 'zod';
import { paiseAmount } from '../utils/zod-money.js';

export const paymentPreviewQuerySchema = z.object({
  amountPaise: z.coerce.number().int().positive(),
});

export const staffPaymentSchema = z.object({
  customerId: z.string().min(1),
  schemeId: z.string().min(1),
  amountPaise: paiseAmount(),
  method: z.enum(['CASH', 'UPI', 'BANK', 'CARD']),
  paymentDate: z.coerce.date(),
  referenceNumber: z.string().max(120).optional(),
  notes: z.string().max(500).optional(),
  idempotencyKey: z.string().min(8).max(120),
});

export const staffPhonePeInitiateSchema = z.object({
  customerId: z.string().min(1),
  schemeId: z.string().min(1),
  amountPaise: z.number().int().min(100),
  idempotencyKey: z.string().min(8).max(120),
});

export const correctionRequestSchema = z.object({
  correctionType: z.enum([
    'CHANGE_AMOUNT',
    'CHANGE_METHOD',
    'CHANGE_REFERENCE',
    'CHANGE_NOTES',
    'REVERSE_PAYMENT',
  ]),
  requestedChanges: z.record(z.string(), z.unknown()).optional(),
  reason: z.string().trim().min(5).max(500),
});
