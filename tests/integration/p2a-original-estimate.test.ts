// Read-only original package estimate projection on actual API processes and an isolated PostgreSQL
// database. Auth is synthetic/local. The projection is separate from packages, snapshots and freeze hashes.
import { randomUUID } from 'node:crypto';

import { originalPackageEstimateResponseSchema, planBaselineResponseSchema, planningPackageSchema } from '@workloom/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { expectEnvelope, expectError } from './support/p1a.js';
import { databaseSnapshot, membershipRow, restoreMembership, revokeMembership } from './support/p1b.js';
import { commit, MEMBERS as M, period, planningHarness, planningProject, planningTask, TEAM, type PlanningHarness } from './support/p2a-fixture.js';
import { expectedOriginBaseline } from './support/original-estimate-oracle.js';
import { P2aClient } from './support/p2a.js';
import { requireTestDatabaseUrl } from './support/test-database-url.js';

requireTestDatabaseUrl();

const path = (packageId: string) => `/planning-packages/${packageId}/original-estimate`;
async function original(client: P2aClient, packageId: string) {
  return expectEnvelope(await client.get(path(packageId)), 200, originalPackageEstimateResponseSchema).data;
}
/** A project freeze first saves each member's personal freeze in the same barrier; that is the first related freeze. */
async function ownerPersonal(client: P2aClient, periodId: string) {
  const found = (await client.baselines(periodId)).find((item) => item.scope === 'self' && item.membershipId === M.teamOwner);
  if (!found) throw new Error('The owner personal baseline is missing.');
  return found;
}
function nextWeek(localStart: string): string {
  const next = new Date(`${localStart}T12:00:00Z`);
  next.setUTCDate(next.getUTCDate() + 7);
  return next.toISOString().slice(0, 10);
}

