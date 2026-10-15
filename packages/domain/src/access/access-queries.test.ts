import { describe, expect, it } from 'vitest';
import { DomainError, NOT_FOUND_MESSAGE } from '../errors.js';
import {
  authorizeLoadedAccess,
  authorizeWorkspace,
  getCurrentActor,
  getWorkspaceForActor,
  listWorkspaceMembers,
  listWorkspacesForActor,
} from './access-queries.js';
import type { ActorContext } from './context.js';
import type { AccessRepository, MembershipRecord, UserRecord, WorkspaceAccessRecord, WorkspaceRecord } from './ports.js';

// In-memory port double for testing domain decisions only. Persistence and
// tenant boundaries of the real adapter are covered by @workloom/db integration tests.
const teamWorkspace: WorkspaceRecord = { id: 'ws-team', name: 'Synthetic Team', timezone: 'UTC', weekStart: 1 };
const otherWorkspace: WorkspaceRecord = { id: 'ws-other', name: 'Synthetic Other', timezone: 'UTC', weekStart: 1 };

const users: UserRecord[] = [
  { id: 'u-owner', displayName: 'Synthetic Owner', kind: 'fixture' },
  { id: 'u-viewer', displayName: 'Synthetic Viewer', kind: 'fixture' },
  { id: 'u-revoked', displayName: 'Synthetic Revoked', kind: 'fixture' },
  { id: 'u-outsider', displayName: 'Synthetic Outsider', kind: 'fixture' },
];

const memberships: MembershipRecord[] = [
  membership('m-1', teamWorkspace.id, 'u-owner', 'owner', 'active'),
  membership('m-2', teamWorkspace.id, 'u-viewer', 'viewer', 'active'),
  membership('m-3', teamWorkspace.id, 'u-revoked', 'member', 'revoked'),
  membership('m-4', otherWorkspace.id, 'u-outsider', 'owner', 'active'),
];

function membership(
  id: string,
  workspaceId: string,
  userId: string,
  role: MembershipRecord['role'],
  state: MembershipRecord['state'],
): MembershipRecord {
  const user = users.find((candidate) => candidate.id === userId);
  return { id, workspaceId, userId, displayName: user?.displayName ?? '?', role, state, revision: 1 };
}

// Like PostgreSQL uuid columns: lookups match IDs in any case, rows come back in stored (lowercase) form.
const sameId = (left: string, right: string) => left.toLowerCase() === right.toLowerCase();

const repository: AccessRepository = {
  async findUser(userId) {
    return users.find((user) => sameId(user.id, userId)) ?? null;
  },
  async findUsers(userIds) {
    return users.filter((user) => userIds.some((userId) => sameId(user.id, userId)));
  },
  async listAccessibleWorkspaces(userId) {
    return memberships
      .filter((record) => sameId(record.userId, userId) && record.state === 'active')
      .map((record) => toAccess(record));
  },
  async findWorkspaceAccess(workspaceId, userId) {
    const record = memberships.find((item) => sameId(item.workspaceId, workspaceId) && sameId(item.userId, userId));
    return record === undefined ? null : toAccess(record);
  },
  async listActiveMemberships(workspaceId) {
    return memberships.filter((record) => sameId(record.workspaceId, workspaceId) && record.state === 'active');
  },
};

function toAccess(record: MembershipRecord): WorkspaceAccessRecord {
  const workspace = record.workspaceId === teamWorkspace.id ? teamWorkspace : otherWorkspace;
  return { workspace, membership: record };
}

function contextFor(userId: string): ActorContext {
  const user = users.find((candidate) => candidate.id === userId) ?? {
    id: userId,
    displayName: 'Synthetic Ghost',
    kind: 'fixture' as const,
  };
  return { actor: { userId: user.id, displayName: user.displayName, kind: user.kind }, source: 'web', requestId: 'r-1' };
}

async function captureError(promise: Promise<unknown>): Promise<DomainError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof DomainError) {
      return error;
    }
    throw error;
  }
  throw new Error('Expected a DomainError');
}

