import type { Request } from 'express';
import { ipKeyGenerator, rateLimit } from 'express-rate-limit';

const clientKey = (request: Request) => {
  const address =
    request.ip ||
    request.socket.remoteAddress ||
    request.get('cf-connecting-ip') ||
    request.get('x-real-ip') ||
    'unknown';
  return address === 'unknown' ? address : ipKeyGenerator(address);
};

const limiter = (windowMs: number, limit: number) =>
  rateLimit({
    windowMs,
    limit,
    keyGenerator: clientKey,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
  });

export const generalRateLimit = limiter(60_000, 300);
export const authRateLimit = limiter(15 * 60_000, 20);
