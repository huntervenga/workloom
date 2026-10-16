import { PgBoss, type ConstructorOptions, type Db, type Job, type QueueResult, type SendOptions } from 'pg-boss';

import type { WorkerConfig } from './config.js';

/**
 * The narrow part of pg-boss the worker runtime uses. Everything else on the
 * client (createQueue, updateQueue, deleteQueue, purge, schedules, migrations)
 * is deliberately absent: the schema and queue registration belong to the
 * explicit `db:queue:migrate` command, and the runtime only verifies them.
 */
export interface QueueRegistration {
  readonly name: string;
  /**
   * Registered options exactly as pg-boss reports them: no defaults are filled
   * in, so an absent value stays `undefined` and fails the strict comparison
   * with the approved registration instead of silently passing.
   */
  readonly policy: string | null | undefined;
  readonly partition: boolean | null | undefined;
  readonly retryLimit: number | null | undefined;
  readonly retryDelay: number | null | undefined;
  readonly retryBackoff: boolean | null | undefined;
  readonly retryDelayMax: number | null | undefined;
  readonly expireInSeconds: number | null | undefined;
  readonly retentionSeconds: number | null | undefined;
  readonly deleteAfterSeconds: number | null | undefined;
  readonly deadLetter: string | null | undefined;
  /** Reported counts: pg-boss may serve them from its queue cache; they are not authoritative accounting. */
  readonly readyCount: number;
  readonly queuedCount: number;
  readonly activeCount: number;
  /** Retained terminal failures (bounded by queue retention), not an all-time total. */
  readonly failedCount: number;
  /** Null until a queue monitor pass has counted the queue. */
  readonly readyOldestSeconds: number | null;
}

/** A job as the queue delivers it. `data` is untrusted until parsed by the shared job schema. */
export interface QueueJob {
  readonly id: string;
  readonly data: unknown;
  readonly retryCount: number;
}

/** Options the worker passes when it enqueues inside the caller's transaction. */
export interface QueueSendOptions {
  /** Transaction adapter: the insert runs on the caller's open transaction, never on the queue pool. */
  readonly db: Db;
  /** Deterministic job ID; a second send with the same ID inserts nothing and resolves null. */
  readonly id: string;
  /** Fairness hint for groupConcurrency; correctness never depends on it. */
  readonly group: { readonly id: string };
  readonly retryLimit: number;
  readonly retryDelay: number;
  readonly retryBackoff: boolean;
  readonly retryDelayMax: number;
  // Expiration, retention and deadLetter are not sendable here: jobs inherit them from the verified queue.
}

/** Work registration. The literal types pin the safe shape: one job per fetch, never pg-boss transactional. */
export interface QueueWorkOptions {
  readonly batchSize: 1;
  /** Handlers run by this process; not a global limit across processes. */
  readonly localConcurrency: number;
  readonly groupConcurrency: 1;
  readonly pollingIntervalSeconds: number;
  readonly transactional: false;
}

export type QueueJobHandler = (jobs: readonly QueueJob[]) => Promise<object>;

export interface QueueStopOptions {
  readonly graceful: boolean;
  readonly close: boolean;
  /** Finite graceful budget; pg-boss fails still-active jobs back to retry when it expires. */
  readonly timeoutMs: number;
}

export interface WorkerQueueClient {
  /** Background error listener; must be attached before start. */
  onError(listener: (error: unknown) => void): void;
  start(): Promise<void>;
  getQueue(name: string): Promise<QueueRegistration | null>;
  send(name: string, data: object, options: QueueSendOptions): Promise<string | null>;
  work(name: string, options: QueueWorkOptions, handler: QueueJobHandler): Promise<void>;
  /** Stops fetching for `name` without waiting; active handlers keep running. */
  stopFetching(name: string): Promise<void>;
  stop(options: QueueStopOptions): Promise<void>;
}

export const QUEUE_APPLICATION_NAME = 'workloom-worker-queue';
const QUEUE_CONNECTION_TIMEOUT_MS = 10_000;

export interface PgBossClientOptions {
  readonly schema: string;
}

/**
 * Constructs the runtime pg-boss client: its own bounded pool from the
 * validated loopback URL, no migration or schema creation, no schedules, no
 * maintenance DDL (reindex), no instance registry, no telemetry. Supervision
 * stays on so expired leases and retention are maintained. Nothing connects
 * until `start()`.
 */
export function createPgBossQueueClient(config: WorkerConfig, options: PgBossClientOptions): WorkerQueueClient {
  return wrapPgBoss(new PgBoss(pgBossRuntimeOptions(config, options)));
}

/** Constructor options of the runtime client; exported so the no-migration settings are testable without a connection. */
export function pgBossRuntimeOptions(
  config: Pick<WorkerConfig, 'database' | 'queuePoolMax'>,
  options: PgBossClientOptions,
): ConstructorOptions {
  return {
    connectionString: config.database.url,
    schema: options.schema,
    application_name: QUEUE_APPLICATION_NAME,
    max: config.queuePoolMax,
    connectionTimeoutMillis: QUEUE_CONNECTION_TIMEOUT_MS,
    // PostgreSQL-enforced bounds also cover getQueue() health/stat reads.
    options: '-c statement_timeout=15000 -c lock_timeout=5000',
    migrate: false,
    createSchema: false,
    schedule: false,
    supervise: true,
    reindex: false,
    registerInstance: false,
    openTelemetry: { enabled: false },
  };
}

function toRegistration(queue: QueueResult): QueueRegistration {
  return {
    name: queue.name,
    policy: queue.policy,
    partition: queue.partition,
    retryLimit: queue.retryLimit,
    retryDelay: queue.retryDelay,
    retryBackoff: queue.retryBackoff,
    retryDelayMax: queue.retryDelayMax,
    expireInSeconds: queue.expireInSeconds,
    retentionSeconds: queue.retentionSeconds,
    deleteAfterSeconds: queue.deleteAfterSeconds,
    deadLetter: queue.deadLetter,
    readyCount: queue.readyCount,
    queuedCount: queue.queuedCount,
    activeCount: queue.activeCount,
    failedCount: queue.failedCount,
    readyOldestSeconds: queue.readyOldestSeconds,
  };
}

/** Adapts a PgBoss instance to the narrow port. Exported for the bootstrap only. */
export function wrapPgBoss(boss: PgBoss): WorkerQueueClient {
  return {
    onError(listener) {
      boss.on('error', listener);
    },
    async start() {
      await boss.start();
    },
    async getQueue(name) {
      const queue = await boss.getQueue(name);
      return queue === null ? null : toRegistration(queue);
    },
    send(name, data, options) {
      const sendOptions: SendOptions = {
        db: options.db,
        id: options.id,
        group: { id: options.group.id },
        retryLimit: options.retryLimit,
        retryDelay: options.retryDelay,
        retryBackoff: options.retryBackoff,
        retryDelayMax: options.retryDelayMax,
      };
      return boss.send(name, data, sendOptions);
    },
    async work(name, options, handler) {
      const handle = (jobs: Job<unknown>[]): Promise<object> => handler(jobs);
      await boss.work(
        name,
        {
          batchSize: options.batchSize,
          localConcurrency: options.localConcurrency,
          groupConcurrency: options.groupConcurrency,
          pollingIntervalSeconds: options.pollingIntervalSeconds,
          transactional: options.transactional,
        },
        handle,
      );
    },
    async stopFetching(name) {
      await boss.offWork(name, { wait: false });
    },
    async stop(options) {
      await boss.stop({ graceful: options.graceful, close: options.close, timeout: options.timeoutMs });
    },
  };
}
