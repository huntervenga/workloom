// Root executes only against a newly owned test child, never the preserved main.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDatabase, createSharedAuthStore, runMigrations, type Database } from '@workloom/db';
import { applyWeeklyDemo, FIXTURE_SHA, type DemoState } from '../../scripts/bootstrap-hunterman-weekly-demo.mjs';
import { createThrowawayDatabase, type ThrowawayDatabase } from './support/test-database.js';
import { requireTestDatabaseUrl } from './support/test-database-url.js';
requireTestDatabaseUrl();
describe('additive five-person demo through real domain commands', () => {
  let target: ThrowawayDatabase; let db: Database;
  beforeAll(async () => { target = await createThrowawayDatabase('hunterman_demo'); await runMigrations(target.url, { requireLoopback: true }); db = createDatabase(target.url, { requireLoopback: true }); });
  afterAll(async () => { try { await db?.close(); } finally { await target?.drop(); } });
  it('captures real plans before facts, preserves unrelated rows and replays without duplicate entities', async () => {
    const identity = await createSharedAuthStore(db).provisionIdentity({ issuer: 'https://auth.example.test', subject: randomUUID(), displayName: 'Private demo owner', workspaceName: 'Private demo target', timezone: 'Asia/Nicosia' });
    const state: DemoState = { version: 1, workspaceId: identity.workspaceId, ownerUserId: identity.user.id, fixtureSHA: FIXTURE_SHA, commands: {} };
    const persist = async () => {};
    const first = await applyWeeklyDemo({ db, workspaceId: identity.workspaceId, ownerUserId: identity.user.id, state, persist });
    expect(first.checks.failed).toBe(0); expect(first.checks.passed).toBeGreaterThan(30);
    const counts = async () => db.sql`select (select count(*) from users)::int users,(select count(*) from memberships)::int members,(select count(*) from projects)::int projects,(select count(*) from tasks)::int tasks,(select count(*) from plan_baselines)::int baselines,(select count(*) from work_logs)::int facts,(select count(*) from shared_auth_identities)::int auth_identities`;
    const latest = await db.sql`select id, document->'membershipIds' as membership_ids from weekly_report_runs where period_id=${first.complete.periodId} order by created_at desc, id desc limit 1`;
    expect(latest[0]?.id).toBe(first.complete.runId);
    expect(latest[0]?.membership_ids).toHaveLength(5);
    const before = await counts(); expect(before[0]).toMatchObject({ users: 5, members: 5, projects: 1, tasks: 32, baselines: 6, facts: 31, auth_identities: 1 });
    const repeat = await applyWeeklyDemo({ db, workspaceId: identity.workspaceId, ownerUserId: identity.user.id, state, persist });
    expect(repeat.complete.runId).toBe(first.complete.runId); expect(await counts()).toEqual(before);
    const [owner] = await db.sql`select kind,display_name from users where id=${identity.user.id}`; expect(owner).toMatchObject({ kind: 'real', display_name: 'Private demo owner' });
  });
});
