import type { TaskFieldRepository } from '../fields/ports.js';
import type {TaskStatusTransitionPolicy} from '../dependencies/ports.js';
import type { PlanningMutationGuard } from '../planning/ports.js';
import type {
  ProjectDto,
  SectionDto,
  TagDto,
  TaskDefaultsDto,
  ProjectRulesDto,
  TaskDto,
  TaskListQuery,
  TaskParticipantDto,
  TaskStatusDto,
} from '@workloom/contracts';

import type { Capability } from '../access/capabilities.js';
import type { CommandContext } from '../access/context.js';
import type { AccessRepository } from '../access/ports.js';
import type { WorkspaceWriteScope } from '../transactions/ports.js';

/** Stable keyset anchors; due dates are ordered ascending with nulls last. */
export type TaskCursorAnchor =
  | { readonly position: number; readonly id: string }
  | { readonly dueDate: string | null; readonly id: string };

/** Current authorization and the complete normalized query bind every page. */
interface TaskCursorBinding {
  readonly workspaceId: string;
  readonly actorUserId: string;
  readonly permissionEpoch: string;
  readonly queryHash: string;
}

/** Version 1 remains byte-compatible; version 2 is exclusively due-date ordering. */
export type TaskCursorPayload = TaskCursorBinding & (
  | { readonly version: 1; readonly position: number; readonly id: string }
  | { readonly version: 2; readonly dueDate: string | null; readonly id: string }
);

export interface WorkPackageRecord {
  readonly id: string;
  readonly workspaceId: string;
  readonly projectId: string;
  readonly origin: 'new_task' | 'added_scope';
  readonly sourcePackageId: string | null;
  readonly estimateMinutes: number | null;
  readonly revision: number;
  /** UTC ISO-8601 timestamp. */
  readonly createdAt: string;
  /** UTC ISO-8601 timestamp. */
  readonly updatedAt: string;
}

export interface IdempotencyRecord {
  readonly workspaceId: string;
  readonly actorUserId: string;
  readonly command: string;
  readonly idempotencyKey: string;
  readonly payloadHash: string;
  readonly result: unknown;
  /** UTC ISO-8601 timestamp. */
  readonly createdAt: string;
}

/**
 * Persistence port for P1a projects, sections, statuses, tags and tasks. Persistence only:
 * every query and write is scoped by `workspaceId`, and callers have already validated
 * capabilities and all same-workspace domain rules. Implementations must not add business
 * rules, defaults or hidden limits.
 */
export interface TaskRepository {
  readonly access: AccessRepository;

  /** Starting values for new tasks of a project; absent means none are configured. Optional so partial fakes stay valid. */
  findTaskDefaults?(workspaceId: string, projectId: string): Promise<TaskDefaultsDto | null>;
  /** The project's rules; null (or an absent method) means every rule is off. */
  findProjectRules?(workspaceId: string, projectId: string): Promise<ProjectRulesDto | null>;

  /** Opaque value that changes whenever workspace access changes; bound into list cursors. */
  permissionEpoch(workspaceId: string): Promise<string>;

  findProject(workspaceId: string, projectId: string): Promise<ProjectDto | null>;
  /** All active projects of the workspace, without a hidden limit. */
  listProjects(workspaceId: string): Promise<ProjectDto[]>;
  insertProject(row: ProjectDto): Promise<void>;
  saveProject(row: ProjectDto): Promise<void>;

  findSection(workspaceId: string, sectionId: string): Promise<SectionDto | null>;
  /** All active sections of the project, without a hidden limit. */
  listSections(workspaceId: string, projectId: string): Promise<SectionDto[]>;
  insertSection(row: SectionDto): Promise<void>;
  saveSection(row: SectionDto): Promise<void>;

  findStatus(workspaceId: string, statusId: string): Promise<TaskStatusDto | null>;
  /** All statuses of the project, ordered. */
  listStatuses(workspaceId: string, projectId: string): Promise<TaskStatusDto[]>;
  insertStatus(row: TaskStatusDto): Promise<void>;

