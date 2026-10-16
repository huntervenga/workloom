import {assertTaskDateRange,assertOrdinaryTaskDates} from './dates.js';
import type { TaskMutationCommand } from '../planning/ports.js';
import { isCommittedPlanningRejection, unwrapPlanningOutcome } from '../planning/freeze.js';
import {
  archiveTaskInputSchema,
  createProjectInputSchema,
  createSectionInputSchema,
  createTagInputSchema,
  createTaskInputSchema,
  idSchema,
  projectSchema,
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
  type CreateProjectInput,
  type CreateSectionInput,
  type CreateTagInput,
  type CreateTaskInput,
  type ProjectDto,
  type RestoreTaskInput,
  type SectionDto,
  type TagDto,
  type TaskDto,
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
import type { TaskApplication, TaskPage } from './application.js';
import type { TaskApplicationDependencies, TaskRepository, TaskWriteScope, WorkPackageRecord } from './ports.js';

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
    async listProjects(context: CommandContext): Promise<ProjectDto[]> {
      const ctx = await authorizeRead(context);
      return reader.listProjects(ctx.workspaceId);
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
          archivedAt: nextArchivedAt(project.archivedAt, parsed.archived, now),
          revision: project.revision + 1,
          updatedAt: now,
        };
        await scope.repository.saveProject(next);
        await record(scope, 'project', id, 'updated', next.revision, changedFields(project, next, ['name', 'archivedAt']), {});
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
      return mutate(context, 'task.edit', 'section.create', id, parsed, sectionSchema, async (scope, ws) => {
        const repo = scope.repository;
        await requireOpenProject(repo, ws, id);
        const position =
          parsed.position ?? nextPosition((await repo.listSections(ws, id)).map((section) => section.position));
        const section: SectionDto = {
          id: newId(),
          workspaceId: ws,
          projectId: id,
          name: parsed.name,
          position,
          revision: 1,
          archivedAt: null,
        };
        await repo.insertSection(section);
        await record(scope, 'section', section.id, 'created', 1, { name: section.name, position }, { projectId: id });
        return section;
      });
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

    async listTags(context: CommandContext): Promise<TagDto[]> {
      const ctx = await authorizeRead(context);
      return reader.listTags(ctx.workspaceId);
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

      const { cursor, ...filters } = query;
      const permissionEpoch = await reader.permissionEpoch(ws);
      const queryHash = hash(filters);
      const binding = { version: 1, workspaceId: ws, actorUserId: ctx.actor.userId, permissionEpoch, queryHash } as const;

      let after: { position: number; id: string } | null = null;
      if (cursor !== undefined) {
        const payload = tools.decodeCursor(cursor);
        const bound =
          payload.version === binding.version &&
          payload.workspaceId === binding.workspaceId &&
          payload.actorUserId === binding.actorUserId &&
          payload.permissionEpoch === binding.permissionEpoch &&
          payload.queryHash === binding.queryHash;
        if (!bound) throw validationError(['cursor'], 'The cursor is no longer valid. Reload the list.');
        after = { position: payload.position, id: payload.id };
      }

      const rows = await reader.listTasks(ws, filters, after, query.limit + 1);
      const items = rows.slice(0, query.limit);
      const last = items.at(-1);
      const nextCursor =
        rows.length > query.limit && last !== undefined
          ? tools.encodeCursor({ ...binding, position: last.position, id: last.id })
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
      return mutate(context, 'task.edit', 'task.create', null, parsed, taskSchema, scope => createTaskInScope(scope,parsed,tools));
    },

    async updateTask(context: CommandContext, taskId: string, input: UpdateTaskInput): Promise<TaskDto> {
      const id = parsePathId(taskId);
      const parsed = parseInput<UpdateTaskInput>(updateTaskInputSchema, input);
      return mutate(context, 'task.edit', 'task.update', id, parsed, taskSchema, async (scope, ws, now) => {
        const repo = scope.repository;
        const task = requireFound(await repo.findTask(ws, id));
        expectRevision(task.revision, parsed.expectedRevision);
        if (task.archivedAt !== null) throw ruleError('The task is archived. Restore it before editing.', 'taskId');

        assertOrdinaryTaskDates(task,parsed);
        // Every provided reference is validated, even when it equals the current value.
        if (parsed.statusId !== undefined) {
          await scope.statusTransitions.assertTransition(task,parsed.statusId);
          requireSameProject(requireFound(await repo.findStatus(ws, parsed.statusId)), task.projectId, 'statusId');
        }
        if (isSet(parsed.sectionId)) await requireAssignableSection(repo, ws, task.projectId, parsed.sectionId);
        if (isSet(parsed.parentTaskId)) {
          const parent = await requireParent(repo, ws, task.projectId, parsed.parentTaskId);
          await assertNoCycle(repo, ws, task.id, parent);
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
          sectionId: parsed.sectionId === undefined ? task.sectionId : parsed.sectionId,
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
        await record(scope, 'task', id, 'updated', updated.revision, diff, taskEventIds(updated));
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
        return setTaskArchivedAt(scope, task, null, now, 'restored');
      });
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
export async function createTaskInScope(scope:TaskWriteScope,input:CreateTaskInput,tools:Pick<TaskApplicationDependencies['tools'],'newId'>):Promise<TaskDto> {
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
          parsed.position ??
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
        await record(
          scope,
          'task',
          id,
          'created',
          task.revision,
          {
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
          },
          taskEventIds(task),
        );
        return task;
}
