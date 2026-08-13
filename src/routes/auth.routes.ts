import { Router } from 'express';
import { asyncHandler } from '../utils/asyncHandler.js';
import { authenticate } from '../middlewares/auth.middleware.js';
import { validateBody } from '../middlewares/validate.middleware.js';
import { loginSchema } from '../validators/auth.validators.js';
import { authRateLimit } from '../middlewares/rate-limit.middleware.js';
import {
  currentSessionHandler,
  loginHandler,
  logoutHandler,
  refreshHandler,
} from '../controllers/auth.controller.js';

const authRouter = Router();
authRouter.post('/login', authRateLimit, validateBody(loginSchema), asyncHandler(loginHandler));
authRouter.post('/refresh', asyncHandler(refreshHandler));
authRouter.post('/logout', asyncHandler(logoutHandler));
authRouter.get('/me', authenticate, asyncHandler(currentSessionHandler));

export default authRouter;
