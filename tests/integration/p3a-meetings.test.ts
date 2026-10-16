// Actual P3a HTTP/PostgreSQL: shared occurrence, atomic attendee sources and pinned union reports.
import { randomUUID } from 'node:crypto';

import { attendancePostingResponseSchema, type AttendanceDto, type AttendancePostingInput, type MeetingDto } from '@workloom/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { expectEnvelope, expectError, uniqueName } from './support/p1a.js';
import { changedTables, databaseSnapshot, membershipRow, restoreMembership, revokeMembership } from './support/p1b.js';
import { MEMBERS as M, period, planningHarness, planningProject, TEAM, USERS, type PlanningHarness } from './support/p2a-fixture.js';
import { P3aClient } from './support/p3a.js';
import { requireTestDatabaseUrl } from './support/test-database-url.js';

requireTestDatabaseUrl();
const FIVE = [M.teamOwner, M.teamAdmin, M.teamMemberA, M.teamMemberB, M.teamMemberC];
function present(a: AttendanceDto): AttendancePostingInput {
  return { attendanceId: a.id, expectedAttendanceRevision: a.revision, expectedWorkLogRevision: a.workLog?.revision ?? null, kind: 'confirm', status: 'present', attributionBasis: 'actual_meeting' };
}
function absent(a: AttendanceDto, planned = false): AttendancePostingInput {
  return { attendanceId: a.id, expectedAttendanceRevision: a.revision, expectedWorkLogRevision: a.workLog?.revision ?? null, kind: 'confirm', status: 'absent', attributionBasis: planned ? 'planned_absence' : 'actual_meeting', reason: planned ? 'Запланированная встреча не состоялась' : null };
}

