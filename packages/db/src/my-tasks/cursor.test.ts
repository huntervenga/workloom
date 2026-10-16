import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { MyTasksCursor } from '@workloom/domain';
import { createMyTasksCursorCodec } from './cursor.js';
import { createTaskCursorCodec } from '../tasks/cursor.js';

const SECRET = 'synthetic-cursor-test-key-with-32-bytes';
const id = (n: number) => `aa000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const payload: MyTasksCursor = { kind: 'my-tasks', version: 1, workspaceId: id(1), actorUserId: id(2), membershipId: id(3), permissionEpoch: '1', queryHash: 'a'.repeat(64), dueDate: '0001-01-01', id: id(4) };
const sign = (value: object) => { const body = Buffer.from(JSON.stringify(value)).toString('base64url'); return `${body}.${createHmac('sha256', SECRET).update(body).digest('base64url')}`; };

describe('separate personal-task cursor codec', () => {
  it('round-trips date and null anchors and expires after its bounded TTL', () => {
    let now = 1000;
    const codec = createMyTasksCursorCodec({ secret: SECRET, ttlMs: 100, now: () => now });
    const token = codec.encode(payload);
    expect(codec.decode(token)).toEqual(payload);
    expect(codec.decode(codec.encode({ ...payload, dueDate: null }))).toEqual({ ...payload, dueDate: null });
    now = 1100;
    expect(() => codec.decode(token)).toThrow('Reload the personal task list.');
  });
  it('rejects the old task-list cursor kind even with the same signature key', () => {
    const old = createTaskCursorCodec({ secret: SECRET, now: () => 1000 });
    const token = old.encode({ version: 1, workspaceId: payload.workspaceId, actorUserId: payload.actorUserId, permissionEpoch: payload.permissionEpoch, queryHash: payload.queryHash, position: 0, id: payload.id });
    expect(() => createMyTasksCursorCodec({ secret: SECRET, now: () => 1000 }).decode(token)).toThrow('Reload the personal task list.');
  });
  it('rejects tampering, noncanonical IDs, invalid dates and extra signed fields', () => {
    const codec = createMyTasksCursorCodec({ secret: SECRET, now: () => 1000 });
    const token = codec.encode(payload);
    expect(() => codec.decode(`x${token}`)).toThrow();
    for (const patch of [{ workspaceId: payload.workspaceId.toUpperCase() }, { dueDate: '2026-02-30' }, { dueDate: '0000-01-01' }, { extra: true }, { kind: 'tasks' }, { expiresAt: 999999999 }, { membershipId: null }]) expect(() => codec.decode(sign({ ...payload, expiresAt: 1100, ...patch }))).toThrow();
  });
});
