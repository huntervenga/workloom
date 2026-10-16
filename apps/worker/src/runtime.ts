import { RECURRENCE_MATERIALIZE_QUEUE, RECURRENCE_QUEUE_REGISTRATIONS, type ReadinessProbe } from '@workloom/db';
import type { RecurrenceOutboxRelay, RecurrenceRelayHealth, RecurrenceWorkerFacade } from '@workloom/domain';
import type { DrizzleTransactionLike } from 'pg-boss';

import type { WorkerConfig } from './config.js';
import { assessQueueRegistration, buildHealthReport, type WorkerHealthReport, type WorkerLifecycle } from './health.js';
import { createHealthMonitor, type HealthSchedule } from './health-monitor.js';
import type { WorkerLogger } from './logging.js';
import { createMaterializationHandler } from './materialize.js';
import type { QueueRegistration, QueueWorkOptions, WorkerQueueClient } from './queue.js';
import { MAX_RELAY_BACKOFF_MS, createMaterializationEnqueue, createRelayPoller, type RelaySchedule } from './relay.js';
import { createShutdown, type ShutdownController, type ShutdownResult, type ShutdownStep } from './shutdown.js';

/** A queue row is absent or differs from the approved registration of `db:queue:migrate`. */
export class QueueRegistrationError extends Error {
  override readonly name = 'QueueRegistrationError';
  readonly code: 'QUEUE_MISSING' | 'QUEUE_INCOMPATIBLE';
  readonly queueName: string;

  constructor(code: 'QUEUE_MISSING' | 'QUEUE_INCOMPATIBLE', queueName: string) {
    super(
      code === 'QUEUE_MISSING'
        ? `Queue ${queueName} is not registered; run the explicit queue migration command first.`
        : `Queue ${queueName} differs from its approved registration; the worker does not repair it.`,
    );
    this.code = code;
    this.queueName = queueName;
  }
}

/** The application database is unreachable or its schema is not this build's (see `@workloom/db` readiness). */
export class ApplicationSchemaUnreadyError extends Error {
  override readonly name = 'ApplicationSchemaUnreadyError';
  readonly code = 'APP_SCHEMA_UNREADY';

  constructor() {
    super('Application database readiness check failed; run the explicit migration command first.');
  }
}

/** Only the fixed check outcomes are used; the probe's diagnostic (tables, migration state, errors) is never read. */
export type ApplicationReadiness = Pick<ReadinessProbe, 'check'>;

/** start() was interrupted by shutdown (for example a signal during startup). */
export class WorkerStartAbortedError extends Error {
  override readonly name = 'WorkerStartAbortedError';
  readonly code = 'WORKER_START_ABORTED';

  constructor() {
    super('Worker shutdown began before startup completed.');
  }
}

export class WorkerRuntimeStateError extends Error {
  override readonly name = 'WorkerRuntimeStateError';
  readonly code = 'WORKER_ALREADY_STARTED';

  constructor() {
    super('A worker runtime can be started only once.');
  }
}

/** A resource the runtime closes exactly once in the close phase (e.g. the application database pool). */
export interface OwnedResource {
  /** Code-defined step name, e.g. `database.close`. */
  readonly name: string;
  close(): Promise<void>;
}

export interface WorkerRuntimeDependencies<Tx extends DrizzleTransactionLike> {
  readonly config: Pick<WorkerConfig, 'jobConcurrency' | 'pollIntervalMs' | 'shutdownTimeoutMs'>;
  readonly logger: WorkerLogger;
  /** Mandatory: checked before the queue starts and before any handler or relay work. */
  readonly readiness: ApplicationReadiness;
  /** Owned: the runtime starts it, stops it gracefully and closes its pool. */
  readonly queue: WorkerQueueClient;
  readonly facade: RecurrenceWorkerFacade;
  readonly relay: RecurrenceOutboxRelay<Tx>;
  /** Closed after the queue, in order, once. Resources the caller keeps must not be listed. */
  readonly ownedResources?: readonly OwnedResource[];
  readonly relayBatchLimit?: number;
  readonly relaySchedule?: RelaySchedule;
  /** Health observation cadence; defaults to HEALTH_OBSERVATION_INTERVAL_MS. */
  readonly healthIntervalMs?: number;
  readonly healthSchedule?: HealthSchedule;
  readonly now?: () => number;
}

export interface WorkerRuntime {
  /**
   * Checks application schema readiness, starts the queue client, verifies both
   * approved queue rows, then registers the consumer, starts relay polling and
   * logs the first health observation (then one per interval).
   * On any failure everything owned is closed and the error is rethrown.
   */
  start(): Promise<void>;
  /** Shared, idempotent graceful shutdown. */
  readonly shutdownController: ShutdownController;
  shutdown(reason: string): Promise<ShutdownResult>;
  health(): Promise<WorkerHealthReport>;
  readonly lifecycle: WorkerLifecycle;
}

