import { recurrenceMaterializationJobSchema } from '@workloom/contracts';
import type { RecurrenceWorkerFacade, RecurrenceWorkerOutcome, RecurrenceWorkerStatus } from '@workloom/domain';

import { classifyError, type SafeErrorInfo, type WorkerLogger } from './logging.js';
import type { QueueJob, QueueJobHandler } from './queue.js';

/**
 * Consumer of `workloom.recurrence.materialize.v1`. Each job is one call to the
 * authoritative domain facade, which opens exactly one workspace unit of work,
 * resolves and revalidates the stored authorizer under the workspace barrier,
 * and writes any continuation (pending) or refreshed request (stale) in that
 * same unit of work. The handler never sends jobs itself.
 *
 * Every controlled outcome completes (acknowledges) the job. Only an invalid
 * payload or an unexpected error rejects, which hands the job to pg-boss's
 * bounded retry. Delivery is at least once: a crash between the domain commit
 * and the acknowledgement re-delivers the job, and durable occurrence
 * uniqueness in the domain makes the repeat harmless. Nothing here claims
 * exactly-once. The job's AbortSignal is not forwarded: it cannot cancel a
 * database transaction that is already running.
 */
export const RECURRENCE_WORKER_STATUSES = [
  'complete',
  'pending',
  'stale',
  'blocked',
  'paused',
] as const satisfies readonly RecurrenceWorkerStatus[];

/** Metadata-only job output stored by the queue: status, counts, block code and IDs. */
export interface MaterializationJobResult {
  readonly status: RecurrenceWorkerStatus;
  readonly bindingId: string;
  readonly periodId: string;
  readonly createdCount: number;
  readonly remainingCount: number;
  readonly blockedCode: RecurrenceWorkerOutcome['blockedCode'];
}

/** Queue data that is not exactly a materialization job (extra keys such as an actor, wrong types). */
export class InvalidMaterializationJobError extends Error {
  override readonly name = 'InvalidMaterializationJobError';
  readonly code = 'RECURRENCE_JOB_INVALID';

  constructor() {
    super('Queue job data failed strict materialization job validation.');
  }
}

/** pg-boss received a batch of a size other than one; nothing was executed. */
export class UnexpectedJobBatchError extends Error {
  override readonly name = 'UnexpectedJobBatchError';
  readonly code = 'RECURRENCE_JOB_BATCH';

  constructor() {
    super('Materialization handler expects exactly one job per batch.');
  }
}

/** The facade returned something outside the frozen outcome contract. */
export class InvalidWorkerOutcomeError extends Error {
  override readonly name = 'InvalidWorkerOutcomeError';
  readonly code = 'RECURRENCE_OUTCOME_INVALID';

  constructor() {
    super('Recurrence worker facade returned an unknown outcome.');
  }
}

/**
 * What pg-boss stores as the failure output and retries. It carries only the
 * safe classification of the original error, never its message, stack, cause
 * or any payload, so private text cannot reach the queue tables either.
 */
export class MaterializationJobFailedError extends Error {
  override readonly name = 'MaterializationJobFailedError';
  readonly code: string | undefined;
  readonly causeName: string;

  constructor(info: SafeErrorInfo) {
    super(`Materialization job failed (${info.name}${info.code === undefined ? '' : ` ${info.code}`}).`);
    this.causeName = info.name;
    this.code = info.code;
  }
}

export interface MaterializationJobCounters {
  readonly outcomes: Readonly<Record<RecurrenceWorkerStatus, number>>;
  readonly rejected: number;
  readonly failed: number;
  readonly lastFailureAt: number | null;
}

export interface MaterializationHandler {
  readonly handle: QueueJobHandler;
  counters(): MaterializationJobCounters;
}

export interface MaterializationHandlerOptions {
  readonly facade: RecurrenceWorkerFacade;
  readonly logger: WorkerLogger;
  readonly now?: () => number;
}

function isWorkerStatus(value: unknown): value is RecurrenceWorkerStatus {
  return (RECURRENCE_WORKER_STATUSES as readonly unknown[]).includes(value);
}

export function createMaterializationHandler(options: MaterializationHandlerOptions): MaterializationHandler {
  const { facade, logger } = options;
  const now = options.now ?? (() => Date.now());
  const outcomes: Record<RecurrenceWorkerStatus, number> = { complete: 0, pending: 0, stale: 0, blocked: 0, paused: 0 };
  let rejected = 0;
  let failed = 0;
  let lastFailureAt: number | null = null;

  async function handleOne(job: QueueJob): Promise<MaterializationJobResult> {
    const startedAt = now();
    const parsed = recurrenceMaterializationJobSchema.safeParse(job.data);
    if (!parsed.success) {
      rejected += 1;
      lastFailureAt = now();
      // Only the queue-assigned ID and attempt: the data itself is untrusted and never logged.
      logger.error('materialize.job_rejected', { jobId: job.id, attempt: job.retryCount, reason: 'invalid_job' });
      throw new InvalidMaterializationJobError();
    }
    const data = parsed.data;
    const jobLog = logger.child({ jobId: job.id, workspaceId: data.workspaceId, entityType: 'recurrence_binding', entityId: data.bindingId });

    let outcome: RecurrenceWorkerOutcome;
    try {
      outcome = await facade.materializeBinding(data);
    } catch (error) {
      failed += 1;
      lastFailureAt = now();
      jobLog.error('materialize.job_failed', { attempt: job.retryCount, durationMs: now() - startedAt, error });
      throw new MaterializationJobFailedError(classifyError(error));
    }

    if (!isWorkerStatus(outcome.status)) {
      failed += 1;
      lastFailureAt = now();
      jobLog.error('materialize.job_failed', { attempt: job.retryCount, durationMs: now() - startedAt, reason: 'invalid_outcome' });
      throw new InvalidWorkerOutcomeError();
    }
    outcomes[outcome.status] += 1;
    const fields = {
      attempt: job.retryCount,
      result: outcome.status,
      count: outcome.createdCount,
      durationMs: now() - startedAt,
      ...(outcome.blockedCode === null ? {} : { reason: outcome.blockedCode }),
    };
    if (outcome.status === 'blocked') {
      jobLog.warn('materialize.job_done', fields);
    } else {
      jobLog.info('materialize.job_done', fields);
    }
    return {
      status: outcome.status,
      bindingId: outcome.bindingId,
      periodId: outcome.periodId,
      createdCount: outcome.createdCount,
      remainingCount: outcome.remainingCount,
      blockedCode: outcome.blockedCode,
    };
  }

  return {
    async handle(jobs) {
      const [job] = jobs;
      if (jobs.length !== 1 || job === undefined) {
        failed += 1;
        lastFailureAt = now();
        logger.error('materialize.batch_rejected', { count: jobs.length, reason: 'unexpected_batch' });
        throw new UnexpectedJobBatchError();
      }
      return handleOne(job);
    },
    counters() {
      return { outcomes: { ...outcomes }, rejected, failed, lastFailureAt };
    },
  };
}
