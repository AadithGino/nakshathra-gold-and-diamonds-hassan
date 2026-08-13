import type { Response } from 'express';
import { ok } from '../../utils/respond.js';
import type { AuthenticatedRequest } from '../../types/authenticated-request.js';
import { initiatePhonePe, initiatePhonePeSdkOrder } from '../../services/gateway.service.js';
import { getOwnedCustomer } from '../../services/customer-access.service.js';
import {
  getCustomerPaymentIntent,
  getCustomerHome,
  getCustomerPaymentPreview,
  getOwnedReceipt,
  getOwnedSchemeDetails,
  listCustomerNotifications,
  listCustomerGoldRates,
  listCustomerPayments,
  listCustomerPayouts,
  listCustomerSchemes,
} from '../../services/customer-portal.service.js';
import { listQueryFromRequest } from '../../utils/cursor-pagination.js';
import { customerPaymentPreviewQuerySchema } from '../../validators/customer-portal.validators.js';

export async function getHomeHandler(request: AuthenticatedRequest, response: Response) {
  ok(response, await getCustomerHome(request.auth.userId));
}

export async function listSchemesHandler(request: AuthenticatedRequest, response: Response) {
  ok(response, await listCustomerSchemes(request.auth.userId));
}

export async function getSchemeHandler(request: AuthenticatedRequest, response: Response) {
  ok(response, await getOwnedSchemeDetails(request.auth.userId, String(request.params.id)));
}

export async function previewCustomerPaymentHandler(
  request: AuthenticatedRequest,
  response: Response,
) {
  const query = customerPaymentPreviewQuerySchema.parse(request.query);
  ok(
    response,
    await getCustomerPaymentPreview(
      request.auth.userId,
      String(request.params.id),
      query.amountPaise,
      query.schemeMonth,
    ),
  );
}

export async function listPaymentsHandler(request: AuthenticatedRequest, response: Response) {
  const listQuery = listQueryFromRequest(request.query);
  const result = await listCustomerPayments(request.auth.userId, listQuery);
  ok(response, result.items, result.meta);
}

export async function listGoldRatesHandler(request: AuthenticatedRequest, response: Response) {
  ok(response, await listCustomerGoldRates(request.auth.userId));
}

export async function getReceiptHandler(request: AuthenticatedRequest, response: Response) {
  ok(response, await getOwnedReceipt(request.auth.userId, String(request.params.id)));
}

export async function initiatePhonePeHandler(request: AuthenticatedRequest, response: Response) {
  ok(
    response,
    await initiatePhonePe(
      request.auth.userId,
      request.body,
      String(request.id),
      request.get('origin') ?? undefined,
    ),
    undefined,
    201,
  );
}

export async function initiatePhonePeSdkOrderHandler(
  request: AuthenticatedRequest,
  response: Response,
) {
  ok(
    response,
    await initiatePhonePeSdkOrder(request.auth.userId, request.body, String(request.id)),
    undefined,
    201,
  );
}

export async function getPaymentIntentHandler(request: AuthenticatedRequest, response: Response) {
  ok(
    response,
    await getCustomerPaymentIntent(
      request.auth.userId,
      String(request.params.orderId),
      String(request.id),
    ),
  );
}

export async function listPayoutsHandler(request: AuthenticatedRequest, response: Response) {
  const listQuery = listQueryFromRequest(request.query);
  const result = await listCustomerPayouts(request.auth.userId, listQuery);
  ok(response, result.items, result.meta);
}

export async function listNotificationsHandler(request: AuthenticatedRequest, response: Response) {
  const listQuery = listQueryFromRequest(request.query);
  const result = await listCustomerNotifications(request.auth.userId, listQuery);
  ok(response, result.items, result.meta);
}

export async function getProfileHandler(request: AuthenticatedRequest, response: Response) {
  ok(response, await getOwnedCustomer(request.auth.userId));
}
