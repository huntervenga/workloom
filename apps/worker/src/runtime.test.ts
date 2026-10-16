import {
  RECURRENCE_DEAD_LETTER_QUEUE,
  RECURRENCE_MATERIALIZE_QUEUE,
  RECURRENCE_QUEUE_REGISTRATIONS,
  type ReadinessReport,
} from '@workloom/db';
import type {
  RecurrenceOutboxRelay,
  RecurrenceRelayBatchResult,
  RecurrenceRelayHealth,
  RecurrenceWorkerFacade,
  RecurrenceWorkerOutcome,
} from '@workloom/domain';
import type { DrizzleTransactionLike } from 'pg-boss';
import { describe, expect, it } from 'vitest';

import type { ApprovedQueueRegistration } from './health.js';
import { createWorkerLogger } from './logging.js';
import type { QueueJobHandler, QueueRegistration, QueueStopOptions, QueueWorkOptions, WorkerQueueClient } from './queue.js';
import {
  ApplicationSchemaUnreadyError,
  QueueRegistrationError,
  WorkerStartAbortedError,
  createWorkerRuntime,
  type ApplicationReadiness,
} from './runtime.js';

const WORKSPACE_ID = '00000000-0000-4000-8000-000000000001';
const BINDING_ID = '00000000-0000-4000-8000-000000000003';
const PERIOD_ID = '00000000-0000-4000-8000-000000000004';
const JOB_ID = '00000000-0000-4000-8000-0000000000e1';
const CANARY = 'canary-secret-table postgres://workloom:canary-pw@127.0.0.1/workloom';

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const flush = () => new Promise<void>((done) => setImmediate(done));

type FakeTx = DrizzleTransactionLike;

function registered(approved: ApprovedQueueRegistration, overrides: Partial<QueueRegistration> = {}): QueueRegistration {
  const defaults: QueueRegistration = {
    name: approved.name,
    policy: undefined,
    partition: undefined,
    retryLimit: undefined,
    retryDelay: undefined,
    retryBackoff: undefined,
    retryDelayMax: undefined,
    expireInSeconds: undefined,
    retentionSeconds: undefined,
    deleteAfterSeconds: undefined,
    deadLetter: undefined,
    readyCount: 0,
    queuedCount: 0,
    activeCount: 0,
    failedCount: 0,
    readyOldestSeconds: null,
  };
  return Object.assign(defaults, approved.expected, overrides);
}

const [DEAD_LETTER, MATERIALIZE] = RECURRENCE_QUEUE_REGISTRATIONS;

function approvedQueues(): Map<string, QueueRegistration | null | Error> {
  return new Map<string, QueueRegistration | null | Error>([
    [DEAD_LETTER.name, registered(DEAD_LETTER)],
    [MATERIALIZE.name, registered(MATERIALIZE)],
  ]);
}

const READY: ReadinessReport = { ready: true, checks: { database: 'ok', schema: 'ok' } };

interface HarnessOptions {
  readonly readiness?: ApplicationReadiness;
  readonly queues?: Map<string, QueueRegistration | null | Error>;
  readonly queueStart?: () => Promise<void>;
  readonly queueWork?: () => Promise<void>;
  readonly relayBatch?: () => Promise<RecurrenceRelayBatchResult>;
  readonly relayHealth?: () => Promise<RecurrenceRelayHealth>;
  readonly outcome?: () => Promise<RecurrenceWorkerOutcome>;
}

