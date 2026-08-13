import { Router } from 'express';
import { asyncHandler } from '../../utils/asyncHandler.js';
import { validateBody } from '../../middlewares/validate.middleware.js';
import {
  createStaffSchema,
  resetPasswordSchema,
  updateStaffSchema,
  updateUserStatusSchema,
} from '../../validators/staff.validators.js';
import {
  createStaffHandler,
  getStaffHandler,
  listStaffHandler,
  resetPasswordHandler,
  updateStaffHandler,
  updateUserStatusHandler,
} from '../../controllers/admin/staff-admin.controller.js';

export const staffAdminRouter = Router();

staffAdminRouter.post('/staff', validateBody(createStaffSchema), asyncHandler(createStaffHandler));
staffAdminRouter.get('/staff', asyncHandler(listStaffHandler));
staffAdminRouter.get('/staff/:id', asyncHandler(getStaffHandler));
staffAdminRouter.patch(
  '/staff/:id',
  validateBody(updateStaffSchema),
  asyncHandler(updateStaffHandler),
);
staffAdminRouter.patch(
  '/users/:id/status',
  validateBody(updateUserStatusSchema),
  asyncHandler(updateUserStatusHandler),
);
staffAdminRouter.post(
  '/users/:id/reset-password',
  validateBody(resetPasswordSchema),
  asyncHandler(resetPasswordHandler),
);
