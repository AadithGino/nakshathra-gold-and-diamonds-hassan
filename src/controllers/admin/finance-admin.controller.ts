import type { Response } from 'express';
import { ok } from '../../utils/respond.js';
import type { AuthenticatedRequest } from '../../types/authenticated-request.js';
import { auditContextFromRequest } from '../../types/authenticated-request.js';
import { listQueryFromRequest } from '../../utils/cursor-pagination.js';
import { listAuditLogs } from '../../services/audit.service.js';
import {
  createPayout,
  getPaymentDetail,
  listCashSubmissions,
  listCorrections,
  listPayments,
  listPayouts,
  listStaffCashHeld,
  reversePayment,
  reviewCorrection,
  submitCash,
} from '../../services/finance.service.js';
import { createManualPayment } from '../../services/payment.service.js';
import {
  getRefundDetail,
  initiatePaymentRefund,
  listRefunds,
  reconcileRefundStatus,
  retryFailedRefund,
} from '../../services/refund.service.js';
import {
  acknowledgeFinancialException,
  createDisputeCase,
  createSuspenseEntry,
  getDisputeCaseDetail,
  getFinancialExceptionDetail,
  listDisputeCases,
  listFinancialExceptions,
  listSuspenseEntries,
  resolveFinancialException,
  resolveSuspenseEntry,
  updateDisputeCase,
} from '../../services/financial-exception.service.js';
import {
  closeGatewaySettlement,
  confirmGatewaySettlementBankCredit,
  createGatewaySettlement,
  getGatewaySettlementDetail,
  getGatewaySettlementLedgerSummary,
  listGatewaySettlements,
} from '../../services/gateway-settlement.service.js';
import {
  getGoldControlSummary,
  getGoldLiabilityMovements,
  listGoldInventoryMovements,
  recordGoldInventoryMovement,
} from '../../services/gold-control.service.js';
import {
  closeAccountingPeriod,
  getPeriodSummary,
  listAccountingPeriods,
  reopenAccountingPeriod,
} from '../../services/accounting-period.service.js';

export async function createManualPaymentHandler(
  request: AuthenticatedRequest,
  response: Response,
) {
  ok(
    response,
    await createManualPayment(request.body, {
      ...auditContextFromRequest(request),
      actorRole: 'ADMIN',
    }),
    undefined,
    201,
  );
}

export async function listPaymentsHandler(request: AuthenticatedRequest, response: Response) {
  const listQuery = listQueryFromRequest(request.query);
  const result = await listPayments(listQuery);
  ok(response, result.items, result.meta);
}

export async function getPaymentHandler(request: AuthenticatedRequest, response: Response) {
  ok(response, await getPaymentDetail(String(request.params.id)));
}

export async function initiateRefundHandler(request: AuthenticatedRequest, response: Response) {
  ok(
    response,
    await initiatePaymentRefund(String(request.params.id), request.body, {
      ...auditContextFromRequest(request),
      actorId: request.auth.userId,
    }),
    undefined,
    201,
  );
}

export async function listRefundsHandler(request: AuthenticatedRequest, response: Response) {
  const listQuery = listQueryFromRequest(request.query);
  const result = await listRefunds(listQuery);
  ok(response, result.items, result.meta);
}

export async function getRefundHandler(request: AuthenticatedRequest, response: Response) {
  ok(response, await getRefundDetail(String(request.params.id)));
}

export async function checkRefundStatusHandler(
  request: AuthenticatedRequest,
  response: Response,
) {
  ok(
    response,
    await reconcileRefundStatus(String(request.params.id), {
      ...auditContextFromRequest(request),
      actorId: request.auth.userId,
    }),
  );
}

export async function retryFailedRefundHandler(
  request: AuthenticatedRequest,
  response: Response,
) {
  ok(
    response,
    await retryFailedRefund(String(request.params.id), request.body, {
      ...auditContextFromRequest(request),
      actorId: request.auth.userId,
    }),
    undefined,
    201,
  );
}

export async function reversePaymentHandler(request: AuthenticatedRequest, response: Response) {
  ok(
    response,
    await reversePayment(
      String(request.params.id),
      request.body.reason,
      auditContextFromRequest(request),
    ),
  );
}

