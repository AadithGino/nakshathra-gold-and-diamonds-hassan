import { AppError } from './AppError.js';

/** Mongo duplicate-key (E11000), including nested writeErrors from insertMany/create([..]). */
export function isDuplicateKeyError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const err = error as {
    code?: number;
    writeErrors?: Array<{ code?: number }>;
    errorResponse?: { code?: number };
  };
  if (err.code === 11000) return true;
  if (err.errorResponse?.code === 11000) return true;
  if (Array.isArray(err.writeErrors) && err.writeErrors.some((row) => row?.code === 11000)) {
    return true;
  }
  return false;
}

export function duplicateKeyFields(error: unknown): string[] {
  if (!error || typeof error !== 'object') return [];
  const err = error as {
    keyPattern?: Record<string, unknown>;
    keyValue?: Record<string, unknown>;
    writeErrors?: Array<{
      err?: { keyPattern?: Record<string, unknown>; keyValue?: Record<string, unknown> };
      keyPattern?: Record<string, unknown>;
      keyValue?: Record<string, unknown>;
    }>;
  };
  const fields = new Set<string>();
  for (const source of [err.keyPattern, err.keyValue]) {
    if (source) for (const key of Object.keys(source)) fields.add(key);
  }
  for (const writeError of err.writeErrors ?? []) {
    const nested = writeError.err ?? writeError;
    for (const source of [nested.keyPattern, nested.keyValue]) {
      if (source) for (const key of Object.keys(source)) fields.add(key);
    }
  }
  return [...fields];
}

export function duplicatePhoneConflictError() {
  return new AppError(
    'DUPLICATE_PHONE',
    'A customer with this phone number already exists',
    409,
    false,
    [{ path: 'phone', message: 'This phone number is already registered' }],
  );
}

export function throwIfDuplicatePhoneKey(error: unknown): never | void {
  if (!isDuplicateKeyError(error)) return;
  const fields = duplicateKeyFields(error);
  if (fields.length === 0 || fields.includes('phone')) {
    throw duplicatePhoneConflictError();
  }
}
