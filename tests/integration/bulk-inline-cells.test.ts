// Runs only in an owned disposable child. No DATABASE_URL fallback or main database access.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { BulkUpdateTasksInput, CreateTaskInput, TaskDto, TaskFieldData, TaskFieldDefinitionDto } from '@workloom/contracts';
import type { CommandContext, TaskApplication, TaskFieldApplication } from '@workloom/domain';
import { createDatabase, createDependencyApplication, createPlanningApplication, createTaskApplication, createTaskFieldApplication, runMigrations, seedDemoData, FIXTURE_USER_IDS as U, FIXTURE_WORKSPACE_IDS as W, FIXTURE_MEMBERSHIP_IDS as M, type Database } from '@workloom/db';
import { changedTables, databaseSnapshot, membershipRow, restoreMembership, revokeMembership } from './support/p1b.js';
import { requireTestDatabaseUrl } from './support/test-database-url.js';
import { createThrowawayDatabase, type ThrowawayDatabase } from './support/test-database.js';
requireTestDatabaseUrl();
const ctx = (key = randomUUID()): CommandContext => ({ workspaceId: W.team, actor: { userId: U.owner, displayName: 'Synthetic bulk cells', kind: 'fixture' }, requestId: randomUUID(), source: 'web', idempotencyKey: key });
function required<T>(value: T | undefined | null): T { if (value === undefined || value === null) throw new Error('Missing disposable bulk fixture.'); return value; }
const ref = (task: TaskDto) => ({ taskId: task.id, expectedRevision: task.revision });
describe('selected-cell atomic commands on isolated PostgreSQL', () => {
  let target: ThrowawayDatabase | undefined, db: Database, tasks: TaskApplication, fields: TaskFieldApplication;
  beforeAll(async () => {
    target = await createThrowawayDatabase('bulk_inline');
    db = createDatabase(target.url, { requireLoopback: true });
    const existing = await db.sql`select 1 from information_schema.tables where table_schema='public' limit 1`;
    if (existing.length) throw new Error('Refusing to migrate a nonempty child.');
    await runMigrations(target.url, { requireLoopback: true }); await seedDemoData(db);
    tasks = createTaskApplication(db); fields = createTaskFieldApplication(db);
  }, 60_000);
  afterAll(async () => { try { await db?.close(); } finally { await target?.drop(); } });
  async function fixture(name: string) {
    const project = await tasks.createProject(ctx(), { name });
    const statuses = await tasks.listStatuses(ctx(), project.id), todo = required(statuses.find(row => row.group === 'todo')), done = required(statuses.find(row => row.group === 'done'));
    const create = (input: Partial<CreateTaskInput> = {}) => tasks.createTask(ctx(), { projectId: project.id, statusId: todo.id, title: 'Bulk task', ...input });
    return { project, todo, done, create };
  }
  async function unchanged(code: string, run: () => Promise<unknown>) {
    const before = await databaseSnapshot(db.sql); await expect(run()).rejects.toMatchObject({ code }); expect(await databaseSnapshot(db.sql)).toEqual(before);
  }
  const field = (projectId: string, type: TaskFieldDefinitionDto['type']) => fields.createField(ctx(), { projectId, name: type, type, historyEnabled: true, locked: false, options: ['single_select', 'multi_select'].includes(type) ? [{ name: 'Option', color: null }] : [] });
  it('preflights an actual enforced dependency on the later selected row and leaves every table unchanged', async () => {
    const f = await fixture('Bulk status policy'), a = await f.create(), b = await f.create(), blocker = await f.create();
    const deps = createDependencyApplication(db);
    await deps.createDependency(ctx(), { predecessorTaskId: blocker.id, successorTaskId: b.id, type: 'finish_to_start', expectedAbsent: true });
    await deps.updateProjectPolicy(ctx(), f.project.id, { expectedRevision: 0, mode: 'enforce' });
    await unchanged('DOMAIN_VALIDATION_FAILED', () => tasks.bulkUpdateTasks(ctx(), { projectId: f.project.id, tasks: [ref(a), ref(b)], changes: { statusId: f.done.id, priority: 'high' } }));
    expect((await tasks.getTask(ctx(), a.id)).statusId).toBe(f.todo.id);
  });
  it('sets one chosen value for all nine custom types including absent, zero, false, empty text and empty lists', async () => {
    const f = await fixture('Bulk all field types'), a = await f.create(), b = await f.create(), untouched = await f.create();
    for (const type of ['text', 'number', 'duration', 'date', 'single_select', 'multi_select', 'person', 'boolean', 'url'] as const) {
      const def = await field(f.project.id, type);
      const value: TaskFieldData = type === 'text' ? { type, value: '' } : type === 'number' || type === 'duration' ? { type, value: 0 } : type === 'date' ? { type, value: '2030-02-01' } : type === 'single_select' ? { type, value: required(def.options[0]).id } : type === 'multi_select' || type === 'person' ? { type, value: [] } : type === 'boolean' ? { type, value: false } : { type, value: 'https://example.com/record' };
      const body: BulkUpdateTasksInput = { projectId: f.project.id, tasks: [a, b].map(row => ({ ...ref(row), expectedFieldValueRevision: 0 })), changes: { customField: { fieldId: def.id, expectedDefinitionRevision: def.revision, value } } };
      const result = await tasks.bulkUpdateTasks(ctx(), body);
      expect(result.map(row => row.revision)).toEqual([a.revision, b.revision]);
      for (const row of [a, b]) expect((await fields.listTaskValues(ctx(), row.id)).find(item => item.fieldId === def.id)?.value).toEqual(value);
      expect((await fields.listTaskValues(ctx(), untouched.id)).find(item => item.fieldId === def.id)).toBeUndefined();
    }
  });
  it('rejects a later stale value, definition and unavailable reference without any earlier proposal', async () => {
    const f = await fixture('Bulk field preflight'), a = await f.create(), b = await f.create();
    const def = await field(f.project.id, 'number');
    await fields.setTaskValue(ctx(), b.id, def.id, { expectedRevision: 0, expectedDefinitionRevision: def.revision, value: { type: 'number', value: 3 } });
    const body: BulkUpdateTasksInput = { projectId: f.project.id, tasks: [a, b].map(row => ({ ...ref(row), expectedFieldValueRevision: 0 })), changes: { priority: 'urgent', customField: { fieldId: def.id, expectedDefinitionRevision: def.revision, value: { type: 'number', value: 0 } } } };
    await unchanged('REVISION_CONFLICT', () => tasks.bulkUpdateTasks(ctx(), body));
    required(body.tasks[1]).expectedFieldValueRevision = 1; required(body.changes.customField).expectedDefinitionRevision++;
    await unchanged('REVISION_CONFLICT', () => tasks.bulkUpdateTasks(ctx(), body));
    const people = await field(f.project.id, 'person');
    await unchanged('NOT_FOUND', () => tasks.bulkUpdateTasks(ctx(), { projectId: f.project.id, tasks: [a, b].map(row => ({ ...ref(row), expectedFieldValueRevision: 0 })), changes: { customField: { fieldId: people.id, expectedDefinitionRevision: people.revision, value: { type: 'person', value: [randomUUID()] } } } }));
  });
  it('updates a shared package once with fresh projections for all selected tasks, preserving its original baseline', async () => {
    const f = await fixture('Bulk shared estimate'), parent = await f.create({ estimateMinutes: 180 }), child = await f.create({ parentTaskId: parent.id }), unselected = await f.create({ parentTaskId: parent.id });
    const planning = createPlanningApplication(db);
    const period = await planning.createPeriod(ctx(), { projectId: f.project.id, name: 'Original budget', localStart: '2030-01-07', timezone: 'UTC', cutoffAt: '2030-01-06T12:00:00.000Z', protectedFieldIds: [], protectEstimate: false });
    await planning.createCommitment(ctx(), period.id, { workPackageId: parent.workPackageId, membershipId: M.teamOwner, expectedAbsent: true, plannedMinutes: 120, allocations: [{ taskId: parent.id, minutes: 120 }] });
    const preview = await planning.previewFreeze(ctx(), period.id, { scope: 'project' });
    await planning.freezePlan(ctx(), period.id, { scope: 'project', previewHash: preview.previewHash });
    const before = await databaseSnapshot(db.sql), baseline = before;
    const body: BulkUpdateTasksInput = { projectId: f.project.id, tasks: [parent, child].map(row => ({ ...ref(row), expectedWorkPackageRevision: row.workPackageRevision })), changes: { estimateMinutes: 240 } };
    const key = randomUUID(), result = await tasks.bulkUpdateTasks(ctx(key), body);
    expect(result.every(row => row.estimateMinutes === 240 && row.workPackageRevision === parent.workPackageRevision + 1)).toBe(true);
    expect(result.map(row => row.revision)).toEqual([parent.revision, child.revision]);
    expect(await tasks.getTask(ctx(), unselected.id)).toMatchObject({ revision: unselected.revision, estimateMinutes: 240, workPackageRevision: parent.workPackageRevision + 1 });
    const after = await databaseSnapshot(db.sql);
    expect(changedTables(baseline, after).filter(name => name.includes('baseline') || name.includes('commitment') || name.includes('work_log'))).toEqual([]);
    const audits = await db.sql<{ diff: { workPackage?: unknown } }[]>`select diff from audit_events where entity_id in (${parent.id},${child.id}) and action='updated'`;
    expect(audits.filter(row => row.diff.workPackage !== undefined)).toHaveLength(1);
    const stable = await databaseSnapshot(db.sql); expect(await tasks.bulkUpdateTasks(ctx(key), structuredClone(body))).toEqual(result); expect(await databaseSnapshot(db.sql)).toEqual(stable);
    const membership = await membershipRow(db.sql, W.team, M.teamOwner);
    try { await revokeMembership(db.sql, W.team, M.teamOwner); await unchanged('NOT_FOUND', () => tasks.bulkUpdateTasks(ctx(key), body)); }
    finally { await restoreMembership(db.sql, W.team, M.teamOwner, membership); }
  });
  it('commits only a classified locked-field rejection and rolls every table back after a late value failure', async () => {
    const f = await fixture('Bulk locked atomic'), a = await f.create(), b = await f.create(), def = await field(f.project.id, 'text');
    await fields.updateField(ctx(), def.id, { expectedRevision: def.revision, locked: true });
    const locked = required((await fields.listFields(ctx(), f.project.id)).find(row => row.id === def.id));
    const body: BulkUpdateTasksInput = { projectId: f.project.id, tasks: [a, b].map(row => ({ ...ref(row), expectedFieldValueRevision: 0 })), changes: { priority: 'high', customField: { fieldId: def.id, expectedDefinitionRevision: locked.revision, value: { type: 'text', value: 'Never partial' } } } };
    const before = await databaseSnapshot(db.sql), key = randomUUID(); await expect(tasks.bulkUpdateTasks(ctx(key), body)).rejects.toMatchObject({ code: 'FIELD_LOCKED', details: { committed: true } });
    expect(changedTables(before, await databaseSnapshot(db.sql))).toEqual(['command_idempotency']);
    await unchanged('FIELD_LOCKED', () => tasks.bulkUpdateTasks(ctx(key), body));
    await fields.updateField(ctx(), def.id, { expectedRevision: locked.revision, locked: false });
    const unlocked = required((await fields.listFields(ctx(), f.project.id)).find(row => row.id === def.id));
    required(body.changes.customField).expectedDefinitionRevision = unlocked.revision;
    if (!/^[0-9a-f-]{36}$/.test(b.id)) throw new Error('Unexpected synthetic UUID.');
    await db.sql.unsafe(`create function bulk_inline_fault() returns trigger language plpgsql as $$ begin if new.task_id = '${b.id}'::uuid then raise exception 'bulk_inline_fault'; end if; return new; end $$`);
    try {
      await db.sql.unsafe('create trigger bulk_inline_fault before insert on task_field_values for each row execute function bulk_inline_fault()');
      const snapshot = await databaseSnapshot(db.sql); await expect(tasks.bulkUpdateTasks(ctx(), body)).rejects.toThrow(); expect(await databaseSnapshot(db.sql)).toEqual(snapshot);
    } finally { await db.sql.unsafe('drop trigger if exists bulk_inline_fault on task_field_values'); await db.sql.unsafe('drop function if exists bulk_inline_fault()'); }
  });
});
