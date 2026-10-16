// Actual P3b HTTP/PostgreSQL: finite explicit bindings, stable reserved headers, the server DST
// resolver, calendar-only census freezes, independent overdue recovery and stored-authorizer blocks.
// No worker runs here; worker crash/relay/receipt evidence stays in its own suite.
import { randomUUID } from 'node:crypto';

import {
  RECURRENCE_DST_REFERENCE_VECTORS, RECURRENCE_MATERIALIZATION_SCHEMA_VERSION, RECURRENCE_RESOLUTION_POLICY,
  recurrenceMaterializationResultResponseSchema, recurrenceSeriesResponseSchema,
  type RecurrenceBindingProgressDto, type RecurrenceCreatePreviewInput, type RecurrenceScheduleInput, type RecurrenceTemplateInput,
} from '@workloom/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { expectEnvelope, expectError, uniqueName } from './support/p1a.js';
import { databaseSnapshot, membershipRow, restoreMembership, revokeMembership } from './support/p1b.js';
import { MEMBERS as M, planningHarness, planningProject, TEAM, type PlanningHarness } from './support/p2a-fixture.js';
import {
  P3B_PATHS as P, P3bClient, byKey, expectOnlyIdempotency, located, materializationRequests, one, p3bClients,
  pgClockBefore, pgClockPlus, waitPastPgClock,
} from './support/p3b.js';
import { requireTestDatabaseUrl } from './support/test-database-url.js';

requireTestDatabaseUrl();

const FAR_CUTOFF = '2027-01-31T00:00:00.000Z';
const MINUTE = 60_000;
const DAY = 86_400_000;
const ms = (instant: string) => Date.parse(instant);
// Rejections docs/16 implies without naming the exact code; reconcile here if the implementation differs.
const AMBIGUOUS_PERIODS = [422, 'DOMAIN_VALIDATION_FAILED'] as const;
const BINDING_CONFLICT = [409, 'REVISION_CONFLICT'] as const;
const CROSS_PERIOD_MOVE = [422, 'DOMAIN_VALIDATION_FAILED'] as const;
const IMMUTABLE_SEQUENCE = [422, 'DOMAIN_VALIDATION_FAILED'] as const;
const PROTECTED_TARGET = [422, 'DOMAIN_VALIDATION_FAILED'] as const;

const ROSTER = [M.teamOwner, M.teamMemberA, M.teamMemberB];
// 30 November 2026 is 45 days after "today" (16 October): beyond any 28-day horizon.
const WEEKDAYS: RecurrenceScheduleInput = {
  startDate: '2026-11-30', localTime: '10:00', timezone: 'Asia/Nicosia', frequency: 'weekly', weekdays: [1, 2, 3, 4, 5],
  plannedDurationMinutes: 45, end: { kind: 'after_count', count: 5 },
};
const FIVE_KEYS = ['2026-11-30', '2026-12-01', '2026-12-02', '2026-12-03', '2026-12-04'];

function template(statusId: string, attendeeMembershipIds: string[], organizerMembershipId: string = M.teamOwner, title = uniqueName('Повторяющаяся встреча')): RecurrenceTemplateInput {
  return { title, statusId, organizerMembershipId, attendeeMembershipIds };
}
function daily(startDate: string, count: number, localTime = '10:00', timezone = 'Asia/Nicosia', plannedDurationMinutes = 30): RecurrenceScheduleInput {
  return { startDate, localTime, timezone, frequency: 'daily', plannedDurationMinutes, end: { kind: 'after_count', count } };
}
function explicitWeek(client: P3bClient, projectId: string, localStart: string, timezone = 'Europe/Berlin') {
  return client.createPeriod({ projectId, name: uniqueName(`Неделя ${localStart}`), localStart, timezone, cutoffAt: FAR_CUTOFF });
}
function cursorOf(result: { nextCursor: string | null }): string {
  if (result.nextCursor === null) throw new Error('Signed continuation cursor required.');
  return result.nextCursor;
}
function hashes(bindings: readonly { bindingId: string; sourceManifestHash: string }[]): Record<string, string> {
  return Object.fromEntries(bindings.map(b => [b.bindingId, b.sourceManifestHash]));
}
/** Every binding reported by a later chunk keeps the generation-input hash it had before. */
function expectStableManifests(reference: readonly RecurrenceBindingProgressDto[], later: readonly RecurrenceBindingProgressDto[]) {
  const known = hashes(reference);
  expect(later.length).toBeGreaterThan(0);
  for (const binding of later) expect(binding.sourceManifestHash, binding.bindingId).toBe(known[binding.bindingId]);
}
async function applyPlan(client: P3bClient, taskId: string, rows: { membershipId: string; plannedMinutes: number | null }[]) {
  const meeting = await client.meeting(taskId);
  const preview = await client.planPreview(taskId, { expectedMeetingRevision: meeting.revision, rows });
  return client.applyPlan(taskId, { expectedMeetingRevision: meeting.revision, previewHash: preview.previewHash, rows: preview.rows.map(row => ({ membershipId: row.membershipId, plannedMinutes: row.plannedMinutes, expectedCommitmentRevision: row.expectedCommitmentRevision })) });
}
async function attend(client: P3bClient, taskId: string, periodId: string, membershipId: string, minutes: number) {
  const scheduled = await client.meeting(taskId);
  const meeting = await client.updateMeeting(taskId, { expectedMeetingRevision: scheduled.revision, actualStartAt: scheduled.plannedStartAt, actualDurationMinutes: minutes });
  const row = (await client.attendance(taskId)).find(a => a.membershipId === membershipId); if (!row) throw new Error('Roster row required.');
  return client.confirm(taskId, { expectedMeetingRevision: meeting.revision, periodId, rows: [{ attendanceId: row.id, expectedAttendanceRevision: row.revision, expectedWorkLogRevision: null, kind: 'confirm', status: 'present', attributionBasis: 'actual_meeting' }] });
}

