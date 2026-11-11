// Real PostgreSQL: changing a task's home to another of its projects while the former home stays in its projects.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDatabase, createTaskApplication, createTaskFieldApplication, runMigrations, seedDemoData, FIXTURE_USER_IDS as U, FIXTURE_WORKSPACE_IDS as W, type Database } from '@workloom/db';
import type { CommandContext } from '@workloom/domain';
import { createThrowawayDatabase, type ThrowawayDatabase } from './support/test-database.js';
import { requireTestDatabaseUrl } from './support/test-database-url.js';
requireTestDatabaseUrl();

const ctx = (): CommandContext => ({ workspaceId: W.team, actor: { userId: U.owner, displayName: 'Synthetic actor', kind: 'fixture' }, source: 'web', requestId: randomUUID(), idempotencyKey: randomUUID() });
const must = <T>(value: T | null | undefined): T => { if (value === null || value === undefined) throw Error('Missing synthetic fixture'); return value; };

describe('task home switch on PostgreSQL', () => {
  let target: ThrowawayDatabase | undefined, db: Database;
  beforeAll(async () => {
    target = await createThrowawayDatabase('home_switch');
    db = createDatabase(target.url, { requireLoopback: true, maxConnections: 4 });
    await runMigrations(target.url, { requireLoopback: true });
    await seedDemoData(db);
  }, 90000);
  afterAll(async () => { await db?.close(); await target?.drop(); }, 30000);

  async function fixture() {
    const tasks = createTaskApplication(db), fields = createTaskFieldApplication(db);
    const backlog = await tasks.createProject(ctx(), { name: `Backlog ${randomUUID().slice(0, 8)}` });
    const week = await tasks.createProject(ctx(), { name: `Week ${randomUUID().slice(0, 8)}` });
    const todo = must((await tasks.listStatuses(ctx(), backlog.id)).find(status => status.group === 'todo'));
    const parent = await tasks.createTask(ctx(), { projectId: backlog.id, statusId: todo.id, title: 'Backlog item' });
    const child = await tasks.createTask(ctx(), { projectId: backlog.id, statusId: todo.id, title: 'Backlog detail', parentTaskId: parent.id });
    // Hours are tracked in both projects under the same name, like two week projects.
    const hours = (projectId: string) => fields.createField(ctx(), { projectId, name: 'Hours', type: 'duration', historyEnabled: true, locked: false, options: [] });
    const backlogHours = await hours(backlog.id), weekHours = await hours(week.id);
    await fields.setTaskValue(ctx(), parent.id, backlogHours.id, { expectedRevision: 0, expectedDefinitionRevision: backlogHours.revision, value: { type: 'duration', value: 90 } });
    const placements = must(tasks.placements);
    return { tasks, fields, placements, backlog, week, parent, child, backlogHours, weekHours };
  }
  const rows = (taskId: string) => db.sql<{ project_id: string; home_project_id: string; archived: boolean; home_row: boolean }[]>`
    select project_id::text, home_project_id::text, archived_at is not null as archived, id = task_id as home_row from task_project_placements where task_id = ${taskId} order by home_row desc, project_id`;
  const values = (taskId: string) => db.sql<{ project_id: string; value: { value: unknown } }[]>`select project_id::text, value from task_field_values where task_id = ${taskId} order by project_id`;
  // The value each project holds for the task: a project's reports and totals also count linked tasks by its own fields.
  const held = async (taskId: string) => Object.fromEntries((await values(taskId)).map(row => [row.project_id, row.value.value]));

  it('makes a listed project the home in one step and keeps the former home active for the task and its subtasks', async () => {
    const f = await fixture();
    await f.placements.attachTaskProject(ctx(), f.parent.id, { projectId: f.week.id, expectedTaskRevision: f.parent.revision });
    const current = await f.tasks.getTask(ctx(), f.parent.id);
    const result = await f.placements.transferTaskProject(ctx(), f.parent.id, { expectedRevision: current.revision, projectId: f.week.id, keepFormerHome: true });
    expect(result.task.projectId).toBe(f.week.id);
    expect(result.movedTaskIds.sort()).toEqual([f.parent.id, f.child.id].sort());
    expect(result.carriedValues).toBe(1);
    // The week is now the home row; the backlog stays as an ordinary, active placement.
    expect(await rows(f.parent.id)).toEqual([
      { project_id: f.week.id, home_project_id: f.week.id, archived: false, home_row: true },
      { project_id: f.backlog.id, home_project_id: f.week.id, archived: false, home_row: false },
    ]);
    expect((await rows(f.child.id)).map(row => [row.project_id, row.archived, row.home_row])).toEqual([[f.week.id, false, true], [f.backlog.id, false, false]]);
    // The value moved to the week: the backlog, which still shows the task, no longer counts its hours.
    expect(await held(f.parent.id)).toEqual({ [f.week.id]: 90, [f.backlog.id]: null });
    const backlogRows = await f.placements.listProjectRows(ctx(), f.backlog.id, { limit: 100, includeArchived: false });
    expect(backlogRows.items.map(row => row.canonicalTask.id).sort()).toEqual([f.parent.id, f.child.id].sort());

    // Switching back is the same action and leaves both projects in place again.
    const moved = await f.tasks.getTask(ctx(), f.parent.id);
    await f.placements.transferTaskProject(ctx(), f.parent.id, { expectedRevision: moved.revision, projectId: f.backlog.id, keepFormerHome: true });
    expect((await rows(f.parent.id)).map(row => [row.project_id, row.archived, row.home_row])).toEqual([[f.backlog.id, false, true], [f.week.id, false, false]]);
    expect(await held(f.parent.id)).toEqual({ [f.backlog.id]: 90, [f.week.id]: null });
  });

  it('keeps a value in the former home, without copying it, when it cannot be cleared there', async () => {
    const f = await fixture();
    await f.fields.updateField(ctx(), f.backlogHours.id, { expectedRevision: f.backlogHours.revision, locked: true });
    await f.placements.attachTaskProject(ctx(), f.parent.id, { projectId: f.week.id, expectedTaskRevision: f.parent.revision });
    const current = await f.tasks.getTask(ctx(), f.parent.id);
    const result = await f.placements.transferTaskProject(ctx(), f.parent.id, { expectedRevision: current.revision, projectId: f.week.id, keepFormerHome: true });
    expect(result.task.projectId).toBe(f.week.id);
    expect(result.carriedValues).toBe(0);
    expect(result.notCarried).toEqual([{ fieldName: 'Hours', count: 1 }]);
    expect(await held(f.parent.id)).toEqual({ [f.backlog.id]: 90 });
  });

  it('still removes the former home when it is not kept', async () => {
    const f = await fixture();
    const current = await f.tasks.getTask(ctx(), f.parent.id);
    await f.placements.transferTaskProject(ctx(), f.parent.id, { expectedRevision: current.revision, projectId: f.week.id });
    expect((await rows(f.parent.id)).map(row => [row.project_id, row.archived, row.home_row])).toEqual([[f.week.id, false, true], [f.backlog.id, true, false]]);
    // The detached former home leaves the project's scope, so its value is kept as history, not counted.
    expect(await held(f.parent.id)).toEqual({ [f.week.id]: 90, [f.backlog.id]: 90 });
  });
});
