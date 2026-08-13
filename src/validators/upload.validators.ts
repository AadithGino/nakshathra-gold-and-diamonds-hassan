import { z } from 'zod';

export const ALLOWED_UPLOAD_MIME = [
  'image/jpeg',
  'image/png',
  'image/webp',
  'application/pdf',
] as const;

export const presignUploadSchema = z.object({
  kind: z.enum(['aadhaar-front', 'aadhaar-back']),
  contentType: z.enum(ALLOWED_UPLOAD_MIME),
  fileName: z.string().trim().min(1).max(180).optional(),
});

export type PresignUploadInput = z.infer<typeof presignUploadSchema>;
