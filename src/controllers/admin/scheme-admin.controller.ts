import type { Response } from "express";
import { ok } from "../../utils/respond.js";
import type { AuthenticatedRequest } from "../../types/authenticated-request.js";
import { auditContextFromRequest } from "../../types/authenticated-request.js";
import { listQueryFromRequest } from "../../utils/cursor-pagination.js";
import { parseSettlementAsset } from "../../services/scheme-settlement.service.js";
import type { EnrollmentListFilters } from "../../services/enrollment-collection.service.js";
import {
  cancelEnrollment,
  createEnrollment,
  createGoldRate,
  createSchemePlan,
  getEnrollmentDetails,
  getSchemePlan,
  listDueCollection,
  listEnrollments,
  listGoldRates,
  getGoldRate,
  listOverdueCollection,
  listRedemptionReadyCollection,
  getMaturityCalendar,
  listSchemePlans,
  prematureCloseEnrollment,
  previewPrematureClosure,
  previewRedemption,
  updateEnrollmentStatus,
  updateGoldRate,
  updateSchemePlan,
} from "../../services/scheme-management.service.js";
import { previewAdminContributionPayment } from "../../services/contribution-status.service.js";
import {
  adminPaymentPreviewQuerySchema,
  maturityCalendarQuerySchema,
} from "../../validators/admin-scheme.validators.js";
import { AppError } from "../../utils/AppError.js";
import { reportDate } from "../../utils/report-date.js";

function optionalDate(value: unknown) {
  if (value == null || String(value).trim() === "") return undefined;
  const date = new Date(String(value));
  return Number.isNaN(date.getTime()) ? undefined : date;
}

function optionalInt(value: unknown) {
  if (value == null || String(value).trim() === "") return undefined;
  const parsed = Number(value);
  return Number.isInteger(parsed) ? parsed : undefined;
}

function optionalBool(value: unknown) {
  if (value == null || String(value).trim() === "") return undefined;
  if (value === true || String(value) === "true") return true;
  if (value === false || String(value) === "false") return false;
  return undefined;
}

function enrollmentFiltersFromQuery(query: Record<string, unknown>): EnrollmentListFilters {
  const installmentStatus = String(query.installmentStatus ?? "").trim();
  return {
    status: query.status ? String(query.status) : undefined,
    schemePlanId: query.schemePlanId ? String(query.schemePlanId) : undefined,
    customerId: query.customerId ? String(query.customerId) : undefined,
    schemeType: query.schemeType ? String(query.schemeType) : undefined,
    search: query.search ? String(query.search).trim() : undefined,
    startDateFrom: optionalDate(query.startDateFrom),
    startDateTo: optionalDate(query.startDateTo),
    maturityFrom: optionalDate(query.maturityFrom),
    maturityTo: optionalDate(query.maturityTo),
    installmentStatus:
      installmentStatus === "PAID" ||
      installmentStatus === "DUE" ||
      installmentStatus === "OVERDUE" ||
      installmentStatus === "UPCOMING"
        ? installmentStatus
        : undefined,
    redemptionReady: optionalBool(query.redemptionReady),
    prematureClosureEligible: optionalBool(query.prematureClosureEligible),
    paymentsCompletedMin: optionalInt(query.paymentsCompletedMin),
    paymentsCompletedMax: optionalInt(query.paymentsCompletedMax),
  };
}

export async function createSchemePlanHandler(
  request: AuthenticatedRequest,
  response: Response,
) {
  ok(
    response,
    await createSchemePlan(request.body, auditContextFromRequest(request)),
    undefined,
    201,
  );
}

export async function listSchemePlansHandler(
  _request: AuthenticatedRequest,
  response: Response,
) {
  ok(response, await listSchemePlans());
}

export async function getSchemePlanHandler(
  request: AuthenticatedRequest,
  response: Response,
) {
  ok(response, await getSchemePlan(String(request.params.id)));
}

export async function updateSchemePlanHandler(
  request: AuthenticatedRequest,
  response: Response,
) {
  ok(
    response,
    await updateSchemePlan(
      String(request.params.id),
      request.body,
      auditContextFromRequest(request),
    ),
  );
}

export async function createEnrollmentHandler(
  request: AuthenticatedRequest,
  response: Response,
) {
  ok(
    response,
    await createEnrollment(request.body, auditContextFromRequest(request)),
    undefined,
    201,
  );
}

export async function listEnrollmentsHandler(
  request: AuthenticatedRequest,
  response: Response,
) {
  const listQuery = listQueryFromRequest(request.query);
  const result = await listEnrollments(
    listQuery,
    enrollmentFiltersFromQuery(request.query as Record<string, unknown>),
  );
  ok(response, result.items, result.meta);
}

