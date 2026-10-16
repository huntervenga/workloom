import type {
 CreateMeetingInput,MeetingCreationDto,PlanningPeriodDto,FreezeScope,RecurrenceBindingProgressDto,RecurrenceBlockedCode,RecurrenceCalendarState,
 RecurrenceExceptionKind,RecurrenceMaterializationJob,RecurrenceMaterializationRequestedEvent,RecurrenceMaterializationRequestedPayload,
 RecurrenceResolutionDto,RecurrenceScheduleInput,RecurrenceSeriesState,RecurrenceSeriesVersionDto,RecurrenceSnapshotSectionDto,
 RecurrenceTimezoneProvenance,
} from '@workloom/contracts';
import type {Capability} from '../access/capabilities.js';
import type {CommandContext,CommandSource} from '../access/context.js';
import type {MeetingWriteScope} from '../meetings/ports.js';
import type {PlanningMutationIntent,PlanningRepository,PlanningTools,PlanningWriteScope} from '../planning/ports.js';
import type {OutboxEventInput} from '../transactions/ports.js';

/** P3b domain ports (docs/16-p3b-contract.md). Interfaces only: persistence, resolver, worker and relay
 * implementations belong to their lanes. Nothing here opens a transaction or a nested write runner.
 */

// ---- Durable records -------------------------------------------------------------------------

export interface RecurrenceSeriesRecord {
 readonly id:string;readonly workspaceId:string;readonly projectId:string;readonly revision:number;
 readonly state:RecurrenceSeriesState;readonly currentVersionId:string;
 readonly authorizationId:string|null;readonly authorizationRevision:number|null;
 readonly createdAt:string;readonly updatedAt:string;
}
/** Immutable "this and future" version; effective segments never overlap. */
export type RecurrenceSeriesVersionRecord=RecurrenceSeriesVersionDto;
/** Finite explicit period binding; a series/key is never rebound to another period, even after cancel. */
export interface RecurrencePeriodBindingRecord {
 readonly id:string;readonly workspaceId:string;readonly projectId:string;readonly seriesId:string;readonly periodId:string;
 readonly revision:number;readonly sourceManifestHash:string;readonly createdAt:string;
}
/** Real composition locators are all-or-none by type: either the whole locator or null. */
export interface RecurrenceEntityLocator {readonly meetingId:string;readonly taskId:string;readonly workPackageId:string}
/** Stable reserved header with natural key (workspaceId,seriesId,occurrenceKey) that outlives queue retention.
 * A never-materialized cancelled header is header-only calendar census and is NOT missing.
 */
export interface RecurrenceInstanceHeader {
 readonly id:string;readonly workspaceId:string;readonly projectId:string;readonly seriesId:string;
 readonly bindingId:string;readonly periodId:string;
 /** Original nominal local date; never the UTC start, a moved day or a version. */
 readonly occurrenceKey:string;
 /** after_count position; immutable original sequence. null for on_date series. */
 readonly nominalSequence:number|null;
 readonly sourceVersionId:string;readonly revision:number;readonly calendarState:RecurrenceCalendarState;
 readonly resolution:RecurrenceResolutionDto;readonly exceptionVersionId:string|null;
 readonly locator:RecurrenceEntityLocator|null;
 readonly createdAt:string;readonly updatedAt:string;
}
export interface RecurrenceExceptionVersionRecord {
 readonly id:string;readonly workspaceId:string;readonly instanceId:string;readonly revision:number;readonly kind:RecurrenceExceptionKind;
 /** Move overrides only; null for skip/restore/reset. */
 readonly localDate:string|null;readonly localTime:string|null;
 readonly reason:string;readonly actorUserId:string;readonly source:CommandSource;readonly recordedAt:string;readonly changeSeq:string;
}
/** Explicit persisted generation grant; the worker never trusts an actor from a payload. */
export interface RecurrenceGenerationAuthorizationRecord {
 readonly id:string;readonly workspaceId:string;readonly seriesId:string;readonly revision:number;
 readonly authorizerUserId:string;readonly authorizerMembershipId:string;
 readonly actorUserId:string;readonly source:CommandSource;readonly recordedAt:string;readonly changeSeq:string;
}
/** Calendar-only freeze lock: original schedule/roster provenance, no commitment/minutes/package baseline. */
export interface RecurrenceCalendarLock {
 readonly id:string;readonly workspaceId:string;readonly projectId:string;readonly baselineId:string;
 readonly kind:'recurrence_calendar';readonly instanceId:string;readonly meetingId:string|null;
}

