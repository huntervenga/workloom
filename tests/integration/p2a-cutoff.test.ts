// Actual PostgreSQL clock/barrier races, not a mocked clock. The before/after evidence includes
// every public table so a committed auto-freeze differs visibly from an unexpected rollback.
import { randomUUID } from 'node:crypto';

import { errorResponseSchema } from '@workloom/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { expectError } from './support/p1a.js';
import { databaseSnapshot } from './support/p1b.js';
import { commit, period, planningHarness, planningProject, planningTask, TEAM, type PlanningHarness } from './support/p2a-fixture.js';
import { requireTestDatabaseUrl } from './support/test-database-url.js';

requireTestDatabaseUrl();

describe('P2a cutoff commit and rollback through a real PostgreSQL write barrier', () => {
  let h: PlanningHarness;
  beforeAll(async () => { h = await planningHarness('p2a_cutoff'); });
  afterAll(async () => { await h?.close(); });

  async function fixture(cutoffDelayMs: number) {
    const { project } = await planningProject(h.owner, 'Граница фиксации');
    const task = await planningTask(h.owner, project, 480);
    const field = await h.owner.createField({ projectId: project.id, name: 'Пустое защищённое поле', type: 'number' });
    let week = await period(h.owner, project.id, { protectedFieldIds: [field.id] });
    await commit(h.owner, week, task, 480);
    const [clock] = await h.db.sql<{ epoch_ms: number }[]>`select extract(epoch from clock_timestamp()) * 1000 as epoch_ms`;
    const cutoff = new Date(Number(clock?.epoch_ms) + cutoffDelayMs).toISOString();
    week = await h.owner.updatePeriod(week.id, { expectedRevision: week.revision, cutoffAt: cutoff });
    return { project, task, field, week, cutoff };
  }

  async function waitPast(cutoff: string) {
    await h.db.sql`select pg_sleep(greatest(0, extract(epoch from (${cutoff}::text::timestamptz - clock_timestamp()))) + 0.025)`;
  }

  async function waitForBlockedWriter() {
    const deadline = Date.now() + 3_000;
    while (Date.now() < deadline) {
      const [row] = await h.db.sql<{ blocked: boolean }[]>`
        select exists(select 1 from pg_stat_activity
          where datname = current_database() and pid <> pg_backend_pid()
            and wait_event_type = 'Lock' and query ilike '%workspaces%') as blocked`;
      if (row?.blocked) return;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error('The real HTTP writer never waited for the workspace barrier.');
  }

  it('rechecks server time after lock wait, commits old snapshot before409, and replays that rejection without duplicated events', async () => {
    const { owner, replica } = h;
    const f = await fixture(1_500);
    const before = await databaseSnapshot(h.db.sql);
    let release!: () => void;
    let ready!: () => void;
    const released = new Promise<void>((resolve) => { release = resolve; });
    const locked = new Promise<void>((resolve) => { ready = resolve; });
    const blocker = h.db.sql.begin(async (tx) => {
      await tx`select id from workspaces where id = ${TEAM} for update`;
      ready();
      await released;
    });
    await locked;
    const [clock] = await h.db.sql<{ before_cutoff: boolean }[]>`select clock_timestamp() < ${f.cutoff}::text::timestamptz as before_cutoff`;
    expect(clock?.before_cutoff, 'request is initiated before cutoff').toBe(true);
    const key = randomUUID();
    const input = { expectedRevision: f.task.revision, expectedWorkPackageRevision: f.task.workPackageRevision, estimateMinutes: 999 };
    const request = owner.patch(`/tasks/${f.task.id}`, input, key);
    try {
      await waitForBlockedWriter();
      await waitPast(f.cutoff);
    } finally {
      release();
      await blocker;
    }
    const response = await request;
    const body = expectError(response, 409, 'FIELD_LOCKED');
    const allBaselines = await replica.baselines(f.week.id);
    const baselines = allBaselines.filter((item) => item.scope === 'project');
    expect(new Set(allBaselines.map((item) => `${item.scope}:${item.membershipId}`)).size).toBe(allBaselines.length);
    expect(baselines).toHaveLength(1);
    const baseline = baselines[0];
    if (!baseline) throw new Error('Committed auto-freeze missing.');
    const relevantIds = allBaselines.filter((item) => item.snapshot.packages.some((pkg) => pkg.id === f.task.workPackageId)).map((item) => item.id).sort();
    expect(relevantIds).toContain(baseline.id);
    expect(body.error.details).toEqual({ committed: true, baselineIds: relevantIds });
    for (const id of relevantIds) expect((await owner.baseline(id)).id).toBe(id);
    expect(baseline).toMatchObject({ scope: 'project', mode: 'cutoff', requestedCutoffAt: f.cutoff });
    expect(Date.parse(baseline.frozenAt)).toBeGreaterThanOrEqual(Date.parse(f.cutoff));
    expect(baseline.snapshot.packages.find((item) => item.id === f.task.workPackageId)?.estimateMinutes).toBe(480);
    expect(baseline.snapshot.fieldValues.find((item) => item.taskId === f.task.id && item.fieldId === f.field.id)?.value).toBeNull();
    expect((await replica.tasks.getTask(f.task.id)).estimateMinutes).toBe(480);
    expect((await owner.getPeriod(f.week.id)).state).toBe('frozen');
    const committed = await databaseSnapshot(h.db.sql);
    expect(committed.rowDigests.work_packages).toBe(before.rowDigests.work_packages);
    expect(committed.rowDigests.tasks).toBe(before.rowDigests.tasks);
    expect(committed.rowDigests.task_field_values).toBe(before.rowDigests.task_field_values);
    expect(committed.rowDigests.plan_baselines).not.toBe(before.rowDigests.plan_baselines);
    const replay = expectError(await replica.patch(`/tasks/${f.task.id}`, input, key), 409, 'FIELD_LOCKED');
    expect(replay.error).toEqual(body.error);
    expect(await databaseSnapshot(h.db.sql)).toEqual(committed);
    expectError(await owner.put(owner.valuePath(f.task.id, f.field.id), {
      expectedRevision: 0, expectedDefinitionRevision: f.field.revision, value: { type: 'number', value: 1 },
    }), 409, 'FIELD_LOCKED');
    expect((await owner.baselines(f.week.id)).filter((item) => item.scope === 'project').map((item) => item.id)).toEqual([baseline.id]);
  });

  it('rolls back necessary auto-freeze on an unexpected late SQL fault, then the same key can commit one409 outcome', async () => {
    const { owner } = h;
    const f = await fixture(400);
    await h.db.sql.unsafe(`create function synthetic_p2a_key_failure() returns trigger language plpgsql as $$
      begin raise exception 'synthetic_p2a_key_failure'; end $$`);
    await h.db.sql.unsafe(`create trigger synthetic_p2a_key_failure before insert on command_idempotency
      for each row execute function synthetic_p2a_key_failure()`);
    await waitPast(f.cutoff);
    const before = await databaseSnapshot(h.db.sql);
    const key = randomUUID();
    const input = { expectedRevision: f.task.revision, expectedWorkPackageRevision: f.task.workPackageRevision, estimateMinutes: 999 };
    try {
      const response = await owner.patch(`/tasks/${f.task.id}`, input, key);
      expect(response.status, response.text()).toBe(500);
      errorResponseSchema.parse(response.json());
      expect(response.text()).not.toContain('synthetic_p2a_key_failure');
      expect(await databaseSnapshot(h.db.sql)).toEqual(before);
      expect(await owner.baselines(f.week.id)).toEqual([]);
    } finally {
      await h.db.sql.unsafe('drop trigger if exists synthetic_p2a_key_failure on command_idempotency');
      await h.db.sql.unsafe('drop function if exists synthetic_p2a_key_failure()');
    }
    const rejection = expectError(await owner.patch(`/tasks/${f.task.id}`, input, key), 409, 'FIELD_LOCKED');
    const allBaselines = await owner.baselines(f.week.id);
    const baselines = allBaselines.filter((item) => item.scope === 'project');
    expect(new Set(allBaselines.map((item) => `${item.scope}:${item.membershipId}`)).size).toBe(allBaselines.length);
    expect(baselines).toHaveLength(1);
    const relevantIds = allBaselines.filter((item) => item.snapshot.packages.some((pkg) => pkg.id === f.task.workPackageId)).map((item) => item.id).sort();
    expect(relevantIds).toContain(baselines[0]?.id);
    expect(rejection.error.details).toEqual({ committed: true, baselineIds: relevantIds });
    for (const id of relevantIds) expect((await owner.baseline(id)).id).toBe(id);
    const committed = await databaseSnapshot(h.db.sql);
    expectError(await owner.patch(`/tasks/${f.task.id}`, input, key), 409, 'FIELD_LOCKED');
    expect(await databaseSnapshot(h.db.sql)).toEqual(committed);
    expect((await owner.tasks.getTask(f.task.id)).estimateMinutes).toBe(480);
    expect(await owner.listTaskValues(f.task.id)).toEqual([]);
  });
});
