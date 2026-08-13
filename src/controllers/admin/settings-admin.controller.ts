import type { Response } from 'express';
import { getSettings, updateSettings } from '../../services/settings.service.js';
import type { AuthenticatedRequest } from '../../types/authenticated-request.js';
import { auditContextFromRequest } from '../../types/authenticated-request.js';
import { ok } from '../../utils/respond.js';

export async function getSettingsHandler(_request: AuthenticatedRequest, response: Response) {
  ok(response, await getSettings());
}

export async function updateSettingsHandler(request: AuthenticatedRequest, response: Response) {
  ok(response, await updateSettings(request.body, auditContextFromRequest(request)));
}
