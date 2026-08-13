import { Router } from 'express';
import { asyncHandler } from '../../utils/asyncHandler.js';
import { authenticate, authorize, requirePermission } from '../../middlewares/auth.middleware.js';
import { validateBody } from '../../middlewares/validate.middleware.js';
import {
  correctionRequestSchema,
  staffPhonePeInitiateSchema,
  staffPaymentSchema,
} from '../../validators/staff-portal.validators.js';
import { createCustomerSchema } from '../../validators/customer.validators.js';
import { createEnrollmentSchema } from '../../validators/scheme.validators.js';
import {
  collectPaymentHandler,
  createCustomerHandler,
  createEnrollmentHandler,
  getActiveEnrollmentHandler,
  getEnrollmentHandler,
  getPhonePeCollectionIntentHandler,
  getCustomerHandler,
  getCashHeldHandler,
  getStaffDashboard,
  getStaffProfileHandler,
  getOwnReceiptHandler,
  getOwnCollectionReportHandler,
  listSchemePlansHandler,
  listOwnCashSubmissionsHandler,
  listOwnCorrectionsHandler,
  listOwnPaymentsHandler,
  initiatePhonePeCollectionHandler,
  initiatePhonePeSdkCollectionHandler,
  previewPaymentHandler,
  requestCorrectionHandler,
  searchCustomersHandler,
} from '../../controllers/staff/staff-portal.controller.js';

const staffRouter = Router();

staffRouter.use(authenticate, authorize('STAFF'));
staffRouter.get('/dashboard', asyncHandler(getStaffDashboard));
staffRouter.get('/reports/collection', asyncHandler(getOwnCollectionReportHandler));
staffRouter.get(
  '/customers',
  requirePermission('canViewCustomers'),
  asyncHandler(searchCustomersHandler),
);
staffRouter.post(
  '/customers',
  requirePermission('canCreateCustomer'),
  validateBody(createCustomerSchema),
  asyncHandler(createCustomerHandler),
);
staffRouter.get(
  '/customers/:id',
  requirePermission('canViewCustomers'),
  asyncHandler(getCustomerHandler),
);
staffRouter.get(
  '/customers/:id/enrollment',
  requirePermission('canViewCustomers'),
  asyncHandler(getActiveEnrollmentHandler),
);
staffRouter.get('/scheme-plans', asyncHandler(listSchemePlansHandler));
staffRouter.get(
  '/enrollments/:id',
  requirePermission('canViewCustomers'),
  asyncHandler(getEnrollmentHandler),
);
staffRouter.post(
  '/enrollments',
  requirePermission('canEnrollScheme'),
  validateBody(createEnrollmentSchema),
  asyncHandler(createEnrollmentHandler),
);
staffRouter.get(
  '/schemes/:id/payment-preview',
  requirePermission('canCollectPayment'),
  asyncHandler(previewPaymentHandler),
);
staffRouter.post(
  '/payments/phonepe/create-order',
  requirePermission('canCollectPayment'),
  validateBody(staffPhonePeInitiateSchema),
  asyncHandler(initiatePhonePeSdkCollectionHandler),
);
staffRouter.post(
  '/payments/phonepe',
  requirePermission('canCollectPayment'),
  validateBody(staffPhonePeInitiateSchema),
  asyncHandler(initiatePhonePeCollectionHandler),
);
staffRouter.get(
  '/payment-intents/:orderId',
  requirePermission('canCollectPayment'),
  asyncHandler(getPhonePeCollectionIntentHandler),
);
staffRouter.post(
  '/payments',
  requirePermission('canCollectPayment'),
  validateBody(staffPaymentSchema),
  asyncHandler(collectPaymentHandler),
);
staffRouter.get('/payments', asyncHandler(listOwnPaymentsHandler));
staffRouter.get('/payments/:id/receipt', asyncHandler(getOwnReceiptHandler));
staffRouter.post(
  '/payments/:id/corrections',
  requirePermission('canSubmitCorrectionRequest'),
  validateBody(correctionRequestSchema),
  asyncHandler(requestCorrectionHandler),
);
staffRouter.get('/corrections', asyncHandler(listOwnCorrectionsHandler));
staffRouter.get('/cash-held', asyncHandler(getCashHeldHandler));
staffRouter.get('/cash-submissions', asyncHandler(listOwnCashSubmissionsHandler));
staffRouter.get('/profile', asyncHandler(getStaffProfileHandler));

export default staffRouter;
