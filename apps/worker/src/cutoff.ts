import { cutoffJobSchema, cutoffRequestedEventSchema, cutoffWorkerOutcomeSchema, type CutoffWorkerOutcome, type CutoffWorkerStatus } from '@workloom/contracts';
import { CUTOFF_QUEUE, CUTOFF_QUEUE_OPTIONS } from '@workloom/db';
import type { CutoffRelayEnqueue, CutoffWorkerFacade } from '@workloom/domain';
import { sql } from 'drizzle-orm';
import { fromDrizzle, type DrizzleTransactionLike } from 'pg-boss';

import { classifyError, type SafeErrorInfo, type WorkerLogger } from './logging.js';
import type { QueueJobHandler, QueueSendOptions, WorkerQueueClient } from './queue.js';

export const CUTOFF_JOB_RETRY = {
  retryLimit: CUTOFF_QUEUE_OPTIONS.retryLimit,
  retryDelay: CUTOFF_QUEUE_OPTIONS.retryDelay,
  retryBackoff: CUTOFF_QUEUE_OPTIONS.retryBackoff,
  retryDelayMax: CUTOFF_QUEUE_OPTIONS.retryDelayMax,
} as const satisfies Pick<QueueSendOptions, 'retryLimit' | 'retryDelay' | 'retryBackoff' | 'retryDelayMax'>;

export class CutoffEventRejectedError extends Error {
  override readonly name = 'CutoffEventRejectedError';
  readonly code = 'CUTOFF_EVENT_REJECTED';
  constructor() { super('Subscribed cutoff event failed strict validation.'); }
}

/** Queue insert and outbox dispatch commit on the caller's one open transaction. */
export function createCutoffEnqueue<Tx extends DrizzleTransactionLike>(queue: Pick<WorkerQueueClient, 'send'>): CutoffRelayEnqueue<Tx> {
  return async (tx, event) => {
    const parsed = cutoffRequestedEventSchema.safeParse(event);
    if (!parsed.success) throw new CutoffEventRejectedError();
    const { eventId, workspaceId, schemaVersion, payload } = parsed.data;
    const job = cutoffJobSchema.parse({ schemaVersion, workspaceId, ...payload });
    const jobId = await queue.send(CUTOFF_QUEUE, job, {
      db: fromDrizzle(tx, sql), id: eventId, group: { id: workspaceId },
      // Never recompute the instant or sleep inside a handler. This also covers durable continuations.
      startAfter: payload.cutoffAt, ...CUTOFF_JOB_RETRY,
    });
    return { accepted: true, jobId };
  };
}

export class InvalidCutoffJobError extends Error {
  override readonly name = 'InvalidCutoffJobError';
  readonly code = 'CUTOFF_JOB_INVALID';
  constructor() { super('Cutoff handler expects exactly one strictly validated job.'); }
}
export class InvalidCutoffOutcomeError extends Error {
  override readonly name = 'InvalidCutoffOutcomeError';
  readonly code = 'CUTOFF_OUTCOME_INVALID';
  constructor() { super('Cutoff facade returned an invalid outcome.'); }
}
/** Safe queue failure output: no original message, stack, cause or job payload. */
export class CutoffJobFailedError extends Error {
  override readonly name = 'CutoffJobFailedError';
  readonly code: string | undefined;
  readonly causeName: string;
  constructor(info: SafeErrorInfo) {
    super(`Cutoff job failed (${info.name}${info.code === undefined ? '' : ` ${info.code}`}).`);
    this.code = info.code; this.causeName = info.name;
  }
}
export interface CutoffJobCounters {
  readonly outcomes: Readonly<Record<CutoffWorkerStatus, number>>;
  readonly rejected: number; readonly failed: number; readonly lastFailureAt: number | null;
}
export interface CutoffHandler { readonly handle: QueueJobHandler; counters(): CutoffJobCounters }

/** Controlled outcomes acknowledge once; their domain transaction already owns any durable continuation. */
export function createCutoffHandler(options: { readonly facade: CutoffWorkerFacade; readonly logger: WorkerLogger; readonly now?: () => number }): CutoffHandler {
  const now = options.now ?? Date.now;
  const outcomes: Record<CutoffWorkerStatus, number> = { frozen: 0, already_frozen: 0, pending: 0, not_due: 0, stale: 0, blocked: 0 };
  let rejected = 0; let failed = 0; let lastFailureAt: number | null = null;
  return {
    async handle(jobs): Promise<CutoffWorkerOutcome> {
      const [job] = jobs;
      const parsed = cutoffJobSchema.safeParse(job?.data);
      if (jobs.length !== 1 || job === undefined || !parsed.success) {
        rejected += 1; lastFailureAt = now();
        options.logger.error('cutoff.job_rejected', { count: jobs.length, reason: 'invalid_job' });
        throw new InvalidCutoffJobError();
      }
      const startedAt = now();
      const logger = options.logger.child({ jobId: job.id, workspaceId: parsed.data.workspaceId, entityType: 'planning_period', entityId: parsed.data.periodId });
      let outcome: CutoffWorkerOutcome;
      try {
        outcome = await options.facade.freezeDuePeriod(parsed.data);
      } catch (error) {
        failed += 1; lastFailureAt = now();
        logger.error('cutoff.job_failed', { error, attempt: job.retryCount, durationMs: now() - startedAt });
        throw new CutoffJobFailedError(classifyError(error));
      }
      const validated = cutoffWorkerOutcomeSchema.safeParse(outcome);
      if (!validated.success || validated.data.requestId !== parsed.data.requestId || validated.data.periodId !== parsed.data.periodId) {
        failed += 1; lastFailureAt = now();
        logger.error('cutoff.job_failed', { reason: 'invalid_outcome' });
        throw new InvalidCutoffOutcomeError();
      }
      outcomes[outcome.status] += 1;
      logger.log(outcome.status === 'blocked' ? 'warn' : 'info', 'cutoff.job_done', {
        result: outcome.status, count: outcome.createdCount, attempt: job.retryCount, durationMs: now() - startedAt,
        ...(outcome.blockedCode === null ? {} : { reason: outcome.blockedCode }),
      });
      return validated.data;
    },
    counters() { return { outcomes: { ...outcomes }, rejected, failed, lastFailureAt }; },
  };
}
