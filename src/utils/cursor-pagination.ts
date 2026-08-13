import mongoose from 'mongoose';
import { AppError } from './AppError.js';

/** Legacy offset pagination — used when `page` is present and `cursor` is absent. */
export type OffsetListQuery = {
  mode: 'offset';
  page: number;
  limit: number;
};

/** Cursor (keyset) pagination — default when `page` is absent. */
export type CursorListQuery = {
  mode: 'cursor';
  cursor: string | null;
  limit: number;
};

/**
 * Unbounded legacy list. HTTP parsers never emit this.
 * Kept so internal/maintenance callers can still be typed and coerced to a bounded page.
 */
export type LegacyAllListQuery = {
  mode: 'legacy-all';
};

export type ListQuery = OffsetListQuery | CursorListQuery | LegacyAllListQuery;

export type CursorPageMeta = {
  mode: 'cursor';
  limit: number;
  nextCursor: string | null;
  hasMore: boolean;
};

export type OffsetPageMeta = {
  mode: 'offset';
  page: number;
  limit: number;
  total: number;
};

export type ListPageMeta = CursorPageMeta | OffsetPageMeta;

export type ListPageResult<T> = {
  items: T[];
  meta?: ListPageMeta;
};

export const DEFAULT_LIST_LIMIT = 50;
export const MAX_LIST_LIMIT = 100;

const DEFAULT_OFFSET_LIMIT = DEFAULT_LIST_LIMIT;
const MAX_OFFSET_LIMIT = MAX_LIST_LIMIT;
const DEFAULT_CURSOR_LIMIT = DEFAULT_LIST_LIMIT;
const MAX_CURSOR_LIMIT = MAX_LIST_LIMIT;

export function isCursorListQuery(query: Record<string, unknown>): boolean {
  return Object.prototype.hasOwnProperty.call(query, 'cursor');
}

function clampLimit(raw: unknown, defaultLimit: number, maxLimit: number) {
  const parsed = Number(raw);
  const fallback = Number.isFinite(parsed) && parsed > 0 ? parsed : defaultLimit;
  return Math.min(maxLimit, Math.max(1, fallback));
}

/**
 * Parse list query params.
 * - `cursor` present (empty = first page) → keyset mode
 * - `page` present without `cursor` → bounded offset compatibility
 * - neither → first cursor page (never unbounded / never legacy-all)
 */
export function listQueryFromRequest(
  query: Record<string, unknown>,
  options: {
    defaultOffsetLimit?: number;
    maxOffsetLimit?: number;
    /** Ignored. Production HTTP never returns an unbounded collection. */
    unboundedLegacy?: boolean;
  } = {},
): OffsetListQuery | CursorListQuery {
  const defaultLimit = options.defaultOffsetLimit ?? DEFAULT_OFFSET_LIMIT;
  const maxLimit = Math.min(options.maxOffsetLimit ?? MAX_OFFSET_LIMIT, MAX_LIST_LIMIT);

  if (isCursorListQuery(query)) {
    const raw = query.cursor;
    const cursor =
      raw == null || String(raw).trim() === '' ? null : String(raw).trim();
    return {
      mode: 'cursor',
      cursor,
      limit: clampLimit(query.limit, DEFAULT_CURSOR_LIMIT, Math.min(maxLimit, MAX_CURSOR_LIMIT)),
    };
  }

  const hasPage = query.page != null && String(query.page).trim() !== '';
  if (hasPage) {
    return {
      mode: 'offset',
      page: Math.max(1, Number(query.page) || 1),
      limit: clampLimit(query.limit, defaultLimit, maxLimit),
    };
  }

  return {
    mode: 'cursor',
    cursor: null,
    limit: clampLimit(query.limit, DEFAULT_CURSOR_LIMIT, Math.min(maxLimit, MAX_CURSOR_LIMIT)),
  };
}

/** Convert leftover internal `legacy-all` queries into a bounded first cursor page. */
export function coerceBoundedListQuery(
  listQuery: ListQuery,
): OffsetListQuery | CursorListQuery {
  if (listQuery.mode === 'legacy-all') {
    return { mode: 'cursor', cursor: null, limit: DEFAULT_LIST_LIMIT };
  }
  return listQuery;
}

export function encodeTimeIdCursor(date: Date, id: unknown) {
  const objectId =
    id instanceof mongoose.Types.ObjectId ? id : new mongoose.Types.ObjectId(String(id));
  return Buffer.from(`${date.toISOString()}|${objectId.toHexString()}`, 'utf8').toString(
    'base64url',
  );
}

export function decodeTimeIdCursor(cursor: string) {
  try {
    const decoded = Buffer.from(cursor, 'base64url').toString('utf8');
    const separator = decoded.lastIndexOf('|');
    if (separator <= 0) throw new Error('invalid cursor');
    const at = new Date(decoded.slice(0, separator));
    const id = decoded.slice(separator + 1);
    if (Number.isNaN(at.getTime()) || !mongoose.isValidObjectId(id)) {
      throw new Error('invalid cursor');
    }
    return { at, id: new mongoose.Types.ObjectId(id) };
  } catch {
    throw new AppError('INVALID_CURSOR', 'Pagination cursor is invalid or expired', 422);
  }
}

/** Keyset filter for descending sort `{ [sortField]: -1, _id: -1 }`. */
export function keysetBefore(sortField: string, at: Date, id: mongoose.Types.ObjectId) {
  return {
    $or: [{ [sortField]: { $lt: at } }, { [sortField]: at, _id: { $lt: id } }],
  };
}

export function buildCursorPage<T extends Record<string, unknown>>(
  rows: T[],
  limit: number,
  sortField: string,
  getSortDate: (row: T) => Date,
  getId: (row: T) => unknown,
): ListPageResult<T> {
  const hasMore = rows.length > limit;
  const items = hasMore ? rows.slice(0, limit) : rows;
  const last = items.at(-1);
  const nextCursor =
    hasMore && last ? encodeTimeIdCursor(getSortDate(last), getId(last)) : null;
  return {
    items,
    meta: {
      mode: 'cursor',
      limit,
      nextCursor,
      hasMore,
    },
  };
}

export function buildOffsetPage<T>(
  items: T[],
  total: number,
  page: number,
  limit: number,
): ListPageResult<T> {
  return {
    items,
    meta: {
      mode: 'offset',
      page,
      limit,
      total,
    },
  };
}

/** Merge keyset cursor into an existing Mongo filter when in cursor mode. */
export function withKeysetFilter(
  baseFilter: Record<string, unknown>,
  listQuery: ListQuery,
  sortField: string,
) {
  if (listQuery.mode !== 'cursor' || !listQuery.cursor) return baseFilter;
  const { at, id } = decodeTimeIdCursor(listQuery.cursor);
  return { $and: [baseFilter, keysetBefore(sortField, at, id)] };
}

export function cursorFetchLimit(listQuery: CursorListQuery) {
  return listQuery.limit + 1;
}

export function isLegacyAll(listQuery: ListQuery): listQuery is LegacyAllListQuery {
  return listQuery.mode === 'legacy-all';
}

export function offsetSkip(listQuery: OffsetListQuery) {
  return (listQuery.page - 1) * listQuery.limit;
}
