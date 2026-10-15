import { isDomainError, type CommandContext } from '@workloom/domain';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { FIXTURE_MEMBERSHIP_IDS, FIXTURE_USER_IDS, FIXTURE_WORKSPACE_IDS } from '../src/fixtures.js';
import { runMigrations } from '../src/migrations.js';
import { seedDemoData } from '../src/seed/demo-seed.js';
import { createWorkspaceWriteRunner, runWorkspaceWrite } from '../src/transactions/workspace-write.js';
import { createThrowawayDatabase, type ThrowawayDatabase } from './support.js';

const ENTITY_ID = '5eed0000-0000-4000-8000-000000000901';

function context(userId: string, workspaceId: string = FIXTURE_WORKSPACE_IDS.team): CommandContext {
  return {
    actor: { userId, displayName: 'resolved by adapter', kind: 'fixture' },
    workspaceId,
    source: 'web',
    requestId: `integration-${userId.slice(-3)}`,
  };
}

describe('workspace write barrier on real PostgreSQL', () => {
  let target: ThrowawayDatabase;

  async function changeSeq(workspaceId: string = FIXTURE_WORKSPACE_IDS.team): Promise<bigint> {
    const [row] = await target.database.sql<{ change_seq: string }[]>`select change_seq from workspaces where id = ${workspaceId}`;
    return BigInt(row?.change_seq ?? '-1');
  }

  async function auditCount(): Promise<number> {
    const [row] = await target.database.sql<{ count: string }[]>`select count(*) from audit_events`;
    return Number(row?.count);
  }

  beforeAll(async () => {
    target = await createThrowawayDatabase('workspace_write');
    await runMigrations(target.url, { requireLoopback: true });
    await seedDemoData(target.database);
  });

  afterAll(async () => {
    await target?.drop();
  });

  it('commits audit and outbox events with one change_seq and ordered ordinals', async () => {
    const before = await changeSeq();
    const runner = createWorkspaceWriteRunner(target.database);
    const recorded = await runner.run(context(FIXTURE_USER_IDS.memberA), 'task.edit', async (scope) => {
      expect(scope.access.membership.id).toBe(FIXTURE_MEMBERSHIP_IDS.teamMemberA);
      expect(scope.barrierAt).toBeInstanceOf(Date);
      expect(Number.isNaN(scope.barrierAt.getTime())).toBe(false);
      return Promise.all([
        scope.recordChange({ entityType: 'probe', entityId: ENTITY_ID, action: 'created', entityRevision: 1 }),
        scope.recordChange({
          entityType: 'probe',
          entityId: ENTITY_ID,
          action: 'updated',
          entityRevision: 2,
          diff: { title: { from: 'a', to: 'b' } },
          outbox: { type: 'probe.updated', payload: { revision: 2 } },
        }),
      ]);
    });

    expect(recorded).toEqual([
      { changeSeq: before + 1n, eventOrdinal: 1 },
      { changeSeq: before + 1n, eventOrdinal: 2 },
    ]);
    expect(await changeSeq()).toBe(before + 1n);

    const audit = await target.database.sql<{ action: string; actor_membership_id: string; source: string }[]>`
      select action, actor_membership_id, source from audit_events
      where workspace_id = ${FIXTURE_WORKSPACE_IDS.team} order by event_ordinal
    `;
    expect(audit.map((row) => row.action)).toEqual(['created', 'updated']);
    expect(audit.every((row) => row.actor_membership_id === FIXTURE_MEMBERSHIP_IDS.teamMemberA && row.source === 'web')).toBe(true);
    const outbox = await target.database.sql<{ type: string; dispatched_at: Date | null }[]>`select type, dispatched_at from outbox_events`;
    expect(outbox).toEqual([{ type: 'probe.updated', dispatched_at: null }]);
  });

  it('rolls back every write of a failed command', async () => {
    const seqBefore = await changeSeq();
    const auditBefore = await auditCount();

    await expect(
      runWorkspaceWrite(target.database, context(FIXTURE_USER_IDS.owner), 'task.edit', async (scope) => {
        await scope.recordChange({ entityType: 'probe', entityId: ENTITY_ID, action: 'updated', outbox: { type: 'probe.updated', payload: {} } });
        await scope.tx.execute(`update workspaces set name = 'Changed inside failed command' where id = '${FIXTURE_WORKSPACE_IDS.team}'`);
        throw new Error('simulated failure after writes');
      }),
    ).rejects.toThrow('simulated failure after writes');

    expect(await changeSeq()).toBe(seqBefore);
    expect(await auditCount()).toBe(auditBefore);
    const [workspace] = await target.database.sql<{ name: string }[]>`select name from workspaces where id = ${FIXTURE_WORKSPACE_IDS.team}`;
    expect(workspace?.name).toBe('Synthetic Team Workspace');
  });

  it('denies outsiders and missing workspaces with NOT_FOUND and viewers with CAPABILITY_REQUIRED', async () => {
    const outsider = runWorkspaceWrite(target.database, context(FIXTURE_USER_IDS.outsider), 'workspace.read', async () => 'unreachable');
    await expect(outsider).rejects.toMatchObject({ code: 'NOT_FOUND' });

    const missing = runWorkspaceWrite(
      target.database,
      context(FIXTURE_USER_IDS.owner, '5eed0000-0000-4000-8000-0000000002ff'),
      'workspace.read',
      async () => 'unreachable',
    );
    await expect(missing).rejects.toMatchObject({ code: 'NOT_FOUND' });

    const malformed = runWorkspaceWrite(target.database, context(FIXTURE_USER_IDS.owner, 'not-a-uuid'), 'workspace.read', async () => 'x');
    await expect(malformed).rejects.toMatchObject({ code: 'NOT_FOUND' });

    const viewer = runWorkspaceWrite(target.database, context(FIXTURE_USER_IDS.viewer), 'task.edit', async () => 'unreachable');
    await expect(viewer).rejects.toMatchObject({ code: 'CAPABILITY_REQUIRED' });
  });

  it('re-checks membership under the barrier after a concurrent revocation', async () => {
    const connection = await target.database.sql.reserve();
    try {
      await connection`begin`;
      await connection`select id from workspaces where id = ${FIXTURE_WORKSPACE_IDS.team} for update`;
      await connection`
        update memberships set state = 'revoked', revoked_at = now(), revision = revision + 1
        where id = ${FIXTURE_MEMBERSHIP_IDS.teamMemberC}
      `;

      const pending = runWorkspaceWrite(target.database, context(FIXTURE_USER_IDS.memberC), 'task.edit', async () => 'should not run');
      // Let the command pass its unlocked pre-check and block on the barrier.
      await new Promise((resolve) => setTimeout(resolve, 300));
      await connection`commit`;

      await expect(pending).rejects.toMatchObject({ code: 'NOT_FOUND' });
    } finally {
      connection.release();
    }
  });

  it('turns a barrier wait beyond lock_timeout into a retryable TEMPORARILY_UNAVAILABLE', async () => {
    const connection = await target.database.sql.reserve();
    try {
      await connection`begin`;
      await connection`select id from workspaces where id = ${FIXTURE_WORKSPACE_IDS.team} for update`;
      const error = await runWorkspaceWrite(target.database, context(FIXTURE_USER_IDS.owner), 'task.edit', async () => 'x', {
        lockTimeoutMs: 200,
      }).catch((caught: unknown) => caught);
      expect(isDomainError(error)).toBe(true);
      expect(error).toMatchObject({ code: 'TEMPORARILY_UNAVAILABLE', retryable: true });
      await connection`rollback`;
    } finally {
      connection.release();
    }
  });

  it('keeps audit history immutable', async () => {
    await expect(target.database.sql`update audit_events set action = 'tampered'`).rejects.toMatchObject({ code: '23001' });
    await expect(target.database.sql`delete from audit_events`).rejects.toMatchObject({ code: '23001' });
    await expect(target.database.sql`truncate audit_events`).rejects.toMatchObject({ code: '23001' });
  });
});
