import { Router } from 'express';
import { asyncHandler } from '../../utils/asyncHandler.js';
import { validateBody } from '../../middlewares/validate.middleware.js';
import {
  createCustomerSchema,
  rejectCustomerKycSchema,
  updateCustomerSchema,
} from '../../validators/customer.validators.js';
import { resetPasswordSchema } from '../../validators/staff.validators.js';
import {
  createCustomerHandler,
  getActiveEnrollmentHandler,
  getCustomerHandler,
  listCustomersHandler,
  rejectCustomerKycHandler,
  resetCustomerPasswordHandler,
  updateCustomerHandler,
  verifyCustomerKycHandler,
} from '../../controllers/admin/customer-admin.controller.js';

export const customerAdminRouter = Router();

customerAdminRouter.post(
  '/customers',
  validateBody(createCustomerSchema),
  asyncHandler(createCustomerHandler),
);
customerAdminRouter.get('/customers', asyncHandler(listCustomersHandler));
customerAdminRouter.get('/customers/:id/enrollment', asyncHandler(getActiveEnrollmentHandler));
customerAdminRouter.get('/customers/:id', asyncHandler(getCustomerHandler));
customerAdminRouter.patch(
  '/customers/:id',
  validateBody(updateCustomerSchema),
  asyncHandler(updateCustomerHandler),
);
customerAdminRouter.post(
  '/customers/:id/reset-password',
  validateBody(resetPasswordSchema),
  asyncHandler(resetCustomerPasswordHandler),
);
customerAdminRouter.post(
  '/customers/:id/kyc/verify',
  asyncHandler(verifyCustomerKycHandler),
);
customerAdminRouter.post(
  '/customers/:id/kyc/reject',
  validateBody(rejectCustomerKycSchema),
  asyncHandler(rejectCustomerKycHandler),
);
