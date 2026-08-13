import { Router } from 'express';
import {
  bankSettlementLedgerReportHandler,
  financialExceptionsAgingReportHandler,
  financialPeriodReportHandler,
  gatewayExpensesReportHandler,
  getOperationRecordHandler,
  getPhonePeTransactionHandler,
  getReportHandler,
  goldControlReportHandler,
  listPhonePeTransactionsHandler,
  refundOperationsReportHandler,
  suspenseLedgerReportHandler,
} from '../../controllers/admin/report-admin.controller.js';
import { asyncHandler } from '../../utils/asyncHandler.js';

export const reportAdminRouter = Router();

reportAdminRouter.get('/phonepe-transactions', asyncHandler(listPhonePeTransactionsHandler));
reportAdminRouter.get('/phonepe-transactions/:id', asyncHandler(getPhonePeTransactionHandler));
reportAdminRouter.get(
  '/operation-records/:module/:id',
  asyncHandler(getOperationRecordHandler),
);

reportAdminRouter.get(
  '/reports/financial-periods/:periodKey',
  asyncHandler(financialPeriodReportHandler),
);
reportAdminRouter.get(
  '/reports/bank-settlement-ledger',
  asyncHandler(bankSettlementLedgerReportHandler),
);
reportAdminRouter.get('/reports/gateway-expenses', asyncHandler(gatewayExpensesReportHandler));
reportAdminRouter.get('/reports/refunds', asyncHandler(refundOperationsReportHandler));
reportAdminRouter.get('/reports/suspense-ledger', asyncHandler(suspenseLedgerReportHandler));
reportAdminRouter.get('/reports/gold-control', asyncHandler(goldControlReportHandler));
reportAdminRouter.get(
  '/reports/financial-exceptions-aging',
  asyncHandler(financialExceptionsAgingReportHandler),
);

reportAdminRouter.get('/reports/:report', asyncHandler(getReportHandler));