/** Built by the server inside the current tx after revalidating the stored authorizer's membership/task.edit
 * and authorization revision under the same workspace barrier. Permits only approved occurrences; it never
 * replaces the triggering ctx actor/source, and audit records trigger and authorizer provenance separately.
 */
export interface ValidatedGenerationAuthority {
 readonly __workloomGenerationAuthority:'validated';
 readonly seriesId:string;readonly authorizationId:string;readonly authorizationRevision:number;
 readonly authorizerUserId:string;readonly authorizerMembershipId:string;readonly validatedAt:Date;
}

// ---- Source manifest -------------------------------------------------------------------------

/** Exactly the generation INPUTS hashed into sourceManifestHash. It excludes materialized entity/header IDs,
 * progress, header attach revisions, changed timestamps and the period revision changed by freeze, so it stays
 * stable across successful chunks. The full previewHash separately covers actor, current access and output state.
 */
export interface RecurrenceSourceManifestInput {
 readonly schemaVersion:1;readonly policyVersion:RecurrenceResolutionDto['policyVersion'];
 readonly workspaceId:string;readonly projectId:string;readonly seriesId:string;readonly bindingId:string;
 readonly period:{readonly periodId:string;readonly localStart:string;readonly localEndExclusive:string;readonly timezone:string};
 readonly versions:readonly {readonly versionId:string;readonly revision:number;readonly effectiveFromNominalDate:string}[];
 readonly exceptions:readonly {readonly occurrenceKey:string;readonly exceptionVersionId:string;readonly revision:number;readonly kind:RecurrenceExceptionKind}[];
 readonly authorization:{readonly authorizationId:string;readonly revision:number}|null;
}

// ---- Pure enumeration and resolution ---------------------------------------------------------

export interface RecurrenceScheduleSegment {
 readonly versionId:string;readonly effectiveFromNominalDate:string;readonly effectiveUntilExclusive:string|null;
 readonly schedule:RecurrenceScheduleInput;
}
export interface RecurrenceNominalCandidate {readonly occurrenceKey:string;readonly nominalSequence:number|null;readonly sourceVersionId:string}
/** Shared by preview, materialization and worker; calendar-date arithmetic, never UTC +24h. */
export interface RecurrenceOccurrenceResolver {
 readonly policyVersion:RecurrenceResolutionDto['policyVersion'];
 provenance(timezone:string):RecurrenceTimezoneProvenance;
 /** At most 366 candidates per series; after_count scans at most 3660 days, otherwise a 422, never truncation. */
 enumerateNominalCandidates(segments:readonly RecurrenceScheduleSegment[]):RecurrenceNominalCandidate[];
 resolveOccurrence(nominalDate:string,localTime:string,timezone:string,plannedDurationMinutes:number):RecurrenceResolutionDto;
}

// ---- Persistence ------------------------------------------------------------------------------

