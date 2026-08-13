import type { RequestHandler } from 'express';
import { isGoldWeightEnabled } from '../config/business.js';
import type { Role } from '../models/index.js';
import { AppError } from '../utils/AppError.js';
import { assertAccessSession, verifyAccess } from '../services/auth.service.js';

export const authenticate: RequestHandler = (req, _res, next) => {
  void (async () => {
    const claims = verifyAccess(req.cookies?.access_token);
    const session = await assertAccessSession(claims);
    req.auth = {
      userId: claims.sub,
      role: session.role,
      permissions: session.permissions,
      sessionVersion: claims.sessionVersion,
    };
    next();
  })().catch(next);
};
export const authorize =
  (...roles: Role[]): RequestHandler =>
  (req, _res, next) => {
    if (!req.auth || !roles.includes(req.auth.role))
      throw new AppError('PERMISSION_DENIED', 'You do not have permission for this action', 403);
    next();
  };
export const requirePermission =
  (permission: string): RequestHandler =>
  (req, _res, next) => {
    if (req.auth?.role !== 'ADMIN' && !req.auth?.permissions.includes(permission))
      throw new AppError('PERMISSION_DENIED', 'Required permission is missing', 403);
    next();
  };

/** Admin, or staff who can create customers, may upload private Aadhaar documents. */
export const requireAadhaarUploadAccess: RequestHandler = (req, _res, next) => {
  if (req.auth?.role === 'ADMIN') {
    next();
    return;
  }
  if (req.auth?.role === 'STAFF' && req.auth.permissions.includes('canCreateCustomer')) {
    next();
    return;
  }
  throw new AppError('PERMISSION_DENIED', 'Required permission is missing', 403);
};

/** GOLD_WEIGHT HTTP surface stays in the tree but is dormant while CASH is the only live type. */
export const requireGoldWeightEnabled: RequestHandler = (_req, _res, next) => {
  if (!isGoldWeightEnabled()) {
    throw new AppError(
      'GOLD_WEIGHT_DISABLED',
      'GOLD_WEIGHT functionality is not enabled for this deployment',
      409,
    );
  }
  next();
};
