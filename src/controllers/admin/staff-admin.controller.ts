import type { Response } from 'express';
import { ok } from '../../utils/respond.js';
import type { AuthenticatedRequest } from '../../types/authenticated-request.js';
import { auditContextFromRequest } from '../../types/authenticated-request.js';
import { listQueryFromRequest } from '../../utils/cursor-pagination.js';
import {
  createStaff,
  getStaffDetails,
  listStaff,
  resetUserPassword,
  updateStaff,
  updateUserStatus,
} from '../../services/staff.service.js';
import { AppError } from '../../utils/AppError.js';
import { reportDate } from '../../utils/report-date.js';

export async function createStaffHandler(request: AuthenticatedRequest, response: Response) {
  const data = await createStaff(request.body, auditContextFromRequest(request));
  ok(response, data, undefined, 201);
}

export async function listStaffHandler(request: AuthenticatedRequest, response: Response) {
  const listQuery = listQueryFromRequest(request.query);
  const search = String(request.query.search ?? '').trim();
  const result = await listStaff(listQuery, search);
  ok(response, result.items, result.meta);
}

export async function getStaffHandler(request: AuthenticatedRequest, response: Response) {
  const from = reportDate(request.query.from);
  const to = reportDate(request.query.to, true);
  if (from && to && from > to)
    throw new AppError('VALIDATION_ERROR', 'Report start date must be before end date', 422);
  ok(response, await getStaffDetails(String(request.params.id), from, to));
}

export async function updateStaffHandler(request: AuthenticatedRequest, response: Response) {
  ok(
    response,
    await updateStaff(String(request.params.id), request.body, auditContextFromRequest(request)),
  );
}

export async function updateUserStatusHandler(request: AuthenticatedRequest, response: Response) {
  ok(
    response,
    await updateUserStatus(
      String(request.params.id),
      request.body.status,
      auditContextFromRequest(request),
    ),
  );
}

export async function resetPasswordHandler(request: AuthenticatedRequest, response: Response) {
  ok(
    response,
    await resetUserPassword(
      String(request.params.id),
      request.body.newPassword,
      auditContextFromRequest(request),
    ),
  );
}