export interface RecurrenceRepository {
 readonly planning:PlanningRepository;
 /** Workspace-barrier serialized internal receipt; requestKey is a digest of the durable job request ID. */
 findJobReceipt(workspaceId:string,requestKey:string):Promise<{readonly payloadHash:string;readonly result:unknown}|null>;
 insertJobReceipt(workspaceId:string,actorUserId:string,requestKey:string,payloadHash:string,result:RecurrenceWorkerOutcome,createdAt:string):Promise<void>;
 listSeries(workspaceId:string,projectId:string):Promise<RecurrenceSeriesRecord[]>;
 findSeries(workspaceId:string,id:string):Promise<RecurrenceSeriesRecord|null>;
 saveSeries(row:RecurrenceSeriesRecord,exists:boolean):Promise<void>;
 listSeriesVersions(workspaceId:string,seriesId:string):Promise<RecurrenceSeriesVersionRecord[]>;
 insertSeriesVersion(row:RecurrenceSeriesVersionRecord,workspaceId:string):Promise<void>;
 findAuthorization(workspaceId:string,id:string):Promise<RecurrenceGenerationAuthorizationRecord|null>;
 insertAuthorization(row:RecurrenceGenerationAuthorizationRecord):Promise<void>;
 listBindings(workspaceId:string,seriesId:string):Promise<RecurrencePeriodBindingRecord[]>;
 /** Active and paused series alike: pause never removes mandatory census. */
 listBindingsForPeriod(workspaceId:string,periodId:string):Promise<RecurrencePeriodBindingRecord[]>;
 findBinding(workspaceId:string,id:string):Promise<RecurrencePeriodBindingRecord|null>;
 saveBinding(row:RecurrencePeriodBindingRecord,exists:boolean):Promise<void>;
 listInstanceHeaders(workspaceId:string,bindingId:string):Promise<RecurrenceInstanceHeader[]>;
 findInstanceHeader(workspaceId:string,seriesId:string,occurrenceKey:string):Promise<RecurrenceInstanceHeader|null>;
 /** Inserts reserved headers; an existing natural key keeps its stable ID and period. */
 reserveInstanceHeaders(rows:readonly RecurrenceInstanceHeader[]):Promise<void>;
 saveInstanceHeader(row:RecurrenceInstanceHeader):Promise<void>;
 /** Same-TX attachment of a freshly created real composition; fails if the header revision moved. */
 attachInstanceLocator(workspaceId:string,instanceId:string,expectedRevision:number,locator:RecurrenceEntityLocator):Promise<void>;
 listExceptionVersions(workspaceId:string,instanceId:string):Promise<RecurrenceExceptionVersionRecord[]>;
 insertExceptionVersion(row:RecurrenceExceptionVersionRecord):Promise<void>;
 listCalendarLocks(workspaceId:string,instanceId:string):Promise<RecurrenceCalendarLock[]>;
 insertCalendarLocks(rows:readonly RecurrenceCalendarLock[]):Promise<void>;
}
export interface RecurrenceWriteScope extends MeetingWriteScope {readonly recurrence:RecurrenceRepository}
export interface RecurrenceUnitOfWork {
 run<T>(ctx:CommandContext,cap:Capability,work:(scope:RecurrenceWriteScope)=>Promise<T>):Promise<T>;
 /** Repeatable read: no materialization, header reservation or entity-ID invention. */
 read<T>(ctx:CommandContext,cap:Capability,work:(repo:RecurrenceRepository)=>Promise<T>):Promise<T>;
}

// ---- Cursors and tools ------------------------------------------------------------------------

/** Signed materialization continuation; replaces any raw afterKey. */
export interface RecurrenceMaterializationCursor {
 readonly version:1;readonly workspaceId:string;readonly actorUserId:string;readonly permissionEpoch:string;
 readonly periodId:string;readonly manifestHash:string;
 readonly afterSeriesId:string|null;readonly afterOccurrenceKey:string|null;
}
export interface RecurrenceTools extends PlanningTools {
 readonly resolver:RecurrenceOccurrenceResolver;
 encodeMaterializationCursor(value:RecurrenceMaterializationCursor):string;
 decodeMaterializationCursor(token:string):RecurrenceMaterializationCursor;
}

// ---- Intents, footprint and prerequisite policy -----------------------------------------------

export type RecurrenceMutationCommand='recurrence.series.create'|'recurrence.series.edit'|'recurrence.series.state'|'recurrence.periods.add'|'recurrence.generation.authorize'|'recurrence.exception.set'|'recurrence.period.materialize';
export interface RecurrenceMutationIntent {readonly family:'recurrence';readonly command:RecurrenceMutationCommand;readonly target:unknown;readonly input:unknown}
/** Follow-up: PlanningMutationIntent (planning lane) must add the recurrence family; until then guards take this union. */
export type RecurrenceGuardIntent=PlanningMutationIntent|RecurrenceMutationIntent;
/** Exact source projects of an intent. An unknown footprint is never guessed: the resolver throws instead. */
export type RecurrenceAffectedFootprint={readonly kind:'none'}|{readonly kind:'projects';readonly projectIds:readonly string[]};
/** full_due_freeze: ordinary writes, fail closed on incomplete affected census.
 * materialize_period_recovery: bypasses ALL full due-freeze loops, validates current actor and stored authorities,
 * creates only approved target-period census entities; the final complete chunk freezes only that overdue period.
 * generation_reauthorization: narrow metadata replacement exempt from the revoked-old-grant prerequisite.
 */
