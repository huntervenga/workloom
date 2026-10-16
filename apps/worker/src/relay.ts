import {
  recurrenceMaterializationJobSchema,
  recurrenceMaterializationRequestedEventSchema,
  type RecurrenceMaterializationJob,
} from '@workloom/contracts';
import { RECURRENCE_MATERIALIZE_QUEUE, RECURRENCE_MATERIALIZE_QUEUE_OPTIONS } from '@workloom/db';
import type { RecurrenceOutboxRelay, RecurrenceRelayBatchResult, RecurrenceRelayEnqueue } from '@workloom/domain';
import { sql } from 'drizzle-orm';
import { fromDrizzle, type DrizzleTransactionLike } from 'pg-boss';

import { classifyError, type SafeErrorInfo, type WorkerLogger } from './logging.js';
import type { QueueSendOptions, WorkerQueueClient } from './queue.js';

/**
 * Retry fields sent with each job, taken from the approved queue options so a
 * job never diverges from its verified registration. Only unexpected handler
 * errors use them; controlled outcomes and chunk continuation never do.
 * Expiration, retention and the dead-letter target are inherited from the queue.
 */
export const MATERIALIZE_JOB_RETRY = {
  retryLimit: RECURRENCE_MATERIALIZE_QUEUE_OPTIONS.retryLimit,
  retryDelay: RECURRENCE_MATERIALIZE_QUEUE_OPTIONS.retryDelay,
  retryBackoff: RECURRENCE_MATERIALIZE_QUEUE_OPTIONS.retryBackoff,
  retryDelayMax: RECURRENCE_MATERIALIZE_QUEUE_OPTIONS.retryDelayMax,
} as const satisfies Pick<QueueSendOptions, 'retryLimit' | 'retryDelay' | 'retryBackoff' | 'retryDelayMax'>;

export const MAX_RELAY_BATCH = 100;
export const DEFAULT_RELAY_BATCH = 50;
/** Upper bound of the failure backoff between relay polls. */
export const MAX_RELAY_BACKOFF_MS = 30_000;

/** A relay row the worker refuses to enqueue. Carries no payload, message detail or cause. */
export class MaterializationEventRejectedError extends Error {
  override readonly name = 'MaterializationEventRejectedError';
  readonly code = 'RECURRENCE_EVENT_REJECTED';

  constructor() {
    super('Subscribed outbox event failed strict validation; it was not enqueued.');
  }
}

/** Server-side correlation for the job context; stable per outbox event, never client supplied. */
export function materializationRequestId(eventId: string): string {
  return `outbox:${eventId.toLowerCase()}`;
}

/**
 * The relay callback. It runs INSIDE the relay transaction that selected the
 * outbox row and will mark it dispatched: the job insert goes through
 * `fromDrizzle(tx, sql)` on that same transaction, so the row is either marked
 * and enqueued together or neither. There is no nested transaction and no send
 * on the queue's own pool. A rejected send propagates and the relay rolls back.
 */
export function createMaterializationEnqueue<Tx extends DrizzleTransactionLike>(
  queue: Pick<WorkerQueueClient, 'send'>,
): RecurrenceRelayEnqueue<Tx> {
  return async (tx, event) => {
    const parsedEvent = recurrenceMaterializationRequestedEventSchema.safeParse(event);
    if (!parsedEvent.success) {
      throw new MaterializationEventRejectedError();
    }
    const { eventId, workspaceId, payload } = parsedEvent.data;
    const candidate: RecurrenceMaterializationJob = {
      workspaceId,
      seriesId: payload.seriesId,
      bindingId: payload.bindingId,
      sourceManifestHash: payload.sourceManifestHash,
      authorizationRevision: payload.authorizationRevision,
      requestId: materializationRequestId(eventId),
    };
    const parsedJob = recurrenceMaterializationJobSchema.safeParse(candidate);
    if (!parsedJob.success) {
      throw new MaterializationEventRejectedError();
    }
    const jobId = await queue.send(RECURRENCE_MATERIALIZE_QUEUE, parsedJob.data, {
      db: fromDrizzle(tx, sql),
      id: eventId,
      group: { id: workspaceId },
      ...MATERIALIZE_JOB_RETRY,
    });
    return { accepted: true, jobId };
  };
}

/** Schedules `run` after `ms`; returns a cancel function. Injected in tests. */
export type RelaySchedule = (run: () => void, ms: number) => () => void;

const defaultSchedule: RelaySchedule = (run, ms) => {
  const timer = setTimeout(run, ms);
  return () => clearTimeout(timer);
};

export interface RelayPollerOptions<Tx> {
  readonly relay: Pick<RecurrenceOutboxRelay<Tx>, 'relayBatch'>;
  readonly enqueue: RecurrenceRelayEnqueue<Tx>;
  readonly intervalMs: number;
  /** Rows per relay transaction, 1..100. */
  readonly batchLimit?: number;
  readonly logger: WorkerLogger;
  readonly schedule?: RelaySchedule;
  readonly now?: () => number;
}

