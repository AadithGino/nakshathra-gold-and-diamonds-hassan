import jwt from 'jsonwebtoken';
import mongoose from 'mongoose';
import { createHash, randomUUID } from 'node:crypto';
import { env } from '../config/env.js';
import { AppError } from '../utils/AppError.js';
import { withMongoTransaction } from '../utils/transaction.js';
import { verifyPassword } from '../utils/password.js';
import { RefreshSession, StaffProfile, User, type Role } from '../models/index.js';
import { PORTAL_ROLES } from '../config/business.js';
import { audit } from './audit.service.js';

export { hashPassword } from '../utils/password.js';

/** Concurrent same-browser refreshes inside this window are REFRESH_RACE, not theft. */
export const REFRESH_RACE_GRACE_MS = 8_000;

type Claims = {
  sub: string;
  role: Role;
  permissions: string[];
  sessionVersion: number;
  type: 'access' | 'refresh';
  jti: string;
};

type ClientContext = { ip?: string; userAgent?: string };

const ROTATION_LOST = Symbol('rotation-lost');

const hash = (value: string) => createHash('sha256').update(value).digest('hex');

function refreshTtlMs() {
  return env.REFRESH_TOKEN_TTL_DAYS * 86_400_000;
}

async function loadStaffPermissions(userId: unknown) {
  const profile = await StaffProfile.findOne({ userId }).select('permissions').lean();
  return Array.isArray(profile?.permissions) ? profile.permissions.map(String) : [];
}

async function claimsFor(user: any) {
  const permissions = user.role === 'STAFF' ? await loadStaffPermissions(user._id) : [];
  return {
    sub: String(user._id),
    role: user.role as Role,
    permissions,
    sessionVersion: user.sessionVersion,
    jti: randomUUID(),
  };
}

function sessionPayload(user: any, permissions: string[] = []) {
  return {
    user: {
      id: String(user._id),
      name: user.name,
      phone: user.phone,
      role: user.role,
      permissions,
    },
    redirectTo: `/${String(user.role).toLowerCase()}`,
  };
}

function isSameFingerprint(session: { ip?: string; userAgent?: string }, context: ClientContext) {
  return (session.ip ?? '') === (context.ip ?? '') && (session.userAgent ?? '') === (context.userAgent ?? '');
}

function isWithinRaceGrace(usedAt?: Date | null) {
  if (!usedAt) return false;
  return Date.now() - new Date(usedAt).getTime() <= REFRESH_RACE_GRACE_MS;
}

function familyIdOf(session: { familyId?: string; _id: unknown }) {
  return session.familyId || String(session._id);
}

export async function issueSession(user: any, context: ClientContext) {
  const base = await claimsFor(user);
  const access = jwt.sign({ ...base, type: 'access' }, env.JWT_ACCESS_SECRET, {
    expiresIn: `${env.ACCESS_TOKEN_TTL_MINUTES}m`,
  });
  const refresh = jwt.sign(
    { ...base, type: 'refresh', jti: randomUUID() },
    env.JWT_REFRESH_SECRET,
    { expiresIn: `${env.REFRESH_TOKEN_TTL_DAYS}d` },
  );
  const now = new Date();
  await RefreshSession.create({
    userId: user._id,
    familyId: randomUUID(),
    tokenHash: hash(refresh),
    issuedAt: now,
    expiresAt: new Date(now.getTime() + refreshTtlMs()),
    ip: context.ip,
    userAgent: context.userAgent,
  });
  return {
    tokens: { access, refresh },
    data: sessionPayload(user, base.permissions),
  };
}

async function issueAccessToken(user: any) {
  const base = await claimsFor(user);
  return jwt.sign({ ...base, type: 'access' }, env.JWT_ACCESS_SECRET, {
    expiresIn: `${env.ACCESS_TOKEN_TTL_MINUTES}m`,
  });
}

