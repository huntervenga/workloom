import { authorizeBulkFieldTarget, prepareBulkExtras, applyBulkExtras } from './bulk-extras.js';
import {assertTaskDateRange,assertOrdinaryTaskDates} from './dates.js';
import type { TaskMutationCommand } from '../planning/ports.js';
import { isCommittedPlanningRejection, unwrapPlanningOutcome } from '../planning/freeze.js';
import {
  TASK_MOVE_UNDO_LIMITS,
  archiveTaskInputSchema,
  bulkUpdateTasksInputSchema,
  bulkChangesForTask,
  type BulkUpdatedTaskDto,
  bulkTaskUpdateResponseSchema,
  createProjectInputSchema,
  createSectionInputSchema,
  createTagInputSchema,
  createTaskInputSchema,
  idSchema,
  moveTaskInputSchema,
  movedTaskSchema,
  projectSchema,
  restoreMoveTaskInputSchema,
  restoreTaskInputSchema,
  sectionSchema,
  tagSchema,
  taskListQuerySchema,
  taskSchema,
  updateProjectInputSchema,
  updateSectionInputSchema,
  updateTagInputSchema,
  updateTaskInputSchema,
  type ArchiveTaskInput,
  type BulkUpdateTasksInput,
  type CreateProjectInput,
  type CreateSectionInput,
  type CreateTagInput,
  type CreateTaskInput,
  type MoveTaskDto,
  type MoveTaskInput,
  type MoveUndoAck,
  type ProjectDto,
  type RestoreMoveTaskInput,
  type RestoreTaskInput,
  type SectionDto,
  type TagDto,
  type TaskDto,
  type TaskFieldData,
  type TaskInsertion,
  type TaskListQuery,
  type TaskParticipantDto,
  type TaskStatusDto,
  type UpdateProjectInput,
  type UpdateSectionInput,
  type UpdateTagInput,
  type UpdateTaskInput,
} from '@workloom/contracts';

import { authorizeWorkspace } from '../access/access-queries.js';
import type { Capability } from '../access/capabilities.js';
import type { CommandContext } from '../access/context.js';
import { DomainError, notFoundError, unauthenticatedError } from '../errors.js';
import type { RecordedChange } from '../transactions/ports.js';
import type { TaskFieldRepository } from '../fields/ports.js';
import { setTaskFieldValueInScope } from '../fields/service.js';
import { resolveTaskDefaults } from '../task-defaults/apply.js';
import { loadTaskActivityLabels, taskActivityDiff } from './activity.js';
import type { TaskApplication, TaskPage } from './application.js';
import {
  MOVE_RESTORE_COMMAND,
  MOVE_UNDO_SOURCE_COMMAND,
  moveGroupOf,
  orderFingerprint,
  parseMoveUndoSource,
  revisionHeads,
  type MoveUndoSource,
} from './move-undo.js';
import type { TaskApplicationDependencies, TaskCursorAnchor, TaskRepository, TaskWriteScope, WorkPackageRecord } from './ports.js';

const MAX_POSITION = 2_147_483_647;
/** Same rule as the HTTP adapter: visible ASCII, 1–128 characters. */
const IDEMPOTENCY_KEY_PATTERN = /^[\x21-\x7e]{1,128}$/;

// Persisted template data for NEW projects, not localized UI labels. Existing statuses and
// exact idempotent outcomes are never renamed or rewritten when this template changes.
const DEFAULT_STATUSES = [
  { name: 'To do', group: 'todo' },
  { name: 'In progress', group: 'in_progress' },
  { name: 'Done', group: 'done' },
  { name: 'Cancelled', group: 'cancelled' },
] as const;

/** Task columns whose change bumps the task `revision` (tag joins count too). */
const TASK_CORE_KEYS = [
  'title',
  'description',
  'statusId',
  'sectionId',
  'parentTaskId',
  'responsibleMembershipId',
  'startDate',
  'dueDate',
  'priority',
  'position',
] as const;

/** Structural view of a Zod schema, so the domain needs no direct Zod dependency. */
interface SafeParser<T> {
  safeParse(value: unknown):
    | { success: true; data: T }
    | { success: false; error: { issues: readonly { path: readonly PropertyKey[] }[] } };
}

/**
 * P1a task application. Adapters stay thin: every call re-validates its input with the shared
 * contract schema, canonicalizes IDs, authorizes the current membership, and every mutation runs
 * under the workspace barrier with idempotency, audit and outbox in one transaction.
 */
