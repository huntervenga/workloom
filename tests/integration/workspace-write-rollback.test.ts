// Real PostgreSQL: the workspace write protocol (packages/db runWorkspaceWrite) commits
// state + audit + outbox together, and a failing SQL statement rolls all of it back.
import { randomUUID } from 'node:crypto';

import { createDatabase, runMigrations, runWorkspaceWrite, schema, type Database } from '@workloom/db';
import { isDomainError, type CommandContext } from '@workloom/domain';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createThrowawayDatabase, type ThrowawayDatabase } from './support/test-database.js';
import { requireTestDatabaseUrl } from './support/test-database-url.js';

requireTestDatabaseUrl();

const workspaceId = randomUUID();
const actorId = randomUUID();
const membershipId = randomUUID();

function context(requestId: string): CommandContext {
  return {
    actor: { userId: actorId, displayName: 'Synthetic Rollback Actor', kind: 'fixture' },
    source: 'api',
    requestId,
    workspaceId,
  };
}

describe('workspace write transaction on PostgreSQL', () => {
  let throwaway: ThrowawayDatabase;
  let database: Database;

  async function snapshot() {
    const [row] = await throwaway.sql<{ change_seq: string; audit: string; outbox: string; users: string }[]>`
      select (select change_seq::text from workspaces where id = ${workspaceId}) as change_seq,
             (select count(*)::text from audit_events where workspace_id = ${workspaceId}) as audit,
             (select count(*)::text from outbox_events where workspace_id = ${workspaceId}) as outbox,
             (select count(*)::text from users) as users`;
    return row;
  }

  beforeAll(async () => {
    throwaway = await createThrowawayDatabase('rollback');
    await runMigrations(throwaway.url, { requireLoopback: true });
    await throwaway.sql`insert into users (id, display_name, kind) values (${actorId}, 'Synthetic Rollback Actor', 'fixture')`;
    await throwaway.sql`insert into workspaces (id, name, timezone) values (${workspaceId}, 'Synthetic Rollback Space', 'Asia/Nicosia')`;
    await throwaway.sql`
      insert into memberships (id, workspace_id, user_id, role) values (${membershipId}, ${workspaceId}, ${actorId}, 'owner')`;
    database = createDatabase(throwaway.url, { maxConnections: 2, requireLoopback: true });
  });

  afterAll(async () => {
    await database?.close();
    await throwaway?.drop();
  });

  it('commits audit and outbox rows and advances change_seq once (control case)', async () => {
    const before = await snapshot();
    const recorded = await runWorkspaceWrite(database, context('req_commit_1'), 'workspace.read', async (scope) => {
      const first = await scope.recordChange({
        entityType: 'workspace',
        entityId: workspaceId,
        action: 'test.touch',
        outbox: { type: 'test.touched', payload: {} },
      });
      const second = await scope.recordChange({ entityType: 'workspace', entityId: workspaceId, action: 'test.touch' });
      return [first, second];
    });

    expect(recorded.map((change) => change.eventOrdinal)).toEqual([1, 2]);
    expect(recorded[0]?.changeSeq).toBe(recorded[1]?.changeSeq);
    const after = await snapshot();
    expect(BigInt(after?.change_seq ?? '0')).toBe(BigInt(before?.change_seq ?? '0') + 1n);
    expect(Number(after?.audit)).toBe(Number(before?.audit) + 2);
    expect(Number(after?.outbox)).toBe(Number(before?.outbox) + 1);
  });

  it('rolls back the row, audit, outbox and change_seq when a later SQL statement fails', async () => {
    const before = await snapshot();
    const insertedUserId = randomUUID();

    const failure = await runWorkspaceWrite(database, context('req_rollback_1'), 'workspace.read', async (scope) => {
      await scope.tx.insert(schema.users).values({ id: insertedUserId, displayName: 'Synthetic Rolled Back', kind: 'fixture' });
      await scope.recordChange({
        entityType: 'user',
        entityId: insertedUserId,
        action: 'test.create',
        outbox: { type: 'test.created', payload: {} },
      });
      // Violates users_display_name_length: the statement itself fails inside the transaction.
      await scope.tx.insert(schema.users).values({ id: randomUUID(), displayName: '   ', kind: 'fixture' });
      return 'unreachable';
    }).then(
      () => null,
      (error: unknown) => error,
    );

    expect(failure).not.toBeNull();
    expect(await snapshot()).toEqual(before);
    const leftover = await throwaway.sql`select 1 from users where id = ${insertedUserId}`;
    expect(leftover).toHaveLength(0);
  });

  it('refuses a revoked membership under the barrier and writes nothing', async () => {
    await throwaway.sql`
      update memberships set state = 'revoked', revoked_at = now(), revision = revision + 1 where id = ${membershipId}`;
    const before = await snapshot();
    let workRan = false;

    const failure = await runWorkspaceWrite(database, context('req_revoked_1'), 'workspace.read', async (scope) => {
      workRan = true;
      await scope.recordChange({ entityType: 'workspace', entityId: workspaceId, action: 'test.touch' });
    }).then(
      () => null,
      (error: unknown) => error,
    );

    expect(isDomainError(failure)).toBe(true);
    expect(isDomainError(failure) && failure.code).toBe('NOT_FOUND');
    expect(workRan).toBe(false);
    expect(await snapshot()).toEqual(before);
  });
});
