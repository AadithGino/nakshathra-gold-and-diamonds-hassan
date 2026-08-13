import type { ClientSession } from 'mongoose';
import {
  AuditLog,
  OutboxEvent,
  type Role,
} from '../models/index.js';
import {
  buildCursorPage,
  buildOffsetPage,
  coerceBoundedListQuery,
  cursorFetchLimit,
  offsetSkip,
  type ListPageResult,
  type ListQuery,
  withKeysetFilter,
} from '../utils/cursor-pagination.js';

export type AuditContext = {
  actorId?: string;
  actorRole?: Role;
  requestId?: string;
  ip?: string;
  userAgent?: string;
};

export async function listAuditLogs(listQuery: ListQuery): Promise<ListPageResult<any>> {
  const query = coerceBoundedListQuery(listQuery);
  const sortField = 'createdAt';
  const filter = withKeysetFilter({}, query, sortField);
  const baseQuery = AuditLog.find(filter).populate('actorId', 'name phone role');

  if (query.mode === 'cursor') {
    const rows = await baseQuery
      .sort({ [sortField]: -1, _id: -1 })
      .limit(cursorFetchLimit(query))
      .lean();
    return buildCursorPage(
      rows,
      query.limit,
      sortField,
      (row) => new Date(row.createdAt),
      (row) => row._id,
    );
  }

  const [items, total] = await Promise.all([
    baseQuery
      .sort({ [sortField]: -1, _id: -1 })
      .skip(offsetSkip(query))
      .limit(query.limit)
      .lean(),
    AuditLog.countDocuments(),
  ]);
  return buildOffsetPage(items, total, query.page, query.limit);
}

export async function audit(
  session: ClientSession,
  context: AuditContext,
  action: string,
  entityType: string,
  entityId: unknown,
  before?: unknown,
  after?: unknown,
) {
  await AuditLog.create(
    [
      {
        actorId: context.actorId,
        actorRole: context.actorRole,
        action,
        entityType,
        entityId,
        before,
        after,
        requestId: context.requestId,
        ip: context.ip,
        userAgent: context.userAgent,
      },
    ],
    { session },
  );
}
export async function outbox(
  session: ClientSession,
  type: string,
  aggregateType: string,
  aggregateId: unknown,
  payload: unknown,
  dedupeKey?: string,
) {
  try {
    await OutboxEvent.create(
      [
        {
          type,
          aggregateType,
          aggregateId,
          payload,
          ...(dedupeKey ? { dedupeKey } : {}),
        },
      ],
      { session },
    );
  } catch (error: any) {
    if (error?.code === 11000 && dedupeKey) return;
    throw error;
  }
}
