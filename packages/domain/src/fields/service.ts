import type { FieldMutationCommand } from '../planning/ports.js';
import { isCommittedPlanningRejection, unwrapPlanningOutcome } from '../planning/freeze.js';
import {
  createTaskFieldInputSchema,
  createTaskFieldOptionInputSchema,
  idSchema,
  projectColumnsSchema,
  setTaskFieldValueInputSchema,
  taskFieldBatchQuerySchema,
  taskFieldDefinitionSchema,
  taskFieldHistoryQuerySchema,
  taskFieldValueSchema,
  updateProjectColumnsInputSchema,
  updateTaskFieldInputSchema,
  updateTaskFieldOptionInputSchema,
  type CreateTaskFieldInput,
  type CreateTaskFieldOptionInput,
  type ProjectColumnsDto,
  type ProjectDto,
  type SetTaskFieldValueInput,
  type TaskDto,
  type TaskFieldBatchQuery,
  type TaskFieldData,
  type TaskFieldDefinitionDto,
  type TaskFieldHistoryQuery,
  type TaskFieldOptionDto,
  type TaskFieldType,
  type TaskFieldValueDto,
  type UpdateProjectColumnsInput,
  type UpdateTaskFieldInput,
  type UpdateTaskFieldOptionInput,
} from '@workloom/contracts';

import { authorizeWorkspace } from '../access/access-queries.js';
import type { Capability } from '../access/capabilities.js';
import type { CommandContext } from '../access/context.js';
import { DomainError, notFoundError, unauthenticatedError } from '../errors.js';
import { canonicalJson } from '../tasks/service.js';
import type { TaskRepository } from '../tasks/ports.js';
import type { RecordedChange } from '../transactions/ports.js';
import type { TaskFieldApplication, TaskFieldHistoryPage } from './application.js';
import type {
  TaskFieldApplicationDependencies,
  TaskFieldHistoryAnchor,
  TaskFieldHistoryCursorPayload,
  TaskFieldOptionRecord,
  TaskFieldRepository,
  TaskFieldWriteScope,
} from './ports.js';

const MAX_POSITION = 2_147_483_647;
const MAX_ACTIVE_FIELDS = 100;
const MAX_OPTIONS = 100;
const DEFAULT_COLUMN_WIDTH = 160;
/** Same rule as the HTTP adapter: visible ASCII, 1–128 characters. */
const IDEMPOTENCY_KEY_PATTERN = /^[\x21-\x7e]{1,128}$/;
const CHANGE_SEQ_PATTERN = /^(0|[1-9][0-9]{0,19})$/;

const SELECT_TYPES: readonly TaskFieldType[] = ['single_select', 'multi_select'];
/** Definition columns whose change bumps the field revision and writes a new version. */
const FIELD_KEYS = ['name', 'historyEnabled', 'locked', 'archivedAt'] as const;
const OPTION_KEYS = ['name', 'color', 'position', 'archivedAt'] as const;

type ProjectColumn = ProjectColumnsDto['columns'][number];
type DefinitionChanges = Partial<Pick<TaskFieldDefinitionDto, 'name' | 'historyEnabled' | 'locked' | 'archivedAt' | 'options'>>;

/** Structural view of a Zod schema, so the domain needs no direct Zod dependency. */
interface SafeParser<T> {
  safeParse(value: unknown):
    | { success: true; data: T }
    | { success: false; error: { issues: readonly { path: readonly PropertyKey[] }[] } };
}

/**
 * P1b custom field application. Same protocol as the task application: every call re-validates
 * its input with the shared contract schema and canonicalizes IDs; reads authorize the current
 * membership for `task.read`; every mutation runs under the workspace barrier, which re-checks the
 * capability before an idempotent replay, and commits state, audit, outbox and history together.
 */
