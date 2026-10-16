import { CUTOFF_QUEUE, RECURRENCE_MATERIALIZE_QUEUE, RECURRENCE_QUEUE_REGISTRATIONS, WORKLOOM_QUEUE_REGISTRATIONS, WORKLOOM_QUEUE_SCHEMA } from '@workloom/db';
import type { RecurrenceOutboxRelay } from '@workloom/domain';
import { PgBoss, type DrizzleTransactionLike, type QueueResult } from 'pg-boss';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { loadWorkerConfig } from './config.js';
import type { ApprovedQueueRegistration } from './health.js';
import { createWorkerLogger } from './logging.js';
import { pgBossRuntimeOptions, wrapPgBoss } from './queue.js';
import { createWorkerRuntime } from './runtime.js';

const config = loadWorkerConfig({
  APP_ENV: 'local',
  AUTH_MODE: 'dev',
  DATABASE_URL: 'postgres://workloom:canary-pw@127.0.0.1:5432/workloom',
  WORKER_QUEUE_POOL_MAX: '4',
});

/** A getQueue() row as pg-boss returns it; nullable columns come back as SQL NULL (`null`). */
function queueRow(approved: ApprovedQueueRegistration, nullColumns: Readonly<Record<string, null>> = {}): QueueResult {
  const row: QueueResult = {
    name: approved.name,
    ...approved.options,
    deferredCount: 0,
    blockedCount: 0,
    queuedCount: 1,
    readyCount: 1,
    activeCount: 0,
    failedCount: 0,
    totalCount: 1,
    completedDelta: 0,
    failedDelta: 0,
    createdDelta: 0,
    deltaSeconds: null,
    deltaOn: null,
    waitBins: null,
    runBins: null,
    readyOldestSeconds: null,
    table: 'job_common',
    createdOn: new Date(0),
    updatedOn: new Date(0),
    singletonsActive: null,
  };
  return Object.assign(row, nullColumns);
}

const [DEAD_LETTER, MATERIALIZE] = RECURRENCE_QUEUE_REGISTRATIONS;

