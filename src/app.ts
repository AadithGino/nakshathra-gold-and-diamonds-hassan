import express from 'express';
import cookieParser from 'cookie-parser';
import cors from 'cors';
import helmet from 'helmet';
import hpp from 'hpp';
import { pinoHttp } from 'pino-http';
import { connectDatabase, isDatabaseReady } from './config/database.js';
import { business } from './config/business.js';
import { env } from './config/env.js';
import { logger } from './config/logger.js';
import { openapi } from './config/openapi.js';
import { errorHandler, notFound } from './middlewares/error-handler.middleware.js';
import { requestContext } from './middlewares/request-context.middleware.js';
import { rejectMongoOperators } from './middlewares/reject-mongo-operators.middleware.js';
import { generalRateLimit } from './middlewares/rate-limit.middleware.js';
import apiRouter from './routes/index.js';

export const app = express();
app.set('trust proxy', 1);
app.disable('x-powered-by');
app.use(requestContext);
app.use(async (_request, _response, next) => {
  try {
    await connectDatabase();
    next();
  } catch (error) {
    next(error);
  }
});
app.use(pinoHttp({ logger, genReqId: (req: any) => (req as any).id }));
app.use(helmet({ crossOriginResourcePolicy: { policy: 'cross-origin' } }));
app.use(
  cors((request, callback) => {
    if (env.CORS_DISABLED) {
      callback(null, { origin: true, credentials: true });
      return;
    }
    const origin = request.get('origin');
    let isSameOrigin = false;
    if (origin) {
      try {
        isSameOrigin = new URL(origin).host === request.get('host');
      } catch {
        isSameOrigin = false;
      }
    }
    callback(null, {
      origin: !origin || isSameOrigin || env.origins.includes(origin),
      credentials: true,
    });
  }),
);
app.use(hpp());
app.use(generalRateLimit);
app.use(
  express.json({
    limit: '256kb',
    verify: (req, _res, buf) => {
      (req as any).rawBody = Buffer.from(buf);
    },
  }),
);
app.use(express.urlencoded({ extended: false, limit: '64kb' }));
app.use(cookieParser());
app.use(rejectMongoOperators);
app.get('/health', (_req, res) => res.json({ status: 'ok', service: business.serviceName }));
app.get('/ready', (_req, res) =>
  isDatabaseReady() ? res.json({ status: 'ready' }) : res.status(503).json({ status: 'not-ready' }),
);
app.get('/api/v1/openapi.json', (_req, res) => res.json(openapi));
app.use('/api/v1', apiRouter);
app.use(notFound);
app.use(errorHandler);
