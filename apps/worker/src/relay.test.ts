import {
  RECURRENCE_MATERIALIZATION_REQUESTED,
  RECURRENCE_MATERIALIZATION_SCHEMA_VERSION,
  type RecurrenceMaterializationRequestedEvent,
} from '@workloom/contracts';
import { RECURRENCE_MATERIALIZE_QUEUE, RECURRENCE_MATERIALIZE_QUEUE_OPTIONS } from '@workloom/db';
import type { RecurrenceOutboxRelay, RecurrenceRelayBatchResult, RecurrenceRelayEnqueue } from '@workloom/domain';
import type { DrizzleTransactionLike } from 'pg-boss';
import { describe, expect, it } from 'vitest';

import { createWorkerLogger } from './logging.js';
import type { QueueSendOptions } from './queue.js';
import {
  MAX_RELAY_BACKOFF_MS,
  MaterializationEventRejectedError,
  createMaterializationEnqueue,
  createRelayPoller,
  type RelaySchedule,
} from './relay.js';

const WORKSPACE_ID = '00000000-0000-4000-8000-000000000001';
const SERIES_ID = '00000000-0000-4000-8000-000000000002';
const BINDING_ID = '00000000-0000-4000-8000-000000000003';
const EVENT_ID = '00000000-0000-4000-8000-0000000000e1';
const HASH = 'a'.repeat(64);
const CANARY = 'canary-private-meeting-title https://meet.example/secret';

interface FakeTx extends DrizzleTransactionLike {
  readonly queries: unknown[];
}

function fakeTx(): FakeTx {
  const queries: unknown[] = [];
  return {
    queries,
    async execute(query: unknown) {
      queries.push(query);
      return [{ id: EVENT_ID }];
    },
  };
}

interface SentJob {
  readonly name: string;
  readonly data: object;
  readonly options: QueueSendOptions;
}

function recordingSender(result: () => Promise<string | null>) {
  const sent: SentJob[] = [];
  return {
    sent,
    send: async (name: string, data: object, options: QueueSendOptions) => {
      sent.push({ name, data, options });
      return result();
    },
  };
}

function event(): RecurrenceMaterializationRequestedEvent {
  return {
    eventId: EVENT_ID,
    workspaceId: WORKSPACE_ID,
    type: RECURRENCE_MATERIALIZATION_REQUESTED,
    schemaVersion: RECURRENCE_MATERIALIZATION_SCHEMA_VERSION,
    payload: { seriesId: SERIES_ID, bindingId: BINDING_ID, sourceManifestHash: HASH, authorizationRevision: 3 },
    occurredAt: '2026-10-16T09:00:00.000Z',
  };
}

