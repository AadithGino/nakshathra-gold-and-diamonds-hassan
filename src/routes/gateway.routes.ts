import { Router } from 'express';
import { asyncHandler } from '../utils/asyncHandler.js';
import { phonePeWebhookHandler } from '../controllers/gateway.controller.js';

const gatewayRouter = Router();

gatewayRouter.post('/phonepe', asyncHandler(phonePeWebhookHandler));

export default gatewayRouter;
