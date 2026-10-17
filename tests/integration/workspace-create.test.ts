// An owned synthetic child only: migrations + base seed, real principals via the shared-Auth store.
import { randomUUID } from 'node:crypto';
import {
  createDatabase,
  createSharedAuthStore,
  createTaskApplication,
  createWorkspaceCreateApplication,
  runMigrations,
  seedDemoData,
  FIXTURE_USER_IDS,
  type Database,
} from '@workloom/db';
import { isDomainError, type WorkspaceCreateContext } from '@workloom/domain';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createThrowawayDatabase, type ThrowawayDatabase } from './support/test-database.js';
import { requireTestDatabaseUrl } from './support/test-database-url.js';

requireTestDatabaseUrl();

/** Tables a successful creation may grow; every other table must be byte-identical. */
const CREATION_TABLES = ['workspaces', 'memberships', 'audit_events', 'workspace_creation_receipts'];

let target: ThrowawayDatabase | undefined;
let primary: Database | undefined;
let secondary: Database | undefined;
let alice = '';
let bob = '';

function databases(): { primary: Database; secondary: Database; target: ThrowawayDatabase } {
  if (primary === undefined || secondary === undefined || target === undefined) throw new Error('Database setup did not run.');
  return { primary, secondary, target };
}

function context(userId: string, idempotencyKey: string, kind: 'real' | 'fixture' = 'real'): WorkspaceCreateContext {
  return { actor: { userId, displayName: 'Synthetic real person', kind }, source: 'web', requestId: randomUUID(), idempotencyKey };
}

async function codeOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    if (isDomainError(error)) return error.code;
    throw error;
  }
  throw new Error('Expected a domain error.');
}

async function snapshot(): Promise<Record<string, string[]>> {
  const { sql } = databases().target;
  const tables = await sql<{ name: string }[]>`select tablename as name from pg_tables where schemaname='public' order by tablename`;
  const rows: Record<string, string[]> = {};
  for (const { name } of tables) {
    // Names come only from pg_catalog; escape identifiers rather than interpolating values as SQL.
    const quoted = `"${name.replaceAll('"', '""')}"`;
    const values = await sql.unsafe<{ row: unknown }[]>(`select to_jsonb(t) as row from public.${quoted} t`);
    rows[name] = values.map(value => JSON.stringify(value.row)).sort();
  }
  return rows;
}

/** Every earlier row survives unchanged; only creation tables may gain rows. */
function expectPreserved(before: Record<string, string[]>, after: Record<string, string[]>, growing: readonly string[] = CREATION_TABLES): void {
  expect(Object.keys(after).sort()).toEqual(Object.keys(before).sort());
  for (const [name, rows] of Object.entries(before)) {
    const current = after[name] ?? [];
    if (growing.includes(name)) expect(current).toEqual(expect.arrayContaining(rows));
    else expect(current).toEqual(rows);
  }
}

async function workspaceFacts(workspaceId: string) {
  const { sql } = databases().target;
  const [workspace] = await sql<{ change_seq: string; permission_epoch: string; week_start: number; name: string; timezone: string }[]>`
    select change_seq::text, permission_epoch::text, week_start, name, timezone from workspaces where id = ${workspaceId}`;
  const members = await sql<{ id: string; user_id: string; role: string; state: string; revision: number }[]>`
    select id, user_id, role::text, state::text, revision from memberships where workspace_id = ${workspaceId} order by id`;
  const audits = await sql<{ change_seq: string; event_ordinal: number; actor_user_id: string; actor_membership_id: string; credential_id: string | null; source: string; request_id: string; entity_type: string; entity_id: string; action: string }[]>`
    select change_seq::text, event_ordinal, actor_user_id, actor_membership_id, credential_id, source::text, request_id, entity_type, entity_id, action
    from audit_events where workspace_id = ${workspaceId} order by change_seq, event_ordinal`;
  const receipts = await sql<{ actor_user_id: string; idempotency_key: string; payload_hash: string }[]>`
    select actor_user_id, idempotency_key, payload_hash from workspace_creation_receipts where workspace_id = ${workspaceId}`;
  const [content] = await sql<{ projects: number; tasks: number; sections: number; statuses: number; tags: number; outbox: number; idempotency: number }[]>`
    select (select count(*)::int from projects where workspace_id = ${workspaceId}) as projects,
           (select count(*)::int from tasks where workspace_id = ${workspaceId}) as tasks,
           (select count(*)::int from sections where workspace_id = ${workspaceId}) as sections,
           (select count(*)::int from task_statuses where workspace_id = ${workspaceId}) as statuses,
           (select count(*)::int from workspace_tags where workspace_id = ${workspaceId}) as tags,
           (select count(*)::int from outbox_events where workspace_id = ${workspaceId}) as outbox,
           (select count(*)::int from command_idempotency where workspace_id = ${workspaceId}) as idempotency`;
  return { workspace, members, audits, receipts, content };
}