export interface RelayPollerSnapshot {
  readonly running: boolean;
  readonly inFlight: boolean;
  /** Completion time of the last batch attempt, successful or not: the relay heartbeat. */
  readonly lastCompletedAt: number | null;
  readonly lastSuccessAt: number | null;
  readonly lastFailureAt: number | null;
  readonly consecutiveFailures: number;
  readonly failedBatches: number;
  readonly lastBatch: RecurrenceRelayBatchResult | null;
  readonly lastError: SafeErrorInfo | null;
}

export interface RelayPoller {
  /** Runs one batch now, then keeps one timer chained after each completed batch. */
  start(): void;
  /** No further batches start; an in-flight batch is not interrupted. Idempotent. */
  stop(): void;
  /** Resolves when no batch is in flight. Never rejects. */
  drain(): Promise<void>;
  snapshot(): RelayPollerSnapshot;
}

/**
 * Polls the subscribed relay without overlap: the next batch is scheduled only
 * after the previous one settled, after a finite delay (doubled per consecutive
 * failure up to MAX_RELAY_BACKOFF_MS). No transaction or lock is held between
 * batches.
 */
export function createRelayPoller<Tx>(options: RelayPollerOptions<Tx>): RelayPoller {
  return createBatchPoller({
    ...options,
    batch: limit => options.relay.relayBatch(options.enqueue, limit),
  });
}

/** Shared timer lifecycle for exact relays and durable discovery; each operation remains independently typed. */
export interface BatchPollerOptions extends Omit<RelayPollerOptions<never>, 'relay' | 'enqueue'> {
  readonly batch: (limit: number) => Promise<RecurrenceRelayBatchResult>;
}

export function createBatchPoller(options: BatchPollerOptions): RelayPoller {
  const batchLimit = options.batchLimit ?? DEFAULT_RELAY_BATCH;
  if (!Number.isInteger(batchLimit) || batchLimit < 1 || batchLimit > MAX_RELAY_BATCH) {
    throw new RangeError(`Relay batch limit must be an integer from 1 to ${MAX_RELAY_BATCH}.`);
  }
  if (!Number.isInteger(options.intervalMs) || options.intervalMs < 1) {
    throw new RangeError('Relay interval must be a positive integer of milliseconds.');
  }
  const schedule = options.schedule ?? defaultSchedule;
  const now = options.now ?? (() => Date.now());
  const logger = options.logger;

  let started = false;
  let stopped = false;
  let cancelTimer: (() => void) | undefined;
  let inFlight: Promise<void> | undefined;
  let lastCompletedAt: number | null = null;
  let lastSuccessAt: number | null = null;
  let lastFailureAt: number | null = null;
  let consecutiveFailures = 0;
  let failedBatches = 0;
  let lastBatch: RecurrenceRelayBatchResult | null = null;
  let lastError: SafeErrorInfo | null = null;

  const nextDelay = (): number =>
    consecutiveFailures === 0
      ? options.intervalMs
      : Math.min(MAX_RELAY_BACKOFF_MS, options.intervalMs * 2 ** Math.min(consecutiveFailures, 6));

  async function runBatch(): Promise<void> {
    const startedAt = now();
    try {
      const result = await options.batch(batchLimit);
      lastBatch = result;
      lastSuccessAt = now();
      consecutiveFailures = 0;
      lastError = null;
      if (result.selectedCount > 0) {
        logger.info('relay.batch_done', { count: result.enqueuedCount, durationMs: now() - startedAt });
      }
      if (result.unsupportedRetainedCount > 0) {
        logger.warn('relay.unsupported_retained', { count: result.unsupportedRetainedCount });
      }
    } catch (error) {
      lastFailureAt = now();
      consecutiveFailures += 1;
      failedBatches += 1;
      lastError = classifyError(error);
      logger.error('relay.batch_failed', { attempt: consecutiveFailures, durationMs: now() - startedAt, error });
    } finally {
      lastCompletedAt = now();
    }
  }

  function tick(): void {
    cancelTimer = undefined;
    if (stopped) return;
    inFlight = runBatch().finally(() => {
      inFlight = undefined;
      if (!stopped) cancelTimer = schedule(tick, nextDelay());
    });
  }

  return {
    start() {
      if (started || stopped) return;
      started = true;
      tick();
    },
    stop() {
      stopped = true;
      cancelTimer?.();
      cancelTimer = undefined;
    },
    async drain() {
      while (inFlight !== undefined) {
        await inFlight;
      }
    },
    snapshot() {
      return {
        running: started && !stopped,
        inFlight: inFlight !== undefined,
        lastCompletedAt,
        lastSuccessAt,
        lastFailureAt,
        consecutiveFailures,
        failedBatches,
        lastBatch,
        lastError,
      };
    },
  };
}