describe('P3a shared meetings and attendance over real HTTP/PostgreSQL', () => {
  let h: PlanningHarness;
  let owner: P3aClient, replica: P3aClient, member: P3aClient, viewer: P3aClient, outsider: P3aClient;
  beforeAll(async () => {
    h = await planningHarness('p3a_http');
    [owner, replica, member, viewer, outsider] = [h.owner, h.replica, h.member, h.viewer, h.outsider].map(c => new P3aClient(c.api, c.workspaceId)) as [P3aClient, P3aClient, P3aClient, P3aClient, P3aClient];
  });
  afterAll(async () => { await h?.close(); });

  async function fixture(label: string, attendees = FIVE, organizer: string = M.teamOwner) {
    const { project, todo, done } = await planningProject(owner, label);
    const week = await period(owner, project.id);
    const input = { title: uniqueName('Общая встреча'), statusId: todo.id, plannedPeriodId: week.id, plannedStartAt: `${week.localStart}T12:00:00.000Z`, timezone: 'Asia/Nicosia', plannedDurationMinutes: 60, organizerMembershipId: organizer, attendeeMembershipIds: attendees };
    const creation = await owner.createMeeting(project.id, input);
    return { project, todo, done, week, input, ...creation };
  }
  async function actual(meeting: MeetingDto, minutes = 60) {
    return owner.updateMeeting(meeting.taskId, { expectedMeetingRevision: meeting.revision, actualStartAt: meeting.plannedStartAt, actualDurationMinutes: minutes });
  }
  async function applyAll(meeting: MeetingDto, attendees: readonly AttendanceDto[]) {
    const rows = attendees.filter(a => a.rosterActive).map(a => ({ membershipId: a.membershipId, plannedMinutes: 60 }));
    const preview = await owner.planPreview(meeting.taskId, { expectedMeetingRevision: meeting.revision, rows });
    return owner.applyPlan(meeting.taskId, { expectedMeetingRevision: meeting.revision, previewHash: preview.previewHash, rows: preview.rows.map(row => ({ membershipId: row.membershipId, plannedMinutes: row.plannedMinutes, expectedCommitmentRevision: row.expectedCommitmentRevision })) });
  }

  it('creates exactly one shared task/package, five unknown roster identities and proposals, with no automatic plan or fact', async () => {
    const f = await fixture('Одна встреча для пяти человек');
    expect(f.task).toMatchObject({ meetingId: f.meeting.id, estimateMinutes: 300 });
    expect(f.meeting).toMatchObject({ taskId: f.task.id, workPackageId: f.task.workPackageId, plannedDurationMinutes: 60, organizerMembershipId: M.teamOwner, hasPostedAttendance: false, scheduleFrozen: false });
    expect(f.attendances).toHaveLength(5);
    expect(new Set(f.attendances.map(a => a.id)).size).toBe(5);
    expect(f.attendances.map(a => a.membershipId).sort()).toEqual(FIVE.slice().sort());
    for (const a of f.attendances) expect(a).toMatchObject({ status: 'unknown', postingState: 'unconfirmed', minutes: null, workLog: null, rosterActive: true });
    expect(f.planProposals).toHaveLength(5);
    for (const proposal of f.planProposals) expect(proposal).toMatchObject({ proposedMinutes: 60, workPackageId: f.task.workPackageId, plannedPeriodId: f.week.id });
    expect(await owner.commitments(f.week.id)).toEqual([]);
    expect(await owner.recordedWork(f.week.id)).toEqual([]);
    expect((await owner.tasks.listTasksPage({ projectId: f.project.id })).items).toHaveLength(1);
    expect(await owner.packages(f.project.id)).toHaveLength(1);
    expect(await owner.meetings(f.project.id, f.week.id)).toEqual([{ task: await owner.tasks.getTask(f.task.id), meeting: await owner.meeting(f.task.id) }]);
    expect((await owner.tasks.getTask(f.task.id)).meetingId).toBe(f.meeting.id);
    const key = randomUUID();
    const first = await owner.createMeeting(f.project.id, { ...f.input, title: 'Идемпотентный экземпляр' }, key);
    const before = await databaseSnapshot(h.db.sql);
    expect(await replica.createMeeting(f.project.id, { ...f.input, title: 'Идемпотентный экземпляр' }, key)).toEqual(first);
    expect(await databaseSnapshot(h.db.sql)).toEqual(before);
  });

  it('separates organizer from plan rights and applies a fresh multi-person plan atomically without implied attendance', async () => {
    const f = await fixture('Предложения и права личного плана', FIVE, M.teamMemberA);
    const rows = f.attendances.map(a => ({ membershipId: a.membershipId, plannedMinutes: 60 }));
    const before = await databaseSnapshot(h.db.sql);
    const ownPreview = await member.planPreview(f.task.id, { expectedMeetingRevision: f.meeting.revision, rows: [{ membershipId: M.teamMemberA, plannedMinutes: 60 }] });
    expect(await databaseSnapshot(h.db.sql)).toEqual(before);
    expectError(await member.post(`/tasks/${f.task.id}/meeting-plan`, { expectedMeetingRevision: f.meeting.revision, previewHash: ownPreview.previewHash, rows: [{ membershipId: M.teamOwner, plannedMinutes: 60, expectedCommitmentRevision: null }] }), 403, 'CAPABILITY_REQUIRED');
    const self = await member.applyPlan(f.task.id, { expectedMeetingRevision: f.meeting.revision, previewHash: ownPreview.previewHash, rows: ownPreview.rows.map(row => ({ membershipId: row.membershipId, plannedMinutes: row.plannedMinutes, expectedCommitmentRevision: row.expectedCommitmentRevision })) });
    expect(self.commitments).toHaveLength(1);
    expect(self.commitments[0]).toMatchObject({ membershipId: M.teamMemberA, plannedMinutes: 60 });
    const stale = await owner.planPreview(f.task.id, { expectedMeetingRevision: f.meeting.revision, rows });
    const existing = self.commitments[0]; if (!existing) throw new Error('Self commitment required.');
    await member.updateCommitment(f.week.id, existing.id, { expectedRevision: existing.revision, plannedMinutes: 30, allocations: [], state: 'active' });
    const state = await databaseSnapshot(h.db.sql);
    expectError(await owner.post(`/tasks/${f.task.id}/meeting-plan`, { expectedMeetingRevision: f.meeting.revision, previewHash: stale.previewHash, rows: stale.rows.map(row => ({ membershipId: row.membershipId, plannedMinutes: row.plannedMinutes, expectedCommitmentRevision: row.expectedCommitmentRevision })) }), 409, 'PREVIEW_STALE');
    expect(await databaseSnapshot(h.db.sql)).toEqual(state);
    const all = await applyAll(f.meeting, f.attendances);
    expect(all.commitments).toHaveLength(5);
    expect(new Set(all.commitments.map(c => c.workPackageId))).toEqual(new Set([f.task.workPackageId]));
    expect(all.commitments.reduce((sum, c) => sum + (c.plannedMinutes ?? 0), 0)).toBe(300);
    for (const c of all.commitments) expect(c.allocations).toEqual([{ taskId: f.task.id, minutes: 60 }]);
    expect(await owner.recordedWork(f.week.id)).toEqual([]);
  });

  it('posts three60 + partial30 + absent0 as210 exactly once, and both pinned report types and table projection read the source union', async () => {
    const f = await fixture('Подтверждённые человеко-минуты');
    await applyAll(f.meeting, f.attendances);
    const baseline = await owner.freeze(f.week.id);
    const meeting = await actual(await owner.meeting(f.task.id));
    const rows = f.attendances.map((a, i): AttendancePostingInput => i < 3 ? present(a) : i === 3 ? { ...present(a), kind: 'confirm', status: 'partial', attributionBasis: 'actual_meeting', minutes: 30 } : absent(a));
    const key = randomUUID(); const input = { expectedMeetingRevision: meeting.revision, periodId: f.week.id, rows };
    const posted = await owner.confirm(f.task.id, input, key);
    expect(posted.attendances).toHaveLength(5);
    const logs = await owner.recordedWork(f.week.id);
    expect(logs).toHaveLength(5);
    expect(logs.reduce((sum, log) => sum + log.minutes, 0)).toBe(210);
    for (const a of posted.attendances) {
      expect(a.workLog).toMatchObject({ sourceKind: 'meeting_attendance', precision: 'occurrence', attendanceId: a.id, meetingId: meeting.id, sourceKey: a.id, periodId: f.week.id, attribution: { basis: 'actual_meeting', plannedStartAt: meeting.plannedStartAt, actualStartAt: meeting.actualStartAt } });
    }
    const state = await databaseSnapshot(h.db.sql);
    expect(await replica.confirm(f.task.id, input, key)).toEqual(posted);
    expect(await databaseSnapshot(h.db.sql)).toEqual(state);
    const planFact = await owner.report({ baselineId: baseline.id });
    expect(planFact.summary).toMatchObject({ knownPlannedMinutes: 300, actualMinutes: 210, totalVarianceMinutes: -90, totalVariancePercent: -30, factCoverage: { recordedItemCount: 5, totalItemCount: 5, complete: true } });
    const planRows = await owner.reportRows(planFact.id);
    expect(planRows).toHaveLength(5);
    expect(planRows.flatMap(row => row.workLogs)).toHaveLength(5);
    const types = await owner.typeReport({ periodId: f.week.id });
    expect(types).toMatchObject({ totalActualMinutes: 210, activeSourceCount: 5, uncategorizedMinutes: 210 });
    expect((await owner.typeRows(types.id)).every(row => row.workLog.sourceKind === 'meeting_attendance')).toBe(true);
    const projection = await owner.timeSummary(f.project.id, f.week.id, [f.task.id]);
    expect(projection.tasks[0]).toMatchObject({ meetingId: meeting.id, ownManualWork: null, hasOtherSources: true, taskActualMinutes: 210, taskActiveSourceCount: 5 });
    expect(projection.packages[0]).toMatchObject({ totalActualMinutes: 210, totalActiveSourceCount: 5 });
    expect(await owner.workLogs(f.week.id)).toEqual([]);
  });

  it('records planned-absence zero without invented actual timing, keeps unknown missing, and void/restore reuse the source', async () => {
    const f = await fixture('Запланированная встреча не состоялась');
    const cancelled = await owner.updateMeeting(f.task.id, { expectedMeetingRevision: f.meeting.revision, state: 'cancelled' });
    const a = f.attendances[0], other = f.attendances[1]; if (!a || !other) throw new Error('Two roster members required.');
    expectError(await owner.post(`/tasks/${f.task.id}/attendance/confirm`, { expectedMeetingRevision: cancelled.revision, periodId: f.week.id, rows: [present(a)] }), 422, 'DOMAIN_VALIDATION_FAILED');

    const actualCreation = await owner.createMeeting(f.project.id, { ...f.input, title: 'Отменённая встреча с сохранёнными actual details' });
    const wasActual = await actual(actualCreation.meeting);
    const wasCancelled = await owner.updateMeeting(actualCreation.task.id, { expectedMeetingRevision: wasActual.revision, state: 'cancelled' });
    const actualAttendee = actualCreation.attendances[0]; if (!actualAttendee) throw new Error('Actual roster required.');
    const actualBefore = await databaseSnapshot(h.db.sql);
    expectError(await owner.post(`/tasks/${actualCreation.task.id}/attendance/confirm`, { expectedMeetingRevision: wasCancelled.revision, periodId: f.week.id, rows: [absent(actualAttendee)] }), 422, 'DOMAIN_VALIDATION_FAILED');
    expect(await databaseSnapshot(h.db.sql)).toEqual(actualBefore);
    const posted = await owner.confirm(f.task.id, { expectedMeetingRevision: cancelled.revision, periodId: f.week.id, rows: [absent(a, true)] });
    expect(posted.meeting).toMatchObject({ actualStartAt: null, actualDurationMinutes: null, hasPostedAttendance: true });
    const current = posted.attendances.find(x => x.id === a.id); if (!current?.workLog) throw new Error('Planned absence must have a recorded zero source.');
    expect(current).toMatchObject({ status: 'absent', postingState: 'active', minutes: 0, workLog: { minutes: 0, attribution: { basis: 'planned_absence', actualStartAt: null, plannedStartAt: cancelled.plannedStartAt } } });
    expect((await owner.attendance(f.task.id)).find(x => x.id === other.id)).toMatchObject({ status: 'unknown', postingState: 'unconfirmed', workLog: null, minutes: null });
    const run = await owner.typeReport({ periodId: f.week.id });
    expect(run).toMatchObject({ totalActualMinutes: 0, activeSourceCount: 1, rowCount: 1 });
    expect(run.byCategory.every(x => x.sharePercent === null)).toBe(true);
    const voided = await owner.confirm(f.task.id, { expectedMeetingRevision: cancelled.revision, periodId: f.week.id, rows: [{ attendanceId: current.id, expectedAttendanceRevision: current.revision, expectedWorkLogRevision: current.workLog.revision, kind: 'void', reason: 'Отмена ошибочного подтверждения отсутствия' }] });
    const voidRow = voided.attendances.find(x => x.id === a.id); if (!voidRow?.workLog) throw new Error('Void retains stable work source.');
    expect(voidRow).toMatchObject({ postingState: 'void', status: 'absent', workLog: { id: current.workLog.id, state: 'void', attribution: current.workLog.attribution } });
    expect((await owner.typeReport({ periodId: f.week.id })).activeSourceCount).toBe(0);
    const restored = await owner.confirm(f.task.id, { expectedMeetingRevision: cancelled.revision, periodId: f.week.id, rows: [{ ...absent(voidRow, true), reason: 'Явное восстановление подтверждённого нуля' }] });
    expect(restored.attendances.find(x => x.id === a.id)).toMatchObject({ workLog: { id: current.workLog.id, revision: 3, minutes: 0, state: 'active' } });
    expect(await owner.getTypeReport(run.id)).toEqual(run);
    expect((await owner.attendanceHistory(f.task.id, a.id)).length).toBeGreaterThanOrEqual(3);
  });

  it('keeps posted attribution snapshots unchanged under metadata edits and requires reasoned same-source correction', async () => {
    const f = await fixture('Изменение фактических деталей');
    let meeting = await actual(f.meeting);
    const a = f.attendances.find(x => x.membershipId === M.teamOwner); if (!a) throw new Error('Owner attendance required.');
    const posted = await owner.confirm(f.task.id, { expectedMeetingRevision: meeting.revision, periodId: f.week.id, rows: [present(a)] });
    const first = posted.attendances.find(x => x.id === a.id); if (!first?.workLog) throw new Error('First source required.');
    const run = await owner.typeReport({ periodId: f.week.id });
    meeting = await owner.updateMeeting(f.task.id, { expectedMeetingRevision: meeting.revision, recordingUrl: 'https://example.com/synthetic-recording', summaryText: 'Материалы после встречи' });
    expect((await owner.attendance(f.task.id)).find(x => x.id === a.id)?.workLog).toEqual(first.workLog);
    const equalBefore = await databaseSnapshot(h.db.sql);
    const equivalent = await owner.updateMeeting(f.task.id, { expectedMeetingRevision: meeting.revision, plannedStartAt: meeting.plannedStartAt.replace('.000Z', 'Z'), actualStartAt: meeting.actualStartAt?.replace('.000Z', 'Z') });
    expect(equivalent).toEqual(meeting);
    const equalAfter = await databaseSnapshot(h.db.sql);
    expect(changedTables(equalBefore, equalAfter)).toEqual(['command_idempotency']);
    expect(equalAfter.changeSeq).toEqual(equalBefore.changeSeq);
    const beforeNoop = await databaseSnapshot(h.db.sql);
    const noop = await owner.confirm(f.task.id, { expectedMeetingRevision: meeting.revision, periodId: f.week.id, rows: [present(first)] });
    expect(noop.attendances.find(x => x.id === a.id)).toEqual(first);
    const afterNoop = await databaseSnapshot(h.db.sql);
    expect(changedTables(beforeNoop, afterNoop)).toEqual(['command_idempotency']);
    expect(afterNoop.changeSeq).toEqual(beforeNoop.changeSeq);
    meeting = await owner.updateMeeting(f.task.id, { expectedMeetingRevision: meeting.revision, actualDurationMinutes: 45 });
    expect((await owner.attendance(f.task.id)).find(x => x.id === a.id)?.workLog?.minutes).toBe(60);
    expectError(await owner.post(`/tasks/${f.task.id}/attendance/confirm`, { expectedMeetingRevision: meeting.revision, periodId: f.week.id, rows: [present(first)] }), 422, 'DOMAIN_VALIDATION_FAILED');
    const corrected = await owner.confirm(f.task.id, { expectedMeetingRevision: meeting.revision, periodId: f.week.id, rows: [{ ...present(first), reason: 'Явное сокращение проведённой встречи' }] });
    const second = corrected.attendances.find(x => x.id === a.id); if (!second?.workLog) throw new Error('Corrected source required.');
    expect(second.workLog).toMatchObject({ id: first.workLog.id, revision: 2, minutes: 45 });
    const nextStart = new Date(new Date(meeting.actualStartAt ?? '').getTime() + 300000).toISOString();
    meeting = await owner.updateMeeting(f.task.id, { expectedMeetingRevision: meeting.revision, actualStartAt: nextStart });
    expect((await owner.attendance(f.task.id)).find(x => x.id === a.id)?.workLog?.attribution).toEqual(second.workLog.attribution);
    const moved = await owner.confirm(f.task.id, { expectedMeetingRevision: meeting.revision, periodId: f.week.id, rows: [{ ...present(second), reason: 'Уточнён фактический момент начала' }] });
    expect(moved.attendances.find(x => x.id === a.id)?.workLog).toMatchObject({ id: first.workLog.id, revision: 3, minutes: 45, attribution: { basis: 'actual_meeting', actualStartAt: nextStart } });
    expect(await owner.getTypeReport(run.id)).toEqual(run);
    expect((await owner.typeReport({ periodId: f.week.id })).totalActualMinutes).toBe(45);
  });

  it('joins the latest recategorized work head while attendance history retains its originally posted revision', async () => {
    const f = await fixture('Две независимые ревизии');
    const field = await owner.createField({ projectId: f.project.id, name: 'Тип встречи', type: 'single_select', options: [{ name: 'Обсуждение' }, { name: 'Поддержка' }] });
    const [a, b] = field.options; if (!a || !b) throw new Error('Two categories required.');
    const binding = await owner.bind(f.project.id, { expectedRevision: 1, fieldId: field.id });
    await owner.setValue(f.task.id, field.id, { expectedRevision: 0, expectedDefinitionRevision: field.revision, value: { type: 'single_select', value: a.id } });
    let meeting = await actual(f.meeting);
    const attendee = f.attendances.find(x => x.membershipId === M.teamOwner); if (!attendee) throw new Error('Owner roster required.');
    const posted = await owner.confirm(f.task.id, { expectedMeetingRevision: meeting.revision, periodId: f.week.id, rows: [present(attendee)] });
    const current = posted.attendances.find(x => x.id === attendee.id); if (!current?.workLog) throw new Error('Initial source required.');
    const changed = await owner.recategorize(current.workLog.id, { expectedWorkLogRevision: current.workLog.revision, expectedBindingRevision: binding.revision, optionId: b.id, reason: 'Уточнён тип выполненной встречи' });
    expect(changed).toMatchObject({ sourceKind: 'meeting_attendance', revision: 2, category: { optionId: b.id } });
    const latest = (await owner.attendance(f.task.id)).find(x => x.id === attendee.id); if (!latest?.workLog) throw new Error('Latest joined head required.');
    expect(latest.revision).toBe(current.revision); expect(latest.workLog).toEqual(changed);
    expect((await owner.attendanceHistory(f.task.id, attendee.id)).some(row => row.workLog?.revisionId === current.workLog?.revisionId)).toBe(true);
    expectError(await owner.post(`/tasks/${f.task.id}/attendance/confirm`, { expectedMeetingRevision: meeting.revision, periodId: f.week.id, rows: [present(current)] }), 409, 'REVISION_CONFLICT');
    const before = await databaseSnapshot(h.db.sql);
    const unchanged = await owner.confirm(f.task.id, { expectedMeetingRevision: meeting.revision, periodId: f.week.id, rows: [present(latest)] });
    expect(unchanged.attendances.find(x => x.id === attendee.id)?.workLog).toEqual(changed);
    expect(changedTables(before, await databaseSnapshot(h.db.sql))).toEqual(['command_idempotency']);
    meeting = await owner.updateMeeting(f.task.id, { expectedMeetingRevision: meeting.revision, actualDurationMinutes: 30 });
    const correction = await owner.confirm(f.task.id, { expectedMeetingRevision: meeting.revision, periodId: f.week.id, rows: [{ ...present(latest), reason: 'Сокращена фактическая длительность' }] });
    expect(correction.attendances.find(x => x.id === attendee.id)?.workLog).toMatchObject({ id: changed.id, revision: 3, category: { optionId: b.id }, minutes: 30 });
  });

  it('keeps batch rights/revisions atomic and current authorization precedes replay', async () => {
    const f = await fixture('Атомарные права присутствия');
    const meeting = await actual(f.meeting);
    const self = f.attendances.find(x => x.membershipId === M.teamMemberA), other = f.attendances.find(x => x.membershipId === M.teamOwner);
    if (!self || !other) throw new Error('Self/other roster required.');
    const before = await databaseSnapshot(h.db.sql);
    expectError(await member.post(`/tasks/${f.task.id}/attendance/confirm`, { expectedMeetingRevision: meeting.revision, periodId: f.week.id, rows: [present(self), present(other)] }), 403, 'CAPABILITY_REQUIRED');
    expectError(await viewer.post(`/tasks/${f.task.id}/attendance/confirm`, { expectedMeetingRevision: meeting.revision, periodId: f.week.id, rows: [present(self)] }), 403, 'CAPABILITY_REQUIRED');
    expectError(await owner.post(`/tasks/${f.task.id}/attendance/confirm`, { expectedMeetingRevision: meeting.revision, periodId: f.week.id, rows: [present(self), { ...present(other), expectedAttendanceRevision: other.revision + 1 }] }), 409, 'REVISION_CONFLICT');
    expect(await databaseSnapshot(h.db.sql)).toEqual(before);
    const key = randomUUID(); const input = { expectedMeetingRevision: meeting.revision, periodId: f.week.id, rows: [present(self)] };
    const posted = await member.confirm(f.task.id, input, key);
    expect(posted.attendances.find(x => x.id === self.id)?.workLog).toMatchObject({ membershipId: M.teamMemberA, actorUserId: USERS.memberA });
    const membership = await membershipRow(h.db.sql, TEAM, M.teamMemberA);
    await revokeMembership(h.db.sql, TEAM, M.teamMemberA);
    try {
      const denied = await databaseSnapshot(h.db.sql);
      expectError(await member.post(`/tasks/${f.task.id}/attendance/confirm`, input, key), 404, 'NOT_FOUND');
      expectError(await member.get(`/tasks/${f.task.id}/attendance`), 404, 'NOT_FOUND');
      expect(await databaseSnapshot(h.db.sql)).toEqual(denied);
    } finally { await restoreMembership(h.db.sql, TEAM, M.teamMemberA, membership); }
    expect(await member.confirm(f.task.id, input, key)).toEqual(posted);
    const foreign = new P3aClient(h.outsider.api, TEAM);
    expectError(await foreign.get(`/tasks/${f.task.id}/meeting`), 404, 'NOT_FOUND', [f.task.title]);
    expectError(await foreign.get(`/tasks/${f.task.id}/attendance`), 404, 'NOT_FOUND');
    const outsideProject = await planningProject(outsider, 'Чужая встреча');
    const outsideWeek = await period(outsider, outsideProject.project.id);
    const external = await outsider.createMeeting(outsideProject.project.id, { title: 'Скрытый экземпляр другой команды', statusId: outsideProject.todo.id, plannedPeriodId: outsideWeek.id, plannedStartAt: `${outsideWeek.localStart}T12:00:00.000Z`, timezone: 'UTC', plannedDurationMinutes: 60, organizerMembershipId: M.outsideOwner, attendeeMembershipIds: [M.outsideOwner] });
    const outsideAttendance = external.attendances[0]; if (!outsideAttendance) throw new Error('Outside attendance required.');
    const freshMeeting = await owner.meeting(f.task.id);
    expectError(await owner.post(`/tasks/${f.task.id}/attendance/confirm`, { expectedMeetingRevision: freshMeeting.revision, periodId: f.week.id, rows: [present(outsideAttendance)] }), 404, 'NOT_FOUND', [external.task.title]);
  });


  it('reuses deactivated roster IDs and updates one shared budget, then forbids roster changes after ever-posted attendance', async () => {
    const f = await fixture('Стабильный состав встречи');
    const removed = f.attendances.find(x => x.membershipId === M.teamMemberC); if (!removed) throw new Error('Removable roster member required.');
    const shorter = await owner.updateMeeting(f.task.id, { expectedMeetingRevision: f.meeting.revision, expectedParticipantsRevision: f.meeting.participantsRevision, expectedWorkPackageRevision: f.task.workPackageRevision, attendeeMembershipIds: FIVE.filter(id => id !== M.teamMemberC), plannedDurationMinutes: 30 });
    const inactive = (await owner.attendance(f.task.id)).find(x => x.id === removed.id);
    expect(inactive).toMatchObject({ id: removed.id, rosterActive: false, status: 'unknown', workLog: null });
    const task = await owner.tasks.getTask(f.task.id); expect(task.estimateMinutes).toBe(120);
    const restored = await owner.updateMeeting(f.task.id, { expectedMeetingRevision: shorter.revision, expectedParticipantsRevision: shorter.participantsRevision, expectedWorkPackageRevision: task.workPackageRevision, attendeeMembershipIds: FIVE });
    const roster = await owner.attendance(f.task.id);
    const reused = roster.find(x => x.membershipId === M.teamMemberC);
    expect(reused?.id).toBe(removed.id); expect(reused?.rosterActive).toBe(true);
    expect((await owner.tasks.getTask(f.task.id)).estimateMinutes).toBe(150);
    const meeting = await actual(restored, 30); const first = roster[0]; if (!first) throw new Error('Attendance required.');
    const posted = await owner.confirm(f.task.id, { expectedMeetingRevision: meeting.revision, periodId: f.week.id, rows: [present(first)] });
    const row = posted.attendances.find(x => x.id === first.id); if (!row?.workLog) throw new Error('Posted work required.');
    await owner.confirm(f.task.id, { expectedMeetingRevision: meeting.revision, periodId: f.week.id, rows: [{ attendanceId: row.id, expectedAttendanceRevision: row.revision, expectedWorkLogRevision: row.workLog.revision, kind: 'void', reason: 'Отмена ошибочного присутствия' }] });
    const fresh = await owner.meeting(f.task.id), freshTask = await owner.tasks.getTask(f.task.id);
    expect(fresh.hasPostedAttendance).toBe(true);
    const noopBefore = await databaseSnapshot(h.db.sql);
    expect(await owner.updateMeeting(f.task.id, { expectedMeetingRevision: fresh.revision, expectedParticipantsRevision: fresh.participantsRevision, expectedWorkPackageRevision: freshTask.workPackageRevision, attendeeMembershipIds: FIVE })).toEqual(fresh);
    const noopAfter = await databaseSnapshot(h.db.sql);
    expect(changedTables(noopBefore, noopAfter)).toEqual(['command_idempotency']);
    expect(noopAfter.changeSeq).toEqual(noopBefore.changeSeq);
    const before = await databaseSnapshot(h.db.sql);
    expectError(await owner.patch(`/tasks/${f.task.id}/meeting`, { expectedMeetingRevision: fresh.revision, expectedParticipantsRevision: fresh.participantsRevision, expectedWorkPackageRevision: freshTask.workPackageRevision, attendeeMembershipIds: FIVE.filter(id => id !== M.teamMemberC) }), 409, 'FIELD_LOCKED');
    const after = await databaseSnapshot(h.db.sql);
    expect(changedTables(before, after)).toEqual(['command_idempotency']);
    expect(after.changeSeq).toEqual(before.changeSeq);
    for (const patch of [
      { plannedStartAt: new Date(new Date(fresh.plannedStartAt).getTime() + 3600000).toISOString() },
      { timezone: 'UTC' }, { organizerMembershipId: M.teamMemberA },
      { plannedDurationMinutes: 45, expectedWorkPackageRevision: freshTask.workPackageRevision },
    ]) expectError(await owner.patch(`/tasks/${f.task.id}/meeting`, { expectedMeetingRevision: fresh.revision, ...patch }), 409, 'FIELD_LOCKED');
    expect(changedTables(after, await databaseSnapshot(h.db.sql))).toEqual(['command_idempotency']);
  });

  it('guards generic task/manual bypasses while ordinary status and explicit independent preparation remain usable', async () => {
    const f = await fixture('Единый путь изменения встречи');
    const before = await databaseSnapshot(h.db.sql);
    for (const change of [
      { participantMembershipIds: [M.teamOwner], expectedParticipantsRevision: f.task.participantsRevision },
      { responsibleMembershipId: M.teamMemberA }, { dueDate: '2026-10-17' },
      { estimateMinutes: 900, expectedWorkPackageRevision: f.task.workPackageRevision }, { parentTaskId: null },
    ]) expectError(await owner.patch(`/tasks/${f.task.id}`, { expectedRevision: f.task.revision, ...change }), 422, 'DOMAIN_VALIDATION_FAILED');
    expectError(await owner.post(`/tasks/${f.task.id}/archive`, { expectedRevision: f.task.revision }), 422, 'DOMAIN_VALIDATION_FAILED');
    expectError(await owner.post(`/tasks/${f.task.id}/restore`, { expectedRevision: f.task.revision }), 422, 'DOMAIN_VALIDATION_FAILED');
    expectError(await owner.put(owner.workPath(f.task.id, f.week.id, M.teamOwner), { expectedRevision: null, minutes: 60 }), 422, 'DOMAIN_VALIDATION_FAILED');
    expectError(await owner.post('/tasks', { projectId: f.project.id, statusId: f.todo.id, parentTaskId: f.task.id, workScope: 'detail', title: 'Неявная общая оценка встречи' }), 422, 'DOMAIN_VALIDATION_FAILED');
    expect(await databaseSnapshot(h.db.sql)).toEqual(before);
    await owner.tasks.updateTask(f.task.id, { expectedRevision: f.task.revision, statusId: f.done.id, title: 'Завершённая встреча без подтверждения' });
    expect(await owner.recordedWork(f.week.id)).toEqual([]);
    expect((await owner.attendance(f.task.id)).every(a => a.status === 'unknown')).toBe(true);
    const preparation = await owner.tasks.createTask({ projectId: f.project.id, statusId: f.todo.id, parentTaskId: f.task.id, workScope: 'added_scope', estimateMinutes: 30, title: 'Явная подготовка к встрече' });
    expect(preparation.workPackageId).not.toBe(f.task.workPackageId);
    expect(preparation.meetingId).toBeNull();
    const manual = await owner.setWork(preparation.id, f.week.id, M.teamOwner, { expectedRevision: null, minutes: 30 });
    expect(manual.sourceKind).toBe('manual_period');
    expect((await owner.recordedWork(f.week.id)).map(log => log.id)).toEqual([manual.id]);
  });

  it('preserves earliest frozen meeting schedule and links every relevant project commitment, while later metadata/facts remain explicit', async () => {
    const f = await fixture('Общий и личный исходный снимок');
    const plans = await applyAll(f.meeting, f.attendances);
    const personal = await member.freeze(f.week.id, 'self');
    const personalMeeting = personal.snapshot.meetings?.find(row => row.meeting.id === f.meeting.id);
    expect(personalMeeting).toBeDefined();
    const scheduled = await owner.meeting(f.task.id), task = await owner.tasks.getTask(f.task.id);
    expect(scheduled.scheduleFrozen).toBe(true);
    expectError(await owner.patch(`/tasks/${f.task.id}/meeting`, { expectedMeetingRevision: scheduled.revision, expectedWorkPackageRevision: task.workPackageRevision, plannedDurationMinutes: 90 }), 409, 'FIELD_LOCKED');
    const metadata = await owner.updateMeeting(f.task.id, { expectedMeetingRevision: scheduled.revision, summaryText: 'Материалы после личной фиксации' });
    const global = await owner.freeze(f.week.id);
    const globalMeeting = global.snapshot.meetings?.find(row => row.meeting.id === f.meeting.id);
    expect(globalMeeting?.commitmentIds.slice().sort()).toEqual(plans.commitments.map(c => c.id).sort());
    expect(globalMeeting?.meeting).toMatchObject({ plannedStartAt: f.meeting.plannedStartAt, plannedDurationMinutes: 60, plannedPeriodId: f.week.id, organizerMembershipId: M.teamOwner });
    expect(await owner.baseline(personal.id)).toEqual(personal);
    const actualMeeting = await actual(metadata);
    const own = (await owner.attendance(f.task.id)).find(a => a.membershipId === M.teamOwner); if (!own) throw new Error('Owner roster required.');
    await owner.confirm(f.task.id, { expectedMeetingRevision: actualMeeting.revision, periodId: f.week.id, rows: [present(own)] });
    expect(await owner.baseline(global.id)).toEqual(global);
    expect(personalMeeting?.meeting.actualStartAt).toBeNull();
  });

  it('commits an overdue freeze and tagged plan-apply rejection while every proposed plan row stays unchanged', async () => {
    const f = await fixture('Cutoff для атомарного плана встречи');
    await applyAll(f.meeting, f.attendances);
    const desired = f.attendances.map(a => ({ membershipId: a.membershipId, plannedMinutes: 120 }));
    const preview = await owner.planPreview(f.task.id, { expectedMeetingRevision: f.meeting.revision, rows: desired });
    const dueAt = new Date(Date.now() + 400).toISOString();
    await owner.updatePeriod(f.week.id, { expectedRevision: f.week.revision, cutoffAt: dueAt });
    for (let attempt = 0; attempt < 300; attempt++) {
      const [clock] = await h.db.sql<{ due: boolean }[]>`select clock_timestamp() >= ${dueAt}::timestamptz as due`;
      if (clock?.due) break;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    const beforeRows = await h.db.sql`select to_jsonb(c) as row from period_commitments c where period_id=${f.week.id} order by id`;
    const allocations = await h.db.sql`select to_jsonb(a) as row from commitment_allocations a where commitment_id in (select id from period_commitments where period_id=${f.week.id}) order by to_jsonb(a)::text`;
    const body = { expectedMeetingRevision: f.meeting.revision, previewHash: preview.previewHash, rows: preview.rows.map(row => ({ membershipId: row.membershipId, plannedMinutes: row.plannedMinutes, expectedCommitmentRevision: row.expectedCommitmentRevision })) };
    const key = randomUUID(); const response = await owner.post(`/tasks/${f.task.id}/meeting-plan`, body, key);
    const rejection = expectError(response, 409, 'FIELD_LOCKED');
    expect(rejection.error.details).toMatchObject({ committed: true, baselineIds: expect.any(Array) });
    expect(await h.db.sql`select to_jsonb(c) as row from period_commitments c where period_id=${f.week.id} order by id`).toEqual(beforeRows);
    expect(await h.db.sql`select to_jsonb(a) as row from commitment_allocations a where commitment_id in (select id from period_commitments where period_id=${f.week.id}) order by to_jsonb(a)::text`).toEqual(allocations);
    const baselines = await owner.baselines(f.week.id); const global = baselines.find(b => b.scope === 'project');
    expect(global).toBeDefined();
    expect(global?.snapshot.commitments.every(c => c.plannedMinutes === 60)).toBe(true);
    const after = await databaseSnapshot(h.db.sql);
    expect(expectError(await replica.post(`/tasks/${f.task.id}/meeting-plan`, body, key), 409, 'FIELD_LOCKED').error).toEqual(rejection.error);
    expect(await databaseSnapshot(h.db.sql)).toEqual(after);
  });

  it('rolls back late SQL failure for the whole attendance batch, then concurrent exact-key requests create one set of sources', async () => {
    const f = await fixture('Откат и повтор общей отметки');
    const meeting = await actual(f.meeting);
    const body = { expectedMeetingRevision: meeting.revision, periodId: f.week.id, rows: f.attendances.map(present) };
    await h.db.sql.unsafe("create function qa_attendance_late_fault() returns trigger language plpgsql as $$ begin raise exception 'synthetic attendance late fault'; end $$");
    await h.db.sql.unsafe('create trigger qa_attendance_late_fault before insert on command_idempotency for each row execute function qa_attendance_late_fault()');
    const before = await databaseSnapshot(h.db.sql); const key = randomUUID();
    try {
      expectError(await owner.post(`/tasks/${f.task.id}/attendance/confirm`, body, key), 500, 'INTERNAL_ERROR', ['synthetic attendance late fault']);
      expect(await databaseSnapshot(h.db.sql)).toEqual(before);
    } finally {
      await h.db.sql.unsafe('drop trigger qa_attendance_late_fault on command_idempotency');
      await h.db.sql.unsafe('drop function qa_attendance_late_fault()');
    }
    const results = await Promise.all([owner.post(`/tasks/${f.task.id}/attendance/confirm`, body, key), replica.post(`/tasks/${f.task.id}/attendance/confirm`, body, key)]);
    const [responseA, responseB] = results; if (!responseA || !responseB) throw new Error('Both concurrent responses required.');
    const first = expectEnvelope(responseA, 200, attendancePostingResponseSchema).data;
    expect(expectEnvelope(responseB, 200, attendancePostingResponseSchema).data).toEqual(first);
    const logs = await owner.recordedWork(f.week.id); expect(logs).toHaveLength(5);
    expect(logs.reduce((sum, row) => sum + row.minutes, 0)).toBe(300);
    const [count] = await h.db.sql<{ count: number }[]>`select count(*)::int as count from work_log_revisions where work_log_id in (select id from work_logs where period_id=${f.week.id})`;
    expect(count?.count).toBe(5);
    const immutableBefore = await databaseSnapshot(h.db.sql);
    const firstLog = logs[0]; if (!firstLog) throw new Error('Recorded source required.');
    const wrongIdentity: unknown = await h.db.sql`update work_logs set meeting_id=null where id=${firstLog.id}`.then(() => null, (error: unknown) => error);
    expect(wrongIdentity).toMatchObject({ code: '23514' });
    expect(await databaseSnapshot(h.db.sql)).toEqual(immutableBefore);
    for (const table of ['meeting_revisions', 'meeting_attendance_revisions']) {
      for (const query of [`update ${table} set id=id where id=(select id from ${table} order by id limit 1)`, `delete from ${table} where id=(select id from ${table} order by id limit 1)`, `truncate table ${table} cascade`]) {
        const error: unknown = await h.db.sql.unsafe(query).then(() => null, (e: unknown) => e);
        expect(error).toMatchObject({ code: '42501' });
        expect(await databaseSnapshot(h.db.sql)).toEqual(immutableBefore);
      }
    }
  });


  it('keeps UTC overlap instants distinct, validates boundaries in the explicit period zone and never posts to overlapping periods', async () => {
    const { project, todo } = await planningProject(owner, 'Точные моменты и период');
    const input = { projectId: project.id, localStart: '2026-10-19', timezone: 'Europe/Berlin', cutoffAt: '2026-10-26T12:00:00.000Z' };
    const a = await owner.createPeriod({ ...input, name: 'Явный период A' });
    const b = await owner.createPeriod({ ...input, localStart: '2026-10-20', name: 'Перекрывающийся период B' });
    const create = { title: 'Осенняя встреча', statusId: todo.id, plannedPeriodId: a.id, plannedStartAt: '2026-10-25T00:30:00.000Z', timezone: 'Europe/Berlin', plannedDurationMinutes: 90, organizerMembershipId: M.teamOwner, attendeeMembershipIds: [M.teamOwner] };
    const first = await owner.createMeeting(project.id, create);
    const second = await owner.createMeeting(project.id, { ...create, plannedStartAt: '2026-10-25T01:30:00.000Z' });
    expect(first.meeting.id).not.toBe(second.meeting.id);
    expect(first.meeting.plannedStartAt).toBe(create.plannedStartAt);
    expect(second.meeting.plannedStartAt).toBe('2026-10-25T01:30:00.000Z');
    const boundary = await owner.createMeeting(project.id, { ...create, plannedStartAt: '2026-10-18T22:30:00.000Z', timezone: 'UTC' });
    expect(boundary.meeting.plannedPeriodId).toBe(a.id);
    expectError(await owner.post(`/projects/${project.id}/meetings`, { ...create, plannedStartAt: '2026-10-18T21:59:00.000Z' }), 422, 'DOMAIN_VALIDATION_FAILED');
    expectError(await owner.post(`/projects/${project.id}/meetings`, { ...create, plannedStartAt: '2026-10-25T02:30' }), 400, 'VALIDATION_FAILED');
    expectError(await owner.post(`/projects/${project.id}/meetings`, { ...create, timezone: '+02:00' }), 400, 'VALIDATION_FAILED');
    expectError(await owner.post(`/projects/${project.id}/meetings`, { ...create, joinUrl: 'javascript:alert(1)' }), 400, 'VALIDATION_FAILED');
    const meeting = await actual(first.meeting, 90); const attendee = first.attendances[0]; if (!attendee) throw new Error('Attendance required.');
    const before = await databaseSnapshot(h.db.sql);
    expectError(await owner.post(`/tasks/${first.task.id}/attendance/confirm`, { expectedMeetingRevision: meeting.revision, periodId: b.id, rows: [present(attendee)] }), 422, 'DOMAIN_VALIDATION_FAILED');
    expect(await databaseSnapshot(h.db.sql)).toEqual(before);
    const posted = await owner.confirm(first.task.id, { expectedMeetingRevision: meeting.revision, periodId: a.id, rows: [present(attendee)] });
    expect(posted.attendances[0]?.workLog).toMatchObject({ precision: 'occurrence', minutes: 90, periodId: a.id, attribution: { actualStartAt: '2026-10-25T00:30:00.000Z' } });
    expect(await owner.recordedWork(b.id)).toEqual([]);
    expect((await owner.typeReport({ periodId: a.id })).totalActualMinutes).toBe(90);
  });


  it('persists an empty overdue baseline and committed stale preview, then fresh-key plan apply creates server-added work', async () => {
    const f = await fixture('Cutoff без прежних личных планов');
    const desired = [{ membershipId: M.teamOwner, plannedMinutes: 60 }];
    const preview = await owner.planPreview(f.task.id, { expectedMeetingRevision: f.meeting.revision, rows: desired });
    const dueAt = new Date(Date.now() + 400).toISOString();
    await owner.updatePeriod(f.week.id, { expectedRevision: f.week.revision, cutoffAt: dueAt });
    for (let attempt = 0; attempt < 300; attempt++) {
      const [clock] = await h.db.sql<{ due: boolean }[]>`select clock_timestamp() >= ${dueAt}::timestamptz as due`;
      if (clock?.due) break;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    const body = { expectedMeetingRevision: f.meeting.revision, previewHash: preview.previewHash, rows: preview.rows.map(row => ({ membershipId: row.membershipId, plannedMinutes: row.plannedMinutes, expectedCommitmentRevision: row.expectedCommitmentRevision })) };
    const key = randomUUID(); const rejected = expectError(await owner.post(`/tasks/${f.task.id}/meeting-plan`, body, key), 409, 'PREVIEW_STALE');
    expect(rejected.error.details).toMatchObject({ committed: true, baselineIds: expect.any(Array) });
    expect(await owner.commitments(f.week.id)).toEqual([]);
    const baselines = await owner.baselines(f.week.id); const global = baselines.find(b => b.scope === 'project');
    expect(global?.snapshot.commitments).toEqual([]);
    const after = await databaseSnapshot(h.db.sql);
    expect(expectError(await replica.post(`/tasks/${f.task.id}/meeting-plan`, body, key), 409, 'PREVIEW_STALE').error).toEqual(rejected.error);
    expect(await databaseSnapshot(h.db.sql)).toEqual(after);
    const freshMeeting = await owner.meeting(f.task.id);
    const fresh = await owner.planPreview(f.task.id, { expectedMeetingRevision: freshMeeting.revision, rows: desired });
    const applied = await owner.applyPlan(f.task.id, { expectedMeetingRevision: freshMeeting.revision, previewHash: fresh.previewHash, rows: fresh.rows.map(row => ({ membershipId: row.membershipId, plannedMinutes: row.plannedMinutes, expectedCommitmentRevision: row.expectedCommitmentRevision })) });
    expect(applied.commitments).toHaveLength(1);
    expect(applied.commitments[0]).toMatchObject({ plannedMinutes: 60, classification: 'added', baselineIds: [] });
    if (!global) throw new Error('Committed original project baseline required.');
    expect(await owner.baseline(global.id)).toEqual(global);
  });


  it('voids the recorded occurrence snapshot after actual details changed, then restores only through explicit reconfirmation', async () => {
    const f = await fixture('Отмена прежнего факта после уточнения встречи');
    const atA = await actual(f.meeting, 60); const attendee = f.attendances[0]; if (!attendee) throw new Error('Attendance required.');
    const posted = await owner.confirm(f.task.id, { expectedMeetingRevision: atA.revision, periodId: f.week.id, rows: [present(attendee)] });
    const original = posted.attendances.find(row => row.id === attendee.id); if (!original?.workLog) throw new Error('Original recorded source required.');
    const startB = new Date(new Date(atA.actualStartAt ?? '').getTime() + 600000).toISOString();
    const atB = await owner.updateMeeting(f.task.id, { expectedMeetingRevision: atA.revision, actualStartAt: startB, actualDurationMinutes: 30 });
    const voided = await owner.confirm(f.task.id, { expectedMeetingRevision: atB.revision, periodId: f.week.id, rows: [{ attendanceId: original.id, expectedAttendanceRevision: original.revision, expectedWorkLogRevision: original.workLog.revision, kind: 'void', reason: 'Отмена прежней записи без переписывания её момента' }] });
    const voidRow = voided.attendances.find(row => row.id === attendee.id); if (!voidRow?.workLog) throw new Error('Void source head required.');
    expect(voidRow.workLog).toMatchObject({ id: original.workLog.id, state: 'void', revision: 2, minutes: 60, confirmedMeetingRevision: original.workLog.confirmedMeetingRevision, attribution: original.workLog.attribution });
    expect(voidRow.confirmedMeetingRevision).toBe(original.confirmedMeetingRevision);
    const restored = await owner.confirm(f.task.id, { expectedMeetingRevision: atB.revision, periodId: f.week.id, rows: [{ ...present(voidRow), reason: 'Явное подтверждение уточнённых фактических деталей' }] });
    expect(restored.attendances.find(row => row.id === attendee.id)?.workLog).toMatchObject({ id: original.workLog.id, state: 'active', revision: 3, minutes: 30, confirmedMeetingRevision: atB.revision, attribution: { basis: 'actual_meeting', actualStartAt: startB } });
    const history = await owner.attendanceHistory(f.task.id, attendee.id);
    expect(history.find(row => row.postingState === 'void')?.workLog).toMatchObject({ minutes: 60, attribution: original.workLog.attribution, confirmedMeetingRevision: original.workLog.confirmedMeetingRevision });
  });

});
