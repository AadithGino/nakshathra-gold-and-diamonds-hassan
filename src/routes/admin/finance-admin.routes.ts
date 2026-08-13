import { Router } from 'express';
import { asyncHandler } from '../../utils/asyncHandler.js';
import { validateBody } from '../../middlewares/validate.middleware.js';
import {
  cashSubmissionSchema,
  correctionDecisionSchema,
  manualPaymentSchema,
  payoutSchema,
  reversePaymentSchema,
} from '../../validators/finance.validators.js';
import { initiateRefundSchema, retryFailedRefundSchema } from '../../validators/refund.validators.js';
import {
  acknowledgeExceptionSchema,
  createDisputeSchema,
  createSuspenseSchema,
  resolveExceptionSchema,
  resolveSuspenseSchema,
  updateDisputeSchema,
} from '../../validators/financial-exception.validators.js';
import {
  closeGatewaySettlementSchema,
  confirmGatewaySettlementSchema,
  createGatewaySettlementSchema,
} from '../../validators/gateway-settlement.validators.js';
import { createGoldInventoryMovementSchema } from '../../validators/gold-inventory.validators.js';
import {
  closeAccountingPeriodSchema,
  reopenAccountingPeriodSchema,
} from '../../validators/accounting-period.validators.js';
import {
  acknowledgeExceptionHandler,
  checkRefundStatusHandler,
  closeAccountingPeriodHandler,
  closeGatewaySettlementHandler,
  confirmGatewaySettlementHandler,
  createCashSubmissionHandler,
  createDisputeHandler,
  createGatewaySettlementHandler,
  createGoldInventoryMovementHandler,
  createManualPaymentHandler,
  createPayoutHandler,
  createSuspenseHandler,
  getAccountingPeriodHandler,
  getDisputeHandler,
  getExceptionHandler,
  getGatewaySettlementHandler,
  getPaymentHandler,
  getRefundHandler,
  gatewaySettlementSummaryHandler,
  goldControlSummaryHandler,
  goldLiabilityMovementsHandler,
  initiateRefundHandler,
  listAccountingPeriodsHandler,
  listAuditLogsHandler,
  listCashHeldHandler,
  listCashSubmissionsHandler,
  listCorrectionsHandler,
  listDisputesHandler,
  listExceptionsHandler,
  listGatewaySettlementsHandler,
  listGoldInventoryMovementsHandler,
  listPaymentsHandler,
  listPayoutsHandler,
  listRefundsHandler,
  listSuspenseHandler,
  reopenAccountingPeriodHandler,
  resolveExceptionHandler,
  resolveSuspenseHandler,
  retryFailedRefundHandler,
  reversePaymentHandler,
  reviewCorrectionHandler,
  updateDisputeHandler,
} from '../../controllers/admin/finance-admin.controller.js';

export const financeAdminRouter = Router();

financeAdminRouter.post(
  '/payments/manual',
  validateBody(manualPaymentSchema),
  asyncHandler(createManualPaymentHandler),
);
financeAdminRouter.get('/payments', asyncHandler(listPaymentsHandler));
financeAdminRouter.get('/payments/:id', asyncHandler(getPaymentHandler));
financeAdminRouter.post(
  '/payments/:id/refund',
  validateBody(initiateRefundSchema),
  asyncHandler(initiateRefundHandler),
);
financeAdminRouter.post(
  '/payments/:id/reverse',
  validateBody(reversePaymentSchema),
  asyncHandler(reversePaymentHandler),
);
financeAdminRouter.get('/refunds', asyncHandler(listRefundsHandler));
financeAdminRouter.get('/refunds/:id', asyncHandler(getRefundHandler));
financeAdminRouter.post('/refunds/:id/check-status', asyncHandler(checkRefundStatusHandler));
financeAdminRouter.post(
  '/refunds/:id/retry',
  validateBody(retryFailedRefundSchema),
  asyncHandler(retryFailedRefundHandler),
);
financeAdminRouter.post('/payouts', validateBody(payoutSchema), asyncHandler(createPayoutHandler));
financeAdminRouter.get('/payouts', asyncHandler(listPayoutsHandler));
financeAdminRouter.get('/cash-held', asyncHandler(listCashHeldHandler));
financeAdminRouter.post(
  '/cash-submissions',
  validateBody(cashSubmissionSchema),
  asyncHandler(createCashSubmissionHandler),
);
financeAdminRouter.get('/cash-submissions', asyncHandler(listCashSubmissionsHandler));
financeAdminRouter.get('/corrections', asyncHandler(listCorrectionsHandler));
financeAdminRouter.patch(
  '/corrections/:id',
  validateBody(correctionDecisionSchema),
  asyncHandler(reviewCorrectionHandler),
);
financeAdminRouter.get('/audit-logs', asyncHandler(listAuditLogsHandler));

