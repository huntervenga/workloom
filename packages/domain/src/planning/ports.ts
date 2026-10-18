import type {TaskProjectPlacementCommand} from '../tasks/project-placement-ports.js';
import type { CutoffRequestSink } from '../cutoff/ports.js';
import type {DependencyMutationCommand,TaskStatusTransitionPolicy} from '../dependencies/ports.js';
import type {MeetingMutationCommand} from '../meetings/ports.js';
import type { WorkCategoryResolver, WorkCategoryMutationCommand } from '../categories/ports.js';
import type {
  TaskFieldData, BulkUpdateTasksInput,CreateTaskRowInput,FreezeScope,RecurrenceSnapshotSectionDto,MeetingDto,AttendanceDto,RecordedWorkLogDto, ManualPeriodWorkLogDto, MembershipDto, PackageBaselineDto, PeriodCommitmentDto, PlanBaselineDto,
  PlanningPackageDto, PlanningPeriodDto, TaskDto, TaskFieldDefinitionDto, TaskFieldValueDto,
  WeeklyPlanFactReportRunDto, WeeklyPlanFactRowDto,
} from '@workloom/contracts';
import type { Capability } from '../access/capabilities.js';
import type { CommandContext } from '../access/context.js';
import type { TaskFieldRepository } from '../fields/ports.js';
import type { TaskRepository } from '../tasks/ports.js';
import type { WorkspaceWriteScope } from '../transactions/ports.js';
import type { RecurrenceMutationCommand } from '../recurrence/ports.js';
import type { RecurrenceScopedMaterializer } from '../recurrence/ports.js';

export interface ProjectPlanningSources {
  readonly packages: PlanningPackageDto[];
  readonly tasks: TaskDto[];
  readonly memberships: MembershipDto[];
  readonly activeMembershipIds: string[];
  readonly fields: TaskFieldDefinitionDto[];
  readonly values: TaskFieldValueDto[];
}
export interface PackageFreezeObservation {
  readonly workspaceId:string; readonly projectId:string; readonly workPackageId:string;
  readonly estimateMinutes:number|null; readonly packageRevision:number; readonly baselineId:string;
}
/** Read-only first-freeze provenance: the immutable observation, its immutable plan-baseline header
 * (never the full snapshot) and the matching original package baseline when the estimate was known. */
