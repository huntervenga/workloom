// Real HTTP/PostgreSQL P2b acceptance. No mocked report arithmetic or task-time projection.
import { randomUUID } from 'node:crypto';

import { categorizedWorkLogResponseSchema, type TaskDto, type TaskFieldDefinitionDto } from '@workloom/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { expectEnvelope, expectError, uniqueName } from './support/p1a.js';
import { changedTables, databaseSnapshot, membershipRow, rowDelta, restoreMembership, revokeMembership } from './support/p1b.js';
import { MEMBERS as M, period, planningHarness, planningProject, planningTask, TEAM, type PlanningHarness } from './support/p2a-fixture.js';
import { P2bClient } from './support/p2b.js';
import { requireTestDatabaseUrl } from './support/test-database-url.js';

requireTestDatabaseUrl();

describe('P2b category snapshots, all-fact reports and exact task-time projection over HTTP/PostgreSQL', () => {
  let h: PlanningHarness;
  let owner: P2bClient, replica: P2bClient, member: P2bClient, viewer: P2bClient, outsider: P2bClient;
  beforeAll(async () => {
    h = await planningHarness('p2b_http');
    [owner, replica, member, viewer, outsider] = [h.owner, h.replica, h.member, h.viewer, h.outsider].map(c => new P2bClient(c.api, c.workspaceId)) as [P2bClient, P2bClient, P2bClient, P2bClient, P2bClient];
  });
  afterAll(async () => { await h?.close(); });

  async function fixture(label: string) {
    const { project, todo, done } = await planningProject(owner, label);
    const field = await owner.createField({ projectId: project.id, name: 'Тип выполненной работы', type: 'single_select', options: [{ name: 'Развитие', color: '#6366f1' }, { name: 'Поддержка', color: '#0d9488' }] });
    const [a, b] = field.options;
    if (!a || !b) throw new Error('Category fixture requires two stable options.');
    const binding = await owner.bind(project.id, { expectedRevision: 1, fieldId: field.id });
    const week = await period(owner, project.id);
    return { project, todo, done, field, a, b, binding, week };
  }
  async function value(task: TaskDto, field: TaskFieldDefinitionDto, optionId: string | null) {
    const existing = (await owner.listTaskValues(task.id)).find(row => row.fieldId === field.id);
    return owner.setValue(task.id, field.id, { expectedRevision: existing?.revision ?? 0, expectedDefinitionRevision: field.revision, value: { type: 'single_select', value: optionId } });
  }

  it('keeps virtual binding reads write-free and enforces field type/tenant/current management rights', async () => {
    const { project } = await planningProject(owner, 'Привязка категории');
    const before = await databaseSnapshot(h.db.sql);
    expect(await owner.binding(project.id)).toEqual({ workspaceId: TEAM, projectId: project.id, revision: 1, versionId: null, fieldId: null, availability: 'unbound' });
    expect(await databaseSnapshot(h.db.sql)).toEqual(before);
    const text = await owner.createField({ projectId: project.id, name: 'Не категория', type: 'text' });
    expectError(await owner.patch(owner.bindingPath(project.id), { expectedRevision: 1, fieldId: text.id }), 422, 'DOMAIN_VALIDATION_FAILED');
    const select = await owner.createField({ projectId: project.id, name: 'Выбор', type: 'single_select', options: [{ name: 'Значение' }] });
    expectError(await member.patch(member.bindingPath(project.id), { expectedRevision: 1, fieldId: select.id }), 403, 'CAPABILITY_REQUIRED');
    expectError(await viewer.patch(viewer.bindingPath(project.id), { expectedRevision: 1, fieldId: select.id }), 403, 'CAPABILITY_REQUIRED');
    const foreignProject = await planningProject(outsider, 'Другой tenant');
    const foreign = await outsider.createField({ projectId: foreignProject.project.id, name: 'Чужая категория', type: 'single_select' });
    expectError(await owner.patch(owner.bindingPath(project.id), { expectedRevision: 1, fieldId: foreign.id }), 404, 'NOT_FOUND', [foreign.name]);
    const key = randomUUID(); const input = { expectedRevision: 1, fieldId: select.id };
    const bound = await owner.bind(project.id, input, key);
    expect(bound).toMatchObject({ revision: 2, fieldId: select.id, availability: 'active' });
    expect(bound.versionId).not.toBeNull();
    const state = await databaseSnapshot(h.db.sql);
    expect(await replica.bind(project.id, input, key)).toEqual(bound);
    expect(await databaseSnapshot(h.db.sql)).toEqual(state);
    expectError(await owner.patch(owner.bindingPath(project.id), { expectedRevision: 2, fieldId: null }, key), 409, 'IDEMPOTENCY_KEY_REUSED');
    expectError(await owner.patch(owner.bindingPath(project.id), input), 409, 'REVISION_CONFLICT');
  });

  it('reports60/30/30 as50/25/25 before any baseline; includes unknown category, Done/detail/archive and distinct person denominators', async () => {
    const f = await fixture('Полный знаменатель');
    const tagA = await owner.tasks.createTag({ name: uniqueName('Отметка A'), color: null });
    const tagB = await owner.tasks.createTag({ name: uniqueName('Отметка B'), color: null });
    const root = await owner.tasks.createTask({ projectId: f.project.id, statusId: f.done.id, title: 'Готовая основная работа', estimateMinutes: 480, participantMembershipIds: [M.teamOwner, M.teamMemberA], tagIds: [tagA.id, tagB.id] });
    const detail = await owner.tasks.createTask({ projectId: f.project.id, parentTaskId: root.id, workScope: 'detail', statusId: f.todo.id, title: 'Незавершённая детализация', participantMembershipIds: [M.teamOwner, M.teamMemberA], tagIds: [tagA.id, tagB.id] });
    const uncategorized = await planningTask(owner, f.project, null, 'Работа без выбранного типа');
    await value(root, f.field, f.a.id); await value(detail, f.field, f.b.id);
    const a = await owner.setWork(root.id, f.week.id, M.teamOwner, { expectedRevision: null, minutes: 60 });
    const b = await owner.setWork(detail.id, f.week.id, M.teamMemberA, { expectedRevision: null, minutes: 30 });
    const u = await owner.setWork(uncategorized.id, f.week.id, M.teamOwner, { expectedRevision: null, minutes: 30 });
    await owner.tasks.archiveTask(uncategorized.id, uncategorized.revision);
    expect(await owner.baselines(f.week.id)).toEqual([]);
    const run = await owner.typeReport({ periodId: f.week.id });
    expect(run).toMatchObject({ metricVersion: 'weekly_work_type_v1', totalActualMinutes: 120, activeSourceCount: 3, categorizedMinutes: 90, uncategorizedMinutes: 30, rowCount: 3 });
    expect(run.byCategory.find(x => x.optionId === f.a.id)).toMatchObject({ minutes: 60, sharePercent: 50 });
    expect(run.byCategory.find(x => x.optionId === f.b.id)).toMatchObject({ minutes: 30, sharePercent: 25 });
    expect(run.byCategory.find(x => x.optionId === null)).toMatchObject({ minutes: 30, sharePercent: 25 });
    const own = run.byPerson.find(x => x.membershipId === M.teamOwner);
    const colleague = run.byPerson.find(x => x.membershipId === M.teamMemberA);
    expect(own).toMatchObject({ totalActualMinutes: 90, activeSourceCount: 2 });
    expect(own?.byCategory.find(x => x.optionId === f.a.id)?.sharePercent).toBeCloseTo(100 * 60 / 90);
    expect(colleague).toMatchObject({ totalActualMinutes: 30, activeSourceCount: 1 });
    expect(colleague?.byCategory.find(x => x.optionId === f.b.id)?.sharePercent).toBe(100);
    const rows = await replica.typeRows(run.id, 1);
    expect(rows).toHaveLength(3);
    expect(new Set(rows.map(x => x.id)).size).toBe(3);
    expect(rows.map(x => x.workLog.revisionId).sort()).toEqual([a.revisionId, b.revisionId, u.revisionId].sort());
    expect(run.workLogRevisionIds.slice().sort()).toEqual(rows.map(x => x.workLog.revisionId).sort());
    expect(await viewer.getTypeReport(run.id)).toEqual(run);
    expect((await owner.typeReports(f.week.id)).map(x => x.id)).toContain(run.id);
  });

  it('distinguishes active zero, absent and void, retaining excluded diagnostic rows without invented completeness', async () => {
    const f = await fixture('Ноль и отменённый факт');
    const zeroTask = await planningTask(owner, f.project, 120);
    const voidTask = await planningTask(owner, f.project, 120);
    await planningTask(owner, f.project, 120, 'Нет источника');
    await value(zeroTask, f.field, f.a.id);
    const zero = await owner.setWork(zeroTask.id, f.week.id, M.teamOwner, { expectedRevision: null, minutes: 0 });
    const first = await owner.setWork(voidTask.id, f.week.id, M.teamMemberA, { expectedRevision: null, minutes: 60 });
    const voided = await owner.setWork(voidTask.id, f.week.id, M.teamMemberA, { expectedRevision: first.revision, minutes: 60, state: 'void', reason: 'Ошибочная запись времени' });
    const run = await owner.typeReport({ periodId: f.week.id });
    expect(run).toMatchObject({ totalActualMinutes: 0, activeSourceCount: 1, categorizedMinutes: 0, uncategorizedMinutes: 0, rowCount: 2 });
    expect(run.byCategory.every(x => x.sharePercent === null)).toBe(true);
    const rows = await owner.typeRows(run.id);
    expect(rows.find(x => x.workLog.id === zero.id)).toMatchObject({ excluded: false, workLog: { state: 'active', minutes: 0 } });
    expect(rows.find(x => x.workLog.id === voided.id)).toMatchObject({ excluded: true, workLog: { state: 'void', revisionId: voided.revisionId } });
    expect(run.membershipIds.sort()).toEqual([M.teamOwner, M.teamMemberA].sort());
    const noSources = await owner.typeReport({ periodId: f.week.id, membershipIds: [M.teamMemberB] });
    expect(noSources).toMatchObject({ totalActualMinutes: 0, activeSourceCount: 0, rowCount: 0 });
    expect(noSources.byCategory).toEqual([]);
  });

  it('pins category labels on the source, groups by stable option identity and keeps newer bucket labels after old-hours correction', async () => {
    const f = await fixture('Историческая подпись категории');
    const oldTask = await planningTask(owner, f.project, 120);
    await value(oldTask, f.field, f.a.id);
    const old = await owner.setWork(oldTask.id, f.week.id, M.teamOwner, { expectedRevision: null, minutes: 60 });
    expect(old.category).toMatchObject({ kind: 'categorized', fieldId: f.field.id, optionId: f.a.id, optionLabel: f.a.name });
    const pinned = await owner.typeReport({ periodId: f.week.id });
    const pinnedRows = await owner.typeRows(pinned.id);
    const renamed = await owner.updateOption(f.field.id, f.a.id, { expectedRevision: f.field.revision, name: 'Развитие продукта', color: '#e11d48' });
    const newTask = await planningTask(owner, f.project, 120);
    await value(newTask, renamed, f.a.id);
    const newer = await owner.setWork(newTask.id, f.week.id, M.teamOwner, { expectedRevision: null, minutes: 30 });
    expect(newer.category).toMatchObject({ optionId: f.a.id, optionLabel: 'Развитие продукта', color: '#e11d48' });
    await value(oldTask, renamed, f.b.id);
    const correction = await owner.setWork(oldTask.id, f.week.id, M.teamOwner, { expectedRevision: old.revision, minutes: 90, reason: 'Уточнение часов без смены типа' });
    expect(correction.category).toEqual(old.category);
    const fresh = await owner.typeReport({ periodId: f.week.id });
    expect(fresh.byCategory).toHaveLength(1);
    expect(fresh.byCategory[0]).toMatchObject({ optionId: f.a.id, label: 'Развитие продукта', color: '#e11d48', minutes: 120, sharePercent: 100 });
    expect(await replica.getTypeReport(pinned.id)).toEqual(pinned);
    expect(await replica.typeRows(pinned.id)).toEqual(pinnedRows);
    const binding = await owner.binding(f.project.id);
    const key = randomUUID(); const input = { expectedWorkLogRevision: correction.revision, expectedBindingRevision: binding.revision, optionId: f.b.id, reason: 'Явная переклассификация работы' };
    const changed = await owner.recategorize(old.id, input, key);
    expect(changed).toMatchObject({ id: old.id, sourceKey: old.sourceKey, minutes: 90, revision: correction.revision + 1, category: { optionId: f.b.id } });
    const after = await databaseSnapshot(h.db.sql);
    expect(await replica.recategorize(old.id, input, key)).toEqual(changed);
    expect(await databaseSnapshot(h.db.sql)).toEqual(after);
    expectError(await owner.post(`/worklogs/${newer.id}/recategorize`, input, key), 409, 'IDEMPOTENCY_KEY_REUSED');
    expectError(await owner.post(`/worklogs/${old.id}/recategorize`, input), 409, 'REVISION_CONFLICT');
    const noopBefore = await databaseSnapshot(h.db.sql);
    const noop = await owner.recategorize(old.id, { ...input, expectedWorkLogRevision: changed.revision, reason: 'Та же категория, без новой версии' });
    expect(noop).toEqual(changed);
    const noopAfter = await databaseSnapshot(h.db.sql);
    expect(changedTables(noopBefore, noopAfter)).toEqual(['command_idempotency']);
    expect(rowDelta(noopBefore, noopAfter).command_idempotency).toBe(1);
    expect(noopAfter.changeSeq).toEqual(noopBefore.changeSeq);
  });

  it('returns valid CSV task cells and complete package totals including unloaded detail sources, with exact worker/source counts', async () => {
    const f = await fixture('Проекция видимых строк');
    const root = await planningTask(owner, f.project, 480);
    const detail = await owner.tasks.createTask({ projectId: f.project.id, parentTaskId: root.id, workScope: 'detail', statusId: f.todo.id, title: 'Незагруженная детализация' });
    const commitment = await owner.createCommitment(f.week.id, { workPackageId: root.workPackageId, membershipId: M.teamOwner, expectedAbsent: true, plannedMinutes: 120, allocations: [{ taskId: detail.id, minutes: 60 }] });
    const own = await owner.setWork(root.id, f.week.id, M.teamOwner, { expectedRevision: null, minutes: 60 });
    await owner.setWork(root.id, f.week.id, M.teamMemberA, { expectedRevision: null, minutes: 15 });
    const child = await owner.setWork(detail.id, f.week.id, M.teamOwner, { expectedRevision: null, minutes: 30 });
    const before = await databaseSnapshot(h.db.sql);
    const summary = await owner.timeSummary(f.project.id, f.week.id, [root.id.toUpperCase()]);
    expect(summary).toMatchObject({ subjectMembershipId: M.teamOwner, tasks: [{ taskId: root.id, currentAllocationMinutes: null, subjectActualMinutes: 60, taskActualMinutes: 75, subjectActiveSourceCount: 1, taskActiveSourceCount: 2, hasOtherSources: false, ownManualWork: { id: own.id } }] });
    expect(summary.packages).toHaveLength(1);
    expect(summary.packages[0]).toMatchObject({ workPackageId: root.workPackageId, commitment: { id: commitment.id, unallocatedMinutes: 60 }, subjectActualMinutes: 90, totalActualMinutes: 105, subjectActiveSourceCount: 2, totalActiveSourceCount: 3 });
    expect(await databaseSnapshot(h.db.sql)).toEqual(before);
    const both = await owner.timeSummary(f.project.id, f.week.id, [detail.id, root.id]);
    expect(both.tasks).toHaveLength(2); expect(both.packages).toHaveLength(1);
    expect(both.tasks.find(x => x.taskId === detail.id)?.currentAllocationMinutes).toBe(60);
    const colleague = await member.timeSummary(f.project.id, f.week.id, [root.id]);
    expect(colleague).toMatchObject({ subjectMembershipId: M.teamMemberA, tasks: [{ subjectActualMinutes: 15, taskActualMinutes: 75 }] });
    expect(colleague.packages[0]).toMatchObject({ subjectActualMinutes: 15, totalActualMinutes: 105 });
    const voided = await owner.setWork(detail.id, f.week.id, M.teamOwner, { expectedRevision: child.revision, minutes: 30, state: 'void', reason: 'Отменена ошибочная детализация' });
    const voidSummary = await owner.timeSummary(f.project.id, f.week.id, [detail.id]);
    expect(voidSummary.tasks[0]).toMatchObject({ subjectActualMinutes: 0, taskActualMinutes: 0, subjectActiveSourceCount: 0, taskActiveSourceCount: 0, hasOtherSources: false, ownManualWork: { id: voided.id, state: 'void', revision: voided.revision } });
    await owner.setWork(root.id, f.week.id, M.teamOwner, { expectedRevision: own.revision, minutes: 0, reason: 'Подтверждён нулевой итог' });
    const zeroSummary = await owner.timeSummary(f.project.id, f.week.id, [root.id]);
    expect(zeroSummary.tasks[0]).toMatchObject({ subjectActualMinutes: 0, subjectActiveSourceCount: 1, ownManualWork: { state: 'active', minutes: 0 } });
    expect(zeroSummary.packages[0]).toMatchObject({ subjectActualMinutes: 0, totalActualMinutes: 15, totalActiveSourceCount: 2 });
    for (const bad of ['', `${root.id},${root.id}`, JSON.stringify([root.id]), 'not-an-id']) {
      expectError(await owner.get(`/projects/${f.project.id}/periods/${f.week.id}/task-time-summary?taskIds=${encodeURIComponent(bad)}`), 400, 'VALIDATION_FAILED');
    }
    const other = await planningProject(owner, 'Несовместимый проект');
    const otherTask = await planningTask(owner, other.project);
    expectError(await owner.get(owner.summaryPath(f.project.id, f.week.id, [root.id, otherTask.id])), 422, 'DOMAIN_VALIDATION_FAILED');
    const external = await planningProject(outsider, 'Чужая проекция');
    const externalTask = await planningTask(outsider, external.project);
    expectError(await owner.get(owner.summaryPath(f.project.id, f.week.id, [root.id, externalTask.id])), 404, 'NOT_FOUND', [externalTask.title]);
    expectError(await owner.get(owner.summaryPath(f.project.id, f.week.id, [root.id], M.outsideOwner)), 404, 'NOT_FOUND');
  });

  it('preserves retained archived category references, and makes clear/rebind/archive affect only genuinely new sources', async () => {
    const f = await fixture('Настройка без переписывания факта');
    const oldTask = await planningTask(owner, f.project, 120);
    await value(oldTask, f.field, f.a.id);
    const archived = await owner.updateOption(f.field.id, f.a.id, { expectedRevision: f.field.revision, archived: true });
    const retained = await owner.setWork(oldTask.id, f.week.id, M.teamOwner, { expectedRevision: null, minutes: 60 });
    expect(retained.category).toMatchObject({ kind: 'categorized', optionId: f.a.id, optionArchivedAt: expect.any(String) });
    const freshTask = await planningTask(owner, f.project, 120);
    await value(freshTask, archived, f.b.id);
    const other = await owner.setWork(freshTask.id, f.week.id, M.teamOwner, { expectedRevision: null, minutes: 30 });
    expectError(await owner.post(`/worklogs/${other.id}/recategorize`, { expectedWorkLogRevision: other.revision, expectedBindingRevision: f.binding.revision, optionId: f.a.id, reason: 'Новое назначение архива' }), 422, 'DOMAIN_VALIDATION_FAILED');
    const beforeRun = await owner.typeReport({ periodId: f.week.id });
    const cleared = await owner.bind(f.project.id, { expectedRevision: f.binding.revision, fieldId: null });
    const corrected = await owner.setWork(oldTask.id, f.week.id, M.teamOwner, { expectedRevision: retained.revision, minutes: 90, reason: 'Часы после снятия настройки' });
    expect(corrected.category).toEqual(retained.category);
    const unboundTask = await planningTask(owner, f.project);
    const unbound = await owner.setWork(unboundTask.id, f.week.id, M.teamOwner, { expectedRevision: null, minutes: 20 });
    expect(unbound.category).toMatchObject({ kind: 'uncategorized', reason: 'unbound' });
    const rebound = await owner.bind(f.project.id, { expectedRevision: cleared.revision, fieldId: f.field.id });
    const missingTask = await planningTask(owner, f.project);
    const missing = await owner.setWork(missingTask.id, f.week.id, M.teamOwner, { expectedRevision: null, minutes: 10 });
    expect(missing.category).toMatchObject({ kind: 'uncategorized', reason: 'unset' });
    const field = await owner.updateField(f.field.id, { expectedRevision: archived.revision, archived: true });
    expect(field.archivedAt).not.toBeNull();
    expect(await owner.binding(f.project.id)).toMatchObject({ revision: rebound.revision, fieldId: f.field.id, availability: 'field_archived' });
    const unavailableTask = await planningTask(owner, f.project);
    const unavailable = await owner.setWork(unavailableTask.id, f.week.id, M.teamOwner, { expectedRevision: null, minutes: 5 });
    expect(unavailable.category).toMatchObject({ kind: 'uncategorized', reason: 'field_unavailable', fieldId: f.field.id });
    expect(await owner.getTypeReport(beforeRun.id)).toEqual(beforeRun);
  });

  it('checks worklog/binding revisions and worker rights, then replays only under current ACL with pinned tenant isolation', async () => {
    const f = await fixture('Права и повтор классификации');
    const task = await planningTask(owner, f.project);
    await value(task, f.field, f.a.id);
    const log = await owner.setWork(task.id, f.week.id, M.teamOwner, { expectedRevision: null, minutes: 60 });
    const body = { expectedWorkLogRevision: log.revision, expectedBindingRevision: f.binding.revision, optionId: f.b.id, reason: 'Обоснованная смена типа' };
    expectError(await member.post(`/worklogs/${log.id}/recategorize`, body), 403, 'CAPABILITY_REQUIRED');
    expectError(await viewer.post(`/worklogs/${log.id}/recategorize`, body), 403, 'CAPABILITY_REQUIRED');
    expectError(await owner.post(`/worklogs/${log.id}/recategorize`, { ...body, expectedBindingRevision: body.expectedBindingRevision + 1 }), 409, 'REVISION_CONFLICT');
    expectError(await owner.post(`/worklogs/${log.id}/recategorize`, { ...body, reason: ' ' }), 400, 'VALIDATION_FAILED');
    const wrongField = await owner.createField({ projectId: f.project.id, name: 'Другая классификация', type: 'single_select', options: [{ name: 'Другой вариант' }] });
    const wrongOption = wrongField.options[0];
    if (!wrongOption) throw new Error('Other field requires an option.');
    expectError(await owner.post(`/worklogs/${log.id}/recategorize`, { ...body, optionId: wrongOption.id }), 422, 'DOMAIN_VALIDATION_FAILED');
    const outsideProject = await planningProject(outsider, 'Другой workspace категорий');
    const outsideField = await outsider.createField({ projectId: outsideProject.project.id, name: 'Чужой тип', type: 'single_select', options: [{ name: 'Скрытый вариант' }] });
    const outsideOption = outsideField.options[0];
    if (!outsideOption) throw new Error('Outside field requires an option.');
    expectError(await owner.post(`/worklogs/${log.id}/recategorize`, { ...body, optionId: outsideOption.id }), 404, 'NOT_FOUND', [outsideField.name, outsideOption.name]);
    const key = randomUUID(); const changed = await owner.recategorize(log.id, body, key);
    const pinned = await owner.typeReport({ periodId: f.week.id });
    const memberBefore = await membershipRow(h.db.sql, TEAM, M.teamOwner);
    await revokeMembership(h.db.sql, TEAM, M.teamOwner);
    try {
      const denied = await databaseSnapshot(h.db.sql);
      expectError(await owner.post(`/worklogs/${log.id}/recategorize`, body, key), 404, 'NOT_FOUND');
      expectError(await owner.get(`/work-type-report-runs/${pinned.id}`), 404, 'NOT_FOUND');
      expectError(await owner.get(`/work-type-report-runs/${pinned.id}/rows`), 404, 'NOT_FOUND');
      expect(await databaseSnapshot(h.db.sql)).toEqual(denied);
    } finally { await restoreMembership(h.db.sql, TEAM, M.teamOwner, memberBefore); }
    expect(await owner.recategorize(log.id, body, key)).toEqual(changed);
    const foreign = new P2bClient(h.outsider.api, TEAM);
    expectError(await foreign.get(`/work-type-report-runs/${pinned.id}`), 404, 'NOT_FOUND', [task.title, f.a.name]);
    expectError(await foreign.get(owner.summaryPath(f.project.id, f.week.id, [task.id])), 404, 'NOT_FOUND', [task.title]);
  });

  it('atomically rolls back a late SQL fault after recategorization and resolves concurrent same-revision commands once', async () => {
    const f = await fixture('Транзакция классификации');
    const task = await planningTask(owner, f.project);
    await value(task, f.field, f.a.id);
    const log = await owner.setWork(task.id, f.week.id, M.teamOwner, { expectedRevision: null, minutes: 60 });
    const body = { expectedWorkLogRevision: log.revision, expectedBindingRevision: f.binding.revision, optionId: f.b.id, reason: 'Исправление классификации источника' };
    await h.db.sql.unsafe("create function qa_category_late_fault() returns trigger language plpgsql as $$ begin raise exception 'synthetic category late fault'; end $$");
    await h.db.sql.unsafe('create trigger qa_category_late_fault before insert on command_idempotency for each row execute function qa_category_late_fault()');
    const before = await databaseSnapshot(h.db.sql); const key = randomUUID();
    try {
      expectError(await owner.post(`/worklogs/${log.id}/recategorize`, body, key), 500, 'INTERNAL_ERROR', ['synthetic category late fault']);
      expect(await databaseSnapshot(h.db.sql)).toEqual(before);
    } finally {
      await h.db.sql.unsafe('drop trigger qa_category_late_fault on command_idempotency');
      await h.db.sql.unsafe('drop function qa_category_late_fault()');
    }
    const results = await Promise.all([
      owner.post(`/worklogs/${log.id}/recategorize`, body, key),
      replica.post(`/worklogs/${log.id}/recategorize`, { ...body, optionId: null }),
    ]);
    expect(results.map(x => x.status).sort()).toEqual([200, 409]);
    const success = results.find(x => x.status === 200);
    if (!success) throw new Error('One real concurrent category write must succeed.');
    const changed = expectEnvelope(success, 200, categorizedWorkLogResponseSchema).data;
    expect(changed).toMatchObject({ id: log.id, revision: log.revision + 1, minutes: 60 });
    const rows = await h.db.sql<{ count: string }[]>`select count(*)::text as count from work_log_revisions where work_log_id=${log.id}`;
    expect(rows[0]?.count).toBe('2');
  });


  it('rejects malformed category SQL snapshots and mutation/deletion/truncation of immutable revisions and reports', async () => {
    const f = await fixture('SQL история категории');
    const task = await planningTask(owner, f.project);
    await value(task, f.field, f.a.id);
    const log = await owner.setWork(task.id, f.week.id, M.teamOwner, { expectedRevision: null, minutes: 60 });
    const run = await owner.typeReport({ periodId: f.week.id });
    const [saved] = await h.db.sql<{ category: Record<string, unknown> }[]>`select category from work_log_revisions where id=${log.revisionId}`;
    if (!saved?.category) throw new Error('New real source must persist a category snapshot.');
    const valid = saved.category;
    const without = (key: string) => Object.fromEntries(Object.entries(valid).filter(([name]) => name !== key));
    const malformed = [without('kind'), without('fieldId'), without('optionLabel'), { ...valid, kind: 'invented' }, { ...valid, optionRevision: 0 }, { ...valid, optionId: randomUUID() }];
    const before = await databaseSnapshot(h.db.sql);
    for (const category of malformed) {
      const error: unknown = await h.db.sql`
        insert into work_log_revisions (
          id,workspace_id,work_log_id,revision,minutes,state,reason,actor_user_id,recorded_at,change_seq,
          category,category_project_id,category_binding_version_id,category_binding_revision,category_field_id,category_definition_version_id,category_option_id,category_option_revision
        ) select ${randomUUID()},workspace_id,work_log_id,revision+1,minutes,state,'Synthetic malformed category',actor_user_id,recorded_at,change_seq+1,
          ${JSON.stringify(category)}::text::jsonb,category_project_id,category_binding_version_id,category_binding_revision,category_field_id,category_definition_version_id,category_option_id,category_option_revision
        from work_log_revisions where id=${log.revisionId}`.then(() => null, (e: unknown) => e);
      expect(error).toMatchObject({ code: '23514' });
      expect(await databaseSnapshot(h.db.sql)).toEqual(before);
    }
    for (const table of ['project_work_category_binding_versions', 'work_log_revisions', 'work_type_report_runs']) {
      const predicate = table === 'project_work_category_binding_versions' ? `id='${f.binding.versionId}'` : table === 'work_log_revisions' ? `id='${log.revisionId}'` : `id='${run.id}'`;
      for (const statement of [`update ${table} set id=id where ${predicate}`, `delete from ${table} where ${predicate}`, `truncate table ${table} cascade`]) {
        const error: unknown = await h.db.sql.unsafe(statement).then(() => null, (e: unknown) => e);
        expect(error).toMatchObject({ code: '42501' });
        expect(await databaseSnapshot(h.db.sql)).toEqual(before);
      }
    }
  });

});
