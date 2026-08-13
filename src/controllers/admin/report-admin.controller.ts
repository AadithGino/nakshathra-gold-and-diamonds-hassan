import type { Response } from 'express';
import type { AuthenticatedRequest } from '../../types/authenticated-request.js';
import { ok } from '../../utils/respond.js';
import { listQueryFromRequest } from '../../utils/cursor-pagination.js';
import {
  adminReport,
  getAdminOperationRecord,
  getPhonePeTransactionDetail,
  listPhonePeTransactions,
} from '../../services/report.service.js';
import {
  bankSettlementLedgerReport,
  financialExceptionsAgingReport,
  financialPeriodReport,
  gatewayExpensesReport,
  goldControlReport,
  refundOperationsReport,
  suspenseLedgerReport,
} from '../../services/operational-report.service.js';
import { AppError } from '../../utils/AppError.js';
import { reportDate } from '../../utils/report-date.js';

export { reportDate };

export async function listPhonePeTransactionsHandler(
  request: AuthenticatedRequest,
  response: Response,
) {
  const listQuery = listQueryFromRequest(request.query);
  const result = await listPhonePeTransactions(listQuery);
  ok(response, result.items, result.meta);
}

export async function getPhonePeTransactionHandler(
  request: AuthenticatedRequest,
  response: Response,
) {
  ok(response, await getPhonePeTransactionDetail(String(request.params.id)));
}

export async function getReportHandler(request: AuthenticatedRequest, response: Response) {
  const from = reportDate(request.query.from);
  const to = reportDate(request.query.to, true);
  if (from && to && from > to)
    throw new AppError('VALIDATION_ERROR', 'Report start date must be before end date', 422);
  ok(
    response,
    await adminReport(String(request.params.report), {
      from,
      to,
      id: request.query.id ? String(request.query.id) : undefined,
    }),
  );
}

export async function getOperationRecordHandler(request: AuthenticatedRequest, response: Response) {
  ok(
    response,
    await getAdminOperationRecord(String(request.params.module), String(request.params.id)),
  );
}

export async function financialPeriodReportHandler(
  request: AuthenticatedRequest,
  response: Response,
) {
  ok(response, await financialPeriodReport(String(request.params.periodKey)));
}

export async function bankSettlementLedgerReportHandler(
  request: AuthenticatedRequest,
  response: Response,
) {
  ok(
    response,
    await bankSettlementLedgerReport({
      from: reportDate(request.query.from),
      to: reportDate(request.query.to, true),
      status: request.query.status ? String(request.query.status) : undefined,
    }),
  );
}

export async function gatewayExpensesReportHandler(
  request: AuthenticatedRequest,
  response: Response,
) {
  ok(
    response,
    await gatewayExpensesReport({
      from: reportDate(request.query.from),
      to: reportDate(request.query.to, true),
    }),
  );
}

export async function refundOperationsReportHandler(
  _request: AuthenticatedRequest,
  response: Response,
) {
  ok(response, await refundOperationsReport());
}

export async function suspenseLedgerReportHandler(
  _request: AuthenticatedRequest,
  response: Response,
) {
  ok(response, await suspenseLedgerReport());
}

export async function goldControlReportHandler(
  request: AuthenticatedRequest,
  response: Response,
) {
  ok(
    response,
    await goldControlReport({
      from: reportDate(request.query.from),
      to: reportDate(request.query.to, true),
    }),
  );
}

export async function financialExceptionsAgingReportHandler(
  _request: AuthenticatedRequest,
  response: Response,
) {
  ok(response, await financialExceptionsAgingReport());
}
