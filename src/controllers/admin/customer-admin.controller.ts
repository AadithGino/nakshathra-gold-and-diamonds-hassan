import type { Response } from 'express';
import { ok } from '../../utils/respond.js';
import type { AuthenticatedRequest } from '../../types/authenticated-request.js';
import { auditContextFromRequest } from '../../types/authenticated-request.js';
import { listQueryFromRequest } from '../../utils/cursor-pagination.js';
import {
  createCustomer,
  getCustomerDetails,
  listCustomers,
  rejectCustomerKyc,
  updateCustomer,
  verifyCustomerKyc,
} from '../../services/customer.service.js';
import { resetUserPassword } from '../../services/staff.service.js';
import { getActiveEnrollmentForCustomer } from '../../services/scheme-management.service.js';

export async function createCustomerHandler(request: AuthenticatedRequest, response: Response) {
  const data = await createCustomer(request.body, auditContextFromRequest(request));
  ok(response, data, undefined, 201);
}

export async function listCustomersHandler(request: AuthenticatedRequest, response: Response) {
  const listQuery = listQueryFromRequest(request.query);
  const search = String(request.query.search ?? '').trim();
  const result = await listCustomers(listQuery, search);
  ok(response, result.items, result.meta);
}

export async function getCustomerHandler(request: AuthenticatedRequest, response: Response) {
  ok(response, await getCustomerDetails(String(request.params.id)));
}

export async function getActiveEnrollmentHandler(
  request: AuthenticatedRequest,
  response: Response,
) {
  ok(response, await getActiveEnrollmentForCustomer(String(request.params.id)));
}

export async function updateCustomerHandler(request: AuthenticatedRequest, response: Response) {
  ok(
    response,
    await updateCustomer(String(request.params.id), request.body, auditContextFromRequest(request)),
  );
}

export async function resetCustomerPasswordHandler(
  request: AuthenticatedRequest,
  response: Response,
) {
  const details = await getCustomerDetails(String(request.params.id));
  const userId = String((details.customer as any).userId?._id ?? (details.customer as any).userId);
  ok(
    response,
    await resetUserPassword(userId, request.body.newPassword, auditContextFromRequest(request)),
  );
}

export async function verifyCustomerKycHandler(
  request: AuthenticatedRequest,
  response: Response,
) {
  ok(
    response,
    await verifyCustomerKyc(String(request.params.id), auditContextFromRequest(request)),
  );
}

export async function rejectCustomerKycHandler(
  request: AuthenticatedRequest,
  response: Response,
) {
  ok(
    response,
    await rejectCustomerKyc(
      String(request.params.id),
      request.body.reason,
      auditContextFromRequest(request),
    ),
  );
}