describe('createMaterializationEnqueue', () => {
  it('sends only the strict job on the supplied relay transaction with a deterministic ID and workspace group', async () => {
    const sender = recordingSender(async () => EVENT_ID);
    const tx = fakeTx();
    const enqueue = createMaterializationEnqueue<FakeTx>(sender);

    await expect(enqueue(tx, event())).resolves.toEqual({ accepted: true, jobId: EVENT_ID });

    expect(sender.sent).toHaveLength(1);
    const [job] = sender.sent;
    expect(job?.name).toBe(RECURRENCE_MATERIALIZE_QUEUE);
    expect(job?.data).toStrictEqual({
      workspaceId: WORKSPACE_ID,
      seriesId: SERIES_ID,
      bindingId: BINDING_ID,
      sourceManifestHash: HASH,
      authorizationRevision: 3,
      requestId: `outbox:${EVENT_ID}`,
    });
    expect(job?.options.id).toBe(EVENT_ID);
    expect(job?.options.group).toEqual({ id: WORKSPACE_ID });
    // Retry comes from the approved queue options; expiration, retention and deadLetter stay inherited.
    expect(Object.keys(job?.options ?? {}).sort()).toEqual(['db', 'group', 'id', 'retryBackoff', 'retryDelay', 'retryDelayMax', 'retryLimit']);
    expect(job?.options.retryLimit).toBe(RECURRENCE_MATERIALIZE_QUEUE_OPTIONS.retryLimit);

    // The adapter handed to pg-boss executes on the very transaction the relay supplied, not on a pool.
    expect(tx.queries).toHaveLength(0);
    await expect(job?.options.db.executeSql('select $1::uuid as id', [EVENT_ID])).resolves.toEqual({ rows: [{ id: EVENT_ID }] });
    expect(tx.queries).toHaveLength(1);
  });

  it('canonicalizes upper-case IDs and reports a duplicate send (null job ID) as accepted', async () => {
    const sender = recordingSender(async () => null);
    const upper = { ...event(), eventId: EVENT_ID.toUpperCase(), workspaceId: WORKSPACE_ID.toUpperCase() };

    await expect(createMaterializationEnqueue<FakeTx>(sender)(fakeTx(), upper)).resolves.toEqual({ accepted: true, jobId: null });
    expect(sender.sent[0]?.options.id).toBe(EVENT_ID);
    expect(sender.sent[0]?.options.group).toEqual({ id: WORKSPACE_ID });
  });

  it('propagates a rejected send unchanged and returns no accepted result', async () => {
    const failure = new Error('insert failed');
    const sender = recordingSender(() => Promise.reject(failure));

    await expect(createMaterializationEnqueue<FakeTx>(sender)(fakeTx(), event())).rejects.toBe(failure);
  });

  it('rejects events outside the strict v1 schema without sending, and without echoing their contents', async () => {
    const sender = recordingSender(async () => EVENT_ID);
    const enqueue = createMaterializationEnqueue<FakeTx>(sender);
    const valid = event();
    const withActor = { ...valid, payload: { ...valid.payload, actorUserId: SERIES_ID } };
    const withText = { ...valid, title: CANARY };
    const otherVersion = { ...valid, schemaVersion: 2 };

    for (const candidate of [withActor, withText, otherVersion]) {
      const rejection = await enqueue(fakeTx(), candidate as RecurrenceMaterializationRequestedEvent).then(
        () => undefined,
        (error: unknown) => error,
      );
      expect(rejection).toBeInstanceOf(MaterializationEventRejectedError);
      expect(String(rejection)).not.toContain('canary');
    }
    expect(sender.sent).toHaveLength(0);
  });
});

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

const flush = () => new Promise<void>((done) => setImmediate(done));

function manualSchedule() {
  const timers: { run: () => void; ms: number; cancelled: boolean }[] = [];
  const schedule: RelaySchedule = (run, ms) => {
    const timer = { run, ms, cancelled: false };
    timers.push(timer);
    return () => {
      timer.cancelled = true;
    };
  };
  const fire = () => {
    const timer = timers.find((candidate) => !candidate.cancelled);
    if (timer === undefined) throw new Error('no pending timer');
    timer.cancelled = true;
    timer.run();
  };
  const pending = () => timers.filter((timer) => !timer.cancelled);
  return { schedule, fire, pending };
}

function scriptedRelay() {
  const batches: Deferred<RecurrenceRelayBatchResult>[] = [];
  const limits: (number | undefined)[] = [];
  let active = 0;
  let maxActive = 0;
  const relay: RecurrenceOutboxRelay<FakeTx> = {
    relayBatch(_enqueue: RecurrenceRelayEnqueue<FakeTx>, limit?: number) {
      limits.push(limit);
      active += 1;
      maxActive = Math.max(maxActive, active);
      const batch = deferred<RecurrenceRelayBatchResult>();
      batches.push(batch);
      return batch.promise.finally(() => {
        active -= 1;
      });
    },
    getHealth: async () => ({ pendingSubscribedCount: 0, oldestSubscribedAt: null, oldestSubscribedAgeMs: null, unsupportedSubscribedCount: 0 }),
  };
  return { relay, batches, limits, maxActive: () => maxActive };
}

const noopEnqueue: RecurrenceRelayEnqueue<FakeTx> = async () => ({ accepted: true, jobId: null });
const done: RecurrenceRelayBatchResult = { selectedCount: 1, enqueuedCount: 1, unsupportedRetainedCount: 0 };

