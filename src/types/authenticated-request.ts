import type { Request } from 'express';
import type { Role } from '../models/index.js';

export type AuthenticatedRequest = Request & {
  auth: {
    userId: string;
    role: Role;
    permissions: string[];
    sessionVersion: number;
  };
};

export const auditContextFromRequest = (request: AuthenticatedRequest) => ({
  actorId: request.auth.userId,
  actorRole: request.auth.role,
  requestId: String(request.id),
  ip: request.ip,
  userAgent: request.get('user-agent'),
});
