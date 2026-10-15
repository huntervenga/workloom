import { getWorkspaceForActor, listWorkspaceMembers, listWorkspacesForActor, type ActorContext, type DomainError } from '@workloom/domain';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { DEMO_MEMBERSHIPS, DEMO_USERS, DEMO_WORKSPACES, FIXTURE_MEMBERSHIP_IDS, FIXTURE_USER_IDS, FIXTURE_WORKSPACE_IDS } from '../src/fixtures.js';
import { runMigrations } from '../src/migrations.js';
import { createAccessRepository } from '../src/repositories/access-repository.js';
import { seedDemoData } from '../src/seed/demo-seed.js';
import { createThrowawayDatabase, type ThrowawayDatabase } from './support.js';

async function counts(target: ThrowawayDatabase): Promise<Record<string, number>> {
  const [row] = await target.database.sql<{ users: string; workspaces: string; memberships: string }[]>`
    select (select count(*) from users) as users,
           (select count(*) from workspaces) as workspaces,
           (select count(*) from memberships) as memberships
  `;
  return { users: Number(row?.users), workspaces: Number(row?.workspaces), memberships: Number(row?.memberships) };
}

function actor(userId: string): ActorContext {
  return { actor: { userId, displayName: 'resolved by adapter', kind: 'fixture' }, source: 'web', requestId: 'integration' };
}

async function domainError(promise: Promise<unknown>): Promise<DomainError> {
  try {
    await promise;
  } catch (error) {
    return error as DomainError;
  }
  throw new Error('expected a DomainError');
}

describe('demo seed and access repository on real PostgreSQL', () => {
  let target: ThrowawayDatabase;

  beforeAll(async () => {
    target = await createThrowawayDatabase('seed_access');
    await runMigrations(target.url, { requireLoopback: true });
  });

  afterAll(async () => {
    await target?.drop();
  });

  it('seeds the fixtures once and repeats without duplicating', async () => {
    const first = await seedDemoData(target.database);
    expect(first.users).toEqual({ expected: 7, inserted: 7, alreadyPresent: 0 });
    expect(first.workspaces).toEqual({ expected: 2, inserted: 2, alreadyPresent: 0 });
    expect(first.memberships).toEqual({ expected: 7, inserted: 7, alreadyPresent: 0 });
    expect(first.drift).toEqual([]);
    expect(await counts(target)).toEqual({
      users: DEMO_USERS.length,
      workspaces: DEMO_WORKSPACES.length,
      memberships: DEMO_MEMBERSHIPS.length,
    });

    const second = await seedDemoData(target.database);
    expect(second.users.inserted + second.workspaces.inserted + second.memberships.inserted).toBe(0);
    expect(await counts(target)).toEqual({ users: 7, workspaces: 2, memberships: 7 });
  });

  it('keeps team and outside workspaces isolated', async () => {
    const repository = createAccessRepository(target.database);

    const ownerWorkspaces = await listWorkspacesForActor(repository, actor(FIXTURE_USER_IDS.owner));
    expect(ownerWorkspaces.map((workspace) => [workspace.id, workspace.role])).toEqual([[FIXTURE_WORKSPACE_IDS.team, 'owner']]);

    const outsiderWorkspaces = await listWorkspacesForActor(repository, actor(FIXTURE_USER_IDS.outsider));
    expect(outsiderWorkspaces.map((workspace) => workspace.id)).toEqual([FIXTURE_WORKSPACE_IDS.outside]);

    const members = await listWorkspaceMembers(repository, {
      actor: actor(FIXTURE_USER_IDS.viewer).actor,
      workspaceId: FIXTURE_WORKSPACE_IDS.team,
    });
    expect(members.map((member) => member.role)).toEqual(['owner', 'admin', 'member', 'member', 'member', 'viewer']);
    expect(members.some((member) => member.userId === FIXTURE_USER_IDS.outsider)).toBe(false);

    const denied = await domainError(
      getWorkspaceForActor(repository, { actor: actor(FIXTURE_USER_IDS.outsider).actor, workspaceId: FIXTURE_WORKSPACE_IDS.team }),
    );
    const missing = await domainError(
      getWorkspaceForActor(repository, {
        actor: actor(FIXTURE_USER_IDS.outsider).actor,
        workspaceId: '5eed0000-0000-4000-8000-0000000002ff',
      }),
    );
    expect(denied.code).toBe('NOT_FOUND');
    expect({ code: denied.code, message: denied.message, details: denied.details }).toEqual({
      code: missing.code,
      message: missing.message,
      details: missing.details,
    });
    expect(denied.message).not.toContain('Synthetic Team');
  });

  it('treats malformed IDs as absent instead of raising database errors', async () => {
    const repository = createAccessRepository(target.database);
    expect(await repository.findWorkspaceAccess('not-a-uuid', FIXTURE_USER_IDS.owner)).toBeNull();
    expect(await repository.findUser("'; select 1; --")).toBeNull();
    expect(await repository.findUsers(['nope', FIXTURE_USER_IDS.viewer])).toHaveLength(1);
  });

  it('hides a workspace after its membership is revoked and reports seed drift without reverting it', async () => {
    const repository = createAccessRepository(target.database);
    await target.database.sql`
      update memberships set state = 'revoked', revoked_at = now(), revision = revision + 1
      where id = ${FIXTURE_MEMBERSHIP_IDS.teamMemberB}
    `;

    expect(await listWorkspacesForActor(repository, actor(FIXTURE_USER_IDS.memberB))).toEqual([]);
    const revoked = await domainError(
      getWorkspaceForActor(repository, { actor: actor(FIXTURE_USER_IDS.memberB).actor, workspaceId: FIXTURE_WORKSPACE_IDS.team }),
    );
    expect(revoked.code).toBe('NOT_FOUND');

    const members = await listWorkspaceMembers(repository, {
      actor: actor(FIXTURE_USER_IDS.owner).actor,
      workspaceId: FIXTURE_WORKSPACE_IDS.team,
    });
    expect(members.map((member) => member.userId)).not.toContain(FIXTURE_USER_IDS.memberB);

    const reseed = await seedDemoData(target.database);
    expect(reseed.memberships.inserted).toBe(0);
    expect(reseed.drift).toEqual([expect.stringContaining(FIXTURE_MEMBERSHIP_IDS.teamMemberB)]);
    const [state] = await target.database.sql<{ state: string }[]>`
      select state from memberships where id = ${FIXTURE_MEMBERSHIP_IDS.teamMemberB}
    `;
    expect(state?.state).toBe('revoked');
    expect(await counts(target)).toEqual({ users: 7, workspaces: 2, memberships: 7 });
  });
});