export async function listCashHeldHandler(_request: AuthenticatedRequest, response: Response) {
  ok(response, await listStaffCashHeld());
}

export async function createCashSubmissionHandler(
  request: AuthenticatedRequest,
  response: Response,
) {
  ok(response, await submitCash(request.body, auditContextFromRequest(request)), undefined, 201);
}

export async function listCashSubmissionsHandler(
  request: AuthenticatedRequest,
  response: Response,
) {
  const listQuery = listQueryFromRequest(request.query);
  const result = await listCashSubmissions(listQuery);
  ok(response, result.items, result.meta);
}

export async function createPayoutHandler(request: AuthenticatedRequest, response: Response) {
  ok(response, await createPayout(request.body, auditContextFromRequest(request)), undefined, 201);
}

export async function listPayoutsHandler(request: AuthenticatedRequest, response: Response) {
  const listQuery = listQueryFromRequest(request.query);
  const result = await listPayouts(listQuery);
  ok(response, result.items, result.meta);
}

export async function listCorrectionsHandler(request: AuthenticatedRequest, response: Response) {
  const listQuery = listQueryFromRequest(request.query);
  const result = await listCorrections(listQuery);
  ok(response, result.items, result.meta);
}

export async function listAuditLogsHandler(request: AuthenticatedRequest, response: Response) {
  const listQuery = listQueryFromRequest(request.query);
  const result = await listAuditLogs(listQuery);
  ok(response, result.items, result.meta);
}

export async function reviewCorrectionHandler(request: AuthenticatedRequest, response: Response) {
  ok(
    response,
    await reviewCorrection(
      String(request.params.id),
      request.body.decision,
      request.body.reviewNotes,
      auditContextFromRequest(request),
    ),
  );
}

export async function listExceptionsHandler(request: AuthenticatedRequest, response: Response) {
  const listQuery = listQueryFromRequest(request.query);
  const result = await listFinancialExceptions(listQuery, {
    status: request.query.status ? String(request.query.status) : undefined,
    severity: request.query.severity ? String(request.query.severity) : undefined,
    type: request.query.type ? String(request.query.type) : undefined,
    agingBucket: request.query.agingBucket ? String(request.query.agingBucket) : undefined,
  });
  ok(response, result.items, result.meta);
}

export async function getExceptionHandler(request: AuthenticatedRequest, response: Response) {
  ok(response, await getFinancialExceptionDetail(String(request.params.id)));
}

export async function acknowledgeExceptionHandler(
  request: AuthenticatedRequest,
  response: Response,
) {
  ok(
    response,
    await acknowledgeFinancialException(
      String(request.params.id),
      { ...auditContextFromRequest(request), actorId: request.auth.userId },
      request.body?.notes,
    ),
  );
}

export async function resolveExceptionHandler(request: AuthenticatedRequest, response: Response) {
  ok(
    response,
    await resolveFinancialException(
      String(request.params.id),
      request.body,
      { ...auditContextFromRequest(request), actorId: request.auth.userId },
    ),
  );
}

export async function createSuspenseHandler(request: AuthenticatedRequest, response: Response) {
  ok(
    response,
    await createSuspenseEntry(request.body, {
      ...auditContextFromRequest(request),
      actorId: request.auth.userId,
    }),
    undefined,
    201,
  );
}

export async function listSuspenseHandler(request: AuthenticatedRequest, response: Response) {
  const listQuery = listQueryFromRequest(request.query);
  const result = await listSuspenseEntries(listQuery);
  ok(response, result.items, result.meta);
}

export async function resolveSuspenseHandler(request: AuthenticatedRequest, response: Response) {
  ok(
    response,
    await resolveSuspenseEntry(String(request.params.id), request.body, {
      ...auditContextFromRequest(request),
      actorId: request.auth.userId,
    }),
  );
}

export async function createDisputeHandler(request: AuthenticatedRequest, response: Response) {
  ok(
    response,
    await createDisputeCase(request.body, {
      ...auditContextFromRequest(request),
      actorId: request.auth.userId,
    }),
    undefined,
    201,
  );
}

