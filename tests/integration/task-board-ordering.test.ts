// Source-only author gate: root executes on TEST_DATABASE_URL's fresh owned synthetic child.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { taskResponseSchema, type CreateTaskInput, type TaskDto } from '@workloom/contracts';
import type { CommandContext, TaskApplication } from '@workloom/domain';
import { createDatabase, createDependencyApplication, createTaskApplication, runMigrations, seedDemoData, FIXTURE_USER_IDS as U, FIXTURE_WORKSPACE_IDS as W, FIXTURE_MEMBERSHIP_IDS as M, type Database } from '@workloom/db';
import { createApp } from '../../apps/api/src/app.js';
import { loadConfig } from '../../apps/api/src/config.js';
import { databaseSnapshot } from './support/p1b.js';
import { requireTestDatabaseUrl } from './support/test-database-url.js';
import { createThrowawayDatabase, type ThrowawayDatabase } from './support/test-database.js';
requireTestDatabaseUrl();
const host = '127.0.0.1:4310';
const ctx = (key = randomUUID(), userId: string = U.owner): CommandContext => ({ workspaceId: W.team, actor: { userId, displayName: 'Synthetic Board order', kind: 'fixture' }, requestId: randomUUID(), source: 'web', idempotencyKey: key });
function required<T>(value: T | null | undefined): T { if (value === null || value === undefined) throw new Error('Missing Board fixture.'); return value; }
const semantic = (task: TaskDto) => ({ ...task, statusId: '', position: 0, revision: 0, updatedAt: '' });
describe('atomic Board status and persistent lane order on owned PostgreSQL', () => {
  let target: ThrowawayDatabase | undefined, db: Database, tasks: TaskApplication, api: FastifyInstance;
  beforeAll(async () => {
    target = await createThrowawayDatabase('board_order'); db = createDatabase(target.url, { requireLoopback: true });
    if ((await db.sql`select 1 from information_schema.tables where table_schema='public' limit 1`).length) throw new Error('Board child must be empty.');
    await runMigrations(target.url, { requireLoopback: true }); await seedDemoData(db); tasks = createTaskApplication(db);
    api = await createApp(loadConfig({ APP_ENV: 'local', AUTH_MODE: 'dev', DEV_ACTOR_ID: U.owner, DATABASE_URL: target.url }), { database: db, taskApplication: tasks, webDistDir: null, logger: false });
  }, 60_000);
  afterAll(async () => { try { await api?.close(); } finally { try { await db?.close(); } finally { await target?.drop(); } } });
  async function fixture(name: string) {
    const project = await tasks.createProject(ctx(), { name }), statuses = await tasks.listStatuses(ctx(), project.id);
    const todo = required(statuses.find(s => s.group === 'todo')).id, done = required(statuses.find(s => s.group === 'done')).id;
    const create = (input: Partial<CreateTaskInput> = {}) => tasks.createTask(ctx(), { projectId: project.id, statusId: todo, title: 'Board task', ...input });
    return { project, todo, done, create };
  }
  async function order(projectId: string, reader = db) { return (await reader.sql<{ id: string }[]>`select id from tasks where project_id=${projectId} order by position,id`).map(row => row.id); }
  const current = (task: TaskDto) => tasks.getTask(ctx(), task.id);
  const post = (taskId: string, body: object, key = randomUUID()) => api.inject({ method: 'POST', url: `/api/v1/workspaces/${W.team}/tasks/${taskId}/move`, headers: { host, origin: `http://${host}`, 'idempotency-key': key }, payload: body });
  async function rejected(code: string, run: () => Promise<unknown>) { const before = await databaseSnapshot(db.sql); await expect(run()).rejects.toMatchObject({ code }); expect(await databaseSnapshot(db.sql)).toEqual(before); }

  it('persists exact same-lane and cross-lane placements through HTTP and a fresh DB connection', async () => {
    const f = await fixture('Board persisted'), section = await tasks.createSection(ctx(), f.project.id, { name: 'Original section' });
    const a = await f.create({ title: 'A', sectionId: section.id, responsibleMembershipId: M.teamMemberA, participantMembershipIds: [M.teamMemberA], estimateMinutes: 120, dueDate: '2030-01-02' });
    const hidden = await f.create({ title: 'Other status' }), b = await f.create({ title: 'B', statusId: f.done }), c = await f.create({ title: 'C', statusId: f.done, parentTaskId: b.id });
    const response = await post(a.id, { expectedRevision: a.revision, statusId: f.done, anchorTaskId: c.id, placement: 'before' });
    expect(response.statusCode).toBe(200); const moved = taskResponseSchema.parse(response.json()).data;
    expect(moved.statusId).toBe(f.done); expect(semantic(moved)).toEqual(semantic(a)); expect(moved.revision).toBe(a.revision + 1);
    expect(await order(f.project.id)).toEqual([hidden.id, b.id, a.id, c.id]);
    const sameLane = await post(c.id, { expectedRevision: (await current(c)).revision, statusId: f.done, anchorTaskId: b.id, placement: 'before' });
    expect(sameLane.statusCode).toBe(200); expect(taskResponseSchema.parse(sameLane.json()).data.parentTaskId).toBe(b.id);
    const fresh = createDatabase(required(target).url, { requireLoopback: true });
    try {
      expect(await order(f.project.id, fresh)).toEqual([hidden.id, c.id, b.id, a.id]);
      const read = createTaskApplication(fresh); expect((await read.getTask(ctx(), a.id)).statusId).toBe(f.done);
      const listed = await read.listTasks(ctx(), { projectId: f.project.id, statusId: f.done, limit: 200 });
      expect(listed.items.map(row => row.id)).toEqual([c.id, b.id, a.id]);
    } finally { await fresh.close(); }
  });

  it('uses the entire target lane beyond loaded pages and preserves archived rows outside the target census', async () => {
    const f = await fixture('Board complete lane'), source = await f.create(), parent = await f.create({ statusId: f.done });
    const rows = Array.from({ length: 220 }, (_, position) => ({ id: randomUUID(), packageId: randomUUID(), position: position + 2, statusId: position % 2 ? f.todo : f.done, parentTaskId: position % 3 ? null : parent.id }));
    await db.sql.begin(async tx => {
      const packages = rows.filter(row => row.parentTaskId === null).map(row => ({ id: row.packageId, workspace_id: W.team, project_id: f.project.id, origin: 'new_task' }));
      await tx`insert into work_packages ${tx(packages, 'id', 'workspace_id', 'project_id', 'origin')}`;
      const entries = rows.map(row => ({ id: row.id, workspace_id: W.team, project_id: f.project.id, work_package_id: row.parentTaskId === null ? row.packageId : parent.workPackageId, title: 'Unloaded Board task', status_id: row.statusId, position: row.position, parent_task_id: row.parentTaskId }));
      await tx`insert into tasks ${tx(entries, 'id', 'workspace_id', 'project_id', 'work_package_id', 'title', 'status_id', 'position', 'parent_task_id')}`;
    });
    const archived = await f.create({ statusId: f.done }); await tasks.archiveTask(ctx(), archived.id, { expectedRevision: archived.revision });
    const moved = await tasks.moveTask(ctx(), source.id, { expectedRevision: source.revision, statusId: f.done, anchorTaskId: null, placement: 'after' });
    const ordered = await order(f.project.id), last = required(rows[218]);
    expect(ordered.indexOf(source.id)).toBe(ordered.indexOf(last.id) + 1); expect(ordered.at(-1)).toBe(archived.id); expect(moved.statusId).toBe(f.done);
    const after = await databaseSnapshot(db.sql);
    expect(await tasks.moveTask(ctx(), source.id, { expectedRevision: moved.revision, statusId: f.done, anchorTaskId: null, placement: 'after' })).toEqual(moved);
    const noOp = await current(source); expect(noOp.revision).toBe(moved.revision);
    // The accepted no-op adds only its own receipt; no task/history rewrite.
    expect((await databaseSnapshot(db.sql)).rowDigests['tasks']).toEqual(after.rowDigests['tasks']);
  });

  it('rejects stale, wrong-lane and foreign targets, then applies the real enforce dependency policy atomically', async () => {
    const f = await fixture('Board rejected'), source = await f.create(), anchor = await f.create({ statusId: f.done }), blocker = await f.create();
    const body = { expectedRevision: source.revision, statusId: f.done, anchorTaskId: anchor.id, placement: 'after' as const };
    await rejected('REVISION_CONFLICT', () => tasks.moveTask(ctx(), source.id, { ...body, expectedRevision: 99 }));
    await rejected('DOMAIN_VALIDATION_FAILED', () => tasks.moveTask(ctx(), source.id, { ...body, statusId: f.todo }));
    const foreign = await fixture('Board foreign');
    await rejected('DOMAIN_VALIDATION_FAILED', () => tasks.moveTask(ctx(), source.id, { ...body, statusId: foreign.done }));
    const dependencies = createDependencyApplication(db);
    await dependencies.createDependency(ctx(), { predecessorTaskId: blocker.id, successorTaskId: source.id, type: 'finish_to_start', expectedAbsent: true });
    await dependencies.updateProjectPolicy(ctx(), f.project.id, { expectedRevision: 0, mode: 'enforce' });
    await rejected('DOMAIN_VALIDATION_FAILED', () => tasks.moveTask(ctx(), source.id, body));
    await tasks.updateTask(ctx(), blocker.id, { expectedRevision: blocker.revision, statusId: f.done });
    const moved = await tasks.moveTask(ctx(), source.id, body); expect(moved.statusId).toBe(f.done);
    expect(await order(f.project.id)).toEqual([anchor.id, source.id, blocker.id]);
  });

  it('rolls back status, earlier position writes, receipts and audit when a later SQL row write fails', async () => {
    const f = await fixture('Board SQL rollback'), source = await f.create(), middle = await f.create(), anchor = await f.create({ statusId: f.done });
    // Constraint belongs only to this synthetic child and is removed before the next case.
    await db.sql.unsafe(`alter table tasks add constraint board_qa_reject_shift check (id <> '${middle.id}'::uuid or position = ${middle.position})`);
    try {
      const before = await databaseSnapshot(db.sql);
      const failure: unknown = await tasks.moveTask(ctx(), source.id, { expectedRevision: source.revision, statusId: f.done, anchorTaskId: anchor.id, placement: 'after' }).then(() => null, (error: unknown) => error);
      let cause: unknown = failure, matched = false;
      for (let depth = 0; depth < 8 && typeof cause === 'object' && cause !== null; depth += 1) {
        const detail = cause as { code?: unknown; constraint_name?: unknown; cause?: unknown };
        if (detail.code === '23514' && detail.constraint_name === 'board_qa_reject_shift') { matched = true; break; }
        cause = detail.cause;
      }
      expect(matched).toBe(true); // Requires the intended late SQL check, never any arbitrary rejection.
      expect(await databaseSnapshot(db.sql)).toEqual(before);
    } finally { await db.sql`alter table tasks drop constraint board_qa_reject_shift`; }
  });

  it('serializes competing source revisions and replays the exact accepted receipt without reordering again', async () => {
    const f = await fixture('Board concurrency'), source = await f.create(), a = await f.create({ statusId: f.done }), b = await f.create({ statusId: f.done });
    const keys = [randomUUID(), randomUUID()], bodies = [a, b].map(anchor => ({ expectedRevision: source.revision, statusId: f.done, anchorTaskId: anchor.id, placement: 'after' as const }));
    const responses = await Promise.all(bodies.map((body, index) => post(source.id, body, required(keys[index]))));
    expect(responses.map(response => response.statusCode).sort()).toEqual([200, 409]);
    const winner = responses.findIndex(response => response.statusCode === 200), moved = taskResponseSchema.parse(required(responses[winner]).json()).data;
    await tasks.updateTask(ctx(), source.id, { expectedRevision: moved.revision, title: 'Later edit' });
    const before = await databaseSnapshot(db.sql), replay = await post(source.id, required(bodies[winner]), required(keys[winner]));
    expect(replay.statusCode).toBe(200); expect(taskResponseSchema.parse(replay.json()).data).toEqual(moved); expect(await databaseSnapshot(db.sql)).toEqual(before);
  });
});