  findTag(workspaceId: string, tagId: string): Promise<TagDto | null>;
  /** All active tags of the workspace, without a hidden limit. */
  listTags(workspaceId: string): Promise<TagDto[]>;
  insertTag(row: TagDto): Promise<void>;
  saveTag(row: TagDto): Promise<void>;

  findWorkPackage(workspaceId: string, workPackageId: string): Promise<WorkPackageRecord | null>;
  insertWorkPackage(row: WorkPackageRecord): Promise<void>;
  saveWorkPackage(row: WorkPackageRecord): Promise<void>;

  /**
   * The joined task projection: work package budget and revision, all participants
   * (active and inactive) and tag DTOs.
   */
  findTask(workspaceId: string, taskId: string): Promise<TaskDto | null>;
  findTasksByIds(workspaceId:string,taskIds:readonly string[]):Promise<TaskDto[]>;
  /**
   * Tasks matching `input`, in manual `(position,id)` or due `(dueDate NULLS LAST,id)` order after `after`.
   * Returns at most `take` rows; the domain passes page size + 1 to detect a next page.
   */
  listTasks(
    workspaceId: string,
    input: TaskListQuery,
    after: TaskCursorAnchor | null,
    take: number,
  ): Promise<TaskDto[]>;
  /**
   * Writes only task columns. Never copies the budget, participant or tag arrays of the
   * projection; those change through their explicit methods.
   */
  insertTaskCore(row: TaskDto): Promise<void>;
  /** Same column scope as `insertTaskCore`. */
  saveTaskCore(row: TaskDto): Promise<void>;
  /**
   * Upserts every provided participant history row and never deletes. The `active` flag
   * and row revisions are computed by the domain. `at` is a UTC ISO-8601 timestamp.
   */
  saveParticipants(workspaceId: string, taskId: string, rows: TaskParticipantDto[], at: string): Promise<void>;
  /** Replaces the current task–tag joins only; the audit history is separate and immutable. */
  setTaskTagIds(workspaceId: string, taskId: string, tagIds: string[]): Promise<void>;

  findIdempotency(
    workspaceId: string,
    actorUserId: string,
    command: string,
    idempotencyKey: string,
  ): Promise<IdempotencyRecord | null>;
  insertIdempotency(row: IdempotencyRecord): Promise<void>;
}

export interface TaskWriteScope extends WorkspaceWriteScope {
  /** Same workspace-barrier transaction; required whenever a bulk custom field is requested. */
  readonly fieldRepository?: TaskFieldRepository;
  readonly statusTransitions:TaskStatusTransitionPolicy;
  /** Required by every real composition; tests must inject an explicit policy fake. */
  readonly planningGuard: PlanningMutationGuard;
  readonly repository: TaskRepository;
}

/** `WorkspaceWriteRunner` whose scope also carries the transactional `TaskRepository`. */
export interface TaskUnitOfWork {
  run<T>(context: CommandContext, capability: Capability, work: (scope: TaskWriteScope) => Promise<T>): Promise<T>;
}

/**
 * Runtime primitives injected by the DB adapter (UUID, SHA-256, HMAC) so the domain imports
 * no Node built-ins. In P1a the cursor key is a per-process local secret.
 */
export interface TaskTools {
  newId(): string;
  digest(value: string): string;
  encodeCursor(payload: TaskCursorPayload): string;
  /**
   * Verifies signature and TTL; an invalid or expired token throws a `DomainError` with
   * `VALIDATION_FAILED`. Binding to actor, workspace, query and epoch is checked by the domain.
   */
  decodeCursor(token: string): TaskCursorPayload;
}

export interface TaskApplicationDependencies {
  readonly reader: TaskRepository;
  readonly writer: TaskUnitOfWork;
  readonly tools: TaskTools;
}
