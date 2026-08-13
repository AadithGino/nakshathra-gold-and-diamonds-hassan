import { z } from 'zod';
import {
  DISPUTE_DETECTED_VIA,
  DISPUTE_STATUSES,
  FINANCIAL_EXCEPTION_AGING_BUCKETS,
  FINANCIAL_EXCEPTION_SEVERITIES,
  FINANCIAL_EXCEPTION_STATUSES,
  FINANCIAL_EXCEPTION_TYPES,
  SUSPENSE_ENTRY_SOURCES,
  SUSPENSE_ENTRY_TYPES,
} from '../models/enums.js';

const objectIdString = z.string().trim().min(1);

export const acknowledgeExceptionSchema = z.object({
  notes: z.string().trim().max(1000).optional(),
});

export const resolveExceptionSchema = z.object({
  resolutionNotes: z.string().trim().min(3).max(2000),
  status: z.enum(['RESOLVED', 'IGNORED']).default('RESOLVED'),
});

export const createSuspenseSchema = z.object({
  entryType: z.enum(SUSPENSE_ENTRY_TYPES),
  amountPaise: z.number().int().positive(),
  provider: z.string().trim().max(80).optional(),
  providerReference: z.string().trim().max(200).optional(),
  bankReference: z.string().trim().max(200).optional(),
  transactionDate: z.coerce.date().optional(),
  description: z.string().trim().min(3).max(1000),
  source: z.enum(SUSPENSE_ENTRY_SOURCES),
});

export const resolveSuspenseSchema = z.object({
  resolutionNotes: z.string().trim().min(3).max(2000),
  status: z.enum(['RESOLVED', 'WRITTEN_OFF']).default('RESOLVED'),
  resolvedPaymentId: objectIdString.optional(),
  resolvedRefundId: objectIdString.optional(),
});

export const createDisputeSchema = z.object({
  paymentId: objectIdString,
  providerCaseId: z.string().trim().max(120).optional(),
  amountPaise: z.number().int().positive().optional(),
  reasonCode: z.string().trim().max(80).optional(),
  reason: z.string().trim().min(3).max(1000),
  detectedVia: z.enum(DISPUTE_DETECTED_VIA),
  notifiedAt: z.coerce.date().optional(),
  responseDueAt: z.coerce.date().optional(),
  evidenceNotes: z.string().trim().max(2000).optional(),
});

export const updateDisputeSchema = z
  .object({
    status: z.enum(DISPUTE_STATUSES).optional(),
    providerCaseId: z.string().trim().max(120).optional(),
    reasonCode: z.string().trim().max(80).optional(),
    reason: z.string().trim().min(3).max(1000).optional(),
    evidenceNotes: z.string().trim().max(2000).optional(),
    resolutionReference: z.string().trim().max(200).optional(),
    responseDueAt: z.coerce.date().optional(),
    notifiedAt: z.coerce.date().optional(),
  })
  .refine((body) => Object.keys(body).length > 0, {
    message: 'At least one field is required',
  });

export const listExceptionsQuerySchema = z.object({
  status: z.enum(FINANCIAL_EXCEPTION_STATUSES).optional(),
  severity: z.enum(FINANCIAL_EXCEPTION_SEVERITIES).optional(),
  type: z.enum(FINANCIAL_EXCEPTION_TYPES).optional(),
  agingBucket: z.enum(FINANCIAL_EXCEPTION_AGING_BUCKETS).optional(),
});
