import { reportMutationObserverFailure } from '../../lib/mutationDiagnostics';
import type { QueryClient } from '@tanstack/react-query';
import { bulkChangesForTask, type BulkTaskChanges, type BulkUpdateTasksInput, type BulkUpdatedTaskDto, type TaskDto, type TaskFieldData, type TaskFieldDefinitionDto, type TaskFieldValueDto, type UpdateTaskInput } from '@workloom/contracts';
import { ApiError, sendMutation } from '../../lib/api';
import { queryKeys } from '../../lib/queryKeys';
import { archiveTaskRequest, bulkUpdateTasksRequest, restoreTaskRequest, updateTaskRequest } from '../tasks/api';
import { setTaskFieldValueRequest } from '../fields/api';
import { reconcileFieldAcks } from './storeFieldAck';
import { projectUndoFor, undoScope } from './projectUndo';
import type { UndoHeads } from './UndoStore';
export interface BulkUndoMetadata {
  before: readonly TaskDto[];
  /** Exact known rows aligned with input.tasks. Null means known absent, not unloaded. */
  customValues?: readonly (TaskFieldValueDto | null)[];
  field?: TaskFieldDefinitionDto;
}
export interface FieldUndoMetadata { before: TaskFieldValueDto | null; field: TaskFieldDefinitionDto }
const taskSource = (id: string) => `task:${id}`;
const packageSource = (id: string) => `package:${id}`;
const participantSource = (id: string) => `participants:${id}`;
const fieldSource = (taskId: string, fieldId: string) => `field:${taskId}:${fieldId}`;
function confirmedHead(guards: Readonly<UndoHeads>, source: string): number {
  const value = guards[source]; if (value === undefined) throw new Error('UNDO_CONFIRMED_REVISION_MISSING'); return value;
}
async function reconcileConfirmedFields(client: QueryClient, actor: string, workspace: string, values: readonly TaskFieldValueDto[]) {
  try { await reconcileFieldAcks(client, actor, workspace, values); }
  catch { reportMutationObserverFailure(); }
}
function invalidate(client: QueryClient, actor: string, workspace: string) {
  // Invalidation does not fabricate an optimistic head and includes reports/activity/independent values.
  void client.invalidateQueries({ queryKey: queryKeys.workspace(actor, workspace) });
}
/** Only an already-loaded exact guarded snapshot is eligible; a refetch never supplies an undo base. */
export function captureTask(client: QueryClient, actor: string, workspace: string, id: string, input: { expectedRevision: number; expectedParticipantsRevision?: number; expectedWorkPackageRevision?: number }): TaskDto | undefined {
  const candidates: TaskDto[] = [];
  const detail = client.getQueryData<TaskDto>(queryKeys.task(actor, workspace, id));
  if (detail) candidates.push(detail);
  for (const [, data] of client.getQueriesData<{ pages?: { tasks?: TaskDto[] }[] }>({ queryKey: queryKeys.tasks(actor, workspace) })) {
    for (const page of data?.pages ?? []) for (const task of page.tasks ?? []) if (task.id === id) candidates.push(task);
  }
  const eligible = candidates.find(task => task.id === id && task.workspaceId === workspace && task.revision === input.expectedRevision && (input.expectedParticipantsRevision === undefined || task.participantsRevision === input.expectedParticipantsRevision) && (input.expectedWorkPackageRevision === undefined || task.workPackageRevision === input.expectedWorkPackageRevision));
  return eligible ? structuredClone(eligible) : undefined;
}
function heads(task: TaskDto, changes: { estimateMinutes?: number | null; participantMembershipIds?: string[] }): UndoHeads {
  return { [taskSource(task.id)]: task.revision,
    ...(changes.estimateMinutes !== undefined ? { [packageSource(task.workPackageId)]: task.workPackageRevision } : {}),
    ...(changes.participantMembershipIds !== undefined ? { [participantSource(task.id)]: task.participantsRevision } : {}),
  };
}
const editableKeys = ['title', 'description', 'statusId', 'sectionId', 'responsibleMembershipId', 'startDate', 'dueDate', 'priority', 'tagIds', 'participantMembershipIds', 'estimateMinutes'] as const;
function inversePatch(before: TaskDto, changes: UpdateTaskInput | BulkTaskChanges): Omit<UpdateTaskInput, 'expectedRevision'> | null {
  const guards = ['expectedRevision', 'expectedParticipantsRevision', 'expectedWorkPackageRevision', 'customField'];
  if (Object.keys(changes).some(key => changes[key as keyof typeof changes] !== undefined && !guards.includes(key) && !(editableKeys as readonly string[]).includes(key))) return null;
  const inverse: Record<string, unknown> = {};
  for (const key of editableKeys) {
    if (!(key in changes) || changes[key as keyof typeof changes] === undefined) continue;
    if (key === 'tagIds') inverse[key] = before.tags.map(tag => tag.id);
    else if (key === 'participantMembershipIds') inverse[key] = before.participants.filter(row => row.active).map(row => row.membershipId);
    else {
      if (before[key] === undefined) return null; // A historical uncaptured start is not a captured null.
      inverse[key] = before[key];
    }
  }
  return inverse;
}
function unsupported(client: QueryClient, actor: string, workspace: string, task: TaskDto, id: string, receipt: string) {
  projectUndoFor(client).record({ id, receipt, scope: undoScope(actor, workspace, task.projectId), kind: 'unsupported', heads: {}, beforeHeads: {} });
}
export function recordTaskUndo(client: QueryClient, actor: string, workspace: string, command: 'update' | 'archive' | 'restore' | 'create' | 'move', before: TaskDto | undefined, after: TaskDto, input: UpdateTaskInput | { expectedRevision: number } | undefined, receipt: string) {
  if (after.workspaceId !== workspace || before && (before.id !== after.id || before.workspaceId !== workspace || before.projectId !== after.projectId || input && before.revision !== input.expectedRevision)) return;
  const id = `${command}:${receipt}:${after.id}:${after.revision}:${after.participantsRevision}:${after.workPackageRevision}`;
  if (command === 'move' || (command !== 'create' && !before)) { unsupported(client, actor, workspace, after, id, receipt); return; }
  const patch = command === 'update' && before && input ? inversePatch(before, input) : {};
  if (patch === null) { unsupported(client, actor, workspace, after, id, receipt); return; }
  const changes = (input ?? {}) as UpdateTaskInput;
  const guardHeads = heads(after, changes);
  projectUndoFor(client).record({ id, receipt, scope: undoScope(actor, workspace, after.projectId), kind: command === 'archive' ? 'archive' : command === 'create' ? 'create' : 'edit', heads: guardHeads, beforeHeads: before ? heads(before, changes) : {},
    prepare: (guards, key) => {
      const expectedRevision = confirmedHead(guards, taskSource(after.id));
      const inverse = { expectedRevision, ...patch,
        ...(changes.estimateMinutes !== undefined ? { expectedWorkPackageRevision: confirmedHead(guards, packageSource(after.workPackageId)) } : {}),
        ...(changes.participantMembershipIds !== undefined ? { expectedParticipantsRevision: confirmedHead(guards, participantSource(after.id)) } : {}),
      };
      const request = command === 'archive' ? restoreTaskRequest(workspace, after.id, { expectedRevision }) : command === 'restore' || command === 'create' ? archiveTaskRequest(workspace, after.id, { expectedRevision }) : updateTaskRequest(workspace, after.id, inverse);
      return async () => {
        const result = (await sendMutation(request, { idempotencyKey: key })).data;
        invalidate(client, actor, workspace);
        if (result.id !== after.id || result.workspaceId !== workspace || result.projectId !== after.projectId) throw new ApiError({ kind: 'invalid_response', status: null });
        // A restored parent may not match the current list filter. Publish only its confirmed
        // revision, never an old task DTO or an inferred descendant head, to release its subtree.
        const currentActor = client.getQueryData<{ actor?: { id?: string } }>(queryKeys.me)?.actor?.id;
        if (command === 'archive' && result.archivedAt === null && currentActor === actor) {
          try { client.setQueryData<number>(queryKeys.taskRestoreAck(actor, workspace, result.id), before => Math.max(before ?? 0, result.revision)); }
          catch { reportMutationObserverFailure(); }
        }
        return heads(result, changes);
      };
    },
  });
}
function clearValue(value: TaskFieldData): TaskFieldData { return { type: value.type, value: null }; }
export function recordFieldUndo(client: QueryClient, actor: string, workspace: string, metadata: FieldUndoMetadata | undefined, after: TaskFieldValueDto, input: { expectedRevision: number; expectedDefinitionRevision: number }, receipt: string, expectedTaskId: string) {
  if (after.workspaceId !== workspace || after.taskId !== expectedTaskId) return;
  const id = `field:${receipt}:${after.taskId}:${after.fieldId}:${after.revision}`;
  const scope = undoScope(actor, workspace, after.projectId);
  const source = fieldSource(after.taskId, after.fieldId);
  if (!metadata || (metadata.before?.revision ?? 0) !== input.expectedRevision || metadata.field.id !== after.fieldId || metadata.field.projectId !== after.projectId || metadata.field.revision !== input.expectedDefinitionRevision || metadata.before && (metadata.before.taskId !== after.taskId || metadata.before.fieldId !== after.fieldId)) {
    projectUndoFor(client).record({ id, receipt, scope, kind: 'unsupported', heads: {}, beforeHeads: {} }); return;
  }
  const value = structuredClone(metadata.before?.value ?? clearValue(after.value));
  projectUndoFor(client).record({ id, receipt, scope, kind: 'edit', heads: { [source]: after.revision }, beforeHeads: { [source]: metadata.before?.revision ?? 0 }, clearFirstFill: metadata.before === null,
    prepare: (guards, key) => {
      const request = setTaskFieldValueRequest(workspace, after.taskId, after.fieldId, { expectedRevision: confirmedHead(guards, source), expectedDefinitionRevision: input.expectedDefinitionRevision, value });
      return async () => { const result = (await sendMutation(request, { idempotencyKey: key })).data; if (result.taskId !== after.taskId || result.fieldId !== after.fieldId || result.workspaceId !== workspace || result.projectId !== after.projectId) throw new ApiError({ kind: 'invalid_response', status: null }); await reconcileConfirmedFields(client, actor, workspace, [result]); invalidate(client, actor, workspace); return { [source]: result.revision }; };
    },
  });
}
export function recordBulkUndo(client: QueryClient, actor: string, workspace: string, metadata: BulkUndoMetadata | undefined, after: readonly BulkUpdatedTaskDto[], input: BulkUpdateTasksInput, receipt: string) {
  const id = `bulk:${receipt}:${after.map(task => `${task.id}:${task.revision}:${task.participantsRevision}:${task.workPackageRevision}:${task.customFieldAck?.revision ?? ''}`).join('|')}`;
  const scope = undoScope(actor, workspace, input.projectId);
  const fail = () => projectUndoFor(client).record({ id, receipt, scope, kind: 'unsupported', heads: {}, beforeHeads: {} });
  if (!metadata || metadata.before.length !== input.tasks.length || input.changes.restore) { fail(); return; }
  const originalHeads: UndoHeads = {}, confirmedHeads: UndoHeads = {};
  const restore: NonNullable<BulkUpdateTasksInput['changes']['restore']> = [];
  let clearFirstFill = false;
  for (const [index, row] of input.tasks.entries()) {
    const before = metadata.before[index], result = after.find(task => task.id === row.taskId);
    if (!before || !result || before.id !== row.taskId || before.projectId !== input.projectId || before.workspaceId !== workspace || result.workspaceId !== workspace || result.projectId !== input.projectId || before.revision !== row.expectedRevision || row.expectedParticipantsRevision !== undefined && before.participantsRevision !== row.expectedParticipantsRevision || row.expectedWorkPackageRevision !== undefined && before.workPackageRevision !== row.expectedWorkPackageRevision) { fail(); return; }
    const changes = bulkChangesForTask(input, row.taskId);
    const patch = inversePatch(before, changes);
    if (!patch) { fail(); return; }
    const inverse: BulkTaskChanges = patch;
    Object.assign(originalHeads, heads(before, changes)); Object.assign(confirmedHeads, heads(result, changes));
    if (changes.customField) {
      const previous = metadata.customValues?.[index], field = metadata.field, ack = result.customFieldAck;
      if (previous === undefined || !field || field.id !== changes.customField.fieldId || field.projectId !== input.projectId || field.revision !== changes.customField.expectedDefinitionRevision || (previous?.revision ?? 0) !== row.expectedFieldValueRevision || previous && (previous.taskId !== row.taskId || previous.fieldId !== field.id) || !ack || ack.fieldId !== field.id) { fail(); return; }
      const source = fieldSource(row.taskId, field.id);
      originalHeads[source] = previous?.revision ?? 0; confirmedHeads[source] = ack.revision;
      inverse.customField = { fieldId: field.id, expectedDefinitionRevision: field.revision, value: structuredClone(previous?.value ?? clearValue(changes.customField.value)) };
      clearFirstFill ||= previous === null;
    }
    restore.push({ taskId: row.taskId, changes: inverse });
  }
  projectUndoFor(client).record({ id, receipt, scope, kind: 'edit', heads: confirmedHeads, beforeHeads: originalHeads, clearFirstFill,
    prepare: (guards, key) => {
      const body: BulkUpdateTasksInput = { projectId: input.projectId, ...(restore.some(row => row.changes.customField) ? { includeFieldValueAck: true as const } : {}),
        tasks: restore.map(row => {
          const task = after.find(task => task.id === row.taskId);
          if (!task) throw new Error('UNDO_CONFIRMED_TASK_MISSING');
          return { taskId: task.id, expectedRevision: confirmedHead(guards, taskSource(task.id)),
            ...(row.changes.participantMembershipIds !== undefined ? { expectedParticipantsRevision: confirmedHead(guards, participantSource(task.id)) } : {}),
            ...(row.changes.estimateMinutes !== undefined ? { expectedWorkPackageRevision: confirmedHead(guards, packageSource(task.workPackageId)) } : {}),
            ...(row.changes.customField ? { expectedFieldValueRevision: confirmedHead(guards, fieldSource(task.id, row.changes.customField.fieldId)) } : {}),
          };
        }), changes: { restore },
      };
      const request = bulkUpdateTasksRequest(workspace, body);
      return async () => {
        const result = (await sendMutation(request, { idempotencyKey: key })).data;
        const ackHeads: UndoHeads = {};
        for (const task of result) {
          const changes = bulkChangesForTask(body, task.id);
          Object.assign(ackHeads, heads(task, changes));
          if (changes.customField) {
            if (!task.customFieldAck || task.customFieldAck.fieldId !== changes.customField.fieldId) throw new ApiError({ kind: 'invalid_response', status: null });
            ackHeads[fieldSource(task.id, changes.customField.fieldId)] = task.customFieldAck.revision;
          }
        }
        await reconcileConfirmedFields(client, actor, workspace, result.flatMap(task => task.customFieldAck ? [task.customFieldAck] : []));
        invalidate(client, actor, workspace); return ackHeads;
      };
    },
  });
}