financeAdminRouter.get('/finance/exceptions', asyncHandler(listExceptionsHandler));
financeAdminRouter.get('/finance/exceptions/:id', asyncHandler(getExceptionHandler));
financeAdminRouter.post(
  '/finance/exceptions/:id/acknowledge',
  validateBody(acknowledgeExceptionSchema),
  asyncHandler(acknowledgeExceptionHandler),
);
financeAdminRouter.post(
  '/finance/exceptions/:id/resolve',
  validateBody(resolveExceptionSchema),
  asyncHandler(resolveExceptionHandler),
);

financeAdminRouter.post(
  '/finance/suspense',
  validateBody(createSuspenseSchema),
  asyncHandler(createSuspenseHandler),
);
financeAdminRouter.get('/finance/suspense', asyncHandler(listSuspenseHandler));
financeAdminRouter.post(
  '/finance/suspense/:id/resolve',
  validateBody(resolveSuspenseSchema),
  asyncHandler(resolveSuspenseHandler),
);

financeAdminRouter.post(
  '/finance/disputes',
  validateBody(createDisputeSchema),
  asyncHandler(createDisputeHandler),
);
financeAdminRouter.get('/finance/disputes', asyncHandler(listDisputesHandler));
financeAdminRouter.get('/finance/disputes/:id', asyncHandler(getDisputeHandler));
financeAdminRouter.patch(
  '/finance/disputes/:id',
  validateBody(updateDisputeSchema),
  asyncHandler(updateDisputeHandler),
);

financeAdminRouter.post(
  '/finance/gateway-settlements',
  validateBody(createGatewaySettlementSchema),
  asyncHandler(createGatewaySettlementHandler),
);
financeAdminRouter.get(
  '/finance/gateway-settlements/summary',
  asyncHandler(gatewaySettlementSummaryHandler),
);
financeAdminRouter.get('/finance/gateway-settlements', asyncHandler(listGatewaySettlementsHandler));
financeAdminRouter.get(
  '/finance/gateway-settlements/:id',
  asyncHandler(getGatewaySettlementHandler),
);
financeAdminRouter.post(
  '/finance/gateway-settlements/:id/confirm-bank-credit',
  validateBody(confirmGatewaySettlementSchema),
  asyncHandler(confirmGatewaySettlementHandler),
);
financeAdminRouter.post(
  '/finance/gateway-settlements/:id/close',
  validateBody(closeGatewaySettlementSchema),
  asyncHandler(closeGatewaySettlementHandler),
);

financeAdminRouter.post(
  '/finance/gold-inventory/movements',
  validateBody(createGoldInventoryMovementSchema),
  asyncHandler(createGoldInventoryMovementHandler),
);
financeAdminRouter.get(
  '/finance/gold-inventory/movements',
  asyncHandler(listGoldInventoryMovementsHandler),
);
financeAdminRouter.get('/finance/gold-control/summary', asyncHandler(goldControlSummaryHandler));
financeAdminRouter.get(
  '/finance/gold-control/liability-movements',
  asyncHandler(goldLiabilityMovementsHandler),
);

financeAdminRouter.get('/finance/accounting-periods', asyncHandler(listAccountingPeriodsHandler));
financeAdminRouter.get(
  '/finance/accounting-periods/:periodKey',
  asyncHandler(getAccountingPeriodHandler),
);
financeAdminRouter.post(
  '/finance/accounting-periods/:periodKey/close',
  validateBody(closeAccountingPeriodSchema),
  asyncHandler(closeAccountingPeriodHandler),
);
financeAdminRouter.post(
  '/finance/accounting-periods/:periodKey/reopen',
  validateBody(reopenAccountingPeriodSchema),
  asyncHandler(reopenAccountingPeriodHandler),
);