export interface OriginalPackageEstimateSource {
  readonly observation:PackageFreezeObservation;
  readonly origin:{readonly planBaselineId:string;readonly periodId:string;readonly periodLocalStart:string;readonly scope:FreezeScope;readonly mode:'manual'|'cutoff';readonly frozenAt:string};
  readonly packageBaseline:PackageBaselineDto|null;
}
export interface PlanningLock {
  readonly id:string; readonly workspaceId:string; readonly projectId:string; readonly baselineId:string;
  readonly kind:'estimate'|'custom_value'|'commitment';
  readonly workPackageId:string|null; readonly taskId:string|null; readonly fieldId:string|null; readonly commitmentId:string|null;
}
export interface PlanningRepository {
  readonly tasks: TaskRepository;
  currentChangeSeq(workspaceId:string):Promise<string>;
  readonly fields: TaskFieldRepository;
  /** One consistent project read; implementations must not hide a row/page limit. */
  captureProject(workspaceId:string,projectId:string):Promise<ProjectPlanningSources>;
  /** Read-only full census: incomplete registered sources reject without reserving or materializing. */
  captureRecurrenceSnapshot(period:PlanningPeriodDto,kind:FreezeScope,memberId:string|null):Promise<RecurrenceSnapshotSectionDto|undefined>;
  listPeriods(workspaceId:string,projectId?:string):Promise<PlanningPeriodDto[]>;
  findPeriod(workspaceId:string,id:string):Promise<PlanningPeriodDto|null>;
  insertPeriod(row:PlanningPeriodDto):Promise<void>;
  savePeriod(row:PlanningPeriodDto):Promise<void>;
  listCommitments(workspaceId:string,periodId:string):Promise<PeriodCommitmentDto[]>;
  findCommitment(workspaceId:string,id:string):Promise<PeriodCommitmentDto|null>;
  saveCommitment(row:PeriodCommitmentDto):Promise<void>;
  insertCommitmentRevision(row:PeriodCommitmentDto,actorUserId:string,changeSeq:bigint,revisionId:string):Promise<void>;
  listBaselines(workspaceId:string,periodId:string):Promise<PlanBaselineDto[]>;
  findBaseline(workspaceId:string,id:string):Promise<PlanBaselineDto|null>;
  insertBaseline(row:PlanBaselineDto):Promise<void>;
  findPackageBaseline(workspaceId:string,id:string):Promise<PackageBaselineDto|null>;
  findPackageBaselineForPackage(workspaceId:string,packageId:string):Promise<PackageBaselineDto|null>;
  insertPackageBaseline(row:PackageBaselineDto):Promise<void>;
  findPackageObservation(workspaceId:string,packageId:string):Promise<PackageFreezeObservation|null>;
  insertPackageObservation(row:PackageFreezeObservation):Promise<void>;
  /** One bounded read for one package; null when no related freeze has observed it. */
  findOriginalPackageEstimateSource(workspaceId:string,packageId:string):Promise<OriginalPackageEstimateSource|null>;
  listLocks(workspaceId:string,filter?:{readonly taskIds:readonly string[];readonly workPackageIds:readonly string[]}):Promise<PlanningLock[]>;
  insertLocks(rows:PlanningLock[]):Promise<void>;
  listMeetings(workspaceId:string,projectId:string):Promise<MeetingDto[]>;
  findMeetingByTask(workspaceId:string,taskId:string):Promise<MeetingDto|null>;
  listAttendance(workspaceId:string,meetingId:string):Promise<AttendanceDto[]>;
  listMeetingLocks(workspaceId:string,meetingId:string):Promise<{baselineId:string}[]>;
  insertMeetingLock(workspaceId:string,meetingId:string,baselineId:string,id:string):Promise<void>;
  listRecordedWork(workspaceId:string,periodId:string):Promise<RecordedWorkLogDto[]>;
  saveRecordedWork(row:RecordedWorkLogDto):Promise<void>;
  listWorkLogs(workspaceId:string,periodId:string):Promise<ManualPeriodWorkLogDto[]>;
  findManualWork(workspaceId:string,taskId:string,periodId:string,memberId:string):Promise<ManualPeriodWorkLogDto|null>;
  saveManualWork(row:ManualPeriodWorkLogDto):Promise<void>;
  insertWorkRevision(row:RecordedWorkLogDto):Promise<void>;
  listReportRuns(workspaceId:string,periodId:string):Promise<WeeklyPlanFactReportRunDto[]>;
  findReportRun(workspaceId:string,id:string):Promise<{run:WeeklyPlanFactReportRunDto;rows:WeeklyPlanFactRowDto[]}|null>;
  insertReportRun(run:WeeklyPlanFactReportRunDto,rows:WeeklyPlanFactRowDto[]):Promise<void>;
}
export interface PlanningWriteScope extends WorkspaceWriteScope {
  readonly statusTransitions:TaskStatusTransitionPolicy;
  readonly repository:PlanningRepository;
  /** P3b mandatory same-TX census bound by every real composition (no optional no-op production bypass).
   * The shared guard resolves the affected footprint through it and performFreeze ensures/captures census with it. */
  readonly recurrenceCensus:RecurrenceScopedMaterializer;
}
/** The time-writing application must always resolve first-source categories under its TX. */
export interface PlanningApplicationWriteScope extends PlanningWriteScope {readonly categoryResolver:WorkCategoryResolver; readonly cutoffRequests:CutoffRequestSink}
export interface PlanningUnitOfWork {
  run<T>(ctx:CommandContext,capability:Capability,work:(scope:PlanningApplicationWriteScope)=>Promise<T>):Promise<T>;
  /** Repeatable-read snapshot for preview/read projections. No mutation or automatic freeze. */
  read<T>(ctx:CommandContext,capability:Capability,work:(repository:PlanningRepository)=>Promise<T>):Promise<T>;
}
export interface PlanningCursor {
  readonly version:1;readonly workspaceId:string;readonly actorUserId:string;readonly permissionEpoch:string;
  readonly queryHash:string;readonly afterId:string;
}
export interface PlanningTools {
  newId():string;digest(value:string):string;
  encodeCursor(value:PlanningCursor):string;decodeCursor(token:string):PlanningCursor;
}
export interface PlanningApplicationDependencies {
  readonly reader:PlanningRepository;readonly writer:PlanningUnitOfWork;readonly tools:PlanningTools;
}

