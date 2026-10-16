// Actual pg-boss lifecycle on a standard owned throwaway child, using source factories only.
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import type { CutoffJob, CutoffRequestedEvent } from '@workloom/contracts';
import { CUTOFF_QUEUE, CUTOFF_DEAD_LETTER_QUEUE, WORKLOOM_QUEUE_REGISTRATIONS, WORKLOOM_QUEUE_SCHEMA, createDatabase, createReadinessProbe, createCutoffApplication, createCutoffWorkerFacade, createCutoffDiscovery, createCutoffOutboxRelay, createRecurrenceOutboxRelay, createRecurrenceWorkerFacade, migrateWorkloomQueue, runMigrations, seedDemoData, schema, parseDatabaseUrl, FIXTURE_USER_IDS as U, FIXTURE_MEMBERSHIP_IDS as M, FIXTURE_WORKSPACE_IDS as W, type Database, type WorkloomExecutor } from '@workloom/db';
import type { CommandContext } from '@workloom/domain';
import { createCutoffEnqueue, createCutoffHandler, createWorkerRuntime, createWorkerLogger, pgBossRuntimeOptions, wrapPgBoss, type WorkerRuntime } from '@workloom/worker';
import { PgBoss } from 'pg-boss';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createThrowawayDatabase, type ThrowawayDatabase } from './support/test-database.js';
import { requireTestDatabaseUrl } from './support/test-database-url.js';
import { repoRoot } from './support/api-process.js';

requireTestDatabaseUrl();
function required<T>(value: T | undefined | null): T { if (value === undefined || value === null) throw new Error('Expected test fixture value.'); return value; }

const context = (): CommandContext => ({ workspaceId: W.team, actor: { userId: U.owner, kind: 'fixture', displayName: 'Queue fixture' }, source: 'web', requestId: randomUUID(), idempotencyKey: randomUUID() });
async function waitFor<T>(probe: () => Promise<T | undefined>, timeout = 30_000): Promise<T> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { const result = await probe(); if (result !== undefined) return result; await delay(50); }
  throw new Error('Timed out waiting for the owned cutoff worker test.');
}

let target: ThrowawayDatabase | undefined;
let db: Database;
let observer: PgBoss | undefined;
const runtimes: WorkerRuntime[] = [];
const queueErrors: unknown[] = [];
const lines: string[] = [];
const logger = createWorkerLogger({ level: 'trace', sink: line => lines.push(line) });
function bossOptions() { return { ...pgBossRuntimeOptions({ database: parseDatabaseUrl(required(target).url, { requireLoopback: true }), queuePoolMax: 2 }, { schema: WORKLOOM_QUEUE_SCHEMA }), supervise: false, monitorIntervalSeconds: 1 }; }
function runtime() {
  const boss = new PgBoss(bossOptions());
  const instance = createWorkerRuntime<WorkloomExecutor>({ config: { jobConcurrency: 2, pollIntervalMs: 500, shutdownTimeoutMs: 5000 }, logger,
    readiness: createReadinessProbe(db), queue: wrapPgBoss(boss), facade: createRecurrenceWorkerFacade(db), relay: createRecurrenceOutboxRelay(db),
    cutoffFacade: createCutoffWorkerFacade(db), cutoffRelay: createCutoffOutboxRelay(db), cutoffDiscovery: createCutoffDiscovery(db),
  });
  runtimes.push(instance); return instance;
}
async function fixture(cutoffAt: string) {
  const projectId = randomUUID(), periodId = randomUUID();
  await db.db.insert(schema.projects).values({ id: projectId, workspaceId: W.team, name: 'Queue cutoff project' });
  await db.db.insert(schema.planningPeriods).values({ id: periodId, workspaceId: W.team, projectId, name: 'Queue deadline', localStart: '2026-10-12', localEndExclusive: '2026-10-19', timezone: 'UTC', cutoffAt: new Date(cutoffAt), revision: 1, protectedFieldIds: [], protectEstimate: true, createdAt: new Date(), updatedAt: new Date() });
  const configured = await createCutoffApplication(db).configure(context(), periodId, { expectedPeriodRevision: 1, expectedGrantRevision: 0, enabled: true });
  expect(configured.requestId).not.toBeNull();
  const [row] = await db.sql<{ id: string; payload: CutoffRequestedEvent['payload'] }[]>`select id::text, payload from outbox_events where type='planning.cutoff_requested' and payload->>'requestId'=${configured.requestId}`;
  if (row === undefined) throw new Error('Missing committed cutoff request.');
  return { projectId, periodId, requestId: required(configured.requestId), eventId: row.id, job: { schemaVersion: 1, workspaceId: W.team, ...row.payload } as CutoffJob };
}
async function baselines(periodId: string) { return db.sql`select id, frozen_at from plan_baselines where period_id=${periodId} and scope='project'`; }
async function cli() {
  return new Promise<{ code: number | null; output: string }>((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', 'packages/db/src/cli/queue-migrate.ts'], { cwd: repoRoot, env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', APP_ENV: 'local', AUTH_MODE: 'dev', DATABASE_URL: required(target).url }, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', (chunk: Buffer) => { output += chunk.toString(); }); child.stderr.on('data', (chunk: Buffer) => { output += chunk.toString(); });
    const timeout = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('Owned queue CLI test timed out.')); }, 30000);
    child.on('error', error => { clearTimeout(timeout); reject(error); });
    child.on('exit', code => { clearTimeout(timeout); resolve({ code, output }); });
  });
}

