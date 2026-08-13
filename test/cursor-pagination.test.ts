import { describe, expect, it } from 'vitest';
import mongoose from 'mongoose';
import {
  coerceBoundedListQuery,
  decodeTimeIdCursor,
  encodeTimeIdCursor,
  isCursorListQuery,
  listQueryFromRequest,
} from '../src/utils/cursor-pagination.js';

describe('cursor pagination parser', () => {
  it('defaults missing pagination params to a bounded first cursor page', () => {
    expect(listQueryFromRequest({})).toEqual({
      mode: 'cursor',
      cursor: null,
      limit: 50,
    });
  });

  it('does not enter legacy-all even when unboundedLegacy is requested', () => {
    expect(listQueryFromRequest({}, { unboundedLegacy: true })).toEqual({
      mode: 'cursor',
      cursor: null,
      limit: 50,
    });
    expect(listQueryFromRequest({}, { unboundedLegacy: true }).mode).not.toBe('legacy-all');
  });

  it('uses cursor mode when only limit is provided', () => {
    expect(listQueryFromRequest({ limit: '25' })).toEqual({
      mode: 'cursor',
      cursor: null,
      limit: 25,
    });
  });

  it('clamps oversized limits instead of returning unbounded results', () => {
    expect(listQueryFromRequest({ limit: '1000' })).toEqual({
      mode: 'cursor',
      cursor: null,
      limit: 100,
    });
    expect(listQueryFromRequest({ page: '1', limit: '1000' })).toEqual({
      mode: 'offset',
      page: 1,
      limit: 100,
    });
    expect(listQueryFromRequest({ cursor: '', limit: '1000' })).toEqual({
      mode: 'cursor',
      cursor: null,
      limit: 100,
    });
  });

  it('keeps bounded offset compatibility when page is provided', () => {
    expect(listQueryFromRequest({ page: '2', limit: '20' })).toEqual({
      mode: 'offset',
      page: 2,
      limit: 20,
    });
  });

  it('activates cursor mode when cursor param is present', () => {
    expect(isCursorListQuery({ cursor: '' })).toBe(true);
    expect(isCursorListQuery({ limit: '20' })).toBe(false);
    expect(listQueryFromRequest({ cursor: '', limit: '25' })).toEqual({
      mode: 'cursor',
      cursor: null,
      limit: 25,
    });
  });

  it('coerces leftover internal legacy-all queries to a bounded first cursor page', () => {
    expect(coerceBoundedListQuery({ mode: 'legacy-all' })).toEqual({
      mode: 'cursor',
      cursor: null,
      limit: 50,
    });
  });

  it('round-trips time/id cursors', () => {
    const at = new Date('2026-08-04T10:15:00.000Z');
    const id = '507f1f77bcf86cd799439011';
    const cursor = encodeTimeIdCursor(at, id);
    expect(decodeTimeIdCursor(cursor)).toEqual({
      at,
      id: expect.objectContaining({ toHexString: expect.any(Function) }),
    });
    expect(decodeTimeIdCursor(cursor).id.toHexString()).toBe(id);
  });

  it('rejects malformed cursors', () => {
    expect(() => decodeTimeIdCursor('not-a-cursor')).toThrow(/invalid/i);
    try {
      decodeTimeIdCursor('%%%');
    } catch (error: any) {
      expect(error.code).toBe('INVALID_CURSOR');
      expect(error.statusCode).toBe(422);
    }
    expect(() =>
      decodeTimeIdCursor(
        Buffer.from('not-a-date|507f1f77bcf86cd799439011', 'utf8').toString('base64url'),
      ),
    ).toThrow();
    expect(() =>
      decodeTimeIdCursor(encodeTimeIdCursor(new Date(), new mongoose.Types.ObjectId()).slice(0, 8)),
    ).toThrow();
  });
});
