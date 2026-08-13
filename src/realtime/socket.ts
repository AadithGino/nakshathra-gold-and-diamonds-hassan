import type { Server as HttpServer } from 'node:http';
import { Server, type Socket } from 'socket.io';
import { env } from '../config/env.js';
import { logger } from '../config/logger.js';
import { assertAccessSession, verifyAccess } from '../services/auth.service.js';
import { activeGoldRate } from '../services/scheme.service.js';
import { AppError } from '../utils/AppError.js';

export const GOLD_RATE_ROOM = 'gold-rates';
export const GOLD_RATE_UPDATED_EVENT = 'gold-rate:updated';
export const GOLD_RATE_CURRENT_EVENT = 'gold-rate:current';

export type GoldRateSocketPayload = {
  id: string;
  ratePerGramPaise: number;
  purity: string;
  effectiveFrom: string;
  status: 'ACTIVE' | 'INACTIVE';
  updatedAt: string;
  notes?: string;
};

export type GoldRateBroadcast = {
  rate: GoldRateSocketPayload;
  /** Today's board rate after the change (null when none published for today). */
  currentActive: GoldRateSocketPayload | null;
  publishedAt: string;
};

let io: Server | undefined;

function parseCookies(header?: string): Record<string, string> {
  if (!header) return {};
  const out: Record<string, string> = {};
  for (const part of header.split(';')) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim();
    try {
      out[key] = decodeURIComponent(value);
    } catch {
      out[key] = value;
    }
  }
  return out;
}

export function toGoldRateSocketPayload(rate: {
  _id: unknown;
  ratePerGramPaise: number;
  purity?: string;
  effectiveFrom: Date;
  status: string;
  updatedAt?: Date;
  createdAt?: Date;
  notes?: string;
}): GoldRateSocketPayload {
  return {
    id: String(rate._id),
    ratePerGramPaise: rate.ratePerGramPaise,
    purity: rate.purity ?? '916',
    effectiveFrom: new Date(rate.effectiveFrom).toISOString(),
    status: rate.status === 'INACTIVE' ? 'INACTIVE' : 'ACTIVE',
    updatedAt: new Date(rate.updatedAt ?? rate.createdAt ?? Date.now()).toISOString(),
    ...(rate.notes ? { notes: rate.notes } : {}),
  };
}

async function resolveCurrentActivePayload(): Promise<GoldRateSocketPayload | null> {
  try {
    const rate = await activeGoldRate(new Date());
    const plain =
      typeof (rate as { toObject?: () => unknown }).toObject === 'function'
        ? (rate as { toObject: () => Parameters<typeof toGoldRateSocketPayload>[0] }).toObject()
        : (rate as Parameters<typeof toGoldRateSocketPayload>[0]);
    return toGoldRateSocketPayload(plain);
  } catch {
    return null;
  }
}

export async function authenticateSocket(socket: Socket) {
  const cookies = parseCookies(socket.handshake.headers.cookie);
  const token = cookies.access_token;
  if (!token) {
    throw new Error('AUTHENTICATION_REQUIRED');
  }
  let claims: ReturnType<typeof verifyAccess>;
  try {
    claims = verifyAccess(token);
    await assertAccessSession(claims);
  } catch (error) {
    if (error instanceof AppError) throw new Error(error.code);
    throw error;
  }
  if (!['CUSTOMER', 'ADMIN', 'STAFF'].includes(claims.role)) {
    throw new Error('PERMISSION_DENIED');
  }
  socket.data.auth = {
    userId: claims.sub,
    role: claims.role,
  };
}

export function initSocketServer(httpServer: HttpServer) {
  if (io) return io;

  io = new Server(httpServer, {
    path: '/socket.io',
    cors: {
      origin: (origin, callback) => {
        if (!origin || env.origins.includes(origin)) {
          callback(null, true);
          return;
        }
        callback(new Error('CORS_ORIGIN_DENIED'), false);
      },
      credentials: true,
    },
    // Allow polling-first clients; websocket upgrade needs proxy Upgrade headers.
    transports: ['polling', 'websocket'],
  });

  io.use((socket, next) => {
    void authenticateSocket(socket)
      .then(() => next())
      .catch((error: unknown) => {
        const message = String((error as { message?: string })?.message ?? error);
        logger.warn({ err: error, socketId: socket.id }, 'socket auth failed');
        next(new Error(message));
      });
  });

  io.on('connection', (socket) => {
    const auth = socket.data.auth as { userId?: string; role?: string } | undefined;
    logger.info(
      { socketId: socket.id, userId: auth?.userId, role: auth?.role },
      'socket connected',
    );
    void socket.join(GOLD_RATE_ROOM);

    void resolveCurrentActivePayload()
      .then((currentActive) => {
        socket.emit(GOLD_RATE_CURRENT_EVENT, {
          currentActive,
          publishedAt: new Date().toISOString(),
        });
      })
      .catch((error) => {
        logger.warn({ err: error, socketId: socket.id }, 'socket current gold rate emit failed');
      });

    socket.on('gold-rate:subscribe', () => {
      void socket.join(GOLD_RATE_ROOM);
    });

    socket.on('disconnect', (reason) => {
      logger.info({ socketId: socket.id, reason }, 'socket disconnected');
    });
  });

  logger.info({ path: '/socket.io', origins: env.origins }, 'Socket.IO ready');
  return io;
}

export function getSocketServer() {
  return io;
}

export async function publishGoldRateChange(rate: {
  _id: unknown;
  ratePerGramPaise: number;
  purity?: string;
  effectiveFrom: Date;
  status: string;
  updatedAt?: Date;
  createdAt?: Date;
  notes?: string;
}) {
  if (!io) return;
  const payload: GoldRateBroadcast = {
    rate: toGoldRateSocketPayload(rate),
    currentActive: await resolveCurrentActivePayload(),
    publishedAt: new Date().toISOString(),
  };
  io.to(GOLD_RATE_ROOM).emit(GOLD_RATE_UPDATED_EVENT, payload);
  logger.info(
    {
      rateId: payload.rate.id,
      status: payload.rate.status,
      currentActiveId: payload.currentActive?.id ?? null,
    },
    'gold-rate:updated broadcast',
  );
}

export async function closeSocketServer() {
  if (!io) return;
  const current = io;
  io = undefined;
  await new Promise<void>((resolve) => {
    current.close(() => resolve());
  });
}