beforeAll(async () => {
  target = await createThrowawayDatabase('workspace_create');
  await runMigrations(target.url, { requireLoopback: true });
  primary = createDatabase(target.url, { requireLoopback: true });
  secondary = createDatabase(target.url, { requireLoopback: true });
  await seedDemoData(primary);
  const store = createSharedAuthStore(primary);
  alice = (await store.provisionIdentity({ issuer: 'https://auth.example.test', subject: 'create-alice', displayName: 'Alice Synthetic', workspaceName: 'Alice first', timezone: 'UTC' })).user.id;
  bob = (await store.provisionIdentity({ issuer: 'https://auth.example.test', subject: 'create-bob', displayName: 'Bob Synthetic', workspaceName: 'Bob first', timezone: 'UTC' })).user.id;
}, 60_000);

afterAll(async () => {
  await primary?.close();
  await secondary?.close();
  await target?.drop();
});

describe('workspace creation against PostgreSQL', () => {
  it('serializes concurrent identical requests from two pools into one workspace, owner, audit, receipt and head 1', async () => {
    const db = databases();
    const before = await snapshot();
    const first = createWorkspaceCreateApplication(db.primary), second = createWorkspaceCreateApplication(db.secondary);
    const firstContext = context(alice, 'concurrent-key'), secondContext = context(alice, 'concurrent-key');
    const [left, right] = await Promise.all([
      first.createWorkspace(firstContext, { name: 'Concurrent team', timezone: 'Europe/Berlin' }),
      second.createWorkspace(secondContext, { name: 'Concurrent team', timezone: 'Europe/Berlin' }),
    ]);
    expect(right).toEqual(left);
    expect(left).toMatchObject({ name: 'Concurrent team', timezone: 'Europe/Berlin', role: 'owner' });

    const after = await snapshot();
    expectPreserved(before, after);
    for (const name of CREATION_TABLES) expect(after[name]?.length).toBe((before[name]?.length ?? 0) + 1);

    const facts = await workspaceFacts(left.id);
    expect(facts.workspace).toEqual({ change_seq: '1', permission_epoch: '0', week_start: 1, name: 'Concurrent team', timezone: 'Europe/Berlin' });
    expect(facts.members).toHaveLength(1);
    const [owner] = facts.members;
    expect(owner).toMatchObject({ user_id: alice, role: 'owner', state: 'active', revision: 1 });
    expect(facts.audits).toHaveLength(1);
    expect(facts.audits[0]).toMatchObject({ change_seq: '1', event_ordinal: 1, actor_user_id: alice, actor_membership_id: owner?.id,
      credential_id: null, source: 'web', entity_type: 'workspace', entity_id: left.id, action: 'created' });
    expect([firstContext.requestId, secondContext.requestId]).toContain(facts.audits[0]?.request_id);
    expect(facts.receipts).toHaveLength(1);
    expect(facts.receipts[0]).toMatchObject({ actor_user_id: alice, idempotency_key: 'concurrent-key' });
    expect(facts.receipts[0]?.payload_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(facts.receipts)).not.toContain('Concurrent team');
    expect(facts.content).toEqual({ projects: 0, tasks: 0, sections: 0, statuses: 0, tags: 0, outbox: 0, idempotency: 0 });
  });

  it('replays an exact retry without new rows and rejects a changed body under the same key', async () => {
    const app = createWorkspaceCreateApplication(databases().primary);
    const created = await app.createWorkspace(context(alice, 'retry-key'), { name: 'Retry team', timezone: 'Asia/Nicosia' });
    const before = await snapshot();
    expect(await app.createWorkspace(context(alice, 'retry-key'), { name: ' Retry team ', timezone: 'Asia/Nicosia' })).toEqual(created);
    expect(await codeOf(app.createWorkspace(context(alice, 'retry-key'), { name: 'Retry team renamed', timezone: 'Asia/Nicosia' }))).toBe('IDEMPOTENCY_KEY_REUSED');
    expect(await codeOf(app.createWorkspace(context(alice, 'retry-key'), { name: 'Retry team', timezone: 'UTC' }))).toBe('IDEMPOTENCY_KEY_REUSED');
    expect(await snapshot()).toEqual(before);
    expect((await workspaceFacts(created.id)).workspace?.change_seq).toBe('1');
  });

  it('scopes keys per actor: the same key for another real actor creates an independent workspace', async () => {
    const app = createWorkspaceCreateApplication(databases().primary);
    const mine = await app.createWorkspace(context(alice, 'shared-key'), { name: 'Shared key team', timezone: 'UTC' });
    const theirs = await app.createWorkspace(context(bob, 'shared-key'), { name: 'Shared key team', timezone: 'UTC' });
    expect(theirs.id).not.toBe(mine.id);
    expect((await workspaceFacts(theirs.id)).members).toEqual([expect.objectContaining({ user_id: bob, role: 'owner' })]);
    expect((await workspaceFacts(mine.id)).members).toEqual([expect.objectContaining({ user_id: alice, role: 'owner' })]);
  });

  it('authorizes replay against the current membership after demotion and revocation, never restoring it', async () => {
    const { target: child } = databases();
    const app = createWorkspaceCreateApplication(databases().primary);
    const created = await app.createWorkspace(context(alice, 'membership-key'), { name: 'Membership team', timezone: 'UTC' });

    await child.sql`update memberships set role = 'viewer', revision = revision + 1, updated_at = now() where workspace_id = ${created.id} and user_id = ${alice}`;
    expect(await app.createWorkspace(context(alice, 'membership-key'), { name: 'Membership team', timezone: 'UTC' })).toEqual({ ...created, role: 'viewer' });

    await child.sql`update memberships set state = 'revoked', revoked_at = now(), revision = revision + 1, updated_at = now() where workspace_id = ${created.id} and user_id = ${alice}`;
    const before = await snapshot();
    expect(await codeOf(app.createWorkspace(context(alice, 'membership-key'), { name: 'Membership team', timezone: 'UTC' }))).toBe('NOT_FOUND');
    expect(await codeOf(app.createWorkspace(context(alice, 'membership-key'), { name: 'Different body', timezone: 'UTC' }))).toBe('NOT_FOUND');
    expect(await snapshot()).toEqual(before);
    expect((await workspaceFacts(created.id)).members).toEqual([expect.objectContaining({ user_id: alice, role: 'viewer', state: 'revoked' })]);
  });

  it('rejects stored fixture principals even when the caller claims a real actor', async () => {
    const app = createWorkspaceCreateApplication(databases().primary);
    const before = await snapshot();
    expect(await codeOf(app.createWorkspace(context(FIXTURE_USER_IDS.owner, 'fixture-key'), { name: 'Fixture team', timezone: 'UTC' }))).toBe('CAPABILITY_REQUIRED');
    expect(await codeOf(app.createWorkspace(context(FIXTURE_USER_IDS.owner, 'fixture-key', 'fixture'), { name: 'Fixture team', timezone: 'UTC' }))).toBe('CAPABILITY_REQUIRED');
    expect(await codeOf(app.createWorkspace(context(randomUUID(), 'ghost-key'), { name: 'Ghost team', timezone: 'UTC' }))).toBe('UNAUTHENTICATED');
    expect(await snapshot()).toEqual(before);
  });

  it('rolls back every row when the transaction fails and the same key then succeeds cleanly', async () => {
    const { target: child } = databases();
    const app = createWorkspaceCreateApplication(databases().primary);
    // Fixture surgery inside the owned child only: fail the last insert of the transaction.
    await child.sql.unsafe(`
      create function workloom_test_fail_receipt() returns trigger language plpgsql as $$
      begin raise exception 'synthetic receipt failure'; end $$;
      create trigger workloom_test_fail_receipt before insert on workspace_creation_receipts
      for each row execute function workloom_test_fail_receipt();
    `);
    const before = await snapshot();
    try {
      await expect(app.createWorkspace(context(bob, 'rollback-key'), { name: 'Rollback team', timezone: 'UTC' })).rejects.toThrow();
      expect(await snapshot()).toEqual(before);
    } finally {
      await child.sql.unsafe(`
        drop trigger workloom_test_fail_receipt on workspace_creation_receipts;
        drop function workloom_test_fail_receipt();
      `);
    }
    const created = await app.createWorkspace(context(bob, 'rollback-key'), { name: 'Rollback team', timezone: 'UTC' });
    const facts = await workspaceFacts(created.id);
    expect(facts.workspace?.change_seq).toBe('1');
    expect(facts.audits).toHaveLength(1);
    expect(facts.receipts).toHaveLength(1);
  });

  it('leaves first and fixture workspaces untouched and supports ordinary project creation in the new workspace', async () => {
    const { target: child, primary: db } = databases();
    const app = createWorkspaceCreateApplication(db);
    const created = await app.createWorkspace(context(alice, 'project-key'), { name: 'Project team', timezone: 'UTC' });
    const fixtureMembers = await child.sql`select 1 from memberships m join users u on u.id = m.user_id where m.workspace_id = ${created.id} and u.kind = 'fixture'`;
    expect(fixtureMembers).toHaveLength(0);
    expect((await workspaceFacts(created.id)).content).toEqual({ projects: 0, tasks: 0, sections: 0, statuses: 0, tags: 0, outbox: 0, idempotency: 0 });

    const before = await snapshot();
    const tasks = createTaskApplication(db);
    const project = await tasks.createProject({ workspaceId: created.id, actor: { userId: alice, displayName: 'Alice Synthetic', kind: 'real' },
      source: 'web', requestId: randomUUID(), idempotencyKey: randomUUID() }, { name: 'First project' });
    expect(project.name).toBe('First project');
    const after = await snapshot();
    // Only the new workspace gains rows (its own head advances); every other earlier row is preserved.
    for (const [name, rows] of Object.entries(before)) {
      if (name !== 'workspaces') expect(after[name]).toEqual(expect.arrayContaining(rows));
    }
    const otherWorkspaces = (before['workspaces'] ?? []).filter(row => !row.includes(created.id));
    expect(after['workspaces']).toEqual(expect.arrayContaining(otherWorkspaces));
    const facts = await workspaceFacts(created.id);
    expect(facts.content.projects).toBe(1);
    expect(facts.content.tasks).toBe(0);
  });
});
