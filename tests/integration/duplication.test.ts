// Owned disposable PostgreSQL only. Duplication uses the real DB factory, workspace barrier and census.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type * as C from '@workloom/contracts';
import type { CommandContext, DuplicationApplication, GenericReportApplication, PlanningCheckApplication, TaskApplication, TaskFieldApplication } from '@workloom/domain';
import { createDatabase, createTaskApplication, createTaskFieldApplication, createGenericReportApplication, createPlanningCheckApplication, createPlanningApplication, createMeetingApplication, runMigrations, seedDemoData, FIXTURE_WORKSPACE_IDS as W, FIXTURE_USER_IDS as U, FIXTURE_MEMBERSHIP_IDS as M, type Database } from '@workloom/db';
import { createDuplicationApplication } from '../../packages/db/src/duplication/application.js';
import { databaseSnapshot, membershipRow, restoreMembership, revokeMembership } from './support/p1b.js';
import { createThrowawayDatabase, type ThrowawayDatabase } from './support/test-database.js';
import { requireTestDatabaseUrl } from './support/test-database-url.js';
requireTestDatabaseUrl();
const ctx = (userId: string = U.owner, key: string = randomUUID()): CommandContext => ({ workspaceId: W.team, actor: { userId, displayName: 'Synthetic duplication', kind: 'fixture' }, requestId: randomUUID(), source: 'web', idempotencyKey: key });
const copy: C.DuplicationCopyOptions = { description: true, assignee: true, dates: true, tags: true, priority: true, participants: true, subtasks: true, customFieldIds: [] };
function required<T>(value: T | null | undefined): T { if (value === null || value === undefined) throw new Error('Missing duplication fixture'); return value; }
describe('atomic ordinary duplication on isolated PostgreSQL', () => {
  let target: ThrowawayDatabase | undefined, db: Database, tasks: TaskApplication, fields: TaskFieldApplication, reports: GenericReportApplication, checks: PlanningCheckApplication, duplicates: DuplicationApplication;
  beforeAll(async () => { target = await createThrowawayDatabase('duplication'); db = createDatabase(target.url, { requireLoopback: true }); await runMigrations(target.url, { requireLoopback: true }); await seedDemoData(db); tasks = createTaskApplication(db); fields = createTaskFieldApplication(db); reports = createGenericReportApplication(db); checks = createPlanningCheckApplication(db); duplicates = createDuplicationApplication(db); }, 60_000);
  afterAll(async () => { await db?.close(); await target?.drop(); }, 30_000);
  async function fixture() {
    const project = await tasks.createProject(ctx(), { name: `Duplication ${randomUUID().slice(0, 8)}` }), statuses = await tasks.listStatuses(ctx(), project.id), todo = required(statuses.find(row => row.group === 'todo')), done = required(statuses.find(row => row.group === 'done'));
    const section = await tasks.createSection(ctx(), project.id, { name: 'Source section' });
    const task = await tasks.createTask(ctx(), { projectId: project.id, sectionId: section.id, title: 'Original', description: 'Useful description', statusId: done.id, responsibleMembershipId: M.teamMemberA, participantMembershipIds: [M.teamMemberA], startDate: '2026-10-20', dueDate: '2026-10-23', priority: 'high' });
    return { project, todo, done, section, task };
  }
  async function newField(projectId: string, type: 'boolean' | 'duration' | 'single_select' = 'duration', name = `Ordinary ${type} value`) { return fields.createField(ctx(), { projectId, name, type, historyEnabled: true, locked: false, options: type === 'single_select' ? [{ name: 'Old choice', color: '#663399' }] : [] }); }
  async function rejectUnchanged(code: string, action: () => Promise<unknown>) { const before = await databaseSnapshot(db.sql); await expect(action()).rejects.toMatchObject({ code }); expect(await databaseSnapshot(db.sql)).toEqual(before); }
  async function historical() {
    const names = ['plan_baselines', 'package_baselines', 'period_commitments', 'work_logs', 'work_log_revisions', 'weekly_report_runs', 'generic_report_initial_snapshots', 'task_dependencies', 'task_comments'];
    return Promise.all(names.map(async table => ({ table, rows: await db.sql`select * from ${db.sql(table)} order by 1` })));
  }
  it('duplicates a complete tree with fresh identities, To do status, opt-in zero/false fields and no historical work', async () => {
    const f = await fixture(), zero = await newField(f.project.id), flag = await newField(f.project.id, 'boolean');
    await fields.setTaskValue(ctx(), f.task.id, zero.id, { expectedRevision: 0, expectedDefinitionRevision: zero.revision, value: { type: 'duration', value: 0 } });
    await fields.setTaskValue(ctx(), f.task.id, flag.id, { expectedRevision: 0, expectedDefinitionRevision: flag.revision, value: { type: 'boolean', value: false } });
    const child = await tasks.createTask(ctx(), { projectId: f.project.id, sectionId: f.section.id, parentTaskId: f.task.id, title: 'Detail', statusId: f.done.id });
    const extra = await tasks.createTask(ctx(), { projectId: f.project.id, sectionId: f.section.id, parentTaskId: child.id, title: 'Added scope', workScope: 'added_scope', estimateMinutes: 180, statusId: f.todo.id });
    const planning = createPlanningApplication(db), period = await planning.createPeriod(ctx(), { projectId: f.project.id, name: 'Source recorded time', localStart: '2026-10-19', timezone: 'UTC', cutoffAt: '2099-12-31T00:00:00.000Z', protectedFieldIds: [], protectEstimate: true });
    await planning.setManualPeriodWork(ctx(), f.task.id, period.id, M.teamMemberA, { expectedRevision: null, minutes: 90, state: 'active', reason: null });
    const beforeHistory = await historical(), input = { projectId: f.project.id, title: 'New work', copy: { ...copy, customFieldIds: [zero.id, flag.id] } }, preview = await duplicates.previewTask(ctx(), f.task.id, input), commandContext = ctx();
    expect(preview.taskCount).toBe(3);
    const result = await duplicates.duplicateTask(commandContext, f.task.id, { ...input, expectedSourceVersion: preview.sourceVersion });
    expect(result.taskIds).toHaveLength(3); expect(new Set(result.taskIds).size).toBe(3);
    const created = await Promise.all(result.taskIds.map(id => tasks.getTask(ctx(), id))), root = required(created[0]), detail = required(created[1]), added = required(created[2]);
    expect(root).toMatchObject({ title: 'New work', description: f.task.description, statusId: f.todo.id, responsibleMembershipId: M.teamMemberA, priority: 'high', dueDate: f.task.dueDate, estimateMinutes: null });
    expect(created.every(task => task.statusId === f.todo.id)).toBe(true);
    expect((await tasks.getTask(ctx(), f.task.id)).statusId).toBe(f.done.id);
    expect((await tasks.getTask(ctx(), child.id)).statusId).toBe(f.done.id);
    expect(root.workPackageId).not.toBe(f.task.workPackageId); expect(detail.parentTaskId).toBe(root.id); expect(detail.workPackageId).toBe(root.workPackageId); expect(added.parentTaskId).toBe(detail.id); expect(added.workPackageId).not.toBe(root.workPackageId); expect(added.workPackageId).not.toBe(extra.workPackageId); expect(added.estimateMinutes).toBeNull();
    const values = await fields.listTaskValues(ctx(), root.id);
    expect(values.map(value => value.value)).toEqual(expect.arrayContaining([{ type: 'duration', value: 0 }, { type: 'boolean', value: false }])); expect(values.every(value => value.revision === 1)).toBe(true);
    expect(await historical()).toEqual(beforeHistory);
    const after = await databaseSnapshot(db.sql);
    expect(await duplicates.duplicateTask(commandContext, f.task.id, { ...input, expectedSourceVersion: preview.sourceVersion })).toEqual(result);
    expect(await databaseSnapshot(db.sql)).toEqual(after);
  });
  it('copies no custom value by default but allows an explicitly selected report fact field', async () => {
    const f = await fixture(), actual = await newField(f.project.id, 'duration', 'User chosen actual'), plan = await newField(f.project.id, 'duration', 'User chosen estimate');
    await reports.create(ctx(), { name: 'Configured ordinary actual', config: { projectId: f.project.id, hierarchy: 'all_tasks', measures: [{ key: 'plan', operation: 'sum', fieldId: plan.id }, { key: 'fact', operation: 'sum', fieldId: actual.id }], comparison: { planFieldId: plan.id, factFieldId: actual.id, completion: 'done_only' }, groupBy: { kind: 'assignee' }, filters: { statusGroups: [], tagIds: [], assignee: { kind: 'all' }, dateRange: null } } });
    await fields.setTaskValue(ctx(), f.task.id, actual.id, { expectedRevision: 0, expectedDefinitionRevision: actual.revision, value: { type: 'duration', value: 90 } });
    const base = { projectId: f.project.id, title: 'Blank values', copy }, p = await duplicates.previewTask(ctx(), f.task.id, base), first = await duplicates.duplicateTask(ctx(), f.task.id, { ...base, expectedSourceVersion: p.sourceVersion });
    expect(await fields.listTaskValues(ctx(), required(first.rootTaskId))).toEqual([]);
    const chosen = { ...base, title: 'Explicit values', copy: { ...copy, customFieldIds: [actual.id] } }, q = await duplicates.previewTask(ctx(), f.task.id, chosen), second = await duplicates.duplicateTask(ctx(), f.task.id, { ...chosen, expectedSourceVersion: q.sourceVersion });
    expect((await fields.listTaskValues(ctx(), required(second.rootTaskId)))[0]?.value).toEqual({ type: 'duration', value: 90 });
  });
  it('rejects stale independent value changes and a late invalid option atomically without partial copies', async () => {
    const f = await fixture(), actual = await newField(f.project.id), option = await newField(f.project.id, 'single_select');
    await fields.setTaskValue(ctx(), f.task.id, actual.id, { expectedRevision: 0, expectedDefinitionRevision: actual.revision, value: { type: 'duration', value: 60 } });
    const base = { projectId: f.project.id, title: 'Never partial', copy: { ...copy, customFieldIds: [actual.id] } }, p = await duplicates.previewTask(ctx(), f.task.id, base);
    await fields.setTaskValue(ctx(), f.task.id, actual.id, { expectedRevision: 1, expectedDefinitionRevision: actual.revision, value: { type: 'duration', value: 120 } });
    await rejectUnchanged('PREVIEW_STALE', () => duplicates.duplicateTask(ctx(), f.task.id, { ...base, expectedSourceVersion: p.sourceVersion }));
    const optionId = required(option.options[0]).id;
    await fields.setTaskValue(ctx(), f.task.id, option.id, { expectedRevision: 0, expectedDefinitionRevision: option.revision, value: { type: 'single_select', value: optionId } });
    await fields.updateOption(ctx(), option.id, optionId, { expectedRevision: 1, archived: true });
    const invalid = { ...base, copy: { ...copy, customFieldIds: [actual.id, option.id] } }, q = await duplicates.previewTask(ctx(), f.task.id, invalid);
    await rejectUnchanged('DOMAIN_VALIDATION_FAILED', () => duplicates.duplicateTask(ctx(), f.task.id, { ...invalid, expectedSourceVersion: q.sourceVersion }));
  });
  it('replays exact successful receipts after source changes/archive, but refuses a revoked actor before replay', async () => {
    const f = await fixture(), user = U.memberA, commandContext = ctx(user), input = { projectId: f.project.id, title: 'Member copy', copy }, p = await duplicates.previewTask(ctx(user), f.task.id, input), result = await duplicates.duplicateTask(commandContext, f.task.id, { ...input, expectedSourceVersion: p.sourceVersion });
    await tasks.archiveTask(ctx(), f.task.id, { expectedRevision: (await tasks.getTask(ctx(), f.task.id)).revision });
    const before = await databaseSnapshot(db.sql);
    expect(await duplicates.duplicateTask(commandContext, f.task.id, { ...input, expectedSourceVersion: p.sourceVersion })).toEqual(result); expect(await databaseSnapshot(db.sql)).toEqual(before);
    const saved = await membershipRow(db.sql, W.team, M.teamMemberA); await revokeMembership(db.sql, W.team, M.teamMemberA);
    try { await rejectUnchanged('NOT_FOUND', () => duplicates.duplicateTask(commandContext, f.task.id, { ...input, expectedSourceVersion: p.sourceVersion })); } finally { await restoreMembership(db.sql, W.team, M.teamMemberA, saved); }
  });
  it('clones section-specific summaries and balance checks with fresh keys and literal references, even with no tasks', async () => {
    const f = await fixture(), effort = await newField(f.project.id), later = await tasks.createSection(ctx(), f.project.id, { name: 'Following section' });
    await reports.setSettings(ctx(), f.project.id, { expectedRevision: 0, measures: [], headerWidgets: [{ group: { kind: 'section', sectionId: f.section.id }, widgets: [{ key: 'effort', kind: 'measure', label: 'Selected effort', measure: { key: 'effort_sum', operation: 'sum', fieldId: effort.id } }] }] });
    const rule: C.PlanningCheckRuleDto = { id: randomUUID(), name: 'Section target', enabled: true, kind: 'balance', hierarchy: 'all_tasks', filters: { statusGroups: [], tagIds: [], assignee: { kind: 'all' }, dateRange: null }, group: { kind: 'section', sectionId: f.section.id }, sumFieldId: effort.id, cohort: { kind: 'all_tasks' }, missingPlan: 'unknown', target: { kind: 'fixed', unit: 'minutes', value: 2400 }, under: { enabled: true, thresholdBps: 8000, fullIntensityAtBps: 5000, nearColor: '#eab308', farColor: '#dc2626' }, over: { enabled: true, thresholdBps: 11000, fullIntensityAtBps: 15000, nearColor: '#f97316', farColor: '#dc2626' } };
    await checks.setSettings(ctx(), f.project.id, { expectedRevision: 0, config: { enabled: true, rules: [rule] } });
    const input = { name: 'Reusable section', includeTasks: false, includeSettings: true, copy }, p = await duplicates.previewSection(ctx(), f.section.id, input), beforeHistory = await historical(), result = await duplicates.duplicateSection(ctx(), f.section.id, { ...input, expectedSourceVersion: p.sourceVersion });
    expect(result.taskIds).toEqual([]); expect(result.rootTaskId).toBeNull(); const section = required(result.section);
    expect(section.position).toBe(f.section.position + 1); expect((await tasks.listSections(ctx(), f.project.id)).find(row => row.id === later.id)?.position).toBe(later.position + 1);
    const aggregates = await reports.getSettings(ctx(), f.project.id), nextChecks = await checks.getSettings(ctx(), f.project.id), settings = required(p.settings);
    expect(aggregates.revision).toBe(settings.aggregateRevision + 1); expect(nextChecks.revision).toBe(settings.checksRevision + 1);
    expect(aggregates.headerWidgets?.[0]).toEqual(settings.headerWidgets[0]); const widget = required(aggregates.headerWidgets?.[1]?.widgets[0]); expect(widget.key).not.toBe('effort'); if (widget.kind !== 'measure') throw new Error('Expected copied measure'); expect(widget.measure).toMatchObject({ fieldId: effort.id }); expect(widget.measure.key).not.toBe('effort_sum');
    expect(nextChecks.config.rules[0]).toEqual(rule); expect(nextChecks.config.rules[1]).toMatchObject({ group: { kind: 'section', sectionId: section.id }, sumFieldId: effort.id, target: rule.target }); expect(nextChecks.config.rules[1]?.id).not.toBe(rule.id);
    expect(await historical()).toEqual(beforeHistory);
    await rejectUnchanged('CAPABILITY_REQUIRED', () => duplicates.previewSection(ctx(U.memberA), f.section.id, input));
  });
  it('duplicates a completed task into To do without copying fields required only for completion', async () => {
    const f = await fixture(), actual = await newField(f.project.id);
    await fields.setTaskValue(ctx(), f.task.id, actual.id, { expectedRevision: 0, expectedDefinitionRevision: actual.revision, value: { type: 'duration', value: 90 } });
    const rule: Extract<C.PlanningCheckRuleDto, { kind: 'presence' }> = {
      id: randomUUID(), name: 'Actual required before completion', enabled: true, kind: 'presence', fieldId: actual.id,
      color: '#dc2626', severity: 'critical', hierarchy: 'all_tasks', requireBeforeDone: true,
      filters: { statusGroups: ['done'], tagIds: [], assignee: { kind: 'all' }, dateRange: null },
    };
    await checks.setSettings(ctx(), f.project.id, { expectedRevision: 0, config: { enabled: true, rules: [rule] } });
    const input = { projectId: f.project.id, title: 'Fresh work', copy: { ...copy, subtasks: false } };
    const preview = await duplicates.previewTask(ctx(), f.task.id, input);
    const result = await duplicates.duplicateTask(ctx(), f.task.id, { ...input, expectedSourceVersion: preview.sourceVersion });
    const created = await tasks.getTask(ctx(), required(result.rootTaskId));
    expect(created.statusId).toBe(f.todo.id);
    expect(await fields.listTaskValues(ctx(), created.id)).toEqual([]);
    expect((await tasks.getTask(ctx(), f.task.id)).statusId).toBe(f.done.id);
    expect((await fields.listTaskValues(ctx(), f.task.id))[0]?.value).toEqual({ type: 'duration', value: 90 });
    // Completion rules still apply when the newly created work is actually completed.
    await rejectUnchanged('DOMAIN_VALIDATION_FAILED', () => tasks.updateTask(ctx(), created.id, { expectedRevision: created.revision, statusId: f.done.id }));
  });

  it('starts all tasks copied with a section in the first To do status regardless of source status or status name', async () => {
    const f = await fixture(), statuses = await tasks.listStatuses(ctx(), f.project.id);
    const inProgress = required(statuses.find(status => status.group === 'in_progress'));
    const cancelled = required(statuses.find(status => status.group === 'cancelled'));
    const active = await tasks.createTask(ctx(), { projectId: f.project.id, sectionId: f.section.id, title: 'Started', statusId: inProgress.id });
    const abandoned = await tasks.createTask(ctx(), { projectId: f.project.id, sectionId: f.section.id, title: 'Cancelled', statusId: cancelled.id });
    const chosenId = randomUUID();
    // Project statuses are identified by group and order, including custom names and multiple To do columns.
    await db.sql`update task_statuses set position = position + 1 where workspace_id = ${W.team} and project_id = ${f.project.id}`;
    await db.sql`insert into task_statuses (id, workspace_id, project_id, name, "group", position, revision)
      values (${chosenId}, ${W.team}, ${f.project.id}, 'Ready to start', 'todo', 0, 1)`;
    const input = { name: 'New section work', includeTasks: true, includeSettings: false, copy };
    const preview = await duplicates.previewSection(ctx(), f.section.id, input);
    const result = await duplicates.duplicateSection(ctx(), f.section.id, { ...input, expectedSourceVersion: preview.sourceVersion });
    expect(result.taskIds).toHaveLength(3);
    const created = await Promise.all(result.taskIds.map(id => tasks.getTask(ctx(), id)));
    expect(created.every(task => task.statusId === chosenId)).toBe(true);
    for (const original of [f.task, active, abandoned]) expect((await tasks.getTask(ctx(), original.id)).statusId).toBe(original.statusId);
  });

  it('blocks locked copied values through the mandatory guard without committing a new task', async () => {
    const f = await fixture(), effort = await newField(f.project.id);
    await fields.setTaskValue(ctx(), f.task.id, effort.id, { expectedRevision: 0, expectedDefinitionRevision: effort.revision, value: { type: 'duration', value: 30 } });
    await fields.updateField(ctx(), effort.id, { expectedRevision: effort.revision, locked: true });
    const input = { projectId: f.project.id, title: 'Blocked copy', copy: { ...copy, customFieldIds: [effort.id] } }, p = await duplicates.previewTask(ctx(), f.task.id, input);
    const before = required((await db.sql<{ count: number }[]>`select count(*)::int as count from tasks where project_id=${f.project.id}`)[0]).count;
    await expect(duplicates.duplicateTask(ctx(), f.task.id, { ...input, expectedSourceVersion: p.sourceVersion })).rejects.toMatchObject({ code: 'FIELD_LOCKED' });
    expect(required((await db.sql<{ count: number }[]>`select count(*)::int as count from tasks where project_id=${f.project.id}`)[0]).count).toBe(before);
  });

  it('rolls back the new section and order shifts if copied settings exceed configured limits', async () => {
    const f = await fixture(), effort = await newField(f.project.id);
    const rules: C.PlanningCheckRuleDto[] = Array.from({ length: 50 }, () => ({ id: randomUUID(), name: 'Configured target', enabled: false, kind: 'balance', hierarchy: 'all_tasks', filters: { statusGroups: [], tagIds: [], assignee: { kind: 'all' }, dateRange: null }, group: { kind: 'section', sectionId: f.section.id }, sumFieldId: effort.id, cohort: { kind: 'all_tasks' }, missingPlan: 'unknown', target: { kind: 'fixed', unit: 'minutes', value: 2400 }, under: { enabled: false, thresholdBps: 8000, fullIntensityAtBps: 5000, nearColor: '#eab308', farColor: '#dc2626' }, over: { enabled: false, thresholdBps: 11000, fullIntensityAtBps: 15000, nearColor: '#f97316', farColor: '#dc2626' } }));
    await checks.setSettings(ctx(), f.project.id, { expectedRevision: 0, config: { enabled: false, rules } });
    await tasks.createSection(ctx(), f.project.id, { name: 'Must not shift' });
    const input = { name: 'Too many copied rules', includeTasks: false, includeSettings: true, copy }, preview = await duplicates.previewSection(ctx(), f.section.id, input);
    await rejectUnchanged('VALIDATION_FAILED', () => duplicates.duplicateSection(ctx(), f.section.id, { ...input, expectedSourceVersion: preview.sourceVersion }));
  });
  it('rejects linked rows and meeting sources instead of converting or silently omitting them', async () => {
    const f = await fixture(), other = await fixture();
    await required(tasks.placements).attachTaskProject(ctx(), other.task.id, { projectId: f.project.id, sectionId: f.section.id, expectedTaskRevision: other.task.revision });
    await rejectUnchanged('DOMAIN_VALIDATION_FAILED', () => duplicates.previewSection(ctx(), f.section.id, { name: 'Linked section', includeTasks: true, includeSettings: false, copy }));
    await rejectUnchanged('DOMAIN_VALIDATION_FAILED', () => duplicates.previewTask(ctx(), other.task.id, { projectId: f.project.id, title: 'Linked source', copy }));
    const planning = createPlanningApplication(db), period = await planning.createPeriod(ctx(), { projectId: f.project.id, name: 'Meeting fixture', localStart: '2027-06-07', timezone: 'UTC', cutoffAt: '2099-12-31T00:00:00.000Z', protectedFieldIds: [], protectEstimate: true });
    const meeting = await createMeetingApplication(db).createMeeting(ctx(), f.project.id, { title: 'Must stay a meeting', statusId: f.todo.id, plannedPeriodId: period.id, plannedStartAt: '2027-06-07T10:00:00.000Z', timezone: 'UTC', plannedDurationMinutes: 30, organizerMembershipId: M.teamMemberA, attendeeMembershipIds: [M.teamMemberA] });
    await rejectUnchanged('DOMAIN_VALIDATION_FAILED', () => duplicates.previewTask(ctx(), meeting.task.id, { projectId: f.project.id, title: 'No meeting conversion', copy }));
  });

});
