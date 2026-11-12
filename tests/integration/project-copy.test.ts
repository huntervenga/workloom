// Isolated PostgreSQL: copying a project's structure and settings without its tasks.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createDatabase, createGenericReportApplication, createMyTasksApplication, createPlanningCheckApplication, createProjectCopyApplication, createTaskApplication, FIXTURE_MEMBERSHIP_IDS as M,
  createTaskDefaultsApplication, createTaskFieldApplication, runMigrations, seedDemoData, FIXTURE_USER_IDS as U, FIXTURE_WORKSPACE_IDS as W, type Database,
} from '@workloom/db';
import type { CommandContext } from '@workloom/domain';
import { createThrowawayDatabase, type ThrowawayDatabase } from './support/test-database.js';
import { requireTestDatabaseUrl } from './support/test-database-url.js';

requireTestDatabaseUrl();
const ctx = (userId: string = U.owner, key: string = randomUUID()): CommandContext => ({ workspaceId: W.team, actor: { userId, displayName: 'Synthetic copier', kind: 'fixture' }, source: 'web', requestId: randomUUID(), idempotencyKey: key });
function need<T>(value: T | null | undefined): T { if (value === null || value === undefined) throw new Error('fixture missing'); return value; }

describe('project copy on isolated PostgreSQL', () => {
  let target: ThrowawayDatabase | undefined;
  let db: Database;
  beforeAll(async () => {
    target = await createThrowawayDatabase('project_copy');
    db = createDatabase(target.url, { requireLoopback: true });
    await runMigrations(target.url, { requireLoopback: true });
    await seedDemoData(db);
  }, 90_000);
  afterAll(async () => { await db?.close(); await target?.drop(); }, 30_000);

  async function source() {
    const tasks = createTaskApplication(db), fields = createTaskFieldApplication(db), reports = createGenericReportApplication(db), checks = createPlanningCheckApplication(db), defaults = createTaskDefaultsApplication(db);
    const project = await tasks.createProject(ctx(), { name: '42 week (since 19 October 2026) Planning' });
    const dated = await tasks.updateProject(ctx(), project.id, { expectedRevision: project.revision, dateRange: { from: '2026-10-19', to: '2026-10-25' } });
    for (const name of ['Mark', 'Andrei']) await tasks.createSection(ctx(), project.id, { name });
    const template = await reports.template(ctx(), project.id, { planName: 'Hours Est', factName: 'Hours Fact', reportName: 'Plan vs fact', expectedColumnsRevision: 1 });
    const [plan, fact] = template.fields;
    const stage = await fields.createField(ctx(), { projectId: project.id, name: 'Stage', type: 'single_select', historyEnabled: true, locked: false, options: [{ name: 'Design', color: null }, { name: 'Build', color: null }] });
    const sections = await tasks.listSections(ctx(), project.id);
    const statuses = await tasks.listStatuses(ctx(), project.id);
    const checkSettings = await checks.getSettings(ctx(), project.id);
    await checks.setSettings(ctx(), project.id, { expectedRevision: checkSettings.revision, config: { enabled: true, rules: [
      { id: randomUUID(), kind: 'presence', name: 'Estimate missing', color: '#dc2626', enabled: true, hierarchy: 'all_tasks', severity: 'warning', fieldId: need(plan).id, filters: { statusGroups: ['todo'], tagIds: [], assignee: { kind: 'all' }, dateRange: { source: { kind: 'due_date' }, from: '2026-10-19', to: '2026-10-25' } } },
      { id: randomUUID(), kind: 'presence', name: 'Fact missing when done', color: '#dc2626', enabled: true, hierarchy: 'all_tasks', severity: 'critical', fieldId: need(fact).id, requireBeforeDone: true, filters: { statusGroups: ['done'], tagIds: [], assignee: { kind: 'all' }, dateRange: null } },
    ] } });
    const design = need(stage.options.find(o => o.name === 'Design'));
    await defaults.setDefaults(ctx(), project.id, { expectedRevision: 0, config: { statusId: need(statuses.find(s => s.group === 'todo')).id, priority: 'medium', estimateMinutes: null, fieldValues: [{ fieldId: need(plan).id, value: { type: 'duration', value: 60 } }, { fieldId: stage.id, value: { type: 'single_select', value: design.id } }] } });
    return { project: dated, sections, plan: need(plan), fact: need(fact), stage, design, template };
  }

  it('copies sections, fields with options, columns, checks, defaults and reports — without tasks — and shifts dates', async () => {
    const s = await source();
    const tasks = createTaskApplication(db);
    await tasks.createTask(ctx(), { projectId: s.project.id, title: 'Existing task', statusId: need((await tasks.listStatuses(ctx(), s.project.id)).find(x => x.group === 'todo')).id });
    const copies = createProjectCopyApplication(db);
    const result = await copies.duplicateProject(ctx(), s.project.id, { name: '43 week (since 26 October 2026) Planning', shiftDays: 7 });
    expect(result.warnings).toEqual([]);
    expect(result.copied).toMatchObject({ sections: 2, fields: 3, checkRules: 2, defaults: true });
    expect(result.copied.reports).toBeGreaterThanOrEqual(1);

    const copy = await tasks.getProject(ctx(), result.projectId);
    expect(copy.name).toBe('43 week (since 26 October 2026) Planning');
    expect(copy.dateRange).toMatchObject({ from: '2026-10-26', to: '2026-11-01' });
    expect((await tasks.listSections(ctx(), result.projectId)).map(x => x.name)).toEqual(['Mark', 'Andrei']);
    expect(await tasks.listTasks(ctx(), { projectId: result.projectId, limit: 50, includeArchived: true })).toMatchObject({ items: [] });

    const fields = createTaskFieldApplication(db);
    const copiedFields = await fields.listFields(ctx(), result.projectId);
    expect(copiedFields.map(f => f.name).sort()).toEqual(['Hours Est', 'Hours Fact', 'Stage']);
    expect(copiedFields.find(f => f.name === 'Stage')?.options.map(o => o.name).sort()).toEqual(['Build', 'Design']);
    const copiedIds = new Set(copiedFields.map(f => f.id));
    expect([s.plan.id, s.fact.id, s.stage.id].some(id => copiedIds.has(id))).toBe(false);
    const columns = await fields.getProjectColumns(ctx(), result.projectId);
    expect(columns.columns.map(c => c.fieldId).every(id => copiedIds.has(id))).toBe(true);
    expect(columns.columns.length).toBeGreaterThanOrEqual(2);

    const checks = await createPlanningCheckApplication(db).getSettings(ctx(), result.projectId);
    expect(checks.config.rules.map(r => r.name)).toEqual(['Estimate missing', 'Fact missing when done']);
    const first = checks.config.rules[0];
    expect(first && 'fieldId' in first && copiedIds.has(first.fieldId)).toBe(true);
    expect(first?.filters.dateRange).toMatchObject({ from: '2026-10-26', to: '2026-11-01' });
    expect(checks.config.rules.map(r => r.id)).not.toContain(s.template.report.id);

    const defaults = await createTaskDefaultsApplication(db).getDefaults(ctx(), result.projectId);
    expect(defaults.config.priority).toBe('medium');
    expect(defaults.config.fieldValues).toHaveLength(2);
    expect(defaults.config.fieldValues.every(item => copiedIds.has(item.fieldId))).toBe(true);
    const newTodo = need((await tasks.listStatuses(ctx(), result.projectId)).find(x => x.group === 'todo'));
    expect(defaults.config.statusId).toBe(newTodo.id);

    const reports = await createGenericReportApplication(db).list(ctx(), result.projectId);
    expect(reports.map(r => r.name)).toContain('Plan vs fact');
    expect(reports.every(r => r.config.projectId === result.projectId)).toBe(true);

    // The source is untouched.
    expect(await tasks.listTasks(ctx(), { projectId: s.project.id, limit: 50 })).toMatchObject({ items: [expect.objectContaining({ title: 'Existing task' })] });
  });

  it('clones a template with its tasks, subtasks and every field value, and keeps template tasks out of My tasks', async () => {
    const tasks = createTaskApplication(db), fields = createTaskFieldApplication(db), copies = createProjectCopyApplication(db);
    const created = await tasks.createProject(ctx(), { name: 'Week template' });
    const dated = await tasks.updateProject(ctx(), created.id, { expectedRevision: created.revision, dateRange: { from: '2026-11-09', to: '2026-11-15' } });
    const project = await tasks.updateProject(ctx(), created.id, { expectedRevision: dated.revision, isTemplate: true });
    expect(project.isTemplate).toBe(true);
    const michael = await tasks.createSection(ctx(), project.id, { name: 'Michael' });
    await tasks.createSection(ctx(), project.id, { name: 'Anna' });
    const est = await fields.createField(ctx(), { projectId: project.id, name: 'Hours Est', type: 'duration', historyEnabled: true, locked: false, options: [] });
    const fact = await fields.createField(ctx(), { projectId: project.id, name: 'Hours Fact', type: 'duration', historyEnabled: true, locked: false, options: [] });
    const stage = await fields.createField(ctx(), { projectId: project.id, name: 'Stage', type: 'single_select', historyEnabled: true, locked: false, options: [{ name: 'Design', color: null }, { name: 'Build', color: null }] });
    const review = await fields.createField(ctx(), { projectId: project.id, name: 'Review', type: 'date', historyEnabled: false, locked: false, options: [] });
    const frozen = await fields.createField(ctx(), { projectId: project.id, name: 'Frozen note', type: 'text', historyEnabled: false, locked: false, options: [] });
    const statuses = await tasks.listStatuses(ctx(), project.id);
    const doing = need(statuses.find(x => x.group === 'in_progress'));
    const todo = need(statuses.find(x => x.group === 'todo'));
    const qa = await tasks.createTask(ctx(), { projectId: project.id, sectionId: michael.id, title: 'Template QA', statusId: doing.id, responsibleMembershipId: M.teamOwner, participantMembershipIds: [M.teamMemberA], dueDate: '2026-11-13', priority: 'high', estimateMinutes: 300 });
    const detail = await tasks.createTask(ctx(), { projectId: project.id, sectionId: michael.id, parentTaskId: qa.id, title: 'Template regression', statusId: todo.id });
    const extra = await tasks.createTask(ctx(), { projectId: project.id, sectionId: michael.id, parentTaskId: qa.id, title: 'Template extra scope', statusId: todo.id, workScope: 'added_scope', estimateMinutes: 30 });
    const old = await tasks.createTask(ctx(), { projectId: project.id, title: 'Template archived', statusId: todo.id });
    await tasks.archiveTask(ctx(), old.id, { expectedRevision: old.revision });
    const build = need(stage.options.find(o => o.name === 'Build'));
    await fields.setTaskValue(ctx(), qa.id, est.id, { expectedRevision: 0, expectedDefinitionRevision: est.revision, value: { type: 'duration', value: 300 } });
    await fields.setTaskValue(ctx(), qa.id, fact.id, { expectedRevision: 0, expectedDefinitionRevision: fact.revision, value: { type: 'duration', value: 60 } });
    await fields.setTaskValue(ctx(), qa.id, stage.id, { expectedRevision: 0, expectedDefinitionRevision: stage.revision, value: { type: 'single_select', value: build.id } });
    await fields.setTaskValue(ctx(), qa.id, review.id, { expectedRevision: 0, expectedDefinitionRevision: review.revision, value: { type: 'date', value: '2026-11-12' } });
    await fields.setTaskValue(ctx(), detail.id, est.id, { expectedRevision: 0, expectedDefinitionRevision: est.revision, value: { type: 'duration', value: 120 } });
    await fields.setTaskValue(ctx(), extra.id, frozen.id, { expectedRevision: 0, expectedDefinitionRevision: frozen.revision, value: { type: 'text', value: 'keep' } });
    await fields.updateField(ctx(), frozen.id, { expectedRevision: frozen.revision, locked: true });

    // Template tasks are not anyone's work: the owner's My tasks leaves them out.
    const myTasks = createMyTasksApplication(db, { secret: 'synthetic-personal-task-cursor-test-secret' });
    expect((await myTasks.list(ctx(), { search: 'Template QA' })).items).toEqual([]);

    const key = randomUUID();
    const result = await copies.duplicateProject(ctx(U.owner, key), project.id, { name: '46 week', shiftDays: 7, copy: { tasks: true } });
    expect(result.copied.tasks).toBe(3);
    expect(result.warnings).toEqual([{ part: 'tasks', message: 'Values of locked fields were not copied: Frozen note.' }]);
    const copy = await tasks.getProject(ctx(), result.projectId);
    expect(copy.isTemplate).toBeUndefined();
    expect(copy.dateRange).toEqual({ from: '2026-11-16', to: '2026-11-22' });

    const rows = (await tasks.listTasks(ctx(), { projectId: result.projectId, limit: 50, includeArchived: true })).items;
    expect(rows.map(row => row.title).sort()).toEqual(['Template QA', 'Template extra scope', 'Template regression']);
    const byTitle = (title: string) => need(rows.find(row => row.title === title));
    const [newQa, newDetail, newExtra] = [byTitle('Template QA'), byTitle('Template regression'), byTitle('Template extra scope')];
    const newSections = await tasks.listSections(ctx(), result.projectId), newStatuses = await tasks.listStatuses(ctx(), result.projectId);
    expect(newQa).toMatchObject({ parentTaskId: null, sectionId: need(newSections.find(x => x.name === 'Michael')).id, statusId: need(newStatuses.find(x => x.group === 'in_progress')).id, responsibleMembershipId: M.teamOwner, dueDate: '2026-11-20', priority: 'high', estimateMinutes: 300, position: qa.position });
    expect(newQa.participants.filter(p => p.active).map(p => p.membershipId)).toEqual([M.teamMemberA]);
    expect(newDetail).toMatchObject({ parentTaskId: newQa.id, workPackageId: newQa.workPackageId });
    expect(newExtra).toMatchObject({ parentTaskId: newQa.id, estimateMinutes: 30 });
    expect(newExtra.workPackageId).not.toBe(newQa.workPackageId);

    const newFields = await fields.listFields(ctx(), result.projectId);
    const fieldNamed = (name: string) => need(newFields.find(f => f.name === name));
    const values = await fields.listProjectValues(ctx(), result.projectId, { taskIds: [newQa.id, newDetail.id, newExtra.id] });
    const valueOf = (taskId: string, name: string) => values.find(v => v.taskId === taskId && v.fieldId === fieldNamed(name).id)?.value.value ?? null;
    expect(valueOf(newQa.id, 'Hours Est')).toBe(300);
    expect(valueOf(newQa.id, 'Hours Fact')).toBe(60);
    expect(valueOf(newQa.id, 'Stage')).toBe(need(fieldNamed('Stage').options.find(o => o.name === 'Build')).id);
    expect(valueOf(newQa.id, 'Review')).toBe('2026-11-19');
    expect(valueOf(newDetail.id, 'Hours Est')).toBe(120);
    expect(valueOf(newExtra.id, 'Frozen note')).toBeNull();

    // The copy is real work; a retry with the same key continues the same copy and creates nothing more.
    expect((await myTasks.list(ctx(), { search: 'Template QA' })).items.map(item => item.task.id)).toEqual([newQa.id]);
    const again = await copies.duplicateProject(ctx(U.owner, key), project.id, { name: '46 week', shiftDays: 7, copy: { tasks: true } });
    expect(again).toEqual(result);
    expect((await tasks.listTasks(ctx(), { projectId: result.projectId, limit: 50, includeArchived: true })).items).toHaveLength(3);
    // The template itself is untouched.
    expect((await tasks.listTasks(ctx(), { projectId: project.id, limit: 50 })).items.map(row => row.title).sort()).toEqual(['Template QA', 'Template extra scope', 'Template regression']);
  });

  it('is resumable: the same key returns the same project and does not create a second one', async () => {
    const s = await source();
    const copies = createProjectCopyApplication(db), key = randomUUID();
    const first = await copies.duplicateProject(ctx(U.owner, key), s.project.id, { name: 'Replay copy', shiftDays: 0 });
    const again = await copies.duplicateProject(ctx(U.owner, key), s.project.id, { name: 'Replay copy', shiftDays: 0 });
    expect(again.projectId).toBe(first.projectId);
    expect(again.copied).toEqual(first.copied);
    const named = (await createTaskApplication(db).listProjects(ctx())).filter(p => p.name === 'Replay copy');
    expect(named).toHaveLength(1);
  });

  it('refuses a member who may not manage fields before creating anything, and an unknown source', async () => {
    const s = await source();
    const copies = createProjectCopyApplication(db), tasks = createTaskApplication(db);
    const before = (await tasks.listProjects(ctx())).length;
    await expect(copies.duplicateProject(ctx(U.memberA), s.project.id, { name: 'Not allowed' })).rejects.toMatchObject({ code: 'CAPABILITY_REQUIRED' });
    await expect(copies.duplicateProject(ctx(), randomUUID(), { name: 'Nowhere' })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect((await tasks.listProjects(ctx())).length).toBe(before);
  });
});