/** A real client that never connects: lifecycle and queue calls are spied, mutation APIs must stay untouched. */
function spiedBoss(rows: ReadonlyMap<string, QueueResult>) {
  const boss = new PgBoss(pgBossRuntimeOptions(config, { schema: WORKLOOM_QUEUE_SCHEMA }));
  const spies = {
    start: vi.spyOn(boss, 'start').mockResolvedValue(boss),
    getQueue: vi.spyOn(boss, 'getQueue').mockImplementation(async (name) => rows.get(name) ?? null),
    work: vi.spyOn(boss, 'work').mockResolvedValue('work-id'),
    offWork: vi.spyOn(boss, 'offWork').mockResolvedValue(undefined),
    stop: vi.spyOn(boss, 'stop').mockResolvedValue(undefined),
    send: vi.spyOn(boss, 'send').mockResolvedValue(null),
    forbidden: [
      vi.spyOn(boss, 'createQueue').mockRejectedValue(new Error('forbidden')),
      vi.spyOn(boss, 'updateQueue').mockRejectedValue(new Error('forbidden')),
      vi.spyOn(boss, 'deleteQueue').mockRejectedValue(new Error('forbidden')),
      vi.spyOn(boss, 'deleteAllJobs').mockRejectedValue(new Error('forbidden')),
      vi.spyOn(boss, 'deleteQueuedJobs').mockRejectedValue(new Error('forbidden')),
      vi.spyOn(boss, 'schedule').mockRejectedValue(new Error('forbidden')),
    ],
  };
  return { boss, spies };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('pgBossRuntimeOptions', () => {
  it('never migrates, creates schema, schedules or reindexes, and bounds its own pool', () => {
    expect(pgBossRuntimeOptions(config, { schema: WORKLOOM_QUEUE_SCHEMA })).toMatchObject({
      schema: WORKLOOM_QUEUE_SCHEMA,
      max: 4,
      migrate: false,
      createSchema: false,
      schedule: false,
      reindex: false,
      supervise: true,
      registerInstance: false,
      options: '-c statement_timeout=15000 -c lock_timeout=5000',
    });
  });
});

describe('wrapPgBoss', () => {
  it('projects every approved option as reported, keeping null and absent values distinct', async () => {
    const rows = new Map([[MATERIALIZE.name, queueRow(MATERIALIZE, { retryDelayMax: null })]]);
    const { boss } = spiedBoss(rows);
    const registration = await wrapPgBoss(boss).getQueue(MATERIALIZE.name);

    expect(registration).toMatchObject({ ...MATERIALIZE.expected, retryDelayMax: null, readyCount: 1, queuedCount: 1 });
    const withoutRetention = queueRow(MATERIALIZE);
    delete withoutRetention.retentionSeconds;
    rows.set(MATERIALIZE.name, withoutRetention);
    const absent = await wrapPgBoss(boss).getQueue(MATERIALIZE.name);
    expect(absent?.retentionSeconds).toBeUndefined();
    expect(absent).toHaveProperty('retentionSeconds');
  });

  it('starts a runtime that only reads queue rows and registers both bounded non-transactional consumers', async () => {
    const rows = new Map(WORKLOOM_QUEUE_REGISTRATIONS.map(item => [item.name, queueRow(item, item.expected.deadLetter === null ? { deadLetter: null } : {})]));
    const { boss, spies } = spiedBoss(rows);
    const relay: RecurrenceOutboxRelay<DrizzleTransactionLike> = {
      relayBatch: async () => ({ selectedCount: 0, enqueuedCount: 0, unsupportedRetainedCount: 0 }),
      getHealth: async () => ({ pendingSubscribedCount: 0, oldestSubscribedAt: null, oldestSubscribedAgeMs: null, unsupportedSubscribedCount: 0 }),
    };
    const runtime = createWorkerRuntime<DrizzleTransactionLike>({
      config,
      logger: createWorkerLogger({ level: 'silent' }),
      readiness: { check: async () => ({ ready: true, checks: { database: 'ok', schema: 'ok' } }) },
      queue: wrapPgBoss(boss),
      facade: { materializeBinding: () => Promise.reject(new Error('not called')) },
      relay,
      cutoffFacade: { freezeDuePeriod: () => Promise.reject(new Error('not called')) },
      cutoffRelay: { relayBatch: async () => ({ selectedCount: 0, enqueuedCount: 0, unsupportedRetainedCount: 0 }), getHealth: () => relay.getHealth() },
      cutoffDiscovery: { discoverBatch: async () => ({ selectedCount: 0, requestedCount: 0, blockedCount: 0, cycleComplete: true, leased: true }) },
      discoverySchedule: () => () => undefined,
      relaySchedule: () => () => undefined,
      healthSchedule: () => () => undefined,
    });

    await runtime.start();

    expect(spies.getQueue.mock.calls.map(([name]) => name)).toEqual([...WORKLOOM_QUEUE_REGISTRATIONS, ...WORKLOOM_QUEUE_REGISTRATIONS].map(item => item.name));
    expect(spies.work).toHaveBeenCalledTimes(2);
    expect(spies.work.mock.calls[1]?.[0]).toBe(CUTOFF_QUEUE);
    const [name, options] = spies.work.mock.calls[0] ?? [];
    expect(name).toBe(RECURRENCE_MATERIALIZE_QUEUE);
    expect(options).toStrictEqual({
      batchSize: 1,
      localConcurrency: config.jobConcurrency,
      groupConcurrency: 1,
      pollingIntervalSeconds: config.pollIntervalMs / 1000,
      transactional: false,
    });
    expect(spies.send).not.toHaveBeenCalled();

    await runtime.shutdown('SIGTERM');
    expect(spies.offWork).toHaveBeenCalledWith(RECURRENCE_MATERIALIZE_QUEUE, { wait: false });
    expect(spies.stop.mock.calls.map(([stop]) => stop)).toEqual([
      { graceful: true, close: false, timeout: config.shutdownTimeoutMs },
      { graceful: false, close: true, timeout: config.shutdownTimeoutMs },
    ]);
    for (const forbidden of spies.forbidden) expect(forbidden).not.toHaveBeenCalled();
  });

  it('forwards an absolute startAfter to installed pg-boss without adding scheduling to ordinary sends', async () => {
    const { boss, spies } = spiedBoss(new Map());
    const queue = wrapPgBoss(boss);
    const options = { db: { executeSql: async () => ({ rows: [] }) }, id: '00000000-0000-4000-8000-000000000001', group: { id: '00000000-0000-4000-8000-000000000002' }, retryLimit: 5, retryDelay: 5, retryBackoff: true, retryDelayMax: 300 };
    await queue.send(CUTOFF_QUEUE, {}, { ...options, startAfter: '2026-10-25T01:30:00.000Z' });
    expect(spies.send.mock.calls[0]?.[2]).toMatchObject({ startAfter: '2026-10-25T01:30:00.000Z', db: options.db });
    await queue.send(RECURRENCE_MATERIALIZE_QUEUE, {}, options);
    expect(spies.send.mock.calls[1]?.[2]).not.toHaveProperty('startAfter');
  });

  it('does not repair an incompatible registration', async () => {
    const rows = new Map([
      [DEAD_LETTER.name, queueRow(DEAD_LETTER, { deadLetter: null })],
      [MATERIALIZE.name, queueRow(MATERIALIZE, { deadLetter: null })],
    ]);
    const { boss, spies } = spiedBoss(rows);
    const runtime = createWorkerRuntime<DrizzleTransactionLike>({
      config,
      logger: createWorkerLogger({ level: 'silent' }),
      readiness: { check: async () => ({ ready: true, checks: { database: 'ok', schema: 'ok' } }) },
      queue: wrapPgBoss(boss),
      facade: { materializeBinding: () => Promise.reject(new Error('not called')) },
      cutoffFacade: { freezeDuePeriod: () => Promise.reject(new Error('not called')) },
      cutoffRelay: { relayBatch: async () => ({ selectedCount: 0, enqueuedCount: 0, unsupportedRetainedCount: 0 }), getHealth: () => Promise.reject(new Error('not called')) },
      cutoffDiscovery: { discoverBatch: () => Promise.reject(new Error('not called')) },
      relay: {
        relayBatch: () => Promise.reject(new Error('not called')),
        getHealth: () => Promise.reject(new Error('not called')),
      },
    });

    await expect(runtime.start()).rejects.toMatchObject({ code: 'QUEUE_INCOMPATIBLE', queueName: MATERIALIZE.name });
    expect(spies.work).not.toHaveBeenCalled();
    for (const forbidden of spies.forbidden) expect(forbidden).not.toHaveBeenCalled();
  });
});
