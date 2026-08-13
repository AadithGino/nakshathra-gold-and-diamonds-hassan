import { Router } from 'express';
import {
  getSettingsHandler,
  updateSettingsHandler,
} from '../../controllers/admin/settings-admin.controller.js';
import { validateBody } from '../../middlewares/validate.middleware.js';
import { asyncHandler } from '../../utils/asyncHandler.js';
import { updateSettingsSchema } from '../../validators/settings.validators.js';

export const settingsAdminRouter = Router();

settingsAdminRouter.get('/settings', asyncHandler(getSettingsHandler));
settingsAdminRouter.patch(
  '/settings',
  validateBody(updateSettingsSchema),
  asyncHandler(updateSettingsHandler),
);