/** pg-boss polling, in seconds, derived from the validated per-process interval (>= 0.5 s). */
function pollingSeconds(intervalMs: number): number {
  return Math.max(0.5, intervalMs / 1000);
}

const RECENT_FAILURE_WINDOW_MS = 5 * 60_000;

/**
 * Assembles the worker from injected ports. Nothing here opens connections,
 * migrates, registers queues, binds signals or listens: `bootstrap.ts` builds
 * the real ports and `main.ts` owns the process.
 */
export function createWorkerRuntime<Tx extends DrizzleTransactionLike>(deps: WorkerRuntimeDependencies<Tx>): WorkerRuntime {
  const { config, logger, queue } = deps;
  const now = deps.now ?? (() => Date.now());
  const handler = createMaterializationHandler({ facade: deps.facade, logger, now });
  const poller = createRelayPoller({
    relay: deps.relay,
    enqueue: createMaterializationEnqueue<Tx>(queue),
    intervalMs: config.pollIntervalMs,
    logger,
    now,
    ...(deps.relayBatchLimit === undefined ? {} : { batchLimit: deps.relayBatchLimit }),
    ...(deps.relaySchedule === undefined ? {} : { schedule: deps.relaySchedule }),
  });
  const workOptions: QueueWorkOptions = {
    batchSize: 1,
    localConcurrency: config.jobConcurrency,
    groupConcurrency: 1,
    pollingIntervalSeconds: pollingSeconds(config.pollIntervalMs),
    transactional: false,
  };

  let lifecycle: WorkerLifecycle = 'created';
  let runningSince: number | null = null;
  /** Set before calling start(): a stop must also cover a start that is still in flight. */
  let queueStartAttempted = false;
  /** Set before calling work(): a worker registered late must still be stopped. */
  let workAttempted = false;
  /** True between a settled start() and the queue close; health reads the queue only then. */
  let queueReadable = false;
  let queueErrors = 0;
  let lastQueueErrorAt: number | null = null;
  /**
   * The raw queue.start()/queue.work() call, settled either way. Queue shutdown
   * steps wait for it, so a pool or worker that appears after the signal is
   * still stopped and closed. Never the runtime start() itself: that awaits
   * shutdown, and waiting for it here would be a cycle.
   */
  let queueCall: Promise<void> = Promise.resolve();

  function trackQueueCall(call: Promise<void>): Promise<void> {
    queueCall = call.then(
      () => undefined,
      () => undefined,
    );
    return call;
  }

  async function health(): Promise<WorkerHealthReport> {
    const queues = new Map<string, QueueRegistration | null | 'unavailable'>();
    let relayHealth: RecurrenceRelayHealth | 'unavailable' = 'unavailable';
    if (queueReadable && lifecycle !== 'stopped') {
      const [readings, relayReading] = await Promise.all([
        Promise.all(
          RECURRENCE_QUEUE_REGISTRATIONS.map((approved) =>
            queue.getQueue(approved.name).catch((): 'unavailable' => 'unavailable'),
          ),
        ),
        deps.relay.getHealth().catch((): 'unavailable' => 'unavailable'),
      ]);
      RECURRENCE_QUEUE_REGISTRATIONS.forEach((approved, index) => {
        // null is a real reading (queue absent), so only a missing slot becomes unavailable.
        const reading = readings[index];
        queues.set(approved.name, reading === undefined ? 'unavailable' : reading);
      });
      relayHealth = relayReading;
    }
    return buildHealthReport({
      now: now(),
      lifecycle,
      runningSince,
      staleAfterMs: config.pollIntervalMs * 3 + MAX_RELAY_BACKOFF_MS,
      recentWindowMs: RECENT_FAILURE_WINDOW_MS,
      queues,
      queueErrors,
      lastQueueErrorAt,
      relayHealth,
      poller: poller.snapshot(),
      jobs: handler.counters(),
    });
  }

  const monitor = createHealthMonitor({
    read: health,
    logger,
    ...(deps.healthIntervalMs === undefined ? {} : { intervalMs: deps.healthIntervalMs }),
    ...(deps.healthSchedule === undefined ? {} : { schedule: deps.healthSchedule }),
  });

  const steps = {
    healthStop: { name: 'health.stop', run: () => monitor.stop() },
    relayStop: { name: 'relay.stop', run: () => poller.stop() },
    queueStopFetching: {
      name: 'queue.stop_fetching',
      run: async () => {
        await queueCall;
        if (workAttempted) await queue.stopFetching(RECURRENCE_MATERIALIZE_QUEUE);
      },
    },
    relayDrain: { name: 'relay.drain', run: () => poller.drain() },
    queueDrain: {
      name: 'queue.drain',
      run: async () => {
        await queueCall;
        if (queueStartAttempted) await queue.stop({ graceful: true, close: false, timeoutMs: config.shutdownTimeoutMs });
      },
    },
    // A close step, so it also runs when drain was skipped: no health read outlives the pools it uses.
    healthDrain: { name: 'health.drain', run: () => monitor.drain() },
    // Always runs, even when start() never got that far or drain was skipped: closes the queue pool once.
    queueClose: {
      name: 'queue.close',
      run: async () => {
        await queueCall;
        queueReadable = false;
        await queue.stop({ graceful: false, close: true, timeoutMs: config.shutdownTimeoutMs });
      },
    },
  } satisfies Record<string, ShutdownStep>;

  const controller = createShutdown(
    {
      stopIntake: [steps.healthStop, steps.relayStop, steps.queueStopFetching],
      drain: [steps.relayDrain, steps.queueDrain],
      close: [
        steps.healthDrain,
        steps.queueClose,
        ...(deps.ownedResources ?? []).map((resource) => ({ name: resource.name, run: () => resource.close() })),
      ],
    },
    { logger },
  );

  function shutdown(reason: string): Promise<ShutdownResult> {
    if (lifecycle !== 'stopped') lifecycle = 'stopping';
    return controller.shutdown(reason).then((result) => {
      lifecycle = 'stopped';
      return result;
    });
  }

  const shutdownController: ShutdownController = {
    shutdown,
    get started() {
      return controller.started;
    },
  };

  /** Called right before every raw queue call and after every await, so nothing new starts once shutdown began. */
  function assertNotStopping(): void {
    if (controller.started) throw new WorkerStartAbortedError();
  }

  async function requireApplicationReadiness(): Promise<void> {
    let checks: { readonly database: string; readonly schema: string };
    try {
      ({ checks } = await deps.readiness.check());
    } catch {
      // The probe is not expected to throw; its error is not logged either way.
      logger.error('worker.readiness_failed', { step: 'probe', result: 'failed' });
      throw new ApplicationSchemaUnreadyError();
    }
    if (checks.database !== 'ok' || checks.schema !== 'ok') {
      logger.error('worker.readiness_failed', { step: 'database', result: checks.database });
      logger.error('worker.readiness_failed', { step: 'schema', result: checks.schema });
      throw new ApplicationSchemaUnreadyError();
    }
  }

  async function start(): Promise<void> {
    // A shutdown requested before start (e.g. an early signal) has already closed what the runtime owns.
    if (controller.started) throw new WorkerStartAbortedError();
    if (lifecycle !== 'created') throw new WorkerRuntimeStateError();
    lifecycle = 'starting';
    try {
      assertNotStopping();
      await requireApplicationReadiness();
      assertNotStopping();

      // Attached before start so no background error is ever unhandled; only a safe classification is logged.
      queue.onError((error) => {
        queueErrors += 1;
        lastQueueErrorAt = now();
        logger.error('queue.error', { error });
      });
      queueStartAttempted = true;
      await trackQueueCall(queue.start());
      assertNotStopping();
      queueReadable = true;

      // Dead-letter queue first, then materialization: both must match before any handler exists.
      for (const approved of RECURRENCE_QUEUE_REGISTRATIONS) {
        const reading = await queue.getQueue(approved.name);
        assertNotStopping();
        const assessment = assessQueueRegistration(approved, reading);
        if (assessment.state !== 'ready') {
          for (const property of assessment.mismatchedProperties) {
            logger.error('worker.queue_option_mismatch', { jobName: approved.name, step: property });
          }
          throw new QueueRegistrationError(assessment.state === 'missing' ? 'QUEUE_MISSING' : 'QUEUE_INCOMPATIBLE', approved.name);
        }
      }
      assertNotStopping();

      workAttempted = true;
      await trackQueueCall(queue.work(RECURRENCE_MATERIALIZE_QUEUE, workOptions, handler.handle));
      assertNotStopping();

      poller.start();
      lifecycle = 'running';
      runningSince = now();
      logger.info('worker.started', { jobName: RECURRENCE_MATERIALIZE_QUEUE, count: workOptions.localConcurrency });
      // First observation now, then one per interval: the real health report, logged (there is no HTTP server).
      monitor.start();
    } catch (error) {
      const aborted = controller.started;
      if (!aborted) logger.fatal('worker.start_failed', { error });
      await shutdown(aborted ? 'start_aborted' : 'start_failed');
      throw aborted && !(error instanceof WorkerStartAbortedError) ? new WorkerStartAbortedError() : error;
    }
  }

  return {
    start,
    shutdownController,
    shutdown,
    health,
    get lifecycle() {
      return lifecycle;
    },
  };
}