function harness(options: HarnessOptions = {}) {
  const calls: string[] = [];
  const lines: string[] = [];
  const sends: string[] = [];
  const stops: QueueStopOptions[] = [];
  const queues = options.queues ?? approvedQueues();
  const clock = { value: 1_000_000 };
  let errorListener: ((error: unknown) => void) | undefined;
  let handler: QueueJobHandler | undefined;
  let workOptions: QueueWorkOptions | undefined;

  const queue: WorkerQueueClient = {
    onError(listener) {
      calls.push('queue.onError');
      errorListener = listener;
    },
    async start() {
      calls.push('queue.start');
      await options.queueStart?.();
    },
    async getQueue(name) {
      calls.push(`queue.getQueue:${name}`);
      const reading = queues.get(name);
      if (reading === undefined || reading instanceof Error) throw reading ?? new Error('unknown queue');
      return reading;
    },
    async send(name) {
      sends.push(name);
      return null;
    },
    async work(name, opts, handle) {
      calls.push(`queue.work:${name}`);
      handler = handle;
      workOptions = opts;
      await options.queueWork?.();
    },
    async stopFetching(name) {
      calls.push(`queue.stop_fetching:${name}`);
    },
    async stop(opts) {
      calls.push(opts.close ? 'queue.close' : 'queue.drain');
      stops.push(opts);
    },
  };
  const relay: RecurrenceOutboxRelay<FakeTx> = {
    relayBatch() {
      calls.push('relay.batch');
      return options.relayBatch?.() ?? Promise.resolve({ selectedCount: 0, enqueuedCount: 0, unsupportedRetainedCount: 0 });
    },
    getHealth() {
      return (
        options.relayHealth?.() ??
        Promise.resolve({ pendingSubscribedCount: 0, oldestSubscribedAt: null, oldestSubscribedAgeMs: null, unsupportedSubscribedCount: 0 })
      );
    },
  };
  const facade: RecurrenceWorkerFacade = {
    materializeBinding() {
      calls.push('facade.materializeBinding');
      return (
        options.outcome?.() ??
        Promise.resolve({ status: 'complete', bindingId: BINDING_ID, periodId: PERIOD_ID, createdCount: 1, remainingCount: 0, blockedCode: null })
      );
    },
  };
  const readiness: ApplicationReadiness = options.readiness ?? {
    async check() {
      calls.push('readiness.check');
      return READY;
    },
  };

  const runtime = createWorkerRuntime<FakeTx>({
    config: { jobConcurrency: 2, pollIntervalMs: 2_000, shutdownTimeoutMs: 10_000 },
    logger: createWorkerLogger({ level: 'trace', sink: (line) => lines.push(line) }),
    readiness,
    queue,
    facade,
    relay,
    ownedResources: [
      {
        name: 'database.close',
        close: async () => {
          calls.push('database.close');
        },
      },
    ],
    // Never fires on its own: each test drives the relay explicitly through start/shutdown.
    relaySchedule: () => () => undefined,
    healthSchedule: () => () => undefined,
    now: () => clock.value,
  });

  return {
    runtime,
    calls,
    lines,
    sends,
    stops,
    queues,
    clock,
    emitQueueError: (error: unknown) => errorListener?.(error),
    handler: () => handler,
    workOptions: () => workOptions,
    count: (call: string) => calls.filter((entry) => entry === call).length,
  };
}

async function rejectionOf(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => undefined,
    (error: unknown) => error,
  );
}

