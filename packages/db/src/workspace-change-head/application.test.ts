import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CommandContext, WorkspaceChangeHeadReadRepository } from '@workloom/domain';
import type { Database, WorkloomExecutor } from '../client.js';
import { createWorkspaceChangeHeadApplication } from './application.js';

const { createRepository } = vi.hoisted(() => ({ createRepository: vi.fn() }));
vi.mock('./repository.js', () => ({ createWorkspaceChangeHeadReadRepository: createRepository }));
const workspaceId = 'aa000000-0000-4000-8000-000000000001';
const actorUserId = 'aa000000-0000-4000-8000-000000000002';
const membershipId = 'aa000000-0000-4000-8000-000000000003';
const context: CommandContext = { workspaceId, actor: { userId: actorUserId, displayName: 'Viewer', kind: 'fixture' }, source: 'web', requestId: 'request' };
afterEach(() => vi.resetAllMocks());

function harness() {
  let active = false;
  const findWorkspaceAccess = vi.fn<WorkspaceChangeHeadReadRepository['access']['findWorkspaceAccess']>(async () => {
    expect(active).toBe(true);
    return { workspace: { id: workspaceId, name: 'Team', timezone: 'UTC', weekStart: 1 }, membership: { id: membershipId, workspaceId, userId: actorUserId, displayName: 'Viewer', role: 'viewer' as const, state: 'active' as const, revision: 2 } };
  });
  const findHead = vi.fn(async () => { expect(active).toBe(true); return { workspaceId, changeSeq: 9007199254740993n, permissionEpoch: 0n }; });
  const repository: WorkspaceChangeHeadReadRepository = { access: { findWorkspaceAccess, findUser: async () => null, findUsers: async () => [], listAccessibleWorkspaces: async () => [], listActiveMemberships: async () => [] }, findHead };
  const tx = {};
  createRepository.mockImplementation((received: unknown) => { expect(received).toBe(tx); expect(active).toBe(true); return repository; });
  const transaction = vi.fn(async <R>(read: (received: unknown) => Promise<R>, options: unknown) => {
    expect(options).toEqual({ isolationLevel: 'repeatable read', accessMode: 'read only' });
    expect(active).toBe(false); active = true;
    try { return await read(tx); } finally { active = false; }
  });
  return { source: { transaction } as unknown as WorkloomExecutor, transaction, findWorkspaceAccess, findHead };
}

describe('workspace change head database application transaction adapter', () => {
  it('uses the exact same read-only repeatable-read transaction for current access and bigint head reads on every call', async () => {
    const h = harness(); const application = createWorkspaceChangeHeadApplication(h.source);
    expect(await application.getHead(context)).toMatchObject({ changeSeq: '9007199254740993', permissionEpoch: '0', role: 'viewer', membershipRevision: 2 });
    await application.getHead(context);
    expect(h.transaction).toHaveBeenCalledTimes(2); expect(createRepository).toHaveBeenCalledTimes(2);
    expect(h.findWorkspaceAccess).toHaveBeenCalledTimes(2); expect(h.findHead).toHaveBeenCalledTimes(2);
  });
  it('reuses an injected Database pool without opening or closing a connection', async () => {
    const h = harness(); const close = vi.fn();
    const database = { db: h.source, sql: {}, close } as unknown as Database;
    await createWorkspaceChangeHeadApplication(database).getHead(context);
    expect(h.transaction).toHaveBeenCalledTimes(1); expect(close).not.toHaveBeenCalled();
  });
  it('propagates authorization denial without issuing a scalar read or starting another transaction', async () => {
    const h = harness(); h.findWorkspaceAccess.mockResolvedValueOnce(null);
    await expect(createWorkspaceChangeHeadApplication(h.source).getHead(context)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(h.transaction).toHaveBeenCalledTimes(1); expect(h.findHead).not.toHaveBeenCalled();
  });
});
