import type { Request, Response } from 'express';
import { ok } from '../../utils/respond.js';
import { financialDashboard } from '../../services/report.service.js';

export async function getDashboard(_request: Request, response: Response) {
  ok(response, await financialDashboard());
}
