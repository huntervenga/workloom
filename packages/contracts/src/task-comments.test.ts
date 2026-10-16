import { describe, expect, it } from 'vitest';
import { createTaskCommentInputSchema, taskActivityQuerySchema, taskActivitySchema, taskCommentsQuerySchema, taskCommentsResponseSchema } from './task-comments.js';
const id = '10000000-0000-4000-8000-000000000001';
describe('bounded plaintext discussion contracts', () => {
  it('preserves exact text and rejects blank/NUL/oversize bodies and client-authored identity', () => {
    const body = '  <img src=x onerror=alert(1)>\r\nPlain text  ';
    expect(createTaskCommentInputSchema.parse({ body })).toEqual({ body });
    for (const value of ['', ' \n\t\u00a0', '\0', 'a'.repeat(4001), '😀'.repeat(2001)]) expect(createTaskCommentInputSchema.safeParse({ body: value }).success).toBe(false);
    expect(createTaskCommentInputSchema.safeParse({ body: 'valid', authorUserId: id }).success).toBe(false);
  });
  it('bounds paging and requires explicit continuation metadata', () => {
    expect(taskCommentsQuerySchema.parse({})).toEqual({ limit: 50 });
    expect(taskActivityQuerySchema.parse({ limit: '100' })).toEqual({ limit: 100 });
    for (const input of [{ limit: 101 }, { limit: 0 }, { limit: 1.5 }, { actorId: id }, { sort: 'title' }]) expect(taskCommentsQuerySchema.safeParse(input).success).toBe(false);
    expect(taskCommentsResponseSchema.safeParse({ data: [], meta: { requestId: 'test' } }).success).toBe(false);
    expect(taskCommentsResponseSchema.safeParse({ data: [], meta: { requestId: 'test', nextCursor: null } }).success).toBe(true);
  });
  it('permits only reviewed activity kinds and rejects raw audit data', () => {
    const event = { id, workspaceId: id, taskId: id, kind: 'schedule_updated', actorUserId: id, actorMembershipId: id, actorDisplayName: 'Current name', occurredAt: '2026-10-16T00:00:00.000Z', changeSeq: '1', eventOrdinal: 1 };
    expect(taskActivitySchema.safeParse(event).success).toBe(true);
    expect(taskActivitySchema.safeParse({ ...event, kind: 'field_value_changed' }).success).toBe(false);
    expect(taskActivitySchema.safeParse({ ...event, diff: { secret: 'hidden' } }).success).toBe(false);
  });
});