describe('cutoff worker runtime on an owned real PostgreSQL queue', () => {
  beforeAll(async () => {
    target = await createThrowawayDatabase('cutoff_runtime');
    console.info(`CUTOFF_RUNTIME_DISPOSABLE_DB=${target.name}`);
    await runMigrations(target.url, { requireLoopback: true });
    db = createDatabase(target.url, { requireLoopback: true, maxConnections: 5 });
    await seedDemoData(db);
    const installed = await migrateWorkloomQueue(target.url);
    expect(installed.queueNames).toEqual(WORKLOOM_QUEUE_REGISTRATIONS.map(item => item.name));
    observer = new PgBoss(bossOptions()); observer.on('error', error => queueErrors.push(error)); await observer.start();
  }, 60000);
  afterAll(async () => {
    try { for (const instance of runtimes) await instance.shutdown('test_cleanup'); await observer?.stop({ graceful: true, close: true, timeout: 5000 }); }
    finally { try { await db?.close(); } finally { await target?.drop(); } }
    expect(queueErrors).toEqual([]);
  });

  it('explicit CLI adds both cutoff registrations, preserves existing recurrence rows and reports all four', async () => {
    // Only this owned child: emulate the accepted previous two-queue installation.
    await required(observer).deleteQueue(CUTOFF_QUEUE);
    await required(observer).deleteQueue(CUTOFF_DEAD_LETTER_QUEUE);
    const previous = await db.sql`select to_jsonb(q) as row from workloom_queue.queue q order by name`;
    expect(previous).toHaveLength(2);
    const result = await cli(); expect(result.code).toBe(0);
    const retained = await db.sql`select to_jsonb(q) as row from workloom_queue.queue q where name not in (${CUTOFF_QUEUE},${CUTOFF_DEAD_LETTER_QUEUE}) order by name`;
    expect(retained).toEqual(previous);
    expect(result.output).toContain(`queues ${WORKLOOM_QUEUE_REGISTRATIONS.map(item => item.name).join(', ')} are ready.`);
    for (const item of WORKLOOM_QUEUE_REGISTRATIONS) expect(await required(observer).getQueue(item.name)).toMatchObject(item.expected);
  });

  it('atomically schedules at the stored instant, rolls back failed delivery and isolates exact-event poison', async () => {
    const cutoffAt = new Date(Date.now() + 3600000).toISOString();
    const f = await fixture(cutoffAt);
    const relay = createCutoffOutboxRelay(db), enqueue = createCutoffEnqueue<WorkloomExecutor>(wrapPgBoss(required(observer)));
    await expect(relay.relayBatch(async (tx, event) => { await enqueue(tx, event); throw new Error('Queue rollback sentinel'); }, 100)).rejects.toThrow('Queue rollback sentinel');
    expect(await required(observer).getJobById(CUTOFF_QUEUE, f.eventId)).toBeNull();
    const [undispatched] = await db.sql`select dispatched_at from outbox_events where id=${f.eventId}`;
    expect(undispatched?.dispatched_at).toBeNull();
    const poison = randomUUID(), unrelated = randomUUID();
    await db.sql`insert into outbox_events(id,workspace_id,change_seq,event_ordinal,type,schema_version,aggregate_type,aggregate_id,payload,occurred_at) values(${poison},${W.team},900001,1,'planning.cutoff_requested',99,'test',${randomUUID()},'{}',now()),(${unrelated},${W.team},900002,1,'unrelated.cutoff',1,'test',${randomUUID()},'{}',now())`;
    const batch = await relay.relayBatch(enqueue, 100);
    expect(batch).toEqual({ selectedCount: 1, enqueuedCount: 1, unsupportedRetainedCount: 1 });
    const queued = await required(observer).getJobById<CutoffJob>(CUTOFF_QUEUE, f.eventId);
    expect(queued?.data).toEqual(f.job);
    expect(queued?.startAfter.toISOString()).toBe(cutoffAt);
    expect(await required(observer).fetch(CUTOFF_QUEUE)).toEqual([]);
    expect(await baselines(f.periodId)).toEqual([]);
    const untouched = await db.sql`select dispatched_at from outbox_events where id in (${poison},${unrelated})`;
    expect(untouched.every(row => row.dispatched_at === null)).toBe(true);
    expect((await relay.getHealth()).unsupportedSubscribedCount).toBe(1);
  });

  it('recovers a normal early-delivery continuation after restart without delivery before the stored deadline', async () => {
    const f = await fixture(new Date(Date.now() + 5000).toISOString());
    // Actual domain path: the early receipt and a fresh continuation/outbox commit together.
    const early = await createCutoffWorkerFacade(db).freezeDuePeriod(f.job);
    expect(early.status).toBe('not_due');
    expect(early.nextRequestId).not.toBe(f.requestId);
    const [nextEvent] = await db.sql<{ id: string }[]>`select id::text from outbox_events where type='planning.cutoff_requested' and payload->>'requestId'=${required(early.nextRequestId)}`;
    const continuationEventId = required(nextEvent).id;
    await createCutoffOutboxRelay(db).relayBatch(createCutoffEnqueue<WorkloomExecutor>(wrapPgBoss(required(observer))), 100);
    const first = runtime(); await first.start();
    expect((await first.health()).queues).toHaveLength(4);
    expect(await baselines(f.periodId)).toEqual([]);
    await first.shutdown('SIGTERM');
    expect((await required(observer).getJobById(CUTOFF_QUEUE, continuationEventId))?.state).toBe('created');
    expect((await required(observer).getJobById(CUTOFF_QUEUE, continuationEventId))?.startAfter.toISOString()).toBe(f.job.cutoffAt);
    const second = runtime(); await second.start();
    const completed = await waitFor(async () => { const job = await required(observer).getJobById(CUTOFF_QUEUE, continuationEventId); return job?.state === 'completed' ? job : undefined; });
    expect(required(completed.startedOn).getTime()).toBeGreaterThanOrEqual(Date.parse(f.job.cutoffAt));
    expect(completed.output).toMatchObject({ status: 'frozen', periodId: f.periodId });
    const frozen = await baselines(f.periodId); expect(frozen).toHaveLength(1);
    expect(new Date(required(frozen[0]).frozen_at as string).getTime()).toBeGreaterThanOrEqual(Date.parse(f.job.cutoffAt));
    expect(await createCutoffWorkerFacade(db).freezeDuePeriod(f.job)).toEqual(early);
    const originalQueued = await required(observer).getJobById(CUTOFF_QUEUE, f.eventId);
    expect(originalQueued?.output).toEqual(early);
    expect(await baselines(f.periodId)).toEqual(frozen);
    expect(await db.sql`select id from weekly_report_runs where period_id=${f.periodId}`).toEqual([]);
    await second.shutdown('SIGTERM');
  }, 30000);

  it('replays a cutoff receipt after a real lost queue acknowledgement and consumer restart', async () => {
    const f = await fixture(new Date(Date.now() - 60000).toISOString());
    await createCutoffOutboxRelay(db).relayBatch(createCutoffEnqueue<WorkloomExecutor>(wrapPgBoss(required(observer))), 100);
    const crashed = new PgBoss(bossOptions()); crashed.on('error', error => queueErrors.push(error));
    await crashed.start();
    const handler = createCutoffHandler({ facade: createCutoffWorkerFacade(db), logger });
    let committed: object | undefined;
    try {
      await crashed.work(CUTOFF_QUEUE, { batchSize: 1, localConcurrency: 1, pollingIntervalSeconds: 0.5 }, async jobs => {
        committed = await handler.handle(jobs);
        throw new Error('Synthetic lost acknowledgement after committed cutoff.');
      });
      await waitFor(async () => { const job = await required(observer).getJobById(CUTOFF_QUEUE, f.eventId); return job?.state === 'retry' ? job : undefined; });
      expect(await baselines(f.periodId)).toHaveLength(1);
    } finally { await crashed.offWork(CUTOFF_QUEUE, { wait: true }); await crashed.stop({ graceful: true, close: true, timeout: 5000 }); }
    const restarted = runtime(); await restarted.start();
    const replayed = await waitFor(async () => { const job = await required(observer).getJobById(CUTOFF_QUEUE, f.eventId); return job?.state === 'completed' ? job : undefined; });
    expect(replayed.retryCount).toBe(1);
    expect(replayed.output).toEqual(required(committed));
    expect(await baselines(f.periodId)).toHaveLength(1);
    expect((await restarted.health()).cutoff?.jobs.outcomes.frozen).toBe(1);
    expect((await restarted.shutdown('SIGTERM')).status).toBe('clean');
  }, 30000);

  it('discovers overdue work after inactivity, persists progress, and visibly dead-letters invalid payloads', async () => {
    const f = await fixture(new Date(Date.now() - 86400000).toISOString());
    // Inject an invariant-recovery state: a terminal historical not_due with no live replacement.
    // Current normal transactions atomically save both and cannot produce this state by crashing.
    // Discovery may repair only now-due authorized not_due; blocked receipts remain suppressed.
    await db.sql`update planning_cutoff_requests set processed_at=now(), processed_actor_user_id=${U.owner}, processed_membership_id=${M.teamOwner}, result=${JSON.stringify({ schemaVersion: 1, requestId: f.requestId, periodId: f.periodId, status: 'not_due', processedAt: new Date().toISOString(), createdCount: 0, remainingCount: 0, baselineId: null, frozenAt: null, nextRequestId: null, blockedCode: null })}::jsonb where id=${f.requestId}`;
    await db.sql`update outbox_events set dispatched_at=now() where id=${f.eventId}`;
    const instance = runtime(); await instance.start();
    await waitFor(async () => (await baselines(f.periodId)).length === 1 ? true : undefined);
    const requests = await db.sql`select id from planning_cutoff_requests where period_id=${f.periodId}`;
    expect(requests.length).toBeGreaterThanOrEqual(2);
    const invalidId = randomUUID(), sentinel = `private-${randomUUID()}`;
    await required(observer).send(CUTOFF_QUEUE, { ...f.job, actorUserId: U.owner, title: sentinel }, { id: invalidId, retryLimit: 0 });
    const failed = await waitFor(async () => { const job = await required(observer).getJobById(CUTOFF_QUEUE, invalidId); return job?.state === 'failed' ? job : undefined; });
    expect(JSON.stringify(failed.output)).not.toContain(sentinel);
    const dead = await waitFor(async () => (await required(observer).findJobs(CUTOFF_DEAD_LETTER_QUEUE, {})).find(job => job.sourceId === invalidId));
    expect(dead.state).toBe('created');
    const health = await waitFor(async () => { await required(observer).supervise(); const report = await instance.health(); return report.reasons.includes('dead_letter_jobs') ? report : undefined; });
    expect(health.status).toBe('degraded');
    expect(health.cutoff?.jobs.rejected).toBe(1);
    expect(health.cutoff?.relay.unsupportedSubscribedCount).toBe(1);
    expect(JSON.stringify(health)).not.toContain(sentinel);
    expect(lines.join('')).not.toContain(sentinel);
    expect((await instance.shutdown('SIGTERM')).status).toBe('clean');
    expect(instance.lifecycle).toBe('stopped');
  }, 45000);
});
