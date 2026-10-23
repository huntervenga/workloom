import type { TaskDto, TaskStatusDto } from '@workloom/contracts';
import { changedKeys, draftFromTask, emptyDraft, inheritsEstimate, type CreateOptions, type TaskDraft, type TaskDraftKey } from './taskDraft';
import type { WorkPackageEntry } from '../task-table/workPackages';
import { hasInitialTaskCells } from './InitialTaskCells';
import type { CreateRequest, CreateResultAnchor, CreateSession, EditSession } from './useTaskCommands';

export type TaskInlineField = 'title' | 'statusId' | 'responsibleMembershipId' | 'dueDate' | 'priority' | 'estimate' | 'sectionId' | 'tagIds';

/** View/recovery mapping must follow the edited field rather than assume a date fallback. */
export function taskInlineColumn(field: TaskInlineField) {
  switch (field) {
    case 'title': return field;
    // The section move is a row action anchored in the pinned title cell.
    case 'sectionId': return 'title';
    case 'statusId': return 'status';
    case 'responsibleMembershipId': return 'responsible';
    case 'dueDate': return field;
    case 'tagIds': return 'tags';
    case 'priority': return field;
    case 'estimate': return field;
  }
}

export function canEditTaskInline(task: TaskDto): boolean {
  // Missing task type belongs to a retained older response and must be refreshed first.
  return task.archivedAt === null && task.meetingId === null;
}

/** Only an ordinary root task moves between sections; a subtask stays under its parent. */
export function canMoveTaskSection(task: TaskDto): boolean {
  return canEditTaskInline(task) && task.parentTaskId === null;
}

/** The project's configured default status when it still exists; otherwise the first "to do" status. */
export function defaultTaskStatusId(statuses: readonly TaskStatusDto[], preferredId?: string | null): string | null {
  const ordered = [...statuses].sort((a, b) => a.position - b.position);
  const preferred = preferredId ? ordered.find(status => status.id.toLowerCase() === preferredId.toLowerCase()) : undefined;
  return (preferred ?? ordered.find(status => status.group === 'todo') ?? ordered[0])?.id ?? null;
}

/** The section a create lands in: a subtask always shares its parent's section. */
function requestSectionId(sectionId: string | null, request: CreateRequest | undefined): string | null {
  if (!request) return sectionId;
  return request.parent !== null ? request.parent.sectionId : request.sectionId;
}

/** A new row's draft: the given status, and the assignee of the group it was explicitly opened in. */
function quickStartDraft(statusId: string, sectionId: string | null, request: CreateRequest | undefined): TaskDraft {
  const start = request?.startValues;
  const draft = start ? { ...emptyDraft(statusId, sectionId), ...start } : emptyDraft(statusId, sectionId);
  const responsible = request?.defaultResponsibleMembershipId;
  return responsible === undefined ? draft : { ...draft, responsibleMembershipId: responsible };
}

export function freshQuickSession(sectionId: string | null, statusId: string, request?: CreateRequest): CreateSession {
  const section = requestSectionId(sectionId, request);
  return {
    request: { ...request, sectionId: section, parent: request?.parent ?? null },
    draft: quickStartDraft(statusId, section, request),
    workScope: 'detail',
    origin: 'quick',
    clientId: crypto.randomUUID(),
    baseStatusId: statusId,
  };
}

/** A quick subtask joins its parent's work package exactly like one created in details. */
export function quickCreateOptions(session: CreateSession): CreateOptions {
  return { parentTaskId: session.request.parent?.id ?? null, workScope: session.workScope };
}

/**
 * The draft this row started from. A group's own assignee is part of the start, not a change;
 * retained pre-insertion sessions keep their own status as the base.
 */
export function quickBaselineDraft(session: CreateSession): TaskDraft {
  return quickStartDraft(session.baseStatusId ?? session.draft.statusId, session.request.sectionId, session.request);
}

/** Values that differ from a new quick row. */
export function quickDraftChanges(session: CreateSession): TaskDraftKey[] {
  return changedKeys(quickBaselineDraft(session), session.draft);
}

/** The row places each next task right after the one it just queued: an inserted row or a first child. */
export function quickRowContinues(request: CreateRequest): boolean {
  return request.insertion !== undefined || request.insertionAnchor !== undefined || request.continueInPlace === true;
}

/**
 * The request of the row's next task once the current one is queued. A continuing row follows
 * that task, whatever ID it gets; the bottom row keeps adding at the end.
 */