export function createTaskApplication(dependencies: TaskApplicationDependencies): TaskApplication {
  const { reader, writer, tools } = dependencies;

  const newId = (): string => idSchema.parse(tools.newId());
  const hash = (value: unknown): string => tools.digest(canonicalJson(value));

  async function authorizeRead(context: CommandContext): Promise<CommandContext> {
    const ctx = normalizeContext(context);
    await authorizeWorkspace(reader.access, ctx, 'task.read');
    return ctx;
  }

  /**
   * Runs one idempotent command. The writer has already re-checked the active membership and
   * capability under the barrier; a stored result for the same key is replayed without any
   * state, audit or outbox write, and a different payload under that key is rejected.
   */
  async function mutate<R>(
    context: CommandContext,
    capability: Capability,
    command: TaskMutationCommand,
    target: string | null,
    input: unknown,
    resultSchema: SafeParser<R>,
    work: (scope: TaskWriteScope, workspaceId: string, now: string) => Promise<R>,
    authorizeBeforeReplay?: (scope: TaskWriteScope) => Promise<void>,
  ): Promise<R> {
    const ctx = normalizeContext(context);
    const key = ctx.idempotencyKey;
    if (key === undefined || !IDEMPOTENCY_KEY_PATTERN.test(key)) {
      throw validationError(['Idempotency-Key'], 'A valid Idempotency-Key is required.');
    }
    const payloadHash = hash({ command, target, input });
    const { workspaceId } = ctx;
    const actorUserId = ctx.actor.userId;

    const outcome = await writer.run(ctx, capability, async (scope) => {
      if (authorizeBeforeReplay) await authorizeBeforeReplay(scope);
      const existing = await scope.repository.findIdempotency(workspaceId, actorUserId, command, key);
      if (existing !== null) {
        if (existing.payloadHash !== payloadHash) {
          throw new DomainError('IDEMPOTENCY_KEY_REUSED', 'This Idempotency-Key was already used for a different request.');
        }
        if (isCommittedPlanningRejection(existing.result)) return existing.result;
        const stored = resultSchema.safeParse(existing.result);
        if (!stored.success) throw new Error('Stored idempotent result does not match its contract.');
        return stored.data;
      }
      const now = scope.barrierAt.toISOString();
      const rejected = await scope.planningGuard.check({ family: 'task', command, target, input });
      const result = rejected ?? await work(scope, workspaceId, now);
      await scope.repository.insertIdempotency({
        workspaceId,
        actorUserId,
        command,
        idempotencyKey: key,
        payloadHash,
        result,
        createdAt: now,
      });
      return result;
    });
    return unwrapPlanningOutcome(outcome);
  }

  return {
    async listProjects(context: CommandContext, includeArchived = false): Promise<ProjectDto[]> {
      const ctx = await authorizeRead(context);
      return reader.listProjects(ctx.workspaceId, includeArchived);
    },

    async getProject(context: CommandContext, projectId: string): Promise<ProjectDto> {
      const id = parsePathId(projectId);
      const ctx = await authorizeRead(context);
      return requireFound(await reader.findProject(ctx.workspaceId, id));
    },

    async createProject(context: CommandContext, input: CreateProjectInput): Promise<ProjectDto> {
      const parsed = parseInput<CreateProjectInput>(createProjectInputSchema, input);
      return mutate(context, 'task.edit', 'project.create', null, parsed, projectSchema, async (scope, ws, now) => {
        const repo = scope.repository;
        const project: ProjectDto = {
          id: newId(),
          workspaceId: ws,
          name: parsed.name,
          revision: 1,
          archivedAt: null,
          createdAt: now,
          updatedAt: now,
        };
        await repo.insertProject(project);
        const statusIds: string[] = [];
        for (const [position, status] of DEFAULT_STATUSES.entries()) {
          const row: TaskStatusDto = { id: newId(), workspaceId: ws, projectId: project.id, ...status, position, revision: 1 };
          await repo.insertStatus(row);
          statusIds.push(row.id);
        }
        await record(scope, 'project', project.id, 'created', 1, { name: project.name, statusIds }, {});
        return project;
      });
    },

    async updateProject(context: CommandContext, projectId: string, input: UpdateProjectInput): Promise<ProjectDto> {
      const id = parsePathId(projectId);
      const parsed = parseInput<UpdateProjectInput>(updateProjectInputSchema, input);
      return mutate(context, 'task.edit', 'project.update', id, parsed, projectSchema, async (scope, ws, now) => {
        const project = requireFound(await scope.repository.findProject(ws, id));
        expectRevision(project.revision, parsed.expectedRevision);
        const next: ProjectDto = {
          ...project,
          name: parsed.name ?? project.name,
          ...(parsed.dateRange===undefined?{}:{dateRange:parsed.dateRange}),
          archivedAt: nextArchivedAt(project.archivedAt, parsed.archived, now),
          revision: project.revision + 1,
          updatedAt: now,
        };
        await scope.repository.saveProject(next);
        await record(scope, 'project', id, 'updated', next.revision, changedFields(project, next, ['name', 'archivedAt', 'dateRange']), {});
        return next;
      });
    },

    async listSections(context: CommandContext, projectId: string): Promise<SectionDto[]> {
      const id = parsePathId(projectId);
      const ctx = await authorizeRead(context);
      requireFound(await reader.findProject(ctx.workspaceId, id));
      return reader.listSections(ctx.workspaceId, id);
    },

    async createSection(context: CommandContext, projectId: string, input: CreateSectionInput): Promise<SectionDto> {
      const id = parsePathId(projectId);
      const parsed = parseInput<CreateSectionInput>(createSectionInputSchema, input);
      return mutate(context, 'task.edit', 'section.create', id, parsed, sectionSchema, scope => createSectionInScope(scope, id, parsed, { newId }));
    },

    async updateSection(context: CommandContext, sectionId: string, input: UpdateSectionInput): Promise<SectionDto> {
      const id = parsePathId(sectionId);
      const parsed = parseInput<UpdateSectionInput>(updateSectionInputSchema, input);
      return mutate(context, 'task.edit', 'section.update', id, parsed, sectionSchema, async (scope, ws, now) => {
        const section = requireFound(await scope.repository.findSection(ws, id));
        expectRevision(section.revision, parsed.expectedRevision);
        const next: SectionDto = {
          ...section,
          name: parsed.name ?? section.name,
          position: parsed.position ?? section.position,
          archivedAt: nextArchivedAt(section.archivedAt, parsed.archived, now),
          revision: section.revision + 1,
        };
        await scope.repository.saveSection(next);
        const diff = changedFields(section, next, ['name', 'position', 'archivedAt']);
        await record(scope, 'section', id, 'updated', next.revision, diff, { projectId: section.projectId });
        return next;
      });
    },

    async listStatuses(context: CommandContext, projectId: string): Promise<TaskStatusDto[]> {
      const id = parsePathId(projectId);
      const ctx = await authorizeRead(context);
      requireFound(await reader.findProject(ctx.workspaceId, id));
      return reader.listStatuses(ctx.workspaceId, id);
    },

    async listTags(context: CommandContext, includeArchived = false): Promise<TagDto[]> {
      const ctx = await authorizeRead(context);
      return reader.listTags(ctx.workspaceId, includeArchived);
    },

    async createTag(context: CommandContext, input: CreateTagInput): Promise<TagDto> {
      const parsed = parseInput<CreateTagInput>(createTagInputSchema, input);
      return mutate(context, 'fields.manage', 'tag.create', null, parsed, tagSchema, async (scope, ws) => {
        await assertTagNameFree(scope.repository, ws, parsed.name, null);
        const tag: TagDto = {
          id: newId(),
          workspaceId: ws,
          name: parsed.name,
          color: parsed.color ?? null,
          revision: 1,
          archivedAt: null,
        };
        await scope.repository.insertTag(tag);
        await record(scope, 'tag', tag.id, 'created', 1, { name: tag.name, color: tag.color }, {});
        return tag;
      });
    },

    async updateTag(context: CommandContext, tagId: string, input: UpdateTagInput): Promise<TagDto> {
      const id = parsePathId(tagId);
      const parsed = parseInput<UpdateTagInput>(updateTagInputSchema, input);
      return mutate(context, 'fields.manage', 'tag.update', id, parsed, tagSchema, async (scope, ws, now) => {
        const tag = requireFound(await scope.repository.findTag(ws, id));
        expectRevision(tag.revision, parsed.expectedRevision);
        const next: TagDto = {
          ...tag,
          name: parsed.name ?? tag.name,
          color: parsed.color === undefined ? tag.color : parsed.color,
          archivedAt: nextArchivedAt(tag.archivedAt, parsed.archived, now),
          revision: tag.revision + 1,
        };
        if (next.archivedAt === null && (parsed.name !== undefined || tag.archivedAt !== null)) {
          await assertTagNameFree(scope.repository, ws, next.name, id);
        }
        await scope.repository.saveTag(next);
        await record(scope, 'tag', id, 'updated', next.revision, changedFields(tag, next, ['name', 'color', 'archivedAt']), {});
        return next;
      });
    },

    async listTasks(context: CommandContext, input: TaskListQuery): Promise<TaskPage> {
      const query = parseInput<TaskListQuery>(taskListQuerySchema, input);
      const ctx = await authorizeRead(context);
      const ws = ctx.workspaceId;
      requireFound(await reader.findProject(ws, query.projectId));
      if (query.sectionId !== undefined) {
        requireSameProject(requireFound(await reader.findSection(ws, query.sectionId)), query.projectId, 'sectionId');
      }
      if (query.statusId !== undefined) {
        requireSameProject(requireFound(await reader.findStatus(ws, query.statusId)), query.projectId, 'statusId');
      }

      if (query.tagId !== undefined) {
        // Archived tags remain readable on existing tasks; only assignment rejects them.
        requireFound(await reader.findTag(ws, query.tagId));
      }

      const { cursor, sort, ...legacyFilters } = query;
      // No default/null/manual key enters the old canonical hash or v1 cursor bytes.
      const filters = sort === 'due_asc' ? { ...legacyFilters, sort } : legacyFilters;
      const permissionEpoch = await reader.permissionEpoch(ws);
      const queryHash = hash(filters);
      const binding = { workspaceId: ws, actorUserId: ctx.actor.userId, permissionEpoch, queryHash };
      const version = sort === 'due_asc' ? 2 : 1;

      let after: TaskCursorAnchor | null = null;
      if (cursor !== undefined) {
        const payload = tools.decodeCursor(cursor);
        const bound =
          payload.version === version &&
          payload.workspaceId === binding.workspaceId &&
          payload.actorUserId === binding.actorUserId &&
          payload.permissionEpoch === binding.permissionEpoch &&
          payload.queryHash === binding.queryHash;
        if (!bound) throw validationError(['cursor'], 'The cursor is no longer valid. Reload the list.');
        after = payload.version === 2
          ? { dueDate: payload.dueDate, id: payload.id }
          : { position: payload.position, id: payload.id };
      }

      const rows = await reader.listTasks(ws, filters, after, query.limit + 1);
      const items = rows.slice(0, query.limit);
      const last = items.at(-1);
      const nextCursor =
        rows.length > query.limit && last !== undefined
          ? tools.encodeCursor(version === 2
              ? { version: 2, ...binding, dueDate: last.dueDate, id: last.id }
              : { version: 1, ...binding, position: last.position, id: last.id })
          : null;
      return { items, nextCursor };
    },

    async getTask(context: CommandContext, taskId: string): Promise<TaskDto> {
      const id = parsePathId(taskId);
      const ctx = await authorizeRead(context);
      return requireFound(await reader.findTask(ctx.workspaceId, id));
    },

    async createTask(context: CommandContext, input: CreateTaskInput): Promise<TaskDto> {
      const parsed = parseInput<CreateTaskInput>(createTaskInputSchema, input);
      return mutate(context, 'task.edit', 'task.create', null, parsed, taskSchema, async scope => {
        // The receipt keeps the caller's own input; project defaults only fill in what was left out.
        const filled = await resolveTaskDefaults(scope.repository, scope.fieldRepository, scope.context.workspaceId, parsed, new Set(), scope.barrierAt);
        const created = await createTaskInScope(scope, filled.input, tools, filled.fields);
        for (const item of filled.fields) {
          await setTaskFieldValueInScope({ ...scope, repository: scope.fieldRepository as TaskFieldRepository, planningGuard: scope.planningGuard }, created.id, item.fieldId,
            { expectedRevision: 0, expectedDefinitionRevision: item.expectedDefinitionRevision, value: item.value }, tools);
        }
        return created;
      });
    },

    async updateTask(context: CommandContext, taskId: string, input: UpdateTaskInput): Promise<TaskDto> {
      const id = parsePathId(taskId);
      const parsed = parseInput<UpdateTaskInput>(updateTaskInputSchema, input);
      return mutate(context, 'task.edit', 'task.update', id, parsed, taskSchema, async (scope, ws, now) => {
        const repo = scope.repository;
        const task = requireFound(await repo.findTask(ws, id));
        expectRevision(task.revision, parsed.expectedRevision);
        if (task.archivedAt !== null) throw ruleError('The task is archived. Restore it before editing.', 'taskId');
        await requireOpenProject(repo, ws, task.projectId);

        assertOrdinaryTaskDates(task,parsed);
        // Every provided reference is validated, even when it equals the current value.
        if (parsed.statusId !== undefined) {
          await scope.statusTransitions.assertTransition(task,parsed.statusId,{prospective:completionScope(parsed)});
          requireSameProject(requireFound(await repo.findStatus(ws, parsed.statusId)), task.projectId, 'statusId');
        }
        if (isSet(parsed.sectionId)) await requireAssignableSection(repo, ws, task.projectId, parsed.sectionId);
        let sectionId = parsed.sectionId === undefined ? task.sectionId : parsed.sectionId;
        const parentChanged = parsed.parentTaskId !== undefined && parsed.parentTaskId !== task.parentTaskId;
        if (isSet(parsed.parentTaskId)) {
          const parent = await requireParent(repo, ws, task.projectId, parsed.parentTaskId);
          await assertNoCycle(repo, ws, task.id, parent);
          if (parentChanged) {
            if (parsed.sectionId !== undefined && parsed.sectionId !== parent.sectionId) throw ruleError('A subtask must stay in its parent section.', 'sectionId');
            sectionId = parent.sectionId;
          }
        }
        if (!parentChanged && task.parentTaskId !== null && parsed.sectionId !== undefined && parsed.sectionId !== task.sectionId) throw ruleError('A subtask can only stay in its own section.', 'sectionId');
        if (parentChanged && parsed.parentTaskId === null && task.parentTaskId !== null) {
          const previousParent = requireFound(await repo.findTask(ws, task.parentTaskId));
          if (task.workPackageId === previousParent.workPackageId) throw ruleError('A detail subtask shares its parent work package. Create an independent task instead of detaching it from that package.', 'parentTaskId');
        }
        await requireActiveMembers(repo, ws, parsed.responsibleMembershipId ?? null, parsed.participantMembershipIds ?? [], {
          responsibleId: task.responsibleMembershipId,
          participantIds: task.participants.filter((row) => row.active).map((row) => row.membershipId),
        });
        const currentTagIds = task.tags.map((tag) => tag.id);
        if (parsed.tagIds !== undefined) await requireAssignableTags(repo, ws, parsed.tagIds, currentTagIds);

        const diff: Record<string, unknown> = {};

        // Shared work package: estimate and revision change exactly once; tasks never copy it.
        if (parsed.estimateMinutes !== undefined) {
          const workPackage = await repo.findWorkPackage(ws, task.workPackageId);
          if (workPackage === null) throw new Error('Task work package is missing.');
          expectRevision(workPackage.revision, parsed.expectedWorkPackageRevision ?? 0, 'expectedWorkPackageRevision');
          const nextPackage: WorkPackageRecord = {
            ...workPackage,
            estimateMinutes: parsed.estimateMinutes,
            revision: workPackage.revision + 1,
            updatedAt: now,
          };
          await repo.saveWorkPackage(nextPackage);
          diff.workPackage = {
            id: workPackage.id,
            revision: { from: workPackage.revision, to: nextPackage.revision },
            estimateMinutes: { from: workPackage.estimateMinutes, to: nextPackage.estimateMinutes },
          };
        }

        let participantsRevision = task.participantsRevision;
        if (parsed.participantMembershipIds !== undefined) {
          expectRevision(
            task.participantsRevision,
            parsed.expectedParticipantsRevision ?? 0,
            'expectedParticipantsRevision',
          );
          const change = nextParticipantRows(task.participants, parsed.participantMembershipIds);
          if (change.rows.length > 0) await repo.saveParticipants(ws, id, change.rows, now);
          participantsRevision += 1;
          diff.participants = {
            revision: { from: task.participantsRevision, to: participantsRevision },
            added: change.added,
            removed: change.removed,
          };
        }

        const coreTouched = TASK_CORE_KEYS.some((key) => parsed[key] !== undefined) || parsed.tagIds !== undefined;
        const next: TaskDto = {
          ...task,
          title: parsed.title ?? task.title,
          description: parsed.description ?? task.description,
          statusId: parsed.statusId ?? task.statusId,
          sectionId,
          // Reparenting never changes the task's own work package.
          parentTaskId: parsed.parentTaskId === undefined ? task.parentTaskId : parsed.parentTaskId,
          responsibleMembershipId:
            parsed.responsibleMembershipId === undefined ? task.responsibleMembershipId : parsed.responsibleMembershipId,
          startDate: parsed.startDate === undefined ? task.startDate ?? null : parsed.startDate,
          dueDate: parsed.dueDate === undefined ? task.dueDate : parsed.dueDate,
          priority: parsed.priority ?? task.priority,
          position: parsed.position ?? task.position,
          revision: coreTouched ? task.revision + 1 : task.revision,
          participantsRevision,
          updatedAt: now,
        };
        await repo.saveTaskCore(next);
        if (parsed.tagIds !== undefined) {
          await repo.setTaskTagIds(ws, id, parsed.tagIds);
          diff.tagIds = { from: currentTagIds, to: parsed.tagIds };
        }
        Object.assign(diff, changedFields(task, next, TASK_CORE_KEYS));
        if (coreTouched) diff.revision = { from: task.revision, to: next.revision };

        const updated = await reloadTask(repo, ws, id);
        const activityPair = { before: task, after: updated };
        const labels = await loadTaskActivityLabels(scope, [activityPair]);
        await record(scope, 'task', id, 'updated', updated.revision, taskActivityDiff(activityPair, diff, labels), taskEventIds(updated));
        return updated;
      });
    },

    async archiveTask(context: CommandContext, taskId: string, input: ArchiveTaskInput): Promise<TaskDto> {
      const id = parsePathId(taskId);
      const parsed = parseInput<ArchiveTaskInput>(archiveTaskInputSchema, input);
      return mutate(context, 'task.edit', 'task.archive', id, parsed, taskSchema, async (scope, ws, now) => {
        const repo = scope.repository;
        const task = requireFound(await repo.findTask(ws, id));
        expectRevision(task.revision, parsed.expectedRevision);
        if (task.archivedAt !== null) throw ruleError('The task is already archived.', 'taskId');
        await requireOpenProject(repo, ws, task.projectId);
        // Subtasks go with their parent, with the same instant, so a restore can bring back exactly them.
        for (const child of await descendantsOf(repo, ws, task, task.archivedAt)) await setTaskArchivedAt(scope, child, now, now, 'archived');
        return setTaskArchivedAt(scope, task, now, now, 'archived');
      });
    },

    async restoreTask(context: CommandContext, taskId: string, input: RestoreTaskInput): Promise<TaskDto> {
      const id = parsePathId(taskId);
      const parsed = parseInput<RestoreTaskInput>(restoreTaskInputSchema, input);
      return mutate(context, 'task.edit', 'task.restore', id, parsed, taskSchema, async (scope, ws, now) => {
        const repo = scope.repository;
        const task = requireFound(await repo.findTask(ws, id));
        expectRevision(task.revision, parsed.expectedRevision);
        if (task.archivedAt === null) throw ruleError('The task is not archived.', 'taskId');
        await requireOpenProject(repo, ws, task.projectId);
        if (task.parentTaskId !== null) {
          const parent = await repo.findTask(ws, task.parentTaskId);
          if (parent && parent.archivedAt !== null) throw ruleError('Restore the parent task first.', 'taskId');
        }
        // Only the subtasks that left together with this task come back with it.
        const leftTogether = task.archivedAt;
        const restored = await setTaskArchivedAt(scope, task, null, now, 'restored');
        for (const child of await descendantsOf(repo, ws, task, leftTogether)) await setTaskArchivedAt(scope, child, null, now, 'restored');
        return restored;
      });
    },

    async bulkUpdateTasks(context: CommandContext, input: BulkUpdateTasksInput): Promise<BulkUpdatedTaskDto[]> {
      const parsed = parseInput<BulkUpdateTasksInput>(bulkUpdateTasksInputSchema, input);
      const ctx = normalizeContext(context);
      const key = ctx.idempotencyKey;
      if (key === undefined || !IDEMPOTENCY_KEY_PATTERN.test(key)) throw validationError(['Idempotency-Key'], 'A valid Idempotency-Key is required.');
      const command = 'task.bulk.update';
      const payloadHash = hash({ command, target: parsed.projectId, input: parsed });
      const outcome = await writer.run(ctx, 'task.edit', async scope => {
        const repo = scope.repository, ws = ctx.workspaceId;
        // Current access to EVERY requested target is established before a stored response is replayed.
        requireFound(await repo.findProject(ws, parsed.projectId));
        const targets: TaskDto[] = [];
        for (const row of parsed.tasks) {
          const task = requireFound(await repo.findTask(ws, row.taskId));
          requireSameProject(task, parsed.projectId, 'tasks');
          targets.push(task);
        }
        await authorizeBulkFieldTarget(scope, parsed);
        const existing = await repo.findIdempotency(ws, ctx.actor.userId, command, key);
        if (existing !== null) {
          if (existing.payloadHash !== payloadHash) throw new DomainError('IDEMPOTENCY_KEY_REUSED', 'This Idempotency-Key was already used for a different request.');
          if (isCommittedPlanningRejection(existing.result)) return existing.result;
          const stored = bulkTaskUpdateResponseSchema.shape.data.safeParse(existing.result);
          if (!stored.success) throw new Error('Stored bulk result does not match its contract.');
          return stored.data;
        }
        await requireOpenProject(repo, ws, parsed.projectId);
        // Complete preflight before cutoff prerequisites or proposed writes. Replays retain old guards.
        for (const [index, task] of targets.entries()) {
          const changes = bulkChangesForTask(parsed, task.id);
          await requireActiveMembers(repo, ws, changes.responsibleMembershipId ?? null, changes.participantMembershipIds ?? [], {
            responsibleId: task.responsibleMembershipId, participantIds: task.participants.filter(row => row.active).map(row => row.membershipId),
          });
          if (isSet(changes.sectionId)) await requireAssignableSection(repo, ws, parsed.projectId, changes.sectionId);
          if (changes.participantMembershipIds !== undefined) expectRevision(task.participantsRevision, parsed.tasks[index]?.expectedParticipantsRevision ?? 0, 'expectedParticipantsRevision');
          expectRevision(task.revision, parsed.tasks[index]?.expectedRevision ?? 0);
          if (task.archivedAt !== null) throw ruleError('The task is archived. Restore it before editing.', 'tasks');
          assertTaskDateRange(changes.startDate === undefined ? task.startDate : changes.startDate, changes.dueDate === undefined ? task.dueDate : changes.dueDate);
          // One target status for every row; each transition is asserted even when the row already has it.
          if (changes.statusId !== undefined) {
            await scope.statusTransitions.assertTransition(task, changes.statusId,{prospective:completionScope(changes),...(changes.customField?{fieldValues:[changes.customField]}:{})});
            requireSameProject(requireFound(await repo.findStatus(ws, changes.statusId)), task.projectId, 'statusId');
          }
          // Sections move root tasks only; a subtask never leaves its parent's section or lineage.
          if (changes.sectionId !== undefined && task.parentTaskId !== null && changes.sectionId !== task.sectionId) {
            throw ruleError('A subtask can only stay in its own section.', 'sectionId');
          }
          // Archived tags may stay only on the rows that already carry them.
          if (changes.tagIds !== undefined) await requireAssignableTags(repo, ws, changes.tagIds, task.tags.map(tag => tag.id));
        }
        const extras = await prepareBulkExtras(scope, parsed, targets);
        const now = scope.barrierAt.toISOString();
        const rejected = await scope.planningGuard.check({ family: 'task_bulk', command, target: { projectId: parsed.projectId }, input: parsed });
        const sameIds = (left: readonly string[], right: readonly string[]) => left.length === right.length && right.every(id => left.includes(id));
        const updated: BulkUpdatedTaskDto[] = [];
        const audit: { before: TaskDto; after: TaskDto; diff: Record<string, unknown> }[] = [];
        const recordedPackages = new Set<string>();
        if (rejected === null) {
          const fieldValues = await applyBulkExtras(scope, parsed, targets, extras, tools);
          for (const task of targets) {
            const changes = bulkChangesForTask(parsed, task.id);
            const participants = changes.participantMembershipIds === undefined ? null : nextParticipantRows(task.participants, changes.participantMembershipIds);
            if (participants && participants.rows.length > 0) await repo.saveParticipants(ws, task.id, participants.rows, now);
            const next: TaskDto = { ...task,
              ...(changes.responsibleMembershipId !== undefined ? { responsibleMembershipId: changes.responsibleMembershipId } : {}),
              ...(changes.startDate !== undefined ? { startDate: changes.startDate } : {}),
              ...(changes.dueDate !== undefined ? { dueDate: changes.dueDate } : {}),
              ...(changes.statusId !== undefined ? { statusId: changes.statusId } : {}),
              ...(changes.priority !== undefined ? { priority: changes.priority } : {}),
              ...(changes.sectionId !== undefined ? { sectionId: changes.sectionId } : {}),
            };
            const diff: Record<string, unknown> = changedFields(task, next, ['responsibleMembershipId', 'startDate', 'dueDate', 'statusId', 'priority', 'sectionId']);
            const currentTagIds = task.tags.map(tag => tag.id);
            const tagIds = changes.tagIds !== undefined && !sameIds(currentTagIds, changes.tagIds) ? changes.tagIds : null;
            if (tagIds !== null) diff.tagIds = { from: currentTagIds, to: tagIds };
            const coreChanged = Object.keys(diff).length > 0;
            if (participants) diff.participants = { revision: { from: task.participantsRevision, to: task.participantsRevision + 1 }, added: participants.added, removed: participants.removed };
            if (coreChanged || participants) {
              await repo.saveTaskCore({ ...next, revision: coreChanged ? task.revision + 1 : task.revision, participantsRevision: task.participantsRevision + (participants ? 1 : 0), updatedAt: now });
              if (tagIds !== null) await repo.setTaskTagIds(ws, task.id, tagIds);
              if (coreChanged) diff.revision = { from: task.revision, to: task.revision + 1 };
            }
            const pack = extras.packages.get(task.workPackageId);
            if (pack && !recordedPackages.has(task.workPackageId)) {
              recordedPackages.add(task.workPackageId);
              diff.workPackage = { id: pack.before.id,
                revision: { from: pack.before.revision, to: pack.after.revision },
                estimateMinutes: { from: pack.before.estimateMinutes, to: pack.after.estimateMinutes } };
            }
            const confirmed = coreChanged || pack || participants ? await reloadTask(repo, ws, task.id) : task;
            const valueAck = fieldValues.get(task.id);
            updated.push(parsed.includeFieldValueAck && valueAck ? { ...confirmed, customFieldAck: valueAck } : confirmed);
            if (Object.keys(diff).length > 0) audit.push({ before: task, after: confirmed, diff });
          }
          // Batch reference labels once. Audit-only snapshots never enter the outbox or receipt.
          const labels = await loadTaskActivityLabels(scope, audit);
          for (const pair of audit) await record(scope, 'task', pair.after.id, 'updated', pair.after.revision,
            taskActivityDiff(pair, pair.diff, labels), taskEventIds(pair.after));
        }
        const result = rejected ?? updated;
        await repo.insertIdempotency({ workspaceId: ws, actorUserId: ctx.actor.userId, command, idempotencyKey: key, payloadHash, result, createdAt: now });
        return result;
      });
      return unwrapPlanningOutcome(outcome);
    },

    async moveTask(context: CommandContext, taskId: string, input: MoveTaskInput): Promise<MoveTaskDto> {
      const id = parsePathId(taskId);
      const parsed = parseInput<MoveTaskInput>(moveTaskInputSchema, input);
      // Opt-in only: without captureUndo the hash, receipt schema and output stay byte-exact.
      const captureUndo = parsed.captureUndo === true;
      const resultSchema: SafeParser<MoveTaskDto> = captureUndo ? movedTaskSchema : taskSchema;
      return mutate(context, 'task.edit', 'task.move', id, parsed, resultSchema, async (scope, ws, now) => {
        const repo = scope.repository;
        const task = requireFound(await repo.findTask(ws, id));
        expectRevision(task.revision, parsed.expectedRevision);
        if (task.archivedAt !== null) throw ruleError('The task is archived. Restore it before moving.', 'taskId');
        if (parsed.anchorTaskId === id) throw ruleError('A task cannot be placed next to itself.', 'anchorTaskId');
        await requireOpenProject(repo, ws, task.projectId);
        const assigneeMode = parsed.responsibleMembershipId !== undefined;
        const statusMode = parsed.statusId !== undefined;
        const flatMode = assigneeMode || statusMode;
        const statusId = parsed.statusId ?? task.statusId;
        if (statusMode) {
          await scope.statusTransitions.assertTransition(task, statusId,{prospective:completionScope(parsed)});
          requireSameProject(requireFound(await repo.findStatus(ws, statusId)), task.projectId, 'statusId');
        }
        if (assigneeMode) {
          await requireActiveMembers(repo, ws, parsed.responsibleMembershipId ?? null, []);
        }
        const responsibleMembershipId = assigneeMode ? parsed.responsibleMembershipId ?? null : task.responsibleMembershipId;
        const projectOrder = await listOrderScope(repo, ws, task.projectId);
        if (captureUndo && projectOrder.length > TASK_MOVE_UNDO_LIMITS.maxProjectTasks) throw ruleError('This project is too large to capture a move undo.', 'captureUndo');
        let anchor: TaskDto | null;
        if (parsed.anchorTaskId === null) {
          // Full project scope, never the filtered/loaded client group. Archived rows keep their relative order.
          anchor = projectOrder.filter(row => row.id !== id && row.archivedAt === null && (statusMode ? row.statusId === statusId : row.responsibleMembershipId === responsibleMembershipId)).at(-1) ?? null;
        } else {
          if (flatMode) {
            anchor = requireFound(await repo.findTask(ws, parsed.anchorTaskId));
            requireSameProject(anchor, task.projectId, 'anchorTaskId');
            if (anchor.archivedAt !== null) throw ruleError('The anchor task is archived.', 'anchorTaskId');
          } else anchor = await requireOrderAnchor(repo, ws, task.projectId, task.parentTaskId, parsed.anchorTaskId, 'anchorTaskId');
          if (assigneeMode && anchor.responsibleMembershipId !== responsibleMembershipId) {
            throw ruleError('The anchor belongs to another responsible person.', 'anchorTaskId');
          }
          if (statusMode && anchor.statusId !== statusId) {
            throw ruleError('The anchor belongs to another status lane.', 'anchorTaskId');
          }
        }
        // Legacy section moves take the root anchor's section; flat lane moves keep source section.
        let sectionId = task.sectionId;
        if (!flatMode && task.parentTaskId === null && anchor !== null) {
          sectionId = anchor.sectionId;
          if (sectionId !== null) await requireAssignableSection(repo, ws, task.projectId, sectionId);
        } else if (!flatMode && task.parentTaskId !== null && anchor?.sectionId !== task.sectionId) {
          throw ruleError('A subtask can only be moved within its own section.', 'anchorTaskId');
        }
        // A null anchor constrains only a non-empty active group, and a source already after its last member keeps its global slot.
        const anchorRank = projectOrder.findIndex(row => row.id === anchor?.id);
        const keepSlot = parsed.anchorTaskId === null && anchorRank < projectOrder.findIndex(row => row.id === id);
        const order = anchor === null || keepSlot ? projectOrder.map(row => (row.id === id ? null : row)) : placeInOrder(projectOrder, id, anchor.id, parsed.placement, 'anchorTaskId');
        const orderChanged = order.some((row, rank) => (row?.id ?? id) !== projectOrder[rank]?.id);
        const unchanged = sectionId === task.sectionId && responsibleMembershipId === task.responsibleMembershipId && statusId === task.statusId && !orderChanged;
        if (unchanged) return task;
        // Flat lane writes that keep the global order keep the numeric position, ties and gaps included; legacy moves always renumber.
        const renumber = !flatMode || orderChanged;
        await repo.saveTaskCore({ ...task, sectionId, responsibleMembershipId, statusId, position: renumber ? order.indexOf(null) : task.position, revision: task.revision + 1, updatedAt: now });
        const updated = await reloadTask(repo, ws, id);
        const diff = {
          ...changedFields(task, updated, statusMode ? ['statusId', 'position'] : assigneeMode ? ['sectionId', 'position', 'responsibleMembershipId'] : ['sectionId', 'position']),
          revision: { from: task.revision, to: updated.revision },
          anchor: { taskId: anchor?.id ?? null, placement: parsed.placement },
        };
        const activityPair = { before: task, after: updated };
        const labels = await loadTaskActivityLabels(scope, [activityPair]);
        await record(scope, 'task', id, 'updated', updated.revision, taskActivityDiff(activityPair, diff, labels), taskEventIds(updated));
        if (renumber) await saveShiftedTasks(scope, order, now);
        if (!captureUndo) return updated;
        // A no-op above returns without moveUndo: there is nothing to undo and no source is stored.
        // Same normalized actor, key and payload hash as the primary receipt that mutate writes next.
        const owner = normalizeContext(context);
        const receipt = { actorUserId: owner.actor.userId, key: owner.idempotencyKey, payloadHash: hash({ command: 'task.move', target: id, input: parsed }) };
        return { ...updated, moveUndo: await saveMoveUndoSource(scope, hash, receipt, task, projectOrder, now) };
      }, captureUndo ? async scope => {
        const current = requireFound(await scope.repository.findTask(scope.context.workspaceId, id));
        requireFound(await scope.repository.findProject(scope.context.workspaceId, current.projectId));
      } : undefined);
    },

    async restoreMoveTask(context: CommandContext, taskId: string, input: RestoreMoveTaskInput): Promise<MoveTaskDto> {
      const id = parsePathId(taskId);
      const parsed = parseInput<RestoreMoveTaskInput>(restoreMoveTaskInputSchema, input);
      const ctx = normalizeContext(context);
      const key = ctx.idempotencyKey;
      if (key === undefined || !IDEMPOTENCY_KEY_PATTERN.test(key)) throw validationError(['Idempotency-Key'], 'A valid Idempotency-Key is required.');
      const command = MOVE_RESTORE_COMMAND;
      const payloadHash = hash({ command, target: id, input: parsed });
      const ws = ctx.workspaceId, actorUserId = ctx.actor.userId;
      const outcome = await writer.run(ctx, 'task.edit', async (scope) => {
        const repo = scope.repository;
        // Current access to the actor's own stored source, its task and project precede any receipt replay.
        const stored = await repo.findIdempotency(ws, actorUserId, MOVE_UNDO_SOURCE_COMMAND, parsed.originalMoveKey);
        if (stored === null) throw notFoundError();
        const source = parseMoveUndoSource(stored.result);
        if (source === null) throw new Error('Stored move undo source does not match its contract.');
        if (source.taskId !== id || source.originalKey !== parsed.originalMoveKey) throw notFoundError();
        const task = requireFound(await repo.findTask(ws, id));
        requireSameProject(task, source.projectId, 'taskId');
        requireFound(await repo.findProject(ws, source.projectId));
        const existing = await repo.findIdempotency(ws, actorUserId, command, key);
        if (existing !== null) {
          if (existing.payloadHash !== payloadHash) throw new DomainError('IDEMPOTENCY_KEY_REUSED', 'This Idempotency-Key was already used for a different request.');
          if (isCommittedPlanningRejection(existing.result)) return existing.result;
          const replay = movedTaskSchema.safeParse(existing.result);
          if (!replay.success) throw new Error('Stored idempotent result does not match its contract.');
          return replay.data;
        }
        await requireOpenProject(repo, ws, task.projectId);
        expectRevision(task.revision, parsed.expectedRevision);
        if (task.archivedAt !== null) throw ruleError('The task is archived. Restore it before undoing its move.', 'taskId');
        // The client fingerprint only binds the request; the stored source and the re-read rows are the authority.
        if (parsed.expectedOrderFingerprint !== source.afterFingerprint) throw orderConflictError();
        const projectOrder = await listOrderScope(repo, ws, task.projectId);
        if (orderFingerprint(hash, task.projectId, projectOrder) !== source.afterFingerprint) throw orderConflictError();
        const positions = new Map(source.positions.map((row) => [row.taskId, row.position]));
        if (positions.size !== projectOrder.length || projectOrder.some((row) => !positions.has(row.id))) throw orderConflictError();
        if (task.parentTaskId !== source.before.parentTaskId) throw orderConflictError();
        const verifyHeads = (rows: readonly TaskDto[]) => {
          const expected = new Map(parsed.expectedHeads.map(row => [row.taskId, row.revision]));
          if (expected.size !== source.affectedTaskIds.length || source.affectedTaskIds.some(id => !expected.has(id))) throw orderConflictError();
          for (const id of source.affectedTaskIds) {
            const row = requireFound(rows.find(item => item.id === id) ?? null);
            expectRevision(row.revision, expected.get(id) ?? -1, 'expectedHeads');
          }
          if (expected.get(task.id) !== parsed.expectedRevision) throw orderConflictError();
        };
        verifyHeads(projectOrder);

        // Complete preflight of the stored restored fields before the guard and any proposed write.
        const target = source.before;
        if (target.statusId !== task.statusId) {
          await scope.statusTransitions.assertTransition(task, target.statusId,{prospective:completionScope(target)});
          requireSameProject(requireFound(await repo.findStatus(ws, target.statusId)), task.projectId, 'statusId');
        }
        await requireActiveMembers(repo, ws, target.responsibleMembershipId, [], { responsibleId: task.responsibleMembershipId, participantIds: [] });
        if (target.sectionId !== null && target.sectionId !== task.sectionId) await requireAssignableSection(repo, ws, task.projectId, target.sectionId);

        const now = scope.barrierAt.toISOString();
        // Deliberately mapped onto the task.move guard with the actual restored fields from the stored source.
        const rejected = await scope.planningGuard.check({
          family: 'task',
          command: 'task.move',
          target: id,
          input: {
            restore: MOVE_RESTORE_COMMAND,
            expectedRevision: parsed.expectedRevision,
            sectionId: target.sectionId,
            responsibleMembershipId: target.responsibleMembershipId,
            statusId: target.statusId,
          },
        });
        let result;
        if (rejected) result = rejected;
        else {
          // A cutoff prerequisite may write within this transaction; never restore from a pre-guard snapshot.
          const freshOrder = await listOrderScope(repo, ws, task.projectId);
          if (orderFingerprint(hash, task.projectId, freshOrder) !== source.afterFingerprint) throw orderConflictError();
          verifyHeads(freshOrder);
          const freshTask = requireFound(freshOrder.find(row => row.id === id) ?? null);
          result = await writeMoveRestore(scope, hash, freshTask, freshOrder, source, now);
        }
        await repo.insertIdempotency({ workspaceId: ws, actorUserId, command, idempotencyKey: key, payloadHash, result, createdAt: now });
        return result;
      });
      return unwrapPlanningOutcome(outcome);
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Validation and canonical form

/** Trusted context with canonical lowercase IDs, so hashes, replays and cursors are case-stable. */
function normalizeContext(context: CommandContext): CommandContext {
  const workspaceId = idSchema.safeParse(context.workspaceId);
  if (!workspaceId.success) throw notFoundError();
  const userId = idSchema.safeParse(context.actor.userId);
  if (!userId.success) throw unauthenticatedError();
  return { ...context, workspaceId: workspaceId.data, actor: { ...context.actor, userId: userId.data } };
}

/** A path ID that is not a UUID cannot name anything visible. */
function parsePathId(value: string): string {
  const parsed = idSchema.safeParse(value);
  if (!parsed.success) throw notFoundError();
  return parsed.data;
}

function parseInput<T>(schema: SafeParser<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (result.success) return result.data;
  throw validationError([...new Set(result.error.issues.map((issue) => issue.path.map(String).join('.') || '(root)'))]);
}

/** JSON with recursively sorted object keys; `undefined` members are omitted. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((item: unknown) => canonicalJson(item)).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => (left < right ? -1 : 1));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

function isSet<T>(value: T | null | undefined): value is T {
  return value !== undefined && value !== null;
}

// ---------------------------------------------------------------------------------------------
// Errors

function validationError(fields: string[], message = 'The request is invalid.'): DomainError {
  return new DomainError('VALIDATION_FAILED', message, { details: { fields } });
}

/** A visible object that breaks a domain rule (422). */
function ruleError(message: string, field: string): DomainError {
  return new DomainError('DOMAIN_VALIDATION_FAILED', message, { details: { fields: [field] } });
}

function requireFound<T>(value: T | null): T {
  if (value === null) throw notFoundError();
  return value;
}

function expectRevision(current: number, expected: number, field = 'expectedRevision'): void {
  if (current !== expected) {
    throw new DomainError('REVISION_CONFLICT', 'The resource was changed by someone else. Reload and retry.', {
      details: { fields: [field], currentRevision: current },
    });
  }
}

// ---------------------------------------------------------------------------------------------
// Reference checks (all inside the write transaction)

function requireSameProject(row: { projectId: string }, projectId: string, field: string): void {
  if (row.projectId !== projectId) throw ruleError('The referenced object belongs to another project.', field);
}

async function requireOpenProject(repo: TaskRepository, ws: string, projectId: string): Promise<ProjectDto> {
  const project = requireFound(await repo.findProject(ws, projectId));
  if (project.archivedAt !== null) throw ruleError('The project is archived.', 'projectId');
  return project;
}

async function requireAssignableSection(repo: TaskRepository, ws: string, projectId: string, sectionId: string) {
  const section = requireFound(await repo.findSection(ws, sectionId));
  requireSameProject(section, projectId, 'sectionId');
  if (section.archivedAt !== null) throw ruleError('The section is archived.', 'sectionId');
}

async function requireParent(repo: TaskRepository, ws: string, projectId: string, parentId: string): Promise<TaskDto> {
  const parent = requireFound(await repo.findTask(ws, parentId));
  requireSameProject(parent, projectId, 'parentTaskId');
  if (parent.archivedAt !== null) throw ruleError('The parent task is archived.', 'parentTaskId');
  return parent;
}

function requireParentPackage(parent: TaskDto | null): string {
  if (parent === null) throw new Error('A root task must create its own work package.');
  return parent.workPackageId;
}

/** Walks the full ancestor chain of the new parent; no depth limit. */
async function assertNoCycle(repo: TaskRepository, ws: string, taskId: string, parent: TaskDto): Promise<void> {
  const seen = new Set<string>();
  let current: TaskDto | null = parent;
  while (current !== null && !seen.has(current.id)) {
    if (current.id === taskId) throw ruleError('A task cannot be moved under itself or its subtasks.', 'parentTaskId');
    seen.add(current.id);
    current = current.parentTaskId === null ? null : await repo.findTask(ws, current.parentTaskId);
  }
}

/** References an existing task already holds; only these may outlive a revoked membership. */
interface RetainedMembers {
  readonly responsibleId: string | null;
  /** Membership IDs of currently active participant rows. */
  readonly participantIds: readonly string[];
}

const NO_RETAINED_MEMBERS: RetainedMembers = { responsibleId: null, participantIds: [] };

/**
 * New assignments need an active membership of this workspace; anything else (foreign, missing,
 * revoked) is the generic NOT_FOUND. On update, keeping the current responsible person or an
 * already active participant row is allowed after their membership was revoked; reactivating an
 * inactive row is a new assignment. Removing or clearing never needs a check.
 */
async function requireActiveMembers(
  repo: TaskRepository,
  ws: string,
  responsibleId: string | null,
  participantIds: readonly string[],
  retained: RetainedMembers = NO_RETAINED_MEMBERS,
): Promise<void> {
  const retainedParticipants = new Set(retained.participantIds.map((id) => id.toLowerCase()));
  const newAssignments = participantIds.filter((id) => !retainedParticipants.has(id.toLowerCase()));
  if (responsibleId !== null && responsibleId.toLowerCase() !== retained.responsibleId?.toLowerCase()) {
    newAssignments.push(responsibleId);
  }
  if (newAssignments.length === 0) return;
  const active = new Set(
    (await repo.access.listActiveMemberships(ws))
      .filter((membership) => membership.state === 'active' && membership.workspaceId === ws)
      .map((membership) => membership.id.toLowerCase()),
  );
  if (newAssignments.some((id) => !active.has(id.toLowerCase()))) throw notFoundError();
}

/** Tags must exist in the workspace; archived tags may stay on a task but cannot be newly assigned. */
async function requireAssignableTags(
  repo: TaskRepository,
  ws: string,
  tagIds: readonly string[],
  currentTagIds: readonly string[],
): Promise<void> {
  for (const tagId of tagIds) {
    const tag = requireFound(await repo.findTag(ws, tagId));
    if (tag.archivedAt !== null && !currentTagIds.includes(tagId)) {
      throw ruleError('Archived tags cannot be assigned.', 'tagIds');
    }
  }
}

/** Active tags only; the database unique constraint also covers archived names. */
async function assertTagNameFree(repo: TaskRepository, ws: string, name: string, exceptId: string | null) {
  const key = name.toLowerCase();
  const clash = (await repo.listTags(ws)).some((tag) => tag.id !== exceptId && tag.name.toLowerCase() === key);
  if (clash) throw ruleError('A tag with this name already exists.', 'name');
}

// ---------------------------------------------------------------------------------------------
// State helpers

function nextPosition(positions: readonly number[]): number {
  const max = positions.reduce((highest, position) => Math.max(highest, position), -1);
  if (max >= MAX_POSITION) throw ruleError('The list has no free position at its end; pass a position.', 'position');
  return max + 1;
}

function nextArchivedAt(current: string | null, archived: boolean | undefined, now: string): string | null {
  if (archived === undefined) return current;
  return archived ? (current ?? now) : null;
}

function newParticipant(membershipId: string): TaskParticipantDto {
  return { membershipId, role: 'assignee', active: true, revision: 1 };
}

/**
 * Participant rows to upsert. Rows keep their identity: removed members are deactivated and
 * re-added members reactivate their old row; each state change bumps that row's revision.
 */
function nextParticipantRows(
  current: readonly TaskParticipantDto[],
  desired: readonly string[],
): { rows: TaskParticipantDto[]; added: string[]; removed: string[] } {
  const wanted = new Set(desired);
  const known = new Set<string>();
  const rows: TaskParticipantDto[] = [];
  const added: string[] = [];
  const removed: string[] = [];
  for (const row of current) {
    known.add(row.membershipId);
    const active = wanted.has(row.membershipId);
    if (active !== row.active) {
      rows.push({ ...row, active, revision: row.revision + 1 });
      (active ? added : removed).push(row.membershipId);
    }
  }
  for (const membershipId of desired) {
    if (!known.has(membershipId)) {
      rows.push(newParticipant(membershipId));
      added.push(membershipId);
    }
  }
  return { rows, added, removed };
}

function changedFields<T extends object>(
  before: T,
  after: T,
  keys: readonly (keyof T & string)[],
): Record<string, { from: unknown; to: unknown }> {
  const diff: Record<string, { from: unknown; to: unknown }> = {};
  for (const key of keys) {
    if (canonicalJson(before[key]) !== canonicalJson(after[key])) diff[key] = { from: before[key], to: after[key] };
  }
  return diff;
}

async function reloadTask(repo: TaskRepository, ws: string, id: string): Promise<TaskDto> {
  const task = await repo.findTask(ws, id);
  if (task === null) throw new Error('Task is missing inside its own transaction.');
  return task;
}

/**
 * All descendants of `root` in its project whose archive state matches `archivedAt` (null: active ones, a timestamp: those
 * archived at exactly that instant). Children are visited parent first.
 */
async function descendantsOf(repo: TaskRepository, ws: string, root: TaskDto, archivedAt: string | null): Promise<TaskDto[]> {
  const rows = await listOrderScope(repo, ws, root.projectId);
  const byParent = new Map<string, TaskDto[]>();
  for (const row of rows) if (row.parentTaskId !== null) byParent.set(row.parentTaskId, [...(byParent.get(row.parentTaskId) ?? []), row]);
  const found: TaskDto[] = [];
  const queue = [root.id];
  for (let head = 0; head < queue.length; head += 1) {
    for (const child of byParent.get(queue[head] ?? '') ?? []) {
      if (child.archivedAt === archivedAt) found.push(child);
      // A restore must not reactivate a descendant below a separately archived parent.
      if (archivedAt === null || child.archivedAt === archivedAt) queue.push(child.id);
    }
  }
  return found;
}

async function setTaskArchivedAt(
  scope: TaskWriteScope,
  task: TaskDto,
  archivedAt: string | null,
  now: string,
  action: 'archived' | 'restored',
): Promise<TaskDto> {
  const ws = task.workspaceId;
  await scope.repository.saveTaskCore({ ...task, archivedAt, revision: task.revision + 1, updatedAt: now });
  const updated = await reloadTask(scope.repository, ws, task.id);
  const diff = { archivedAt: { from: task.archivedAt, to: archivedAt }, revision: { from: task.revision, to: updated.revision } };
  await record(scope, 'task', task.id, action, updated.revision, diff, taskEventIds(updated));
  return updated;
}

/** Minimal outbox IDs: enough for clients to invalidate the project task list and shared budgets. */
function taskEventIds(task: TaskDto): Record<string, unknown> {
  return {
    projectId: task.projectId,
    workPackageId: task.workPackageId,
    workPackageRevision: task.workPackageRevision,
    participantsRevision: task.participantsRevision,
  };
}

/** One audit event with its outbox event per command; the outbox carries IDs and revisions only. */
function record(
  scope: TaskWriteScope,
  entityType: 'project' | 'section' | 'tag' | 'task',
  entityId: string,
  action: 'created' | 'updated' | 'archived' | 'restored',
  entityRevision: number,
  diff: Record<string, unknown>,
  ids: Record<string, unknown>,
): Promise<RecordedChange> {
  return scope.recordChange({
    entityType,
    entityId,
    action,
    entityRevision,
    diff,
    outbox: {
      type: `${entityType}.${action}`,
      payload: { workspaceId: scope.context.workspaceId, [`${entityType}Id`]: entityId, revision: entityRevision, ...ids },
    },
  });
}

/** Shared validated in-transaction primitive. Caller owns current authorization, barrier, guard and receipt. */
export async function createTaskInScope(scope:TaskWriteScope,input:CreateTaskInput,tools:Pick<TaskApplicationDependencies['tools'],'newId'>,completionFieldValues:readonly {readonly fieldId:string;readonly value:TaskFieldData}[]=[]):Promise<TaskDto> {
 const parsed=parseInput<CreateTaskInput>(createTaskInputSchema,input),ws=scope.context.workspaceId,now=scope.barrierAt.toISOString();
 const newId=()=>idSchema.parse(tools.newId());
        const repo = scope.repository;
        const projectId = parsed.projectId;
        assertTaskDateRange(parsed.startDate,parsed.dueDate);
        await requireOpenProject(repo, ws, projectId);
        if (isSet(parsed.sectionId)) await requireAssignableSection(repo, ws, projectId, parsed.sectionId);
        requireSameProject(requireFound(await repo.findStatus(ws, parsed.statusId)), projectId, 'statusId');
        const parent = isSet(parsed.parentTaskId) ? await requireParent(repo, ws, projectId, parsed.parentTaskId) : null;
        const participantIds = parsed.participantMembershipIds ?? [];
        await requireActiveMembers(repo, ws, parsed.responsibleMembershipId ?? null, participantIds);
        const tagIds = parsed.tagIds ?? [];
        await requireAssignableTags(repo, ws, tagIds, []);

        // Only an explicit insertion renumbers the project order; otherwise the legacy append below is unchanged.
        let order: (TaskDto | null)[] | null = null;
        if (parsed.insertion !== undefined) {
          const sectionId = parsed.sectionId ?? null;
          const parentTaskId = parent?.id ?? null;
          const field = 'insertion.anchorTaskId';
          const anchor = await requireOrderAnchor(repo, ws, projectId, parentTaskId, parsed.insertion.anchorTaskId, field);
          if (anchor.sectionId !== sectionId) throw ruleError('The anchor task is in another section.', field);
          order = placeInOrder(await listOrderScope(repo, ws, projectId), null, anchor.id, parsed.insertion.placement, field);
        }

        // Root tasks and added scope get a new package; a detail subtask shares its parent's.
        let workPackage: WorkPackageRecord | null = null;
        if (parent === null || parsed.workScope === 'added_scope') {
          workPackage = {
            id: newId(),
            workspaceId: ws,
            projectId,
            origin: parent === null ? 'new_task' : 'added_scope',
            sourcePackageId: parent === null ? null : parent.workPackageId,
            estimateMinutes: parsed.estimateMinutes ?? null,
            revision: 1,
            createdAt: now,
            updatedAt: now,
          };
          await repo.insertWorkPackage(workPackage);
        }
        const workPackageId = workPackage?.id ?? requireParentPackage(parent);
        const position =
          order !== null
            ? order.indexOf(null)
            : parsed.position ??
              nextPosition(
                (await repo.listTasks(ws, { projectId, includeArchived: true, limit: 200 }, null, MAX_POSITION)).map(
                  (task) => task.position,
                ),
              );

        const id = newId();
        await repo.insertTaskCore({
          id,
          workspaceId: ws,
          projectId,
          sectionId: parsed.sectionId ?? null,
          parentTaskId: parent?.id ?? null,
          workPackageId,
          workPackageRevision: workPackage?.revision ?? parent?.workPackageRevision ?? 1,
          title: parsed.title,
          description: parsed.description ?? '',
          statusId: parsed.statusId,
          responsibleMembershipId: parsed.responsibleMembershipId ?? null,
          participants: [],
          participantsRevision: 1,
          startDate: parsed.startDate ?? null,
          dueDate: parsed.dueDate ?? null,
          priority: parsed.priority ?? 'none',
          tags: [],
          estimateMinutes: workPackage?.estimateMinutes ?? parent?.estimateMinutes ?? null,
          revision: 1,
          position,
          visibility: 'workspace',
          archivedAt: null,
          createdAt: now,
          updatedAt: now,
        });
        if (participantIds.length > 0) {
          const rows = participantIds.map((membershipId) => newParticipant(membershipId));
          await repo.saveParticipants(ws, id, rows, now);
        }
        if (tagIds.length > 0) await repo.setTaskTagIds(ws, id, tagIds);

        const task = await reloadTask(repo, ws, id);
        await scope.statusTransitions.assertTransition(task,task.statusId,{creating:true,fieldValues:completionFieldValues});
        const activityPair = { before: null, after: task };
        const labels = await loadTaskActivityLabels(scope, [activityPair]);
        await record(
          scope,
          'task',
          id,
          'created',
          task.revision,
          taskActivityDiff(activityPair, {
            title: task.title,
            parentTaskId: task.parentTaskId,
            statusId: task.statusId,
            sectionId: task.sectionId,
            responsibleMembershipId: task.responsibleMembershipId,
            participantMembershipIds: participantIds,
            tagIds,
            workPackage: {
              id: workPackageId,
              created: workPackage !== null,
              revision: task.workPackageRevision,
              estimateMinutes: task.estimateMinutes,
            },
            ...(parsed.insertion === undefined ? {} : { position: task.position, insertion: parsed.insertion }),
          }, labels),
          taskEventIds(task),
        );
        if (order !== null) await saveShiftedTasks(scope, order, now);
        return task;
}

// ---------------------------------------------------------------------------------------------
// Manual order

/**
 * The complete project-global manual order: every task of the project, all parents and sections,
 * archived rows included, sorted by (position, id). Manual position is one sequence per project,
 * so no parent/section filter applies. The take is MAX_POSITION so no page limit hides rows.
 */
async function listOrderScope(repo: TaskRepository, ws: string, projectId: string): Promise<TaskDto[]> {
  const rows = await repo.listTasks(ws, { projectId, includeArchived: true, limit: 200 }, null, MAX_POSITION);
  return rows.sort((a, b) => a.position - b.position || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/** An active sibling of the placed task; archived rows keep their place but cannot anchor. */
async function requireOrderAnchor(
  repo: TaskRepository,
  ws: string,
  projectId: string,
  parentTaskId: string | null,
  anchorId: string,
  field: string,
): Promise<TaskDto> {
  const anchor = requireFound(await repo.findTask(ws, anchorId));
  requireSameProject(anchor, projectId, field);
  if (anchor.archivedAt !== null) throw ruleError('The anchor task is archived.', field);
  if (anchor.parentTaskId !== parentTaskId) throw ruleError('The anchor task has a different parent.', field);
  return anchor;
}

/**
 * Full project order with the placed task as `null` directly before/after the anchor; every other
 * row (other sections, parents, hidden, archived or unloaded) keeps its relative order.
 */
function placeInOrder(
  projectOrder: readonly TaskDto[],
  placedId: string | null,
  anchorId: string,
  placement: TaskInsertion['placement'],
  field: string,
): (TaskDto | null)[] {
  const order: (TaskDto | null)[] = projectOrder.filter((row) => row.id !== placedId);
  const at = order.findIndex((row) => row?.id === anchorId);
  if (at < 0) throw new Error('The order anchor is missing from its own project order.');
  order.splice(placement === 'before' ? at : at + 1, 0, null);
  if (order.length - 1 > MAX_POSITION) throw ruleError('The list is too long to reorder.', field);
  return order;
}

/** Renumbers the full project order to 0..N-1; each changed existing row gets one position/revision event. */
async function saveShiftedTasks(scope: TaskWriteScope, order: readonly (TaskDto | null)[], now: string): Promise<void> {
  for (const [position, row] of order.entries()) {
    if (row === null || row.position === position) continue;
    const revision = row.revision + 1;
    await scope.repository.saveTaskCore({ ...row, position, revision, updatedAt: now });
    const diff = { position: { from: row.position, to: position }, revision: { from: row.revision, to: revision } };
    await record(scope, 'task', row.id, 'updated', revision, diff, taskEventIds(row));
  }
}

// ---------------------------------------------------------------------------------------------
// Move undo

/** Any foreign order or grouping change since the move: conservative, the client reloads instead. */
function orderConflictError(): DomainError {
  return new DomainError('REVISION_CONFLICT', 'The task order changed after this move. Reload before undoing it.', {
    details: { fields: ['expectedOrderFingerprint'] },
  });
}

/**
 * Stores the server-only inverse source of a move that wrote, in the same transaction, under the
 * real Idempotency-Key of that move, and returns its compact public ACK.
 */
async function saveMoveUndoSource(
  scope: TaskWriteScope,
  hash: (value: unknown) => string,
  receipt: { readonly actorUserId: string; readonly key: string | undefined; readonly payloadHash: string },
  before: TaskDto,
  beforeOrder: readonly TaskDto[],
  now: string,
): Promise<MoveUndoAck> {
  const { actorUserId, key, payloadHash } = receipt;
  if (key === undefined) throw new Error('A captured move needs its real Idempotency-Key.');
  const ws = before.workspaceId;
  const afterOrder = await listOrderScope(scope.repository, ws, before.projectId);
  const after = afterOrder.find((row) => row.id === before.id);
  if (after === undefined) throw new Error('Task is missing inside its own transaction.');
  const source: MoveUndoSource = {
    v: 1,
    taskId: before.id,
    projectId: before.projectId,
    originalKey: key,
    before: moveGroupOf(before),
    after: moveGroupOf(after),
    affectedTaskIds: revisionHeads(beforeOrder, afterOrder).afterHeads.map(row => row.taskId),
    positions: beforeOrder.map((row) => ({ taskId: row.id, position: row.position })),
    beforeFingerprint: orderFingerprint(hash, before.projectId, beforeOrder),
    afterFingerprint: orderFingerprint(hash, before.projectId, afterOrder),
  };
  await scope.repository.insertIdempotency({
    workspaceId: ws,
    actorUserId,
    command: MOVE_UNDO_SOURCE_COMMAND,
    idempotencyKey: key,
    payloadHash,
    result: source,
    createdAt: now,
  });
  return { originalKey: key, orderFingerprint: source.afterFingerprint, ...revisionHeads(beforeOrder, afterOrder) };
}

/**
 * Restores the source task's grouping and every row's exact captured position as a new audited write:
 * each written row gets revision + 1 and one event; history, receipts and other fields stay untouched.
 */
async function writeMoveRestore(
  scope: TaskWriteScope,
  hash: (value: unknown) => string,
  task: TaskDto,
  projectOrder: readonly TaskDto[],
  source: MoveUndoSource,
  now: string,
): Promise<MoveTaskDto> {
  const repo = scope.repository, ws = task.workspaceId;
  const positions = new Map(source.positions.map((row) => [row.taskId, row.position]));
  const position = positions.get(task.id);
  if (position === undefined) throw new Error('The move undo source misses its own task.');
  const { sectionId, responsibleMembershipId, statusId } = source.before;
  await repo.saveTaskCore({ ...task, sectionId, responsibleMembershipId, statusId, position, revision: task.revision + 1, updatedAt: now });
  const updated = await reloadTask(repo, ws, task.id);
  const diff = {
    ...changedFields(task, updated, ['sectionId', 'position', 'responsibleMembershipId', 'statusId']),
    revision: { from: task.revision, to: updated.revision },
    restore: { command: 'task.move' },
  };
  const activityPair = { before: task, after: updated };
  const labels = await loadTaskActivityLabels(scope, [activityPair]);
  await record(scope, 'task', task.id, 'updated', updated.revision, taskActivityDiff(activityPair, diff, labels), taskEventIds(updated));
  for (const row of projectOrder) {
    const restored = positions.get(row.id);
    if (row.id === task.id || restored === undefined || restored === row.position) continue;
    const revision = row.revision + 1;
    await repo.saveTaskCore({ ...row, position: restored, revision, updatedAt: now });
    const rowDiff = { position: { from: row.position, to: restored }, revision: { from: row.revision, to: revision } };
    await record(scope, 'task', row.id, 'updated', revision, rowDiff, taskEventIds(row));
  }
  const afterOrder = await listOrderScope(repo, ws, task.projectId);
  const fingerprint = orderFingerprint(hash, task.projectId, afterOrder);
  // Internal invariant; throwing rolls back every write of this command.
  if (fingerprint !== source.beforeFingerprint) throw new Error('Move restore did not reproduce its captured order.');
  return { ...updated, moveUndo: { originalKey: source.originalKey, orderFingerprint: fingerprint, ...revisionHeads(projectOrder, afterOrder) } };
}

/** Only fields used by a completion rule; omitted keys retain the current task values. */
function completionScope(value:{parentTaskId?:string|null|undefined;responsibleMembershipId?:string|null|undefined;dueDate?:string|null|undefined;tagIds?:readonly string[]|undefined}){
 return{...(value.parentTaskId===undefined?{}:{parentTaskId:value.parentTaskId}),...(value.responsibleMembershipId===undefined?{}:{responsibleMembershipId:value.responsibleMembershipId}),...(value.dueDate===undefined?{}:{dueDate:value.dueDate}),...(value.tagIds===undefined?{}:{tagIds:value.tagIds})};
}

/** Shared validated section creator; caller owns the mandatory guard and the outer receipt. */
export async function createSectionInScope(scope: TaskWriteScope, projectId: string, input: CreateSectionInput, tools: Pick<TaskApplicationDependencies['tools'], 'newId'>): Promise<SectionDto> {
  const parsed = parseInput<CreateSectionInput>(createSectionInputSchema, input), ws = scope.context.workspaceId;
  await requireOpenProject(scope.repository, ws, projectId);
  const position = parsed.position ?? nextPosition((await scope.repository.listSections(ws, projectId)).map(section => section.position));
  const section: SectionDto = { id: idSchema.parse(tools.newId()), workspaceId: ws, projectId, name: parsed.name, position, revision: 1, archivedAt: null };
  await scope.repository.insertSection(section);
  await record(scope, 'section', section.id, 'created', 1, { name: section.name, position }, { projectId });
  return section;
}
