import type { CutoffGrantDto, CutoffRequestedEvent, CutoffJob, CutoffWorkerOutcome, PlanningPeriodDto } from '@workloom/contracts';
import type { AccessRepository } from '../access/ports.js';
import type { CommandContext, CommandSource } from '../access/context.js';
import type { IdempotencyRecord } from '../tasks/ports.js';
import type { PlanningRepository, PlanningTools } from '../planning/ports.js';
import type { RecurrenceCensusAssessment, RecurrenceRelayBatchResult, RecurrenceRelayHealth, RecurrenceRepository, RecurrenceWriteScope } from '../recurrence/ports.js';
export interface CutoffGrantRecord extends CutoffGrantDto {
  readonly actorUserId: string; readonly actorMembershipId: string; readonly source: CommandSource; readonly changeSeq: string;
}
export interface CutoffRequestRecord {
  readonly job: CutoffJob; readonly payloadHash: string; readonly reason: string;
  readonly createdAt: string; readonly requestedByUserId: string; readonly source: CommandSource; readonly changeSeq: string;
  readonly supersededAt: string | null; readonly processedAt: string | null; readonly result: CutoffWorkerOutcome | null;
}
export interface CutoffRepository {
  readonly access: AccessRepository; readonly planning: PlanningRepository; readonly recurrence: RecurrenceRepository;
  currentGrant(workspaceId: string, periodId: string): Promise<CutoffGrantRecord | null>;
  saveGrant(grant: CutoffGrantRecord, previousRevision: number): Promise<void>;
  request(workspaceId: string, requestId: string): Promise<CutoffRequestRecord | null>;
  latestRequest(workspaceId: string, periodId: string, grant?: { id: string; revision: number }): Promise<CutoffRequestRecord | null>;
  latestCompletedRequest(workspaceId: string, periodId: string, grant: { id: string; revision: number }): Promise<CutoffRequestRecord | null>;
  liveRequest(workspaceId: string, periodId: string): Promise<CutoffRequestRecord | null>;
  supersedeLive(workspaceId: string, periodId: string, at: string): Promise<void>;
  insertRequest(record: CutoffRequestRecord): Promise<void>;
  completeRequest(workspaceId: string, requestId: string, payloadHash: string, outcome: CutoffWorkerOutcome, userId: string, membershipId: string): Promise<void>;
  baselineHeader(workspaceId: string, baselineId: string): Promise<{ id: string; frozenAt: string; requestedCutoffAt: string } | null>;
  findIdempotency(workspaceId: string, userId: string, command: string, key: string): Promise<IdempotencyRecord | null>;
  insertIdempotency(record: IdempotencyRecord): Promise<void>;
}
export type CutoffRequestReason = 'enabled' | 'replaced' | 'retry' | 'period_changed' | 'recurrence_changed' | 'generation_authorized' | 'series_resumed' | 'discovery' | 'continuation' | 'stale_job' | 'early_job';
export interface CutoffRequestSink { requestPeriod(period: PlanningPeriodDto, reason: CutoffRequestReason, force?: boolean): Promise<string | null> }
export interface CutoffWriteScope extends RecurrenceWriteScope { readonly cutoff: CutoffRepository }
export interface CutoffReadScope { readonly repository: CutoffRepository; readonly serverAt: Date }
export interface CutoffUnitOfWork {
  read<T>(context: CommandContext, work: (scope: CutoffReadScope) => Promise<T>): Promise<T>;
  run<T>(context: CommandContext, work: (scope: CutoffWriteScope) => Promise<T>): Promise<T>;
}
export interface CutoffJobUnitOfWork { run<T>(job: CutoffJob, work: (scope: CutoffWriteScope) => Promise<T>): Promise<T> }
export type CutoffTools = Pick<PlanningTools, 'newId' | 'digest'>;
export interface CutoffSources { readonly assessment: RecurrenceCensusAssessment; readonly sourceManifestHash: string }
export interface CutoffDiscoveryTarget { readonly workspaceId: string; readonly projectId: string; readonly periodId: string; readonly cutoffAt: string }
export interface CutoffDiscoveryBatchResult { readonly selectedCount: number; readonly requestedCount: number; readonly blockedCount: number; readonly cycleComplete: boolean; readonly leased: boolean }
export interface CutoffDiscovery { discoverBatch(limit?: number): Promise<CutoffDiscoveryBatchResult> }

/** Exact event subscription; the adapter enqueues and marks dispatch on the same open transaction. */
export type CutoffRelayEnqueue<Tx> = (tx: Tx, event: CutoffRequestedEvent) => Promise<{ readonly accepted: true; readonly jobId: string | null }>;
export interface CutoffOutboxRelay<Tx> {
  relayBatch(enqueue: CutoffRelayEnqueue<Tx>, limit?: number): Promise<RecurrenceRelayBatchResult>;
  getHealth(): Promise<RecurrenceRelayHealth>;
}
