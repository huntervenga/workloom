import type { MyTaskDto, MyTasksQueryInput } from '@workloom/contracts';
import { describe, expect, it } from 'vitest';
import type { AccessRepository, WorkspaceAccessRecord } from '../access/ports.js';
import type { CommandContext } from '../access/context.js';
import { DomainError } from '../errors.js';
import { createMyTasksApplication } from './service.js';
import type { MyTasksCursor, MyTasksReadRepository } from './ports.js';

const id = (n: number) => `aa000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const workspace = id(1), user = id(2), member = id(3);
const context: CommandContext = { actor: { userId: user, displayName: 'Viewer', kind: 'fixture' }, workspaceId: workspace, source: 'web', requestId: 'request' };
function row(n: number): MyTaskDto {
  return { task: { id: id(100 + n), workspaceId: workspace, projectId: id(10 + n), sectionId: null, parentTaskId: null, workPackageId: id(200 + n), workPackageRevision: 1, title: `Task ${n}`, description: '', statusId: id(300 + n), responsibleMembershipId: member, participants: [], participantsRevision: 1, dueDate: '2026-10-16', priority: 'none', tags: [], estimateMinutes: null, revision: 1, position: 0, visibility: 'workspace', archivedAt: null, createdAt: '2026-10-16T00:00:00.000Z', updatedAt: '2026-10-16T00:00:00.000Z' }, project: { id: id(10 + n), name: `Project ${n}`, archivedAt: null }, status: { id: id(300 + n), name: 'To do', group: 'todo' } };
}
function harness() {
  let active = false;
  const calls: string[] = [];
  const state: { access: WorkspaceAccessRecord | null; epoch: string; rows: MyTaskDto[]; query?: unknown } = { access: { workspace: { id: workspace, name: 'Team', timezone: 'UTC', weekStart: 1 }, membership: { id: member, workspaceId: workspace, userId: user, displayName: 'Viewer', role: 'viewer', state: 'active', revision: 1 } }, epoch: '1', rows: [row(1), row(2)] };
  const inside = (call: string) => { expect(active).toBe(true); calls.push(call); };
  const access: AccessRepository = { findUser: async () => null, findUsers: async () => [], listAccessibleWorkspaces: async () => [], listActiveMemberships: async () => [], findWorkspaceAccess: async () => { inside('authorize'); return state.access; } };
  const repository: MyTasksReadRepository = { access, permissionEpoch: async () => { inside('epoch'); return state.epoch; }, list: async (ws, membershipId, query, after, take) => { inside('list'); expect(ws).toBe(workspace); expect(membershipId).toBe(state.access?.membership.id); state.query = query; return state.rows.filter(item => !after || item.task.id > after.id).slice(0, take); } };
  const app = createMyTasksApplication({ async run(read) { expect(active).toBe(false); active = true; try { return await read(repository); } finally { active = false; } } }, { digest: value => `digest:${value}`, encodeCursor: value => JSON.stringify(value), decodeCursor: value => { inside('decode'); return JSON.parse(value) as MyTasksCursor; } });
  return { app, state, calls };
}
async function error(promise: Promise<unknown>) { try { await promise; } catch (value) { expect(value).toBeInstanceOf(DomainError); return value as DomainError; } throw new Error('Expected a domain error'); }

describe('personal task read application', () => {
  it('allows viewer reads and derives the member in the same snapshot as authorization and page data', async () => {
    const h = harness();
    const page = await h.app.list({ ...context, actor: { ...context.actor, userId: user.toUpperCase() }, workspaceId: workspace.toUpperCase() }, { search: '  hello  ', relation: 'assigned' });
    expect(page.items).toHaveLength(2);
    expect(page.nextCursor).toBeNull();
    expect(h.calls).toEqual(['authorize', 'epoch', 'list']);
    expect(h.state.query).toEqual({ relation: 'assigned', completion: 'open', includeArchived: false, search: 'hello', limit: 50 });
  });
  it('uses limit+1 and binds distinct-kind cursors to self and every normalized filter', async () => {
    const h = harness();
    const first = await h.app.list(context, { limit: 1 });
    expect(first.items.map(item => item.task.id)).toEqual([row(1).task.id]);
    expect(first.nextCursor).not.toBeNull();
    const cursor = first.nextCursor as string;
    expect(JSON.parse(cursor)).toMatchObject({ kind: 'my-tasks', version: 1, workspaceId: workspace, actorUserId: user, membershipId: member, permissionEpoch: '1', dueDate: '2026-10-16', id: row(1).task.id });
    const second = await h.app.list(context, { limit: 1, cursor });
    expect(second.items.map(item => item.task.id)).toEqual([row(2).task.id]);
    expect(second.nextCursor).toBeNull();
    expect(h.calls.slice(-4)).toEqual(['authorize', 'epoch', 'decode', 'list']);
    for (const change of [{ relation: 'assigned' }, { relation: 'participating' }, { completion: 'closed' }, { completion: 'all' }, { includeArchived: true }, { search: 'different' }, { limit: 2 }] satisfies MyTasksQueryInput[]) expect((await error(h.app.list(context, { limit: 1, cursor, ...change }))).code).toBe('VALIDATION_FAILED');
  });
  it('reauthorizes before decoding any cursor and hides absent and revoked memberships equally', async () => {
    const h = harness();
    const saved = h.state.access as WorkspaceAccessRecord;
    h.state.access = null;
    const absent = await error(h.app.list(context, { cursor: 'invalid' }));
    h.state.access = { ...saved, membership: { ...saved.membership, state: 'revoked' } };
    const revoked = await error(h.app.list(context, { cursor: 'invalid' }));
    expect(absent.code).toBe('NOT_FOUND');
    expect(revoked.code).toBe(absent.code);
    expect(h.calls).toEqual(['authorize', 'authorize']);
  });
  it('invalidates cursors after membership replacement, permission-epoch changes, actor changes or kind mismatch', async () => {
    for (const mutation of ['member', 'epoch', 'actor', 'kind'] as const) {
      const h = harness();
      const first = await h.app.list(context, { limit: 1 });
      let cursor = first.nextCursor as string;
      if (mutation === 'member' && h.state.access) h.state.access = { ...h.state.access, membership: { ...h.state.access.membership, id: id(90) } };
      if (mutation === 'epoch') h.state.epoch = '2';
      if (mutation === 'kind') cursor = JSON.stringify({ ...(JSON.parse(cursor) as MyTasksCursor), kind: 'tasks' });
      const ctx = mutation === 'actor' ? { ...context, actor: { ...context.actor, userId: id(91) } } : context;
      expect((await error(h.app.list(ctx, { limit: 1, cursor }))).code).toBe('VALIDATION_FAILED');
    }
  });
  it('normalizes equivalent blank search filters and enforces the 200-row page bound', async () => {
    const h = harness();
    const first = await h.app.list(context, { limit: 1 });
    expect((await h.app.list(context, { limit: 1, search: '   ', cursor: first.nextCursor as string })).items).toHaveLength(1);
    h.state.rows = Array.from({ length: 201 }, (_, i) => row(i + 1));
    const page = await h.app.list(context, { limit: 200 });
    expect(page.items).toHaveLength(200);
    expect(page.nextCursor).not.toBeNull();
    expect((await error(h.app.list(context, { limit: 201 }))).code).toBe('VALIDATION_FAILED');
  });
});
