import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AccessRepository, WorkspaceAccessRecord } from '../access/ports.js';
import type { CommandContext } from '../access/context.js';
import * as capabilities from '../access/capabilities.js';
import { createWorkspaceChangeHeadApplication } from './service.js';
import type { WorkspaceChangeHeadReadRepository, WorkspaceChangeHeadReadUnitOfWork, WorkspaceChangeHeadRecord } from './ports.js';

const id = (n: number) => `aa000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const workspaceId = id(1), actorUserId = id(2), membershipId = id(3);
const context: CommandContext = { actor: { userId: actorUserId, displayName: 'Viewer', kind: 'fixture' }, workspaceId, source: 'web', requestId: 'request' };
const accessRecord = (): WorkspaceAccessRecord => ({ workspace: { id: workspaceId, name: 'Team', timezone: 'UTC', weekStart: 1 }, membership: { id: membershipId, workspaceId, userId: actorUserId, displayName: 'Viewer', role: 'viewer', state: 'active', revision: 7 } });
function harness() {
  let inside = false;
  const calls: string[] = [];
  const state: { access: WorkspaceAccessRecord | null; head: WorkspaceChangeHeadRecord | null } = { access: accessRecord(), head: { workspaceId, changeSeq: 0n, permissionEpoch: 0n } };
  const findWorkspaceAccess = vi.fn(async (workspace: string, actor: string) => { expect(inside).toBe(true); expect([workspace, actor]).toEqual([workspaceId, actorUserId]); calls.push('authorize'); return state.access; });
  const access: AccessRepository = { findWorkspaceAccess, findUser: async () => null, findUsers: async () => [], listAccessibleWorkspaces: async () => [], listActiveMemberships: async () => [] };
  const findHead = vi.fn(async (workspace: string) => { expect(inside).toBe(true); expect(workspace).toBe(workspaceId); calls.push('head'); return state.head; });
  const repository: WorkspaceChangeHeadReadRepository = new Proxy({ access, findHead }, { get(target, property, receiver) { if (!(property in target)) throw new Error(`Unexpected side-effect interface: ${String(property)}`); return Reflect.get(target, property, receiver); } });
  const run = vi.fn<() => void>();
  const snapshots: WorkspaceChangeHeadReadUnitOfWork = {
    async run<R>(read: (repository: WorkspaceChangeHeadReadRepository) => Promise<R>): Promise<R> {
      run(); expect(inside).toBe(false); inside = true;
      try { return await read(repository); } finally { inside = false; }
    },
  };
  return { app: createWorkspaceChangeHeadApplication(snapshots), state, calls, findHead, findWorkspaceAccess, run };
}
afterEach(() => vi.restoreAllMocks());

describe('authorized workspace change head read', () => {
  it('canonicalizes trusted context and returns current viewer membership metadata inside one snapshot', async () => {
    const h = harness();
    h.state.access = { workspace: { ...accessRecord().workspace, id: workspaceId.toUpperCase() }, membership: { ...accessRecord().membership, id: membershipId.toUpperCase(), workspaceId: workspaceId.toUpperCase(), userId: actorUserId.toUpperCase() } };
    expect(await h.app.getHead({ ...context, workspaceId: workspaceId.toUpperCase(), actor: { ...context.actor, userId: actorUserId.toUpperCase() } })).toEqual({ workspaceId, actorUserId, membershipId, membershipRevision: 7, role: 'viewer', changeSeq: '0', permissionEpoch: '0' });
    expect(h.calls).toEqual(['authorize', 'head']); expect(h.run).toHaveBeenCalledTimes(1);
  });
  it('reauthorizes each read and reflects exact bigint, role, membership and epoch changes without write interfaces', async () => {
    const h = harness();
    const before = {
      access: h.state.access === null ? null : { workspace: { ...h.state.access.workspace }, membership: { ...h.state.access.membership } },
      head: h.state.head === null ? null : { ...h.state.head },
    };
    await h.app.getHead(context); await h.app.getHead(context);
    expect(h.state).toEqual(before);
    h.state.access = { ...accessRecord(), membership: { ...accessRecord().membership, id: id(4), revision: 8, role: 'member' } };
    h.state.head = { workspaceId, changeSeq: 9007199254740993n, permissionEpoch: 9223372036854775807n };
    expect(await h.app.getHead(context)).toMatchObject({ membershipId: id(4), membershipRevision: 8, role: 'member', changeSeq: '9007199254740993', permissionEpoch: '9223372036854775807' });
    expect(h.findWorkspaceAccess).toHaveBeenCalledTimes(3); expect(h.run).toHaveBeenCalledTimes(3);
  });
  it('returns indistinguishable absent/revoked denials before head reads', async () => {
    const h = harness(); h.state.access = null;
    await expect(h.app.getHead(context)).rejects.toMatchObject({ code: 'NOT_FOUND', message: 'The requested resource was not found.' });
    h.state.access = { ...accessRecord(), membership: { ...accessRecord().membership, state: 'revoked' } };
    await expect(h.app.getHead(context)).rejects.toMatchObject({ code: 'NOT_FOUND', message: 'The requested resource was not found.' });
    expect(h.findHead).not.toHaveBeenCalled();
  });
  it('uses the shared workspace.read capability policy before reading scalars', async () => {
    const h = harness(); const policy = vi.spyOn(capabilities, 'roleHasCapability').mockReturnValue(false);
    await expect(h.app.getHead(context)).rejects.toMatchObject({ code: 'CAPABILITY_REQUIRED' });
    expect(policy).toHaveBeenCalledWith('viewer', 'workspace.read'); expect(h.findHead).not.toHaveBeenCalled();
  });
  it('rejects foreign actor, workspace and membership-workspace bindings neutrally before head reads', async () => {
    for (const record of [
      { ...accessRecord(), workspace: { ...accessRecord().workspace, id: id(99) } },
      { ...accessRecord(), membership: { ...accessRecord().membership, workspaceId: id(99) } },
      { ...accessRecord(), membership: { ...accessRecord().membership, userId: id(99) } },
      { ...accessRecord(), membership: { ...accessRecord().membership, id: 'invalid' } },
    ]) { const h = harness(); h.state.access = record; await expect(h.app.getHead(context)).rejects.toMatchObject({ code: 'NOT_FOUND' }); expect(h.findHead).not.toHaveBeenCalled(); }
  });
  it('rejects missing/foreign scalar rows and invalid bigint values without producing a head', async () => {
    for (const head of [null, { workspaceId: id(99), changeSeq: 1n, permissionEpoch: 1n }]) { const h = harness(); h.state.head = head; await expect(h.app.getHead(context)).rejects.toMatchObject({ code: 'NOT_FOUND' }); }
    for (const head of [{ workspaceId, changeSeq: -1n, permissionEpoch: 0n }, { workspaceId, changeSeq: 0n, permissionEpoch: 9223372036854775808n }]) { const h = harness(); h.state.head = head; await expect(h.app.getHead(context)).rejects.toThrow(); }
  });
  it('preserves malformed-context conventions before opening a snapshot', async () => {
    const h = harness();
    await expect(h.app.getHead({ ...context, workspaceId: 'invalid' })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(h.app.getHead({ ...context, actor: { ...context.actor, userId: 'invalid' } })).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
    expect(h.run).not.toHaveBeenCalled();
  });
});
