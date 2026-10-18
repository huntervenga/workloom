import type { PlanningMutationGuard } from '../planning/ports.js';
import type {
  TaskFieldPolicyDto,
  ProjectColumnsDto,
  TaskFieldDefinitionDto,
  TaskFieldOptionDto,
  TaskFieldValueDto,
  TaskFieldValueHistoryDto,
} from '@workloom/contracts';

import type { Capability } from '../access/capabilities.js';
import type { CommandContext } from '../access/context.js';
import type { TaskRepository } from '../tasks/ports.js';
import type { WorkspaceWriteScope } from '../transactions/ports.js';

/** Option row with its owning field; the option DTO itself carries no parent IDs. */
export interface TaskFieldOptionRecord extends TaskFieldOptionDto {
  readonly workspaceId: string;
  readonly projectId: string;
  readonly fieldId: string;
}

/**
 * Keyset position of the last history entry on a page; history is ordered descending by
 * `(changeSeq, eventOrdinal, id)`. `changeSeq` is a decimal string so it never loses precision.
 */
export interface TaskFieldHistoryAnchor {
  readonly changeSeq: string;
  readonly eventOrdinal: number;
  readonly id: string;
}

/**
 * Signed history cursor contents. The domain checks that the actor, workspace, permission
 * epoch, task and field still match the request; a mismatch is rejected.
 */
export interface TaskFieldHistoryCursorPayload extends TaskFieldHistoryAnchor {
  readonly version: 1;
  readonly workspaceId: string;
  readonly actorUserId: string;
  readonly permissionEpoch: string;
  readonly taskId: string;
  readonly fieldId: string;
}

/**
 * Persistence port for P1b project-scoped custom task fields, shared project column settings,
 * typed values and value history. No built-in estimate or weekly baseline binding. Persistence
 * only: every query and write is scoped by `workspaceId`, and callers have already validated
 * capabilities and all domain rules. Writes run inside the workspace barrier transaction.
 * Implementations must not add business rules, defaults or hidden limits.
 */
export interface TaskFieldPolicyUsage {
  readonly workspaceId:string; readonly projectId:string; readonly taskId:string; readonly fieldId:string;
  readonly actorUserId:string; readonly valueRevision:number; readonly policyRevision:number;
  readonly exception:boolean; readonly recordedAt:string;
}
/** Mandatory same-transaction storage; usage is independent of optional value history. */
export interface TaskFieldPolicyRepository {
  find(workspaceId:string,fieldId:string):Promise<TaskFieldPolicyDto|null>;
  save(policy:TaskFieldPolicyDto):Promise<void>;
  count(workspaceId:string,taskId:string,fieldId:string,actorUserId:string):Promise<number>;
  insertUsage(usage:TaskFieldPolicyUsage):Promise<void>;
}

export interface TaskFieldRepository {
  readonly policies: TaskFieldPolicyRepository;
  /** Access, project and task lookups, permission epoch and idempotency records. */
  readonly tasks: TaskRepository;

  /** The current definition with its whole option catalog (active and archived). */
  findField(workspaceId: string, fieldId: string): Promise<TaskFieldDefinitionDto | null>;
  /**
   * All fields of the project, active and archived, without a hidden limit, ordered by
   * `(createdAt, id)`. Column order lives in the project column settings, not here.
   */
  listFields(workspaceId: string, projectId: string): Promise<TaskFieldDefinitionDto[]>;
  /** Writes only field columns; options and definition versions change through their methods. */
  insertField(row: TaskFieldDefinitionDto): Promise<void>;
  /** Same column scope as `insertField`. */
  saveField(row: TaskFieldDefinitionDto): Promise<void>;
  /**
   * Inserts the immutable full snapshot (options included) under `snapshot.definitionVersionId`.
   * Never updated afterwards, so history never relabels past options.
   */
  insertDefinitionVersion(snapshot: TaskFieldDefinitionDto): Promise<void>;

  /**
   * The option (active or archived) with its parent IDs, scoped by workspace only, so the
   * domain can tell a missing or foreign option (404) from one of another field or project (422).
   */
  findOption(workspaceId: string, optionId: string): Promise<TaskFieldOptionRecord | null>;
  insertOption(row: TaskFieldOptionRecord): Promise<void>;
  saveOption(row: TaskFieldOptionRecord): Promise<void>;

  findProjectColumns(workspaceId: string, projectId: string): Promise<ProjectColumnsDto | null>;
  /**
   * Upserts the settings header and replaces all column rows with exactly `row.columns` within
   * the transaction. The domain supplies every row; nothing is filtered or defaulted.
   */
  saveProjectColumns(row: ProjectColumnsDto): Promise<void>;

  /** The current value row, or null when absent; a row holding typed `null` is a clear. */
  findValue(workspaceId: string, taskId: string, fieldId: string): Promise<TaskFieldValueDto | null>;
  /** All value rows of the task, without a hidden limit. */
  listTaskValues(workspaceId: string, taskId: string): Promise<TaskFieldValueDto[]>;
  /** All value rows of the given tasks in the project, without a hidden limit. */
  listProjectValues(workspaceId: string, projectId: string, taskIds: readonly string[]): Promise<TaskFieldValueDto[]>;
  /** Upserts the value row. */
  saveValue(row: TaskFieldValueDto): Promise<void>;

  /**
   * Inserts an immutable history entry. The adapter stores the definition snapshot (or its
   * immutable version reference) and the typed `before`/`after` JSON as given.
   */
  insertValueHistory(row: TaskFieldValueHistoryDto): Promise<void>;
  /**
   * History of one task field in stable descending `(changeSeq, eventOrdinal, id)` order strictly
   * after `after`. Returns at most `take` rows; the domain passes page size + 1 to detect a next page.
   */
  listValueHistory(
    workspaceId: string,
    taskId: string,
    fieldId: string,
    after: TaskFieldHistoryAnchor | null,
    take: number,
  ): Promise<TaskFieldValueHistoryDto[]>;
}

export interface TaskFieldWriteScope extends WorkspaceWriteScope {
  /** Required by every real composition; tests must inject an explicit policy fake. */
  readonly planningGuard: PlanningMutationGuard;
  readonly repository: TaskFieldRepository;
}

/** `WorkspaceWriteRunner` whose scope also carries the transactional `TaskFieldRepository`. */
export interface TaskFieldUnitOfWork {
  run<T>(context: CommandContext, capability: Capability, work: (scope: TaskFieldWriteScope) => Promise<T>): Promise<T>;
}

/** Runtime primitives injected by the DB adapter (UUID, SHA-256, HMAC); see `TaskTools`. */
export interface TaskFieldTools {
  newId(): string;
  digest(value: string): string;
  encodeHistoryCursor(payload: TaskFieldHistoryCursorPayload): string;
  /**
   * Verifies signature and TTL; an invalid or expired token throws a `DomainError` with
   * `VALIDATION_FAILED`. Binding to actor, workspace, epoch, task and field is checked by the domain.
   */
  decodeHistoryCursor(token: string): TaskFieldHistoryCursorPayload;
}

export interface TaskFieldApplicationDependencies {
  readonly reader: TaskFieldRepository;
  readonly writer: TaskFieldUnitOfWork;
  readonly tools: TaskFieldTools;
}
