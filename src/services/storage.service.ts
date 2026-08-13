import { randomUUID } from 'node:crypto';
import {
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { env } from '../config/env.js';
import { AppError } from '../utils/AppError.js';
import type { PresignUploadInput } from '../validators/upload.validators.js';

const UPLOAD_KINDS = {
  'aadhaar-front': { visibility: 'private' as const, folder: 'aadhaar-front' },
  'aadhaar-back': { visibility: 'private' as const, folder: 'aadhaar-back' },
};

const EXTENSIONS: Record<string, string> = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
  'application/pdf': '.pdf',
};

const DEFAULT_SIGNED_TTL = 60 * 60;

function assertS3Configured() {
  const s3 = env.storage;
  if (!s3.region || !s3.bucket || !s3.accessKeyId || !s3.secretAccessKey) {
    throw new AppError(
      'STORAGE_NOT_CONFIGURED',
      'S3 storage is not configured. Set AWS_REGION, AWS_S3_BUCKET, AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY.',
      503,
    );
  }
}

function getS3() {
  assertS3Configured();
  return new S3Client({
    region: env.storage.region,
    credentials: {
      accessKeyId: env.storage.accessKeyId,
      secretAccessKey: env.storage.secretAccessKey,
    },
    // Avoid CRC32 checksum query params that break browser CORS preflights on presigned PUTs.
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED',
  });
}

function signedTtlSeconds() {
  const raw = env.storage.signedUrlTtl;
  if (!Number.isFinite(raw) || raw < 60) return DEFAULT_SIGNED_TTL;
  return Math.min(Math.floor(raw), 7 * 24 * 60 * 60);
}

export function buildObjectKey(kind: PresignUploadInput['kind'], contentType: string) {
  const meta = UPLOAD_KINDS[kind];
  const ext = EXTENSIONS[contentType];
  if (!ext) throw new AppError('INVALID_FILE_TYPE', 'Unsupported file type', 415);

  const date = new Date().toISOString().slice(0, 10);
  const leaf = `${meta.folder}/${date}/${randomUUID()}${ext}`;
  return [env.storage.prefix, env.storage.jewelleryFolder, meta.visibility, leaf]
    .filter(Boolean)
    .join('/');
}

export function isOurStorageObject(key: string) {
  const prefix = [env.storage.prefix, env.storage.jewelleryFolder].filter(Boolean).join('/');
  return Boolean(key) && key.startsWith(`${prefix}/`);
}

export async function createPresignedUpload(input: PresignUploadInput) {
  assertS3Configured();
  const key = buildObjectKey(input.kind, input.contentType);
  const client = getS3();
  const expiresIn = Math.min(signedTtlSeconds(), 15 * 60);
  const uploadUrl = await getSignedUrl(
    client,
    new PutObjectCommand({
      Bucket: env.storage.bucket,
      Key: key,
      ContentType: input.contentType,
    }),
    { expiresIn },
  );

  return {
    key,
    uploadUrl,
    method: 'PUT' as const,
    headers: { 'Content-Type': input.contentType },
    maxBytes: env.storage.maxBytes,
    expiresIn,
  };
}

export async function uploadObject(
  kind: PresignUploadInput['kind'],
  contentType: string,
  body: Buffer,
) {
  assertS3Configured();
  if (!EXTENSIONS[contentType]) {
    throw new AppError('INVALID_FILE_TYPE', 'Unsupported file type', 415);
  }
  if (body.byteLength > env.storage.maxBytes) {
    throw new AppError('FILE_TOO_LARGE', 'Uploaded file exceeds the maximum allowed size', 413);
  }

  const key = buildObjectKey(kind, contentType);
  await getS3().send(
    new PutObjectCommand({
      Bucket: env.storage.bucket,
      Key: key,
      Body: body,
      ContentType: contentType,
      CacheControl: 'private, max-age=3600',
    }),
  );

  return {
    key,
    contentType,
    bytes: body.byteLength,
  };
}

export async function getSignedObjectUrl(key?: string | null) {
  if (!key) return null;
  if (!isOurStorageObject(key)) return null;
  assertS3Configured();
  const expiresIn = signedTtlSeconds();
  return getSignedUrl(
    getS3(),
    new GetObjectCommand({
      Bucket: env.storage.bucket,
      Key: key,
      ResponseContentDisposition: 'inline',
      ResponseCacheControl: `private, max-age=${Math.min(expiresIn, 3600)}`,
    }),
    { expiresIn },
  );
}

export async function signAadhaarUrls(aadhaar?: {
  frontKey?: string | null;
  backKey?: string | null;
} | null) {
  if (!aadhaar) return null;
  const [frontUrl, backUrl] = await Promise.all([
    getSignedObjectUrl(aadhaar.frontKey),
    getSignedObjectUrl(aadhaar.backKey),
  ]);
  return {
    frontKey: aadhaar.frontKey ?? null,
    backKey: aadhaar.backKey ?? null,
    frontUrl,
    backUrl,
  };
}