export async function listDisputesHandler(request: AuthenticatedRequest, response: Response) {
  const listQuery = listQueryFromRequest(request.query);
  const result = await listDisputeCases(listQuery);
  ok(response, result.items, result.meta);
}

export async function getDisputeHandler(request: AuthenticatedRequest, response: Response) {
  ok(response, await getDisputeCaseDetail(String(request.params.id)));
}

export async function updateDisputeHandler(request: AuthenticatedRequest, response: Response) {
  ok(
    response,
    await updateDisputeCase(String(request.params.id), request.body, {
      ...auditContextFromRequest(request),
      actorId: request.auth.userId,
    }),
  );
}

export async function createGatewaySettlementHandler(
  request: AuthenticatedRequest,
  response: Response,
) {
  ok(
    response,
    await createGatewaySettlement(request.body, {
      ...auditContextFromRequest(request),
      actorId: request.auth.userId,
    }),
    undefined,
    201,
  );
}

export async function listGatewaySettlementsHandler(
  request: AuthenticatedRequest,
  response: Response,
) {
  const listQuery = listQueryFromRequest(request.query);
  const result = await listGatewaySettlements(listQuery);
  ok(response, result.items, result.meta);
}

export async function getGatewaySettlementHandler(
  request: AuthenticatedRequest,
  response: Response,
) {
  ok(response, await getGatewaySettlementDetail(String(request.params.id)));
}

export async function confirmGatewaySettlementHandler(
  request: AuthenticatedRequest,
  response: Response,
) {
  ok(
    response,
    await confirmGatewaySettlementBankCredit(String(request.params.id), request.body, {
      ...auditContextFromRequest(request),
      actorId: request.auth.userId,
    }),
  );
}

export async function closeGatewaySettlementHandler(
  request: AuthenticatedRequest,
  response: Response,
) {
  ok(
    response,
    await closeGatewaySettlement(String(request.params.id), request.body ?? {}, {
      ...auditContextFromRequest(request),
      actorId: request.auth.userId,
    }),
  );
}

export async function gatewaySettlementSummaryHandler(
  request: AuthenticatedRequest,
  response: Response,
) {
  ok(response, await getGatewaySettlementLedgerSummary());
}

export async function createGoldInventoryMovementHandler(
  request: AuthenticatedRequest,
  response: Response,
) {
  ok(
    response,
    await recordGoldInventoryMovement(request.body, {
      ...auditContextFromRequest(request),
      actorId: request.auth.userId,
    }),
    undefined,
    201,
  );
}

export async function listGoldInventoryMovementsHandler(
  request: AuthenticatedRequest,
  response: Response,
) {
  const listQuery = listQueryFromRequest(request.query);
  const result = await listGoldInventoryMovements(listQuery);
  ok(response, result.items, result.meta);
}

export async function goldControlSummaryHandler(
  _request: AuthenticatedRequest,
  response: Response,
) {
  ok(response, await getGoldControlSummary());
}

export async function goldLiabilityMovementsHandler(
  request: AuthenticatedRequest,
  response: Response,
) {
  const from = request.query.from ? new Date(String(request.query.from)) : undefined;
  const to = request.query.to ? new Date(String(request.query.to)) : undefined;
  ok(response, await getGoldLiabilityMovements(from, to));
}

export async function listAccountingPeriodsHandler(
  _request: AuthenticatedRequest,
  response: Response,
) {
  ok(response, await listAccountingPeriods());
}

export async function getAccountingPeriodHandler(
  request: AuthenticatedRequest,
  response: Response,
) {
  ok(response, await getPeriodSummary(String(request.params.periodKey)));
}

export async function closeAccountingPeriodHandler(
  request: AuthenticatedRequest,
  response: Response,
) {
  ok(
    response,
    await closeAccountingPeriod(String(request.params.periodKey), request.body ?? {}, {
      ...auditContextFromRequest(request),
      actorId: request.auth.userId,
    }),
  );
}

export async function reopenAccountingPeriodHandler(
  request: AuthenticatedRequest,
  response: Response,
) {
  ok(
    response,
    await reopenAccountingPeriod(String(request.params.periodKey), request.body.reason, {
      ...auditContextFromRequest(request),
      actorId: request.auth.userId,
    }),
  );
}
