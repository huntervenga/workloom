// Root runs this source only against its explicitly named throwaway PostgreSQL child.
// Never reads DATABASE_URL as a fallback, never uses the main runtime database.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { BulkUpdateTasksInput, CreateTaskInput, TaskDto } from '@workloom/contracts';
import type { CommandContext, TaskApplication } from '@workloom/domain';
import { createDatabase, createPlanningApplication, createTaskApplication, runMigrations, seedDemoData, FIXTURE_USER_IDS as U, FIXTURE_WORKSPACE_IDS as W, FIXTURE_MEMBERSHIP_IDS as M, type Database } from '@workloom/db';
import type { FastifyInstance } from 'fastify';
import { createApp } from '../../apps/api/src/app.js';
import { loadConfig } from '../../apps/api/src/config.js';
import { databaseSnapshot, changedTables, membershipRow, restoreMembership, revokeMembership } from './support/p1b.js';
import { requireTestDatabaseUrl } from './support/test-database-url.js';
import { createThrowawayDatabase, type ThrowawayDatabase } from './support/test-database.js';
requireTestDatabaseUrl();
const host = '127.0.0.1:4310';
const ctx = (key = randomUUID(), userId: string = U.owner): CommandContext => ({ workspaceId: W.team, actor: { userId, displayName: 'Synthetic assignment', kind: 'fixture' }, requestId: randomUUID(), source: 'web', idempotencyKey: key });
function required<T>(value: T | undefined | null): T { if (value === undefined || value === null) throw new Error('Missing isolated assignment fixture.'); return value; }
const ref = (task: TaskDto) => ({ taskId: task.id, expectedRevision: task.revision });
describe('atomic assignee ordering and bulk edits on isolated PostgreSQL', () => {
  let target: ThrowawayDatabase | undefined, db: Database, tasks: TaskApplication, api: FastifyInstance;
  beforeAll(async () => {
    target = await createThrowawayDatabase('assignee_bulk');
    db = createDatabase(target.url, { requireLoopback: true });
    const existing = await db.sql`select 1 from information_schema.tables where table_schema='public' limit 1`;
    if (existing.length) throw new Error('Refusing to migrate a nonempty assignment test child.');
    await runMigrations(target.url, { requireLoopback: true });
    await seedDemoData(db);
    tasks = createTaskApplication(db);
    api = await createApp(loadConfig({ APP_ENV: 'local', AUTH_MODE: 'dev', DEV_ACTOR_ID: U.owner, DATABASE_URL: target.url }), { database: db, taskApplication: tasks, webDistDir: null, logger: false });
  }, 60_000);
  afterAll(async () => { try { await api?.close(); } finally { try { await db?.close(); } finally { await target?.drop(); } } });
  async function fixture(name: string) {
    const project = await tasks.createProject(ctx(), { name });
    const statuses = await tasks.listStatuses(ctx(), project.id);
    const statusId = required(statuses.find(s => s.group === 'todo')).id;
    const create = (input: Partial<CreateTaskInput> = {}) => tasks.createTask(ctx(), { projectId: project.id, statusId, title: 'Assignment task', ...input });
    return { projectId: project.id, create };
  }
  async function order(projectId: string) {
    return (await db.sql<{ id: string }[]>`select id from tasks where project_id=${projectId} order by position,id`).map(r => r.id);
  }
  async function current(task: TaskDto) { return tasks.getTask(ctx(), task.id); }
  async function unchanged(code: string, run: () => Promise<unknown>) {
    const before = await databaseSnapshot(db.sql);
    await expect(run()).rejects.toMatchObject({ code });
    expect(await databaseSnapshot(db.sql)).toEqual(before);
  }
  const post = (path: string, body: object, key: string = randomUUID()) => api.inject({ method: 'POST', url: `/api/v1/workspaces/${W.team}${path}`, headers: { host, origin: `http://${host}`, 'idempotency-key': key }, payload: body });

  it('splices full-project order and current responsible atomically without changing section, package or participants', async () => {
    const f = await fixture('Assignee anchored');
    const section = await tasks.createSection(ctx(), f.projectId, { name: 'Source section' });
    const a = await f.create({ title: 'A', sectionId: section.id, responsibleMembershipId: M.teamMemberA, participantMembershipIds: [M.teamMemberA, M.teamMemberB], estimateMinutes: 90, dueDate: '2030-02-01' });
    const hidden = await f.create({ title: 'Filter hidden', responsibleMembershipId: M.teamOwner });
    const b = await f.create({ title: 'B', responsibleMembershipId: M.teamMemberB });
    const moved = await tasks.moveTask(ctx(), a.id, { expectedRevision: 1, anchorTaskId: b.id, placement: 'after', responsibleMembershipId: M.teamMemberB });
    expect(await order(f.projectId)).toEqual([hidden.id, b.id, a.id]);
    expect(moved).toMatchObject({ sectionId: section.id, responsibleMembershipId: M.teamMemberB, workPackageId: a.workPackageId, participants: a.participants, participantsRevision: 1, estimateMinutes: 90, dueDate: '2030-02-01', revision: 2 });
    const reader = createDatabase(required(target).url, { requireLoopback: true });
    try { expect((await reader.sql<{ responsible_membership_id: string; section_id: string }[]>`select responsible_membership_id,section_id from tasks where id=${a.id}`)[0]).toEqual({ responsible_membership_id: M.teamMemberB, section_id: section.id }); } finally { await reader.close(); }
  });

  it('resolves null anchors from the complete group, includes children and excludes archived and supports truly empty unassigned', async () => {
    const f = await fixture('Assignee full group');
    const source = await f.create({ responsibleMembershipId: M.teamMemberA });
    const first = await f.create({ responsibleMembershipId: M.teamMemberB });
    const middle = await f.create({ responsibleMembershipId: M.teamOwner });
    const last = await f.create({ responsibleMembershipId: M.teamMemberB });
    const child = await f.create({ parentTaskId: first.id, responsibleMembershipId: M.teamMemberB });
    const archivedDraft = await f.create({ responsibleMembershipId: M.teamMemberB });
    const archived = await tasks.archiveTask(ctx(), archivedDraft.id, { expectedRevision: 1 });
    const moved = await tasks.moveTask(ctx(), source.id, { expectedRevision: 1, anchorTaskId: null, placement: 'after', responsibleMembershipId: M.teamMemberB });
    expect(await order(f.projectId)).toEqual([first.id, middle.id, last.id, child.id, source.id, archived.id]);
    const peers = await Promise.all([first, middle, last, child].map(current));
    const cleared = await tasks.moveTask(ctx(), source.id, { expectedRevision: moved.revision, anchorTaskId: null, placement: 'after', responsibleMembershipId: null });
    expect(cleared.responsibleMembershipId).toBeNull();
    // No active unassigned row imposes an order: the source keeps its global slot and nothing else is renumbered.
    expect(cleared.position).toBe(moved.position);
    expect(await order(f.projectId)).toEqual([first.id, middle.id, last.id, child.id, source.id, archived.id]);
    expect(await Promise.all([first, middle, last, child].map(current))).toEqual(peers);
  });

  it('keeps same-parent child reorder bounded and rejects mismatched person/revision/foreign/archived anchors', async () => {
    const f = await fixture('Assignee rejection');
    const p = await f.create({ responsibleMembershipId: M.teamMemberA });
    const c1 = await f.create({ parentTaskId: p.id, responsibleMembershipId: M.teamMemberA });
    const c2 = await f.create({ parentTaskId: p.id, responsibleMembershipId: M.teamMemberA });
    await tasks.moveTask(ctx(), c2.id, { expectedRevision: 1, anchorTaskId: c1.id, placement: 'before' });
    expect((await current(c2)).parentTaskId).toBe(p.id);
    const c1now = await current(c1);
    await unchanged('DOMAIN_VALIDATION_FAILED', () => tasks.moveTask(ctx(), c1.id, { expectedRevision: c1now.revision, anchorTaskId: c2.id, placement: 'after', responsibleMembershipId: M.teamMemberB }));
    const root = await current(p);
    await unchanged('DOMAIN_VALIDATION_FAILED', () => tasks.moveTask(ctx(), p.id, { expectedRevision: root.revision, anchorTaskId: c1.id, placement: 'before' }));
    await unchanged('REVISION_CONFLICT', () => tasks.moveTask(ctx(), p.id, { expectedRevision: 999, anchorTaskId: null, placement: 'after', responsibleMembershipId: null }));
    const archived = await tasks.archiveTask(ctx(), root.id, { expectedRevision: root.revision });
    await unchanged('DOMAIN_VALIDATION_FAILED', () => tasks.moveTask(ctx(), c1.id, { expectedRevision: c1now.revision, anchorTaskId: archived.id, placement: 'after' }));
  });

  it('moves child-to-child across parents and root-to-child in flat assignee groups without reparenting', async () => {
    const f = await fixture('Flat child assignment');
    const p = await f.create({ responsibleMembershipId: M.teamMemberA }), q = await f.create({ responsibleMembershipId: M.teamMemberB });
    const child = await f.create({ parentTaskId: p.id, responsibleMembershipId: M.teamMemberA });
    const otherChild = await f.create({ parentTaskId: q.id, responsibleMembershipId: M.teamMemberB });
    const moved = await tasks.moveTask(ctx(), child.id, { expectedRevision: 1, anchorTaskId: otherChild.id, placement: 'after', responsibleMembershipId: M.teamMemberB });
    expect(moved).toMatchObject({ parentTaskId: p.id, sectionId: child.sectionId, workPackageId: child.workPackageId, responsibleMembershipId: M.teamMemberB });
    const root = await tasks.moveTask(ctx(), p.id, { expectedRevision: (await current(p)).revision, anchorTaskId: child.id, placement: 'after', responsibleMembershipId: M.teamMemberB });
    expect(root).toMatchObject({ parentTaskId: null, sectionId: p.sectionId, workPackageId: p.workPackageId, responsibleMembershipId: M.teamMemberB });
    expect((await current(otherChild)).parentTaskId).toBe(q.id);
  });

  it('preflights every bulk revision/date/target before any write, including a later invalid final range', async () => {
    const f = await fixture('Bulk preflight');
    const a = await f.create({ startDate: '2030-01-01' }), b = await f.create({ startDate: '2030-03-01' });
    const body: BulkUpdateTasksInput = { projectId: f.projectId, tasks: [ref(a), ref(b)], changes: { dueDate: '2030-02-01', responsibleMembershipId: M.teamMemberB } };
    await unchanged('DOMAIN_VALIDATION_FAILED', () => tasks.bulkUpdateTasks(ctx(), body));
    await unchanged('REVISION_CONFLICT', () => tasks.bulkUpdateTasks(ctx(), { ...body, tasks: [ref(a), { ...ref(b), expectedRevision: 999 }], changes: { dueDate: null } }));
    const foreign = await fixture('Bulk other project');
    const other = await foreign.create();
    await unchanged('DOMAIN_VALIDATION_FAILED', () => tasks.bulkUpdateTasks(ctx(), { ...body, tasks: [ref(a), ref(other)], changes: { dueDate: null } }));
    await unchanged('CAPABILITY_REQUIRED', () => tasks.bulkUpdateTasks(ctx(randomUUID(), U.viewer), { ...body, changes: { dueDate: null } }));
    const original = await membershipRow(db.sql, W.team, M.teamMemberB);
    try { await revokeMembership(db.sql, W.team, M.teamMemberB); await unchanged('NOT_FOUND', () => tasks.bulkUpdateTasks(ctx(), { ...body, changes: { responsibleMembershipId: M.teamMemberB } })); }
    finally { await restoreMembership(db.sql, W.team, M.teamMemberB, original); }
  });

  it('commits one exact bulk body/receipt after a lost HTTP answer, rejects changed-body retry and revoked actor replay', async () => {
    const f = await fixture('Bulk unknown retry');
    const a = await f.create(), b = await f.create(), untouched = await f.create({ title: 'Unselected' });
    const body: BulkUpdateTasksInput = { projectId: f.projectId, tasks: [ref(a), ref(b)], changes: { responsibleMembershipId: M.teamMemberB, startDate: '2030-01-01', dueDate: '2030-01-31' } };
    const key = randomUUID();
    // Server committed; pretend the first body was lost to the browser. Retry the EXACT payload/key.
    const first = await post('/tasks/bulk-update', body, key);
    expect(first.statusCode).toBe(200);
    const snapshot = await databaseSnapshot(db.sql);
    const retried = await post('/tasks/bulk-update', structuredClone(body), key);
    expect(retried.statusCode).toBe(200);
    // Request metadata belongs to this HTTP request; the stored command DATA must replay exactly.
    expect(JSON.stringify((retried.json() as { data: TaskDto[] }).data)).toBe(JSON.stringify((first.json() as { data: TaskDto[] }).data));
    expect(await databaseSnapshot(db.sql)).toEqual(snapshot);
    expect(await current(untouched)).toEqual(untouched);
    const selected = (first.json() as { data: TaskDto[] }).data;
    expect(selected.map(t => t.id)).toEqual([a.id, b.id]);
    expect(selected.every(t => t.responsibleMembershipId === M.teamMemberB && t.revision === 2)).toBe(true);
    expect((await post('/tasks/bulk-update', { ...body, changes: { dueDate: null } }, key)).statusCode).toBe(409);
    const original = await membershipRow(db.sql, W.team, M.teamOwner);
    try { await revokeMembership(db.sql, W.team, M.teamOwner); const before = await databaseSnapshot(db.sql); expect((await post('/tasks/bulk-update', body, key)).statusCode).toBe(404); expect(await databaseSnapshot(db.sql)).toEqual(before); }
    finally { await restoreMembership(db.sql, W.team, M.teamOwner, original); }
    expect((await db.sql<{ count: number }[]>`select count(*)::int as count from command_idempotency where idempotency_key=${key}`)[0]?.count).toBe(1);
  });

  it('reauthorizes existence of every selected target before a cached bulk response', async () => {
    const f = await fixture('Bulk current target replay');
    const a = await f.create(), b = await f.create();
    const body: BulkUpdateTasksInput = { projectId: f.projectId, tasks: [ref(a), ref(b)], changes: { dueDate: null } }, key = randomUUID();
    await tasks.bulkUpdateTasks(ctx(key), body);
    await db.sql`delete from tasks where id=${b.id}`;
    await unchanged('NOT_FOUND', () => tasks.bulkUpdateTasks(ctx(key), body));
  });

  it('rolls back earlier bulk writes and assignment/renumbering after a late PostgreSQL trigger error', async () => {
    const f = await fixture('Atomic assignment rollback');
    const a = await f.create({ responsibleMembershipId: M.teamMemberA }), b = await f.create({ responsibleMembershipId: M.teamMemberB }), c = await f.create({ responsibleMembershipId: M.teamMemberA });
    if (!/^[0-9a-f-]{36}$/.test(b.id)) throw new Error('Unexpected synthetic UUID.');
    await db.sql.unsafe(`create function assignee_bulk_test_fail() returns trigger language plpgsql as $$ begin if new.id = '${b.id}'::uuid then raise exception 'synthetic late assignment failure'; end if; return new; end $$`);
    try {
      await db.sql.unsafe('create trigger assignee_bulk_test_fail before update on tasks for each row execute function assignee_bulk_test_fail()');
      const before = await databaseSnapshot(db.sql);
      await expect(tasks.bulkUpdateTasks(ctx(), { projectId: f.projectId, tasks: [ref(a), ref(b)], changes: { dueDate: '2030-02-01' } })).rejects.toThrow();
      expect(await databaseSnapshot(db.sql)).toEqual(before);
      await expect(tasks.moveTask(ctx(), c.id, { expectedRevision: 1, anchorTaskId: b.id, placement: 'before', responsibleMembershipId: M.teamMemberB })).rejects.toThrow();
      expect(await databaseSnapshot(db.sql)).toEqual(before);
    } finally { await db.sql.unsafe('drop trigger if exists assignee_bulk_test_fail on tasks'); await db.sql.unsafe('drop function if exists assignee_bulk_test_fail()'); }
    expect((await current(c)).responsibleMembershipId).toBe(M.teamMemberA);
  });

  it('preserves pinned baselines, participant histories, whole packages and recorded facts across current reassignment/date patch', async () => {
    const f = await fixture('Assignment historical attribution');
    const a = await f.create({ responsibleMembershipId: M.teamMemberA, participantMembershipIds: [M.teamMemberA, M.teamMemberB], estimateMinutes: 90 });
    const b = await f.create({ responsibleMembershipId: M.teamMemberB });
    const planning = createPlanningApplication(db);
    const period = await planning.createPeriod(ctx(), { projectId: f.projectId, name: 'Attribution', localStart: '2030-01-07', timezone: 'UTC', cutoffAt: '2030-01-06T12:00:00.000Z', protectedFieldIds: [], protectEstimate: true });
    await planning.createCommitment(ctx(), period.id, { workPackageId: a.workPackageId, membershipId: M.teamMemberA, expectedAbsent: true, plannedMinutes: 90, allocations: [{ taskId: a.id, minutes: 90 }] });
    const preview = await planning.previewFreeze(ctx(), period.id, { scope: 'project' });
    const baseline = await planning.freezePlan(ctx(), period.id, { scope: 'project', previewHash: preview.previewHash });
    await planning.setManualPeriodWork(ctx(), a.id, period.id, M.teamMemberA, { expectedRevision: null, minutes: 75, state: 'active', reason: null });
    const before = await databaseSnapshot(db.sql);
    const moved = await tasks.moveTask(ctx(), a.id, { expectedRevision: 1, anchorTaskId: b.id, placement: 'before', responsibleMembershipId: M.teamMemberB });
    await tasks.bulkUpdateTasks(ctx(), { projectId: f.projectId, tasks: [ref(moved)], changes: { startDate: '2030-01-08', dueDate: '2030-01-10' } });
    expect(await planning.getBaseline(ctx(), baseline.id)).toEqual(baseline);
    expect(changedTables(before, await databaseSnapshot(db.sql)).sort()).toEqual(['audit_events', 'command_idempotency', 'outbox_events', 'tasks', 'workspaces']);
    const facts = await db.sql<{ membership_id: string; minutes: number }[]>`select w.membership_id,r.minutes from work_logs w join work_log_revisions r on r.workspace_id=w.workspace_id and r.id=w.revision_id where w.task_id=${a.id}`;
    expect(facts).toContainEqual({ membership_id: M.teamMemberA, minutes: 75 });
  });
  it('freezes old sources before valid bulk changes and rolls the freeze back with late proposal failure', async () => {
    const f = await fixture('Bulk cutoff transaction');
    const a = await f.create({ responsibleMembershipId: M.teamMemberA, estimateMinutes: 90 }), b = await f.create({ responsibleMembershipId: M.teamMemberA });
    const planning = createPlanningApplication(db);
    const period = await planning.createPeriod(ctx(), { projectId: f.projectId, name: 'Cutoff', localStart: '2030-01-07', timezone: 'UTC', cutoffAt: '2030-01-06T12:00:00.000Z', protectedFieldIds: [], protectEstimate: true });
    await planning.createCommitment(ctx(), period.id, { workPackageId: a.workPackageId, membershipId: M.teamMemberA, expectedAbsent: true, plannedMinutes: 90, allocations: [{ taskId: a.id, minutes: 90 }] });
    await db.sql`update planning_periods set cutoff_at='2020-01-01T00:00:00Z'::timestamptz where id=${period.id}`;
    if (!/^[0-9a-f-]{36}$/.test(b.id)) throw new Error('Unexpected synthetic UUID.');
    await db.sql.unsafe(`create function bulk_cutoff_test_fail() returns trigger language plpgsql as $$ begin if new.id = '${b.id}'::uuid then raise exception 'synthetic post-freeze failure'; end if; return new; end $$`);
    const body: BulkUpdateTasksInput = { projectId: f.projectId, tasks: [ref(a), ref(b)], changes: { responsibleMembershipId: M.teamMemberB, dueDate: '2030-01-31' } };
    try {
      await db.sql.unsafe('create trigger bulk_cutoff_test_fail before update on tasks for each row execute function bulk_cutoff_test_fail()');
      const before = await databaseSnapshot(db.sql);
      await expect(tasks.bulkUpdateTasks(ctx(), body)).rejects.toThrow();
      expect(await databaseSnapshot(db.sql)).toEqual(before);
    } finally { await db.sql.unsafe('drop trigger if exists bulk_cutoff_test_fail on tasks'); await db.sql.unsafe('drop function if exists bulk_cutoff_test_fail()'); }
    const updated = await tasks.bulkUpdateTasks(ctx(), body);
    expect(updated.every(t => t.responsibleMembershipId === M.teamMemberB)).toBe(true);
    const frozen = await planning.getPeriod(ctx(), period.id);
    expect(frozen.state).toBe('frozen');
    const baseline = await planning.getBaseline(ctx(), required(frozen.projectBaselineId));
    expect(baseline.snapshot.tasks).toContainEqual(expect.objectContaining({ id: a.id, responsibleMembershipId: M.teamMemberA }));
    expect(baseline.snapshot.commitments).toContainEqual(expect.objectContaining({ membershipId: M.teamMemberA, plannedMinutes: 90 }));
  });

  /** Exact numeric positions by task ID, ties and gaps included. */
  async function positions(projectId: string) {
    const rows = await db.sql<{ id: string; position: number }[]>`select id,position from tasks where project_id=${projectId} order by position,id`;
    return Object.fromEntries([...rows].map(r => [r.id, r.position]));
  }
  /** A null-anchor drop that must keep the global order: only the source assignee/revision may change, with one audit/outbox event. */
  async function drop(projectId: string, source: TaskDto, responsibleMembershipId: string | null, others: readonly TaskDto[]) {
    const key = randomUUID();
    const counts = async () => required((await db.sql<{ audit: number; outbox: number; receipts: number }[]>`select (select count(*)::int from audit_events) as audit, (select count(*)::int from outbox_events) as outbox, (select count(*)::int from command_idempotency where idempotency_key=${key}) as receipts`)[0]);
    const original = await current(source), peers = await Promise.all(others.map(current)), sequence = await order(projectId), numeric = await positions(projectId);
    const before = await databaseSnapshot(db.sql), beforeCounts = await counts();
    const input = { expectedRevision: original.revision, anchorTaskId: null, placement: 'after' as const, responsibleMembershipId };
    const moved = await tasks.moveTask(ctx(key), source.id, input);
    const after = await databaseSnapshot(db.sql);
    const reassigned = responsibleMembershipId !== original.responsibleMembershipId, writes = reassigned ? 1 : 0;
    expect(moved).toEqual(reassigned ? { ...original, responsibleMembershipId, revision: original.revision + 1, updatedAt: moved.updatedAt } : original);
    expect(await current(source)).toEqual(moved);
    expect(await order(projectId)).toEqual(sequence);
    expect(await positions(projectId)).toEqual(numeric);
    expect(await Promise.all(others.map(current))).toEqual(peers);
    expect(await counts()).toEqual({ audit: beforeCounts.audit + writes, outbox: beforeCounts.outbox + writes, receipts: 1 });
    // Unfiltered: a no-op stores only its receipt and advances no workspace change sequence.
    expect(changedTables(before, after).sort()).toEqual(reassigned ? ['audit_events', 'command_idempotency', 'outbox_events', 'tasks', 'workspaces'] : ['command_idempotency']);
    expect(JSON.stringify(await tasks.moveTask(ctx(key), source.id, input))).toBe(JSON.stringify(moved));
    expect(await databaseSnapshot(db.sql)).toEqual(after);
    return moved;
  }

  it('group-end semantic: null-anchor drops keep durable global slots, peer revisions, audit and one replayable receipt', async () => {
    // Same person, already the last active member, with other-person rows interleaved and after it.
    const same = await fixture('Group-end same person');
    const a = await same.create({ responsibleMembershipId: M.teamMemberA });
    const aChild = await same.create({ parentTaskId: a.id, responsibleMembershipId: M.teamMemberA });
    const x = await same.create({ responsibleMembershipId: M.teamMemberB });
    const source = await same.create({ responsibleMembershipId: M.teamMemberA, participantMembershipIds: [M.teamMemberA], estimateMinutes: 45 });
    const y = await same.create();
    await drop(same.projectId, source, M.teamMemberA, [a, aChild, x, y]);
    expect(await order(same.projectId)).toEqual([a.id, aChild.id, x.id, source.id, y.id]);
    // The only active task of its person, with unrelated rows after it.
    const only = await fixture('Group-end only member');
    const p = await only.create({ responsibleMembershipId: M.teamMemberB });
    const lone = await only.create({ responsibleMembershipId: M.teamMemberA });
    const pChild = await only.create({ parentTaskId: p.id, responsibleMembershipId: M.teamMemberB });
    const u = await only.create();
    await drop(only.projectId, lone, M.teamMemberA, [p, pChild, u]);
    expect(await order(only.projectId)).toEqual([p.id, lone.id, pChild.id, u.id]);
    // Reassignment that already follows the last active target member, children included.
    const later = await fixture('Group-end reassignment after target');
    const t = await later.create({ responsibleMembershipId: M.teamMemberB });
    const tChild = await later.create({ parentTaskId: t.id, responsibleMembershipId: M.teamMemberB });
    const before = await later.create({ responsibleMembershipId: M.teamMemberA });
    const mover = await later.create({ responsibleMembershipId: M.teamMemberA });
    const trailing = await later.create();
    await drop(later.projectId, mover, M.teamMemberB, [t, tChild, before, trailing]);
    expect(await order(later.projectId)).toEqual([t.id, tChild.id, before.id, mover.id, trailing.id]);
    // Genuinely empty destinations: an archived target row and an empty unassigned group impose no order.
    const empty = await fixture('Group-end empty destination');
    const archived = await tasks.archiveTask(ctx(), (await empty.create({ responsibleMembershipId: M.teamMemberB })).id, { expectedRevision: 1 });
    const solo = await empty.create({ responsibleMembershipId: M.teamMemberA });
    const tail = await empty.create({ responsibleMembershipId: M.teamMemberA });
    const moved = await drop(empty.projectId, solo, M.teamMemberB, [tail]);
    await drop(empty.projectId, moved, null, [tail]);
    expect(await order(empty.projectId)).toEqual([archived.id, solo.id, tail.id]);
  });

  it('group-end semantic: legacy ties and gaps keep exact numeric positions on assignment-only drops; real reorders still renumber', async () => {
    const f = await fixture('Group-end legacy ties');
    const t = await f.create({ responsibleMembershipId: M.teamMemberB });
    const tChild = await f.create({ parentTaskId: t.id, responsibleMembershipId: M.teamMemberB });
    const x = await f.create({ responsibleMembershipId: M.teamMemberA });
    const source = await f.create({ responsibleMembershipId: M.teamMemberA, participantMembershipIds: [M.teamMemberA], estimateMinutes: 45 });
    const archived = await tasks.archiveTask(ctx(), (await f.create({ responsibleMembershipId: M.teamMemberB })).id, { expectedRevision: 1 });
    const y = await f.create();
    // Legacy state, written only in this owned child: ties at 4 and 7, gaps before 7 and 20.
    // Random-ID tie order never decides the drop: every active target row sits at 4, the source at 7.
    const legacy = { [t.id]: 4, [tChild.id]: 4, [x.id]: 7, [source.id]: 7, [archived.id]: 7, [y.id]: 20 };
    for (const [id, position] of Object.entries(legacy)) await db.sql`update tasks set position=${position} where id=${id}`;
    expect(await positions(f.projectId)).toEqual(legacy);
    const peers = [t, tChild, x, archived, y];
    const moved = await drop(f.projectId, source, M.teamMemberB, peers);
    expect(moved).toMatchObject({ position: 7, parentTaskId: null, sectionId: source.sectionId, workPackageId: source.workPackageId, participants: source.participants, estimateMinutes: 45 });
    await drop(f.projectId, moved, M.teamMemberB, peers);
    expect(await positions(f.projectId)).toEqual(legacy);
    // A real reorder behind the last active unassigned row still normalizes the whole project.
    const sequence = await order(f.projectId);
    const cleared = await tasks.moveTask(ctx(), source.id, { expectedRevision: moved.revision, anchorTaskId: null, placement: 'after', responsibleMembershipId: null });
    const expected = [...sequence.filter(id => id !== source.id), source.id];
    expect(await order(f.projectId)).toEqual(expected);
    expect(await positions(f.projectId)).toEqual(Object.fromEntries(expected.map((id, rank) => [id, rank])));
    expect(cleared).toMatchObject({ responsibleMembershipId: null, position: 5, revision: moved.revision + 1 });
  });

});