export async function listOverdueEnrollmentsHandler(
  request: AuthenticatedRequest,
  response: Response,
) {
  const listQuery = listQueryFromRequest(request.query);
  const sortRaw = String(request.query.sort ?? "oldest");
  const sort =
    sortRaw === "newest" || sortRaw === "highestAmount" ? sortRaw : "oldest";
  const result = await listOverdueCollection(listQuery, {
    ...enrollmentFiltersFromQuery(request.query as Record<string, unknown>),
    minDaysOverdue: optionalInt(request.query.minDaysOverdue),
    maxDaysOverdue: optionalInt(request.query.maxDaysOverdue),
    sort,
  } as EnrollmentListFilters & {
    minDaysOverdue?: number;
    maxDaysOverdue?: number;
    sort?: "oldest" | "newest" | "highestAmount";
  });
  ok(response, result.items, result.meta);
}

export async function listDueEnrollmentsHandler(
  request: AuthenticatedRequest,
  response: Response,
) {
  const listQuery = listQueryFromRequest(request.query);
  const result = await listDueCollection(
    listQuery,
    enrollmentFiltersFromQuery(request.query as Record<string, unknown>),
  );
  ok(response, result.items, result.meta);
}

export async function listRedemptionReadyHandler(
  request: AuthenticatedRequest,
  response: Response,
) {
  const listQuery = listQueryFromRequest(request.query);
  const result = await listRedemptionReadyCollection(
    listQuery,
    enrollmentFiltersFromQuery(request.query as Record<string, unknown>),
  );
  ok(response, result.items, result.meta);
}

export async function maturityCalendarHandler(
  request: AuthenticatedRequest,
  response: Response,
) {
  const query = maturityCalendarQuerySchema.parse(request.query);
  const from = reportDate(query.from) ?? new Date();
  const to = reportDate(query.to, true) ?? new Date(from.getTime() + 366 * 86_400_000);
  if (from > to) {
    throw new AppError(
      "VALIDATION_ERROR",
      "Maturity calendar start date must be before or equal to end date",
      422,
    );
  }
  const result = await getMaturityCalendar({
    from,
    to,
    status: query.status ? [query.status] : undefined,
    schemeType: query.schemeType,
  });
  ok(response, result.items, {
    from: result.from.toISOString(),
    to: result.to.toISOString(),
    total: result.items.length,
  });
}

export async function enrollmentPaymentPreviewHandler(
  request: AuthenticatedRequest,
  response: Response,
) {
  const query = adminPaymentPreviewQuerySchema.parse(request.query);
  ok(
    response,
    await previewAdminContributionPayment(
      String(request.params.id),
      query.amountPaise,
      query.paymentDate ?? new Date(),
      query.schemeMonth,
    ),
  );
}

export async function getEnrollmentHandler(
  request: AuthenticatedRequest,
  response: Response,
) {
  ok(response, await getEnrollmentDetails(String(request.params.id)));
}

export async function updateEnrollmentStatusHandler(
  request: AuthenticatedRequest,
  response: Response,
) {
  ok(
    response,
    await updateEnrollmentStatus(
      String(request.params.id),
      request.body.status,
      request.body.reason,
      auditContextFromRequest(request),
    ),
  );
}

export async function cancelEnrollmentHandler(
  request: AuthenticatedRequest,
  response: Response,
) {
  ok(
    response,
    await cancelEnrollment(
      String(request.params.id),
      request.body.reason,
      auditContextFromRequest(request),
    ),
  );
}

export async function prematureClosurePreviewHandler(
  request: AuthenticatedRequest,
  response: Response,
) {
  const asset = parseSettlementAsset(request.query.settlementAsset);
  ok(
    response,
    await previewPrematureClosure(String(request.params.id), asset),
  );
}

export async function prematureCloseHandler(
  request: AuthenticatedRequest,
  response: Response,
) {
  ok(
    response,
    await prematureCloseEnrollment(
      String(request.params.id),
      request.body,
      auditContextFromRequest(request),
    ),
    undefined,
    201,
  );
}

export async function redemptionPreviewHandler(
  request: AuthenticatedRequest,
  response: Response,
) {
  const asset = parseSettlementAsset(request.query.settlementAsset);
  ok(
    response,
    await previewRedemption(String(request.params.id), asset),
  );
}

export async function createGoldRateHandler(
  request: AuthenticatedRequest,
  response: Response,
) {
  ok(
    response,
    await createGoldRate(request.body, auditContextFromRequest(request)),
    undefined,
    201,
  );
}

export async function listGoldRatesHandler(
  _request: AuthenticatedRequest,
  response: Response,
) {
  ok(response, await listGoldRates());
}

export async function getGoldRateHandler(
  request: AuthenticatedRequest,
  response: Response,
) {
  ok(response, await getGoldRate(String(request.params.id)));
}

export async function updateGoldRateHandler(
  request: AuthenticatedRequest,
  response: Response,
) {
  ok(
    response,
    await updateGoldRate(
      String(request.params.id),
      request.body,
      auditContextFromRequest(request),
    ),
  );
}