describe('P3b finite recurrence over real HTTP/PostgreSQL', () => {
  let h: PlanningHarness;
  let owner: P3bClient, replica: P3bClient, member: P3bClient, viewer: P3bClient, outsider: P3bClient;
  beforeAll(async () => {
    h = await planningHarness('p3b_http');
    ({ owner, replica, member, viewer, outsider } = p3bClients(h));
  });
  afterAll(async () => { await h?.close(); });

  async function weekdaySeries(label: string) {
    const { project, todo } = await planningProject(owner, label);
    const week = await explicitWeek(owner, project.id, '2026-11-30');
    const input: RecurrenceCreatePreviewInput = { schedule: WEEKDAYS, template: template(todo.id, ROSTER), targetPeriodIds: [week.id] };
    return { project, todo, week, input };
  }

  it('registers five reserved headers from a read-only preview and materializes five real compositions exactly once', async () => {
    const f = await weekdaySeries('Пять будней одной серии');
    const before = await databaseSnapshot(h.db.sql);
    const preview = await owner.previewCreate(f.project.id, f.input);
    expect(await replica.previewCreate(f.project.id, f.input)).toEqual(preview);
    expect(await databaseSnapshot(h.db.sql)).toEqual(before);
    expect(preview).toMatchObject({
      projectId: f.project.id, policyVersion: RECURRENCE_RESOLUTION_POLICY, provenance: { timezone: 'Asia/Nicosia' },
      counts: { nominalCount: 5, consumedNominalCount: 0, remainingNominalCount: 5, skippedCount: 0, cancelledCount: 0 },
      periods: [{ periodId: f.week.id, periodRevision: f.week.revision, candidateCount: 5 }], unboundCandidateCount: 0, warnings: [],
    });
    expect(preview.candidates.map(c => [c.occurrenceKey, c.nominalSequence, c.periodId, c.collidesWithOccurrenceKeys])).toEqual(FIVE_KEYS.map((key, i) => [key, i + 1, f.week.id, []]));
    for (const c of preview.candidates) {
      expect(c.resolution).toMatchObject({ intendedLocalDate: c.occurrenceKey, intendedLocalTime: '10:00', resolvedLocalDate: c.occurrenceKey, resolvedLocalTime: '10:00', resolvedOffset: '+02:00', warning: null, plannedDurationMinutes: 45 });
      expect(ms(c.resolution.resolvedEndAt) - ms(c.resolution.resolvedStartAt)).toBe(45 * MINUTE);
    }

    const createKey = randomUUID(); const createInput = { ...f.input, previewHash: preview.previewHash };
    const series = await owner.createSeries(f.project.id, createInput, createKey);
    expect(series).toMatchObject({
      projectId: f.project.id, state: 'active', boundPeriodIds: [f.week.id], boundPeriodCount: 1, nominalCandidateCount: 5,
      currentVersion: { effectiveFromNominalDate: WEEKDAYS.startDate, schedule: WEEKDAYS, template: f.input.template, policyVersion: RECURRENCE_RESOLUTION_POLICY },
      generation: { authorizerMembershipId: M.teamOwner, state: 'ready', blockedCode: null },
    });
    const created = await databaseSnapshot(h.db.sql);
    expect(await replica.createSeries(f.project.id, createInput, createKey)).toEqual(series);
    expect(await databaseSnapshot(h.db.sql)).toEqual(created);

    const headers = await owner.instances(series.id, f.week.id);
    expect(headers.map(i => i.occurrenceKey)).toEqual(FIVE_KEYS);
    expect(new Set(headers.map(i => i.id)).size).toBe(5);
    expect(headers.map(i => i.resolution)).toEqual(preview.candidates.map(c => c.resolution));
    headers.forEach((header, i) => expect(header).toMatchObject({
      seriesId: series.id, plannedPeriodId: f.week.id, nominalSequence: i + 1, sourceVersionId: series.currentVersion.id,
      calendarState: 'scheduled', meetingId: null, taskId: null, workPackageId: null, meetingRevision: null, exception: null,
    }));
    const bindingId = one([...new Set(headers.map(i => i.bindingId))]);
    const requested = await materializationRequests(h.db.sql, TEAM, before.changeSeq[TEAM] ?? '0');
    expect(requested).toEqual([{ changeSeq: created.changeSeq[TEAM], schemaVersion: RECURRENCE_MATERIALIZATION_SCHEMA_VERSION,
      payload: { seriesId: series.id, bindingId, sourceManifestHash: expect.any(String), authorizationRevision: series.generation.authorizationRevision } }]);
    expect(await owner.commitments(f.week.id)).toEqual([]);
    expect(await owner.recordedWork(f.week.id)).toEqual([]);
    expect(await owner.periodMeetings(f.project.id, f.week.id)).toEqual([]);

    const ready = await owner.readiness(f.week.id);
    const manifest = one(requested).payload.sourceManifestHash;
    expect(ready).toMatchObject({ periodId: f.week.id, state: 'pending', missingCount: 5, blockedCount: 0, truncated: false });
    expect(ready.bindings).toMatchObject([{ bindingId, seriesId: series.id, sourceManifestHash: manifest, state: 'pending', remainingCount: 5, blockedCode: null }]);
    const materializeKey = randomUUID();
    const result = await owner.materialize(f.week.id, {}, materializeKey);
    expect(result).toEqual({ periodId: f.week.id, status: 'complete', createdCount: 5, remainingCount: 0, nextCursor: null, frozenBaselineIds: [], truncated: false,
      bindings: [{ bindingId, seriesId: series.id, sourceManifestHash: manifest, state: 'complete', createdCount: 5, remainingCount: 0, blockedCode: null }] });
    const done = await databaseSnapshot(h.db.sql);
    expect(await replica.materialize(f.week.id, {}, materializeKey)).toEqual(result);
    expect(await databaseSnapshot(h.db.sql)).toEqual(done);
    expect(await owner.materialize(f.week.id, {})).toMatchObject({ status: 'complete', createdCount: 0, remainingCount: 0, nextCursor: null, frozenBaselineIds: [], truncated: false });

    const real = (await owner.instances(series.id, f.week.id)).map(located);
    expect(real.map(i => i.id)).toEqual(headers.map(i => i.id));
    for (const locator of ['meetingId', 'taskId', 'workPackageId'] as const) expect(new Set(real.map(i => i[locator])).size).toBe(5);
    expect(await owner.periodMeetings(f.project.id, f.week.id)).toHaveLength(5);
    expect(new Set((await owner.packages(f.project.id)).map(p => p.id))).toEqual(new Set(real.map(i => i.workPackageId)));
    const proposalsBefore = await databaseSnapshot(h.db.sql);
    for (const instance of real) {
      const meeting = await owner.meeting(instance.taskId);
      expect(meeting).toMatchObject({ id: instance.meetingId, workPackageId: instance.workPackageId, plannedPeriodId: f.week.id, timezone: 'Asia/Nicosia', plannedDurationMinutes: 45,
        organizerMembershipId: M.teamOwner, state: 'scheduled', hasPostedAttendance: false, scheduleFrozen: false,
        recurrence: { seriesId: series.id, instanceId: instance.id, occurrenceKey: instance.occurrenceKey, nominalSequence: instance.nominalSequence } });
      expect(ms(meeting.plannedStartAt)).toBe(ms(instance.resolution.resolvedStartAt));
      expect(instance.meetingRevision).toBe(meeting.revision);
      expect(await owner.tasks.getTask(instance.taskId)).toMatchObject({ meetingId: instance.meetingId, workPackageId: instance.workPackageId, estimateMinutes: 45 * ROSTER.length });
      const roster = await owner.attendance(instance.taskId);
      expect(roster.map(a => a.membershipId).sort()).toEqual([...ROSTER].sort());
      for (const a of roster) expect(a).toMatchObject({ status: 'unknown', postingState: 'unconfirmed', minutes: null, workLog: null });
      const proposed = await owner.planPreview(instance.taskId, { expectedMeetingRevision: meeting.revision, rows: ROSTER.map(membershipId => ({ membershipId, plannedMinutes: 45 })) });
      expect(proposed.rows.map(row => row.membershipId).sort()).toEqual([...ROSTER].sort());
      for (const row of proposed.rows) expect(row).toMatchObject({ plannedMinutes: 45, commitment: null, expectedCommitmentRevision: null });
    }
    expect(await databaseSnapshot(h.db.sql)).toEqual(proposalsBefore);
    expect(await owner.commitments(f.week.id)).toEqual([]);
    expect(await owner.recordedWork(f.week.id)).toEqual([]);
    expect(await owner.readiness(f.week.id)).toMatchObject({ state: 'complete', missingCount: 0 });
  });

  it('keeps the original key and IDs through skip/restore/move/reset, never appends after_count dates, and lets the override outrank regeneration', async () => {
    const f = await weekdaySeries('Исключения одной серии');
    const { series } = await owner.create(f.project.id, f.input);
    await owner.materialize(f.week.id, {});
    const original = (await owner.instances(series.id, f.week.id)).map(located);
    const wed = byKey(original, '2026-12-02');
    const identity = { id: wed.id, occurrenceKey: '2026-12-02', nominalSequence: 3, meetingId: wed.meetingId, taskId: wed.taskId, workPackageId: wed.workPackageId };

    const readOnly = await databaseSnapshot(h.db.sql);
    const skipInput = { kind: 'skip', reason: 'Праздничный день', expectedSeriesRevision: series.revision, expectedInstanceRevision: wed.revision } as const;
    const skipPreview = await owner.previewException(series.id, wed.occurrenceKey, skipInput);
    expect(await databaseSnapshot(h.db.sql)).toEqual(readOnly);
    expect(skipPreview).toMatchObject({ seriesId: series.id, instanceId: wed.id, occurrenceKey: wed.occurrenceKey, kind: 'skip', before: wed.resolution, calendarStateAfter: 'cancelled', protectedReasons: [] });
    const skipped = await owner.setException(series.id, wed.occurrenceKey, { ...skipInput, previewHash: skipPreview.previewHash });
    expect(skipped).toMatchObject({ ...identity, calendarState: 'cancelled', exception: { kind: 'skip', reason: 'Праздничный день' } });
    expect(await owner.meeting(wed.taskId)).toMatchObject({ id: wed.meetingId, state: 'cancelled' });

    const fresh = await owner.series(series.id);
    expect(fresh.nominalCandidateCount).toBe(5);
    const nextWeek = await explicitWeek(owner, f.project.id, '2026-12-07');
    const appended = await owner.previewPeriods(series.id, { expectedRevision: fresh.revision, periodIds: [nextWeek.id] });
    expect(appended.periods).toEqual([{ periodId: nextWeek.id, periodRevision: nextWeek.revision, candidateCount: 0 }]);
    expect(appended.candidates.filter(c => !FIVE_KEYS.includes(c.occurrenceKey))).toEqual([]);
    const future = { expectedRevision: fresh.revision, effectiveFromNominalDate: '2026-12-03', schedule: WEEKDAYS, template: { ...f.input.template, title: 'Будущие планёрки' } };
    expect((await owner.previewEdit(series.id, future)).counts).toMatchObject({ nominalCount: 5, consumedNominalCount: 3, remainingNominalCount: 2, skippedCount: 1 });
    const sameDaily = { startDate: WEEKDAYS.startDate, localTime: WEEKDAYS.localTime, timezone: WEEKDAYS.timezone, frequency: 'daily', plannedDurationMinutes: 45, end: WEEKDAYS.end };
    const immutableBefore = await databaseSnapshot(h.db.sql);
    for (const schedule of [
      { ...WEEKDAYS, end: { kind: 'after_count', count: 6 } }, { ...WEEKDAYS, end: { kind: 'on_date', endDate: '2026-12-04' } },
      { ...WEEKDAYS, startDate: '2026-12-01' }, { ...WEEKDAYS, weekdays: [1, 2, 3, 4] }, sameDaily,
    ]) expectError(await owner.post(P.editPreview(series.id), { ...future, schedule }, null), ...IMMUTABLE_SEQUENCE);
    expect(await databaseSnapshot(h.db.sql)).toEqual(immutableBefore);

    const restored = (await owner.exception(skipped, { kind: 'restore', reason: 'Праздник перенесён' })).applied;
    expect(restored).toMatchObject({ ...identity, calendarState: 'scheduled', exception: { kind: 'restore' } });
    expect((await owner.meeting(wed.taskId)).state).toBe('scheduled');
    const move = await owner.exception(restored, { kind: 'move', localDate: '2026-12-05', localTime: '16:30', reason: 'Перенос на субботу' });
    expect(move.preview).toMatchObject({ calendarStateAfter: 'scheduled', protectedReasons: [], after: { intendedLocalDate: '2026-12-05', intendedLocalTime: '16:30' } });
    expect(move.applied).toMatchObject({ ...identity, calendarState: 'scheduled', exception: { kind: 'move' },
      resolution: { intendedLocalDate: '2026-12-05', intendedLocalTime: '16:30', resolvedLocalDate: '2026-12-05', resolvedLocalTime: '16:30', warning: null } });
    const movedMeeting = await owner.meeting(wed.taskId);
    expect(ms(movedMeeting.plannedStartAt)).toBe(ms(move.applied.resolution.resolvedStartAt));
    expect(movedMeeting.recurrence).toEqual({ seriesId: series.id, instanceId: wed.id, occurrenceKey: '2026-12-02', nominalSequence: 3 });

    const current = await owner.series(series.id);
    const later = { ...WEEKDAYS, localTime: '11:00' };
    const edit = { expectedRevision: current.revision, effectiveFromNominalDate: WEEKDAYS.startDate, schedule: later, template: f.input.template };
    const editPreview = await owner.previewEdit(series.id, edit);
    expect(editPreview.protectedTargets).toEqual([]);
    expect(Object.fromEntries(editPreview.impacts.map(i => [i.occurrenceKey, [i.instanceId, i.action]]))).toEqual(Object.fromEntries(original.map(i => [i.occurrenceKey, [i.id, i.occurrenceKey === '2026-12-02' ? 'retain' : 'update']])));
    const edited = await owner.editSeries(series.id, { ...edit, previewHash: editPreview.previewHash });
    expect(edited.currentVersion).toMatchObject({ effectiveFromNominalDate: WEEKDAYS.startDate, schedule: later });
    expect(edited.currentVersion.id).not.toBe(series.currentVersion.id);
    const regenerated = (await owner.instances(series.id, f.week.id)).map(located);
    expect(regenerated.map(i => [i.id, i.meetingId, i.taskId, i.workPackageId])).toEqual(original.map(i => [i.id, i.meetingId, i.taskId, i.workPackageId]));
    expect(byKey(regenerated, '2026-12-02').resolution).toEqual(move.applied.resolution);
    for (const instance of regenerated.filter(i => i.occurrenceKey !== '2026-12-02')) {
      expect(instance).toMatchObject({ sourceVersionId: edited.currentVersion.id, resolution: { intendedLocalDate: instance.occurrenceKey, intendedLocalTime: '11:00', resolvedLocalTime: '11:00' } });
      expect(ms((await owner.meeting(instance.taskId)).plannedStartAt)).toBe(ms(instance.resolution.resolvedStartAt));
    }

    const reset = (await owner.exception(byKey(regenerated, '2026-12-02'), { kind: 'reset', reason: 'Вернуть правило серии' })).applied;
    expect(reset).toMatchObject({ ...identity, calendarState: 'scheduled', sourceVersionId: edited.currentVersion.id, exception: { kind: 'reset' },
      resolution: { intendedLocalDate: '2026-12-02', intendedLocalTime: '11:00', resolvedLocalDate: '2026-12-02', resolvedLocalTime: '11:00' } });
    expect(ms((await owner.meeting(wed.taskId)).plannedStartAt)).toBe(ms(reset.resolution.resolvedStartAt));
    expect(await owner.periodMeetings(f.project.id, f.week.id)).toHaveLength(5);
    expect(await owner.readiness(f.week.id)).toMatchObject({ state: 'complete', missingCount: 0 });
  });

  it('lets this-and-future edits share an effective date, and the highest applicable revision wins even over an older later-dated version', async () => {
    const f = await weekdaySeries('Повторные правки с одной даты');
    const { series } = await owner.create(f.project.id, f.input);
    await owner.materialize(f.week.id, {});
    const original = (await owner.instances(series.id, f.week.id)).map(located);
    async function editFrom(effectiveFromNominalDate: string, localTime: string) {
      const current = await owner.series(series.id);
      const input = { expectedRevision: current.revision, effectiveFromNominalDate, schedule: { ...WEEKDAYS, localTime }, template: f.input.template };
      const preview = await owner.previewEdit(series.id, input);
      expect(preview.protectedTargets).toEqual([]);
      return { preview, edited: await owner.editSeries(series.id, { ...input, previewHash: preview.previewHash }) };
    }
    // 3 December plays the older future "20 October" version; 1 December the newer "18 October" one.
    const laterDated = await editFrom('2026-12-03', '12:00');
    const sameDate = await editFrom('2026-12-03', '13:00');
    expect(sameDate.edited.currentVersion).toMatchObject({ effectiveFromNominalDate: '2026-12-03', schedule: { localTime: '13:00' } });
    expect(sameDate.edited.currentVersion.revision).toBeGreaterThan(laterDated.edited.currentVersion.revision);
    const afterSameDate = (await owner.instances(series.id, f.week.id)).map(located);
    for (const key of ['2026-12-03', '2026-12-04']) expect(byKey(afterSameDate, key)).toMatchObject({ sourceVersionId: sameDate.edited.currentVersion.id, resolution: { intendedLocalTime: '13:00', resolvedLocalTime: '13:00' } });

    const earlier = await editFrom('2026-12-01', '14:00');
    const superseded = ['2026-12-01', '2026-12-02', '2026-12-03', '2026-12-04'];
    expect(Object.fromEntries(earlier.preview.impacts.filter(i => i.occurrenceKey >= '2026-12-01').map(i => [i.occurrenceKey, [i.action, i.after?.intendedLocalTime]]))).toEqual(Object.fromEntries(superseded.map(key => [key, ['update', '14:00']])));
    expect(earlier.preview.impacts.filter(i => i.occurrenceKey < '2026-12-01').every(i => i.action === 'retain')).toBe(true);
    expect(earlier.edited.currentVersion).toMatchObject({ effectiveFromNominalDate: '2026-12-01', schedule: { localTime: '14:00' } });
    const versionIds = [series.currentVersion.id, laterDated.edited.currentVersion.id, sameDate.edited.currentVersion.id, earlier.edited.currentVersion.id];
    expect(new Set(versionIds).size).toBe(4);

    const final = (await owner.instances(series.id, f.week.id)).map(located);
    expect(final.map(i => [i.id, i.meetingId, i.taskId, i.workPackageId])).toEqual(original.map(i => [i.id, i.meetingId, i.taskId, i.workPackageId]));
    expect(byKey(final, '2026-11-30')).toMatchObject({ sourceVersionId: series.currentVersion.id, resolution: byKey(original, '2026-11-30').resolution });
    for (const key of superseded) {
      const instance = byKey(final, key);
      expect(instance).toMatchObject({ sourceVersionId: earlier.edited.currentVersion.id, resolution: { intendedLocalDate: key, intendedLocalTime: '14:00', resolvedLocalDate: key, resolvedLocalTime: '14:00' } });
      expect(ms((await owner.meeting(instance.taskId)).plannedStartAt)).toBe(ms(instance.resolution.resolvedStartAt));
    }
    expect(await owner.periodMeetings(f.project.id, f.week.id)).toHaveLength(5);
    expect(await owner.packages(f.project.id)).toHaveLength(5);
    expect(await owner.tasks.listAllTasks({ projectId: f.project.id })).toHaveLength(5);
    expect(await owner.readiness(f.week.id)).toMatchObject({ state: 'complete', missingCount: 0 });
    const baseline = await owner.freeze(f.week.id);
    expect([...(one(baseline.snapshot.recurrence?.bindings ?? []).seriesVersionIds)].sort()).toEqual([...versionIds].sort());
    for (const key of superseded) expect(byKey(baseline.snapshot.recurrence?.census ?? [], key).sourceVersionId).toBe(earlier.edited.currentVersion.id);
  });

  it('propagates section-only and status-only template changes to existing occurrence tasks without changing their identities', async () => {
    const { project, todo, done } = await planningProject(owner, 'Изменение шаблона встречи');
    const week = await explicitWeek(owner, project.id, '2026-12-07');
    const input = { schedule: daily('2026-12-07', 2), template: template(todo.id, [M.teamOwner]), targetPeriodIds: [week.id] };
    const { series } = await owner.create(project.id, input);
    await owner.materialize(week.id);
    const original = (await owner.instances(series.id, week.id)).map(located);
    const section = await owner.tasks.createSection(project.id, { name: 'Общая координация' });
    for (const change of [{ sectionId: section.id }, { statusId: done.id }]) {
      const current = await owner.series(series.id);
      const edit = { expectedRevision: current.revision, effectiveFromNominalDate: '2026-12-07', schedule: current.currentVersion.schedule,
        template: { ...current.currentVersion.template, ...change } };
      const preview = await owner.previewEdit(series.id, edit);
      expect(preview.protectedTargets).toEqual([]);
      await owner.editSeries(series.id, { ...edit, previewHash: preview.previewHash });
      const after = (await owner.instances(series.id, week.id)).map(located);
      expect(after.map(i => [i.id, i.meetingId, i.taskId, i.workPackageId])).toEqual(original.map(i => [i.id, i.meetingId, i.taskId, i.workPackageId]));
      for (const i of after) expect(await owner.tasks.getTask(i.taskId)).toMatchObject({ title: input.template.title, sectionId: section.id, ...change });
    }
    expect(await owner.periodMeetings(project.id, week.id)).toHaveLength(2);
    expect(await owner.recordedWork(week.id)).toEqual([]);
  });

  it('refuses moving an existing future occurrence earlier today into the past, with read-only protected preview and no mutation', async () => {
    const now = new Date(await pgClockPlus(h.db.sql, 0));
    const timezone = now.getUTCHours() >= 2 && now.getUTCHours() <= 21 ? 'UTC' : 'Etc/GMT-12';
    const formatter = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
    function wall(at: number) {
      const p = Object.fromEntries(formatter.formatToParts(new Date(at)).map(x => [x.type, x.value]));
      return { date: `${p.year}-${p.month}-${p.day}`, time: `${p.hour}:${p.minute}` };
    }
    const future = wall(now.getTime() + 3_600_000), past = wall(now.getTime() - 3_600_000);
    expect(future.date).toBe(past.date);
    const { project, todo } = await planningProject(owner, 'Запрет переноса серии в прошлое');
    const week = await explicitWeek(owner, project.id, future.date, timezone);
    const { series } = await owner.create(project.id, { schedule: daily(future.date, 1, future.time, timezone), template: template(todo.id, [M.teamOwner]), targetPeriodIds: [week.id] });
    await owner.materialize(week.id);
    const before = await databaseSnapshot(h.db.sql);
    const edit = { expectedRevision: series.revision, effectiveFromNominalDate: future.date, schedule: { ...series.currentVersion.schedule, localTime: past.time }, template: series.currentVersion.template };
    const preview = await owner.previewEdit(series.id, edit);
    expect(preview.protectedTargets).toEqual([expect.objectContaining({ reasons: expect.arrayContaining(['past']) })]);
    expect(await databaseSnapshot(h.db.sql)).toEqual(before);
    expectError(await owner.post(P.edit(series.id), { ...edit, previewHash: preview.previewHash }), 422, 'DOMAIN_VALIDATION_FAILED');
    await expectOnlyIdempotency(h.db.sql, before);
  });

  it('resets a moved occurrence to the latest duration/timezone/roster while preserving actual metadata, old history and stable identities', async () => {
    const { project, todo } = await planningProject(owner, 'Возврат перенесённой встречи к новому шаблону');
    const week = await explicitWeek(owner, project.id, '2026-11-30', 'UTC');
    const { series } = await owner.create(project.id, { schedule: daily('2026-11-30', 2, '10:00', 'Asia/Nicosia', 30),
      template: template(todo.id, [M.teamOwner, M.teamMemberA]), targetPeriodIds: [week.id] });
    await owner.materialize(week.id);
    const original = located(byKey(await owner.instances(series.id, week.id), '2026-11-30'));
    const first = await owner.meeting(original.taskId);
    const localSection = await owner.tasks.createSection(project.id, { name: 'Локальная тема встречи' });
    const taskBefore = await owner.tasks.getTask(original.taskId);
    await owner.tasks.updateTask(original.taskId, { expectedRevision: taskBefore.revision, title: 'Собственная тема этой встречи', sectionId: localSection.id });
    // An actual start protects the schedule by policy; an unposted duration and material notes remain editable.
    await owner.updateMeeting(original.taskId, { expectedMeetingRevision: first.revision, actualDurationMinutes: 20,
      joinUrl: 'https://example.test/join/local', recordingUrl: 'https://example.test/recording/retained', summaryText: 'Сохранённые фактические сведения' });
    const moved = (await owner.exception(original, { kind: 'move', localDate: original.occurrenceKey, localTime: '12:00', reason: 'Разовый перенос' })).applied;
    const beforeEdit = await owner.series(series.id);
    const editedInput = { expectedRevision: beforeEdit.revision, effectiveFromNominalDate: original.occurrenceKey,
      schedule: { ...beforeEdit.currentVersion.schedule, timezone: 'Europe/Berlin', plannedDurationMinutes: 60 },
      template: { ...beforeEdit.currentVersion.template, title: 'Новый общий шаблон', organizerMembershipId: M.teamMemberB, attendeeMembershipIds: [M.teamOwner, M.teamMemberB] } };
    const editPreview = await owner.previewEdit(series.id, editedInput);
    expect(editPreview.protectedTargets).toEqual([]);
    const edited = await owner.editSeries(series.id, { ...editedInput, previewHash: editPreview.previewHash });
    const retained = byKey(await owner.instances(series.id, week.id), original.occurrenceKey);
    expect(retained.resolution).toEqual(moved.resolution);
    const historyBefore = await h.db.sql<{ row: unknown }[]>`select to_jsonb(r) as row from meeting_revisions r where workspace_id=${TEAM} and meeting_id=${original.meetingId} order by revision`;
    const attendanceBefore = await owner.attendance(original.taskId);
    const oldHistories = await Promise.all(attendanceBefore.map(async a => ({ id: a.id, rows: await owner.attendanceHistory(original.taskId, a.id) })));
    const { applied: reset, preview: resetPreview } = await owner.exception(retained, { kind: 'reset', reason: 'Вернули к актуальному правилу серии' });
    expect(resetPreview.beforePlannedCalendar).toMatchObject({ timezone: 'Asia/Nicosia', plannedDurationMinutes: 30,
      organizerMembershipId: M.teamOwner, attendeeMembershipIds: [M.teamOwner, M.teamMemberA].sort() });
    expect(resetPreview.afterPlannedCalendar).toMatchObject({ timezone: 'Europe/Berlin', plannedDurationMinutes: 60,
      organizerMembershipId: M.teamMemberB, attendeeMembershipIds: [M.teamOwner, M.teamMemberB].sort() });
    expect([reset.id, reset.meetingId, reset.taskId, reset.workPackageId]).toEqual([original.id, original.meetingId, original.taskId, original.workPackageId]);
    expect(reset.sourceVersionId).toBe(edited.currentVersion.id);
    expect(reset.resolution).toMatchObject({ plannedDurationMinutes: 60, intendedLocalTime: '10:00', provenance: { timezone: 'Europe/Berlin' } });
    const meeting = await owner.meeting(original.taskId);
    expect(meeting).toMatchObject({ plannedDurationMinutes: 60, timezone: 'Europe/Berlin', organizerMembershipId: M.teamMemberB,
      actualStartAt: null, actualDurationMinutes: 20, joinUrl: 'https://example.test/join/local', recordingUrl: 'https://example.test/recording/retained', summaryText: 'Сохранённые фактические сведения' });
    expect(Date.parse(meeting.plannedStartAt)).toBe(Date.parse(reset.resolution.resolvedStartAt));
    expect(await owner.tasks.getTask(original.taskId)).toMatchObject({ title: 'Собственная тема этой встречи', sectionId: localSection.id, statusId: taskBefore.statusId });
    const roster = await owner.attendance(original.taskId);
    expect(roster.filter(a => a.rosterActive).map(a => a.membershipId).sort()).toEqual([M.teamOwner, M.teamMemberB].sort());
    expect(roster.find(a => a.membershipId === M.teamMemberA)).toMatchObject({ id: attendanceBefore.find(a => a.membershipId === M.teamMemberA)?.id, rosterActive: false });
    for (const old of oldHistories) expect(await owner.attendanceHistory(original.taskId, old.id)).toEqual(expect.arrayContaining(old.rows));
    const historyAfter = await h.db.sql<{ row: unknown }[]>`select to_jsonb(r) as row from meeting_revisions r where workspace_id=${TEAM} and meeting_id=${original.meetingId} order by revision`;
    expect(historyAfter).toEqual(expect.arrayContaining(historyBefore));
    expect(await owner.recordedWork(week.id)).toEqual([]);
    const baseline = await member.freeze(week.id, 'self');
    expect((baseline.snapshot.recurrence?.census ?? []).some(i => i.instanceId === reset.id)).toBe(false);
    const own = await owner.freeze(week.id, 'self');
    expect(own.snapshot.recurrence?.census.find(i => i.instanceId === reset.id)).toMatchObject({ resolution: reset.resolution, sourceVersionId: reset.sourceVersionId });
    expect((await owner.meeting(original.taskId)).scheduleFrozen).toBe(true);
  });

  it('requires the whole census for a self freeze but locks only occurrences whose roster includes that member; project freeze then locks all', async () => {
    const { project, todo } = await planningProject(owner, 'Личная фиксация по составу');
    const week = await explicitWeek(owner, project.id, '2026-11-23');
    const own = (await owner.create(project.id, { schedule: daily('2026-11-24', 2, '10:00'), template: template(todo.id, [M.teamOwner, M.teamMemberA]), targetPeriodIds: [week.id] })).series;
    await owner.materialize(week.id, {});
    const colleagues = (await owner.create(project.id, { schedule: daily('2026-11-24', 2, '15:00'), template: template(todo.id, [M.teamOwner, M.teamMemberB], M.teamMemberB), targetPeriodIds: [week.id] })).series;
    // Only the colleagues-only series is missing, yet the self freeze still needs the whole period census.
    const missing = await databaseSnapshot(h.db.sql);
    expectError(await member.post(`/periods/${week.id}/freeze-preview`, { scope: 'self' }, null), 409, 'MATERIALIZATION_REQUIRED');
    expect(await databaseSnapshot(h.db.sql)).toEqual(missing);
    expect(await owner.materialize(week.id, {})).toMatchObject({ status: 'complete', createdCount: 2 });
    const ownReal = (await owner.instances(own.id, week.id)).map(located);
    const colleagueReal = (await owner.instances(colleagues.id, week.id)).map(located);

    const self = await member.freeze(week.id, 'self');
    expect(self).toMatchObject({ scope: 'self', membershipId: M.teamMemberA });
    expect(await owner.getPeriod(week.id)).toMatchObject({ state: 'planning', projectBaselineId: null });
    const ownMeetings = new Map<string, number>();
    for (const instance of ownReal) {
      const meeting = await owner.meeting(instance.taskId);
      expect(meeting.scheduleFrozen).toBe(true);
      ownMeetings.set(instance.id, meeting.revision);
    }
    for (const instance of colleagueReal) expect((await owner.meeting(instance.taskId)).scheduleFrozen).toBe(false);

    const ownSeries = await owner.series(own.id);
    const ownEdit = { expectedRevision: ownSeries.revision, effectiveFromNominalDate: '2026-11-24', schedule: daily('2026-11-24', 2, '11:00'), template: ownSeries.currentVersion.template };
    const ownPreview = await owner.previewEdit(own.id, ownEdit);
    expect(ownPreview.protectedTargets.map(t => t.instanceId).sort()).toEqual(ownReal.map(i => i.id).sort());
    for (const target of ownPreview.protectedTargets) expect(target.reasons).toContain('schedule_frozen');
    const locked = await databaseSnapshot(h.db.sql);
    expectError(await owner.post(P.edit(own.id), { ...ownEdit, previewHash: ownPreview.previewHash }), ...PROTECTED_TARGET);
    await expectOnlyIdempotency(h.db.sql, locked);

    const colleagueSeries = await owner.series(colleagues.id);
    const colleagueEdit = { expectedRevision: colleagueSeries.revision, effectiveFromNominalDate: '2026-11-24', schedule: daily('2026-11-24', 2, '16:00'), template: colleagueSeries.currentVersion.template };
    const colleaguePreview = await owner.previewEdit(colleagues.id, colleagueEdit);
    expect(colleaguePreview.protectedTargets).toEqual([]);
    const moved = await owner.editSeries(colleagues.id, { ...colleagueEdit, previewHash: colleaguePreview.previewHash });
    const movedReal = (await owner.instances(colleagues.id, week.id)).map(located);
    expect(movedReal.map(i => i.id)).toEqual(colleagueReal.map(i => i.id));
    for (const instance of movedReal) {
      expect(instance).toMatchObject({ sourceVersionId: moved.currentVersion.id, resolution: { intendedLocalTime: '16:00' } });
      expect(ms((await owner.meeting(instance.taskId)).plannedStartAt)).toBe(ms(instance.resolution.resolvedStartAt));
    }

    const projectBaseline = await owner.freeze(week.id);
    const census = projectBaseline.snapshot.recurrence?.census ?? [];
    expect(census).toHaveLength(4);
    for (const instance of ownReal) expect(census.find(e => e.instanceId === instance.id)).toMatchObject({ sourceVersionId: instance.sourceVersionId, resolution: instance.resolution, meetingRevision: ownMeetings.get(instance.id) });
    for (const instance of movedReal) expect(census.find(e => e.instanceId === instance.id)).toMatchObject({ sourceVersionId: moved.currentVersion.id, resolution: instance.resolution });
    for (const instance of movedReal) expect((await owner.meeting(instance.taskId)).scheduleFrozen).toBe(true);
    const frozenColleagues = await owner.series(colleagues.id);
    const lockedAll = await owner.previewEdit(colleagues.id, { ...colleagueEdit, expectedRevision: frozenColleagues.revision, schedule: daily('2026-11-24', 2, '17:00') });
    expect(lockedAll.protectedTargets.map(t => t.instanceId).sort()).toEqual(movedReal.map(i => i.id).sort());
    expect(await owner.baseline(self.id)).toEqual(self);
  });

  it('rejects direct planned-calendar edits of a recurring meeting without side effects, allows semantic no-ops and keeps actual/recording metadata usable', async () => {
    const { project, todo } = await planningProject(owner, 'Прямое изменение повторяющейся встречи');
    const week = await explicitWeek(owner, project.id, '2026-12-07');
    const { series } = await owner.create(project.id, { schedule: daily('2026-12-08', 1, '10:00', 'Asia/Nicosia', 60), template: template(todo.id, [M.teamOwner, M.teamMemberA]), targetPeriodIds: [week.id] });
    await owner.materialize(week.id, {});
    const instance = located(one(await owner.instances(series.id, week.id)));
    const meeting = await owner.meeting(instance.taskId), task = await owner.tasks.getTask(instance.taskId);
    const guards = { expectedMeetingRevision: meeting.revision, expectedParticipantsRevision: meeting.participantsRevision, expectedWorkPackageRevision: task.workPackageRevision };
    const before = await databaseSnapshot(h.db.sql);
    for (const change of [
      { plannedStartAt: new Date(ms(meeting.plannedStartAt) + 3_600_000).toISOString() }, { timezone: 'UTC' }, { plannedDurationMinutes: 45 },
      { organizerMembershipId: M.teamMemberA }, { attendeeMembershipIds: [M.teamOwner, M.teamMemberA, M.teamMemberB] }, { state: 'cancelled' },
    ]) expectError(await owner.patch(`/tasks/${instance.taskId}/meeting`, { ...guards, ...change }), 422, 'DOMAIN_VALIDATION_FAILED');
    expect(await databaseSnapshot(h.db.sql)).toEqual(before);

    const canonicalStart = new Date(ms(meeting.plannedStartAt)).toISOString();
    const equivalentStart = meeting.plannedStartAt === canonicalStart ? canonicalStart.replace(/\.000Z$/, 'Z') : canonicalStart;
    expect(equivalentStart).not.toBe(meeting.plannedStartAt);
    const same = await owner.updateMeeting(instance.taskId, { ...guards, plannedStartAt: equivalentStart, timezone: meeting.timezone, plannedDurationMinutes: meeting.plannedDurationMinutes,
      organizerMembershipId: meeting.organizerMembershipId, attendeeMembershipIds: [M.teamMemberA, M.teamOwner], state: meeting.state });
    expect(same).toEqual(meeting);
    await expectOnlyIdempotency(h.db.sql, before);

    const recordingUrl = 'https://example.com/synthetic-recurring-recording';
    const actual = await owner.updateMeeting(instance.taskId, { expectedMeetingRevision: meeting.revision, actualStartAt: meeting.plannedStartAt, actualDurationMinutes: 50, recordingUrl, summaryText: 'Итоги повторяющейся встречи' });
    expect(actual).toMatchObject({ id: meeting.id, plannedStartAt: meeting.plannedStartAt, timezone: meeting.timezone, plannedDurationMinutes: 60, organizerMembershipId: M.teamOwner, state: 'scheduled',
      actualDurationMinutes: 50, recordingUrl, summaryText: 'Итоги повторяющейся встречи', recurrence: meeting.recurrence });
    expect(ms(actual.actualStartAt ?? '')).toBe(ms(meeting.plannedStartAt));
    expect(actual.revision).toBeGreaterThan(meeting.revision);
    expect(located(one(await owner.instances(series.id, week.id)))).toMatchObject({ id: instance.id, calendarState: 'scheduled', meetingId: instance.meetingId, resolution: instance.resolution });
    expect((await owner.attendance(instance.taskId)).filter(a => a.rosterActive).map(a => a.membershipId).sort()).toEqual([M.teamOwner, M.teamMemberA].sort());
  });

  it('resolves all eight DST reference vectors through the real server policy with elapsed duration and provenance', async () => {
    const { project, todo } = await planningProject(owner, 'Политика DST');
    const shift = (date: string, days: number) => new Date(ms(`${date}T00:00:00Z`) + days * DAY).toISOString().slice(0, 10);
    const weeks = [];
    const byStart = new Map<string, Awaited<ReturnType<typeof explicitWeek>>>();
    for (const v of RECURRENCE_DST_REFERENCE_VECTORS) {
      const start = shift(v.intendedLocalDate, -3);
      let week = byStart.get(start);
      if (!week) { week = await explicitWeek(owner, project.id, start, 'UTC'); byStart.set(start, week); }
      weeks.push(week);
    }
    expect(weeks).toHaveLength(8);
    const before = await databaseSnapshot(h.db.sql);
    for (const [index, v] of RECURRENCE_DST_REFERENCE_VECTORS.entries()) {
      const week = weeks[index]; if (!week) throw new Error('Explicit vector period required.');
      const label = `${v.timezone} ${v.intendedLocalDate} ${v.intendedLocalTime}`;
      const preview = await owner.previewCreate(project.id, { schedule: daily(v.intendedLocalDate, 1, v.intendedLocalTime, v.timezone, 90), template: template(todo.id, [M.teamOwner]), targetPeriodIds: [week.id] });
      expect(preview.policyVersion, label).toBe(RECURRENCE_RESOLUTION_POLICY);
      expect(preview.provenance.timezone, label).toBe(v.timezone);
      expect(preview.warnings, label).toEqual(v.warning === null ? [] : [v.warning]);
      const candidate = one(preview.candidates);
      expect(candidate, label).toMatchObject({ occurrenceKey: v.intendedLocalDate, nominalSequence: 1, periodId: week.id, collidesWithOccurrenceKeys: [] });
      expect(candidate.resolution, label).toMatchObject({
        policyVersion: RECURRENCE_RESOLUTION_POLICY, intendedLocalDate: v.intendedLocalDate, intendedLocalTime: v.intendedLocalTime,
        resolvedLocalDate: v.resolvedLocalDate, resolvedLocalTime: v.resolvedLocalTime, resolvedOffset: v.resolvedOffset, warning: v.warning,
        plannedDurationMinutes: 90, provenance: { timezone: v.timezone },
      });
      expect(ms(candidate.resolution.resolvedStartAt), label).toBe(ms(`${v.resolvedLocalDate}T${v.resolvedLocalTime}:00${v.resolvedOffset}`));
      expect(ms(candidate.resolution.resolvedEndAt) - ms(candidate.resolution.resolvedStartAt), label).toBe(90 * MINUTE);
    }
    expect(await databaseSnapshot(h.db.sql)).toEqual(before);
  });

  it('keeps two Apia nominal keys that resolve to the same instant as two distinct candidates, headers and meetings', async () => {
    const { project, todo } = await planningProject(owner, 'Пропущенная дата Apia');
    const week = await explicitWeek(owner, project.id, '2011-12-26', 'UTC');
    const input = { schedule: daily('2011-12-29', 3, '00:00', 'Pacific/Apia'), template: template(todo.id, [M.teamOwner]), targetPeriodIds: [week.id] };
    const before = await databaseSnapshot(h.db.sql);
    const preview = await owner.previewCreate(project.id, input);
    expect(await databaseSnapshot(h.db.sql)).toEqual(before);
    expect(preview.counts.nominalCount).toBe(3);
    expect(preview.periods).toEqual([{ periodId: week.id, periodRevision: week.revision, candidateCount: 3 }]);
    expect(preview.candidates.map(c => c.occurrenceKey)).toEqual(['2011-12-29', '2011-12-30', '2011-12-31']);
    const d29 = byKey(preview.candidates, '2011-12-29'), d30 = byKey(preview.candidates, '2011-12-30'), d31 = byKey(preview.candidates, '2011-12-31');
    expect(d29.collidesWithOccurrenceKeys).toEqual([]);
    expect(d30).toMatchObject({ nominalSequence: 2, periodId: week.id, collidesWithOccurrenceKeys: ['2011-12-31'],
      resolution: { intendedLocalDate: '2011-12-30', intendedLocalTime: '00:00', resolvedLocalDate: '2011-12-31', resolvedLocalTime: '00:00', resolvedOffset: '+14:00', warning: 'skipped_local_date' } });
    expect(d31).toMatchObject({ nominalSequence: 3, periodId: week.id, collidesWithOccurrenceKeys: ['2011-12-30'],
      resolution: { intendedLocalDate: '2011-12-31', resolvedLocalDate: '2011-12-31', resolvedLocalTime: '00:00', resolvedOffset: '+14:00', warning: null } });
    expect(ms(d30.resolution.resolvedStartAt)).toBe(ms(d31.resolution.resolvedStartAt));
    expect(preview.warnings).toContain('skipped_local_date');

    const series = await owner.createSeries(project.id, { ...input, previewHash: preview.previewHash });
    const headers = await owner.instances(series.id, week.id);
    expect(headers.map(i => i.occurrenceKey)).toEqual(['2011-12-29', '2011-12-30', '2011-12-31']);
    expect(new Set(headers.map(i => i.id)).size).toBe(3);
    expect(await owner.materialize(week.id, {})).toMatchObject({ status: 'complete', createdCount: 3 });
    const real = (await owner.instances(series.id, week.id)).map(located);
    expect(new Set(real.map(i => i.meetingId)).size).toBe(3);
    const skippedDate = await owner.meeting(byKey(real, '2011-12-30').taskId), nextDate = await owner.meeting(byKey(real, '2011-12-31').taskId);
    expect(skippedDate.id).not.toBe(nextDate.id);
    expect(ms(skippedDate.plannedStartAt)).toBe(ms(nextDate.plannedStartAt));
    expect([skippedDate.recurrence?.occurrenceKey, nextDate.recurrence?.occurrenceKey]).toEqual(['2011-12-30', '2011-12-31']);
  });

  it('rejects ambiguous overlapping periods without writes, leaves unbound dates unprepared and binds a later explicit period', async () => {
    const { project, todo } = await planningProject(owner, 'Явный выбор недели');
    const a = await explicitWeek(owner, project.id, '2026-10-19');
    const overlapping = await explicitWeek(owner, project.id, '2026-10-20');
    const c = await explicitWeek(owner, project.id, '2026-10-26');
    const schedule: RecurrenceScheduleInput = { ...daily('2026-10-21', 1), end: { kind: 'on_date', endDate: '2026-11-03' } };
    const input = { schedule, template: template(todo.id, [M.teamOwner, M.teamMemberA]), targetPeriodIds: [a.id] };
    const before = await databaseSnapshot(h.db.sql);
    expectError(await owner.post(P.createPreview(project.id), { ...input, targetPeriodIds: [a.id, overlapping.id] }, null), ...AMBIGUOUS_PERIODS);
    expect(await databaseSnapshot(h.db.sql)).toEqual(before);

    const { preview, series } = await owner.create(project.id, input);
    const inA = ['2026-10-21', '2026-10-22', '2026-10-23', '2026-10-24', '2026-10-25'];
    expect(preview.candidates).toHaveLength(14);
    expect(preview.candidates.filter(x => x.periodId === a.id).map(x => x.occurrenceKey)).toEqual(inA);
    expect(preview.candidates.filter(x => x.periodId === null)).toHaveLength(9);
    expect(preview).toMatchObject({ unboundCandidateCount: 9, periods: [{ periodId: a.id, candidateCount: 5 }] });
    expect(series).toMatchObject({ boundPeriodIds: [a.id], boundPeriodCount: 1, nominalCandidateCount: 14 });
    expect((await owner.instances(series.id, a.id)).map(i => i.occurrenceKey)).toEqual(inA);

    expect(await owner.readiness(c.id)).toMatchObject({ state: 'complete', missingCount: 0, bindings: [] });
    expect(await owner.materialize(c.id, {})).toMatchObject({ status: 'complete', createdCount: 0, remainingCount: 0, bindings: [], truncated: false });
    expect(await owner.periodMeetings(project.id, c.id)).toEqual([]);

    const inC = ['2026-10-26', '2026-10-27', '2026-10-28', '2026-10-29', '2026-10-30', '2026-10-31', '2026-11-01'];
    const periodPreview = await owner.previewPeriods(series.id, { expectedRevision: series.revision, periodIds: [c.id] });
    expect(periodPreview.periods).toEqual([{ periodId: c.id, periodRevision: c.revision, candidateCount: 7 }]);
    expect(periodPreview.candidates.filter(x => x.periodId === c.id).map(x => x.occurrenceKey)).toEqual(inC);
    const added = await owner.addPeriods(series.id, { expectedRevision: series.revision, periodIds: [c.id], previewHash: periodPreview.previewHash });
    expect(added.series).toMatchObject({ id: series.id, boundPeriodCount: 2 });
    expect([...added.series.boundPeriodIds].sort()).toEqual([a.id, c.id].sort());
    expect(added.bindings.find(b => b.periodId === c.id)).toMatchObject({ seriesId: series.id, state: 'pending', headerCount: 7, materializedCount: 0, missingCount: 7, cancelledHeaderOnlyCount: 0 });
    expect((await owner.instances(series.id, c.id)).map(i => i.occurrenceKey)).toEqual(inC);
    expect(await owner.materialize(c.id, {})).toMatchObject({ status: 'complete', createdCount: 7 });
    expect(await owner.periodMeetings(project.id, a.id)).toEqual([]);
  });

  it('never rebinds an assigned key to an overlapping period even after cancel, and rejects a cross-period move whole', async () => {
    const { project, todo } = await planningProject(owner, 'Неизменная привязка ключа');
    const c = await explicitWeek(owner, project.id, '2026-10-26');
    const overlapping = await explicitWeek(owner, project.id, '2026-10-27');
    const after = await explicitWeek(owner, project.id, '2026-11-02');
    const { series } = await owner.create(project.id, { schedule: { ...daily('2026-10-27', 1), end: { kind: 'on_date', endDate: '2026-11-01' } }, template: template(todo.id, [M.teamOwner]), targetPeriodIds: [c.id] });
    const headers = await owner.instances(series.id, c.id);
    expect(headers).toHaveLength(6);
    const cancelled = (await owner.exception(byKey(headers, '2026-10-28'), { kind: 'skip', reason: 'Отмена до подготовки' })).applied;
    expect(cancelled).toMatchObject({ calendarState: 'cancelled', meetingId: null, plannedPeriodId: c.id });

    const fresh = await owner.series(series.id);
    const before = await databaseSnapshot(h.db.sql);
    expectError(await owner.post(P.periodPreview(series.id), { expectedRevision: fresh.revision, periodIds: [overlapping.id] }, null), ...BINDING_CONFLICT);
    expect(await databaseSnapshot(h.db.sql)).toEqual(before);
    expect(byKey(await owner.instances(series.id, c.id), '2026-10-28')).toEqual(cancelled);

    await owner.materialize(c.id, {});
    const thursday = located(byKey(await owner.instances(series.id, c.id), '2026-10-29'));
    const latest = await owner.series(series.id);
    const move = { kind: 'move', localDate: '2026-11-03', localTime: '10:00', reason: 'Попытка уйти в другую неделю', expectedSeriesRevision: latest.revision, expectedInstanceRevision: thursday.revision } as const;
    const movePreview = await owner.previewException(series.id, thursday.occurrenceKey, move);
    expect(movePreview.protectedReasons).toContain('cross_period');
    const unchanged = await databaseSnapshot(h.db.sql);
    expectError(await owner.post(P.exception(series.id, thursday.occurrenceKey), { ...move, previewHash: movePreview.previewHash }), ...CROSS_PERIOD_MOVE);
    expect(await databaseSnapshot(h.db.sql)).toEqual(unchanged);
    expect(await owner.periodMeetings(project.id, after.id)).toEqual([]);
    expect((await owner.meeting(thursday.taskId)).plannedPeriodId).toBe(c.id);
  });

  it('refuses stale create/edit previews after a concurrent period edit or materialization with full state unchanged', async () => {
    const { project, todo } = await planningProject(owner, 'Устаревший предпросмотр серии');
    let week = await explicitWeek(owner, project.id, '2026-11-02');
    const input = { schedule: daily('2026-11-03', 3), template: template(todo.id, ROSTER), targetPeriodIds: [week.id] };
    const stale = await owner.previewCreate(project.id, input);
    week = await owner.updatePeriod(week.id, { expectedRevision: week.revision, name: uniqueName('Переименованная неделя') });
    const before = await databaseSnapshot(h.db.sql);
    expectError(await owner.post(P.create(project.id), { ...input, previewHash: stale.previewHash }), 409, 'PREVIEW_STALE');
    expect(await databaseSnapshot(h.db.sql)).toEqual(before);

    const { preview, series } = await owner.create(project.id, input);
    expect(preview.periods).toEqual([{ periodId: week.id, periodRevision: week.revision, candidateCount: 3 }]);
    const edit = { expectedRevision: series.revision, effectiveFromNominalDate: '2026-11-03', schedule: input.schedule, template: { ...input.template, title: 'Обновлённая повестка' } };
    const editPreview = await owner.previewEdit(series.id, edit);
    expect(await owner.materialize(week.id, {})).toMatchObject({ status: 'complete', createdCount: 3 });
    // Materialization changes the preview's output state, not the series revision the edit expects.
    expect((await owner.series(series.id)).revision).toBe(series.revision);
    const materialized = await databaseSnapshot(h.db.sql);
    expectError(await owner.post(P.edit(series.id), { ...edit, previewHash: editPreview.previewHash }), 409, 'PREVIEW_STALE');
    expect(await databaseSnapshot(h.db.sql)).toEqual(materialized);
    const fresh = await owner.previewEdit(series.id, edit);
    const edited = await owner.editSeries(series.id, { ...edit, previewHash: fresh.previewHash });
    expect(edited.currentVersion.template.title).toBe('Обновлённая повестка');
  });

  it('checks current ACL before keyed replay, rejects key reuse for another body/target, and hides foreign series', async () => {
    const { project, todo } = await planningProject(owner, 'Права и повтор серии');
    const other = await planningProject(owner, 'Другая цель того же ключа');
    const week = await explicitWeek(owner, project.id, '2026-11-02');
    const input = { schedule: daily('2026-11-04', 2), template: template(todo.id, ROSTER, M.teamMemberA), targetPeriodIds: [week.id] };
    const preview = await member.previewCreate(project.id, input);
    const body = { ...input, previewHash: preview.previewHash };
    const membership = await membershipRow(h.db.sql, TEAM, M.teamMemberA);
    await revokeMembership(h.db.sql, TEAM, M.teamMemberA);
    try {
      const revoked = await databaseSnapshot(h.db.sql);
      expectError(await member.post(P.create(project.id), body), 404, 'NOT_FOUND');
      expect(await databaseSnapshot(h.db.sql)).toEqual(revoked);
    } finally { await restoreMembership(h.db.sql, TEAM, M.teamMemberA, membership); }

    const key = randomUUID();
    const series = await member.createSeries(project.id, body, key);
    expect(series.generation).toMatchObject({ authorizerMembershipId: M.teamMemberA, state: 'ready' });
    const stored = await databaseSnapshot(h.db.sql);
    expect(await member.createSeries(project.id, body, key)).toEqual(series);
    expect(await databaseSnapshot(h.db.sql)).toEqual(stored);
    expectError(await member.post(P.create(project.id), { ...body, template: { ...body.template, title: 'Другое тело запроса' } }, key), 409, 'IDEMPOTENCY_KEY_REUSED');
    expectError(await member.post(P.create(other.project.id), body, key), 409, 'IDEMPOTENCY_KEY_REUSED');
    expect(await databaseSnapshot(h.db.sql)).toEqual(stored);

    await revokeMembership(h.db.sql, TEAM, M.teamMemberA);
    try {
      const revoked = await databaseSnapshot(h.db.sql);
      expectError(await member.post(P.create(project.id), body, key), 404, 'NOT_FOUND');
      expectError(await member.get(P.series(series.id)), 404, 'NOT_FOUND');
      expect(await databaseSnapshot(h.db.sql)).toEqual(revoked);
    } finally { await restoreMembership(h.db.sql, TEAM, M.teamMemberA, membership); }
    expect(await member.createSeries(project.id, body, key)).toEqual(series);

    const header = one((await owner.instances(series.id, week.id)).filter(i => i.occurrenceKey === '2026-11-04'));
    const viewerPreview = await owner.previewCreate(project.id, input);
    expect(await viewer.series(series.id)).toEqual(await owner.series(series.id));
    expectError(await viewer.post(P.create(project.id), { ...input, previewHash: viewerPreview.previewHash }), 403, 'CAPABILITY_REQUIRED');
    expectError(await viewer.post(P.materialize(week.id), {}), 403, 'CAPABILITY_REQUIRED');
    expectError(await viewer.post(P.exception(series.id, header.occurrenceKey), { kind: 'skip', reason: 'Чужая отмена', expectedSeriesRevision: series.revision, expectedInstanceRevision: header.revision, previewHash: viewerPreview.previewHash }), 403, 'CAPABILITY_REQUIRED');
    const foreign = new P3bClient(h.outsider.api, TEAM);
    expectError(await foreign.get(P.series(series.id)), 404, 'NOT_FOUND', [input.template.title]);
    expectError(await foreign.get(P.readiness(week.id)), 404, 'NOT_FOUND');
    expectError(await outsider.get(P.series(series.id)), 404, 'NOT_FOUND', [input.template.title]);
    expectError(await outsider.post(P.materialize(week.id), {}), 404, 'NOT_FOUND');
    expect(await databaseSnapshot(h.db.sql)).toEqual(stored);
  });

  it('pauses only background preparation: sync materialize and freeze still pin the paused census without implied plans', async () => {
    const { project, todo } = await planningProject(owner, 'Приостановленная серия в фиксации');
    const week = await explicitWeek(owner, project.id, '2026-11-09');
    const { series } = await owner.create(project.id, { schedule: { ...WEEKDAYS, startDate: '2026-11-09', localTime: '09:30', weekdays: [1, 3, 5], plannedDurationMinutes: 60, end: { kind: 'after_count', count: 3 } }, template: template(todo.id, [M.teamOwner, M.teamMemberA]), targetPeriodIds: [week.id] });
    const createdSeq = (await databaseSnapshot(h.db.sql)).changeSeq[TEAM] ?? '0';
    expect(await owner.setSeriesState(series.id, { expectedRevision: series.revision, state: 'paused' })).toMatchObject({ id: series.id, state: 'paused' });
    expect(await materializationRequests(h.db.sql, TEAM, createdSeq)).toEqual([]);
    expect(await owner.readiness(week.id)).toMatchObject({ state: 'pending', missingCount: 3 });
    const missing = await databaseSnapshot(h.db.sql);
    expectError(await owner.post(`/periods/${week.id}/freeze-preview`, { scope: 'project' }, null), 409, 'MATERIALIZATION_REQUIRED');
    expect(await databaseSnapshot(h.db.sql)).toEqual(missing);

    const materialized = await owner.materialize(week.id, {});
    expect(materialized).toMatchObject({ status: 'complete', createdCount: 3, remainingCount: 0, frozenBaselineIds: [] });
    const real = (await owner.instances(series.id, week.id)).map(located);
    const first = byKey(real, '2026-11-09');
    const plans = await applyPlan(owner, first.taskId, [{ membershipId: M.teamOwner, plannedMinutes: 60 }, { membershipId: M.teamMemberA, plannedMinutes: null }]);
    expect(plans.commitments).toHaveLength(2);
    expect(await owner.commitments(week.id)).toHaveLength(2);

    const baseline = await owner.freeze(week.id);
    expect(baseline.snapshot.recurrence).toMatchObject({ schemaVersion: 1, policyVersion: RECURRENCE_RESOLUTION_POLICY,
      bindings: [{ bindingId: first.bindingId, seriesId: series.id, seriesState: 'paused', sourceManifestHash: one(materialized.bindings).sourceManifestHash }] });
    expect(baseline.snapshot.recurrence?.bindings[0]?.seriesVersionIds).toContain(series.currentVersion.id);
    expect([...(baseline.snapshot.recurrence?.census ?? [])].sort((x, y) => x.occurrenceKey.localeCompare(y.occurrenceKey))).toEqual(real.map(i => expect.objectContaining({
      instanceId: i.id, seriesId: series.id, bindingId: i.bindingId, occurrenceKey: i.occurrenceKey, nominalSequence: i.nominalSequence, sourceVersionId: i.sourceVersionId,
      calendarState: 'scheduled', meetingId: i.meetingId, taskId: i.taskId, workPackageId: i.workPackageId,
    })));
    expect(baseline.snapshot.commitments.map(c => [c.membershipId, c.plannedMinutes, c.workPackageId]).sort()).toEqual([[M.teamMemberA, null, first.workPackageId], [M.teamOwner, 60, first.workPackageId]].sort());
    for (const instance of real) expect((await owner.meeting(instance.taskId)).scheduleFrozen).toBe(true);
    const pinned = await owner.report({ baselineId: baseline.id });
    expect(pinned.summary).toMatchObject({ knownPlannedMinutes: 60, actualMinutes: 0, baselineCompleteness: { knownItemCount: 1, totalItemCount: 2, complete: false } });
    expect((await owner.reportRows(pinned.id)).find(row => row.membershipId === M.teamMemberA)).toMatchObject({ scope: 'original', plannedMinutes: null, factRecorded: false });

    await attend(owner, first.taskId, week.id, M.teamOwner, 60);
    const late = await owner.create(project.id, { schedule: { ...WEEKDAYS, startDate: '2026-11-10', localTime: '14:00', weekdays: [2, 4], plannedDurationMinutes: 60, end: { kind: 'after_count', count: 2 } }, template: template(todo.id, [M.teamOwner]), targetPeriodIds: [week.id] });
    expect(await owner.materialize(week.id, {})).toMatchObject({ status: 'complete', createdCount: 2, frozenBaselineIds: [] });
    const lateReal = (await owner.instances(late.series.id, week.id)).map(located);
    const planned = byKey(lateReal, '2026-11-10'), withoutPlan = byKey(lateReal, '2026-11-12');
    expect((await applyPlan(owner, planned.taskId, [{ membershipId: M.teamOwner, plannedMinutes: 30 }])).commitments).toMatchObject([{ classification: 'added', baselineIds: [], plannedMinutes: 30 }]);
    await attend(owner, planned.taskId, week.id, M.teamOwner, 30);
    await attend(owner, withoutPlan.taskId, week.id, M.teamOwner, 45);
    expect((await owner.report({ baselineId: baseline.id })).summary).toMatchObject({ knownPlannedMinutes: 60, actualMinutes: 60, addedActualMinutes: 75, unplannedActualMinutes: 0, totalActualMinutes: 135 });
    expect(await owner.baseline(baseline.id)).toEqual(baseline);
    expect(await owner.getReport(pinned.id)).toEqual(pinned);
  });

  it('keeps a cancelled never-materialized header out of missing/cap counts but frozen in census and protected despite null locators', async () => {
    const { project, todo } = await planningProject(owner, 'Отменённый заголовок без встречи');
    const week = await explicitWeek(owner, project.id, '2026-11-16');
    const { series } = await owner.create(project.id, { schedule: daily('2026-11-17', 4, '11:00'), template: template(todo.id, [M.teamOwner]), targetPeriodIds: [week.id] });
    const headers = await owner.instances(series.id, week.id);
    expect(headers.map(i => i.occurrenceKey)).toEqual(['2026-11-17', '2026-11-18', '2026-11-19', '2026-11-20']);
    const cancelled = (await owner.exception(byKey(headers, '2026-11-18'), { kind: 'skip', reason: 'Отмена до подготовки' })).applied;
    expect(cancelled).toMatchObject({ id: byKey(headers, '2026-11-18').id, calendarState: 'cancelled', meetingId: null, taskId: null, workPackageId: null });
    const ready = await owner.readiness(week.id);
    expect(ready).toMatchObject({ state: 'pending', missingCount: 3 });
    expect(one(ready.bindings).remainingCount).toBe(3);

    const firstChunk = await owner.materialize(week.id, { limit: 2 });
    expect(firstChunk).toMatchObject({ status: 'pending', createdCount: 2, remainingCount: 1, frozenBaselineIds: [], truncated: false });
    const lastChunk = await owner.materialize(week.id, { limit: 2, cursor: cursorOf(firstChunk) });
    expect(lastChunk).toMatchObject({ status: 'complete', createdCount: 1, remainingCount: 0, nextCursor: null, truncated: false });
    expectStableManifests(ready.bindings, [...firstChunk.bindings, ...lastChunk.bindings]);
    expect(await owner.instances(series.id, week.id, false)).toHaveLength(3);
    expect(byKey(await owner.instances(series.id, week.id), '2026-11-18')).toEqual(cancelled);
    expect(await owner.periodMeetings(project.id, week.id)).toHaveLength(3);

    const baseline = await owner.freeze(week.id);
    const census = baseline.snapshot.recurrence?.census ?? [];
    expect(census).toHaveLength(4);
    expect(byKey(census, '2026-11-18')).toMatchObject({ instanceId: cancelled.id, calendarState: 'cancelled', exceptionVersionId: cancelled.exception?.versionId,
      meetingId: null, taskId: null, workPackageId: null, meetingRevision: null, participantsRevision: null });

    const frozenSeries = await owner.series(series.id);
    const restore = { kind: 'restore', reason: 'Попытка вернуть после фиксации', expectedSeriesRevision: frozenSeries.revision, expectedInstanceRevision: cancelled.revision } as const;
    const restorePreview = await owner.previewException(series.id, cancelled.occurrenceKey, restore);
    expect(restorePreview.protectedReasons).toContain('schedule_frozen');
    const before = await databaseSnapshot(h.db.sql);
    expectError(await owner.post(P.exception(series.id, cancelled.occurrenceKey), { ...restore, previewHash: restorePreview.previewHash }), ...PROTECTED_TARGET);
    await expectOnlyIdempotency(h.db.sql, before);

    const edit = { expectedRevision: frozenSeries.revision, effectiveFromNominalDate: '2026-11-17', schedule: daily('2026-11-17', 4, '11:00'), template: template(todo.id, [M.teamOwner], M.teamOwner, 'Изменение после фиксации') };
    const editPreview = await owner.previewEdit(series.id, edit);
    // A manual skip retains its old resolution/source version; title-only regeneration has no effect
    // on its header. Changed scheduled peers remain protected, and explicit restore above is blocked.
    expect(editPreview.impacts.find(i => i.instanceId === cancelled.id)).toMatchObject({ occurrenceKey: '2026-11-18', action: 'retain' });
    expect(editPreview.protectedTargets.some(t => t.reasons.includes('schedule_frozen'))).toBe(true);
    const editBefore = await databaseSnapshot(h.db.sql);
    expectError(await owner.post(P.edit(series.id), { ...edit, previewHash: editPreview.previewHash }), ...PROTECTED_TARGET);
    await expectOnlyIdempotency(h.db.sql, editBefore);
    expect(byKey(await owner.instances(series.id, week.id), '2026-11-18')).toEqual(cancelled);
    expect(await owner.baseline(baseline.id)).toEqual(baseline);
  });

  it('completes a bounded overdue census and freezes it atomically before allowing an ordinary task creation', async () => {
    const { project, todo } = await planningProject(owner, 'Ограниченная синхронная фиксация');
    const week = await explicitWeek(owner, project.id, '2026-12-21', 'UTC');
    const { series } = await owner.create(project.id, { schedule: daily('2026-12-21', 3, '10:00', 'UTC'), template: template(todo.id, [M.teamOwner]), targetPeriodIds: [week.id] });
    expect(await owner.readiness(week.id)).toMatchObject({ missingCount: 3, state: 'pending' });
    const due = await owner.updatePeriod(week.id, { expectedRevision: week.revision, cutoffAt: await pgClockPlus(h.db.sql, -60_000) });
    expect(due.state).toBe('planning');
    const created = await owner.tasks.createTask({ projectId: project.id, statusId: todo.id, title: 'Новая работа после исходного снимка' });
    const frozen = await owner.getPeriod(week.id);
    expect(frozen.state).toBe('frozen');
    if (!frozen.projectBaselineId) throw new Error('Synchronous cutoff baseline required.');
    const baseline = await owner.baseline(frozen.projectBaselineId);
    const headers = (await owner.instances(series.id, week.id)).map(located);
    expect(headers).toHaveLength(3);
    expect(baseline.snapshot.recurrence?.census).toHaveLength(3);
    expect(baseline.snapshot.projectPackageIds).not.toContain(created.workPackageId);
    expect([...baseline.snapshot.projectPackageIds].sort()).toEqual(headers.map(i => i.workPackageId).sort());
    expect(baseline.snapshot.commitments).toEqual([]);
    expect(await owner.readiness(week.id)).toMatchObject({ missingCount: 0, state: 'complete' });
    expect(await owner.recordedWork(week.id)).toEqual([]);
  });

  it('rolls back a late SQL fault of create and of materialize as a whole, then the exact retry commits once', async () => {
    const { project, todo } = await planningProject(owner, 'Откат создания серии');
    const week = await explicitWeek(owner, project.id, '2026-12-14');
    const input = { schedule: daily('2026-12-15', 3), template: template(todo.id, [M.teamOwner, M.teamMemberA]), targetPeriodIds: [week.id] };
    const preview = await owner.previewCreate(project.id, input);
    const createBody = { ...input, previewHash: preview.previewHash }, createKey = randomUUID(), materializeKey = randomUUID();
    const fault = 'synthetic recurrence late fault';
    async function withLateFault(run: () => Promise<void>) {
      await h.db.sql.unsafe(`create function qa_p3b_late_fault() returns trigger language plpgsql as $$ begin raise exception '${fault}'; end $$`);
      await h.db.sql.unsafe('create trigger qa_p3b_late_fault before insert on command_idempotency for each row execute function qa_p3b_late_fault()');
      try { await run(); } finally {
        await h.db.sql.unsafe('drop trigger qa_p3b_late_fault on command_idempotency');
        await h.db.sql.unsafe('drop function qa_p3b_late_fault()');
      }
    }
    await withLateFault(async () => {
      const before = await databaseSnapshot(h.db.sql);
      expectError(await owner.post(P.create(project.id), createBody, createKey), 500, 'INTERNAL_ERROR', [fault]);
      expect(await databaseSnapshot(h.db.sql)).toEqual(before);
    });
    const series = expectEnvelope(await owner.post(P.create(project.id), createBody, createKey), 201, recurrenceSeriesResponseSchema).data;
    expect(await owner.listSeries(project.id)).toEqual([series]);
    const headers = await owner.instances(series.id, week.id);
    expect(headers).toHaveLength(3);

    await withLateFault(async () => {
      const before = await databaseSnapshot(h.db.sql);
      expectError(await owner.post(P.materialize(week.id), {}, materializeKey), 500, 'INTERNAL_ERROR', [fault]);
      expect(await databaseSnapshot(h.db.sql)).toEqual(before);
    });
    expect(await owner.instances(series.id, week.id)).toEqual(headers);
    const [first, second] = await Promise.all([owner.post(P.materialize(week.id), {}, materializeKey), replica.post(P.materialize(week.id), {}, materializeKey)]);
    if (!first || !second) throw new Error('Both concurrent responses required.');
    const result = expectEnvelope(first, 200, recurrenceMaterializationResultResponseSchema).data;
    expect(expectEnvelope(second, 200, recurrenceMaterializationResultResponseSchema).data).toEqual(result);
    expect(result).toMatchObject({ status: 'complete', createdCount: 3, remainingCount: 0 });
    const real = (await owner.instances(series.id, week.id)).map(located);
    expect(real.map(i => i.id)).toEqual(headers.map(i => i.id));
    expect(new Set(real.map(i => i.meetingId)).size).toBe(3);
    expect(await owner.periodMeetings(project.id, week.id)).toHaveLength(3);
  });
});

