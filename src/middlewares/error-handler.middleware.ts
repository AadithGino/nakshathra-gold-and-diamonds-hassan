import type { ErrorRequestHandler, RequestHandler } from 'express';
import { ZodError } from 'zod';
import mongoose from 'mongoose';
import { env } from '../config/env.js';
import { logger } from '../config/logger.js';
import { AppError, Errors } from '../utils/AppError.js';

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
  if ((error as any)?.code === 11000) {
    const keyPattern = (error as any)?.keyPattern ?? {};
    const keyValue = (error as any)?.keyValue ?? {};
    const field = Object.keys(keyPattern)[0] ?? Object.keys(keyValue)[0] ?? '';
    if (field === 'phone') {
      appError = new AppError(
        'DUPLICATE_PHONE',
        'A customer with this phone number already exists',
        409,
        false,
        [{ path: 'phone', message: 'This phone number is already registered' }],
      );
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
