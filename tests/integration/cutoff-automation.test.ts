import { randomUUID } from 'node:crypto';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { CutoffJob, PlanningPeriodDto, RecurrenceCreatePreviewInput } from '@workloom/contracts';
import type { CommandContext } from '@workloom/domain';
import { createDatabase, createCutoffApplication, createCutoffWorkerFacade, createCutoffDiscovery, createCutoffOutboxRelay, createPlanningApplication, createRecurrenceApplication, runMigrations, MIGRATIONS_FOLDER, createReadinessProbe, FIXTURE_USER_IDS as U, FIXTURE_MEMBERSHIP_IDS as M, FIXTURE_WORKSPACE_IDS as W, schema, type Database } from '@workloom/db';
import { createCutoffRepository } from '../../packages/db/src/cutoff/repository.js';
import { createApp } from '../../apps/api/src/app.js';
import { loadConfig } from '../../apps/api/src/config.js';
import { createThrowawayDatabase, type ThrowawayDatabase } from './support/test-database.js';
import { requireTestDatabaseUrl } from './support/test-database-url.js';
import { seedLegacyDemoData } from './support/legacy-upgrade-fixture.js';
requireTestDatabaseUrl();
const context = (userId: string = U.owner, key = randomUUID(), workspaceId: string = W.team): CommandContext => ({ workspaceId, actor: { userId, displayName: 'Synthetic cutoff test', kind: 'fixture' }, source: 'web', requestId: randomUUID(), idempotencyKey: key });
function required<T>(value: T | null | undefined): T { if (value === null || value === undefined) throw new Error('Expected fixture value.'); return value; }

let target: ThrowawayDatabase | undefined;
let db: Database;
let expectedUpgradeTags: readonly string[];
let upgrade: { applied: readonly string[]; unchanged: boolean; historyUnchanged: boolean; pendingNotReady: boolean; ready: boolean; periodId: string }; 
const app = () => createCutoffApplication(db);
const worker = () => createCutoffWorkerFacade(db);
const repo = () => createCutoffRepository(db.db);
async function period(id: string): Promise<PlanningPeriodDto> { return required(await repo().planning.findPeriod(W.team, id)); }
async function job(requestId: string): Promise<CutoffJob> { return required(await repo().request(W.team, requestId)).job; }
async function projectBaselineCount(id: string) { const rows = await db.sql`select count(*)::int as n from plan_baselines where period_id=${id} and scope='project'`; return Number(rows[0]?.n); }
async function digest() {
  const result: Record<string, string> = {};
  for (const table of ['workspaces','memberships','planning_periods','planning_cutoff_automations','planning_cutoff_grant_versions','planning_cutoff_requests','planning_cutoff_discovery_state','tasks','work_packages','period_commitments','plan_baselines','package_baselines','package_freeze_observations','planning_locks','recurrence_instances','meetings','audit_events','outbox_events','command_idempotency','weekly_report_runs']) {
    const [row] = await db.sql.unsafe<{ value: string }[]>(`select md5(coalesce(jsonb_agg(to_jsonb(t) order by to_jsonb(t)::text)::text,'[]')) as value from "${table}" t`);
    result[table] = row?.value ?? '';
  }
  return result;
}
async function fixture(due = true, estimateMinutes: number | null = 120) {
  const projectId = randomUUID(), statusId = randomUUID(), packageId = randomUUID(), taskId = randomUUID(), detailId = randomUUID(), periodId = randomUUID(), at = new Date();
  await db.db.insert(schema.projects).values({ id: projectId, workspaceId: W.team, name: 'Cutoff synthetic project' });
  await db.db.insert(schema.taskStatuses).values({ id: statusId, workspaceId: W.team, projectId, name: 'To do', group: 'todo', position: 0 });
  await db.db.insert(schema.workPackages).values({ id: packageId, workspaceId: W.team, projectId, origin: 'new_task', estimateMinutes });
  await db.db.insert(schema.tasks).values([{ id: taskId, workspaceId: W.team, projectId, workPackageId: packageId, statusId, title: 'Cutoff root', position: 0 }, { id: detailId, workspaceId: W.team, projectId, parentTaskId: taskId, workPackageId: packageId, statusId, title: 'Shared package detail', position: 1 }]);
  await db.db.insert(schema.planningPeriods).values({ id: periodId, workspaceId: W.team, projectId, name: 'Explicit cutoff period', localStart: '2026-10-12', localEndExclusive: '2026-10-19', timezone: 'UTC', cutoffAt: new Date(at.getTime() + (due ? -60_000 : 3_600_000)), revision: 1, protectedFieldIds: [], protectEstimate: true, createdAt: at, updatedAt: at });
  await db.db.insert(schema.periodCommitments).values({ id: randomUUID(), workspaceId: W.team, projectId, periodId, workPackageId: packageId, membershipId: M.teamOwner, plannedMinutes: 60, revision: 1, createdAt: at, updatedAt: at });
  return { projectId, statusId, packageId, taskId, detailId, periodId };
}
async function enable(id: string, actor = U.owner) { return app().configure(context(actor), id, { expectedPeriodRevision: (await period(id)).revision, expectedGrantRevision: (await repo().currentGrant(W.team, id))?.revision ?? 0, enabled: true }); }


