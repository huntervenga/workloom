export {
  DOMAIN_ERROR_CODES,
  DomainError,
  NOT_FOUND_MESSAGE,
  capabilityRequiredError,
  isDomainError,
  notFoundError,
  temporarilyUnavailableError,
  unauthenticatedError,
  type DomainErrorCode,
  type DomainErrorOptions,
} from './errors.js';
export {
  CAPABILITIES,
  CAPABILITY_STAGE,
  WORKSPACE_ROLES,
  capabilitiesForRole,
  isWorkspaceRole,
  roleHasCapability,
  type Capability,
  type WorkspaceRole,
} from './access/capabilities.js';
export {
  COMMAND_SOURCES,
  toCommandContext,
  type Actor,
  type ActorContext,
  type ActorKind,
  type CommandContext,
  type CommandSource,
} from './access/context.js';
export type {
  AccessRepository,
  MembershipRecord,
  MembershipState,
  UserRecord,
  WorkspaceAccessRecord,
  WorkspaceRecord,
} from './access/ports.js';
export {
  authorizeLoadedAccess,
  authorizeWorkspace,
  getCurrentActor,
  getWorkspaceForActor,
  listWorkspaceMembers,
  listWorkspacesForActor,
  type WorkspaceScope,
  type WorkspaceView,
} from './access/access-queries.js';
export type { TaskFieldApplication, TaskFieldHistoryPage } from './fields/application.js';
export type {
  TaskFieldApplicationDependencies,
  TaskFieldHistoryAnchor,
  TaskFieldHistoryCursorPayload,
  TaskFieldOptionRecord,
  TaskFieldRepository,
  TaskFieldTools,
  TaskFieldUnitOfWork,
  TaskFieldWriteScope,
} from './fields/ports.js';
export { createTaskFieldApplication } from './fields/service.js';
export type { TaskApplication, TaskPage } from './tasks/application.js';
export { createTaskApplication } from './tasks/service.js';
export type {
  IdempotencyRecord,
  TaskApplicationDependencies,
  TaskCursorAnchor,
  TaskCursorPayload,
  TaskRepository,
  TaskTools,
  TaskUnitOfWork,
  TaskWriteScope,
  WorkPackageRecord,
} from './tasks/ports.js';
export type {
  ChangeEventInput,
  OutboxEventInput,
  RecordedChange,
  WorkspaceWriteRunner,
  WorkspaceWriteScope,
} from './transactions/ports.js';
export type { PlanningApplication, PlanningPage } from './planning/application.js';
export type { ProjectPlanningSources, PackageFreezeObservation, PlanningLock, PlanningRepository, PlanningWriteScope, PlanningUnitOfWork, PlanningCursor, PlanningTools, PlanningApplicationDependencies, TaskMutationCommand, FieldMutationCommand, PlanningMutationCommand, PlanningMutationIntent, CommittedPlanningRejection, PlanningMutationGuard } from './planning/ports.js';
export { captureFreezeSnapshot, freezePreviewHash, performFreeze, createPlanningMutationGuard, isCommittedPlanningRejection, unwrapPlanningOutcome, materializationRequiredError } from './planning/freeze.js';
export { createPlanningApplication } from './planning/service.js';
export type { WorkCategoryApplication } from './categories/application.js';
export type { WorkCategoryRepository, WorkCategoryBindingRecord, WorkCategoryBindingVersion, WorkCategoryWriteScope, WorkCategoryUnitOfWork, WorkCategoryApplicationDependencies, WorkCategoryResolver, WorkCategoryMutationCommand } from './categories/ports.js';
export { legacyWorkCategory, canonicalWorkCategory, readWorkCategoryBinding, createWorkCategoryResolver } from './categories/resolver.js';
export type { PlanningApplicationWriteScope } from './planning/ports.js';
export { createWorkCategoryApplication, workTypeBuckets } from './categories/service.js';

export * from './meetings/application.js';
export * from './meetings/ports.js';
export {createMeetingApplication,createSingleMeetingInScope,updateSingleMeetingInScope,meetingLocalDate,requireMeetingPeriod} from './meetings/service.js';

export * from './recurrence/application.js';
export * from './recurrence/ports.js';
export {createRecurrenceApplication,recurrenceProtectedReasons} from './recurrence/service.js';
export {createRecurrenceWorkerFacade} from './recurrence/worker.js';
export {createRecurrenceOccurrenceComposer,occurrenceMeetingInput,reviseOccurrenceMeetingInScope,type OccurrenceMeetingTarget} from './recurrence/composer.js';
export {resolveRecurrenceAffectedProjects,type RecurrenceFootprintScope} from './recurrence/footprint.js';
export {
  createRecurrenceScopedMaterializer,evaluatePeriodCensus,validateGenerationAuthority,bindingManifestInput,bindingSourceManifestHash,periodManifestHash,
  requestMaterialization,planCandidates,scheduleSegments,owningPeriods,resolutionInPeriod,desiredOccurrence,assessmentOf,progressOf,snapshotSectionOf,
  type RecurrenceFreezeCensus,type EvaluatedBinding,type BindingCensus,type PlannedCandidate,type DesiredOccurrence,type RecurrenceSeriesContext,type RecurrenceRequestReason,
} from './recurrence/materializer.js';

export {createRecurrenceOccurrenceResolver,buildRecurrenceScheduleSegments,RECURRENCE_RESOLVER_IMPLEMENTATION} from './recurrence/schedule.js';

export * from './dependencies/application.js';
export * from './dependencies/ports.js';
export {createDependencyApplication} from './dependencies/service.js';
export {createTaskStatusTransitionPolicy} from './dependencies/status-policy.js';

export type {TaskScheduleApplication} from './schedule/application.js';

export * from './schedule/ports.js';
export {createTaskScheduleApplication} from './schedule/service.js';
export {assertTaskDateRange,assertOrdinaryTaskDates} from './tasks/dates.js';

export type {ProjectImportApplication} from './imports/application.js';

export {createTaskInScope} from './tasks/service.js';
export {setTaskFieldValueInScope} from './fields/service.js';

export * from './imports/ports.js';
export {createProjectImportApplication} from './imports/service.js';
export type {LocalCredentialApplication,LocalMcpApplication} from './local-mcp/application.js';
export {LOCAL_MCP_TOOL_SCOPE,LOCAL_MCP_SCOPE_CAPABILITY,allowedLocalMcpScopes,assertLocalCredentialCurrent,assertLocalMcpScope} from './local-mcp/policy.js';

export {createLocalCredentialService,type StoredLocalCredential,type LocalCredentialRepository,type LocalCredentialScope,type LocalCredentialReader} from './local-mcp/service.js';
