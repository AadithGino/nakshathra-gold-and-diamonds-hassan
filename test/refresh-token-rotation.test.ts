import { createHash } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import jwt from 'jsonwebtoken';
import { AuditLog, RefreshSession, User } from '../src/models/index.js';
import { env } from '../src/config/env.js';
import { authenticateSocket } from '../src/realtime/socket.js';
import {
  REFRESH_RACE_GRACE_MS,
  assertAccessSession,
  hashPassword,
  issueSession,
  login,
  logout,
  refresh,
  verifyAccess,
} from '../src/services/auth.service.js';
import { AppError } from '../src/utils/AppError.js';
import { clearTestMongo, startTestMongo, stopTestMongo } from './helpers/mongo.js';

const ctx = { ip: '127.0.0.1', userAgent: 'phase7-browser' };
const otherCtx = { ip: '10.0.0.8', userAgent: 'stolen-client' };

let phoneSeq = 0;
function nextPhone() {
  phoneSeq += 1;
  return `+9171${String(phoneSeq).padStart(8, '0')}`;
}

function sha256(value: string) {
  return createHash('sha256').update(value).digest('hex');
}

async function seedCustomer(overrides?: { status?: 'ACTIVE' | 'INACTIVE'; sessionVersion?: number }) {
  const [user] = await User.create([
    {
      name: 'P7 Customer',
      phone: nextPhone(),
      passwordHash: 'hash',
      role: 'CUSTOMER',
      status: overrides?.status ?? 'ACTIVE',
      sessionVersion: overrides?.sessionVersion ?? 0,
    },
  ]);
  return user;
}

async function sessionByHash(token: string) {
  return RefreshSession.findOne({ tokenHash: sha256(token) });
}

function fakeSocket(accessToken: string) {
  return {
    handshake: { headers: { cookie: `access_token=${accessToken}` } },
    data: {} as { auth?: { userId?: string; role?: string } },
  };
}

