import { createHash } from 'node:crypto';
import { AppError } from './AppError.js';

function assertCanonicalValue(value: unknown, path: string): void {
  if (value === undefined) {
    throw new AppError('CANONICAL_HASH_INVALID', `Cannot hash undefined at ${path}`, 500, true);
  }
  if (typeof value === 'function') {
    throw new AppError('CANONICAL_HASH_INVALID', `Cannot hash function at ${path}`, 500, true);
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new AppError('CANONICAL_HASH_INVALID', `Cannot hash non-finite number at ${path}`, 500, true);
    }
    if (!Number.isSafeInteger(value)) {
      throw new AppError(
        'CANONICAL_HASH_INVALID',
        `Cannot hash unsafe integer at ${path}`,
        500,
        true,
      );
    }
  }
}

function canonicalize(value: unknown, path = '$'): unknown {
  assertCanonicalValue(value, path);
  if (value === null) return null;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'bigint') {
    throw new AppError('CANONICAL_HASH_INVALID', `Cannot hash bigint at ${path}`, 500, true);
  }
  if (typeof value !== 'object') return value;
  if (Array.isArray(value)) {
    return value.map((item, index) => canonicalize(item, `${path}[${index}]`));
  }
  const record = value as Record<string, unknown>;
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(record).sort()) {
    sorted[key] = canonicalize(record[key], `${path}.${key}`);
  }
  return sorted;
}

/** Stable JSON for financial command hashing (sorted object keys, array order preserved). */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

export function sha256Canonical(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}