export type RecurrencePrerequisiteMode='full_due_freeze'|'materialize_period_recovery'|'generation_reauthorization';
export const RECURRENCE_PREREQUISITE_BY_COMMAND={
 'recurrence.series.create':'full_due_freeze','recurrence.series.edit':'full_due_freeze','recurrence.series.state':'full_due_freeze',
 'recurrence.periods.add':'full_due_freeze','recurrence.exception.set':'full_due_freeze',
 'recurrence.generation.authorize':'generation_reauthorization','recurrence.period.materialize':'materialize_period_recovery',
} as const satisfies Record<RecurrenceMutationCommand,RecurrencePrerequisiteMode>;
/** Commands that write exactly one recurrence.materialization_requested row per affected binding
 * (series.state only on resume; pause requests nothing). */
export const RECURRENCE_REQUESTING_COMMANDS=['recurrence.series.create','recurrence.series.edit','recurrence.periods.add','recurrence.generation.authorize','recurrence.series.state'] as const satisfies readonly RecurrenceMutationCommand[];

// ---- Mandatory same-TX materializer -----------------------------------------------------------

export type RecurrenceEnsureReason='freeze'|'explicit'|'worker';
export interface RecurrenceEnsureOptions {
 /** Counts REAL compositions only (1..100); reservation headers do not count. */
 readonly maxCreates:number;readonly reason:RecurrenceEnsureReason;
 readonly cursor:RecurrenceMaterializationCursor|null;
 /** Worker scope: one binding. Explicit/freeze: every binding of the period. */
 readonly bindingId:string|null;
}
export interface RecurrenceCensusAssessment {
 readonly periodId:string;readonly status:'complete'|'pending'|'blocked';
 /** Counted by pure enumeration/resolution before any proposed insert. */
 readonly missingCount:number;readonly bindings:readonly RecurrenceBindingProgressDto[];
}
export interface RecurrenceEnsureOutcome extends RecurrenceCensusAssessment {
 readonly createdCount:number;readonly remainingCount:number;readonly nextCursor:RecurrenceMaterializationCursor|null;
}
/** Bound by the real DB composition to the SAME tx and scope.recordChange; no optional no-op production bypass,
 * no new transaction when entered from performFreeze, no nested public write runner.
 */
export interface RecurrenceScopedMaterializer {
 resolveAffectedProjects(intent:RecurrenceGuardIntent):Promise<RecurrenceAffectedFootprint>;
 assessPeriod(period:PlanningPeriodDto):Promise<RecurrenceCensusAssessment>;
 ensurePeriod(period:PlanningPeriodDto,options:RecurrenceEnsureOptions):Promise<RecurrenceEnsureOutcome>;
 /** Ordinary writes: throws controlled MATERIALIZATION_REQUIRED when an affected census is incomplete or blocked. */
 requireCompleteCensus(footprint:RecurrenceAffectedFootprint):Promise<void>;
 /** performFreeze calls this only after a complete census; undefined when the period has no bindings (old JSON unchanged). */
 captureSnapshotSection(period:PlanningPeriodDto,kind:FreezeScope,memberId:string|null):Promise<RecurrenceSnapshotSectionDto|undefined>;
 calendarLocksFor(section:RecurrenceSnapshotSectionDto,baselineId:string,projectId:string):RecurrenceCalendarLock[];
 insertCalendarLocks(rows:readonly RecurrenceCalendarLock[]):Promise<void>;
}
/** Every real task/field/planning/category/meeting/recurrence composition scope must carry this. */
export interface RecurrenceCensusScope extends PlanningWriteScope {readonly recurrenceCensus:RecurrenceScopedMaterializer}

// ---- Occurrence composition -------------------------------------------------------------------

export interface MeetingOccurrenceIdentity {readonly seriesId:string;readonly instanceId:string;readonly occurrenceKey:string;readonly nominalSequence:number|null}
/** Ordinary single-create internal helper on an ALREADY OPEN scope: identity optional only here. It never calls
 * public createMeeting, writer.run, runWorkspaceWrite or the planning guard again.
 */
