import { describe, expect, it } from 'vitest';
import { AppError } from '../src/utils/AppError.js';
import { canonicalJson, sha256Canonical } from '../src/utils/canonical-hash.js';

describe('canonical-hash', () => {
  it('sorts object keys so key order does not change the digest', () => {
    const a = sha256Canonical({ schemeId: 's1', amountPaise: 100_000, customerId: 'c1' });
    const b = sha256Canonical({ customerId: 'c1', amountPaise: 100_000, schemeId: 's1' });
    expect(a).toBe(b);
    expect(canonicalJson({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
  });

  it('preserves array order', () => {
    expect(sha256Canonical([1, 2])).not.toBe(sha256Canonical([2, 1]));
  });

  it('converts dates to ISO strings', () => {
    const date = new Date('2026-08-05T10:00:00.000Z');
    expect(canonicalJson({ at: date })).toBe('{"at":"2026-08-05T10:00:00.000Z"}');
  });

  it('rejects undefined, non-finite numbers, and unsafe integers', () => {
    expect(() => sha256Canonical({ x: undefined })).toThrow(AppError);
    expect(() => sha256Canonical({ x: Number.NaN })).toThrow(AppError);
    expect(() => sha256Canonical({ x: Number.MAX_SAFE_INTEGER + 1 })).toThrow(AppError);
  });
});
