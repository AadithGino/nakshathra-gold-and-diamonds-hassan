import type { RequestHandler } from 'express';
import { AppError } from '../utils/AppError.js';

const forbiddenKeys = new Set(['__proto__', 'prototype', 'constructor']);

export function hasUnsafeMongoKey(value: unknown, seen = new WeakSet<object>()): boolean {
  if (value === null || typeof value !== 'object') return false;
  if (seen.has(value)) return false;
  seen.add(value);

  return Object.entries(value).some(
    ([key, child]) =>
      key.startsWith('$') || key.includes('.') || forbiddenKeys.has(key) || hasUnsafeMongoKey(child, seen),
  );
}

export const rejectMongoOperators: RequestHandler = (req, _res, next) => {
  if ([req.body, req.params, req.query].some((value) => hasUnsafeMongoKey(value))) {
    return next(
      new AppError(
        'UNSAFE_INPUT',
        'Request keys cannot contain MongoDB operators or dotted paths',
        400,
      ),
    );
  }
  next();
};
