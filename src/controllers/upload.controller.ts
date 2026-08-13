import type { Response } from 'express';
import { ok } from '../utils/respond.js';
import type { AuthenticatedRequest } from '../types/authenticated-request.js';
import { AppError } from '../utils/AppError.js';
import {
  createPresignedUpload,
  uploadObject,
} from '../services/storage.service.js';
import {
  ALLOWED_UPLOAD_MIME,
  type PresignUploadInput,
} from '../validators/upload.validators.js';

export async function createPresignedUploadHandler(
  request: AuthenticatedRequest,
  response: Response,
) {
  ok(response, await createPresignedUpload(request.body));
}

export async function uploadFileHandler(
  request: AuthenticatedRequest,
  response: Response,
) {
  const kind = String(request.query.kind ?? request.get('x-upload-kind') ?? '');
  const contentType = String(
    request.get('x-file-content-type') ?? request.get('content-type') ?? '',
  )
    .split(';')[0]
    ?.trim()
    .toLowerCase();

  if (kind !== 'aadhaar-front' && kind !== 'aadhaar-back') {
    throw new AppError('INVALID_UPLOAD_KIND', 'Unsupported upload kind', 422);
  }
  if (!contentType || !(ALLOWED_UPLOAD_MIME as readonly string[]).includes(contentType)) {
    throw new AppError('INVALID_FILE_TYPE', 'Unsupported file type', 415);
  }

  const body = Buffer.isBuffer(request.body)
    ? request.body
    : Buffer.from(request.body ?? []);

  if (!body.byteLength) {
    throw new AppError('FILE_REQUIRED', 'A file is required', 422);
  }

  ok(
    response,
    await uploadObject(kind as PresignUploadInput['kind'], contentType, body),
    undefined,
    201,
  );
}