describe('P3b overdue recovery and stored generation authority over real HTTP/PostgreSQL', () => {
  let h: PlanningHarness;
  let owner: P3bClient, replica: P3bClient, member: P3bClient;
  beforeAll(async () => {
    h = await planningHarness('p3b_overdue');
    ({ owner, replica, member } = p3bClients(h));
  });
  afterAll(async () => { await h?.close(); });

  it('advances two overdue >100 periods independently by signed cursors; only each final chunk freezes its own period', { timeout: 120_000 }, async () => {
    const { project, todo } = await planningProject(owner, 'Две просроченные недели');
    const a = await explicitWeek(owner, project.id, '2026-11-02', 'UTC');
    const b = await explicitWeek(owner, project.id, '2026-11-09', 'UTC');
    for (let n = 1; n <= 16; n++) {
      await owner.create(project.id, { schedule: daily('2026-11-02', 14, '10:00', 'Europe/Berlin', 15), template: template(todo.id, [M.teamOwner], M.teamOwner, `Ежедневная серия ${n}`), targetPeriodIds: [a.id, b.id] });
    }
    const extra = (await owner.create(project.id, { schedule: daily('2026-11-08', 2, '10:00', 'Europe/Berlin', 15), template: template(todo.id, [M.teamOwner], M.teamOwner, 'Отменённые заголовки'), targetPeriodIds: [a.id, b.id] })).series;
    for (const periodId of [a.id, b.id]) {
      const skipped = (await owner.exception(one(await owner.instances(extra.id, periodId)), { kind: 'skip', reason: 'Отмена до подготовки' })).applied;
      expect(skipped).toMatchObject({ calendarState: 'cancelled', meetingId: null });
    }
    const readyA = await owner.readiness(a.id), readyB = await owner.readiness(b.id);
    for (const ready of [readyA, readyB]) {
      expect(ready).toMatchObject({ state: 'pending', missingCount: 112, blockedCount: 0, truncated: false });
      expect(ready.bindings).toHaveLength(17);
    }

    const cutoff = await pgClockPlus(h.db.sql, 8_000);
    const dueA = await owner.updatePeriod(a.id, { expectedRevision: a.revision, cutoffAt: cutoff });
    const dueB = await owner.updatePeriod(b.id, { expectedRevision: b.revision, cutoffAt: cutoff });
    expect(await pgClockBefore(h.db.sql, cutoff), 'both cutoff updates committed before the cutoff').toBe(true);
    expect([ms(dueA.cutoffAt), ms(dueB.cutoffAt)]).toEqual([ms(cutoff), ms(cutoff)]);
    await waitPastPgClock(h.db.sql, cutoff);

    const ordinary = { projectId: project.id, statusId: todo.id, title: 'Обычная запись в просроченном проекте' };
    const blocked = await databaseSnapshot(h.db.sql);
    expectError(await owner.post('/tasks', ordinary), 409, 'MATERIALIZATION_REQUIRED');
    expectError(await owner.post(`/periods/${a.id}/freeze-preview`, { scope: 'project' }, null), 409, 'MATERIALIZATION_REQUIRED');
    await expectOnlyIdempotency(h.db.sql, blocked);
    expect((await owner.tasks.listTasksPage({ projectId: project.id })).items).toEqual([]);

    const keyA1 = randomUUID();
    const beforeA1 = await databaseSnapshot(h.db.sql);
    const a1 = await owner.materialize(a.id, { limit: 100 }, keyA1);
    expect(a1).toMatchObject({ periodId: a.id, status: 'pending', createdCount: 100, remainingCount: 12, frozenBaselineIds: [], truncated: false });
    expectStableManifests(readyA.bindings, a1.bindings);
    const continuation = await materializationRequests(h.db.sql, TEAM, beforeA1.changeSeq[TEAM] ?? '0');
    // Explicit recovery returns a signed cursor for the next user click. It does not enqueue
    // a second background request; worker-pending continuation is a separate same-UOW guarantee.
    expect(continuation).toEqual([]);

    const b1 = await owner.materialize(b.id, { limit: 100 });
    expect(b1).toMatchObject({ periodId: b.id, status: 'pending', createdCount: 100, remainingCount: 12, frozenBaselineIds: [], truncated: false });
    expectStableManifests(readyB.bindings, b1.bindings);
    expect((await owner.getPeriod(a.id)).state).toBe('planning');

    const a2 = await owner.materialize(a.id, { limit: 12, cursor: cursorOf(a1) });
    expect(a2).toMatchObject({ periodId: a.id, status: 'complete', createdCount: 12, remainingCount: 0, nextCursor: null, truncated: false });
    expectStableManifests(readyA.bindings, a2.bindings);
    const frozenA = await owner.getPeriod(a.id);
    if (frozenA.projectBaselineId === null) throw new Error('Final chunk must freeze period A.');
    expect(frozenA.state).toBe('frozen');
    expect(a2.frozenBaselineIds).toContain(frozenA.projectBaselineId);
    expect(await owner.getPeriod(b.id)).toMatchObject({ state: 'planning', projectBaselineId: null });
    expect(await owner.baselines(b.id)).toEqual([]);
    const beforeBPreview = await databaseSnapshot(h.db.sql);
    expectError(await owner.post(`/periods/${b.id}/freeze-preview`, { scope: 'project' }, null), 409, 'MATERIALIZATION_REQUIRED');
    expect(await databaseSnapshot(h.db.sql)).toEqual(beforeBPreview);

    const b2 = await owner.materialize(b.id, { limit: 12, cursor: cursorOf(b1) });
    expect(b2).toMatchObject({ periodId: b.id, status: 'complete', createdCount: 12, remainingCount: 0, nextCursor: null, truncated: false });
    expectStableManifests(readyB.bindings, b2.bindings);
    const frozenB = await owner.getPeriod(b.id);
    if (frozenB.projectBaselineId === null) throw new Error('Final chunk must freeze period B.');
    expect(b2.frozenBaselineIds).toContain(frozenB.projectBaselineId);
    expect(a2.frozenBaselineIds).not.toContain(frozenB.projectBaselineId);

    for (const [period, baselineId, ready] of [[a, frozenA.projectBaselineId, readyA], [b, frozenB.projectBaselineId, readyB]] as const) {
      const baseline = await owner.baseline(baselineId);
      expect(baseline).toMatchObject({ periodId: period.id, scope: 'project', mode: 'cutoff' });
      const census = baseline.snapshot.recurrence?.census ?? [];
      expect(census).toHaveLength(113);
      expect(new Set(census.map(e => e.instanceId)).size).toBe(113);
      expect(census.filter(e => e.calendarState === 'cancelled')).toEqual([expect.objectContaining({ seriesId: extra.id, meetingId: null, taskId: null, workPackageId: null })]);
      expect(hashes(baseline.snapshot.recurrence?.bindings ?? [])).toEqual(hashes(ready.bindings));
    }
    const meetingsA = await owner.periodMeetings(project.id, a.id), meetingsB = await owner.periodMeetings(project.id, b.id);
    expect([meetingsA.length, meetingsB.length]).toEqual([112, 112]);
    const all = [...meetingsA, ...meetingsB];
    for (const ids of [all.map(x => x.meeting.id), all.map(x => x.task.id), all.map(x => x.meeting.workPackageId)]) expect(new Set(ids).size).toBe(224);
    expect(await owner.allPackages(project.id)).toHaveLength(224);

    const settled = await databaseSnapshot(h.db.sql);
    expect(await replica.materialize(a.id, { limit: 100 }, keyA1)).toEqual(a1);
    expect(await databaseSnapshot(h.db.sql)).toEqual(settled);
    expect(await owner.tasks.createTask(ordinary)).toMatchObject({ projectId: project.id });
  });

  it('blocks only the revoked authorizer’s overdue period until an owner reauthorizes ahead of the prerequisite', { timeout: 60_000 }, async () => {
    const { project, todo } = await planningProject(owner, 'Отозванный автор серии');
    const unrelated = await planningProject(owner, 'Независимый проект');
    const week = await explicitWeek(owner, project.id, '2026-11-23', 'UTC');
    const input = { schedule: { ...WEEKDAYS, startDate: '2026-11-23', localTime: '13:00', weekdays: [1, 2], plannedDurationMinutes: 30, end: { kind: 'after_count', count: 2 } } satisfies RecurrenceScheduleInput,
      template: template(todo.id, [M.teamOwner, M.teamMemberB], M.teamMemberB), targetPeriodIds: [week.id] };
    const preview = await member.previewCreate(project.id, input);
    const key = randomUUID(); const body = { ...input, previewHash: preview.previewHash };
    const authored = await member.createSeries(project.id, body, key);
    expect(authored.generation).toMatchObject({ authorizerMembershipId: M.teamMemberA, state: 'ready', blockedCode: null });
    const cutoff = await pgClockPlus(h.db.sql, 3_000);
    await owner.updatePeriod(week.id, { expectedRevision: week.revision, cutoffAt: cutoff });
    const membership = await membershipRow(h.db.sql, TEAM, M.teamMemberA);
    await revokeMembership(h.db.sql, TEAM, M.teamMemberA);
    try {
      await waitPastPgClock(h.db.sql, cutoff);
      const blocked = await owner.readiness(week.id);
      expect(blocked).toMatchObject({ state: 'blocked' });
      expect(blocked.blockedCount).toBeGreaterThan(0);
      expect(blocked.bindings).toMatchObject([{ seriesId: authored.id, state: 'blocked', blockedCode: 'authorizer_inactive' }]);
      const stale = await owner.series(authored.id);
      expect(stale.generation).toMatchObject({ authorizerMembershipId: M.teamMemberA, state: 'blocked', blockedCode: 'authorizer_inactive' });

      const before = await databaseSnapshot(h.db.sql);
      expectError(await owner.post(`/periods/${week.id}/freeze-preview`, { scope: 'project' }, null), 409, 'MATERIALIZATION_REQUIRED');
      expectError(await owner.post('/tasks', { projectId: project.id, statusId: todo.id, title: 'Запись в затронутом проекте' }), 409, 'MATERIALIZATION_REQUIRED');
      expectError(await member.post(P.create(project.id), body, key), 404, 'NOT_FOUND');
      await expectOnlyIdempotency(h.db.sql, before);
      expect(await owner.tasks.createTask({ projectId: unrelated.project.id, statusId: unrelated.todo.id, title: 'Независимая запись' })).toMatchObject({ projectId: unrelated.project.id });

      const refused = await owner.materialize(week.id, {});
      expect(refused).toMatchObject({ status: 'blocked', createdCount: 0, frozenBaselineIds: [], truncated: false });
      expect(refused.bindings).toMatchObject([{ state: 'blocked', blockedCode: 'authorizer_inactive' }]);
      expect(await owner.periodMeetings(project.id, week.id)).toEqual([]);

      const reauthSeq = (await databaseSnapshot(h.db.sql)).changeSeq[TEAM] ?? '0';
      const reauthorized = await owner.authorizeGeneration(authored.id, { expectedRevision: stale.revision, expectedAuthorizationRevision: stale.generation.authorizationRevision });
      expect(reauthorized.generation).toMatchObject({ authorizerMembershipId: M.teamOwner, state: 'ready', blockedCode: null });
      expect(reauthorized.generation.authorizationRevision).not.toBe(stale.generation.authorizationRevision);
      expect(reauthorized.currentVersion).toEqual(stale.currentVersion);
      expect((await materializationRequests(h.db.sql, TEAM, reauthSeq)).map(e => e.payload)).toEqual([{
        seriesId: authored.id, bindingId: one(blocked.bindings).bindingId, sourceManifestHash: expect.any(String), authorizationRevision: reauthorized.generation.authorizationRevision,
      }]);

      const recovered = await owner.materialize(week.id, {});
      expect(recovered).toMatchObject({ status: 'complete', createdCount: 2, remainingCount: 0, truncated: false });
      const frozen = await owner.getPeriod(week.id);
      if (frozen.projectBaselineId === null) throw new Error('Recovered overdue period must freeze.');
      expect(recovered.frozenBaselineIds).toContain(frozen.projectBaselineId);
      expect((await owner.baseline(frozen.projectBaselineId)).snapshot.recurrence?.census).toHaveLength(2);
      for (const meeting of await owner.periodMeetings(project.id, week.id)) expect(meeting.meeting.organizerMembershipId).toBe(M.teamMemberB);
      expect(await owner.tasks.createTask({ projectId: project.id, statusId: todo.id, title: 'Запись после восстановления' })).toMatchObject({ projectId: project.id });
    } finally { await restoreMembership(h.db.sql, TEAM, M.teamMemberA, membership); }
    expect(await member.createSeries(project.id, body, key)).toEqual(authored);
    expect((await member.series(authored.id)).generation.authorizerMembershipId).toBe(M.teamOwner);
  });
});