async function series(f: Awaited<ReturnType<typeof fixture>>, count = 7, actor: string = U.owner, paused = false, startDate = '2026-10-12') {
  const recurrence = createRecurrenceApplication(db);
  const input: RecurrenceCreatePreviewInput = { schedule: { startDate, localTime: '09:00', timezone: 'UTC', frequency: 'daily', plannedDurationMinutes: 30, end: { kind: 'after_count', count } }, template: { title: 'Cutoff calendar source', statusId: f.statusId, organizerMembershipId: M.teamOwner, attendeeMembershipIds: [M.teamOwner] }, targetPeriodIds: [f.periodId] };
  const preview = await recurrence.previewCreate(context(actor), f.projectId, input);
  const created = await recurrence.createSeries(context(actor), f.projectId, { ...input, previewHash: preview.previewHash });
  return paused ? recurrence.setState(context(actor), created.id, { expectedRevision: created.revision, state: 'paused' }) : created;
}
async function makeDue(id: string) { await db.sql`update planning_periods set cutoff_at=clock_timestamp()-interval '1 minute', revision=revision+1 where id=${id}`; }
async function calendarCount(id: string) { const [row] = await db.sql`select count(*)::int as n from recurrence_instances where period_id=${id} and meeting_id is not null`; return Number(row?.n); }