describe('Phase 7 refresh token rotation', () => {
  beforeAll(async () => {
    await startTestMongo();
  });

  afterAll(async () => {
    await stopTestMongo();
  });

  beforeEach(async () => {
    await clearTestMongo();
  });

  afterEach(async () => {
    await clearTestMongo();
  });

  it('login issues access and refresh tokens', async () => {
    const password = 'LoginPass123!';
    const phone = nextPhone();
    await User.create([
      {
        name: 'P7 Login',
        phone,
        passwordHash: await hashPassword(password),
        role: 'CUSTOMER',
        status: 'ACTIVE',
      },
    ]);

    const result = await login(phone, password, ctx);
    expect(result.tokens.access).toBeTruthy();
    expect(result.tokens.refresh).toBeTruthy();
    expect(result.tokens.access).not.toBe(result.tokens.refresh);

    const accessClaims = jwt.verify(result.tokens.access, env.JWT_ACCESS_SECRET) as {
      type: string;
    };
    const refreshClaims = jwt.verify(result.tokens.refresh, env.JWT_REFRESH_SECRET) as {
      type: string;
    };
    expect(accessClaims.type).toBe('access');
    expect(refreshClaims.type).toBe('refresh');

    const stored = await sessionByHash(result.tokens.refresh);
    expect(stored).toBeTruthy();
    expect(stored?.usedAt).toBeFalsy();
    expect(stored?.familyId).toBeTruthy();
  }, 20_000);

  it('first refresh succeeds, stores a new hash, and consumes the old session', async () => {
    const user = await seedCustomer();
    const issued = await issueSession(user, ctx);
    const rotated = await refresh(issued.tokens.refresh, ctx);

    expect(rotated.tokens.refresh).not.toBe(issued.tokens.refresh);
    expect(rotated.tokens.access).not.toBe(issued.tokens.access);

    const oldRow = await sessionByHash(issued.tokens.refresh);
    const newRow = await sessionByHash(rotated.tokens.refresh);
    expect(oldRow?.usedAt).toBeTruthy();
    expect(oldRow?.revokedAt).toBeFalsy();
    expect(String(oldRow?.replacedBySessionId)).toBe(String(newRow?._id));
    expect(newRow?.usedAt).toBeFalsy();
    expect(newRow?.familyId).toBe(oldRow?.familyId);
    expect(newRow?.tokenHash).toBe(sha256(rotated.tokens.refresh));
    expect(newRow?.tokenHash).not.toBe(oldRow?.tokenHash);
  });

  it('the new refresh token can itself be rotated', async () => {
    const user = await seedCustomer();
    const issued = await issueSession(user, ctx);
    const first = await refresh(issued.tokens.refresh, ctx);
    const second = await refresh(first.tokens.refresh, ctx);

    expect(second.tokens.refresh).not.toBe(first.tokens.refresh);
    const live = await sessionByHash(second.tokens.refresh);
    expect(live?.usedAt).toBeFalsy();
    expect(live?.revokedAt).toBeFalsy();
  });

  it('the old refresh token cannot normally refresh again', async () => {
    const user = await seedCustomer();
    const issued = await issueSession(user, ctx);
    const first = await refresh(issued.tokens.refresh, ctx);

    await expect(refresh(issued.tokens.refresh, ctx)).rejects.toMatchObject({
      code: 'REFRESH_RACE',
      statusCode: 409,
      retryable: true,
    });

    const stillLive = await refresh(first.tokens.refresh, ctx);
    expect(stillLive.tokens.refresh).toBeTruthy();
  });

  it('two simultaneous refreshes with the same token allow exactly one winner', async () => {
    const user = await seedCustomer();
    const issued = await issueSession(user, ctx);

    const settled = await Promise.allSettled([
      refresh(issued.tokens.refresh, ctx),
      refresh(issued.tokens.refresh, ctx),
    ]);

    const successes = settled.filter((row) => row.status === 'fulfilled');
    const failures = settled.filter((row) => row.status === 'rejected');
    expect(successes).toHaveLength(1);
    expect(failures).toHaveLength(1);

    const failed = failures[0] as PromiseRejectedResult;
    expect(failed.reason).toBeInstanceOf(AppError);
    expect(failed.reason.code).toBe('REFRESH_RACE');
    expect(failed.reason.retryable).toBe(true);

    const reloaded = await User.findById(user._id).select('+sessionVersion');
    expect(reloaded?.sessionVersion).toBe(0);

    const winner = (successes[0] as PromiseFulfilledResult<{ tokens: { refresh: string } }>).value;
    const next = await refresh(winner.tokens.refresh, ctx);
    expect(next.tokens.refresh).not.toBe(winner.tokens.refresh);
  }, 20_000);

  it('reuse of a consumed token outside the race grace revokes the family', async () => {
    const user = await seedCustomer();
    const issued = await issueSession(user, ctx);
    const first = await refresh(issued.tokens.refresh, ctx);

    const consumed = await sessionByHash(issued.tokens.refresh);
    expect(consumed).toBeTruthy();
    consumed!.usedAt = new Date(Date.now() - REFRESH_RACE_GRACE_MS - 1_000);
    await consumed!.save();

    await expect(refresh(issued.tokens.refresh, otherCtx)).rejects.toMatchObject({
      code: 'TOKEN_REUSE_DETECTED',
      statusCode: 401,
      message: 'Session expired',
    });

    const family = await RefreshSession.find({ familyId: consumed!.familyId });
    expect(family.length).toBeGreaterThan(0);
    expect(family.every((row) => row.revokedAt)).toBe(true);

    const reloaded = await User.findById(user._id).select('+sessionVersion');
    expect(reloaded?.sessionVersion).toBe(1);

    const auditRow = await AuditLog.findOne({ action: 'REFRESH_TOKEN_REUSE_DETECTED' });
    expect(auditRow).toBeTruthy();
    expect(JSON.stringify(auditRow)).not.toContain(issued.tokens.refresh);

    await expect(refresh(first.tokens.refresh, ctx)).rejects.toMatchObject({
      code: 'SESSION_EXPIRED',
    });
  });

  it('rejects refresh for an inactive customer', async () => {
    const user = await seedCustomer();
    const issued = await issueSession(user, ctx);
    await User.updateOne({ _id: user._id }, { $set: { status: 'INACTIVE' } });

    await expect(refresh(issued.tokens.refresh, ctx)).rejects.toMatchObject({
      code: 'SESSION_EXPIRED',
      statusCode: 401,
    });
  });

  it('rejects refresh when sessionVersion does not match', async () => {
    const user = await seedCustomer();
    const issued = await issueSession(user, ctx);
    await User.updateOne({ _id: user._id }, { $inc: { sessionVersion: 1 } });

    await expect(refresh(issued.tokens.refresh, ctx)).rejects.toMatchObject({
      code: 'SESSION_EXPIRED',
      statusCode: 401,
    });
  });

  it('logout revokes the current live refresh session only', async () => {
    const user = await seedCustomer();
    const issued = await issueSession(user, ctx);
    const rotated = await refresh(issued.tokens.refresh, ctx);

    await logout(rotated.tokens.refresh);

    const oldRow = await sessionByHash(issued.tokens.refresh);
    const liveRow = await sessionByHash(rotated.tokens.refresh);
    expect(oldRow?.revokedAt).toBeFalsy();
    expect(liveRow?.revokedAt).toBeTruthy();
    expect(liveRow?.usedAt).toBeFalsy();
  });

  it('refresh after logout is rejected', async () => {
    const user = await seedCustomer();
    const issued = await issueSession(user, ctx);
    await logout(issued.tokens.refresh);

    await expect(refresh(issued.tokens.refresh, ctx)).rejects.toMatchObject({
      code: 'SESSION_EXPIRED',
      statusCode: 401,
    });
  });

  it('never stores a plaintext refresh token in Mongo', async () => {
    const user = await seedCustomer();
    const issued = await issueSession(user, ctx);
    const rotated = await refresh(issued.tokens.refresh, ctx);

    const rows = await RefreshSession.find().lean();
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.tokenHash).toMatch(/^[a-f0-9]{64}$/);
      expect(JSON.stringify(row)).not.toContain(issued.tokens.refresh);
      expect(JSON.stringify(row)).not.toContain(rotated.tokens.refresh);
    }
  });

  it('access token verification still works after login and refresh', async () => {
    const user = await seedCustomer();
    const issued = await issueSession(user, ctx);
    const accessClaims = verifyAccess(issued.tokens.access);
    expect(accessClaims.type).toBe('access');
    expect(accessClaims.sub).toBe(String(user._id));
    await expect(assertAccessSession(accessClaims)).resolves.toMatchObject({
      status: 'ACTIVE',
    });

    const rotated = await refresh(issued.tokens.refresh, ctx);
    const refreshedClaims = verifyAccess(rotated.tokens.access);
    expect(refreshedClaims.sessionVersion).toBe(accessClaims.sessionVersion);
    await expect(assertAccessSession(refreshedClaims)).resolves.toBeTruthy();
  });

  it('WebSocket sessionVersion check remains aligned with HTTP access checks', async () => {
    const user = await seedCustomer();
    const issued = await issueSession(user, ctx);
    const socket = fakeSocket(issued.tokens.access);
    await authenticateSocket(socket as any);
    expect(socket.data.auth?.userId).toBe(String(user._id));
    expect(socket.data.auth?.role).toBe('CUSTOMER');

    await User.updateOne({ _id: user._id }, { $inc: { sessionVersion: 1 } });
    await expect(authenticateSocket(fakeSocket(issued.tokens.access) as any)).rejects.toThrow(
      'SESSION_EXPIRED',
    );
    await expect(assertAccessSession(verifyAccess(issued.tokens.access))).rejects.toMatchObject({
      code: 'SESSION_EXPIRED',
    });
  });
});
