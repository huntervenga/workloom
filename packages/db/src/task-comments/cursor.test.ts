import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { TaskTimelineCursor } from '@workloom/domain';
import { createTaskTimelineCursorCodec } from './cursor.js';
const id = (n: number) => `aa000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const secret = 'synthetic-comment-cursor-key-at-least-thirty-two-bytes';
const base = { version: 1, workspaceId: id(1), taskId: id(2), actorUserId: id(3), membershipId: id(4), permissionEpoch: '0', limit: 50 } as const;
const comment: TaskTimelineCursor = { ...base, kind: 'task-comments', createdAt: '2026-10-16T00:00:00.000Z', id: id(5) };
function signed(value: unknown) { const body = Buffer.from(JSON.stringify(value)).toString('base64url'); return `${body}.${createHmac('sha256', secret).update(body).digest('base64url')}`; }
describe('task timeline signed cursor', () => {
  it('round-trips distinct feed anchors and expires at its exact TTL', () => {
    let now = 1000; const codec = createTaskTimelineCursorCodec({ secret, now: () => now, ttlMs: 1000 });
    const token = codec.encode(comment);
    expect(codec.decode(token)).toEqual(comment);
    const activity: TaskTimelineCursor = { ...base, kind: 'task-activity', changeSeq: '9007199254740993', eventOrdinal: 2 };
    expect(codec.decode(codec.encode(activity))).toEqual(activity);
    now = 2000; expect(() => codec.decode(token)).toThrow(expect.objectContaining({ code: 'VALIDATION_FAILED' }));
  });
  it('rejects tampering, old task list families, extra fields and malformed anchor/identity values', () => {
    const codec = createTaskTimelineCursorCodec({ secret, now: () => 1000, ttlMs: 1000 });
    for (const patch of [{ kind: 'my-tasks' }, { extra: 'hidden' }, { workspaceId: id(1).toUpperCase() }, { permissionEpoch: '9223372036854775808' }, { limit: 101 }, { createdAt: '2026-02-30T00:00:00.000Z' }, { createdAt: '2026-10-16T00:00:00Z' }, { kind: 'task-activity', createdAt: undefined, id: undefined, changeSeq: '0', eventOrdinal: 1 }]) expect(() => codec.decode(signed({ ...comment, ...patch, expiresAt: 1500 }))).toThrow(expect.objectContaining({ code: 'VALIDATION_FAILED' }));
    const token = codec.encode(comment), [body] = token.split('.');
    expect(() => codec.decode(`${body}.tampered`)).toThrow();
    expect(() => codec.decode('x'.repeat(2049))).toThrow();
    expect(() => codec.encode({ ...comment, extra: true } as TaskTimelineCursor)).toThrow('payload');
  });
  it('requires bounded key material and positive TTL', () => {
    expect(() => createTaskTimelineCursorCodec({ secret: 'short' })).toThrow('32 bytes');
    expect(() => createTaskTimelineCursorCodec({ ttlMs: 0 })).toThrow('positive');
  });
});
