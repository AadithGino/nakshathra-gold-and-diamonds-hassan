import type { ErrorRequestHandler, RequestHandler } from 'express';
import { ZodError } from 'zod';
import mongoose from 'mongoose';
import { env } from '../config/env.js';
import { logger } from '../config/logger.js';
import { AppError, Errors } from '../utils/AppError.js';
import {
  duplicateKeyFields,
  duplicatePhoneConflictError,
  isDuplicateKeyError,
} from '../utils/mongo-duplicate-key.js';

export const notFound: RequestHandler = (req, _res, next) =>
  next(new AppError('ROUTE_NOT_FOUND', `Route ${req.method} ${req.path} not found`, 404));
export const errorHandler: ErrorRequestHandler = (error, req, res, _next) => {
  void _next;
  let appError = error;
  if (error instanceof ZodError)
    appError = Errors.validation(
      error.issues.map((x) => ({ path: x.path.join('.'), message: x.message })),
    );
  if (error instanceof mongoose.Error.CastError)
    appError = Errors.validation([{ path: error.path, message: 'Invalid identifier' }]);
  if (isDuplicateKeyError(error)) {
    const fields = duplicateKeyFields(error);
    const field = fields[0] ?? '';
    if (field === 'phone' || fields.includes('phone')) {
      appError = duplicatePhoneConflictError();
    } else if (field === 'customerCode') {
      appError = new AppError(
        'DUPLICATE_CUSTOMER_CODE',
        'Passbook ID conflict. Please try again.',
        409,
        false,
        [{ path: 'customerCode', message: 'Passbook ID already exists' }],
      );
    } else if (field === 'enrollmentNumber') {
      appError = new AppError(
        'DUPLICATE_ENROLLMENT',
        'Enrollment number conflict. Please try again.',
        409,
      );
    } else {
      appError = new AppError('DUPLICATE_RECORD', 'This record already exists', 409);
    }
  }
  if (!(appError instanceof AppError))
    appError = new AppError('INTERNAL_ERROR', 'An unexpected error occurred', 500, true);
  logger[appError.statusCode >= 500 ? 'error' : 'warn'](
    { err: error, requestId: req.id, code: appError.code },
    appError.message,
  );
  res.status(appError.statusCode).json({
    success: false,
    error: {
      code: appError.code,
      message: appError.message,
      retryable: appError.retryable,
      details: appError.details,
    },
    requestId: req.id,
    ...(env.NODE_ENV === 'development' && appError.statusCode === 500
      ? { debug: error.message }
      : {}),
  });
};
