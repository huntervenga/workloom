// Actual P3b worker over real PostgreSQL and a real pg-boss 12 queue in a per-file throwaway database:
// the transactional outbox relay, poison isolation, at-least-once redelivery after a lost
// acknowledgement, stored-authorizer revalidation, pause/stale refresh and dead-letter health.
// No mocked facade, queue, SQL or fault environment. Series are created over raw HTTP with the shared
// contract schemas (no P3b client helper names); the public whole-schema snapshot excludes
// `workloom_queue`, so queue jobs and receipts are read explicitly through pg-boss.
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

import {
  RECURRENCE_MATERIALIZATION_REQUESTED,
  RECURRENCE_MATERIALIZATION_SCHEMA_VERSION,
  recurrenceCreatePreviewResponseSchema,
  recurrenceExceptionPreviewResponseSchema,
  recurrenceInstanceListResponseSchema,
  recurrenceInstanceResponseSchema,
  recurrenceMaterializationJobSchema,
  recurrenceMaterializationRequestedPayloadSchema,
  recurrenceMaterializationResultResponseSchema,
  recurrenceReadinessResponseSchema,
  recurrenceSeriesResponseSchema,
  type PlanningPeriodDto,
  type ProjectDto,
  type RecurrenceBindingProgressDto,
  type RecurrenceCreatePreviewInput,
  type RecurrenceMaterializationJob,
  type RecurrenceMaterializationRequestedPayload,
  type RecurrenceSeriesDto,
  type TaskStatusDto,
} from '@workloom/contracts';
import {
  CUTOFF_QUEUE, CUTOFF_DEAD_LETTER_QUEUE, WORKLOOM_QUEUE_REGISTRATIONS,
  createCutoffWorkerFacade, createCutoffOutboxRelay, createCutoffDiscovery,
  PG_BOSS_SCHEMA_VERSION,
  RECURRENCE_DEAD_LETTER_QUEUE,
  RECURRENCE_MATERIALIZE_QUEUE,
  RECURRENCE_QUEUE_REGISTRATIONS,
  WORKLOOM_QUEUE_SCHEMA,
  createDatabase,
  createReadinessProbe,
  createRecurrenceOutboxRelay,
  createRecurrenceWorkerFacade,
  findQueueOptionMismatches,
  migrateWorkloomQueue,
  parseDatabaseUrl,
  type Database,
  type WorkloomExecutor,
} from '@workloom/db';
import type { RecurrenceOutboxRelay, RecurrenceRelayEnqueue, RecurrenceWorkerFacade } from '@workloom/domain';
import {
  InvalidMaterializationJobError,
  MATERIALIZE_JOB_RETRY,
  createMaterializationEnqueue,
  createMaterializationHandler,
  createWorkerLogger,
  createWorkerRuntime,
  materializationRequestId,
  pgBossRuntimeOptions,
  wrapPgBoss,
  type MaterializationHandler,
  type MaterializationJobResult,
  type QueueJob,
  type QueueWorkOptions,
} from '@workloom/worker';
import { sql as drizzleSql } from 'drizzle-orm';
import { PgBoss, fromDrizzle, type ConstructorOptions, type JobWithMetadata } from 'pg-boss';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { expectEnvelope, uniqueName } from './support/p1a.js';
import { databaseSnapshot, membershipRow, restoreMembership, revokeMembership, type DatabaseSnapshot } from './support/p1b.js';
import { MEMBERS as M, TEAM, USERS, planningHarness, planningProject, planningTask, type PlanningHarness } from './support/p2a-fixture.js';
import { P3aClient } from './support/p3a.js';
import { requireTestDatabaseUrl } from './support/test-database-url.js';

requireTestDatabaseUrl();

const QUEUE = RECURRENCE_MATERIALIZE_QUEUE;
const DLQ = RECURRENCE_DEAD_LETTER_QUEUE;
const SUBSCRIBED = RECURRENCE_MATERIALIZATION_REQUESTED;
const TZ = 'Asia/Nicosia';
const DAY_MS = 86_400_000;
/** The worker's own registration shape, with a short poll so a 5 s retry lands inside the wait budget. */
const WORK_OPTIONS: QueueWorkOptions = { batchSize: 1, localConcurrency: 1, groupConcurrency: 1, pollingIntervalSeconds: 0.5, transactional: false };

/** Thrown by a test wrapper AFTER the real handler returned, i.e. after the domain commit and before the queue ack. */
class LostAcknowledgement extends Error {
  override readonly name = 'LostAcknowledgement';
}
/** Thrown by a test relay callback AFTER the real queue insert, inside the relay transaction. */
class ControlledRelayFailure extends Error {
  override readonly name = 'ControlledRelayFailure';
}

interface MaterializationRequest {
  readonly id: string;
  readonly payload: RecurrenceMaterializationRequestedPayload;
  readonly dispatched: boolean;
}
interface Composition {
  readonly instanceId: string;
  readonly occurrenceKey: string;
  readonly calendarState: string;
  readonly meetingId: string | null;
  readonly taskId: string | null;
  readonly workPackageId: string | null;
}
interface Delivery {
  readonly job: QueueJob;
  readonly result: MaterializationJobResult;
}
interface Attempt {
  readonly retryCount: number;
  readonly result: MaterializationJobResult;
}
interface SeriesFixture {
  readonly project: ProjectDto;
  readonly week: PlanningPeriodDto;
  readonly series: RecurrenceSeriesDto;
  readonly bindingId: string;
  readonly request: MaterializationRequest;
}
interface FixtureOptions {
  readonly creator?: P3aClient;
  readonly organizer?: string;
  readonly attendees?: readonly string[];
  readonly weeksAhead?: number;
  readonly project?: { readonly project: ProjectDto; readonly todo: TaskStatusDto };
}

