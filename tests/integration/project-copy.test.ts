// Isolated PostgreSQL: copying a project's structure and settings without its tasks.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createDatabase, createGenericReportApplication, createPlanningCheckApplication, createProjectCopyApplication, createTaskApplication,
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