describe('worker runtime startup', () => {
  it('checks application readiness, then both queue rows in order, before any handler or relay work', async () => {
    const h = harness();
    await h.runtime.start();

    expect(h.calls).toEqual([
      'readiness.check',
      'queue.onError',
      'queue.start',
      `queue.getQueue:${RECURRENCE_DEAD_LETTER_QUEUE}`,
      `queue.getQueue:${RECURRENCE_MATERIALIZE_QUEUE}`,
      `queue.work:${RECURRENCE_MATERIALIZE_QUEUE}`,
      'relay.batch',
      `queue.getQueue:${RECURRENCE_DEAD_LETTER_QUEUE}`,
      `queue.getQueue:${RECURRENCE_MATERIALIZE_QUEUE}`,
    ]);
    expect(h.workOptions()).toStrictEqual({
      batchSize: 1,
      localConcurrency: 2,
      groupConcurrency: 1,
      pollingIntervalSeconds: 2,
      transactional: false,
    });
    expect(h.runtime.lifecycle).toBe('running');
  });

  it.each([
    ['database unreachable', { ready: false, checks: { database: 'failed', schema: 'skipped' } }],
    ['schema pending', { ready: false, checks: { database: 'ok', schema: 'failed' }, diagnostic: { migrationStatus: 'pending', missingTables: [CANARY] } }],
    ['inconsistent report', { ready: true, checks: { database: 'ok', schema: 'failed' } }],
  ] satisfies [string, ReadinessReport][])('fails closed when the application schema is not ready (%s)', async (_label, report) => {
    const h = harness({ readiness: { check: async () => report } });

    expect(await rejectionOf(h.runtime.start())).toBeInstanceOf(ApplicationSchemaUnreadyError);
    expect(h.calls).not.toContain('queue.start');
    expect(h.calls.some((call) => call.startsWith('queue.work'))).toBe(false);
    expect(h.calls).not.toContain('relay.batch');
    expect(h.count('queue.close')).toBe(1);
    expect(h.count('database.close')).toBe(1);
    expect(h.runtime.lifecycle).toBe('stopped');
    expect(h.lines.join('\n')).not.toContain('canary');
    expect(h.lines.some((line) => line.includes('"worker.readiness_failed"') && line.includes('"step":"schema"'))).toBe(true);
  });

  it('fails closed without logging the error when the readiness probe itself throws', async () => {
    const h = harness({ readiness: { check: () => Promise.reject(new Error(CANARY)) } });

    expect(await rejectionOf(h.runtime.start())).toBeInstanceOf(ApplicationSchemaUnreadyError);
    expect(h.calls).not.toContain('queue.start');
    expect(h.count('database.close')).toBe(1);
    expect(h.lines.join('\n')).not.toContain('canary');
  });

  it.each([
    ['dead-letter queue missing', DEAD_LETTER.name, null, 'QUEUE_MISSING'],
    ['dead-letter queue retries', DEAD_LETTER.name, registered(DEAD_LETTER, { retryLimit: 2 }), 'QUEUE_INCOMPATIBLE'],
    ['dead-letter queue reports a dead letter', DEAD_LETTER.name, registered(DEAD_LETTER, { deadLetter: MATERIALIZE.name }), 'QUEUE_INCOMPATIBLE'],
    ['materialize queue missing', MATERIALIZE.name, null, 'QUEUE_MISSING'],
    ['materialize retryDelayMax not reported', MATERIALIZE.name, registered(MATERIALIZE, { retryDelayMax: undefined }), 'QUEUE_INCOMPATIBLE'],
    ['materialize retention as null', MATERIALIZE.name, registered(MATERIALIZE, { retentionSeconds: null }), 'QUEUE_INCOMPATIBLE'],
    ['materialize without dead letter', MATERIALIZE.name, registered(MATERIALIZE, { deadLetter: null }), 'QUEUE_INCOMPATIBLE'],
    ['materialize partitioned', MATERIALIZE.name, registered(MATERIALIZE, { partition: true }), 'QUEUE_INCOMPATIBLE'],
    ['materialize short policy', MATERIALIZE.name, registered(MATERIALIZE, { policy: 'short' }), 'QUEUE_INCOMPATIBLE'],
  ] as const)('refuses to register any handler when %s', async (_label, name, reading, code) => {
    const queues = approvedQueues();
    queues.set(name, reading);
    const h = harness({ queues });

    const error = await rejectionOf(h.runtime.start());
    expect(error).toBeInstanceOf(QueueRegistrationError);
    expect(error).toMatchObject({ code, queueName: name });
    expect(h.calls.some((call) => call.startsWith('queue.work'))).toBe(false);
    expect(h.calls).not.toContain('relay.batch');
    // The runtime only reads registrations: it stops gracefully, closes once, and never repairs.
    expect(h.calls.slice(-3)).toEqual(['queue.drain', 'queue.close', 'database.close']);
    if (name === DEAD_LETTER.name) expect(h.calls).not.toContain(`queue.getQueue:${MATERIALIZE.name}`);
  });

  it('names mismatched options in logs without their reported values', async () => {
    const queues = approvedQueues();
    queues.set(MATERIALIZE.name, registered(MATERIALIZE, { retryDelayMax: undefined, deadLetter: CANARY }));
    const h = harness({ queues });

    await rejectionOf(h.runtime.start());
    const mismatches = h.lines.filter((line) => line.includes('"worker.queue_option_mismatch"'));
    expect(mismatches.map((line) => (JSON.parse(line) as { step?: string }).step).sort()).toEqual(['deadLetter', 'retryDelayMax']);
    expect(h.lines.join('\n')).not.toContain('canary');
  });

  it('closes owned resources exactly once when queue start fails, also across a later signal', async () => {
    const failure = Object.assign(new Error(CANARY), { code: 'ECONNREFUSED' });
    const h = harness({ queueStart: () => Promise.reject(failure) });

    expect(await rejectionOf(h.runtime.start())).toBe(failure);
    const first = await h.runtime.shutdown('SIGTERM');
    expect(first.reason).toBe('start_failed');
    expect(h.count('queue.close')).toBe(1);
    expect(h.count('database.close')).toBe(1);
    expect(h.lines.join('\n')).not.toContain('canary');
    expect(h.lines.some((line) => line.includes('"worker.start_failed"') && line.includes('"ECONNREFUSED"'))).toBe(true);
  });

  it('aborts a start that a signal interrupted, without registering handlers', async () => {
    const gate = deferred<undefined>();
    const h = harness({ queueStart: () => gate.promise });

    const starting = rejectionOf(h.runtime.start());
    await flush();
    const stopping = h.runtime.shutdown('SIGTERM');
    await flush();
    expect(h.calls).not.toContain('queue.drain');
    expect(h.calls).not.toContain('queue.close');
    expect(h.calls).not.toContain('database.close');
    gate.resolve(undefined);

    expect(await starting).toBeInstanceOf(WorkerStartAbortedError);
    expect((await stopping).reason).toBe('SIGTERM');
    expect(h.calls.some((call) => call.startsWith('queue.work'))).toBe(false);
    expect(h.count('database.close')).toBe(1);
    expect(h.count('queue.close')).toBe(1);
    expect(h.count('queue.drain')).toBe(1);
  });

  it('waits for a late work registration before stopping intake and closing once', async () => {
    const gate = deferred<undefined>();
    const h = harness({ queueWork: () => gate.promise });
    const starting = rejectionOf(h.runtime.start());
    await flush();
    expect(h.handler()).toBeDefined();
    const stopping = h.runtime.shutdown('SIGTERM');
    await flush();
    expect(h.calls).not.toContain(`queue.stop_fetching:${RECURRENCE_MATERIALIZE_QUEUE}`);
    expect(h.calls).not.toContain('queue.close');
    gate.resolve(undefined);
    expect(await starting).toBeInstanceOf(WorkerStartAbortedError);
    expect((await stopping).status).toBe('clean');
    expect(h.calls).not.toContain('relay.batch');
    expect(h.count(`queue.stop_fetching:${RECURRENCE_MATERIALIZE_QUEUE}`)).toBe(1);
    expect(h.count('queue.close')).toBe(1);
    expect(h.count('database.close')).toBe(1);
    await h.runtime.shutdown('SIGINT');
    expect(h.count('queue.close')).toBe(1);
  });

  it('refuses to start after shutdown already ran', async () => {
    const h = harness();
    await h.runtime.shutdown('SIGINT');

    expect(await rejectionOf(h.runtime.start())).toBeInstanceOf(WorkerStartAbortedError);
    expect(h.calls).not.toContain('readiness.check');
    expect(h.count('database.close')).toBe(1);
  });
});