describe('P2a original package estimate read projection over HTTP on PostgreSQL', () => {
  let h: PlanningHarness;
  beforeAll(async () => { h = await planningHarness('p2a_original_estimate'); });
  afterAll(async () => { await h?.close(); });

  it('reports a fresh known current estimate as not captured yet, without writes', async () => {
    const { owner, viewer } = h;
    const { project } = await planningProject(owner, 'Оценка до фиксации');
    const task = await planningTask(owner, project, 480);
    await period(owner, project.id);
    const before = await databaseSnapshot(h.db.sql);
    const pending = await original(owner, task.workPackageId);
    expect(pending).toEqual({ state: 'not_captured_yet', workspaceId: TEAM, projectId: project.id, workPackageId: task.workPackageId });
    expect(await original(viewer, task.workPackageId.toUpperCase())).toEqual(pending);
    expect(await databaseSnapshot(h.db.sql)).toEqual(before);
  });

  it('keeps an unknown first observation unknown after an unprotected fill and a later known freeze', async () => {
    const { owner } = h;
    const { project } = await planningProject(owner, 'Неизвестный оригинал');
    let task = await planningTask(owner, project, null);
    const firstWeek = await period(owner, project.id, { protectEstimate: false });
    await commit(owner, firstWeek, task, 60);
    const first = await owner.freeze(firstWeek.id);
    const firstPersonal = await ownerPersonal(owner, firstWeek.id);
    expect(first.snapshot.sourcePersonalBaselineIds).toContain(firstPersonal.id);
    task = await owner.tasks.updateTask(task.id, { expectedRevision: task.revision, expectedWorkPackageRevision: task.workPackageRevision, estimateMinutes: 120 });
    expect(task.estimateMinutes).toBe(120);
    const secondWeek = await period(owner, project.id, { localStart: nextWeek(firstWeek.localStart) });
    await commit(owner, secondWeek, task, 60);
    const second = await owner.freeze(secondWeek.id);
    expect(second.snapshot.packages.find((item) => item.id === task.workPackageId)?.estimateMinutes).toBe(120);
    const unknown = await original(owner, task.workPackageId);
    expect(unknown).toEqual({
      state: 'original_unknown', workspaceId: TEAM, projectId: project.id, workPackageId: task.workPackageId,
      estimateMinutes: null, packageBaselineId: null,
      origin: { planBaselineId: firstPersonal.id, periodId: firstWeek.id, periodLocalStart: firstWeek.localStart, scope: 'self', mode: 'manual', frozenAt: firstPersonal.frozenAt, packageRevision: 1 },
    });
    expect(JSON.stringify(unknown)).not.toContain(second.id);
    const observations = await h.db.sql`select estimate_minutes, baseline_id from package_freeze_observations where work_package_id=${task.workPackageId}`;
    expect(observations).toEqual([{ estimate_minutes: null, baseline_id: firstPersonal.id }]);
  });

  it('captures a known zero with immutable first-freeze provenance and keeps it after the current estimate changes', async () => {
    const { owner } = h;
    const { project } = await planningProject(owner, 'Нулевой оригинал');
    let task = await planningTask(owner, project, 0);
    const week = await period(owner, project.id, { protectEstimate: false });
    await commit(owner, week, task, 0);
    await owner.freeze(week.id);
    const baseline = await ownerPersonal(owner, week.id);
    const pkg = (await owner.packages(project.id)).find((item) => item.id === task.workPackageId);
    expect(pkg?.packageBaselineId).not.toBeNull();
    const captured = await original(owner, task.workPackageId);
    expect(captured).toEqual({
      state: 'captured', workspaceId: TEAM, projectId: project.id, workPackageId: task.workPackageId,
      estimateMinutes: 0, packageBaselineId: pkg?.packageBaselineId, acceptedAt: baseline.frozenAt, provenance: 'first_known_plan_freeze',
      origin: { planBaselineId: baseline.id, periodId: week.id, periodLocalStart: week.localStart, scope: 'self', mode: 'manual', frozenAt: baseline.frozenAt, packageRevision: 1 },
    });
    expect(captured).toEqual(await original(owner, task.workPackageId));
    task = await owner.tasks.updateTask(task.id, { expectedRevision: task.revision, expectedWorkPackageRevision: task.workPackageRevision, estimateMinutes: 300 });
    expect(task.estimateMinutes).toBe(300);
    expect(await original(owner, task.workPackageId)).toEqual(captured);
    expect(await owner.packageBaseline(pkg?.packageBaselineId ?? '')).toMatchObject({ estimateMinutes: 0, sourceBaselineId: baseline.id });
  });

  it('keeps a non-owner personal freeze saved before the project freeze as the immutable earliest origin', async () => {
    const { owner, member } = h;
    const { project } = await planningProject(owner, 'Ранняя личная фиксация');
    let task = await planningTask(owner, project, 300);
    const week = await period(owner, project.id, { protectEstimate: false });
    await commit(owner, week, task, 120, M.teamMemberA);
    await commit(owner, week, task, 60, M.teamOwner);
    const memberSelf = await member.freeze(week.id, 'self');
    expect(memberSelf).toMatchObject({ scope: 'self', membershipId: M.teamMemberA, mode: 'manual' });
    const expected = {
      state: 'captured', workspaceId: TEAM, projectId: project.id, workPackageId: task.workPackageId, estimateMinutes: 300,
      acceptedAt: memberSelf.frozenAt, provenance: 'first_known_plan_freeze',
      origin: { planBaselineId: memberSelf.id, periodId: week.id, periodLocalStart: week.localStart, scope: 'self', mode: 'manual', frozenAt: memberSelf.frozenAt, packageRevision: task.workPackageRevision },
    };
    const early = await original(owner, task.workPackageId);
    expect(early).toMatchObject(expected);
    // The unprotected current estimate changes after the earliest freeze; it is never backfilled as the original.
    task = await owner.tasks.updateTask(task.id, { expectedRevision: task.revision, expectedWorkPackageRevision: task.workPackageRevision, estimateMinutes: 420 });
    const preview = await owner.preview(week.id);
    expect(await original(owner, task.workPackageId)).toEqual(early);
    expect((await owner.preview(week.id)).previewHash).toBe(preview.previewHash);
    const projectBaseline = await owner.freeze(week.id);
    expect(projectBaseline.snapshot.sourcePersonalBaselineIds).toContain(memberSelf.id);
    const later = await ownerPersonal(owner, week.id);
    expect(BigInt(later.changeSeq)).toBeGreaterThan(BigInt(memberSelf.changeSeq));
    // The owner's later personal freeze is a real competitor; whichever member sorts first, the earlier command wins.
    expect(later.snapshot.commitments.some((c) => c.state === 'active' && c.workPackageId === task.workPackageId && c.membershipId === M.teamOwner)).toBe(true);
    expect(expectedOriginBaseline(await owner.baselines(week.id), task.workPackageId).id).toBe(memberSelf.id);
    expect(await original(owner, task.workPackageId)).toEqual(early);
    expect(await original(member, task.workPackageId)).toEqual(early);
    expect((await owner.tasks.getTask(task.id)).estimateMinutes).toBe(420);
    expect(await h.db.sql`select estimate_minutes, baseline_id from package_freeze_observations where work_package_id=${task.workPackageId}`).toEqual([{ estimate_minutes: 300, baseline_id: memberSelf.id }]);
    expect(await h.db.sql`select estimate_minutes, source_baseline_id from package_baselines where work_package_id=${task.workPackageId}`).toEqual([{ estimate_minutes: 300, source_baseline_id: memberSelf.id }]);
  });

  it('derives the shared-package origin from the sorted personal-freeze loop instead of assuming the owner', async () => {
    const { owner } = h;
    const { project } = await planningProject(owner, 'Общий пакет двух людей');
    const task = await planningTask(owner, project, 240);
    const week = await period(owner, project.id);
    await commit(owner, week, task, 60, M.teamMemberA);
    await commit(owner, week, task, 90, M.teamOwner);
    const frozen = await owner.freeze(week.id);
    const all = await owner.baselines(week.id);
    const committed = all.filter((item) => item.scope === 'self' && (item.membershipId === M.teamOwner || item.membershipId === M.teamMemberA));
    expect(committed.map((item) => item.membershipId).sort()).toEqual([M.teamOwner, M.teamMemberA].sort());
    // One project command: these personal freezes and the project freeze share frozenAt, so neither time nor
    // baseline ID orders them. The freeze loop visits committed members in sorted membership-ID order.
    expect(new Set([...committed, frozen].map((item) => item.frozenAt))).toEqual(new Set([frozen.frozenAt]));
    const first = committed.find((item) => item.membershipId === [M.teamOwner, M.teamMemberA].sort()[0]);
    if (!first) throw new Error('The sorted first committed member baseline is missing.');
    expect(expectedOriginBaseline(all, task.workPackageId).id).toBe(first.id);
    const value = await original(owner, task.workPackageId);
    expect(value).toMatchObject({ state: 'captured', estimateMinutes: 240, origin: { planBaselineId: first.id, scope: 'self', mode: 'manual', frozenAt: frozen.frozenAt } });
    expect(value.state === 'captured' ? value.origin.planBaselineId : null).not.toBe(frozen.id);
    expect(await h.db.sql`select baseline_id from package_freeze_observations where work_package_id=${task.workPackageId}`).toEqual([{ baseline_id: first.id }]);
  });

  it('records a cutoff-forced first freeze with cutoff mode and never applies the rejected edit or a later replay', async () => {
    const { owner, replica } = h;
    const { project } = await planningProject(owner, 'Оригинал на дедлайне');
    const task = await planningTask(owner, project, 480);
    let week = await period(owner, project.id);
    await commit(owner, week, task, 480);
    // Established p2a-cutoff pattern: a cutoff shortly after the PostgreSQL clock, then wait past it in SQL.
    const [clock] = await h.db.sql<{ epoch_ms: number }[]>`select extract(epoch from clock_timestamp()) * 1000 as epoch_ms`;
    const cutoff = new Date(Number(clock?.epoch_ms) + 400).toISOString();
    week = await owner.updatePeriod(week.id, { expectedRevision: week.revision, cutoffAt: cutoff });
    await h.db.sql`select pg_sleep(greatest(0, extract(epoch from (${cutoff}::text::timestamptz - clock_timestamp()))) + 0.025)`;
    // Reads never run an overdue freeze.
    const unfrozen = await databaseSnapshot(h.db.sql);
    expect(await original(owner, task.workPackageId)).toMatchObject({ state: 'not_captured_yet' });
    expect(await databaseSnapshot(h.db.sql)).toEqual(unfrozen);
    const key = randomUUID();
    const input = { expectedRevision: task.revision, expectedWorkPackageRevision: task.workPackageRevision, estimateMinutes: 999 };
    const rejected = expectError(await owner.patch(`/tasks/${task.id}`, input, key), 409, 'FIELD_LOCKED');
    // Only the owner committed to this package, so the owner's personal freeze is the known origin, never the project one.
    const all = await owner.baselines(week.id);
    const first = await ownerPersonal(owner, week.id);
    const forcedProject = all.find((item) => item.scope === 'project');
    if (!forcedProject) throw new Error('The cutoff-forced project baseline is missing.');
    expect(all.filter((item) => item.snapshot.packages.some((p) => p.id === task.workPackageId)).every((item) => item.mode === 'cutoff')).toBe(true);
    expect(first.mode).toBe('cutoff');
    expect(Date.parse(first.frozenAt)).toBeGreaterThanOrEqual(Date.parse(cutoff));
    expect(expectedOriginBaseline(all, task.workPackageId).id).toBe(first.id);
    const value = await original(owner, task.workPackageId);
    expect(value).toEqual({
      state: 'captured', workspaceId: TEAM, projectId: project.id, workPackageId: task.workPackageId, estimateMinutes: 480,
      packageBaselineId: expect.any(String), acceptedAt: first.frozenAt, provenance: 'first_known_plan_freeze',
      origin: { planBaselineId: first.id, periodId: week.id, periodLocalStart: week.localStart, scope: 'self', mode: 'cutoff', frozenAt: first.frozenAt, packageRevision: task.workPackageRevision },
    });
    expect(value.state === 'captured' ? value.origin.planBaselineId : null).not.toBe(forcedProject.id);
    expect(await h.db.sql`select baseline_id from package_freeze_observations where work_package_id=${task.workPackageId}`).toEqual([{ baseline_id: first.id }]);
    const committed = await databaseSnapshot(h.db.sql);
    expect(expectError(await replica.patch(`/tasks/${task.id}`, input, key), 409, 'FIELD_LOCKED').error).toEqual(rejected.error);
    expect(await databaseSnapshot(h.db.sql)).toEqual(committed);
    expect(await original(replica, task.workPackageId)).toEqual(value);
    expect((await owner.tasks.getTask(task.id)).estimateMinutes).toBe(480);
  });

  it('denies foreign, cross-tenant and revoked access before any observation is returned', async () => {
    const { owner, outsider } = h;
    const { project } = await planningProject(owner, 'Права исходной оценки');
    const task = await planningTask(owner, project, 60);
    const week = await period(owner, project.id);
    await commit(owner, week, task, 60);
    await owner.freeze(week.id);
    const foreign = await planningProject(outsider, 'Секрет чужой оценки');
    const foreignTask = await planningTask(outsider, foreign.project, 90);
    const foreignWeek = await period(outsider, foreign.project.id);
    await commit(outsider, foreignWeek, foreignTask, 90, M.outsideOwner);
    await outsider.freeze(foreignWeek.id);
    expect(await original(outsider, foreignTask.workPackageId)).toMatchObject({ state: 'captured', estimateMinutes: 90 });
    const before = await databaseSnapshot(h.db.sql);
    expectError(await owner.get(path(foreignTask.workPackageId)), 404, 'NOT_FOUND', [foreign.project.name, foreignTask.title]);
    expectError(await new P2aClient(outsider.api, TEAM).get(path(task.workPackageId)), 404, 'NOT_FOUND', [project.name, task.title]);
    expectError(await owner.get(path(randomUUID())), 404, 'NOT_FOUND');
    expectError(await owner.get(path('not-a-uuid')), 400, 'VALIDATION_FAILED');
    expectError(await owner.get(`${path(task.workPackageId)}?estimateMinutes=60`), 400, 'VALIDATION_FAILED');
    expect(await databaseSnapshot(h.db.sql)).toEqual(before);
    const saved = await membershipRow(h.db.sql, TEAM, M.teamOwner);
    try {
      await revokeMembership(h.db.sql, TEAM, M.teamOwner);
      const revoked = await databaseSnapshot(h.db.sql);
      expectError(await owner.get(path(task.workPackageId)), 404, 'NOT_FOUND', [project.name, task.title]);
      expect(await databaseSnapshot(h.db.sql)).toEqual(revoked);
    } finally { await restoreMembership(h.db.sql, TEAM, M.teamOwner, saved); }
    expect(await original(owner, task.workPackageId)).toMatchObject({ state: 'captured', estimateMinutes: 60 });
  });

  it('leaves preview hashes, freeze replay, old package DTOs and stored snapshots unchanged', async () => {
    const { owner } = h;
    const { project } = await planningProject(owner, 'Совместимость оригинала');
    const task = await planningTask(owner, project, 240);
    const week = await period(owner, project.id);
    await commit(owner, week, task, 120);
    const preview = await owner.preview(week.id);
    await original(owner, task.workPackageId);
    expect((await owner.preview(week.id)).previewHash).toBe(preview.previewHash);
    const key = randomUUID();
    const frozen = expectEnvelope(await owner.freezeRequest(week.id, 'project', preview.previewHash, key), 200, planBaselineResponseSchema).data;
    expect(await original(owner, task.workPackageId)).toMatchObject({ state: 'captured', estimateMinutes: 240, origin: { planBaselineId: (await ownerPersonal(owner, week.id)).id, frozenAt: frozen.frozenAt } });
    const replay = await owner.freezeRequest(week.id, 'project', preview.previewHash, key);
    expect(replay.json()).toMatchObject({ data: frozen });
    expect(expectEnvelope(replay, 200, planBaselineResponseSchema).data).toEqual(frozen);
    const keys = Object.keys(planningPackageSchema.shape).sort();
    for (const item of frozen.snapshot.packages) expect(Object.keys(item).sort()).toEqual(keys);
    for (const item of await owner.packages(project.id)) expect(Object.keys(item).sort()).toEqual(keys);
    const [stored] = await h.db.sql<{ snapshot: unknown }[]>`select snapshot from plan_baselines where id=${frozen.id}`;
    expect(stored?.snapshot).toEqual(frozen.snapshot);
    expect(JSON.stringify(stored?.snapshot)).not.toMatch(/original_unknown|not_captured_yet|first_known_plan_freeze/);
  });
});
