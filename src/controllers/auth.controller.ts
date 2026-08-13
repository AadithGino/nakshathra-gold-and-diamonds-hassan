import type { Request, Response } from 'express';
import { env } from '../config/env.js';
import { AppError } from '../utils/AppError.js';
import { ok } from '../utils/respond.js';
import { login, logout, refresh } from '../services/auth.service.js';

const requestClient = (request: Request) => ({
  ip: request.ip,
  userAgent: request.get('user-agent'),
});

const cookieBase = {
  httpOnly: true,
  secure: env.COOKIE_SECURE,
  sameSite: 'lax' as const,
  path: '/',
};

const writeSessionCookies = (response: Response, tokens: { access: string; refresh: string }) => {
  response.cookie('access_token', tokens.access, {
    ...cookieBase,
    maxAge: env.ACCESS_TOKEN_TTL_MINUTES * 60_000,
  });
  response.cookie('refresh_token', tokens.refresh, {
    ...cookieBase,
    maxAge: env.REFRESH_TOKEN_TTL_DAYS * 86_400_000,
  });
};

export async function loginHandler(request: Request, response: Response) {
  const input = request.body;
  const result = await login(input.phone, input.password, requestClient(request));
  writeSessionCookies(response, result.tokens);
  ok(response, result.data);
}

export async function refreshHandler(request: Request, response: Response) {
  try {
    const result = await refresh(request.cookies?.refresh_token, requestClient(request));
    writeSessionCookies(response, result.tokens);
    ok(response, result.data);
  } catch (error) {
    if (
      error instanceof AppError &&
      (error.code === 'TOKEN_REUSE_DETECTED' || error.code === 'SESSION_EXPIRED')
    ) {
      response.clearCookie('access_token', cookieBase);
      response.clearCookie('refresh_token', cookieBase);
    }
    throw error;
  }
}

export async function logoutHandler(request: Request, response: Response) {
  await logout(request.cookies?.refresh_token);
  response.clearCookie('access_token', cookieBase);
  response.clearCookie('refresh_token', cookieBase);
  ok(response, { loggedOut: true });
}

export async function currentSessionHandler(request: Request, response: Response) {
  ok(response, request.auth);
}