describe('worker runtime jobs and shutdown', () => {
  it('acknowledges pending, stale and blocked outcomes through the registered handler without sending jobs', async () => {
    const outcomes: RecurrenceWorkerOutcome[] = [
      { status: 'pending', bindingId: BINDING_ID, periodId: PERIOD_ID, createdCount: 100, remainingCount: 20, blockedCode: null },
      { status: 'stale', bindingId: BINDING_ID, periodId: PERIOD_ID, createdCount: 0, remainingCount: 0, blockedCode: null },
      { status: 'blocked', bindingId: BINDING_ID, periodId: PERIOD_ID, createdCount: 0, remainingCount: 3, blockedCode: 'authorization_revision_stale' },
    ];
    const h = harness({ outcome: async () => outcomes.shift() ?? Promise.reject(new Error('no outcome')) });
    await h.runtime.start();
    const handle = h.handler();
    const data = {
      workspaceId: WORKSPACE_ID,
      seriesId: '00000000-0000-4000-8000-000000000002',
      bindingId: BINDING_ID,
      sourceManifestHash: 'c'.repeat(64),
      authorizationRevision: 1,
      requestId: `outbox:${JOB_ID}`,
    };

    for (const status of ['pending', 'stale', 'blocked']) {
      await expect(handle?.([{ id: JOB_ID, data, retryCount: 0 }])).resolves.toMatchObject({ status });
    }
    expect(h.count('facade.materializeBinding')).toBe(3);
    expect(h.sends).toEqual([]);
    const report = await h.runtime.health();
    expect(report.jobs).toEqual({ outcomes: { complete: 0, pending: 1, stale: 1, blocked: 1, paused: 0 }, rejected: 0, failed: 0 });
    expect(report.reasons).not.toContain('job_failures_recent');
  });

  it('stops intake, waits for the in-flight relay batch, drains the queue, then closes each resource once', async () => {
    const batch = deferred<RecurrenceRelayBatchResult>();
    const h = harness({ relayBatch: () => batch.promise });
    await h.runtime.start();

    const first = h.runtime.shutdown('SIGTERM');
    const second = h.runtime.shutdown('SIGINT');
    await flush();
    expect(h.calls).toContain(`queue.stop_fetching:${RECURRENCE_MATERIALIZE_QUEUE}`);
    expect(h.calls).not.toContain('queue.drain');

    batch.resolve({ selectedCount: 1, enqueuedCount: 1, unsupportedRetainedCount: 0 });
    const result = await first;
    expect(await second).toBe(result);
    expect(result).toMatchObject({ status: 'clean', reason: 'SIGTERM' });
    expect(h.calls.slice(h.calls.indexOf(`queue.stop_fetching:${RECURRENCE_MATERIALIZE_QUEUE}`))).toEqual([
      `queue.stop_fetching:${RECURRENCE_MATERIALIZE_QUEUE}`,
      'queue.drain',
      'queue.close',
      'database.close',
    ]);
    expect(h.stops).toEqual([
      { graceful: true, close: false, timeoutMs: 10_000 },
      { graceful: false, close: true, timeoutMs: 10_000 },
    ]);
    expect(h.count('relay.batch')).toBe(1);
    expect(h.runtime.lifecycle).toBe('stopped');
  });
});

