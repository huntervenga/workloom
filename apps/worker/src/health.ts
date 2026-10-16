import { CUTOFF_DEAD_LETTER_QUEUE, RECURRENCE_DEAD_LETTER_QUEUE, RECURRENCE_QUEUE_REGISTRATIONS, WORKLOOM_QUEUE_REGISTRATIONS, findQueueOptionMismatches } from '@workloom/db';
import type { RecurrenceRelayHealth, RecurrenceWorkerStatus } from '@workloom/domain';

import type { CutoffJobCounters } from './cutoff.js';
import type { MaterializationJobCounters } from './materialize.js';
import type { QueueRegistration } from './queue.js';
import type { RelayPollerSnapshot } from './relay.js';

/** One approved queue (dead-letter first, then materialization), exactly as `db:queue:migrate` registers it. */
export type ApprovedQueueRegistration = (typeof WORKLOOM_QUEUE_REGISTRATIONS)[number];

export type QueueRegistrationState = 'ready' | 'missing' | 'incompatible';

export interface QueueAssessment {
  readonly state: QueueRegistrationState;
  /** Names of the approved options that differ; code-defined, never the reported values. */
  readonly mismatchedProperties: readonly string[];
}

/**
 * Strict comparison of a reported queue with its approved registration, through
 * the shared foundation helper: every expected option must be present and
 * strictly equal (null only matches an expected null). The runtime never
 * creates, updates or repairs a queue.
 */
export function assessQueueRegistration(approved: ApprovedQueueRegistration, queue: QueueRegistration | null): QueueAssessment {
  if (queue === null) return { state: 'missing', mismatchedProperties: [] };
  const mismatched = findQueueOptionMismatches(approved.expected, queue).map((mismatch) => mismatch.property);
  if (queue.name !== approved.name) mismatched.unshift('name');
  return { state: mismatched.length === 0 ? 'ready' : 'incompatible', mismatchedProperties: mismatched };
}

export type WorkerLifecycle = 'created' | 'starting' | 'running' | 'stopping' | 'stopped';

export type WorkerHealthReason =
  | 'not_running'
  | 'heartbeat_stale'
  | 'queue_missing'
  | 'queue_incompatible'
  | 'queue_unavailable'
  | 'dead_letter_missing'
  | 'dead_letter_incompatible'
  | 'dead_letter_unavailable'
  | 'queue_failed_jobs'
  | 'dead_letter_jobs'
  | 'queue_errors_recent'
  | 'job_failures_recent'
  | 'relay_unavailable'
  | 'relay_failing'
  | 'relay_unsupported_events'
  | 'cutoff_relay_unavailable'
  | 'cutoff_relay_failing'
  | 'cutoff_relay_unsupported_events'
  | 'cutoff_heartbeat_stale'
  | 'cutoff_discovery_failing'
  | 'cutoff_discovery_stale';

/** Reasons that mean the worker cannot make progress or cannot keep failed jobs. */
const DOWN_REASONS: ReadonlySet<WorkerHealthReason> = new Set([
  'not_running',
  'queue_missing',
  'queue_incompatible',
  'queue_unavailable',
  'dead_letter_missing',
  'dead_letter_incompatible',
  'dead_letter_unavailable',
]);

export interface QueueHealth {
  readonly name: string;
  readonly state: QueueRegistrationState | 'unavailable';
  readonly mismatchedProperties: readonly string[];
  /** As reported by pg-boss, possibly from its queue cache: an operational signal, not authoritative accounting. */
  readonly reported: {
    readonly readyCount: number;
    readonly queuedCount: number;
    readonly activeCount: number;
    /** Retained terminal failures within queue retention. */
    readonly failedCount: number;
    readonly readyOldestSeconds: number | null;
  } | null;
}

export interface CutoffHealthInputs {
  readonly relayHealth: RecurrenceRelayHealth | 'unavailable';
  readonly poller: RelayPollerSnapshot;
  readonly jobs: CutoffJobCounters;
  readonly discovery: RelayPollerSnapshot & { readonly discoveryBatch: { readonly selectedCount: number; readonly requestedCount: number; readonly blockedCount: number; readonly cycleComplete: boolean; readonly leased: boolean } | null };
}

