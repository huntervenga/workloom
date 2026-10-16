// P2a black-box acceptance on actual API processes and PostgreSQL. Auth is synthetic/local;
// snapshots/reports are real persisted DTOs, never mocked calculation fixtures.
import { randomUUID } from 'node:crypto';

import { manualPeriodWorkLogResponseSchema, planBaselineResponseSchema, projectColumnsResponseSchema, taskFieldDefinitionResponseSchema, taskFieldValueResponseSchema, weeklyPlanFactRowListResponseSchema, type TaskDto } from '@workloom/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { expectEnvelope, expectError, uniqueName } from './support/p1a.js';
import { databaseSnapshot, devSessionCookie, membershipRow, restoreMembership, revokeMembership } from './support/p1b.js';
import { commit, MEMBERS as M, period, planningHarness, planningProject, planningTask, TEAM, USERS, type PlanningHarness } from './support/p2a-fixture.js';
import { P2aClient } from './support/p2a.js';
import { requireTestDatabaseUrl } from './support/test-database-url.js';

requireTestDatabaseUrl();

describe('P2a planning, period facts and pinned reports over HTTP on PostgreSQL', () => {
  let h: PlanningHarness;
  beforeAll(async () => { h = await planningHarness('p2a_http'); });
  afterAll(async () => { await h?.close(); });

  it('deduplicates detail facts/tags/participants:480→600,+120/+25%, while added240 stays separate and open work remains in cohort', async () => {
    const { owner } = h;
    const { project, todo, done } = await planningProject(owner, 'Исходный и добавленный объём');
    const tagA = await owner.tasks.createTag({ name: uniqueName('Пилот'), color: null });
    const tagB = await owner.tasks.createTag({ name: uniqueName('Проверка'), color: null });
    const root = await owner.tasks.createTask({ projectId: project.id, statusId: done.id, title: 'Исходные восемь часов', estimateMinutes: 480,
      participantMembershipIds: [M.teamOwner, M.teamMemberA], tagIds: [tagA.id, tagB.id] });
    const child = await owner.tasks.createTask({ projectId: project.id, parentTaskId: root.id, statusId: todo.id,
      title: 'Детализация исходной работы', workScope: 'detail', participantMembershipIds: [M.teamOwner, M.teamMemberA], tagIds: [tagA.id, tagB.id] });
    expect(child.workPackageId).toBe(root.workPackageId);
    const oldUnplanned = await planningTask(owner, project, 60, 'Существовавшая работа без исходного плана');
    const week = await period(owner, project.id);
    const original = await commit(owner, week, root, 480);
    const baseline = await owner.freeze(week.id);
    const first = await owner.setWork(root.id, week.id, M.teamOwner, { expectedRevision: null, minutes: 180 });
    const second = await owner.setWork(child.id, week.id, M.teamOwner, { expectedRevision: null, minutes: 420 });
    const added = await owner.tasks.createTask({ projectId: project.id, parentTaskId: root.id, statusId: todo.id,
      title: 'Новая дополнительная работа', workScope: 'added_scope', estimateMinutes: 300 });
    const extra = await commit(owner, week, added, 300);
    expect(extra.classification).toBe('added');
    const addedFact = await owner.setWork(added.id, week.id, M.teamOwner, { expectedRevision: null, minutes: 240 });
    const run = await owner.report({ baselineId: baseline.id });
    expect(run.summary).toMatchObject({ knownPlannedMinutes: 480, actualMinutes: 600,
      totalVarianceMinutes: 120, totalVariancePercent: 25, addedActualMinutes: 240, unplannedActualMinutes: 0, totalActualMinutes: 840 });
    expect(run.cohort).toEqual({ originalItemCount: 1, selectedItemCount: 1 });
    const rows = await owner.reportRows(run.id);
    const row = rows.find((item) => item.commitmentId === original.id);
    expect(row).toMatchObject({ scope: 'original', plannedMinutes: 480, actualMinutes: 600, packageEstimateMinutes: 480 });
    expect(row?.taskIds).toEqual(expect.arrayContaining([root.id, child.id]));
    expect(row?.workLogs.map((log) => log.id).sort()).toEqual([first.id, second.id].sort());
    expect(rows.find((item) => item.workPackageId === added.workPackageId)).toMatchObject({ scope: 'added_scope', actualMinutes: 240 });
    expect(run.workLogRevisionIds.sort()).toEqual([first.revisionId, second.revisionId, addedFact.revisionId].sort());
    expect(run.byPerson.find((item) => item.membershipId === M.teamOwner)?.summary).toEqual(run.summary);
    for (const person of run.byPerson.filter((item) => item.membershipId !== M.teamOwner)) {
      expect(person.summary.totalActualMinutes).toBe(0);
      expect(person.summary.baselineCompleteness.totalItemCount).toBe(0);
    }
    expect((await owner.packages(project.id)).filter((item) => item.id === root.workPackageId)).toHaveLength(1);
    await owner.setWork(oldUnplanned.id, week.id, M.teamOwner, { expectedRevision: null, minutes: 60 });
    const withUnplanned = await owner.report({ baselineId: baseline.id });
    expect(withUnplanned.summary).toMatchObject({ actualMinutes: 600, addedActualMinutes: 240, unplannedActualMinutes: 60, totalActualMinutes: 900 });
    expect((await owner.reportRows(withUnplanned.id)).find((item) => item.workPackageId === oldUnplanned.workPackageId)?.scope).toBe('unplanned');
    expect(await owner.getReport(run.id)).toEqual(run);
  });

  it('compares the weekly360 to300 independently of whole1200 and pins the old fact revision after a correction', async () => {
    const { owner, replica } = h;
    const { project } = await planningProject(owner, 'Недельный и полный план');
    const task = await planningTask(owner, project, 1200);
    const week = await period(owner, project.id);
    await commit(owner, week, task, 360);
    const baseline = await owner.freeze(week.id);
    const fact = await owner.setWork(task.id, week.id, M.teamOwner, { expectedRevision: null, minutes: 300 });
    expect(fact).toMatchObject({ precision: 'period', sourceKind: 'manual_period', reason: null });
    expect(Object.keys(fact)).not.toContain('workDate');
    const wireLogs = (await owner.get(`/worklogs?periodId=${week.id}`)).json() as { data: Record<string, unknown>[] };
    for (const log of wireLogs.data) expect(log).not.toHaveProperty('workDate');
    const original = await owner.report({ baselineId: baseline.id });
    expect(original.summary).toMatchObject({ knownPlannedMinutes: 360, actualMinutes: 300, totalVarianceMinutes: -60 });
    const rows = await replica.reportRows(original.id);
    expect(rows[0]).toMatchObject({ packageEstimateMinutes: 1200, plannedMinutes: 360, actualMinutes: 300 });
    const correction = await owner.setWork(task.id, week.id, M.teamOwner, { expectedRevision: fact.revision, minutes: 360, reason: 'Уточнён недельный итог' });
    expect(correction).toMatchObject({ id: fact.id, revision: fact.revision + 1, sourceKey: fact.sourceKey, precision: 'period' });
    expect(correction.revisionId).not.toBe(fact.revisionId);
    expect(await replica.getReport(original.id)).toEqual(original);
    expect(await replica.reportRows(original.id)).toEqual(rows);
    const current = await owner.report({ baselineId: baseline.id });
    expect(current.summary).toMatchObject({ actualMinutes: 360, totalVarianceMinutes: 0 });
    expect(original.workLogRevisionIds).toContain(fact.revisionId);
    expect(current.workLogRevisionIds).toContain(correction.revisionId);
    expect(current.workLogRevisionIds).not.toContain(fact.revisionId);
  });

  it('keeps unknown plans and missing/zero/void facts distinct, including an explicitly labelled known-estimate subset', async () => {
    const { owner } = h;
    const { project } = await planningProject(owner, 'Пропуски и подтверждённый ноль');
    const a = await planningTask(owner, project, 120);
    const b = await planningTask(owner, project, null);
    const week = await period(owner, project.id);
    await commit(owner, week, a, 120);
    await commit(owner, week, b, null);
    const baseline = await owner.freeze(week.id);
    await owner.setWork(a.id, week.id, M.teamOwner, { expectedRevision: null, minutes: 120 });
    await owner.setWork(b.id, week.id, M.teamOwner, { expectedRevision: null, minutes: 60 });
    const run = await owner.report({ baselineId: baseline.id });
    expect(run.summary).toMatchObject({ knownPlannedMinutes: 120, actualMinutes: 180, missingEstimateCount: 1,
      totalVarianceMinutes: null, totalVariancePercent: null, baselineCompleteness: { knownItemCount: 1, totalItemCount: 2, ratio: 0.5, complete: false } });
    const subset = await owner.report({ baselineId: baseline.id, knownEstimatesOnly: true });
    expect(subset.knownEstimatesOnly).toBe(true);
    expect(subset.cohort).toEqual({ selectedItemCount: 1, originalItemCount: 2 });
    expect(subset.summary).toMatchObject({ knownPlannedMinutes: 120, actualMinutes: 120, totalVarianceMinutes: 0 });

    const { project: zeroProject } = await planningProject(owner, 'Нулевой план');
    const zero = await planningTask(owner, zeroProject, 0);
    const zeroWeek = await period(owner, zeroProject.id);
    await commit(owner, zeroWeek, zero, 0);
    const zeroBaseline = await owner.freeze(zeroWeek.id);
    const missing = await owner.report({ baselineId: zeroBaseline.id });
    expect(missing.summary.factCoverage).toMatchObject({ recordedItemCount: 0, totalItemCount: 1, complete: false });
    expect(missing.summary.totalVarianceMinutes).toBeNull();
    const confirmed = await owner.setWork(zero.id, zeroWeek.id, M.teamOwner, { expectedRevision: null, minutes: 0 });
    const complete = await owner.report({ baselineId: zeroBaseline.id });
    expect(complete.summary).toMatchObject({ actualMinutes: 0, totalVarianceMinutes: 0, totalVariancePercent: null,
      factCoverage: { recordedItemCount: 1, totalItemCount: 1, complete: true } });
    await owner.setWork(zero.id, zeroWeek.id, M.teamOwner, { expectedRevision: confirmed.revision, minutes: 0, state: 'void', reason: 'Ноль был введён ошибочно' });
    const voidRun = await owner.report({ baselineId: zeroBaseline.id });
    expect(voidRun.summary.factCoverage).toMatchObject({ recordedItemCount: 0, complete: false });
    expect(voidRun.summary.totalVarianceMinutes).toBeNull();
    expect((await owner.workLogs(zeroWeek.id))[0]).toMatchObject({ id: confirmed.id, state: 'void', revision: confirmed.revision + 1 });
  });

  it('refuses stale freeze previews after actual source edits and preserves snapshot labels and selected value identity', async () => {
    const { owner } = h;
    const { project } = await planningProject(owner, 'Свежесть источников фиксации');
    let task = await planningTask(owner, project, 480);
    const field = await owner.createField({ projectId: project.id, name: 'Исходное поле', type: 'text' });
    const week = await period(owner, project.id, { protectedFieldIds: [field.id] });
    await commit(owner, week, task, 480);
    let preview = await owner.preview(week.id);
    task = await owner.tasks.updateTask(task.id, { expectedRevision: task.revision, title: 'Новое имя до фиксации' });
    let before = await databaseSnapshot(h.db.sql);
    expectError(await owner.freezeRequest(week.id, 'project', preview.previewHash), 409, 'PREVIEW_STALE');
    expect(await databaseSnapshot(h.db.sql)).toEqual(before);
    preview = await owner.preview(week.id);
    const value = await owner.setValue(task.id, field.id, { expectedRevision: 0, expectedDefinitionRevision: field.revision, value: { type: 'text', value: 'Зафиксированное значение' } });
    before = await databaseSnapshot(h.db.sql);
    expectError(await owner.freezeRequest(week.id, 'project', preview.previewHash), 409, 'PREVIEW_STALE');
    expect(await databaseSnapshot(h.db.sql)).toEqual(before);
    preview = await owner.preview(week.id);
    await planningTask(owner, project, 30, 'Существовал до фиксации без commitment');
    before = await databaseSnapshot(h.db.sql);
    expectError(await owner.freezeRequest(week.id, 'project', preview.previewHash), 409, 'PREVIEW_STALE');
    expect(await databaseSnapshot(h.db.sql)).toEqual(before);
    preview = await owner.preview(week.id);
    const originalMember = await membershipRow(h.db.sql, TEAM, M.teamMemberB);
    try {
      await revokeMembership(h.db.sql, TEAM, M.teamMemberB);
      before = await databaseSnapshot(h.db.sql);
      expectError(await owner.freezeRequest(week.id, 'project', preview.previewHash), 409, 'PREVIEW_STALE');
      expect(await databaseSnapshot(h.db.sql)).toEqual(before);
    } finally { await restoreMembership(h.db.sql, TEAM, M.teamMemberB, originalMember); }
    const acceptedPreview = await owner.preview(week.id);
    const freezeKey = randomUUID();
    const baseline = expectEnvelope(await owner.freezeRequest(week.id, 'project', acceptedPreview.previewHash, freezeKey), 200, planBaselineResponseSchema).data;
    expect(baseline.snapshot.fieldValues.find((item) => item.taskId === task.id && item.fieldId === field.id)?.value).toEqual(value);
    await owner.tasks.updateTask(task.id, { expectedRevision: task.revision, title: 'Текущее имя после фиксации' });
    await owner.updateField(field.id, { expectedRevision: field.revision, name: 'Текущее имя поля' });
    expect(await owner.baseline(baseline.id)).toEqual(baseline);
    const frozenState = await databaseSnapshot(h.db.sql);
    expect(expectEnvelope(await owner.freezeRequest(week.id, 'project', acceptedPreview.previewHash, freezeKey), 200, planBaselineResponseSchema).data).toEqual(baseline);
    expectError(await owner.freezeRequest(week.id, 'self', acceptedPreview.previewHash, freezeKey), 409, 'IDEMPOTENCY_KEY_REUSED');
    expect(await databaseSnapshot(h.db.sql)).toEqual(frozenState);
  });

  it('retains personal-source and missing-row locks after participant removal, while default self report excludes colleagues', async () => {
    const { owner, member } = h;
    const { project } = await planningProject(owner, 'Личная фиксация');
    let task = await planningTask(owner, project, null);
    const field = await owner.createField({ projectId: project.id, name: 'Пока не заполнено', type: 'number' });
    const week = await period(owner, project.id, { protectedFieldIds: [field.id] });
    const selfCommitment = await commit(owner, week, task, 120, M.teamMemberA);
    await commit(owner, week, task, 60, M.teamOwner);
    const self = await member.freeze(week.id, 'self');
    expect(self.membershipId).toBe(M.teamMemberA);
    expect(self.snapshot.fieldValues.find((item) => item.taskId === task.id && item.fieldId === field.id)?.value).toBeNull();
    task = await owner.tasks.updateTask(task.id, { expectedRevision: task.revision,
      expectedParticipantsRevision: task.participantsRevision, participantMembershipIds: [M.teamOwner] });
    const before = await databaseSnapshot(h.db.sql);
    expectError(await owner.patch(`/tasks/${task.id}`, { expectedRevision: task.revision, expectedWorkPackageRevision: task.workPackageRevision, estimateMinutes: 480 }), 409, 'FIELD_LOCKED');
    expectError(await owner.put(owner.valuePath(task.id, field.id), { expectedRevision: 0, expectedDefinitionRevision: field.revision, value: { type: 'number', value: 1 } }), 409, 'FIELD_LOCKED');
    expectError(await member.put(`/periods/${week.id}/commitments/${selfCommitment.id}`, {
      expectedRevision: selfCommitment.revision, plannedMinutes: 121, allocations: [{ taskId: task.id, minutes: 121 }], state: 'active',
    }), 409, 'FIELD_LOCKED');
    const rejectedState = await databaseSnapshot(h.db.sql);
    expect(rejectedState.rows.command_idempotency).toBe((before.rows.command_idempotency ?? 0) + 3);
    for (const table of Object.keys(before.rowDigests)) {
      if (table !== 'command_idempotency') expect(rejectedState.rowDigests[table], table).toBe(before.rowDigests[table]);
    }
    expect(rejectedState.changeSeq).toEqual(before.changeSeq);
    await owner.setWork(task.id, week.id, M.teamMemberA, { expectedRevision: null, minutes: 120 });
    await owner.setWork(task.id, week.id, M.teamOwner, { expectedRevision: null, minutes: 60 });
    const ownRun = await owner.report({ baselineId: self.id });
    expect(ownRun.byPerson.map((item) => item.membershipId)).toEqual([M.teamMemberA]);
    expect(ownRun.summary).toMatchObject({ actualMinutes: 120, totalActualMinutes: 120, unplannedActualMinutes: 0 });
    expectError(await owner.post('/report-runs', { baselineId: self.id, membershipIds: [M.teamOwner] }), 422, 'DOMAIN_VALIDATION_FAILED');
    const global = await owner.freeze(week.id);
    expect(global.snapshot.sourcePersonalBaselineIds).toContain(self.id);
    expect(await member.baseline(self.id)).toEqual(self);
  });

  it('never upgrades an initially unknown original estimate through a later unlocked fill or another period freeze', async () => {
    const { owner } = h;
    const { project } = await planningProject(owner, 'Неизвестная исходная оценка');
    let task = await planningTask(owner, project, null);
    const firstWeek = await period(owner, project.id, { protectEstimate: false });
    await commit(owner, firstWeek, task, 60);
    const first = await owner.freeze(firstWeek.id);
    expect(first.snapshot.packages.find((item) => item.id === task.workPackageId)?.estimateMinutes).toBeNull();
    task = await owner.tasks.updateTask(task.id, { expectedRevision: task.revision, expectedWorkPackageRevision: task.workPackageRevision, estimateMinutes: 120 });
    expect(task.estimateMinutes).toBe(120);
    const nextStart = new Date(`${firstWeek.localStart}T12:00:00Z`);
    nextStart.setUTCDate(nextStart.getUTCDate() + 7);
    const secondWeek = await period(owner, project.id, { localStart: nextStart.toISOString().slice(0, 10) });
    await commit(owner, secondWeek, task, 60);
    const second = await owner.freeze(secondWeek.id);
    const pkg = (await owner.packages(project.id)).find((item) => item.id === task.workPackageId);
    expect(pkg?.packageBaselineId).toBeNull();
    const run = await owner.report({ baselineId: second.id });
    expect((await owner.reportRows(run.id))[0]).toMatchObject({ packageEstimateMinutes: null, packageBaselineId: null });
    expect(await owner.baseline(first.id)).toEqual(first);
  });

  it('uses one stable manual-period source with revisions, meaningful correction reasons and real concurrent revision guards', async () => {
    const { owner, replica } = h;
    const { project } = await planningProject(owner, 'Ревизии ручного факта');
    const task = await planningTask(owner, project, 120);
    const other = await planningTask(owner, project, 60);
    const week = await period(owner, project.id);
    const path = owner.workPath(task.id, week.id, M.teamOwner);
    const responses = await Promise.all([
      owner.put(path, { expectedRevision: null, minutes: 30 }),
      replica.put(path, { expectedRevision: null, minutes: 60 }),
    ]);
    expect(responses.map((item) => item.status).sort()).toEqual([200, 409]);
    const winner = responses.find((item) => item.status === 200);
    const loser = responses.find((item) => item.status === 409);
    if (!winner || !loser) throw new Error('Concurrent manual work responses missing.');
    const fact = expectEnvelope(winner, 200, manualPeriodWorkLogResponseSchema).data;
    expectError(loser, 409, 'REVISION_CONFLICT');
    expect(await owner.workLogs(week.id)).toEqual([fact]);
    const before = await databaseSnapshot(h.db.sql);
    expectError(await owner.put(path, { expectedRevision: fact.revision, minutes: fact.minutes + 1 }), 422, 'DOMAIN_VALIDATION_FAILED');
    expectError(await owner.put(path, { expectedRevision: fact.revision, minutes: fact.minutes, state: 'void' }), 422, 'DOMAIN_VALIDATION_FAILED');
    expectError(await owner.put(path, { expectedRevision: null, minutes: 5 }), 409, 'REVISION_CONFLICT');
    expectError(await owner.put(path, { expectedRevision: fact.revision, minutes: 5, membershipId: M.teamMemberA }), 400, 'VALIDATION_FAILED');
    expect(await databaseSnapshot(h.db.sql)).toEqual(before);
    const key = randomUUID();
    const input = { expectedRevision: fact.revision, minutes: fact.minutes + 10, reason: 'Проверен исходный учёт' };
    const corrected = await owner.setWork(task.id, week.id, M.teamOwner, input, key);
    expect(corrected).toMatchObject({ id: fact.id, sourceKey: fact.sourceKey, revision: fact.revision + 1 });
    const committed = await databaseSnapshot(h.db.sql);
    expect(await owner.setWork(task.id, week.id, M.teamOwner, input, key)).toEqual(corrected);
    expectError(await owner.put(owner.workPath(other.id, week.id, M.teamOwner), input, key), 409, 'IDEMPOTENCY_KEY_REUSED');
    expect(await databaseSnapshot(h.db.sql)).toEqual(committed);
    const noop = await owner.setWork(task.id, week.id, M.teamOwner, { expectedRevision: corrected.revision, minutes: corrected.minutes });
    expect(noop).toEqual(corrected);
    const afterNoop = await databaseSnapshot(h.db.sql);
    expect(afterNoop.rows.command_idempotency).toBe((committed.rows.command_idempotency ?? 0) + 1);
    for (const table of Object.keys(committed.rowDigests)) {
      if (table !== 'command_idempotency') expect(afterNoop.rowDigests[table], table).toBe(committed.rowDigests[table]);
    }
  });

  it('pages every pinned report row without duplication while summaries cover the full cohort and cursors retain current actor binding', async () => {
    const { owner } = h;
    const { project } = await planningProject(owner, 'Полный отчёт и страницы');
    const week = await period(owner, project.id);
    const tasks: TaskDto[] = [];
    for (let index = 0; index < 7; index++) {
      const task = await planningTask(owner, project, 60, `Работа ${index + 1}`);
      tasks.push(task);
      await commit(owner, week, task, 60);
    }
    const baseline = await owner.freeze(week.id);
    for (const task of tasks) await owner.setWork(task.id, week.id, M.teamOwner, { expectedRevision: null, minutes: 30 });
    const run = await owner.report({ baselineId: baseline.id });
    expect(run).toMatchObject({ rowCount: 7, cohort: { selectedItemCount: 7, originalItemCount: 7 } });
    expect(run.summary).toMatchObject({ knownPlannedMinutes: 420, actualMinutes: 210, totalVarianceMinutes: -210, totalVariancePercent: -50 });
    expect(run.byPerson.find((item) => item.membershipId === M.teamOwner)?.summary).toEqual(run.summary);
    for (const person of run.byPerson.filter((item) => item.membershipId !== M.teamOwner)) {
      expect(person.summary.totalActualMinutes).toBe(0);
      expect(person.summary.baselineCompleteness.totalItemCount).toBe(0);
    }
    const rows = await owner.reportRows(run.id, 2);
    expect(rows).toHaveLength(7);
    expect(new Set(rows.map((row) => row.id)).size).toBe(7);
    expect(rows.map((row) => row.workPackageId).sort()).toEqual(tasks.map((task) => task.workPackageId).sort());
    const first = await owner.page(`/report-runs/${run.id}/rows`, weeklyPlanFactRowListResponseSchema, { limit: 2 });
    expect(first.items).toHaveLength(2);
    expect(first.nextCursor).not.toBeNull();
    const other = await owner.report({ baselineId: baseline.id });
    expectError(await owner.get(`/report-runs/${other.id}/rows?limit=2&cursor=${encodeURIComponent(first.nextCursor ?? '')}`), 400, 'VALIDATION_FAILED');
    // Same process/signing secret; a different actor's cookie is the only context change.
    const session = await devSessionCookie(owner.api, USERS.viewer);
    const sameProcessViewer = new P2aClient(owner.api, TEAM, session.cookie);
    expectError(await sameProcessViewer.get(`/report-runs/${run.id}/rows?limit=2&cursor=${encodeURIComponent(first.nextCursor ?? '')}`), 400, 'VALIDATION_FAILED');
    expect((await sameProcessViewer.reportRows(run.id)).map((row) => row.id)).toEqual(rows.map((row) => row.id));
  });

  it('checks self/others permissions, current replay access and foreign period/package/report scope without writes or labels leaking', async () => {
    const { owner, member, viewer, outsider } = h;
    const { project } = await planningProject(owner, 'Права недельного цикла');
    const task = await planningTask(owner, project, 60);
    const week = await period(owner, project.id);
    await commit(owner, week, task, 60);
    const baseline = await owner.freeze(week.id);
    const key = randomUUID();
    const body = { expectedRevision: null, minutes: 60 };
    const fact = await owner.setWork(task.id, week.id, M.teamOwner, body, key);
    const run = await owner.report({ baselineId: baseline.id });
    const foreignProject = await planningProject(outsider, 'Секрет чужого пространства');
    const foreignTask = await planningTask(outsider, foreignProject.project, 60);
    const foreignWeek = await period(outsider, foreignProject.project.id);
    await commit(outsider, foreignWeek, foreignTask, 60, M.outsideOwner);
    const foreignBaseline = await outsider.freeze(foreignWeek.id);
    const foreignRun = await outsider.report({ baselineId: foreignBaseline.id });
    const before = await databaseSnapshot(h.db.sql);
    expectError(await member.put(owner.workPath(task.id, week.id, M.teamOwner), { expectedRevision: fact.revision, minutes: 1, reason: 'Запрещённая чужая запись' }), 403, 'CAPABILITY_REQUIRED');
    expectError(await viewer.put(owner.workPath(task.id, week.id, M.teamViewer), body), 403, 'CAPABILITY_REQUIRED');
    expectError(await member.post('/periods', { projectId: project.id, name: 'Нельзя', localStart: week.localStart, timezone: week.timezone, cutoffAt: week.cutoffAt }), 403, 'CAPABILITY_REQUIRED');
    expectError(await member.post(`/periods/${week.id}/freeze-preview`, { scope: 'project' }, null), 403, 'CAPABILITY_REQUIRED');
    for (const path of [`/periods/${foreignWeek.id}`, `/baselines/${foreignBaseline.id}`, `/report-runs/${foreignRun.id}`, `/report-runs/${foreignRun.id}/rows`, `/worklogs?periodId=${foreignWeek.id}`]) {
      expectError(await owner.get(path), 404, 'NOT_FOUND', [foreignProject.project.name, foreignTask.title]);
    }
    expectError(await owner.post(`/periods/${week.id}/commitments`, { workPackageId: foreignTask.workPackageId, membershipId: M.teamOwner, expectedAbsent: true, plannedMinutes: 60 }), 404, 'NOT_FOUND');
    expectError(await owner.put(owner.workPath(foreignTask.id, week.id, M.teamOwner), body), 404, 'NOT_FOUND');
    expect(await databaseSnapshot(h.db.sql)).toEqual(before);
    const original = await membershipRow(h.db.sql, TEAM, M.teamOwner);
    try {
      await revokeMembership(h.db.sql, TEAM, M.teamOwner);
      const revoked = await databaseSnapshot(h.db.sql);
      expectError(await owner.put(owner.workPath(task.id, week.id, M.teamOwner), body, key), 404, 'NOT_FOUND');
      expectError(await owner.get(`/baselines/${baseline.id}`), 404, 'NOT_FOUND');
      expectError(await owner.get(`/report-runs/${run.id}`), 404, 'NOT_FOUND');
      expectError(await owner.get(`/report-runs/${run.id}/rows`), 404, 'NOT_FOUND');
      expect(await databaseSnapshot(h.db.sql)).toEqual(revoked);
    } finally { await restoreMembership(h.db.sql, TEAM, M.teamOwner, original); }
    expect(await owner.setWork(task.id, week.id, M.teamOwner, body, key)).toEqual(fact);
  });

  it('keeps stable commitments and allocations bounded, and refuses a reparent that turns allocated siblings into ancestor/descendant', async () => {
    const { owner } = h;
    const { project, todo } = await planningProject(owner, 'Распределение без двойного учёта');
    const root = await planningTask(owner, project, 120);
    const a = await owner.tasks.createTask({ projectId: project.id, parentTaskId: root.id, statusId: todo.id, title: 'Соседняя часть A' });
    let b = await owner.tasks.createTask({ projectId: project.id, parentTaskId: root.id, statusId: todo.id, title: 'Соседняя часть B' });
    const unrelated = await planningTask(owner, project, 120);
    const week = await period(owner, project.id);
    let allocated = await owner.createCommitment(week.id, {
      workPackageId: root.workPackageId, membershipId: M.teamOwner, expectedAbsent: true,
      plannedMinutes: 120, allocations: [{ taskId: a.id, minutes: 60 }, { taskId: b.id, minutes: 60 }],
    });
    expect(allocated.unallocatedMinutes).toBe(0);
    const before = await databaseSnapshot(h.db.sql);
    expectError(await owner.patch(`/tasks/${b.id}`, { expectedRevision: b.revision, parentTaskId: a.id }), 422, 'DOMAIN_VALIDATION_FAILED');
    for (const allocations of [
      [{ taskId: a.id, minutes: 121 }],
      [{ taskId: root.id, minutes: 60 }, { taskId: a.id, minutes: 60 }],
      [{ taskId: unrelated.id, minutes: 60 }],
    ]) {
      expectError(await owner.put(`/periods/${week.id}/commitments/${allocated.id}`, {
        expectedRevision: allocated.revision, plannedMinutes: 120, allocations, state: 'active',
      }), 422, 'DOMAIN_VALIDATION_FAILED');
    }
    expect(await databaseSnapshot(h.db.sql)).toEqual(before);
    expect((await owner.tasks.getTask(b.id)).parentTaskId).toBe(root.id);
    allocated = await owner.updateCommitment(week.id, allocated.id, {
      expectedRevision: allocated.revision, plannedMinutes: 120, allocations: [{ taskId: b.id, minutes: 90 }], state: 'active',
    });
    expect(allocated.unallocatedMinutes).toBe(30);
    b = await owner.tasks.updateTask(b.id, { expectedRevision: b.revision, parentTaskId: a.id });
    expect(b.parentTaskId).toBe(a.id);
    await owner.tasks.archiveTask(b.id, b.revision);
    expect((await owner.commitments(week.id))[0]?.allocations).toEqual([{ taskId: b.id, minutes: 90 }]);
    allocated = await owner.updateCommitment(week.id, allocated.id, {
      expectedRevision: allocated.revision, plannedMinutes: 120, allocations: [], state: 'active',
    });
    const archivedState = await databaseSnapshot(h.db.sql);
    expectError(await owner.put(`/periods/${week.id}/commitments/${allocated.id}`, {
      expectedRevision: allocated.revision, plannedMinutes: 120, allocations: [{ taskId: b.id, minutes: 90 }], state: 'active',
    }), 422, 'DOMAIN_VALIDATION_FAILED');
    expect(await databaseSnapshot(h.db.sql)).toEqual(archivedState);
    const removed = await owner.updateCommitment(week.id, allocated.id, {
      expectedRevision: allocated.revision, plannedMinutes: 120, allocations: [], state: 'removed',
    });
    const removedState = await databaseSnapshot(h.db.sql);
    const duplicate = await owner.post(`/periods/${week.id}/commitments`, {
      workPackageId: root.workPackageId, membershipId: M.teamOwner, expectedAbsent: true, plannedMinutes: 120,
    });
    expect(duplicate.status, duplicate.text()).toBe(409);
    expect(await databaseSnapshot(h.db.sql)).toEqual(removedState);
    const frozenWithoutRemoved = await owner.freeze(week.id);
    expect(frozenWithoutRemoved.snapshot.commitments.some((item) => item.id === removed.id)).toBe(false);
    const restored = await owner.updateCommitment(week.id, removed.id, {
      expectedRevision: removed.revision, plannedMinutes: 120, allocations: [], state: 'active',
    });
    expect(restored).toMatchObject({ id: allocated.id, revision: removed.revision + 1, unallocatedMinutes: 120, classification: 'added' });
    expect((await owner.commitments(week.id)).map((item) => item.id)).toEqual([restored.id]);
    const restoredRun = await owner.report({ baselineId: frozenWithoutRemoved.id });
    expect(restoredRun.cohort).toEqual({ selectedItemCount: 0, originalItemCount: 0 });
    expect((await owner.reportRows(restoredRun.id)).find((item) => item.commitmentId === restored.id)).toMatchObject({ scope: 'unplanned', plannedMinutes: 120, factRecorded: false });
    expect(await owner.baseline(frozenWithoutRemoved.id)).toEqual(frozenWithoutRemoved);
  });

  it('replays durable P1b option/columns/value command keys with legacy plain-DTO cache results after planning locks exist', async () => {
    const { owner } = h;
    const { project } = await planningProject(owner, 'Совместимость прежних ключей');
    const task = await planningTask(owner, project, 120);
    const field = await owner.createField({ projectId: project.id, name: 'Прежняя колонка', type: 'single_select' });
    const optionKey = randomUUID();
    const optionBody = { expectedRevision: field.revision, name: 'Стабильный вариант' };
    const definition = expectEnvelope(await owner.post(`/fields/${field.id}/options`, optionBody, optionKey), 201, taskFieldDefinitionResponseSchema).data;
    const option = definition.options[0];
    if (!option) throw new Error('Created option missing.');
    const columns = await owner.getColumns(project.id);
    const columnsKey = randomUUID();
    const columnsBody = { expectedRevision: columns.revision, columns: columns.columns.map((item) => ({ ...item, width: 200 })) };
    const savedColumns = expectEnvelope(await owner.patch(`/projects/${project.id}/columns`, columnsBody, columnsKey), 200, projectColumnsResponseSchema).data;
    const valueKey = randomUUID();
    const valueBody = { expectedRevision: 0, expectedDefinitionRevision: definition.revision, value: { type: 'single_select', value: option.id } };
    const savedValue = expectEnvelope(await owner.put(owner.valuePath(task.id, field.id), valueBody, valueKey), 200, taskFieldValueResponseSchema).data;
    // Actual legacy DB-format fixtures, preserving real command keys/hashes generated above.
    // The accepted P1b protocol stored the DTO itself, without a tagged outcome envelope.
    for (const [command, key, result] of [
      ['field.option.create', optionKey, definition], ['field.columns.update', columnsKey, savedColumns], ['field.value.set', valueKey, savedValue],
    ] as const) {
      const rows = await h.db.sql`select command from command_idempotency where workspace_id = ${TEAM} and idempotency_key = ${key}`;
      expect(rows).toHaveLength(1);
      expect(rows[0]?.command).toBe(command);
      await h.db.sql`update command_idempotency set result = ${JSON.stringify(result)}::text::jsonb
        where workspace_id = ${TEAM} and command = ${command} and idempotency_key = ${key}`;
    }
    const week = await period(owner, project.id, { protectedFieldIds: [field.id] });
    await commit(owner, week, task, 120);
    await owner.freeze(week.id);
    const before = await databaseSnapshot(h.db.sql);
    expect(expectEnvelope(await owner.post(`/fields/${field.id}/options`, optionBody, optionKey), 201, taskFieldDefinitionResponseSchema).data).toEqual(definition);
    expect(expectEnvelope(await owner.patch(`/projects/${project.id}/columns`, columnsBody, columnsKey), 200, projectColumnsResponseSchema).data).toEqual(savedColumns);
    expect(expectEnvelope(await owner.put(owner.valuePath(task.id, field.id), valueBody, valueKey), 200, taskFieldValueResponseSchema).data).toEqual(savedValue);
    expect(await databaseSnapshot(h.db.sql)).toEqual(before);
    expectError(await owner.put(owner.valuePath(task.id, field.id), valueBody), 409, 'FIELD_LOCKED');
  });
});