export async function login(phone: string, password: string, context: ClientContext) {
  const user = await User.findOne({ phone, deletedAt: null }).select(
    '+passwordHash +failedLoginCount +lockedUntil +sessionVersion',
  );
  if (!user) throw new AppError('INVALID_CREDENTIALS', 'Invalid phone or password', 401);
  if (user.status !== 'ACTIVE')
    throw new AppError('ACCOUNT_INACTIVE', 'Account is not active', 403);
  if (!PORTAL_ROLES.includes(user.role))
    throw new AppError('PORTAL_NOT_AVAILABLE', 'This account has no portal access', 403);
  if (user.lockedUntil && user.lockedUntil > new Date())
    throw new AppError('ACCOUNT_LOCKED', 'Too many failed attempts. Try again later', 429, true);
  if (!(await verifyPassword(user.passwordHash, password))) {
    const lockedUntil = new Date(Date.now() + 15 * 60_000);
    await User.findOneAndUpdate(
      { _id: user._id },
      [
        {
          $set: {
            failedLoginCount: { $add: [{ $ifNull: ['$failedLoginCount', 0] }, 1] },
          },
        },
        {
          $set: {
            lockedUntil: {
              $cond: [{ $gte: ['$failedLoginCount', 5] }, lockedUntil, '$lockedUntil'],
            },
          },
        },
      ],
      { new: true },
    );
    throw new AppError('INVALID_CREDENTIALS', 'Invalid phone or password', 401);
  }
  user.failedLoginCount = 0;
  user.lockedUntil = undefined;
  user.lastLoginAt = new Date();
  await user.save();
  return issueSession(user, context);
}

async function revokeFamilyAndInvalidate(
  familyId: string,
  user: any,
  context: ClientContext,
  reusedSessionId: unknown,
) {
  await withMongoTransaction(async (session) => {
    const now = new Date();
    await RefreshSession.updateMany(
      mongoose.trusted({ familyId }),
      { $set: { revokedAt: now } },
      { session },
    );
    const bumped = await User.findOneAndUpdate(
      mongoose.trusted({ _id: user._id }),
      { $inc: { sessionVersion: 1 } },
      { new: true, session },
    ).select('+sessionVersion');
    if (!bumped) throw new AppError('SESSION_EXPIRED', 'Session expired', 401);
    await audit(
      session,
      {
        actorId: String(user._id),
        actorRole: user.role,
        ip: context.ip,
        userAgent: context.userAgent,
      },
      'REFRESH_TOKEN_REUSE_DETECTED',
      'RefreshSession',
      reusedSessionId,
      { familyId },
      { sessionVersion: bumped.sessionVersion, familyRevokedAt: now },
    );
  }, 'refresh-reuse');
}

async function rejectConsumedOrRevoked(
  stored: any,
  context: ClientContext,
  user: any,
): Promise<never> {
  if (!stored.usedAt && stored.revokedAt) {
    throw new AppError('SESSION_EXPIRED', 'Session expired', 401);
  }
  if (
    stored.usedAt &&
    stored.replacedBySessionId &&
    isWithinRaceGrace(stored.usedAt) &&
    isSameFingerprint(stored, context)
  ) {
    throw new AppError(
      'REFRESH_RACE',
      'Refresh is already in progress. Retry with the latest session.',
      409,
      true,
    );
  }
  await revokeFamilyAndInvalidate(familyIdOf(stored), user, context, stored._id);
  throw new AppError('TOKEN_REUSE_DETECTED', 'Session expired', 401);
}