export function createTaskFieldApplication(dependencies: TaskFieldApplicationDependencies): TaskFieldApplication {
  const { reader, writer, tools } = dependencies;

  const newId = (): string => idSchema.parse(tools.newId());
  const hash = (value: unknown): string => tools.digest(canonicalJson(value));

  async function authorizeRead(context: CommandContext): Promise<CommandContext> {
    const ctx = normalizeContext(context);
    await authorizeWorkspace(reader.tasks.access, ctx, 'task.read');
    return ctx;
  }

  /**
   * Runs one idempotent command. The key is scoped by workspace, actor and command; the payload
   * hash covers every target ID and the parsed input. A stored result is replayed without any
   * state, audit, outbox or history write; a different payload under that key is rejected. Only
   * successful outcomes (no-ops included) are stored, since any error rolls the unit back.
   */
  async function mutate<R>(
    context: CommandContext,
    capability: Capability,
    command: FieldMutationCommand,
    target: unknown,
    input: unknown,
    resultSchema: SafeParser<R>,
    work: (scope: TaskFieldWriteScope, workspaceId: string, now: string) => Promise<R>,
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
      const idempotency = scope.repository.tasks;
      const existing = await idempotency.findIdempotency(workspaceId, actorUserId, command, key);
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
      const rejected = await scope.planningGuard.check({ family: 'field', command, target, input });
      const result = rejected ?? await work(scope, workspaceId, now);
      await idempotency.insertIdempotency({
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

  /** Every meaningful definition or option change: revision + 1 and a new immutable version. */
  function nextDefinition(field: TaskFieldDefinitionDto, changes: DefinitionChanges, now: string): TaskFieldDefinitionDto {
    return { ...field, ...changes, revision: field.revision + 1, definitionVersionId: newId(), updatedAt: now };
  }

  /** Header revision + 1 with exactly `columns`; recorded as its own audit and outbox event. */
  async function writeColumns(
    scope: TaskFieldWriteScope,
    current: ProjectColumnsDto,
    columns: ProjectColumn[],
    reason: string,
  ): Promise<ProjectColumnsDto> {
    const next: ProjectColumnsDto = { ...current, revision: current.revision + 1, columns };
    await scope.repository.saveProjectColumns(next);
    await record(
      scope,
      'project_columns',
      next.projectId,
      'updated',
      next.revision,
      { reason, revision: { from: current.revision, to: next.revision }, fieldIds: columns.map((column) => column.fieldId) },
      { projectId: next.projectId, revision: next.revision },
    );
    return next;
  }

  function decodeHistoryCursor(token: string): TaskFieldHistoryCursorPayload {
    try {
      return tools.decodeHistoryCursor(token);
    } catch (error) {
      throw new DomainError('VALIDATION_FAILED', CURSOR_MESSAGE, { details: { fields: ['cursor'] }, cause: error });
    }
  }

  return {
    async listFields(context: CommandContext, projectId: string): Promise<TaskFieldDefinitionDto[]> {
      const id = parsePathId(projectId);
      const ctx = await authorizeRead(context);
      requireFound(await reader.tasks.findProject(ctx.workspaceId, id));
      return reader.listFields(ctx.workspaceId, id);
    },

    async createField(context: CommandContext, input: CreateTaskFieldInput): Promise<TaskFieldDefinitionDto> {
      const parsed = parseInput<CreateTaskFieldInput>(createTaskFieldInputSchema, input);
      return mutate(context, 'fields.manage', 'field.create', null, parsed, taskFieldDefinitionSchema, async (scope, ws, now) => {
        const repo = scope.repository;
        const projectId = parsed.projectId;
        await requireOpenProject(repo.tasks, ws, projectId);
        if (!SELECT_TYPES.includes(parsed.type) && parsed.options.length > 0) {
          throw ruleError('Only select fields have options.', 'options');
        }
        const siblings = await repo.listFields(ws, projectId);
        assertFieldNameFree(siblings, parsed.name, null);
        assertActiveFieldCapacity(siblings, null);
        const options: TaskFieldOptionDto[] = [];
        for (const [position, option] of parsed.options.entries()) {
          assertOptionNameFree(options, option.name, null);
          options.push({ id: newId(), name: option.name, color: option.color, position, revision: 1, archivedAt: null });
        }

        const field: TaskFieldDefinitionDto = {
          id: newId(),
          workspaceId: ws,
          projectId,
          name: parsed.name,
          type: parsed.type,
          revision: 1,
          definitionVersionId: newId(),
          historyEnabled: parsed.historyEnabled,
          locked: parsed.locked,
          archivedAt: null,
          options,
          createdAt: now,
          updatedAt: now,
        };
        await repo.insertField(field);
        for (const option of options) await repo.insertOption(toOptionRecord(field, option));
        await repo.insertDefinitionVersion(field);
        await recordField(scope, field, 'created', {
          name: field.name,
          type: field.type,
          historyEnabled: field.historyEnabled,
          locked: field.locked,
          options: options.map(optionMetadata),
        });

        const columns = await loadColumns(repo, ws, projectId);
        await writeColumns(scope, columns, appendColumn(columns.columns, field.id), 'field_created');
        return field;
      });
    },

    async updateField(context: CommandContext, fieldId: string, input: UpdateTaskFieldInput): Promise<TaskFieldDefinitionDto> {
      const id = parsePathId(fieldId);
      const parsed = parseInput<UpdateTaskFieldInput>(updateTaskFieldInputSchema, input);
      return mutate(context, 'fields.manage', 'field.update', id, parsed, taskFieldDefinitionSchema, async (scope, ws, now) => {
        const repo = scope.repository;
        const field = requireFound(await repo.findField(ws, id));
        expectRevision(field.revision, parsed.expectedRevision);
        if (parsed.type !== undefined && parsed.type !== field.type) {
          throw ruleError('The field type cannot be changed.', 'type');
        }
        await requireOpenProject(repo.tasks, ws, field.projectId);

        const candidate: TaskFieldDefinitionDto = {
          ...field,
          name: parsed.name ?? field.name,
          historyEnabled: parsed.historyEnabled ?? field.historyEnabled,
          locked: parsed.locked ?? field.locked,
          archivedAt: nextArchivedAt(field.archivedAt, parsed.archived, now),
        };
        const diff = changedFields(field, candidate, FIELD_KEYS);
        if (Object.keys(diff).length === 0) return field;

        const archiving = field.archivedAt === null && candidate.archivedAt !== null;
        const restoring = field.archivedAt !== null && candidate.archivedAt === null;
        const siblings = await repo.listFields(ws, field.projectId);
        if (diff.name !== undefined) assertFieldNameFree(siblings, candidate.name, id);
        if (restoring) assertActiveFieldCapacity(siblings, id);

        const next = nextDefinition(field, candidate, now);
        await repo.saveField(next);
        await repo.insertDefinitionVersion(next);
        const action = archiving ? 'archived' : restoring ? 'restored' : 'updated';
        await recordField(scope, next, action, { ...diff, revision: { from: field.revision, to: next.revision } });

        // Archived fields have no column; a restored field is appended with the defaults.
        if (archiving || restoring) {
          const columns = await loadColumns(repo, ws, field.projectId);
          const remaining = columns.columns.filter((column) => !sameId(column.fieldId, id));
          const nextColumns = restoring ? appendColumn(remaining, id) : normalizeColumns(remaining);
          await writeColumns(scope, columns, nextColumns, archiving ? 'field_archived' : 'field_restored');
        }
        return next;
      });
    },

    async createOption(
      context: CommandContext,
      fieldId: string,
      input: CreateTaskFieldOptionInput,
    ): Promise<TaskFieldDefinitionDto> {
      const id = parsePathId(fieldId);
      const parsed = parseInput<CreateTaskFieldOptionInput>(createTaskFieldOptionInputSchema, input);
      return mutate(context, 'fields.manage', 'field.option.create', id, parsed, taskFieldDefinitionSchema, async (scope, ws, now) => {
        const repo = scope.repository;
        const field = requireFound(await repo.findField(ws, id));
        expectRevision(field.revision, parsed.expectedRevision);
        requireSelectField(field);
        await requireOpenProject(repo.tasks, ws, field.projectId);
        if (field.options.length >= MAX_OPTIONS) {
          throw ruleError(`A field can have at most ${MAX_OPTIONS} options, archived ones included.`, 'options');
        }
        assertOptionNameFree(field.options, parsed.name, null);

        const option: TaskFieldOptionDto = {
          id: newId(),
          name: parsed.name,
          color: parsed.color,
          position: parsed.position ?? nextPosition(field.options.map((item) => item.position)),
          revision: 1,
          archivedAt: null,
        };
        const next = nextDefinition(field, { options: sortOptions([...field.options, option]) }, now);
        await repo.saveField(next);
        await repo.insertOption(toOptionRecord(next, option));
        await repo.insertDefinitionVersion(next);
        await recordField(scope, next, 'option_created', {
          option: optionMetadata(option),
          revision: { from: field.revision, to: next.revision },
        });
        return next;
      });
    },

    async updateOption(
      context: CommandContext,
      fieldId: string,
      optionId: string,
      input: UpdateTaskFieldOptionInput,
    ): Promise<TaskFieldDefinitionDto> {
      const fid = parsePathId(fieldId);
      const oid = parsePathId(optionId);
      const parsed = parseInput<UpdateTaskFieldOptionInput>(updateTaskFieldOptionInputSchema, input);
      const target = { fieldId: fid, optionId: oid };
      return mutate(context, 'fields.manage', 'field.option.update', target, parsed, taskFieldDefinitionSchema, async (scope, ws, now) => {
        const repo = scope.repository;
        const field = requireFound(await repo.findField(ws, fid));
        const owner = requireFound(await repo.findOption(ws, oid));
        if (!sameId(owner.fieldId, fid)) throw ruleError('The option belongs to another field.', 'optionId');
        expectRevision(field.revision, parsed.expectedRevision);
        await requireOpenProject(repo.tasks, ws, field.projectId);
        const option = field.options.find((item) => sameId(item.id, oid));
        if (option === undefined) throw new Error('Option is missing from its field catalog.');

        const candidate: TaskFieldOptionDto = {
          ...option,
          name: parsed.name ?? option.name,
          color: parsed.color === undefined ? option.color : parsed.color,
          position: parsed.position ?? option.position,
          archivedAt: nextArchivedAt(option.archivedAt, parsed.archived, now),
        };
        const diff = changedFields(option, candidate, OPTION_KEYS);
        if (Object.keys(diff).length === 0) return field;
        if (diff.name !== undefined) assertOptionNameFree(field.options, candidate.name, oid);

        const nextOption: TaskFieldOptionDto = { ...candidate, revision: option.revision + 1 };
        const options = sortOptions(field.options.map((item) => (sameId(item.id, oid) ? nextOption : item)));
        const next = nextDefinition(field, { options }, now);
        await repo.saveField(next);
        await repo.saveOption(toOptionRecord(next, nextOption));
        await repo.insertDefinitionVersion(next);
        await recordField(scope, next, 'option_updated', {
          optionId: nextOption.id,
          ...diff,
          optionRevision: { from: option.revision, to: nextOption.revision },
          revision: { from: field.revision, to: next.revision },
        });
        return next;
      });
    },

    async getProjectColumns(context: CommandContext, projectId: string): Promise<ProjectColumnsDto> {
      const id = parsePathId(projectId);
      const ctx = await authorizeRead(context);
      const ws = ctx.workspaceId;
      requireFound(await reader.tasks.findProject(ws, id));
      const settings = await loadColumns(reader, ws, id);
      const active = activeFieldIds(await reader.listFields(ws, id));
      return { ...settings, columns: settings.columns.filter((column) => active.has(column.fieldId.toLowerCase())) };
    },

    async updateProjectColumns(
      context: CommandContext,
      projectId: string,
      input: UpdateProjectColumnsInput,
    ): Promise<ProjectColumnsDto> {
      const id = parsePathId(projectId);
      const parsed = parseInput<UpdateProjectColumnsInput>(updateProjectColumnsInputSchema, input);
      return mutate(context, 'fields.manage', 'field.columns.update', id, parsed, projectColumnsSchema, async (scope, ws) => {
        const repo = scope.repository;
        await requireOpenProject(repo.tasks, ws, id);
        const current = await loadColumns(repo, ws, id);
        expectRevision(current.revision, parsed.expectedRevision);

        // Exactly every active field once: unknown IDs are 404, other projects or archived 422.
        const active = activeFieldIds(await repo.listFields(ws, id));
        for (const column of parsed.columns) {
          if (active.has(column.fieldId)) continue;
          const field = requireFound(await repo.findField(ws, column.fieldId));
          throw ruleError(
            sameId(field.projectId, id) ? 'Archived fields have no column.' : 'The field belongs to another project.',
            'columns',
          );
        }
        if (parsed.columns.length !== active.size) {
          throw ruleError('Columns must list every active field of the project exactly once.', 'columns');
        }

        const columns = normalizeColumns(parsed.columns);
        if (canonicalJson(columns) === canonicalJson(normalizeColumns(current.columns))) return current;
        return writeColumns(scope, current, columns, 'columns_updated');
      });
    },

    async listTaskValues(context: CommandContext, taskId: string): Promise<TaskFieldValueDto[]> {
      const id = parsePathId(taskId);
      const ctx = await authorizeRead(context);
      requireFound(await reader.tasks.findTask(ctx.workspaceId, id));
      return reader.listTaskValues(ctx.workspaceId, id);
    },

    async listProjectValues(
      context: CommandContext,
      projectId: string,
      input: TaskFieldBatchQuery,
    ): Promise<TaskFieldValueDto[]> {
      const id = parsePathId(projectId);
      const query = parseInput<TaskFieldBatchQuery>(taskFieldBatchQuerySchema, input);
      const ctx = await authorizeRead(context);
      const ws = ctx.workspaceId;
      requireFound(await reader.tasks.findProject(ws, id));
      // Every requested task must exist before any project check, so no partial result leaks.
      const tasks: TaskDto[] = [];
      for (const taskId of query.taskIds) tasks.push(requireFound(await reader.tasks.findTask(ws, taskId)));
      if (tasks.some((task) => !sameId(task.projectId, id))) {
        throw ruleError('A requested task belongs to another project.', 'taskIds');
      }
      return reader.listProjectValues(ws, id, query.taskIds);
    },

    async setTaskValue(
      context: CommandContext,
      taskId: string,
      fieldId: string,
      input: SetTaskFieldValueInput,
    ): Promise<TaskFieldValueDto> {
      const tid = parsePathId(taskId);
      const fid = parsePathId(fieldId);
      const parsed = parseInput<SetTaskFieldValueInput>(setTaskFieldValueInputSchema, input);
      const target = { taskId: tid, fieldId: fid };
      return mutate(context, 'task.edit', 'field.value.set', target, parsed, taskFieldValueSchema, async (scope, ws, now) => {
        const repo = scope.repository;
        const task = requireFound(await repo.tasks.findTask(ws, tid));
        const field = requireFound(await repo.findField(ws, fid));
        if (!sameId(field.projectId, task.projectId)) throw ruleError('The field belongs to another project.', 'fieldId');
        // A lock blocks every new value command, even an identical value; only a replay passes.
        if (field.locked) {
          throw new DomainError('FIELD_LOCKED', 'The field is locked. Unlock it before changing values.', {
            details: { fields: ['fieldId'] },
          });
        }
        expectRevision(field.revision, parsed.expectedDefinitionRevision, 'expectedDefinitionRevision');
        const current = await repo.findValue(ws, tid, fid);
        expectRevision(current?.revision ?? 0, parsed.expectedRevision);

        await requireOpenProject(repo.tasks, ws, task.projectId);
        if (task.archivedAt !== null) throw ruleError('The task is archived. Restore it before editing.', 'taskId');
        if (field.archivedAt !== null) throw ruleError('The field is archived.', 'fieldId');
        if (parsed.value.type !== field.type) throw ruleError('The value type does not match the field type.', 'value.type');
        await requireAssignableReferences(repo, ws, field, parsed.value, current?.value ?? null);

        if (current !== null && canonicalJson(current.value) === canonicalJson(parsed.value)) return current;

        const next: TaskFieldValueDto = {
          workspaceId: ws,
          projectId: task.projectId,
          taskId: tid,
          fieldId: fid,
          definitionVersionId: field.definitionVersionId,
          revision: (current?.revision ?? 0) + 1,
          value: parsed.value,
          updatedAt: now,
        };
        await repo.saveValue(next);

        // Audit and outbox carry metadata only; complete values live solely in value history.
        const metadata = {
          taskId: tid,
          fieldId: fid,
          type: field.type,
          valueRevision: next.revision,
          definitionRevision: field.revision,
        };
        const recorded = await record(
          scope,
          'task_field_value',
          tid,
          current === null ? 'created' : 'updated',
          next.revision,
          metadata,
          { projectId: task.projectId, ...metadata },
        );
        if (field.historyEnabled) {
          await repo.insertValueHistory({
            id: newId(),
            workspaceId: ws,
            projectId: task.projectId,
            taskId: tid,
            fieldId: fid,
            valueRevision: next.revision,
            definition: field,
            before: current?.value ?? null,
            after: parsed.value,
            actor: { id: scope.context.actor.userId, displayName: scope.access.membership.displayName },
            source: scope.context.source,
            recordedAt: now,
            changeSeq: recorded.changeSeq.toString(),
            eventOrdinal: recorded.eventOrdinal,
          });
        }
        return next;
      });
    },

    async listValueHistory(
      context: CommandContext,
      taskId: string,
      fieldId: string,
      input: TaskFieldHistoryQuery,
    ): Promise<TaskFieldHistoryPage> {
      const tid = parsePathId(taskId);
      const fid = parsePathId(fieldId);
      const query = parseInput<TaskFieldHistoryQuery>(taskFieldHistoryQuerySchema, input);
      const ctx = await authorizeRead(context);
      const ws = ctx.workspaceId;
      const task = requireFound(await reader.tasks.findTask(ws, tid));
      const field = requireFound(await reader.findField(ws, fid));
      if (!sameId(field.projectId, task.projectId)) throw ruleError('The field belongs to another project.', 'fieldId');

      const permissionEpoch = await reader.tasks.permissionEpoch(ws);
      const binding = { version: 1, workspaceId: ws, actorUserId: ctx.actor.userId, permissionEpoch, taskId: tid, fieldId: fid } as const;

      let after: TaskFieldHistoryAnchor | null = null;
      if (query.cursor !== undefined) {
        const payload = decodeHistoryCursor(query.cursor);
        const bound =
          payload.version === binding.version &&
          payload.workspaceId === binding.workspaceId &&
          payload.actorUserId === binding.actorUserId &&
          payload.permissionEpoch === binding.permissionEpoch &&
          payload.taskId === binding.taskId &&
          payload.fieldId === binding.fieldId &&
          isHistoryAnchor(payload);
        if (!bound) throw validationError(['cursor'], CURSOR_MESSAGE);
        after = { changeSeq: payload.changeSeq, eventOrdinal: payload.eventOrdinal, id: payload.id };
      }

      const rows = await reader.listValueHistory(ws, tid, fid, after, query.limit + 1);
      const items = rows.slice(0, query.limit);
      const last = items.at(-1);
      const nextCursor =
        rows.length > query.limit && last !== undefined
          ? tools.encodeHistoryCursor({ ...binding, changeSeq: last.changeSeq, eventOrdinal: last.eventOrdinal, id: last.id })
          : null;
      return { items, nextCursor };
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Validation and canonical form

const CURSOR_MESSAGE = 'The cursor is no longer valid. Reload the history.';

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

/** UUIDs compare case-insensitively, as in PostgreSQL. */
function sameId(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase();
}

function isHistoryAnchor(anchor: TaskFieldHistoryAnchor): boolean {
  return (
    typeof anchor.changeSeq === 'string' &&
    CHANGE_SEQ_PATTERN.test(anchor.changeSeq) &&
    Number.isInteger(anchor.eventOrdinal) &&
    anchor.eventOrdinal >= 1 &&
    anchor.eventOrdinal <= MAX_POSITION &&
    idSchema.safeParse(anchor.id).success
  );
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
// Rules (all inside the write transaction, under the workspace barrier)

async function requireOpenProject(repo: TaskRepository, ws: string, projectId: string): Promise<ProjectDto> {
  const project = requireFound(await repo.findProject(ws, projectId));
  if (project.archivedAt !== null) throw ruleError('The project is archived.', 'projectId');
  return project;
}

function requireSelectField(field: TaskFieldDefinitionDto): void {
  if (!SELECT_TYPES.includes(field.type)) throw ruleError('Only select fields have options.', 'fieldId');
}

/** Names are reserved case-insensitively across active and archived fields of the project. */
function assertFieldNameFree(fields: readonly TaskFieldDefinitionDto[], name: string, exceptId: string | null): void {
  const key = name.toLowerCase();
  const clash = fields.some((field) => (exceptId === null || !sameId(field.id, exceptId)) && field.name.toLowerCase() === key);
  if (clash) throw ruleError('A field with this name already exists in the project.', 'name');
}

function assertActiveFieldCapacity(fields: readonly TaskFieldDefinitionDto[], exceptId: string | null): void {
  const active = fields.filter((field) => field.archivedAt === null && (exceptId === null || !sameId(field.id, exceptId)));
  if (active.length >= MAX_ACTIVE_FIELDS) {
    throw ruleError(`A project can have at most ${MAX_ACTIVE_FIELDS} active fields.`, 'projectId');
  }
}

/** Option names are reserved case-insensitively within the field, archived options included. */
function assertOptionNameFree(options: readonly TaskFieldOptionDto[], name: string, exceptId: string | null): void {
  const key = name.toLowerCase();
  const clash = options.some(
    (option) => (exceptId === null || !sameId(option.id, exceptId)) && option.name.toLowerCase() === key,
  );
  if (clash) throw ruleError('An option with this name already exists in the field.', 'name');
}

/** Option and membership IDs referenced by a value; already canonical (lowercase, sorted). */
function referenceIds(data: TaskFieldData | null): string[] {
  if (data === null) return [];
  switch (data.type) {
    case 'single_select':
      return data.value === null ? [] : [data.value.toLowerCase()];
    case 'multi_select':
    case 'person':
      return (data.value ?? []).map((id) => id.toLowerCase());
    default:
      return [];
  }
}

/**
 * Only newly added references are checked; IDs the current value already holds may stay after
 * their option is archived or their membership revoked. Removing and re-adding is a new reference.
 * Options: missing or foreign 404, another field 422, archived 422. People: an active membership
 * of this workspace, otherwise 404 (they are custom data, not task participants).
 */
async function requireAssignableReferences(
  repo: TaskFieldRepository,
  ws: string,
  field: TaskFieldDefinitionDto,
  value: TaskFieldData,
  current: TaskFieldData | null,
): Promise<void> {
  const retained = new Set(referenceIds(current));
  const added = referenceIds(value).filter((id) => !retained.has(id));
  if (added.length === 0) return;
  if (value.type === 'person') {
    const active = new Set(
      (await repo.tasks.access.listActiveMemberships(ws))
        .filter((membership) => membership.state === 'active' && sameId(membership.workspaceId, ws))
        .map((membership) => membership.id.toLowerCase()),
    );
    if (added.some((id) => !active.has(id))) throw notFoundError();
    return;
  }
  for (const optionId of added) {
    const option = requireFound(await repo.findOption(ws, optionId));
    if (!sameId(option.fieldId, field.id)) throw ruleError('The option belongs to another field.', 'value');
    if (option.archivedAt !== null) throw ruleError('Archived options cannot be newly assigned.', 'value');
  }
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

function sortOptions(options: readonly TaskFieldOptionDto[]): TaskFieldOptionDto[] {
  return [...options].sort((left, right) => left.position - right.position || (left.id < right.id ? -1 : 1));
}

function toOptionRecord(field: TaskFieldDefinitionDto, option: TaskFieldOptionDto): TaskFieldOptionRecord {
  return { ...option, workspaceId: field.workspaceId, projectId: field.projectId, fieldId: field.id };
}

function optionMetadata(option: TaskFieldOptionDto): Record<string, unknown> {
  return { id: option.id, name: option.name, color: option.color, position: option.position };
}

function activeFieldIds(fields: readonly TaskFieldDefinitionDto[]): Set<string> {
  return new Set(fields.filter((field) => field.archivedAt === null).map((field) => field.id.toLowerCase()));
}

/** Settings start as a virtual revision 1 without columns until the first write. */
async function loadColumns(repo: TaskFieldRepository, ws: string, projectId: string): Promise<ProjectColumnsDto> {
  return (await repo.findProjectColumns(ws, projectId)) ?? { workspaceId: ws, projectId, revision: 1, columns: [] };
}

/** Positions 0..N-1 in ascending input position; hidden columns are kept, never dropped. */
function normalizeColumns(columns: readonly ProjectColumn[]): ProjectColumn[] {
  return [...columns]
    .sort((left, right) => left.position - right.position)
    .map((column, position) => ({ fieldId: column.fieldId, visible: column.visible, width: column.width, position }));
}

function appendColumn(columns: readonly ProjectColumn[], fieldId: string): ProjectColumn[] {
  const normalized = normalizeColumns(columns);
  normalized.push({ fieldId, visible: true, width: DEFAULT_COLUMN_WIDTH, position: normalized.length });
  return normalized;
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

/** Definition audit may carry metadata and option labels, never task values. */
function recordField(
  scope: TaskFieldWriteScope,
  field: TaskFieldDefinitionDto,
  action: 'created' | 'updated' | 'archived' | 'restored' | 'option_created' | 'option_updated',
  diff: Record<string, unknown>,
): Promise<RecordedChange> {
  return record(scope, 'task_field', field.id, action, field.revision, diff, {
    projectId: field.projectId,
    fieldId: field.id,
    revision: field.revision,
    definitionVersionId: field.definitionVersionId,
  });
}

/** One audit event with its outbox event; the outbox carries IDs, types and revisions only. */
function record(
  scope: TaskFieldWriteScope,
  entityType: 'task_field' | 'task_field_value' | 'project_columns',
  entityId: string,
  action: string,
  entityRevision: number,
  diff: Record<string, unknown>,
  payload: Record<string, unknown>,
): Promise<RecordedChange> {
  return scope.recordChange({
    entityType,
    entityId,
    action,
    entityRevision,
    diff,
    outbox: { type: `${entityType}.${action}`, payload: { workspaceId: scope.context.workspaceId, ...payload } },
  });
}
