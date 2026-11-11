// Real PostgreSQL: a project's own tasks and the tasks of other projects shown in it (linked placements) share one order.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDatabase, createTaskApplication, runMigrations, seedDemoData, FIXTURE_USER_IDS as U, FIXTURE_WORKSPACE_IDS as W, type Database } from '@workloom/db';
import type { CommandContext } from '@workloom/domain';
import { createThrowawayDatabase, type ThrowawayDatabase } from './support/test-database.js';
import { requireTestDatabaseUrl } from './support/test-database-url.js';
requireTestDatabaseUrl();

const ctx = (key: string = randomUUID()): CommandContext => ({ workspaceId: W.team, actor: { userId: U.owner, displayName: 'Synthetic actor', kind: 'fixture' }, source: 'web', requestId: randomUUID(), idempotencyKey: key });
const must = <T>(value: T | null | undefined): T => { if (value === null || value === undefined) throw Error('Missing synthetic fixture'); return value; };

describe('shared order of own and linked tasks on PostgreSQL', () => {
  let target: ThrowawayDatabase | undefined, db: Database;
  beforeAll(async () => {
    target = await createThrowawayDatabase('placement_order');
    db = createDatabase(target.url, { requireLoopback: true, maxConnections: 4 });
    await runMigrations(target.url, { requireLoopback: true });
    await seedDemoData(db);
  }, 90000);
  afterAll(async () => { await db?.close(); await target?.drop(); }, 30000);

  async function fixture() {
    const tasks = createTaskApplication(db), placements = must(tasks.placements);
    const backlog = await tasks.createProject(ctx(), { name: `Backlog ${randomUUID().slice(0, 8)}` });
    const week = await tasks.createProject(ctx(), { name: `Week ${randomUUID().slice(0, 8)}` });
    const todo = (projectId: string) => tasks.listStatuses(ctx(), projectId).then(rows => must(rows.find(status => status.group === 'todo')));
    const backlogTodo = await todo(backlog.id), weekTodo = await todo(week.id);
    const doing = await tasks.createSection(ctx(), backlog.id, { name: 'Doing' });
    const own = async (title: string) => tasks.createTask(ctx(), { projectId: backlog.id, statusId: backlogTodo.id, title });
    const a = await own('A'), b = await own('B'), c = await own('C');
    // Two tasks of the week, shown in the backlog too.
    const linked = async (title: string) => {
      const task = await tasks.createTask(ctx(), { projectId: week.id, statusId: weekTodo.id, title });
      return placements.attachTaskProject(ctx(), task.id, { projectId: backlog.id, expectedTaskRevision: task.revision });
    };
    const l = await linked('L'), m = await linked('M');
    return { tasks, placements, backlog, doing, a, b, c, l, m, backlogTodo };
  }
  /** The backlog as its table shows it: own tasks and linked rows by number, the own task first on a tie. */
  const shown = async (projectId: string) => {
    const rows = await db.sql<{ label: string; position: number; own: boolean; section: string | null }[]>`
      select t.title as label, t.position, true as own, t.section_id::text as section from tasks t where t.project_id = ${projectId} and t.archived_at is null
      union all
      select t.title, p.position, false, p.section_id::text from task_project_placements p join tasks t on t.id = p.task_id
       where p.project_id = ${projectId} and p.home_project_id <> ${projectId} and p.archived_at is null`;
    return rows.sort((x, y) => x.position - y.position || Number(y.own) - Number(x.own)).map(row => row.label);
  };
  const placement = async (id: string) => must((await db.sql<{ revision: number; position: number; section: string | null }[]>`
    select revision, position, section_id::text as section from task_project_placements where id = ${id}`)[0]);
  const task = (tasks: ReturnType<typeof createTaskApplication>, id: string) => tasks.getTask(ctx(), id);

  it('moves a linked task next to an own task or another linked one, and to the end of a section', async () => {
    const f = await fixture();
    expect(await shown(f.backlog.id)).toEqual(['A', 'B', 'C', 'L', 'M']);
    await f.placements.updateTaskProjectPlacement(ctx(), f.l.id, { expectedRevision: (await placement(f.l.id)).revision, anchor: { taskId: f.b.id }, placement: 'after' });
    expect(await shown(f.backlog.id)).toEqual(['A', 'B', 'L', 'C', 'M']);
    await f.placements.updateTaskProjectPlacement(ctx(), f.m.id, { expectedRevision: (await placement(f.m.id)).revision, anchor: { placementId: f.l.id }, placement: 'before' });
    expect(await shown(f.backlog.id)).toEqual(['A', 'B', 'M', 'L', 'C']);
    // Into another section, at its end.
    const moved = await f.placements.updateTaskProjectPlacement(ctx(), f.m.id, { expectedRevision: (await placement(f.m.id)).revision, anchor: null, placement: 'after', sectionId: f.doing.id });
    expect(moved.sectionId).toBe(f.doing.id);
    expect(await shown(f.backlog.id)).toEqual(['A', 'B', 'L', 'C', 'M']);
    // Next to a task of another section takes that section.
    await f.placements.updateTaskProjectPlacement(ctx(), f.m.id, { expectedRevision: (await placement(f.m.id)).revision, anchor: { taskId: f.a.id }, placement: 'before' });
    expect((await placement(f.m.id)).section).toBeNull();
    expect(await shown(f.backlog.id)).toEqual(['M', 'A', 'B', 'L', 'C']);
  });

  it('keeps linked tasks next to their neighbours when own tasks move, are inserted or appended', async () => {
    const f = await fixture();
    await f.placements.updateTaskProjectPlacement(ctx(), f.l.id, { expectedRevision: (await placement(f.l.id)).revision, anchor: { taskId: f.b.id }, placement: 'after' });
    expect(await shown(f.backlog.id)).toEqual(['A', 'B', 'L', 'C', 'M']);
    // C to the top: L stays after B (before this change it jumped to after A).
    await f.tasks.moveTask(ctx(), f.c.id, { expectedRevision: (await task(f.tasks, f.c.id)).revision, anchorTaskId: f.a.id, placement: 'before' });
    expect(await shown(f.backlog.id)).toEqual(['C', 'A', 'B', 'L', 'M']);
    // An insertion after A keeps L after B.
    await f.tasks.createTask(ctx(), { projectId: f.backlog.id, statusId: f.backlogTodo.id, title: 'N', insertion: { anchorTaskId: f.a.id, placement: 'after' } });
    expect(await shown(f.backlog.id)).toEqual(['C', 'A', 'N', 'B', 'L', 'M']);
    // An appended task goes after the linked ones too.
    await f.tasks.createTask(ctx(), { projectId: f.backlog.id, statusId: f.backlogTodo.id, title: 'Z' });
    expect(await shown(f.backlog.id)).toEqual(['C', 'A', 'N', 'B', 'L', 'M', 'Z']);
  });

  it('gives linked tasks their numbers back when an own move is undone', async () => {
    const f = await fixture();
    await f.placements.updateTaskProjectPlacement(ctx(), f.l.id, { expectedRevision: (await placement(f.l.id)).revision, anchor: { taskId: f.b.id }, placement: 'after' });
    const before = await shown(f.backlog.id), lBefore = (await placement(f.l.id)).position;
    const key = randomUUID();
    const moved = await f.tasks.moveTask(ctx(key), f.c.id, { expectedRevision: (await task(f.tasks, f.c.id)).revision, anchorTaskId: f.a.id, placement: 'before', captureUndo: true });
    expect(await shown(f.backlog.id)).toEqual(['C', 'A', 'B', 'L', 'M']);
    const undo = must(moved.moveUndo);
    await f.tasks.restoreMoveTask(ctx(), f.c.id, { expectedRevision: moved.revision, originalMoveKey: key, expectedOrderFingerprint: undo.orderFingerprint, expectedHeads: undo.afterHeads });
    expect(await shown(f.backlog.id)).toEqual(before);
    expect((await placement(f.l.id)).position).toBe(lBefore);
  });
});
