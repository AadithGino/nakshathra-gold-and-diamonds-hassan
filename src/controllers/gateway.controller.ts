import type { Request, Response } from 'express';
import { ok } from '../utils/respond.js';
import { processPhonePeWebhook } from '../services/gateway.service.js';

export async function phonePeWebhookHandler(request: Request, response: Response) {
  const rawBody = request.rawBody ?? Buffer.from(JSON.stringify(request.body));
  ok(
    response,
    await processPhonePeWebhook(request.get('authorization'), rawBody, String(request.id)),
  );
}
