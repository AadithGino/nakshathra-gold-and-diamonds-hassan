import { Router } from 'express';
import { asyncHandler } from '../../utils/asyncHandler.js';
import { authenticate, authorize, requireGoldWeightEnabled } from '../../middlewares/auth.middleware.js';
import { validateBody } from '../../middlewares/validate.middleware.js';
import { initiatePhonePeSchema } from '../../validators/customer-payment.validators.js';
import {
  getHomeHandler,
  getPaymentIntentHandler,
  getProfileHandler,
  getReceiptHandler,
  getSchemeHandler,
  initiatePhonePeHandler,
  initiatePhonePeSdkOrderHandler,
  listNotificationsHandler,
  listGoldRatesHandler,
  listPaymentsHandler,
  listPayoutsHandler,
  listSchemesHandler,
  previewCustomerPaymentHandler,
} from '../../controllers/customer/customer-portal.controller.js';

const customerRouter = Router();

customerRouter.use(authenticate, authorize('CUSTOMER'));
customerRouter.get('/home', asyncHandler(getHomeHandler));
customerRouter.get('/schemes', asyncHandler(listSchemesHandler));
customerRouter.get(
  '/schemes/:id/payment-preview',
  asyncHandler(previewCustomerPaymentHandler),
);
customerRouter.get('/schemes/:id', asyncHandler(getSchemeHandler));
customerRouter.get('/payments', asyncHandler(listPaymentsHandler));
customerRouter.get('/gold-rates', requireGoldWeightEnabled, asyncHandler(listGoldRatesHandler));
customerRouter.get('/payments/:id/receipt', asyncHandler(getReceiptHandler));
customerRouter.post(
  '/payments/phonepe/create-order',
  validateBody(initiatePhonePeSchema),
  asyncHandler(initiatePhonePeSdkOrderHandler),
);
customerRouter.post(
  '/payments/phonepe',
  validateBody(initiatePhonePeSchema),
  asyncHandler(initiatePhonePeHandler),
);
customerRouter.get('/payment-intents/:orderId', asyncHandler(getPaymentIntentHandler));
customerRouter.get('/payouts', asyncHandler(listPayoutsHandler));
customerRouter.get('/notifications', asyncHandler(listNotificationsHandler));
customerRouter.get('/profile', asyncHandler(getProfileHandler));

export default customerRouter;