describe('worker runtime health', () => {
  it('logs an immediate real aggregate observation and drains an in-flight read before closing pools', async () => {
    const reading = deferred<RecurrenceRelayHealth>();
    const h = harness({ relayHealth: () => reading.promise });
    await h.runtime.start();
    const stopping = h.runtime.shutdown('SIGTERM');
    await flush();
    expect(h.calls).not.toContain('queue.close');
    expect(h.calls).not.toContain('database.close');
    reading.resolve({ pendingSubscribedCount: 7, oldestSubscribedAt: null, oldestSubscribedAgeMs: null, unsupportedSubscribedCount: 2 });
    await stopping;
    const report = h.lines.map(line => JSON.parse(line) as Record<string, unknown>).find(line => line['event'] === 'worker.health');
    expect(report).toMatchObject({ pendingCount: 7, unsupportedCount: 2 });
    expect(h.count('queue.close')).toBe(1);
    expect(h.count('database.close')).toBe(1);
  });

  it('is ok only when both queues match, the relay answers and nothing has failed', async () => {
    const h = harness();
    await h.runtime.start();
    const report = await h.runtime.health();

    expect(report.status).toBe('ok');
    expect(report.reasons).toEqual([]);
    expect(report.queues.map((queue) => [queue.name, queue.state])).toEqual([
      [RECURRENCE_DEAD_LETTER_QUEUE, 'ready'],
      [RECURRENCE_MATERIALIZE_QUEUE, 'ready'],
    ]);
    expect(report.reportedDeadLetterCount).toBe(0);
  });

  it('reports retained dead-letter and failed jobs, relay-reported unsupported versions and queue errors', async () => {
    const health: RecurrenceRelayHealth = {
      pendingSubscribedCount: 4,
      oldestSubscribedAt: '2026-10-16T08:00:00.000Z',
      oldestSubscribedAgeMs: 60_000,
      unsupportedSubscribedCount: 2,
    };
    const h = harness({ relayHealth: async () => health });
    await h.runtime.start();
    h.queues.set(DEAD_LETTER.name, registered(DEAD_LETTER, { queuedCount: 3, failedCount: 1 }));
    h.queues.set(MATERIALIZE.name, registered(MATERIALIZE, { failedCount: 2, readyCount: 5, readyOldestSeconds: 12 }));
    h.emitQueueError(Object.assign(new Error(CANARY), { code: '53300' }));

    const report = await h.runtime.health();
    expect(report.status).toBe('degraded');
    expect(report.reasons).toEqual(
      expect.arrayContaining(['dead_letter_jobs', 'queue_failed_jobs', 'relay_unsupported_events', 'queue_errors_recent']),
    );
    expect(report.reportedDeadLetterCount).toBe(4);
    expect(report.queues[1]?.reported).toEqual({ readyCount: 5, queuedCount: 0, activeCount: 0, failedCount: 2, readyOldestSeconds: 12 });
    expect(report.relay).toMatchObject({ pendingSubscribedCount: 4, unsupportedSubscribedCount: 2, state: 'ok' });
    expect(report.queueErrorsSinceStart).toBe(1);
    expect(h.lines.join('\n')).not.toContain('canary');
    expect(JSON.stringify(report)).not.toContain('canary');
  });

  it('is down when a queue becomes missing, incompatible or unreadable after start', async () => {
    const h = harness();
    await h.runtime.start();

    h.queues.set(DEAD_LETTER.name, new Error(CANARY));
    expect(await h.runtime.health()).toMatchObject({ status: 'down', reasons: expect.arrayContaining(['dead_letter_unavailable']) });

    h.queues.set(DEAD_LETTER.name, null);
    h.queues.set(MATERIALIZE.name, registered(MATERIALIZE, { retryLimit: 9 }));
    const report = await h.runtime.health();
    expect(report.status).toBe('down');
    expect(report.reasons).toEqual(expect.arrayContaining(['dead_letter_missing', 'queue_incompatible']));
    expect(report.queues[1]?.mismatchedProperties).toEqual(['retryLimit']);
    expect(JSON.stringify(report)).not.toContain('canary');
  });

  it('flags a stale relay heartbeat and an unavailable relay health read', async () => {
    const h = harness({ relayHealth: () => Promise.reject(new Error(CANARY)) });
    await h.runtime.start();
    await flush();
    h.clock.value += 2_000 * 3 + 30_000 + 1;

    const report = await h.runtime.health();
    expect(report.reasons).toEqual(expect.arrayContaining(['heartbeat_stale', 'relay_unavailable']));
    expect(report.heartbeat.stale).toBe(true);
    expect(report.relay.state).toBe('unavailable');
  });

  it('is down before start and after shutdown without touching the queue', async () => {
    const h = harness();
    expect(await h.runtime.health()).toMatchObject({ status: 'down', lifecycle: 'created' });
    await h.runtime.start();
    await h.runtime.shutdown('SIGTERM');
    const reads = h.calls.filter((call) => call.startsWith('queue.getQueue')).length;

    expect(await h.runtime.health()).toMatchObject({ status: 'down', lifecycle: 'stopped' });
    expect(h.calls.filter((call) => call.startsWith('queue.getQueue')).length).toBe(reads);
  });
});
