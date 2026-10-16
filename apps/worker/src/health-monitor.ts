import type { WorkerHealthReport } from './health.js';
import type { LogSeverity, WorkerLogger } from './logging.js';

/**
 * Periodic health observation of a running worker. There is no HTTP endpoint:
 * each observation is written as structured aggregate log lines (one
 * `worker.health` line plus one `worker.health_queue` line per approved queue).
 *
 * Observations never overlap: the next one is scheduled only after the
 * previous one settled. Nothing races or abandons a read: each read is bounded
 * by the statement/lock timeouts of the connection it runs on, and shutdown
 * stops the timer and waits for an in-flight read before any pool closes.
 */
export const HEALTH_OBSERVATION_INTERVAL_MS = 30_000;

/** Schedules `run` after `ms`; returns a cancel function. Injected in tests. */
export type HealthSchedule = (run: () => void, ms: number) => () => void;

const defaultSchedule: HealthSchedule = (run, ms) => {
  const timer = setTimeout(run, ms);
  return () => clearTimeout(timer);
};

export interface HealthMonitorOptions {
  /** The real health read (queue rows, relay health, process counters). */
  readonly read: () => Promise<WorkerHealthReport>;
  readonly logger: WorkerLogger;
  readonly intervalMs?: number;
  readonly schedule?: HealthSchedule;
}

export interface HealthMonitor {
  /** Observes now, then again `intervalMs` after each observation settled. Idempotent. */
  start(): void;
  /** No further observation starts; an in-flight read is not interrupted. Idempotent. */
  stop(): void;
  /** Resolves when no observation is in flight. Never rejects. */
  drain(): Promise<void>;
}

const SEVERITY: Readonly<Record<WorkerHealthReport['status'], LogSeverity>> = { ok: 'info', degraded: 'warn', down: 'error' };

/** A count field only when the reading exists: null stays absent rather than becoming 0. */
function present<K extends string>(key: K, value: number | null): { readonly [P in K]?: number } {
  return (value === null ? {} : { [key]: value }) as { readonly [P in K]?: number };
}

/** Writes a report as safe aggregate lines: code-defined names and counts only, never payloads or reported values. */
export function logHealthReport(logger: WorkerLogger, report: WorkerHealthReport): void {
  logger.log(SEVERITY[report.status], 'worker.health', {
    status: report.status,
    lifecycle: report.lifecycle,
    reasons: report.reasons,
    ...present('ageMs', report.heartbeat.ageMs),
    ...present('deadLetterCount', report.reportedDeadLetterCount),
    ...present('pendingCount', report.relay.pendingSubscribedCount),
    ...present('oldestAgeMs', report.relay.oldestSubscribedAgeMs),
    ...present('unsupportedCount', report.relay.unsupportedSubscribedCount),
    consecutiveFailures: report.relay.consecutiveFailures,
    failedBatches: report.relay.failedBatches,
    queueErrors: report.queueErrorsSinceStart,
    jobsFailed: report.jobs.failed,
    jobsRejected: report.jobs.rejected,
  });
  if (report.cutoff !== undefined) {
    const cutoff = report.cutoff;
    logger.log(SEVERITY[report.status], 'worker.health_cutoff', {
      status: report.status, ...present('ageMs', cutoff.heartbeat.ageMs),
      ...present('pendingCount', cutoff.relay.pendingSubscribedCount),
      ...present('unsupportedCount', cutoff.relay.unsupportedSubscribedCount),
      consecutiveFailures: cutoff.relay.consecutiveFailures, failedBatches: cutoff.relay.failedBatches,
      jobsFailed: cutoff.jobs.failed, jobsRejected: cutoff.jobs.rejected,
    });
    for (const [result, count] of Object.entries(cutoff.jobs.outcomes)) logger.info('worker.health_cutoff_outcome', { result, count });
    logger.log(cutoff.discovery.consecutiveFailures > 0 ? 'warn' : 'info', 'worker.health_discovery', {
      consecutiveFailures: cutoff.discovery.consecutiveFailures, failedBatches: cutoff.discovery.failedBatches,
      ...(cutoff.discovery.discoveryBatch === null ? {} : { count: cutoff.discovery.discoveryBatch.requestedCount }),
    });
  }
  for (const queue of report.queues) {
    logger.log(queue.state === 'ready' ? 'info' : 'error', 'worker.health_queue', {
      jobName: queue.name,
      state: queue.state,
      ...(queue.mismatchedProperties.length === 0 ? {} : { properties: queue.mismatchedProperties }),
      ...(queue.reported === null
        ? {}
        : {
            readyCount: queue.reported.readyCount,
            queuedCount: queue.reported.queuedCount,
            activeCount: queue.reported.activeCount,
            failedCount: queue.reported.failedCount,
            ...present('readyOldestSeconds', queue.reported.readyOldestSeconds),
          }),
    });
  }
}

export function createHealthMonitor(options: HealthMonitorOptions): HealthMonitor {
  const intervalMs = options.intervalMs ?? HEALTH_OBSERVATION_INTERVAL_MS;
  if (!Number.isInteger(intervalMs) || intervalMs < 1) {
    throw new RangeError('Health observation interval must be a positive integer of milliseconds.');
  }
  const schedule = options.schedule ?? defaultSchedule;
  const { logger } = options;

  let started = false;
  let stopped = false;
  let cancelTimer: (() => void) | undefined;
  let inFlight: Promise<void> | undefined;

  async function observe(): Promise<void> {
    try {
      logHealthReport(logger, await options.read());
    } catch (error) {
      logger.error('worker.health_failed', { error });
    }
  }

  function tick(): void {
    cancelTimer = undefined;
    if (stopped) return;
    inFlight = observe().finally(() => {
      inFlight = undefined;
      if (!stopped) cancelTimer = schedule(tick, intervalMs);
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
  };
}
