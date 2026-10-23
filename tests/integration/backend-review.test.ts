import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDatabase, createTaskApplication, createTaskFieldApplication, createTaskContinuationApplication, createProjectCopyApplication, createTaskDefaultsApplication, runMigrations, seedDemoData, FIXTURE_USER_IDS as U, FIXTURE_WORKSPACE_IDS as W, type Database } from '@workloom/db';
import type { CommandContext } from '@workloom/domain';
import { createThrowawayDatabase, type ThrowawayDatabase } from './support/test-database.js';
import { requireTestDatabaseUrl } from './support/test-database-url.js';
requireTestDatabaseUrl();
const ctx = (key = randomUUID()): CommandContext => ({ workspaceId: W.team, actor: { userId: U.owner, kind: 'fixture', displayName: 'Synthetic reviewer' }, source: 'web', requestId: randomUUID(), idempotencyKey: key });
const need = <T>(v: T | null | undefined): T => { if (v === null || v === undefined)
  throw Error('Missing synthetic value'); return v; };
describe('backend review safety regressions', () => {
  let target: ThrowawayDatabase | undefined, db: Database;
  beforeAll(async () => { target = await createThrowawayDatabase('backend_review'); db = createDatabase(target.url, { requireLoopback: true }); await runMigrations(target.url, { requireLoopback: true }); await seedDemoData(db); }, 90000);
  afterAll(async () => { await db?.close(); await target?.drop(); }, 30000);
  async function project() { const app = createTaskApplication(db), p = await app.createProject(ctx(), { name: 'Review ' + randomUUID() }), todo = need((await app.listStatuses(ctx(), p.id)).find(s => s.group === 'todo')); return { app, p, todo }; }
  async function counts() { return (await db.sql `select (select count(*)::int from tasks) tasks,(select count(*)::int from audit_events) audit,(select count(*)::int from command_idempotency) receipts`)[0]; }
  it('prevents PATCH section/package/cycle bypass and writes in archived projects', async () => {
    const { app, p, todo } = await project(), one = await app.createSection(ctx(), p.id, { name: 'One' }), two = await app.createSection(ctx(), p.id, { name: 'Two' }), root = await app.createTask(ctx(), { projectId: p.id, statusId: todo.id, title: 'Root', sectionId: one.id }), child = await app.createTask(ctx(), { projectId: p.id, statusId: todo.id, title: 'Detail', parentTaskId: root.id, sectionId: one.id }), grand = await app.createTask(ctx(), { projectId: p.id, statusId: todo.id, title: 'Grandchild', parentTaskId: child.id, sectionId: one.id });
    const before = await counts();
    for (const [task, input] of [[child, { sectionId: two.id }], [child, { parentTaskId: null }], [root, { parentTaskId: grand.id }]] as const)
      await expect(app.updateTask(ctx(), task.id, { expectedRevision: task.revision, ...input })).rejects.toMatchObject({ code: 'DOMAIN_VALIDATION_FAILED' });
    expect(await counts()).toEqual(before);
    await app.updateProject(ctx(), p.id, { expectedRevision: p.revision, archived: true });
    const archived = await counts();
    await expect(app.updateTask(ctx(), root.id, { expectedRevision: root.revision, title: 'Must not write' })).rejects.toMatchObject({ code: 'DOMAIN_VALIDATION_FAILED' });
    await expect(app.archiveTask(ctx(), root.id, { expectedRevision: root.revision })).rejects.toMatchObject({ code: 'DOMAIN_VALIDATION_FAILED' });
    expect(await counts()).toEqual(archived);
  });
  it('does not restore a descendant below a separately archived legacy parent', async () => { const { app, p, todo } = await project(), root = await app.createTask(ctx(), { projectId: p.id, statusId: todo.id, title: 'Root' }), child = await app.createTask(ctx(), { projectId: p.id, statusId: todo.id, title: 'Legacy archived child', parentTaskId: root.id }), grand = await app.createTask(ctx(), { projectId: p.id, statusId: todo.id, title: 'Legacy active grandchild', parentTaskId: child.id }); await db.sql `update tasks set archived_at='2020-01-01T00:00:00Z'::timestamptz where id=${child.id}`; const archived = await app.archiveTask(ctx(), root.id, { expectedRevision: root.revision }); await app.restoreTask(ctx(), root.id, { expectedRevision: archived.revision }); expect((await app.getTask(ctx(), child.id)).archivedAt).not.toBeNull(); expect((await app.getTask(ctx(), grand.id)).archivedAt).not.toBeNull(); });
  it('permits independent added-scope detach without rewriting package identity', async () => { const { app, p, todo } = await project(), root = await app.createTask(ctx(), { projectId: p.id, statusId: todo.id, title: 'Root' }), child = await app.createTask(ctx(), { projectId: p.id, statusId: todo.id, title: 'Added scope', parentTaskId: root.id, workScope: 'added_scope' }), detached = await app.updateTask(ctx(), child.id, { expectedRevision: child.revision, parentTaskId: null }); expect(detached.parentTaskId).toBeNull(); expect(detached.workPackageId).toBe(child.workPackageId); expect(detached.workPackageId).not.toBe(root.workPackageId); });
  it('rejects unusable dynamic/default references when saving, before any defaults row', async () => {
    const { p } = await project(), fields = createTaskFieldApplication(db), number = await fields.createField(ctx(), { projectId: p.id, name: 'Number', type: 'number', historyEnabled: true, locked: false, options: [] }), other = await project(), foreign = await fields.createField(ctx(), { projectId: other.p.id, name: 'Foreign', type: 'date', historyEnabled: true, locked: false, options: [] }), defaults = createTaskDefaultsApplication(db), empty = { statusId: null, priority: null, estimateMinutes: null, fieldValues: [] };
    for (const addition of [{ assignee: { kind: 'fixed', membershipId: randomUUID() } }, { tags: { kind: 'fixed', tagIds: [randomUUID()] } }, { todayFields: [{ fieldId: number.id, offsetDays: 0 }] }, { fromAbove: { priority: false, estimate: false, fieldIds: [foreign.id] } }])
      await expect(defaults.setDefaults(ctx(), p.id, { expectedRevision: 0, config: { ...empty, ...addition } as never })).rejects.toMatchObject({ code: 'DOMAIN_VALIDATION_FAILED' });
    expect((await defaults.getDefaults(ctx(), p.id)).revision).toBe(0);
  });
  it('binds continuation to the full input and retains an exact final ACK after later task edits', async () => {
    const a = await project(), b = await project(), task = await a.app.createTask(ctx(), { projectId: a.p.id, statusId: a.todo.id, title: 'Continue' }), app = createTaskContinuationApplication(db), context = ctx(), input = { targetProjectId: b.p.id }, results = await Promise.all([app.continueTask(context, task.id, input), app.continueTask(context, task.id, input)]), first = need(results[0]);
    expect(results[1]).toEqual(first);
    await a.app.updateTask(ctx(), task.id, { expectedRevision: first.closed.revision, title: 'Later title' });
    const before = await counts();
    expect(await app.continueTask(context, task.id, input)).toEqual(first);
    await expect(app.continueTask(context, task.id, { targetProjectId: a.p.id })).rejects.toMatchObject({ code: 'IDEMPOTENCY_KEY_REUSED' });
    expect(await counts()).toEqual(before);
  });
  it('preflights explicit carries and copies explicit duration in the same project', async () => {
    const { app, p, todo } = await project(), other = await project(), fields = createTaskFieldApplication(db), from = await fields.createField(ctx(), { projectId: p.id, name: 'Hours', type: 'duration', historyEnabled: true, locked: false, options: [] }), to = await fields.createField(ctx(), { projectId: other.p.id, name: 'Hours', type: 'duration', historyEnabled: true, locked: true, options: [] }), task = await app.createTask(ctx(), { projectId: p.id, statusId: todo.id, title: 'Carry' });
    await fields.setTaskValue(ctx(), task.id, from.id, { expectedRevision: 0, expectedDefinitionRevision: from.revision, value: { type: 'duration', value: 0 } });
    const service = createTaskContinuationApplication(db), before = (await app.getTask(ctx(), task.id)).revision;
    await expect(service.continueTask(ctx(), task.id, { targetProjectId: other.p.id, carryFieldIds: [from.id] })).rejects.toMatchObject({ code: 'DOMAIN_VALIDATION_FAILED' });
    expect((await app.getTask(ctx(), task.id)).revision).toBe(before);
    expect((await app.listTasks(ctx(), { projectId: other.p.id, limit: 100 })).items).toHaveLength(0);
    expect(to.locked).toBe(true);
    const done = await service.continueTask(ctx(), task.id, { targetProjectId: p.id, carryFieldIds: [from.id] });
    expect((await fields.listTaskValues(ctx(), done.continued.id)).find(v => v.fieldId === from.id)?.value).toEqual({ type: 'duration', value: 0 });
  });
  it('resumes after a field carry committed but a late link failed, without duplicating work', async () => {
    const a = await project(), b = await project(), fields = createTaskFieldApplication(db);
    const from = await fields.createField(ctx(), { projectId: a.p.id, name: 'Carry hours', type: 'duration', historyEnabled: true, locked: false, options: [] });
    const to = await fields.createField(ctx(), { projectId: b.p.id, name: 'Carry hours', type: 'duration', historyEnabled: true, locked: false, options: [] });
    const choices = await fields.createField(ctx(), { projectId: a.p.id, name: 'Carry choices', type: 'multi_select', historyEnabled: true, locked: false, options: [{ name: 'Alpha', color: null }, { name: 'Beta', color: null }] });
    const orderedSource = [...choices.options].sort((left, right) => left.id.localeCompare(right.id));
    let targetChoices = await fields.createField(ctx(), { projectId: b.p.id, name: 'Carry choices', type: 'multi_select', historyEnabled: true, locked: false, options: [{ name: 'Temporary first', color: null }, { name: 'Temporary second', color: null }] });
    const orderedTarget = [...targetChoices.options].sort((left, right) => left.id.localeCompare(right.id));
    // Source ID order intentionally maps to the reverse target ID order.
    targetChoices = await fields.updateOption(ctx(), targetChoices.id, need(orderedTarget[0]).id, { expectedRevision: targetChoices.revision, name: need(orderedSource[1]).name });
    targetChoices = await fields.updateOption(ctx(), targetChoices.id, need(orderedTarget[1]).id, { expectedRevision: targetChoices.revision, name: need(orderedSource[0]).name });
    const task = await a.app.createTask(ctx(), { projectId: a.p.id, statusId: a.todo.id, title: 'Late continuation' });
    await fields.setTaskValue(ctx(), task.id, choices.id, { expectedRevision: 0, expectedDefinitionRevision: choices.revision, value: { type: 'multi_select', value: orderedSource.map(option => option.id) } });
    await fields.setTaskValue(ctx(), task.id, from.id, { expectedRevision: 0, expectedDefinitionRevision: from.revision, value: { type: 'duration', value: 125 } });
    const app = createTaskContinuationApplication(db), context = ctx(), input = { targetProjectId: b.p.id, carryFieldIds: [from.id] };
    await db.sql `create function review_fail_link() returns trigger language plpgsql as $$ begin raise exception 'Synthetic late link failure'; end $$`;
    await db.sql `create trigger review_fail_link before insert on task_dependencies for each row execute function review_fail_link()`;
    try {
      await expect(app.continueTask(context, task.id, input)).rejects.toBeDefined();
    }
    finally {
      await db.sql `drop trigger review_fail_link on task_dependencies`;
      await db.sql `drop function review_fail_link()`;
    }
    const pending = need((await a.app.listTasks(ctx(), { projectId: b.p.id, limit: 100 })).items[0]);
    expect((await fields.listTaskValues(ctx(), pending.id)).find(value => value.fieldId === to.id)).toMatchObject({ revision: 1, value: { type: 'duration', value: 125 } });
    await expect(app.continueTask(context, task.id, { targetProjectId: a.p.id })).rejects.toMatchObject({ code: 'IDEMPOTENCY_KEY_REUSED' });
    const result = await app.continueTask(context, task.id, input);
    expect((await a.app.listTasks(ctx(), { projectId: b.p.id, limit: 100 })).items.map(t => t.id)).toEqual([result.continued.id]);
    expect((await fields.listTaskValues(ctx(), result.continued.id)).find(value => value.fieldId === to.id)).toMatchObject({ revision: 1, value: { type: 'duration', value: 125 } });
    expect((await fields.listTaskValues(ctx(), result.continued.id)).find(value => value.fieldId === targetChoices.id)).toMatchObject({ revision: 1, value: { type: 'multi_select', value: orderedTarget.map(option => option.id) } });
    expect((await db.sql `select id from task_dependencies where predecessor_task_id=${task.id} and successor_task_id=${result.continued.id}`)).toHaveLength(1);
    expect(await app.continueTask(context, task.id, input)).toEqual(result);
  });
  it('binds a project copy input and returns exact receipt after source structure changes', async () => { const a = await project(), app = createProjectCopyApplication(db), context = ctx(), input = { name: 'Review copy ' + randomUUID() }, first = await app.duplicateProject(context, a.p.id, input); await a.app.createSection(ctx(), a.p.id, { name: 'Added afterwards' }); const before = (await db.sql `select count(*)::int n from projects`)[0]?.n; expect(await app.duplicateProject(context, a.p.id, input)).toEqual(first); await expect(app.duplicateProject(context, a.p.id, { ...input, shiftDays: 7 })).rejects.toMatchObject({ code: 'IDEMPOTENCY_KEY_REUSED' }); expect((await db.sql `select count(*)::int n from projects`)[0]?.n).toBe(before); });
});