describe('explicit cutoff automation on an owned throwaway PostgreSQL child', () => {
  beforeAll(async () => {
    target = await createThrowawayDatabase('cutoff_backend'); console.info(`CUTOFF_DISPOSABLE_DB=${target.name}`);
    const prior = mkdtempSync(join(tmpdir(), 'workloom-cutoff-prior-migrations-'));
    try {
      const journal = JSON.parse(readFileSync(join(MIGRATIONS_FOLDER, 'meta', '_journal.json'), 'utf8')) as { entries: { tag: string }[] };
      const cutoffIndex = journal.entries.findIndex(entry => entry.tag === '0013_planning_cutoff_automation');
      expect(cutoffIndex).toBe(13);
      expectedUpgradeTags = journal.entries.slice(cutoffIndex).map(entry => entry.tag);
      journal.entries = journal.entries.slice(0, cutoffIndex);
      mkdirSync(join(prior, 'meta')); writeFileSync(join(prior, 'meta', '_journal.json'), JSON.stringify(journal));
      for (const entry of journal.entries) copyFileSync(join(MIGRATIONS_FOLDER, `${entry.tag}.sql`), join(prior, `${entry.tag}.sql`));
      await runMigrations(target.url, { requireLoopback: true, migrationsFolder: prior });
    } finally { rmSync(prior, { recursive: true, force: true }); }
    db = createDatabase(target.url, { requireLoopback: true, maxConnections: 8 });
    // This child is still pre-0013: current mapped inserts include later columns such as users.avatar_url.
    await seedLegacyDemoData(db.sql);
    const oldPeriod = await fixture(false);
    const names = (await db.sql`select table_name from information_schema.tables where table_schema='public' and table_type='BASE TABLE' order by table_name`).map(row => String(row.table_name));
    // Preserve every original column; additive migrations may introduce new nullable columns.
    const legacyColumns = await db.sql<{ table_name: string; column_name: string }[]>`select table_name, column_name from information_schema.columns where table_schema='public' order by table_name, ordinal_position`;
    const snapshot = async () => {
      const result: Record<string, string> = {};
      for (const name of names) {
        const columns = legacyColumns.filter(column => column.table_name === name).map(column => column.column_name);
        if (!/^[a-z_]+$/.test(name) || !columns.length || columns.some(column => !/^[a-z_]+$/.test(column))) throw new Error('Unsafe synthetic snapshot identifier.');
        const projection = columns.map(column => `"${column}"`).join(',');
        const [row] = await db.sql.unsafe<{ hash: string }[]>(`select md5(coalesce(jsonb_agg(to_jsonb(t) order by to_jsonb(t)::text)::text,'[]')) as hash from (select ${projection} from "${name}") t`);
        result[name] = row?.hash ?? '';
      }
      return result;
    };
    const before = await snapshot(), history = await db.sql`select * from drizzle.__drizzle_migrations order by created_at`, pendingNotReady = !(await createReadinessProbe(db).check()).ready;
    const migration = await runMigrations(target.url, { requireLoopback: true });
    const afterHistory = await db.sql`select * from drizzle.__drizzle_migrations order by created_at`;
    upgrade = { applied: migration.appliedNow, unchanged: JSON.stringify(await snapshot()) === JSON.stringify(before), historyUnchanged: JSON.stringify(afterHistory.slice(0, history.length)) === JSON.stringify(history), pendingNotReady, ready: (await createReadinessProbe(db).check()).ready, periodId: oldPeriod.periodId };
  }, 60_000);
  afterAll(async () => { try { await db?.close(); } finally { await target?.drop(); } });

  it('upgrades populated pre-0013 data and journal without opting existing periods into automation', async () => {
    expect(upgrade).toMatchObject({ applied: expectedUpgradeTags, unchanged: true, historyUnchanged: true, pendingNotReady: true, ready: true });
    expect(await app().getReadiness(context(), upgrade.periodId)).toMatchObject({ persistedState: 'planning', automation: { state: 'not_configured', grant: null }, latestRequest: null, missingCount: 0, blockedCount: 0 });
    for (const table of ['planning_cutoff_automations','planning_cutoff_grant_versions','planning_cutoff_requests']) expect(await db.sql.unsafe(`select * from "${table}"`)).toHaveLength(0);
  });

  it('reads truthful overdue state for owner/viewer without writing or implying delegation', async () => {
    const f = await fixture(); const before = await digest();
    const own = await app().getReadiness(context(), f.periodId), viewer = await app().getReadiness(context(U.viewer), f.periodId);
    expect(own).toMatchObject({ persistedState: 'planning', readiness: 'overdue_waiting', baseline: null, automation: { state: 'not_configured', grant: null }, missingCount: 0, blockedCount: 0, blockers: [], latestRequest: null, actions: { canConfigure: true, canRetry: false } });
    expect(viewer.actions).toEqual({ canConfigure: false, canRetry: false, canFreezeProject: false });
    expect(Date.parse(own.serverNow)).toBeGreaterThan(Date.parse(own.cutoffAt));
    await expect(app().getReadiness(context(U.outsider), f.periodId)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(app().configure(context(U.viewer), f.periodId, { expectedPeriodRevision: 1, expectedGrantRevision: 0, enabled: true })).rejects.toMatchObject({ code: 'CAPABILITY_REQUIRED' });
    expect(await digest()).toEqual(before);
  });

  it('opts in explicitly, replays public commands exactly and replaces/revokes without restoring old authority', async () => {
    const f = await fixture(false), key = randomUUID(), input = { expectedPeriodRevision: 1, expectedGrantRevision: 0, enabled: true };
    const configured = await app().configure(context(U.owner, key), f.periodId, input); const saved = await digest();
    expect(await app().configure(context(U.owner, key), f.periodId, input)).toEqual(configured); expect(await digest()).toEqual(saved);
    await expect(app().configure(context(), f.periodId, input)).rejects.toMatchObject({ code: 'REVISION_CONFLICT' });
    await expect(app().configure(context(U.owner, key), f.periodId, { ...input, enabled: false })).rejects.toMatchObject({ code: 'IDEMPOTENCY_KEY_REUSED' });
    const replaced = await enable(f.periodId); expect(replaced.grant).toMatchObject({ id: configured.grant.id, revision: 2, state: 'active' });
    const revoked = await app().configure(context(), f.periodId, { expectedPeriodRevision: 1, expectedGrantRevision: 2, enabled: false });
    expect(revoked).toMatchObject({ requestId: null, grant: { revision: 3, state: 'revoked' } });
    const after = await digest();
    expect(await app().configure(context(U.owner, key), f.periodId, input)).toEqual(configured);
    expect(await digest()).toEqual(after); expect((await repo().currentGrant(W.team, f.periodId))?.revision).toBe(3);
    expect(await worker().freezeDuePeriod(await job(required(configured.requestId)))).toMatchObject({ status: 'blocked', blockedCode: 'cutoff_grant_stale' });
  });

  it('uses a fresh durably scheduled request after early delivery and preserves lost-ACK outcome', async () => {
    const f = await fixture(false), configured = await enable(f.periodId), original = await job(required(configured.requestId));
    const outcome = await worker().freezeDuePeriod(original);
    expect(outcome).toMatchObject({ status: 'not_due', createdCount: 0, baselineId: null });
    expect(outcome.nextRequestId).not.toBe(original.requestId);
    expect((await job(required(outcome.nextRequestId))).cutoffAt).toBe(original.cutoffAt);
    const before = await digest(); expect(await worker().freezeDuePeriod(original)).toEqual(outcome); expect(await digest()).toEqual(before);
    expect(await projectBaselineCount(f.periodId)).toBe(0);
    expect((await app().getReadiness(context(), f.periodId)).latestRequest?.state).toBe('scheduled');
  });

  it('freezes shared packages once, preserves unknown originals and returns an exact durable receipt', async () => {
    const f = await fixture(true, null), configured = await enable(f.periodId), original = await job(required(configured.requestId));
    const outcome = await worker().freezeDuePeriod(original);
    expect(outcome).toMatchObject({ status: 'frozen', createdCount: 0, remainingCount: 0 });
    expect(await projectBaselineCount(f.periodId)).toBe(1);
    const observations = await db.sql`select estimate_minutes from package_freeze_observations where work_package_id=${f.packageId}`; expect(observations).toEqual([{ estimate_minutes: null }]);
    expect(await db.sql`select id from package_baselines where work_package_id=${f.packageId}`).toHaveLength(0);
    const state = await app().getReadiness(context(), f.periodId); expect(state).toMatchObject({ persistedState: 'frozen', readiness: 'frozen', missingCount: 0, blockedCount: 0, blockers: [], baseline: { id: outcome.baselineId, frozenAt: outcome.frozenAt } });
    await db.db.update(schema.workPackages).set({ estimateMinutes: 500, revision: 2 }).where(eq(schema.workPackages.id, f.packageId));
    const before = await digest(); expect(await worker().freezeDuePeriod(original)).toEqual(outcome); expect(await digest()).toEqual(before);
    const audit = await db.sql`select source, actor_user_id, diff from audit_events where request_id=${`cutoff:${original.requestId}`} and entity_type='plan_baseline'`;
    expect(audit.length).toBeGreaterThan(0); expect(audit.every(row => row.source === 'job' && row.actor_user_id === U.owner && row.diff.cutoffJob.grantId === configured.grant.id)).toBe(true);
    expect(await db.sql`select id from weekly_report_runs where period_id=${f.periodId}`).toHaveLength(0);
  });

  it('rechecks downgrade/revocation before an existing worker receipt with no new writes', async () => {
    const f = await fixture(), configured = await enable(f.periodId), original = await job(required(configured.requestId));
    await worker().freezeDuePeriod(original);
    await db.sql`update memberships set role='member' where id=${M.teamOwner}`;
    try { const before = await digest(); expect(await worker().freezeDuePeriod(original)).toMatchObject({ status: 'blocked', blockedCode: 'cutoff_authorizer_capability_revoked' }); expect(await digest()).toEqual(before); }
    finally { await db.sql`update memberships set role='owner' where id=${M.teamOwner}`; }
    await db.sql`update memberships set state='revoked', revoked_at=now() where id=${M.teamOwner}`;
    try { const before = await digest(); expect(await worker().freezeDuePeriod(original)).toMatchObject({ status: 'blocked', blockedCode: 'cutoff_authorizer_inactive' }); expect(await digest()).toEqual(before); }
    finally { await db.sql`update memberships set state='active', revoked_at=null where id=${M.teamOwner}`; }
    await app().configure(context(), f.periodId, { expectedPeriodRevision: (await period(f.periodId)).revision, expectedGrantRevision: configured.grant.revision, enabled: false });
    const before = await digest(); expect((await worker().freezeDuePeriod(original)).status).toBe('blocked'); expect(await digest()).toEqual(before);
    expect(await app().getReadiness(context(), f.periodId)).toMatchObject({ readiness: 'frozen', automation: { state: 'revoked' }, missingCount: 0, blockedCount: 0, blockers: [] });
  });

  it('serializes duplicate deliveries to one baseline and one exact original result', async () => {
    const f = await fixture(), configured = await enable(f.periodId), original = await job(required(configured.requestId));
    const [one, two] = await Promise.all([worker().freezeDuePeriod(original), worker().freezeDuePeriod(original)]);
    expect(two).toEqual(one); expect(await projectBaselineCount(f.periodId)).toBe(1);
  });

  it('enqueues changed cutoff sources in the same user transaction and never freezes from stale inputs', async () => {
    const f = await fixture(false), configured = await enable(f.periodId), original = await job(required(configured.requestId));
    const nextCutoff = new Date(Date.parse(original.cutoffAt) + 3_600_000).toISOString();
    const changed = await createPlanningApplication(db).updatePeriod(context(), f.periodId, { expectedRevision: 1, cutoffAt: nextCutoff });
    const live = required(await repo().liveRequest(W.team, f.periodId)); expect(live.job).toMatchObject({ cutoffAt: nextCutoff, periodRevision: changed.revision });
    expect(live.job.requestId).not.toBe(original.requestId);
    expect(await worker().freezeDuePeriod(original)).toMatchObject({ status: 'stale', nextRequestId: live.job.requestId, baselineId: null });
    expect(await projectBaselineCount(f.periodId)).toBe(0);
  });

  it.each(['2026-10-20T10:00:00Z', '2026-10-20T10:00:00.1Z', '2026-10-20T10:00:00.123456Z'])('canonicalizes new internal cutoff request timestamps from accepted public input %s', async cutoffAt => {
    const f = await fixture(false); await enable(f.periodId);
    const next = await createPlanningApplication(db).updatePeriod(context(), f.periodId, { expectedRevision: 1, cutoffAt });
    expect(next.cutoffAt).toBe(cutoffAt);
    const current = required(await repo().liveRequest(W.team, f.periodId));
    expect(current.job.cutoffAt).toBe(new Date(cutoffAt).toISOString());
    const received: CutoffJob[] = [];
    await createCutoffOutboxRelay(db).relayBatch(async (_tx, event) => { received.push({ ...event.payload, workspaceId: event.workspaceId, schemaVersion: event.schemaVersion }); return { accepted: true, jobId: event.eventId }; }, 100);
    expect(received.some(delivery => delivery.requestId === current.job.requestId)).toBe(true);
    const outcome = await worker().freezeDuePeriod(current.job);
    expect(outcome.status).toBe('not_due');
    expect(await worker().freezeDuePeriod(current.job)).toEqual(outcome);
  });

  it('keeps two overdue calendars independent and persists a <=100-create continuation before freezing', async () => {
    const a = await fixture(false), b = await fixture(false);
    for (let i = 0; i < 16; i++) { await series(a, 7, U.owner, i === 0); await series(b); }
    await makeDue(a.periodId); await makeDue(b.periodId);
    const one = await enable(a.periodId), two = await enable(b.periodId);
    expect((await app().getReadiness(context(), a.periodId)).missingCount).toBe(112);
    const original = await job(required(one.requestId)), pending = await worker().freezeDuePeriod(original);
    expect(pending).toMatchObject({ status: 'pending', createdCount: 100, remainingCount: 12, baselineId: null });
    expect(await calendarCount(a.periodId)).toBe(100); expect(await calendarCount(b.periodId)).toBe(0);
    expect(await projectBaselineCount(a.periodId)).toBe(0); expect(await projectBaselineCount(b.periodId)).toBe(0);
    expect(await app().getReadiness(context(), a.periodId)).toMatchObject({ readiness: 'preparing_calendar', missingCount: 12, latestOutcome: { status: 'pending' }, latestRequest: { id: pending.nextRequestId, state: 'pending' } });
    const unchanged = await digest(); expect(await worker().freezeDuePeriod(original)).toEqual(pending); expect(await digest()).toEqual(unchanged);
    const frozen = await worker().freezeDuePeriod(await job(required(pending.nextRequestId)));
    expect(frozen).toMatchObject({ status: 'frozen', createdCount: 12, remainingCount: 0 }); expect(await calendarCount(a.periodId)).toBe(112);
    expect(await calendarCount(b.periodId)).toBe(0); expect(await projectBaselineCount(b.periodId)).toBe(0);
    const other = await worker().freezeDuePeriod(await job(required(two.requestId))); expect(other).toMatchObject({ status: 'pending', createdCount: 100, remainingCount: 12 });
    expect((await worker().freezeDuePeriod(await job(required(other.nextRequestId)))).status).toBe('frozen');
    expect(await projectBaselineCount(a.periodId)).toBe(1); expect(await projectBaselineCount(b.periodId)).toBe(1);
    const paused = await db.sql`select state from recurrence_series where project_id=${a.projectId} and state='paused'`; expect(paused).toHaveLength(1);
  }, 60_000);

  it('requires generation authority only for actual missing creations and explicit renewal creates a fresh cutoff request', async () => {
    const f = await fixture(false), source = await series(f, 2, U.memberA);
    await makeDue(f.periodId); const configured = await enable(f.periodId), original = await job(required(configured.requestId));
    await db.sql`update memberships set state='revoked',revoked_at=now() where id=${M.teamMemberA}`;
    try {
      const blocked = await worker().freezeDuePeriod(original); expect(blocked).toMatchObject({ status: 'blocked', createdCount: 0, remainingCount: 2, blockedCode: 'authorizer_inactive' });
      expect(await calendarCount(f.periodId)).toBe(0); expect(await projectBaselineCount(f.periodId)).toBe(0);
      await createRecurrenceApplication(db).authorizeGeneration(context(), source.id, { expectedRevision: source.revision, expectedAuthorizationRevision: source.generation.authorizationRevision });
      const live = required(await repo().liveRequest(W.team, f.periodId)); expect(live.job.requestId).not.toBe(original.requestId);
      expect((await worker().freezeDuePeriod(live.job))).toMatchObject({ status: 'frozen', createdCount: 2 });
    } finally { await db.sql`update memberships set state='active',revoked_at=null where id=${M.teamMemberA}`; }

    const complete = await fixture(false), completedSource = await series(complete, 1, U.memberA);
    await createRecurrenceApplication(db).materializePeriod(context(), complete.periodId, { limit: 100 });
    await makeDue(complete.periodId); const completeGrant = await enable(complete.periodId);
    await db.sql`update memberships set state='revoked',revoked_at=now() where id=${M.teamMemberA}`;
    try { expect((await worker().freezeDuePeriod(await job(required(completeGrant.requestId))))).toMatchObject({ status: 'frozen', createdCount: 0 }); }
    finally { await db.sql`update memberships set state='active',revoked_at=null where id=${M.teamMemberA}`; }
    expect(completedSource.id).toBeTruthy();
  });

  it('rolls calendar creations and freeze artifacts back together after a late SQL failure, then retries the same request', async () => {
    const f = await fixture(false); await series(f, 3); await makeDue(f.periodId);
    const configured = await enable(f.periodId), original = await job(required(configured.requestId));
    await db.sql.unsafe(`create function cutoff_test_late_fault() returns trigger language plpgsql as $$ begin if NEW.type='plan.frozen' then raise exception 'Synthetic late cutoff fault'; end if; return NEW; end $$`);
    await db.sql.unsafe('create trigger cutoff_test_late_fault before insert on outbox_events for each row execute function cutoff_test_late_fault()');
    try { const before = await digest(); await expect(worker().freezeDuePeriod(original)).rejects.toMatchObject({ cause: { message: 'Synthetic late cutoff fault' } }); expect(await digest()).toEqual(before); expect(await calendarCount(f.periodId)).toBe(0); }
    finally { await db.sql.unsafe('drop trigger cutoff_test_late_fault on outbox_events'); await db.sql.unsafe('drop function cutoff_test_late_fault()'); }
    expect((await worker().freezeDuePeriod(original))).toMatchObject({ status: 'frozen', createdCount: 3 });
  });

  it('freezes cancelled header-only census without future generation authority', async () => {
    const f = await fixture(false);
    await db.sql`update planning_periods set local_start='2026-10-19',local_end_exclusive='2026-10-26' where id=${f.periodId}`;
    const recurrence = createRecurrenceApplication(db), source = await series(f, 1, U.memberA, false, '2026-10-19');
    const header = required((await recurrence.listInstances(context(), source.id, { periodId: f.periodId, limit: 100, includeCancelled: true })).items[0]);
    const input = { expectedSeriesRevision: source.revision, expectedInstanceRevision: header.revision, kind: 'skip' as const, reason: 'Synthetic cancellation' };
    const preview = await recurrence.previewException(context(U.memberA), source.id, header.occurrenceKey, input);
    await recurrence.setException(context(U.memberA), source.id, header.occurrenceKey, { ...input, previewHash: preview.previewHash });
    await makeDue(f.periodId); const configured = await enable(f.periodId);
    await db.sql`update memberships set state='revoked',revoked_at=now() where id=${M.teamMemberA}`;
    try {
      expect(await app().getReadiness(context(), f.periodId)).toMatchObject({ missingCount: 0, blockedCount: 0 });
      expect((await worker().freezeDuePeriod(await job(required(configured.requestId))))).toMatchObject({ status: 'frozen', createdCount: 0 });
      expect(await calendarCount(f.periodId)).toBe(0);
      expect(await db.sql`select id from recurrence_instances where series_id=${source.id} and calendar_state='cancelled' and meeting_id is null`).toHaveLength(1);
    } finally { await db.sql`update memberships set state='active',revoked_at=null where id=${M.teamMemberA}`; }
  });

  it('shows no false blockers for a manually frozen period without automation and races manual/job freeze once', async () => {
    const manual = await fixture(false), planning = createPlanningApplication(db);
    const preview = await planning.previewFreeze(context(), manual.periodId, { scope: 'project' });
    await planning.freezePlan(context(), manual.periodId, { scope: 'project', previewHash: preview.previewHash });
    expect(await app().getReadiness(context(), manual.periodId)).toMatchObject({ readiness: 'frozen', persistedState: 'frozen', automation: { state: 'not_configured' }, missingCount: 0, blockedCount: 0, blockers: [] });
    const f = await fixture(), configured = await enable(f.periodId), original = await job(required(configured.requestId));
    const currentPreview = await planning.previewFreeze(context(), f.periodId, { scope: 'project' });
    const [manualResult, jobResult] = await Promise.all([planning.freezePlan(context(), f.periodId, { scope: 'project', previewHash: currentPreview.previewHash }), worker().freezeDuePeriod(original)]);
    expect(jobResult.baselineId).toBe(manualResult.id); expect(['frozen','already_frozen']).toContain(jobResult.status); expect(await projectBaselineCount(f.periodId)).toBe(1);
  });

  it('rechecks current membership after waiting behind the workspace barrier, before old receipt replay', async () => {
    const f = await fixture(), configured = await enable(f.periodId), original = await job(required(configured.requestId));
    await worker().freezeDuePeriod(original);
    let release!: () => void, locked!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; }), acquired = new Promise<void>(resolve => { locked = resolve; });
    const holder = db.sql.begin(async tx => { await tx`select id from workspaces where id=${W.team} for update`; locked(); await gate; await tx`update memberships set role='member' where id=${M.teamOwner}`; });
    await acquired; const replay = worker().freezeDuePeriod(original);
    try {
      let observed = false;
      for (let i = 0; i < 100; i++) { const waiting = await db.sql`select pid from pg_stat_activity where datname=current_database() and wait_event_type='Lock' and query like '%workspaces%'`; if (waiting.length) { observed = true; break; } await new Promise(resolve => setTimeout(resolve, 10)); }
      expect(observed).toBe(true); release(); await holder;
      const before = await digest(); expect(await replay).toMatchObject({ status: 'blocked', blockedCode: 'cutoff_authorizer_capability_revoked' }); expect(await digest()).toEqual(before);
    } finally { release(); await holder; await db.sql`update memberships set role='owner' where id=${M.teamOwner}`; }
  });

  it('protects immutable grant, request payload and write-once receipt rows in PostgreSQL', async () => {
    const f = await fixture(), configured = await enable(f.periodId), requestId = required(configured.requestId);
    await expect(db.sql`update planning_cutoff_grant_versions set state='revoked' where grant_id=${configured.grant.id}`).rejects.toThrow('cutoff grant versions are immutable');
    await expect(db.sql`delete from planning_cutoff_grant_versions where grant_id=${configured.grant.id}`).rejects.toThrow('cutoff grant versions are immutable');
    await expect(db.sql`update planning_cutoff_requests set reason='changed' where id=${requestId}`).rejects.toThrow('cutoff request payload is immutable');
    await expect(db.sql`delete from planning_cutoff_requests where id=${requestId}`).rejects.toThrow('cutoff requests cannot be removed');
    await worker().freezeDuePeriod(await job(requestId));
    const before = await digest();
    await expect(db.sql`update planning_cutoff_requests set result=jsonb_set(result,'{status}','"already_frozen"') where id=${requestId}`).rejects.toThrow('cutoff receipt is immutable');
    expect(await digest()).toEqual(before);
  });

  it('performs bounded durable discovery with idempotent catch-up and no request duplication', async () => {
    const f = await fixture(), configured = await enable(f.periodId);
    const before = await repo().liveRequest(W.team, f.periodId);
    const discovery = createCutoffDiscovery(db), first = await discovery.discoverBatch(1);
    expect(first.leased).toBe(true); expect(first.selectedCount).toBeLessThanOrEqual(1);
    for (let pass = 0; pass < 30; pass++) { if ((await discovery.discoverBatch(2)).cycleComplete) break; }
    expect((await repo().liveRequest(W.team, f.periodId))?.job.requestId).toBe(before?.job.requestId);
    expect(configured.requestId).toBe(before?.job.requestId);
  });

  it('delivers the exact subscribed outbox transactionally and retains poison/unrelated rows', async () => {
    const f = await fixture(), configured = await enable(f.periodId), requestId = required(configured.requestId);
    await db.sql`insert into outbox_events(workspace_id,change_seq,event_ordinal,type,schema_version,aggregate_type,aggregate_id,payload,occurred_at) values(${W.team},999901,1,'planning.cutoff_requested',99,'planning_cutoff_request',${randomUUID()},'{}'::jsonb,now()),(${W.team},999902,1,'planning.cutoff_requested',1,'planning_cutoff_request',${randomUUID()},'[]'::jsonb,now()),(${W.team},999903,1,'external.unrelated',1,'test',${randomUUID()},'{}'::jsonb,now())`;
    const relay = createCutoffOutboxRelay(db), before = await digest();
    await expect(relay.relayBatch(async () => { throw new Error('Synthetic enqueue fault'); })).rejects.toThrow('Synthetic enqueue fault');
    expect(await digest()).toEqual(before);
    const received: string[] = [];
    const result = await relay.relayBatch(async (_tx, event) => { received.push(event.payload.requestId); return { accepted: true, jobId: event.eventId }; }, 100);
    expect(received).toContain(requestId); expect(result.unsupportedRetainedCount).toBe(2);
    expect((await relay.getHealth()).unsupportedSubscribedCount).toBe(2);
    const untouched = await db.sql`select type,dispatched_at from outbox_events where change_seq in (999901,999902,999903)`;
    expect(untouched.every(row => row.dispatched_at === null)).toBe(true);
  });

  it('serves independent HTTP readiness/configuration with strict input and current viewer denial', async () => {
    const f = await fixture(false), api = await createApp(loadConfig({ APP_ENV: 'local', AUTH_MODE: 'dev', DEV_ACTOR_ID: U.owner, DATABASE_URL: required(target).url }), { database: db, webDistDir: null, logger: false });
    const path = `/api/v1/workspaces/${W.team}/periods/${f.periodId}`, headers = { host: '127.0.0.1:4310', origin: 'http://127.0.0.1:4310', 'idempotency-key': randomUUID() };
    try {
      const read = await api.inject({ method: 'GET', url: `${path}/cutoff-readiness`, headers }); expect(read.statusCode).toBe(200); expect(read.json().data.automation.state).toBe('not_configured');
      const input = { expectedPeriodRevision: 1, expectedGrantRevision: 0, enabled: true };
      expect((await api.inject({ method: 'PUT', url: `${path}/cutoff-automation`, headers, payload: { ...input, actorUserId: U.owner } })).statusCode).toBe(400);
      expect((await api.inject({ method: 'PUT', url: `${path}/cutoff-automation`, headers, payload: input })).statusCode).toBe(200);
      expect((await api.inject({ method: 'POST', url: `${path}/cutoff-retry`, headers: { ...headers, 'idempotency-key': randomUUID() }, payload: { expectedPeriodRevision: 1, expectedGrantRevision: 1 } })).statusCode).toBe(200);
    } finally { await api.close(); }
  });
});