async function rotateSession(stored: any, user: any, context: ClientContext) {
  return withMongoTransaction(async (session) => {
    const now = new Date();
    const consumed = await RefreshSession.findOneAndUpdate(
      mongoose.trusted({ _id: stored._id, usedAt: null, revokedAt: null }),
      {
        $set: {
          usedAt: now,
          familyId: familyIdOf(stored),
          ip: context.ip,
          userAgent: context.userAgent,
        },
      },
      { new: true, session },
    );
    if (!consumed) return ROTATION_LOST;

    const access = await issueAccessToken(user);
    const refreshToken = jwt.sign(
      { ...(await claimsFor(user)), type: 'refresh', jti: randomUUID() },
      env.JWT_REFRESH_SECRET,
      { expiresIn: `${env.REFRESH_TOKEN_TTL_DAYS}d` },
    );
    const [successor] = await RefreshSession.create(
      [
        {
          userId: user._id,
          familyId: familyIdOf(consumed),
          tokenHash: hash(refreshToken),
          issuedAt: now,
          expiresAt: new Date(now.getTime() + refreshTtlMs()),
          ip: context.ip,
          userAgent: context.userAgent,
        },
      ],
      { session },
    );
    await RefreshSession.updateOne(
      mongoose.trusted({ _id: consumed._id }),
      { $set: { replacedBySessionId: successor._id } },
      { session },
    );
    return {
      tokens: { access, refresh: refreshToken },
      data: sessionPayload(user),
    };
  }, 'refresh-rotate');
}

export async function refresh(token: string | undefined, context: ClientContext) {
  if (!token) throw new AppError('AUTHENTICATION_REQUIRED', 'Refresh session required', 401);
  let claims: Claims;
  try {
    claims = jwt.verify(token, env.JWT_REFRESH_SECRET) as Claims;
    if (claims.type !== 'refresh') throw new Error('wrong type');
  } catch {
    throw new AppError('SESSION_EXPIRED', 'Session expired', 401);
  }

  const stored = await RefreshSession.findOne({ tokenHash: hash(token) });
  const user = await User.findById(claims.sub).select('+sessionVersion');
  if (
    !user ||
    user.status !== 'ACTIVE' ||
    !PORTAL_ROLES.includes(user.role) ||
    user.sessionVersion !== claims.sessionVersion ||
    (stored && String(stored.userId) !== String(user._id))
  ) {
    throw new AppError('SESSION_EXPIRED', 'Session expired', 401);
  }
  if (!stored || stored.expiresAt <= new Date()) {
    throw new AppError('SESSION_EXPIRED', 'Session expired', 401);
  }
  if (stored.usedAt || stored.revokedAt) {
    await rejectConsumedOrRevoked(stored, context, user);
  }

  const rotated = await rotateSession(stored, user, context);
  if (rotated !== ROTATION_LOST) return rotated;

  const latest = await RefreshSession.findById(stored._id);
  if (latest && !latest.usedAt && !latest.revokedAt) {
    throw new AppError(
      'REFRESH_RACE',
      'Refresh is already in progress. Retry with the latest session.',
      409,
      true,
    );
  }
  if (latest) await rejectConsumedOrRevoked(latest, context, user);
  throw new AppError('SESSION_EXPIRED', 'Session expired', 401);
}

export async function logout(token: string | undefined) {
  if (!token) return;
  await RefreshSession.updateOne(
    mongoose.trusted({ tokenHash: hash(token), usedAt: null }),
    { $set: { revokedAt: new Date() } },
  );
}

export function verifyAccess(token?: string): Claims {
  if (!token) throw new AppError('AUTHENTICATION_REQUIRED', 'Authentication required', 401);
  try {
    const c = jwt.verify(token, env.JWT_ACCESS_SECRET) as Claims;
    if (c.type !== 'access') throw new Error();
    return c;
  } catch {
    throw new AppError('SESSION_EXPIRED', 'Session expired', 401);
  }
}

export async function assertAccessSession(claims: Claims) {
  const user = await User.findById(claims.sub).select('status role +sessionVersion').lean();
  if (
    !user ||
    user.status !== 'ACTIVE' ||
    !PORTAL_ROLES.includes(user.role) ||
    user.sessionVersion !== claims.sessionVersion
  ) {
    throw new AppError('SESSION_EXPIRED', 'Session expired', 401);
  }
  const permissions = user.role === 'STAFF' ? await loadStaffPermissions(user._id) : [];
  return { ...user, permissions };
}
