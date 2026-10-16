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
export { captureFreezeSnapshot, freezePreviewHash, performFreeze, createPlanningMutationGuard, isCommittedPlanningRejection, unwrapPlanningOutcome } from './planning/freeze.js';
export { createPlanningApplication } from './planning/service.js';