function addDays(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00.000Z`) + days * DAY_MS).toISOString().slice(0, 10);
}
/** Monday 2026-10-19 while it is still ahead, otherwise the next Monday at least two days out; plus whole weeks. */
function futureMonday(weeksAhead = 0): string {
  let monday = '2026-10-19';
  while (Date.parse(`${monday}T00:00:00.000Z`) < Date.now() + 2 * DAY_MS) monday = addDays(monday, 7);
  return addDays(monday, weeksAhead * 7);
}
function fiveKeys(monday: string): string[] {
  return [0, 1, 2, 3, 4].map((offset) => addDays(monday, offset));
}
function located(items: readonly Composition[]): Composition[] {
  return items.filter((item) => item.meetingId !== null);
}
function expectDistinctCompositions(items: readonly Composition[], count: number): void {
  const real = located(items);
  expect(real).toHaveLength(count);
  for (const key of ['meetingId', 'taskId', 'workPackageId'] as const) expect(new Set(real.map((item) => item[key])).size).toBe(count);
}
async function waitFor<T>(label: string, probe: () => Promise<T | undefined>, options: { timeoutMs?: number; intervalMs?: number } = {}): Promise<T> {
  const timeoutMs = options.timeoutMs ?? 30_000;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value !== undefined) return value;
    if (Date.now() >= deadline) throw new Error(`Timed out after ${timeoutMs} ms waiting for ${label}.`);
    await delay(options.intervalMs ?? 20);
  }
}

describe('P3b worker: real relay, pg-boss delivery and stored-authorizer materialization', () => {
  let h: PlanningHarness;
  let owner: P3aClient, member: P3aClient;
  let database: Database | undefined;
  let boss: PgBoss | undefined;
  const bossErrors: unknown[] = [];
  let relay: RecurrenceOutboxRelay<WorkloomExecutor>;
  let facade: RecurrenceWorkerFacade;
  let handler: MaterializationHandler;
  let enqueue: RecurrenceRelayEnqueue<WorkloomExecutor>;
  const logger = createWorkerLogger({ level: 'silent' });

  /** Runtime client options exactly as the worker builds them: migrate/createSchema off, own pool. */
  function workerBossOptions(): ConstructorOptions {
    return pgBossRuntimeOptions({ database: parseDatabaseUrl(h.db.url, { requireLoopback: true }), queuePoolMax: 2 }, { schema: WORKLOOM_QUEUE_SCHEMA });
  }
  async function startBoss(errors: unknown[], overrides: Partial<ConstructorOptions> = {}): Promise<PgBoss> {
    const client = new PgBoss({ ...workerBossOptions(), ...overrides });
    client.on('error', (error) => { errors.push(error); });
    await client.start();
    return client;
  }
  async function stopBoss(client: PgBoss | undefined, working: boolean): Promise<void> {
    if (client === undefined) return;
    if (working) await client.offWork(QUEUE, { wait: true });
    await client.stop({ graceful: true, close: true, timeout: 5_000 });
  }
  function queue(): PgBoss {
    if (boss === undefined) throw new Error('The observer queue client did not start.');
    return boss;
  }

  beforeAll(async () => {
    h = await planningHarness('p3b_worker');
    [owner, member] = [h.owner, h.member].map((client) => new P3aClient(client.api, client.workspaceId)) as [P3aClient, P3aClient];
    // Explicit lifecycle first, only on this throwaway database; every client below runs with migrate/createSchema off.
    const migrated = await migrateWorkloomQueue(h.db.url);
    expect(migrated).toMatchObject({ schema: WORKLOOM_QUEUE_SCHEMA, version: PG_BOSS_SCHEMA_VERSION, action: 'installed', queueName: QUEUE, queueReady: true });
    database = createDatabase(h.db.url, { maxConnections: 4, requireLoopback: true, applicationName: 'workloom-p3b-worker-test' });
    // Observer/delivery client: no background supervision; a 1 s monitor interval lets an explicit supervise() refresh counts.
    boss = await startBoss(bossErrors, { supervise: false, monitorIntervalSeconds: 1 });
    relay = createRecurrenceOutboxRelay(database);
    facade = createRecurrenceWorkerFacade(database);
    handler = createMaterializationHandler({ facade, logger });
    enqueue = createMaterializationEnqueue<WorkloomExecutor>(wrapPgBoss(boss));
  }, 120_000);

  afterAll(async () => {
    try {
      await boss?.stop({ graceful: false, close: true, timeout: 5_000 });
    } finally {
      try {
        await database?.close();
      } finally {
        await h?.close();
      }
    }
  });

  // ---- HTTP (raw paths of the frozen docs16 catalog, parsed by the shared schemas) ----------------

  async function weekPeriod(projectId: string, localStart: string): Promise<PlanningPeriodDto> {
    return owner.createPeriod({ projectId, name: uniqueName('Неделя серии'), localStart, timezone: TZ, cutoffAt: `${addDays(localStart, 7)}T00:00:00.000Z` });
  }
  function weekdaySeries(statusId: string, week: PlanningPeriodDto, organizer: string, attendees: readonly string[]): RecurrenceCreatePreviewInput {
    return {
      schedule: {
        startDate: week.localStart, localTime: '10:00', timezone: TZ, frequency: 'weekly', weekdays: [1, 2, 3, 4, 5],
        plannedDurationMinutes: 30, end: { kind: 'on_date', endDate: addDays(week.localStart, 4) },
      },
      template: { title: uniqueName('Планёрка серии'), statusId, organizerMembershipId: organizer, attendeeMembershipIds: [...attendees] },
      targetPeriodIds: [week.id],
    };
  }
  async function createSeries(client: P3aClient, projectId: string, week: PlanningPeriodDto, input: RecurrenceCreatePreviewInput): Promise<RecurrenceSeriesDto> {
    const preview = expectEnvelope(await client.post(`/projects/${projectId}/recurrence-preview`, input, null), 200, recurrenceCreatePreviewResponseSchema).data;
    expect(preview.candidates.map((candidate) => candidate.occurrenceKey).sort()).toEqual(fiveKeys(week.localStart));
    expect(new Set(preview.candidates.map((candidate) => candidate.periodId))).toEqual(new Set([week.id]));
    expect(preview.unboundCandidateCount).toBe(0);
    return expectEnvelope(await client.post(`/projects/${projectId}/recurrence-series`, { ...input, previewHash: preview.previewHash }), 201, recurrenceSeriesResponseSchema).data;
  }
  async function getSeries(seriesId: string): Promise<RecurrenceSeriesDto> {
    return expectEnvelope(await owner.get(`/recurrence-series/${seriesId}`), 200, recurrenceSeriesResponseSchema).data;
  }
  async function setState(seriesId: string, state: 'active' | 'paused'): Promise<RecurrenceSeriesDto> {
    const current = await getSeries(seriesId);
    return expectEnvelope(await owner.patch(`/recurrence-series/${seriesId}/state`, { expectedRevision: current.revision, state }), 200, recurrenceSeriesResponseSchema).data;
  }
  async function bindingOf(periodId: string, seriesId: string): Promise<RecurrenceBindingProgressDto> {
    const readiness = expectEnvelope(await owner.get(`/periods/${periodId}/recurrence-readiness`), 200, recurrenceReadinessResponseSchema).data;
    const [binding, ...extra] = readiness.bindings.filter((item) => item.seriesId === seriesId);
    expect(extra).toEqual([]);
    if (binding === undefined) throw new Error(`Readiness of ${periodId} lists no binding of ${seriesId}.`);
    return binding;
  }
  /** Current occurrences of one period, every page at limit 2, ordered by nominal key. */
  async function compositions(seriesId: string, periodId: string): Promise<Composition[]> {
    const items = await owner.all(`/recurrence-series/${seriesId}/instances`, recurrenceInstanceListResponseSchema, { periodId, includeCancelled: 'true' }, 2);
    return items
      .map((item) => ({
        instanceId: item.id, occurrenceKey: item.occurrenceKey, calendarState: item.calendarState,
        meetingId: item.meetingId, taskId: item.taskId, workPackageId: item.workPackageId,
      }))
      .sort((a, b) => a.occurrenceKey.localeCompare(b.occurrenceKey));
  }
  async function skip(seriesId: string, periodId: string, occurrenceKey: string) {
    const series = await getSeries(seriesId);
    const instance = (await owner.all(`/recurrence-series/${seriesId}/instances`, recurrenceInstanceListResponseSchema, { periodId, includeCancelled: 'true' }, 2))
      .find((item) => item.occurrenceKey === occurrenceKey);
    if (instance === undefined) throw new Error(`Occurrence ${occurrenceKey} has no reserved header.`);
    const input = { kind: 'skip' as const, expectedSeriesRevision: series.revision, expectedInstanceRevision: instance.revision, reason: 'Праздничный день' };
    const path = `/recurrence-series/${seriesId}/instances/${occurrenceKey}`;
    const preview = expectEnvelope(await owner.post(`${path}/exception-preview`, input, null), 200, recurrenceExceptionPreviewResponseSchema).data;
    return expectEnvelope(await owner.post(`${path}/exception`, { ...input, previewHash: preview.previewHash }), 200, recurrenceInstanceResponseSchema).data;
  }
  /** Generation proposes only: no commitment, no recorded work, every attendance still unknown. */
  async function expectNoAutomaticTime(periodId: string, items: readonly Composition[]): Promise<void> {
    expect(await owner.commitments(periodId)).toEqual([]);
    expect(await owner.recordedWork(periodId)).toEqual([]);
    for (const item of located(items)) {
      if (item.taskId === null) continue;
      for (const attendance of await owner.attendance(item.taskId)) {
        expect(attendance).toMatchObject({ status: 'unknown', postingState: 'unconfirmed', minutes: null, workLog: null });
      }
    }
  }

  // ---- Database and queue evidence ---------------------------------------------------------------

  /** P0 outbox rows of the one subscribed type for a series; payloads parse strictly. */
  async function requests(seriesId: string): Promise<MaterializationRequest[]> {
    const rows = await h.db.sql<{ id: string; schema_version: number; payload: unknown; dispatched: boolean }[]>`
      select id::text as id, schema_version, payload, dispatched_at is not null as dispatched
      from outbox_events
      where workspace_id = ${TEAM} and type = ${SUBSCRIBED} and payload->>'seriesId' = ${seriesId}
      order by occurred_at, id`;
    return rows.map((row) => {
      expect(row.schema_version).toBe(RECURRENCE_MATERIALIZATION_SCHEMA_VERSION);
      return { id: row.id, payload: recurrenceMaterializationRequestedPayloadSchema.parse(row.payload), dispatched: row.dispatched };
    });
  }
  async function newRequests(seriesId: string, known: ReadonlySet<string>): Promise<MaterializationRequest[]> {
    return (await requests(seriesId)).filter((row) => !known.has(row.id));
  }
  /** Every other outbox row as whole-row JSON, dispatched_at included. */
  async function unrelatedOutbox(): Promise<string[]> {
    const rows = await h.db.sql<{ row: string }[]>`select to_jsonb(o)::text as row from outbox_events o where o.type <> ${SUBSCRIBED} order by o.id`;
    return rows.map((row) => row.row);
  }
  async function outboxRows(ids: readonly string[]): Promise<string[]> {
    const rows = await h.db.sql<{ row: string }[]>`select to_jsonb(o)::text as row from outbox_events o where o.id::text in ${h.db.sql([...ids])} order by o.id`;
    return rows.map((row) => row.row);
  }
  async function changeSeq(): Promise<string> {
    const [row] = await h.db.sql<{ seq: string }[]>`select change_seq::text as seq from workspaces where id = ${TEAM}`;
    if (row === undefined) throw new Error('Team workspace row required.');
    return row.seq;
  }
  async function jobById(id: string, name: string = QUEUE): Promise<JobWithMetadata<unknown> | undefined> {
    const jobs = await queue().findJobs<unknown>(name, { id });
    expect(jobs.length).toBeLessThanOrEqual(1);
    return jobs[0];
  }
  async function expectQueueIdle(): Promise<void> {
    expect(await queue().findJobs(QUEUE, { queued: true })).toEqual([]);
    expect((await relay.getHealth()).pendingSubscribedCount).toBe(0);
  }
  /** Fetches and acknowledges every ready job through the real handler, one per batch, like the worker. */
  async function deliverQueued(): Promise<Delivery[]> {
    const delivered: Delivery[] = [];
    for (let index = 0; index < 20; index += 1) {
      const jobs = await queue().fetch<unknown>(QUEUE, { batchSize: 1 });
      const [job] = jobs;
      if (job === undefined) return delivered;
      expect(jobs).toHaveLength(1);
      const attempt = { id: job.id, retryCount: job.retryCount };
      let result: MaterializationJobResult;
      try {
        result = (await handler.handle([job])) as MaterializationJobResult;
      } catch (error) {
        await queue().fail(QUEUE, attempt, { reason: 'test_delivery_failed' });
        throw error;
      }
      await queue().complete(QUEUE, attempt, { ...result });
      delivered.push({ job: { id: job.id, data: job.data, retryCount: job.retryCount }, result });
    }
    throw new Error('The materialization queue did not drain within 20 deliveries.');
  }

  async function seriesFixture(label: string, options: FixtureOptions = {}): Promise<SeriesFixture> {
    const { project, todo } = options.project ?? (await planningProject(owner, label));
    const week = await weekPeriod(project.id, futureMonday(options.weeksAhead ?? 0));
    const input = weekdaySeries(todo.id, week, options.organizer ?? M.teamOwner, options.attendees ?? [M.teamOwner, M.teamMemberB]);
    const series = await createSeries(options.creator ?? owner, project.id, week, input);
    const [request, ...extra] = await requests(series.id);
    expect(extra).toEqual([]);
    if (request === undefined) throw new Error('Series creation must request materialization of its binding.');
    expect(request.payload.seriesId).toBe(series.id);
    return { project, week, series, bindingId: request.payload.bindingId, request };
  }

  it('relays exactly the subscribed v1 request of an API-created binding into one real job and its receipt, leaving every other outbox row untouched', async () => {
    expect(RECURRENCE_QUEUE_REGISTRATIONS.map((registration) => registration.name)).toEqual([DLQ, QUEUE]);
    for (const { name, expected } of WORKLOOM_QUEUE_REGISTRATIONS) {
      expect(findQueueOptionMismatches(expected, (await queue().getQueue(name)) ?? {}), name).toEqual([]);
    }
    expect(MATERIALIZE_JOB_RETRY).toEqual({ retryLimit: 5, retryDelay: 5, retryBackoff: true, retryDelayMax: 300 });

    // Unrelated P0–P3a history in the same workspace: project, period, task and a one-off meeting.
    const other = await planningProject(owner, 'Несвязанная история');
    const otherWeek = await weekPeriod(other.project.id, futureMonday());
    await planningTask(owner, other.project);
    await owner.createMeeting(other.project.id, {
      title: uniqueName('Разовая встреча'), statusId: other.todo.id, plannedPeriodId: otherWeek.id, plannedStartAt: `${otherWeek.localStart}T12:00:00.000Z`,
      timezone: TZ, plannedDurationMinutes: 60, organizerMembershipId: M.teamOwner, attendeeMembershipIds: [M.teamOwner],
    });

    const f = await seriesFixture('Ретрансляция подписанного типа');
    const unrelated = await unrelatedOutbox();
    expect(unrelated.some((row) => (JSON.parse(row) as { dispatched_at: unknown }).dispatched_at === null)).toBe(true);
    const binding = await bindingOf(f.week.id, f.series.id);
    expect(f.request).toEqual({
      id: f.request.id, dispatched: false,
      payload: { seriesId: f.series.id, bindingId: binding.bindingId, sourceManifestHash: binding.sourceManifestHash, authorizationRevision: f.series.generation.authorizationRevision },
    });
    // Source census before the worker: five reserved headers, no real composition, proposals only.
    const headers = await compositions(f.series.id, f.week.id);
    expect(headers.map((item) => item.occurrenceKey)).toEqual(fiveKeys(f.week.localStart));
    expect(located(headers)).toEqual([]);
    await expectNoAutomaticTime(f.week.id, headers);
    expect(await relay.getHealth()).toMatchObject({ pendingSubscribedCount: 1, unsupportedSubscribedCount: 0 });

    expect(await relay.relayBatch(enqueue, 100)).toEqual({ selectedCount: 1, enqueuedCount: 1, unsupportedRetainedCount: 0 });
    const job = await jobById(f.request.id);
    expect(job).toMatchObject({ id: f.request.id, name: QUEUE, state: 'created', retryCount: 0, ...MATERIALIZE_JOB_RETRY, expireInSeconds: 300, deadLetter: DLQ, groupId: TEAM });
    const expectedJob: RecurrenceMaterializationJob = {
      workspaceId: TEAM, seriesId: f.series.id, bindingId: f.bindingId, sourceManifestHash: f.request.payload.sourceManifestHash,
      authorizationRevision: f.request.payload.authorizationRevision, requestId: materializationRequestId(f.request.id),
    };
    expect(job?.data).toEqual(expectedJob);
    expect(recurrenceMaterializationJobSchema.parse(job?.data)).toEqual(expectedJob);
    expect((await requests(f.series.id)).map((row) => row.dispatched)).toEqual([true]);
    expect(await unrelatedOutbox()).toEqual(unrelated);

    // A repeated relay neither reselects the receipted row nor sends a second job.
    expect(await relay.relayBatch(enqueue, 100)).toEqual({ selectedCount: 0, enqueuedCount: 0, unsupportedRetainedCount: 0 });
    expect(await queue().findJobs(QUEUE, { data: { bindingId: f.bindingId } })).toHaveLength(1);
    expect(await relay.getHealth()).toEqual({ pendingSubscribedCount: 0, oldestSubscribedAt: null, oldestSubscribedAgeMs: null, unsupportedSubscribedCount: 0 });
    expect(await unrelatedOutbox()).toEqual(unrelated);

    const [delivery, ...extra] = await deliverQueued();
    expect(extra).toEqual([]);
    expect(delivery?.result).toEqual({ status: 'complete', bindingId: f.bindingId, periodId: f.week.id, createdCount: 5, remainingCount: 0, blockedCode: null });
    const materialized = await compositions(f.series.id, f.week.id);
    expect(materialized.map((item) => item.instanceId)).toEqual(headers.map((item) => item.instanceId));
    expectDistinctCompositions(materialized, 5);
    expect(await owner.meetings(f.project.id, f.week.id)).toHaveLength(5);
    expect(await owner.packages(f.project.id)).toHaveLength(5);
    await expectNoAutomaticTime(f.week.id, materialized);
    // Old rows stay byte-identical; materialization's own events are not subscribed and request nothing.
    const after = new Set(await unrelatedOutbox());
    for (const row of unrelated) expect(after.has(row)).toBe(true);
    expect(await requests(f.series.id)).toHaveLength(1);
    await expectQueueIdle();
  }, 60_000);

  it('rolls back the real queue insert and the dispatch receipt together when the relay transaction fails after the enqueue', async () => {
    const f = await seriesFixture('Атомарная ретрансляция');
    const before = await databaseSnapshot(h.db.sql);
    expect(await relay.getHealth()).toMatchObject({ pendingSubscribedCount: 1, unsupportedSubscribedCount: 0 });

    let visibleInsideTransaction: number | undefined;
    const failAfterEnqueue: RecurrenceRelayEnqueue<WorkloomExecutor> = async (tx, event) => {
      expect(await enqueue(tx, event)).toEqual({ accepted: true, jobId: event.eventId });
      // The insert really happened on the relay transaction: pg-boss sees it through the same tx.
      visibleInsideTransaction = (await queue().findJobs(QUEUE, { id: event.eventId, db: fromDrizzle(tx, drizzleSql) })).length;
      throw new ControlledRelayFailure();
    };
    await expect(relay.relayBatch(failAfterEnqueue, 100)).rejects.toBeInstanceOf(ControlledRelayFailure);
    expect(visibleInsideTransaction).toBe(1);
    expect(await jobById(f.request.id)).toBeUndefined();
    expect(await databaseSnapshot(h.db.sql)).toEqual(before);
    expect((await requests(f.series.id)).map((row) => row.dispatched)).toEqual([false]);
    expect(await relay.getHealth()).toMatchObject({ pendingSubscribedCount: 1, unsupportedSubscribedCount: 0 });

    // The real callback then enqueues exactly once.
    expect(await relay.relayBatch(enqueue, 100)).toEqual({ selectedCount: 1, enqueuedCount: 1, unsupportedRetainedCount: 0 });
    expect(await jobById(f.request.id)).toMatchObject({ state: 'created', retryCount: 0 });
    expect(await relay.relayBatch(enqueue, 100)).toEqual({ selectedCount: 0, enqueuedCount: 0, unsupportedRetainedCount: 0 });
    expect(await queue().findJobs(QUEUE, { data: { bindingId: f.bindingId } })).toHaveLength(1);
    const [delivery, ...extra] = await deliverQueued();
    expect(extra).toEqual([]);
    expect(delivery?.result).toMatchObject({ status: 'complete', createdCount: 5 });
    expectDistinctCompositions(await compositions(f.series.id, f.week.id), 5);
    await expectQueueIdle();
  }, 60_000);

  it('never lets poison subscribed rows break relay or health, retains them unacknowledged and never starves a later valid v1 row', async () => {
    const f = await seriesFixture('Отравленные строки');
    const valid = f.request.payload;
    const missingKey = { seriesId: valid.seriesId, bindingId: valid.bindingId, sourceManifestHash: valid.sourceManifestHash };
    // All strictly older than the valid row; the subscribed ones differ only in payload or version.
    const poison = [
      { type: SUBSCRIBED, schemaVersion: 1, payload: null },
      { type: SUBSCRIBED, schemaVersion: 1, payload: [valid] },
      { type: SUBSCRIBED, schemaVersion: 1, payload: 'seriesId' },
      { type: SUBSCRIBED, schemaVersion: 1, payload: missingKey },
      // Fractional revisions, non-RFC UUID-shaped strings and unsafe integers must stay outside selection.
      { type: SUBSCRIBED, schemaVersion: 1, payload: { ...valid, authorizationRevision: 1.5 } },
      { type: SUBSCRIBED, schemaVersion: 1, payload: { ...valid, seriesId: '00000000-0000-0000-0000-000000000001' } },
      { type: SUBSCRIBED, schemaVersion: 1, payload: { ...valid, authorizationRevision: 9_007_199_254_740_992 } },
      { type: SUBSCRIBED, schemaVersion: 2, payload: valid },
    ].map((row, index) => ({ ...row, id: randomUUID(), ordinal: 1000 + index, minutesEarlier: 60 - index }));
    const legacy = { type: 'legacy.unrelated_event', schemaVersion: 1, payload: 'legacy scalar', id: randomUUID(), ordinal: 1100, minutesEarlier: 90 };
    const inserted = [...poison, legacy];
    try {
      for (const row of inserted) {
        await h.db.sql`
          insert into outbox_events (id, workspace_id, change_seq, event_ordinal, type, schema_version, aggregate_type, aggregate_id, aggregate_revision, payload, occurred_at, dispatched_at)
          select ${row.id}::uuid, workspace_id, change_seq, ${row.ordinal}::int, ${row.type}, ${row.schemaVersion}::int, aggregate_type, aggregate_id, aggregate_revision,
            ${JSON.stringify(row.payload)}::text::jsonb, occurred_at - make_interval(mins => ${row.minutesEarlier}::int), null
          from outbox_events where id = ${f.request.id}::uuid`;
      }
      const insertedBefore = await outboxRows(inserted.map((row) => row.id));
      expect(insertedBefore).toHaveLength(inserted.length);

      // Health counts only the subscribed type: the valid row pending, the malformed rows retained, the legacy row nowhere.
      const health = await relay.getHealth();
      expect(health).toMatchObject({ pendingSubscribedCount: 1, unsupportedSubscribedCount: poison.length });
      expect(health.oldestSubscribedAt).not.toBeNull();

      // limit 1 still reaches the valid row behind every older poison row.
      expect(await relay.relayBatch(enqueue, 1)).toEqual({ selectedCount: 1, enqueuedCount: 1, unsupportedRetainedCount: poison.length });
      expect(await jobById(f.request.id)).toMatchObject({ state: 'created' });
      for (const row of inserted) expect(await jobById(row.id), row.id).toBeUndefined();
      expect(await relay.relayBatch(enqueue, 1)).toEqual({ selectedCount: 0, enqueuedCount: 0, unsupportedRetainedCount: poison.length });
      expect(await relay.relayBatch(enqueue)).toEqual({ selectedCount: 0, enqueuedCount: 0, unsupportedRetainedCount: poison.length });
      expect(await queue().findJobs(QUEUE, { data: { bindingId: f.bindingId } })).toHaveLength(1);
      expect(await relay.getHealth()).toEqual({ pendingSubscribedCount: 0, oldestSubscribedAt: null, oldestSubscribedAgeMs: null, unsupportedSubscribedCount: poison.length });
      // Retained, not acknowledged, byte-identical; the legacy row too.
      expect(await outboxRows(inserted.map((row) => row.id))).toEqual(insertedBefore);

      const [delivery, ...extra] = await deliverQueued();
      expect(extra).toEqual([]);
      expect(delivery?.result).toMatchObject({ status: 'complete', bindingId: f.bindingId, createdCount: 5 });
      expect(await outboxRows(inserted.map((row) => row.id))).toEqual(insertedBefore);
    } finally {
      // Synthetic rows of this throwaway database only.
      await h.db.sql`delete from outbox_events where id::text in ${h.db.sql(inserted.map((row) => row.id))}`;
    }
    expect((await relay.getHealth()).unsupportedSubscribedCount).toBe(0);
    await expectQueueIdle();
  }, 60_000);

  it('redelivers a job whose domain commit lost its acknowledgement and the retry on a restarted client creates nothing new', async () => {
    const f = await seriesFixture('Потерянное подтверждение очереди');
    expect(await relay.relayBatch(enqueue, 100)).toEqual({ selectedCount: 1, enqueuedCount: 1, unsupportedRetainedCount: 0 });
    const jobId = f.request.id;
    expect(await jobById(jobId)).toMatchObject({ state: 'created', retryCount: 0, ...MATERIALIZE_JOB_RETRY });

    const crashed: Attempt[] = [];
    const restarted: Attempt[] = [];
    const errors: unknown[] = [];
    let committed: Composition[] | undefined;
    let committedRows: DatabaseSnapshot | undefined;
    let first: PgBoss | undefined;
    let second: PgBoss | undefined;
    let firstWorking = false;
    let secondWorking = false;
    try {
      first = await startBoss(errors);
      await wrapPgBoss(first).work(QUEUE, WORK_OPTIONS, async (jobs) => {
        const result = (await handler.handle(jobs)) as MaterializationJobResult;
        crashed.push({ retryCount: jobs[0]?.retryCount ?? -1, result });
        committed = await compositions(f.series.id, f.week.id);
        committedRows = await databaseSnapshot(h.db.sql);
        throw new LostAcknowledgement();
      });
      firstWorking = true;
      const retrying = await waitFor('the first attempt to go back to retry', async () => {
        const job = await jobById(jobId);
        return job?.state === 'retry' ? job : undefined;
      });
      expect(retrying.retryCount).toBe(0);
      // Restart: the crashed client stops; a fresh runtime-configured client receives the retry.
      await stopBoss(first, firstWorking);
      first = undefined;
      expect(crashed).toHaveLength(1);

      second = await startBoss(errors);
      await wrapPgBoss(second).work(QUEUE, WORK_OPTIONS, async (jobs) => {
        const result = (await handler.handle(jobs)) as MaterializationJobResult;
        restarted.push({ retryCount: jobs[0]?.retryCount ?? -1, result });
        return result;
      });
      secondWorking = true;
      const done = await waitFor('the redelivered attempt to complete', async () => {
        const job = await jobById(jobId);
        return job?.state === 'completed' ? job : undefined;
      });
      const base = { bindingId: f.bindingId, periodId: f.week.id, remainingCount: 0, blockedCode: null };
      expect(crashed).toEqual([{ retryCount: 0, result: { status: 'complete', createdCount: 5, ...base } }]);
      // Durable receipt replays the original operation count, not a count of new rows on this delivery.
      expect(restarted).toEqual([{ retryCount: 1, result: { status: 'complete', createdCount: 5, ...base } }]);
      expect(done).toMatchObject({ state: 'completed', retryCount: 1, output: { status: 'complete', createdCount: 5, ...base } });
    } finally {
      await stopBoss(first, firstWorking);
      await stopBoss(second, secondWorking);
    }

    if (committed === undefined || committedRows === undefined) throw new Error('The first attempt must have committed before its lost acknowledgement.');
    const after = await compositions(f.series.id, f.week.id);
    expect(after).toEqual(committed);
    expectDistinctCompositions(after, 5);
    expect(await databaseSnapshot(h.db.sql)).toEqual(committedRows);
    // Current generation authorization is checked before serving even a completed durable receipt.
    const authorizer = await membershipRow(h.db.sql, TEAM, M.teamOwner);
    await revokeMembership(h.db.sql, TEAM, M.teamOwner);
    try {
      const revoked = await databaseSnapshot(h.db.sql);
      const stored = await jobById(jobId);
      if (stored === undefined || database === undefined) throw new Error('Completed job and database required.');
      const fresh = createMaterializationHandler({ facade: createRecurrenceWorkerFacade(database), logger });
      const denied = await fresh.handle([{ id: jobId, data: stored.data, retryCount: 2 }]);
      expect(denied).toMatchObject({ status: 'blocked', blockedCode: 'authorizer_inactive', createdCount: 0 });
      expect(await databaseSnapshot(h.db.sql)).toEqual(revoked);
    } finally {
      await restoreMembership(h.db.sql, TEAM, M.teamOwner, authorizer);
    }
    expect(await databaseSnapshot(h.db.sql)).toEqual(committedRows);
    expect(await owner.meetings(f.project.id, f.week.id)).toHaveLength(5);
    expect(await owner.packages(f.project.id)).toHaveLength(5);
    await expectNoAutomaticTime(f.week.id, after);
    expect(errors).toEqual([]);
    await expectQueueIdle();
  }, 90_000);

  it('blocks a revoked stored authorizer without impersonating the owner or organizer; explicit owner reauthorization completes only current jobs', async () => {
    // Ordinary member A authors the grant; the owner is both organizer and attendee but never substituted.
    const f = await seriesFixture('Отозванный автор генерации', { creator: member });
    expect(f.series.generation).toMatchObject({ state: 'ready', blockedCode: null, authorizerMembershipId: M.teamMemberA });
    const oldRevision = f.series.generation.authorizationRevision;
    if (oldRevision === null) throw new Error('A created series must carry its generation grant.');
    expect(f.request.payload.authorizationRevision).toBe(oldRevision);
    expect(await relay.relayBatch(enqueue, 100)).toEqual({ selectedCount: 1, enqueuedCount: 1, unsupportedRetainedCount: 0 });

    const original = await membershipRow(h.db.sql, TEAM, M.teamMemberA);
    try {
      await revokeMembership(h.db.sql, TEAM, M.teamMemberA);
      const beforeBlocked = await databaseSnapshot(h.db.sql);
      const [blocked, ...extra] = await deliverQueued();
      expect(extra).toEqual([]);
      if (blocked === undefined) throw new Error('The revoked authorizer job must be delivered.');
      expect(blocked.job.id).toBe(f.request.id);
      expect(blocked.result).toEqual({ status: 'blocked', bindingId: f.bindingId, periodId: f.week.id, createdCount: 0, remainingCount: 0, blockedCode: 'authorizer_inactive' });
      expect(await databaseSnapshot(h.db.sql)).toEqual(beforeBlocked);
      expect(located(await compositions(f.series.id, f.week.id))).toEqual([]);
      // Controlled outcome: acknowledged with metadata only, no hot retry.
      expect(await jobById(f.request.id)).toMatchObject({ state: 'completed', retryCount: 0, output: blocked.result });
      const blockedSeries = await getSeries(f.series.id);
      expect(blockedSeries.generation).toMatchObject({ state: 'blocked', blockedCode: 'authorizer_inactive', authorizerMembershipId: M.teamMemberA, authorizationRevision: oldRevision });

      // Narrow metadata recovery: the owner explicitly re-grants while the old grant is revoked.
      const known = new Set((await requests(f.series.id)).map((row) => row.id));
      const reauthorized = expectEnvelope(
        await owner.post(`/recurrence-series/${f.series.id}/generation-authorization`, { expectedRevision: blockedSeries.revision, expectedAuthorizationRevision: oldRevision }),
        200, recurrenceSeriesResponseSchema,
      ).data;
      expect(reauthorized.generation).toMatchObject({ state: 'ready', blockedCode: null, authorizerMembershipId: M.teamOwner, authorizationRevision: oldRevision + 1 });
      const current = await bindingOf(f.week.id, f.series.id);
      expect(current.sourceManifestHash).not.toBe(f.request.payload.sourceManifestHash);
      expect((await newRequests(f.series.id, known)).map((row) => row.payload)).toEqual([
        { seriesId: f.series.id, bindingId: f.bindingId, sourceManifestHash: current.sourceManifestHash, authorizationRevision: oldRevision + 1 },
      ]);

      // A late redelivery of the old-grant payload never materializes, under anyone.
      const replay = (await handler.handle([{ ...blocked.job, retryCount: blocked.job.retryCount + 1 }])) as MaterializationJobResult;
      expect(['stale', 'blocked']).toContain(replay.status);
      expect(replay).toMatchObject({ bindingId: f.bindingId, periodId: f.week.id, createdCount: 0 });
      expect(located(await compositions(f.series.id, f.week.id))).toEqual([]);

      const seq = await changeSeq();
      expect((await relay.relayBatch(enqueue, 100)).unsupportedRetainedCount).toBe(0);
      const deliveries = await deliverQueued();
      expect(deliveries.length).toBeGreaterThanOrEqual(1);
      for (const delivery of deliveries) {
        expect(delivery.job.data).toMatchObject({ bindingId: f.bindingId, authorizationRevision: oldRevision + 1, sourceManifestHash: current.sourceManifestHash });
        expect(delivery.result).toMatchObject({ status: 'complete', blockedCode: null });
      }
      expect(deliveries.reduce((sum, delivery) => sum + delivery.result.createdCount, 0)).toBe(5);
      const materialized = await compositions(f.series.id, f.week.id);
      expectDistinctCompositions(materialized, 5);
      await expectNoAutomaticTime(f.week.id, materialized);

      // Provenance from the actual schema: job writes run as the explicit current authorizer with source job.
      const jobAudit = await h.db.sql<{ actor: string; source: string }[]>`
        select distinct actor_user_id::text as actor, source::text as source
        from audit_events where workspace_id = ${TEAM} and source = 'job' and change_seq > ${seq}::bigint`;
      expect(jobAudit.map((row) => ({ ...row }))).toEqual([{ actor: USERS.owner, source: 'job' }]);
      const [asRevoked] = await h.db.sql<{ count: number }[]>`
        select count(*)::int as count from audit_events where workspace_id = ${TEAM} and source = 'job' and actor_user_id = ${USERS.memberA}`;
      expect(asRevoked?.count).toBe(0);
      const grants = await h.db.sql<{ revision: number; authorizer: string; membership: string; actor: string; source: string }[]>`
        select revision, authorizer_user_id::text as authorizer, authorizer_membership_id::text as membership, actor_user_id::text as actor, source::text as source
        from recurrence_generation_authorizations where workspace_id = ${TEAM} and series_id = ${f.series.id} order by revision`;
      expect(grants.map((row) => ({ ...row }))).toEqual([
        { revision: oldRevision, authorizer: USERS.memberA, membership: M.teamMemberA, actor: USERS.memberA, source: 'web' },
        { revision: oldRevision + 1, authorizer: USERS.owner, membership: M.teamOwner, actor: USERS.owner, source: 'web' },
      ]);
    } finally {
      await restoreMembership(h.db.sql, TEAM, M.teamMemberA, original);
    }
    expect(await membershipRow(h.db.sql, TEAM, M.teamMemberA)).toEqual(original);
    await expectQueueIdle();
  }, 60_000);

  it('pauses only background preparation, rejects a payload actor before writes, and refreshes a stale manifest exactly once on resume', async () => {
    const shared = await planningProject(owner, 'Пауза фоновой подготовки');
    const near = await seriesFixture('Синхронная подготовка на паузе', { project: shared });
    // Ten weeks ahead: no 28-day horizon, every registered candidate of the bound period.
    const far = await seriesFixture('Фоновая подготовка через десять недель', { project: shared, weeksAhead: 10 });
    expect(await relay.relayBatch(enqueue, 100)).toEqual({ selectedCount: 2, enqueuedCount: 2, unsupportedRetainedCount: 0 });

    expect((await setState(near.series.id, 'paused')).state).toBe('paused');
    expect((await setState(far.series.id, 'paused')).state).toBe('paused');
    expect(await requests(near.series.id)).toHaveLength(1);
    expect(await requests(far.series.id)).toHaveLength(1);
    const paused = await deliverQueued();
    expect(paused.map((delivery) => delivery.result.bindingId).sort()).toEqual([near.bindingId, far.bindingId].sort());
    for (const delivery of paused) expect(delivery.result).toMatchObject({ status: 'paused', createdCount: 0, blockedCode: null });
    expect(located(await compositions(near.series.id, near.week.id))).toEqual([]);
    expect(located(await compositions(far.series.id, far.week.id))).toEqual([]);
    await expectQueueIdle();

    // The synchronous API still ensures the full census of a paused series.
    const sync = expectEnvelope(await owner.post(`/periods/${near.week.id}/materialize-meetings`, {}), 200, recurrenceMaterializationResultResponseSchema).data;
    expect(sync).toMatchObject({ periodId: near.week.id, status: 'complete', createdCount: 5, remainingCount: 0, nextCursor: null, frozenBaselineIds: [] });
    expect(sync.bindings).toEqual([expect.objectContaining({ bindingId: near.bindingId, seriesId: near.series.id, state: 'complete', createdCount: 5, remainingCount: 0 })]);
    const nearMaterialized = await compositions(near.series.id, near.week.id);
    expectDistinctCompositions(nearMaterialized, 5);
    await expectNoAutomaticTime(near.week.id, nearMaterialized);
    expect((await getSeries(near.series.id)).state).toBe('paused');
    expect(located(await compositions(far.series.id, far.week.id))).toEqual([]);

    // Resume requests exactly one current v1 row for its own binding.
    const known = new Set((await requests(far.series.id)).map((row) => row.id));
    const resumed = await setState(far.series.id, 'active');
    expect(resumed.state).toBe('active');
    const beforeSkip = await bindingOf(far.week.id, far.series.id);
    const [resumeRequest, ...extraResume] = await newRequests(far.series.id, known);
    expect(extraResume).toEqual([]);
    if (resumeRequest === undefined) throw new Error('Resume must request materialization.');
    expect(resumeRequest.payload).toEqual({
      seriesId: far.series.id, bindingId: far.bindingId, sourceManifestHash: beforeSkip.sourceManifestHash, authorizationRevision: resumed.generation.authorizationRevision,
    });
    expect(await requests(near.series.id)).toHaveLength(1);

    // A generation input changes after the request: the queued manifest becomes stale.
    const friday = addDays(far.week.localStart, 4);
    expect(await skip(far.series.id, far.week.id, friday)).toMatchObject({ occurrenceKey: friday, calendarState: 'cancelled', meetingId: null });
    const afterSkip = await bindingOf(far.week.id, far.series.id);
    expect(afterSkip.sourceManifestHash).not.toBe(beforeSkip.sourceManifestHash);
    expect(await newRequests(far.series.id, known)).toHaveLength(1);

    expect(await relay.relayBatch(enqueue, 100)).toEqual({ selectedCount: 1, enqueuedCount: 1, unsupportedRetainedCount: 0 });
    const queued = await jobById(resumeRequest.id);
    expect(queued).toMatchObject({ state: 'created', data: { bindingId: far.bindingId, sourceManifestHash: beforeSkip.sourceManifestHash } });
    // A payload actor is rejected strictly before any write, by the handler and by the facade.
    const forged = { ...(queued?.data as RecurrenceMaterializationJob), actorUserId: USERS.memberA };
    const beforeForged = await databaseSnapshot(h.db.sql);
    const rejected = handler.counters().rejected;
    await expect(handler.handle([{ id: randomUUID(), data: forged, retryCount: 0 }])).rejects.toBeInstanceOf(InvalidMaterializationJobError);
    await expect(facade.materializeBinding(forged as RecurrenceMaterializationJob)).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    expect(handler.counters().rejected).toBe(rejected + 1);
    expect(await databaseSnapshot(h.db.sql)).toEqual(beforeForged);

    const [stale, ...extraStale] = await deliverQueued();
    expect(extraStale).toEqual([]);
    if (stale === undefined) throw new Error('The resume job must be delivered.');
    expect(stale.job.id).toBe(resumeRequest.id);
    expect(stale.result).toMatchObject({ status: 'stale', bindingId: far.bindingId, periodId: far.week.id, createdCount: 0, blockedCode: null });
    expect(located(await compositions(far.series.id, far.week.id))).toEqual([]);
    const refreshKnown = new Set([...known, resumeRequest.id]);
    const [refresh, ...extraRefresh] = await newRequests(far.series.id, refreshKnown);
    expect(extraRefresh).toEqual([]);
    expect(refresh).toMatchObject({ dispatched: false, payload: { ...resumeRequest.payload, sourceManifestHash: afterSkip.sourceManifestHash } });
    // A fresh facade/handler must recover the durable stale outcome after a lost acknowledgement.
    // Public state, including the refresh event and idempotency outcome, cannot change on redelivery.
    if (database === undefined) throw new Error('Worker database required.');
    const staleCommitted = await databaseSnapshot(h.db.sql);
    const restarted = createMaterializationHandler({ facade: createRecurrenceWorkerFacade(database), logger });
    const again = (await restarted.handle([{ ...stale.job, retryCount: stale.job.retryCount + 1 }])) as MaterializationJobResult;
    expect(again).toMatchObject({ status: 'stale', createdCount: 0 });
    expect(await databaseSnapshot(h.db.sql)).toEqual(staleCommitted);
    expect(await newRequests(far.series.id, refreshKnown)).toHaveLength(1);

    expect(await relay.relayBatch(enqueue, 100)).toEqual({ selectedCount: 1, enqueuedCount: 1, unsupportedRetainedCount: 0 });
    const [current, ...extraCurrent] = await deliverQueued();
    expect(extraCurrent).toEqual([]);
    expect(current?.job.data).toMatchObject({ bindingId: far.bindingId, sourceManifestHash: afterSkip.sourceManifestHash });
    expect(current?.result).toEqual({ status: 'complete', bindingId: far.bindingId, periodId: far.week.id, createdCount: 4, remainingCount: 0, blockedCode: null });
    const farMaterialized = await compositions(far.series.id, far.week.id);
    expectDistinctCompositions(farMaterialized, 4);
    expect(farMaterialized.find((item) => item.occurrenceKey === friday)).toMatchObject({ calendarState: 'cancelled', meetingId: null, taskId: null, workPackageId: null });
    expect(await owner.meetings(shared.project.id, far.week.id)).toHaveLength(4);
    await expectNoAutomaticTime(far.week.id, farMaterialized);
    await expectQueueIdle();
  }, 90_000);

  it('keeps a terminally failed job in the dead-letter queue and the real worker runtime reports it as degraded with metadata only', async () => {
    if (database === undefined) throw new Error('Worker database required.');
    const sentinel = `private-${randomUUID()}`;
    const runtime = createWorkerRuntime<WorkloomExecutor>({
      config: { jobConcurrency: 1, pollIntervalMs: 500, shutdownTimeoutMs: 5_000 },
      logger, readiness: createReadinessProbe(database), queue: wrapPgBoss(new PgBoss(workerBossOptions())),
      facade, relay, relayBatchLimit: 10,
      cutoffFacade: createCutoffWorkerFacade(database), cutoffRelay: createCutoffOutboxRelay(database), cutoffDiscovery: createCutoffDiscovery(database),
    });
    try {
      await runtime.start();
      expect(runtime.lifecycle).toBe('running');
      const started = await runtime.health();
      expect(started.queues.map((item) => [item.name, item.state])).toEqual([[DLQ, 'ready'], [QUEUE, 'ready'], [CUTOFF_DEAD_LETTER_QUEUE, 'ready'], [CUTOFF_QUEUE, 'ready']]);
      expect(started.relay).toMatchObject({ state: 'ok', pendingSubscribedCount: 0, unsupportedSubscribedCount: 0 });

      // A job carrying an actor and private text is not a materialization job. Only this isolated job
      // drops its retry budget to 0 so it fails terminally inside the wait; the queue rows stay as approved.
      const poisonId = randomUUID();
      const poisonData = {
        workspaceId: TEAM, seriesId: randomUUID(), bindingId: randomUUID(), sourceManifestHash: 'a'.repeat(64), authorizationRevision: 1,
        requestId: materializationRequestId(poisonId), actorUserId: USERS.owner, title: sentinel,
      };
      expect(recurrenceMaterializationJobSchema.safeParse(poisonData).success).toBe(false);
      await queue().send(QUEUE, poisonData, { id: poisonId, group: { id: TEAM }, retryLimit: 0 });

      const failed = await waitFor('terminal failure of the invalid job', async () => {
        const job = await jobById(poisonId);
        return job?.state === 'failed' ? job : undefined;
      });
      expect(failed).toMatchObject({ retryCount: 0, retryLimit: 0, deadLetter: DLQ });
      expect(JSON.stringify(failed.output)).not.toContain(sentinel);
      const dead = await waitFor('the dead-letter copy', async () => (await queue().findJobs<unknown>(DLQ, {})).find((job) => job.sourceId === poisonId));
      expect(dead).toMatchObject({ name: DLQ, state: 'created', sourceName: QUEUE });

      // Counts are stored queue-row stats: an explicit supervise pass refreshes them; health itself is not mocked.
      const report = await waitFor('the runtime health to report the failure', async () => {
        await queue().supervise();
        const health = await runtime.health();
        return health.reasons.includes('queue_failed_jobs') && health.reasons.includes('dead_letter_jobs') ? health : undefined;
      }, { intervalMs: 250 });
      expect(report.status).toBe('degraded');
      expect(report.lifecycle).toBe('running');
      expect(report.reasons).toContain('job_failures_recent');
      expect(report.queues.map((item) => [item.name, item.state, item.mismatchedProperties])).toEqual([[DLQ, 'ready', []], [QUEUE, 'ready', []], [CUTOFF_DEAD_LETTER_QUEUE, 'ready', []], [CUTOFF_QUEUE, 'ready', []]]);
      expect(report.reportedDeadLetterCount).toBeGreaterThanOrEqual(1);
      expect(report.jobs).toMatchObject({ rejected: 1, failed: 0 });
      expect(report.relay).toMatchObject({ state: 'ok', pendingSubscribedCount: 0, unsupportedSubscribedCount: 0 });
      const serialized = JSON.stringify(report);
      expect(serialized).not.toContain(sentinel);
      expect(serialized).not.toContain(poisonId);
      // Nothing re-queues or consumes the dead letter.
      expect((await queue().findJobs<unknown>(DLQ, {})).find((job) => job.sourceId === poisonId)?.state).toBe('created');
    } finally {
      await runtime.shutdown('test_complete');
    }
    expect(runtime.lifecycle).toBe('stopped');
    for (const { name, expected } of WORKLOOM_QUEUE_REGISTRATIONS) {
      expect(findQueueOptionMismatches(expected, (await queue().getQueue(name)) ?? {}), name).toEqual([]);
    }
    expect(bossErrors).toEqual([]);
  }, 60_000);
});