describe('workspace access queries', () => {
  it('lists only workspaces with an active membership', async () => {
    const owner = await listWorkspacesForActor(repository, contextFor('u-owner'));
    expect(owner.map((workspace) => [workspace.id, workspace.role])).toEqual([['ws-team', 'owner']]);

    const outsider = await listWorkspacesForActor(repository, contextFor('u-outsider'));
    expect(outsider.map((workspace) => workspace.id)).toEqual(['ws-other']);

    expect(await listWorkspacesForActor(repository, contextFor('u-revoked'))).toEqual([]);
  });

  it('returns the workspace with the role of the current member', async () => {
    const view = await getWorkspaceForActor(repository, { actor: contextFor('u-viewer').actor, workspaceId: 'ws-team' });
    expect(view).toEqual({ id: 'ws-team', name: 'Synthetic Team', timezone: 'UTC', weekStart: 1, role: 'viewer' });
  });

  it('answers absent, foreign and revoked memberships with the identical NOT_FOUND', async () => {
    const foreign = await captureError(
      getWorkspaceForActor(repository, { actor: contextFor('u-outsider').actor, workspaceId: 'ws-team' }),
    );
    const revoked = await captureError(
      getWorkspaceForActor(repository, { actor: contextFor('u-revoked').actor, workspaceId: 'ws-team' }),
    );
    const missing = await captureError(
      getWorkspaceForActor(repository, { actor: contextFor('u-owner').actor, workspaceId: 'ws-missing' }),
    );

    for (const error of [foreign, revoked, missing]) {
      expect(error.code).toBe('NOT_FOUND');
      expect(error.message).toBe(NOT_FOUND_MESSAGE);
      expect(error.details).toBeUndefined();
      expect(error.message).not.toContain('Synthetic');
    }
  });

  it('lists active members of an accessible workspace only', async () => {
    const members = await listWorkspaceMembers(repository, { actor: contextFor('u-viewer').actor, workspaceId: 'ws-team' });
    expect(members.map((member) => member.id)).toEqual(['m-1', 'm-2']);

    const denied = await captureError(
      listWorkspaceMembers(repository, { actor: contextFor('u-outsider').actor, workspaceId: 'ws-team' }),
    );
    expect(denied.code).toBe('NOT_FOUND');
  });

  it('matches workspace and actor IDs regardless of letter case', async () => {
    const members = await listWorkspaceMembers(repository, { actor: contextFor('u-viewer').actor, workspaceId: 'WS-TEAM' });
    expect(members.map((member) => member.id)).toEqual(['m-1', 'm-2']);

    const workspaces = await listWorkspacesForActor(repository, contextFor('U-OWNER'));
    expect(workspaces.map((workspace) => workspace.id)).toEqual(['ws-team']);
  });

  it('distinguishes a visible workspace without the capability', async () => {
    const error = await captureError(
      authorizeWorkspace(repository, { actor: contextFor('u-viewer').actor, workspaceId: 'ws-team' }, 'task.edit'),
    );
    expect(error.code).toBe('CAPABILITY_REQUIRED');
    expect(error.retryable).toBe(false);
  });

  it('rejects revoked memberships even when the role would allow the capability', () => {
    const revoked = toAccess(membership('m-9', 'ws-team', 'u-owner', 'owner', 'revoked'));
    expect(() => authorizeLoadedAccess(revoked, 'workspace.read')).toThrow(NOT_FOUND_MESSAGE);
    expect(() => authorizeLoadedAccess(null, 'workspace.read')).toThrow(NOT_FOUND_MESSAGE);
  });

  it('treats an actor missing from persistence as unauthenticated', async () => {
    const error = await captureError(getCurrentActor(repository, contextFor('u-ghost')));
    expect(error.code).toBe('UNAUTHENTICATED');
    expect((await getCurrentActor(repository, contextFor('u-owner'))).displayName).toBe('Synthetic Owner');
  });
});