export interface WorkerHealthReport {
  readonly cutoff?: {
    readonly relay: WorkerHealthReport['relay'];
    readonly heartbeat: WorkerHealthReport['heartbeat'];
    readonly jobs: Omit<CutoffJobCounters, 'lastFailureAt'>;
    readonly discovery: CutoffHealthInputs['discovery'];
  };
  readonly concurrency?: { readonly active: number; readonly waiting: number; readonly concurrency: number };
  readonly status: 'ok' | 'degraded' | 'down';
  readonly reasons: readonly WorkerHealthReason[];
  readonly checkedAt: string;
  readonly lifecycle: WorkerLifecycle;
  readonly heartbeat: {
    readonly lastRelayCycleAt: string | null;
    readonly ageMs: number | null;
    readonly stale: boolean;
  };
  /** In registration order: dead-letter queue, then materialization queue. */
  readonly queues: readonly QueueHealth[];
  /** Jobs held by the dead-letter queue (queued + failed there), as reported; nothing re-queues them. */
  readonly reportedDeadLetterCount: number | null;
  readonly queueErrorsSinceStart: number;
  /** Exact subscribed type only, as counted by the relay; unrelated outbox rows are not included. */
  readonly relay: {
    readonly state: 'ok' | 'unavailable';
    readonly pendingSubscribedCount: number | null;
    readonly oldestSubscribedAt: string | null;
    readonly oldestSubscribedAgeMs: number | null;
    readonly unsupportedSubscribedCount: number | null;
    readonly consecutiveFailures: number;
    readonly failedBatches: number;
  };
  /** This process since start; not a cluster-wide total. */
  readonly jobs: {
    readonly outcomes: Readonly<Record<RecurrenceWorkerStatus, number>>;
    readonly rejected: number;
    readonly failed: number;
  };
}

export interface HealthInputs {
  readonly now: number;
  readonly lifecycle: WorkerLifecycle;
  readonly runningSince: number | null;
  readonly staleAfterMs: number;
  readonly recentWindowMs: number;
  /** Per approved queue name: the reported registration, null when absent, `unavailable` when the read failed. */
  readonly queues: ReadonlyMap<string, QueueRegistration | null | 'unavailable'>;
  readonly queueErrors: number;
  readonly lastQueueErrorAt: number | null;
  /** `unavailable` when the relay health read failed. */
  readonly relayHealth: RecurrenceRelayHealth | 'unavailable';
  readonly poller: RelayPollerSnapshot;
  readonly jobs: MaterializationJobCounters;
  readonly cutoff?: CutoffHealthInputs;
  readonly concurrency?: WorkerHealthReport['concurrency'];
}

const within = (at: number | null, now: number, windowMs: number): boolean => at !== null && now - at <= windowMs;

function queueHealth(approved: ApprovedQueueRegistration, reading: QueueRegistration | null | 'unavailable' | undefined): QueueHealth {
  if (reading === undefined || reading === 'unavailable') {
    return { name: approved.name, state: 'unavailable', mismatchedProperties: [], reported: null };
  }
  const assessment = assessQueueRegistration(approved, reading);
  return {
    name: approved.name,
    state: assessment.state,
    mismatchedProperties: assessment.mismatchedProperties,
    reported:
      reading === null
        ? null
        : {
            readyCount: reading.readyCount,
            queuedCount: reading.queuedCount,
            activeCount: reading.activeCount,
            failedCount: reading.failedCount,
            readyOldestSeconds: reading.readyOldestSeconds,
          },
  };
}