export type CreateSingleMeetingInScope=(scope:MeetingWriteScope,input:CreateMeetingInput,tools:Pick<PlanningTools,'newId'>,identity?:MeetingOccurrenceIdentity)=>Promise<MeetingCreationDto>;
/** Recurrence wrapper: identity REQUIRED (from the reserved header) and header attachment in the same TX. */
export interface RecurrenceOccurrenceComposer {
 createOccurrenceInScope(scope:RecurrenceWriteScope,header:RecurrenceInstanceHeader,authority:ValidatedGenerationAuthority,input:CreateMeetingInput):Promise<{readonly header:RecurrenceInstanceHeader;readonly creation:MeetingCreationDto}>;
}
export interface RecurrenceApplicationDependencies {readonly writer:RecurrenceUnitOfWork;readonly tools:RecurrenceTools;readonly composer:RecurrenceOccurrenceComposer}

// ---- Outbox continuation, worker facade and relay ---------------------------------------------

/** The only subscribed outbox row; pending chunks request continuation in the SAME UOW with the stable hash. */
export interface RecurrenceMaterializationOutboxInput extends OutboxEventInput {
 readonly type:RecurrenceMaterializationRequestedEvent['type'];readonly schemaVersion:1;
 readonly payload:RecurrenceMaterializationRequestedPayload;
}
export type RecurrenceWorkerStatus='complete'|'pending'|'stale'|'blocked'|'paused';
/** paused is a controlled outcome with no hot retry; stale durably requests current inputs under the job outcome. */
export interface RecurrenceWorkerOutcome {
 readonly status:RecurrenceWorkerStatus;readonly bindingId:string;readonly periodId:string;
 readonly createdCount:number;readonly remainingCount:number;readonly blockedCode:RecurrenceBlockedCode|null;
}
export type RecurrenceAuthorityCheck={readonly kind:'valid';readonly authority:ValidatedGenerationAuthority}|{readonly kind:'blocked';readonly code:RecurrenceBlockedCode};
/** ctx.source is 'job' with a server requestId; the stored authorizer is resolved and revalidated under the
 * single workspace barrier. Trigger and authorizer provenance remain separate.
 */
export interface RecurrenceJobWriteScope extends RecurrenceWriteScope, RecurrenceCensusScope {readonly authorization:RecurrenceAuthorityCheck}
export interface RecurrenceJobUnitOfWork {run<T>(job:RecurrenceMaterializationJob,work:(scope:RecurrenceJobWriteScope)=>Promise<T>):Promise<T>}
export interface RecurrenceWorkerFacade {materializeBinding(job:RecurrenceMaterializationJob):Promise<RecurrenceWorkerOutcome>}
export interface RecurrenceWorkerDependencies {readonly writer:RecurrenceJobUnitOfWork;readonly tools:RecurrenceTools;readonly composer:RecurrenceOccurrenceComposer}
export type CreateRecurrenceWorkerFacade=(deps:RecurrenceWorkerDependencies)=>RecurrenceWorkerFacade;

/** Domain-neutral relay contract; @workloom/db later binds Tx to WorkloomExecutor (pg-boss adapter, same relay TX). */
export type RecurrenceRelayEnqueue<Tx>=(tx:Tx,event:RecurrenceMaterializationRequestedEvent)=>Promise<{readonly accepted:true;readonly jobId:string|null}>;
export interface RecurrenceRelayBatchResult {readonly selectedCount:number;readonly enqueuedCount:number;readonly unsupportedRetainedCount:number}
/** Counts only the exact subscribed type; unsupported versions stay retained/blocked while valid v1 continues. */
export interface RecurrenceRelayHealth {
 readonly pendingSubscribedCount:number;readonly oldestSubscribedAt:string|null;readonly oldestSubscribedAgeMs:number|null;
 readonly unsupportedSubscribedCount:number;
}
export interface RecurrenceOutboxRelay<Tx> {
 relayBatch(enqueue:RecurrenceRelayEnqueue<Tx>,limit?:number):Promise<RecurrenceRelayBatchResult>;
 getHealth():Promise<RecurrenceRelayHealth>;
}
