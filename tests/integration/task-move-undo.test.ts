// Own fresh throwaway PostgreSQL only. No developer/demo database contents are read.
import { randomUUID } from 'node:crypto';
import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import type { MoveTaskDto, MoveUndoAck, RestoreMoveTaskInput } from '@workloom/contracts';
import type { CommandContext, TaskApplication } from '@workloom/domain';
import { createDatabase, createTaskApplication, runMigrations, seedDemoData, FIXTURE_USER_IDS as U, FIXTURE_WORKSPACE_IDS as W, FIXTURE_MEMBERSHIP_IDS as M, type Database } from '@workloom/db';
import { databaseSnapshot } from './support/p1b.js';
import { requireTestDatabaseUrl } from './support/test-database-url.js';
import { createThrowawayDatabase, type ThrowawayDatabase } from './support/test-database.js';
requireTestDatabaseUrl();
const ctx = (key = randomUUID(), userId: string = U.owner): CommandContext => ({ workspaceId: W.team, actor: { userId, displayName: 'Synthetic move undo', kind: 'fixture' }, source: 'web', requestId: randomUUID(), idempotencyKey: key });
function required<T>(value: T | undefined | null): T { if (value === undefined || value === null) throw Error('Missing isolated move fixture'); return value; }
function ack(task: MoveTaskDto): MoveUndoAck { return required(task.moveUndo); }
function inverse(task: MoveTaskDto, known: readonly MoveUndoAck[] = [ack(task)]): RestoreMoveTaskInput {
  const original = ack(task);
  const expectedHeads = original.afterHeads.map(head => ({ taskId: head.taskId, revision: [...known].reverse().flatMap(row => row.afterHeads).find(row => row.taskId === head.taskId)?.revision ?? head.revision }));
  return { originalMoveKey: original.originalKey, expectedOrderFingerprint: original.orderFingerprint, expectedRevision: required(expectedHeads.find(row => row.taskId === task.id)).revision, expectedHeads };
}
describe('server-receipt move inverse on real PostgreSQL', () => {
  let child: ThrowawayDatabase | undefined, db: Database, tasks: TaskApplication;
  beforeAll(async () => { child = await createThrowawayDatabase('move_undo'); db = createDatabase(child.url, { requireLoopback: true }); await runMigrations(child.url, { requireLoopback: true }); await seedDemoData(db); tasks = createTaskApplication(db); }, 60_000);
  afterAll(async () => { try { await db?.close(); } finally { await child?.drop(); } });
  async function fixture(label: string) {
    const project = await tasks.createProject(ctx(), { name: label }), statuses = await tasks.listStatuses(ctx(), project.id);
    const todo = required(statuses.find(row => row.group === 'todo')), done = required(statuses.find(row => row.group === 'done'));
    const a0 = await tasks.createTask(ctx(), { projectId: project.id, statusId: todo.id, title: 'A original', responsibleMembershipId: M.teamOwner });
    const b0 = await tasks.createTask(ctx(), { projectId: project.id, statusId: todo.id, title: 'B original' });
    const c0 = await tasks.createTask(ctx(), { projectId: project.id, statusId: done.id, title: 'C original', responsibleMembershipId: M.teamMemberB });
    const a = await tasks.updateTask(ctx(), a0.id, { expectedRevision: a0.revision, position: 10 }), b = await tasks.updateTask(ctx(), b0.id, { expectedRevision: b0.revision, position: 10 }), c = await tasks.updateTask(ctx(), c0.id, { expectedRevision: c0.revision, position: 40 });
    return { project, todo, done, a, b, c };
  }
  async function semantic(ids: readonly string[]) { return Promise.all(ids.map(async id => { const row = await tasks.getTask(ctx(), id); return { id, position: row.position, sectionId: row.sectionId, parentTaskId: row.parentTaskId, responsibleMembershipId: row.responsibleMembershipId, statusId: row.statusId }; })); }
  async function unchanged(code: string, run: () => Promise<unknown>) { const before = await databaseSnapshot(db.sql); await expect(run()).rejects.toMatchObject({ code }); expect(await databaseSnapshot(db.sql)).toEqual(before); }
  it('reverses sequential assignee and Board moves with exact gaps/ties, confirmed shifted heads and immutable receipts', async () => {
    const f = await fixture('Move reverse stack'), ids = [f.a.id, f.b.id, f.c.id], original = await semantic(ids);
    const m1 = await tasks.moveTask(ctx(), f.a.id, { expectedRevision: f.a.revision, responsibleMembershipId: M.teamMemberB, anchorTaskId: f.c.id, placement: 'after', captureUndo: true });
    const currentC = await tasks.getTask(ctx(), f.c.id);
    const m2 = await tasks.moveTask(ctx(), f.c.id, { expectedRevision: currentC.revision, statusId: f.todo.id, anchorTaskId: f.b.id, placement: 'before', captureUndo: true });
    const history = [ack(m1), ack(m2)];
    const undo2 = await tasks.restoreMoveTask(ctx(), m2.id, inverse(m2, history)); history.push(ack(undo2));
    const key = randomUUID(), body = inverse(m1, history), undo1 = await tasks.restoreMoveTask(ctx(key), m1.id, body);
    expect(await semantic(ids)).toEqual(original); expect(undo1.revision).toBeGreaterThan(m1.revision);
    const beforeReplay = await databaseSnapshot(db.sql); expect(await tasks.restoreMoveTask(ctx(key), m1.id, body)).toEqual(undo1); expect(await databaseSnapshot(db.sql)).toEqual(beforeReplay);
    const events = await db.sql`select id from audit_events where entity_id=${f.a.id} and action='updated'`; expect(events.length).toBeGreaterThanOrEqual(3);
    const source = await db.sql`select result from command_idempotency where command='task.move.undo-source' and idempotency_key=${ack(m1).originalKey}`;
    expect(source).toHaveLength(1); expect(JSON.stringify(source)).not.toContain('A original');
  });
  it('rejects a changed shifted sibling, incomplete guards and a different actor before any inverse/audit write', async () => {
    const f = await fixture('Move foreign guards');
    const moved = await tasks.moveTask(ctx(), f.a.id, { expectedRevision: f.a.revision, anchorTaskId: f.c.id, placement: 'after', captureUndo: true }); const body = inverse(moved);
    await unchanged('NOT_FOUND', () => tasks.restoreMoveTask(ctx(randomUUID(), U.memberA), moved.id, body));
    await unchanged('REVISION_CONFLICT', () => tasks.restoreMoveTask(ctx(), moved.id, { ...body, expectedHeads: body.expectedHeads.filter(row => row.taskId !== f.b.id) }));
    const b = await tasks.getTask(ctx(), f.b.id); await tasks.updateTask(ctx(randomUUID(), U.memberA), b.id, { expectedRevision: b.revision, title: 'Colleague value preserved' });
    await unchanged('REVISION_CONFLICT', () => tasks.restoreMoveTask(ctx(), moved.id, body)); expect((await tasks.getTask(ctx(), b.id)).title).toBe('Colleague value preserved');
  });
  it('rolls back the source, shifted positions, audit/outbox and inverse receipt on a late SQL failure', async () => {
    const f = await fixture('Move inverse late failure');
    const moved = await tasks.moveTask(ctx(), f.a.id, { expectedRevision: f.a.revision, anchorTaskId: f.c.id, placement: 'after', captureUndo: true }), body = inverse(moved);
    if (!/^[0-9a-f-]{36}$/.test(f.b.id)) throw Error('Unexpected synthetic ID');
    await db.sql.unsafe(`create function move_undo_late_fault() returns trigger language plpgsql as $$ begin if new.id='${f.b.id}'::uuid and new.position<>old.position then raise exception 'move_undo_late_fault'; end if; return new; end $$`);
    try { await db.sql.unsafe('create trigger move_undo_late_fault before update on tasks for each row execute function move_undo_late_fault()'); const before = await databaseSnapshot(db.sql); await expect(tasks.restoreMoveTask(ctx(), moved.id, body)).rejects.toThrow(); expect(await databaseSnapshot(db.sql)).toEqual(before); }
    finally { await db.sql.unsafe('drop trigger if exists move_undo_late_fault on tasks'); await db.sql.unsafe('drop function if exists move_undo_late_fault()'); }
  });
});