/** Pure: derives the report from already collected readings, so every rule is unit-testable. */
export function buildHealthReport(input: HealthInputs): WorkerHealthReport {
  const reasons: WorkerHealthReason[] = [];
  const { now } = input;

  if (input.lifecycle !== 'running') reasons.push('not_running');

  const heartbeatAt = input.poller.lastCompletedAt ?? input.runningSince;
  const ageMs = heartbeatAt === null ? null : Math.max(0, now - heartbeatAt);
  const stale = input.lifecycle === 'running' && (ageMs === null || ageMs > input.staleAfterMs);
  if (stale) reasons.push('heartbeat_stale');

  const registrations = input.cutoff === undefined ? RECURRENCE_QUEUE_REGISTRATIONS : WORKLOOM_QUEUE_REGISTRATIONS;
  const queues = registrations.map((approved) => queueHealth(approved, input.queues.get(approved.name)));
  let reportedDeadLetterCount: number | null = null;
  for (const queue of queues) {
    const deadLetter = (queue.name === RECURRENCE_DEAD_LETTER_QUEUE || queue.name === CUTOFF_DEAD_LETTER_QUEUE);
    if (queue.state !== 'ready') {
      const prefix = deadLetter ? 'dead_letter' : 'queue';
      reasons.push(`${prefix}_${queue.state}` as const);
      continue;
    }
    if (queue.reported === null) continue;
    if (deadLetter) {
      const deadLetterCount = queue.reported.queuedCount + queue.reported.activeCount + queue.reported.failedCount;
      reportedDeadLetterCount = (reportedDeadLetterCount ?? 0) + deadLetterCount;
      if (deadLetterCount > 0) reasons.push('dead_letter_jobs');
    } else if (queue.reported.failedCount > 0) {
      reasons.push('queue_failed_jobs');
    }
  }
  // A combined DLQ count is unavailable if any registered DLQ could not be read.
  if (queues.some(queue => (queue.name === RECURRENCE_DEAD_LETTER_QUEUE || queue.name === CUTOFF_DEAD_LETTER_QUEUE) && queue.state !== 'ready')) reportedDeadLetterCount = null;
  if (within(input.lastQueueErrorAt, now, input.recentWindowMs)) reasons.push('queue_errors_recent');
  if (within(input.jobs.lastFailureAt, now, input.recentWindowMs)) reasons.push('job_failures_recent');

  const relayHealth = input.relayHealth === 'unavailable' ? null : input.relayHealth;
  if (relayHealth === null) reasons.push('relay_unavailable');
  if (input.poller.consecutiveFailures > 0) reasons.push('relay_failing');
  if (relayHealth !== null && relayHealth.unsupportedSubscribedCount > 0) reasons.push('relay_unsupported_events');

  let cutoff: WorkerHealthReport['cutoff'];
  if (input.cutoff !== undefined) {
    const current = input.cutoff;
    const relay = current.relayHealth === 'unavailable' ? null : current.relayHealth;
    const at = current.poller.lastCompletedAt ?? input.runningSince;
    const cutoffAge = at === null ? null : Math.max(0, now - at);
    const cutoffStale = input.lifecycle === 'running' && (cutoffAge === null || cutoffAge > input.staleAfterMs);
    if (cutoffStale) reasons.push('cutoff_heartbeat_stale');
    if (relay === null) reasons.push('cutoff_relay_unavailable');
    if (current.poller.consecutiveFailures > 0) reasons.push('cutoff_relay_failing');
    if (relay !== null && relay.unsupportedSubscribedCount > 0) reasons.push('cutoff_relay_unsupported_events');
    if (current.discovery.consecutiveFailures > 0) reasons.push('cutoff_discovery_failing');
    const discoveryAt = current.discovery.lastCompletedAt ?? input.runningSince;
    if (input.lifecycle === 'running' && (discoveryAt === null || now - discoveryAt > input.staleAfterMs)) reasons.push('cutoff_discovery_stale');
    if (within(current.jobs.lastFailureAt, now, input.recentWindowMs)) reasons.push('job_failures_recent');
    cutoff = {
      heartbeat: { lastRelayCycleAt: at === null ? null : new Date(at).toISOString(), ageMs: cutoffAge, stale: cutoffStale },
      relay: {
        state: relay === null ? 'unavailable' : 'ok', pendingSubscribedCount: relay?.pendingSubscribedCount ?? null,
        oldestSubscribedAt: relay?.oldestSubscribedAt ?? null, oldestSubscribedAgeMs: relay?.oldestSubscribedAgeMs ?? null,
        unsupportedSubscribedCount: relay?.unsupportedSubscribedCount ?? null,
        consecutiveFailures: current.poller.consecutiveFailures, failedBatches: current.poller.failedBatches,
      },
      jobs: { outcomes: current.jobs.outcomes, rejected: current.jobs.rejected, failed: current.jobs.failed },
      discovery: current.discovery,
    };
  }

  const status = reasons.some((reason) => DOWN_REASONS.has(reason)) ? 'down' : reasons.length > 0 ? 'degraded' : 'ok';
  return {
    status,
    reasons: [...new Set(reasons)],
    ...(cutoff === undefined ? {} : { cutoff }),
    ...(input.concurrency === undefined ? {} : { concurrency: input.concurrency }),
    checkedAt: new Date(now).toISOString(),
    lifecycle: input.lifecycle,
    heartbeat: { lastRelayCycleAt: heartbeatAt === null ? null : new Date(heartbeatAt).toISOString(), ageMs, stale },
    queues,
    reportedDeadLetterCount,
    queueErrorsSinceStart: input.queueErrors,
    relay: {
      state: relayHealth === null ? 'unavailable' : 'ok',
      pendingSubscribedCount: relayHealth?.pendingSubscribedCount ?? null,
      oldestSubscribedAt: relayHealth?.oldestSubscribedAt ?? null,
      oldestSubscribedAgeMs: relayHealth?.oldestSubscribedAgeMs ?? null,
      unsupportedSubscribedCount: relayHealth?.unsupportedSubscribedCount ?? null,
      consecutiveFailures: input.poller.consecutiveFailures,
      failedBatches: input.poller.failedBatches,
    },
    jobs: { outcomes: input.jobs.outcomes, rejected: input.jobs.rejected, failed: input.jobs.failed },
  };
}