export function nextQuickRequest(request: CreateRequest, resultAnchor: CreateResultAnchor): CreateRequest {
  return quickRowContinues(request) ? { ...request, insertionAnchor: resultAnchor } : request;
}

/** Custom field values or hours staged in the row, valid or not; a title-only row never shows them. */
export function hasQuickInitialCells(session: CreateSession): boolean {
  return session.initialCells !== undefined && hasInitialTaskCells(session.initialCells);
}

/** Anything a person typed or picked in the row, including staged extras with a blank title. */
export function quickSessionHasValues(session: CreateSession): boolean {
  return quickDraftChanges(session).length > 0 || hasQuickInitialCells(session);
}

/**
 * Two requests open the same row: the same insertion point (or both none), the same first-child
 * continuation and the same assignee group, so a draft never moves into another group.
 */
export function sameCreatePlacement(a: CreateRequest, b: CreateRequest | undefined): boolean {
  return a.insertion?.anchorTaskId === b?.insertion?.anchorTaskId && a.insertion?.placement === b?.insertion?.placement
    && (a.continueInPlace === true) === (b?.continueInPlace === true)
    && a.defaultResponsibleMembershipId === b?.defaultResponsibleMembershipId;
}

const titleOnlyKeys = new Set<TaskDraftKey>(['title']);
const rowKeys = new Set<TaskDraftKey>(['title', 'statusId', 'responsibleMembershipId', 'participantMembershipIds', 'startDate', 'dueDate', 'priority', 'tagIds', 'estimate']);
const inheritedEstimateRowKeys = new Set([...rowKeys].filter(key => key !== 'estimate'));

/**
 * Whether a retained quick session belongs in this row. A title-only row shows only the title;
 * a full table row shows every built-in value except an inherited estimate. Anything else, or
 * another parent's subtask or another insertion point, must be reviewed in details instead.
 */
export function canResumeQuickSession(session: CreateSession, sectionId: string | null, request?: CreateRequest, fullRow = false): boolean {
  if (session.origin !== 'quick' || session.request.sectionId !== requestSectionId(sectionId, request)) return false;
  if ((session.request.parent?.id ?? null) !== (request?.parent?.id ?? null) || !sameCreatePlacement(session.request, request)) return false;
  // Staged extras are shown only by the full row; a title-only row would hide and then send them.
  if (!fullRow && hasQuickInitialCells(session)) return false;
  const shown = !fullRow ? titleOnlyKeys : inheritsEstimate(quickCreateOptions(session)) ? inheritedEstimateRowKeys : rowKeys;
  return quickDraftChanges(session).every(key => shown.has(key));
}

export function canResumeInlineSession(session: EditSession, field: TaskInlineField): boolean {
  const changed = changedKeys(draftFromTask(session.base), session.draft);
  return changed.length === 0 || session.inlineField === field && changed.every(key => key === field || field === 'dueDate' && key === 'startDate');
}

/** A displayed package value is safe to edit only from that exact source projection. */
export function isCurrentEstimateProjection(task: TaskDto, packages: ReadonlyMap<string, WorkPackageEntry> | undefined): boolean {
  const entry = packages?.get(task.workPackageId);
  if (!entry || entry.estimate.status === 'conflict' || entry.revision !== task.workPackageRevision) return false;
  const minutes = entry.estimate.status === 'estimated' ? entry.estimate.minutes : null;
  return minutes === task.estimateMinutes;
}

/** Estimate-only writes advance the package revision, independently of task revision. */
export function matchesInlineTaskReceipt(current: TaskDto, receipt: TaskDto, field: TaskInlineField): boolean {
  if (current.id !== receipt.id || current.revision !== receipt.revision) return false;
  switch (field) {
    case 'estimate':
      return current.workPackageId === receipt.workPackageId &&
        current.workPackageRevision === receipt.workPackageRevision && current.estimateMinutes === receipt.estimateMinutes;
    case 'title':
    case 'statusId':
    case 'responsibleMembershipId':
    case 'dueDate':
      return current.dueDate === receipt.dueDate && (current.startDate ?? null) === (receipt.startDate ?? null);
    case 'tagIds': {
      // Tag metadata can advance independently; confirmation owns the selected stable IDs only.
      const ids = (task: TaskDto) => task.tags.map(tag => tag.id.toLowerCase()).sort();
      const left = ids(current); const right = ids(receipt);
      return left.length === right.length && left.every((id, index) => id === right[index]);
    }
    case 'priority':
    case 'sectionId':
      return current[field] === receipt[field];
  }
}