describe('createRelayPoller', () => {
  it('never overlaps batches: the next timer is armed only after the previous batch settles', async () => {
    const timers = manualSchedule();
    const script = scriptedRelay();
    const poller = createRelayPoller({
      relay: script.relay,
      enqueue: noopEnqueue,
      intervalMs: 1_000,
      batchLimit: 25,
      logger: createWorkerLogger({ level: 'silent' }),
      schedule: timers.schedule,
    });

    poller.start();
    poller.start();
    expect(script.batches).toHaveLength(1);
    expect(timers.pending()).toHaveLength(0);

    script.batches[0]?.resolve(done);
    await flush();
    expect(timers.pending().map((timer) => timer.ms)).toEqual([1_000]);

    timers.fire();
    expect(script.batches).toHaveLength(2);
    expect(timers.pending()).toHaveLength(0);
    script.batches[1]?.resolve(done);
    await flush();

    expect(script.maxActive()).toBe(1);
    expect(script.limits).toEqual([25, 25]);
    expect(poller.snapshot()).toMatchObject({ running: true, inFlight: false, consecutiveFailures: 0, lastBatch: done });
  });

  it('backs off after failures within a finite bound and recovers on success', async () => {
    const timers = manualSchedule();
    const script = scriptedRelay();
    const poller = createRelayPoller({
      relay: script.relay,
      enqueue: noopEnqueue,
      intervalMs: 1_000,
      logger: createWorkerLogger({ level: 'silent' }),
      schedule: timers.schedule,
    });

    poller.start();
    const delays: number[] = [];
    for (let attempt = 0; attempt < 7; attempt += 1) {
      script.batches[attempt]?.reject(new Error(CANARY));
      await flush();
      const [next] = timers.pending();
      delays.push(next?.ms ?? -1);
      timers.fire();
    }
    expect(delays).toEqual([2_000, 4_000, 8_000, 16_000, MAX_RELAY_BACKOFF_MS, MAX_RELAY_BACKOFF_MS, MAX_RELAY_BACKOFF_MS]);
    expect(poller.snapshot()).toMatchObject({ consecutiveFailures: 7, failedBatches: 7, lastError: { name: 'Error' } });

    script.batches[7]?.resolve(done);
    await flush();
    expect(timers.pending().map((timer) => timer.ms)).toEqual([1_000]);
    expect(poller.snapshot()).toMatchObject({ consecutiveFailures: 0, failedBatches: 7, lastError: null });
  });

  it('stop cancels the timer, drain waits for the in-flight batch, and nothing is scheduled afterwards', async () => {
    const timers = manualSchedule();
    const script = scriptedRelay();
    const poller = createRelayPoller({
      relay: script.relay,
      enqueue: noopEnqueue,
      intervalMs: 1_000,
      logger: createWorkerLogger({ level: 'silent' }),
      schedule: timers.schedule,
    });

    poller.start();
    poller.stop();
    let drained = false;
    const drain = poller.drain().then(() => {
      drained = true;
    });
    await flush();
    expect(drained).toBe(false);

    script.batches[0]?.resolve(done);
    await drain;
    expect(drained).toBe(true);
    expect(timers.pending()).toHaveLength(0);
    expect(script.batches).toHaveLength(1);
    expect(poller.snapshot().running).toBe(false);
  });

  it('refuses unbounded batch sizes', () => {
    const script = scriptedRelay();
    const logger = createWorkerLogger({ level: 'silent' });
    for (const batchLimit of [0, 101, 2.5]) {
      expect(() => createRelayPoller({ relay: script.relay, enqueue: noopEnqueue, intervalMs: 1_000, batchLimit, logger })).toThrow(RangeError);
    }
  });

  it('logs failures as a safe classification only', async () => {
    const lines: string[] = [];
    const timers = manualSchedule();
    const script = scriptedRelay();
    const poller = createRelayPoller({
      relay: script.relay,
      enqueue: noopEnqueue,
      intervalMs: 1_000,
      logger: createWorkerLogger({ level: 'trace', sink: (line) => lines.push(line) }),
      schedule: timers.schedule,
    });

    poller.start();
    script.batches[0]?.reject(Object.assign(new Error(CANARY), { code: '57014', query: `select '${CANARY}'` }));
    await flush();
    poller.stop();

    expect(lines.join('\n')).not.toContain('canary');
    expect(lines.some((line) => line.includes('"relay.batch_failed"') && line.includes('"57014"'))).toBe(true);
  });
});
