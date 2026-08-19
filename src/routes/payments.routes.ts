import { Router } from 'express';
import { asyncHandler } from '../utils/asyncHandler.js';
import { authenticate, authorize } from '../middlewares/auth.middleware.js';
import { getPhonePeCredentialsHandler } from '../controllers/gateway.controller.js';

const paymentsRouter = Router();

paymentsRouter.get(
  '/phonepe/config',
  authenticate,
  authorize('CUSTOMER', 'STAFF', 'ADMIN'),
  asyncHandler(getPhonePeCredentialsHandler),
);

export default paymentsRouter;