/** Commands are exhaustive: adding a mutation requires an explicit policy decision. */
export type TaskMutationCommand = 'project.create'|'project.update'|'section.create'|'section.update'|'tag.create'|'tag.update'|'task.create'|'task.update'|'task.archive'|'task.restore'|'task.move';
export type FieldMutationCommand = 'field.create'|'field.update'|'field.option.create'|'field.option.update'|'field.columns.update'|'field.value.set'|'field.policy.set'|'field.value.exception';
export type PlanningMutationCommand = 'period.create'|'period.update'|'commitment.create'|'commitment.update'|'plan.freeze'|'work.set'|'report.create';
export type PlanningMutationIntent =
 | {readonly family:'task_placement';readonly command:TaskProjectPlacementCommand;readonly target:{readonly taskId:string;readonly projectId:string};readonly input:unknown}
 | {readonly family:'cutoff';readonly command:'cutoff.configure'|'cutoff.retry';readonly target:{readonly periodId:string};readonly input:unknown}
 | {readonly family:'table_preference';readonly command:'table.preference.set';readonly target:{readonly projectId:string};readonly input:unknown}
 | {readonly family:'comment';readonly command:'task.comment.create';readonly target:{readonly taskId:string};readonly input:unknown}
 | {readonly family:'import';readonly command:'import.csv.stage';readonly target:{readonly projectId:string};readonly input:unknown}
 | {readonly family:'import';readonly command:'import.project.apply';readonly target:{readonly projectId:string};readonly input:unknown;readonly previewMatches:()=>Promise<boolean>;readonly fieldPolicyCandidates:readonly {readonly fieldId:string;readonly value:TaskFieldData}[]}
 | {readonly family:'schedule';readonly command:'task.schedule.apply';readonly target:{readonly projectId:string;readonly affectedProjectIds:readonly string[]};readonly input:unknown;readonly previewMatches:()=>Promise<boolean>}
 | {readonly family:'task';readonly command:TaskMutationCommand;readonly target:string|null;readonly input:unknown}
 /** Atomic table row: its own typed aggregate, never folded into the task commands or their preview hashes. */
 | {readonly family:'task_bulk';readonly command:'task.bulk.update';readonly target:{readonly projectId:string};readonly input:BulkUpdateTasksInput}
 | {readonly family:'task_row';readonly command:'task.row.create';readonly target:{readonly projectId:string};readonly input:CreateTaskRowInput}
 | {readonly family:'field';readonly command:FieldMutationCommand;readonly target:unknown;readonly input:unknown}
 | {readonly family:'planning';readonly command:PlanningMutationCommand;readonly target:unknown;readonly input:unknown}
 | {readonly family:'meeting';readonly command:MeetingMutationCommand;readonly target:unknown;readonly input:unknown}
 | {readonly family:'category';readonly command:WorkCategoryMutationCommand;readonly target:unknown;readonly input:unknown}
 | {readonly family:'dependency';readonly command:DependencyMutationCommand;readonly target:unknown;readonly input:unknown}
 | {readonly family:'recurrence';readonly command:RecurrenceMutationCommand;readonly target:unknown;readonly input:unknown};
export interface CommittedPlanningRejection {
  readonly __workloomPlanningOutcome:'rejected';readonly code:'FIELD_LOCKED'|'PREVIEW_STALE';
  readonly details:{readonly committed:true;readonly baselineIds:string[];readonly policyReason?:'deadline'|'change_limit'};
}
export interface PlanningMutationGuard {
  /** Ensure due freezes, then classify every protected target BEFORE the proposed handler. */
  check(intent:PlanningMutationIntent):Promise<CommittedPlanningRejection|null>;
}
