import {
  calendarDateSchema,
  createTaskInputSchema,
  updateTaskInputSchema,
  type CreateTaskInput,
  type TaskDto,
  type TaskPriority,
  type TaskWorkScope,
  type UpdateTaskInput,
} from '@workloom/contracts';
import { formatEstimateInput, parseEstimateInput } from '../task-table';

/** Same limits as @workloom/contracts, which remains the authority. */
export const TASK_TITLE_MAX = 500;
export const TASK_DESCRIPTION_MAX = 20_000;

/** What the task form edits. Text stays as typed; IDs are memberships and tags, never names. */
export interface TaskDraft {
  title: string;
  description: string;
  statusId: string;
  sectionId: string | null;
  responsibleMembershipId: string | null;
  participantMembershipIds: string[];
  /** Raw `YYYY-MM-DD`; empty means no due date. */
  dueDate: string;
  priority: TaskPriority;
  tagIds: string[];
  /** Hours as typed; empty means not estimated, which differs from `0`. */
  estimate: string;
}

/** Every draft field, in form order. */
export const taskDraftKeys = [
  'title',
  'description',
  'statusId',
  'sectionId',
  'responsibleMembershipId',
  'participantMembershipIds',
  'dueDate',
  'priority',
  'tagIds',
  'estimate',
] as const;

export type TaskDraftKey = (typeof taskDraftKeys)[number];

export type TaskDraftErrors = Partial<Record<'title' | 'description' | 'dueDate' | 'estimate' | 'form', string>>;

export type BuildResult<T> = { ok: true; input: T } | { ok: false; errors: TaskDraftErrors };

/** Active participant rows, each membership once. */
export function activeParticipantIds(task: TaskDto): string[] {
  return [...new Set(task.participants.filter((row) => row.active).map((row) => row.membershipId))];
}

/**
 * The form state for `task`. Every active participant is kept, including memberships that have
 * since left the workspace: the task may retain those references, so replacing the set (for
 * example adding someone) never drops them silently; only an explicit uncheck removes one.
 * Inactive participant rows are history, not current assignees. The member set is accepted for
 * call compatibility and does not filter anything.
 */
export function draftFromTask(task: TaskDto, _memberIds?: ReadonlySet<string>): TaskDraft {
  return {
    title: task.title,
    description: task.description,
    statusId: task.statusId,
    sectionId: task.sectionId,
    responsibleMembershipId: task.responsibleMembershipId,
    participantMembershipIds: activeParticipantIds(task),
    dueDate: task.dueDate ?? '',
    priority: task.priority,
    tagIds: task.tags.map((tag) => tag.id),
    estimate: formatEstimateInput(task.estimateMinutes),
  };
}

export function emptyDraft(statusId: string, sectionId: string | null): TaskDraft {
  return {
    title: '',
    description: '',
    statusId,
    sectionId,
    responsibleMembershipId: null,
    participantMembershipIds: [],
    dueDate: '',
    priority: 'none',
    tagIds: [],
    estimate: '',
  };
}

function sameIds(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const known = new Set(a.map((id) => id.toLowerCase()));
  return b.every((id) => known.has(id.toLowerCase()));
}

function sameValue(key: TaskDraftKey, a: TaskDraft, b: TaskDraft): boolean {
  switch (key) {
    case 'participantMembershipIds':
    case 'tagIds':
      return sameIds(a[key], b[key]);
    case 'title':
      return a.title.trim() === b.title.trim();
    case 'estimate': {
      const left = parseEstimateInput(a.estimate);
      const right = parseEstimateInput(b.estimate);
      return left.valid && right.valid ? left.minutes === right.minutes : a.estimate.trim() === b.estimate.trim();
    }
    default:
      return a[key] === b[key];
  }
}

/** Fields whose meaning differs between two drafts (`1,5` and `1:30` are the same estimate). */
export function changedKeys(from: TaskDraft, to: TaskDraft): TaskDraftKey[] {
  return taskDraftKeys.filter((key) => !sameValue(key, from, to));
}

/**
 * Moves a draft onto a newer base: fields the user changed keep the user's value, all others
 * take the newer base, so saving does not undo a colleague's edits the user never touched.
 */
export function rebaseDraft(oldBase: TaskDraft, draft: TaskDraft, newBase: TaskDraft): TaskDraft {
  const next: TaskDraft = { ...newBase };
  for (const key of changedKeys(oldBase, draft)) Object.assign(next, { [key]: draft[key] });
  return next;
}

function checkDraft(draft: TaskDraft, checkEstimate: boolean): { errors: TaskDraftErrors; minutes: number | null } {
  const errors: TaskDraftErrors = {};
  const title = draft.title.trim();
  if (title === '') errors.title = 'Введите название задачи.';
  else if (title.length > TASK_TITLE_MAX) errors.title = `Название должно быть не длиннее ${TASK_TITLE_MAX} символов.`;
  if (draft.description.length > TASK_DESCRIPTION_MAX) {
    errors.description = 'Описание должно быть не длиннее 20 000 символов.';
  }
  if (draft.dueDate !== '' && !calendarDateSchema.safeParse(draft.dueDate).success) {
    errors.dueDate = 'Укажите существующую дату.';
  }
  let minutes: number | null = null;
  if (checkEstimate) {
    const estimate = parseEstimateInput(draft.estimate);
    if (estimate.valid) minutes = estimate.minutes;
    else errors.estimate = estimate.message;
  }
  return { errors, minutes };
}

function hasErrors(errors: TaskDraftErrors): boolean {
  return Object.keys(errors).length > 0;
}

export interface CreateOptions {
  parentTaskId: string | null;
  /** Ignored for root tasks, which always start a new work package. */
  workScope: TaskWorkScope;
}

/** True when the new task joins its parent's work package and must not send an estimate. */
export function inheritsEstimate({ parentTaskId, workScope }: CreateOptions): boolean {
  return parentTaskId !== null && workScope === 'detail';
}

/**
 * The create command for a draft. A detail subtask omits `estimateMinutes` entirely (not even
 * zero): it shares the parent's package. Empty optional fields are left to server defaults.
 */
export function buildCreateInput(projectId: string, draft: TaskDraft, options: CreateOptions): BuildResult<CreateTaskInput> {
  const inherited = inheritsEstimate(options);
  const { errors, minutes } = checkDraft(draft, !inherited);
  if (hasErrors(errors)) return { ok: false, errors };

  const input: CreateTaskInput = { projectId, title: draft.title.trim(), statusId: draft.statusId };
  if (draft.description !== '') input.description = draft.description;
  if (draft.sectionId !== null) input.sectionId = draft.sectionId;
  if (options.parentTaskId !== null) {
    input.parentTaskId = options.parentTaskId;
    input.workScope = options.workScope;
  }
  if (draft.responsibleMembershipId !== null) input.responsibleMembershipId = draft.responsibleMembershipId;
  if (draft.participantMembershipIds.length > 0) input.participantMembershipIds = [...draft.participantMembershipIds];
  if (draft.dueDate !== '') input.dueDate = draft.dueDate;
  if (draft.priority !== 'none') input.priority = draft.priority;
  if (draft.tagIds.length > 0) input.tagIds = [...draft.tagIds];
  if (!inherited && minutes !== null) input.estimateMinutes = minutes;

  if (!createTaskInputSchema.safeParse(input).success) return { ok: false, errors: { form: 'Проверьте заполненные поля.' } };
  return { ok: true, input };
}

/**
 * The PATCH for what changed between `baseDraft` (made from `base`) and `draft`, or `null` when
 * nothing did. `expectedRevision` is always sent; the work package and participant guards only
 * with their own field, all taken from `base`, the snapshot the user has seen.
 */
export function buildUpdateInput(base: TaskDto, baseDraft: TaskDraft, draft: TaskDraft): BuildResult<UpdateTaskInput | null> {
  const changed = new Set(changedKeys(baseDraft, draft));
  const { errors, minutes } = checkDraft(draft, true);
  if (hasErrors(errors)) return { ok: false, errors };
  if (changed.size === 0) return { ok: true, input: null };

  const input: UpdateTaskInput = { expectedRevision: base.revision };
  if (changed.has('title')) input.title = draft.title.trim();
  if (changed.has('description')) input.description = draft.description;
  if (changed.has('statusId')) input.statusId = draft.statusId;
  if (changed.has('sectionId')) input.sectionId = draft.sectionId;
  if (changed.has('responsibleMembershipId')) input.responsibleMembershipId = draft.responsibleMembershipId;
  if (changed.has('participantMembershipIds')) {
    input.participantMembershipIds = [...draft.participantMembershipIds];
    input.expectedParticipantsRevision = base.participantsRevision;
  }
  if (changed.has('dueDate')) input.dueDate = draft.dueDate === '' ? null : draft.dueDate;
  if (changed.has('priority')) input.priority = draft.priority;
  if (changed.has('tagIds')) input.tagIds = [...draft.tagIds];
  if (changed.has('estimate') && minutes !== base.estimateMinutes) {
    input.estimateMinutes = minutes;
    input.expectedWorkPackageRevision = base.workPackageRevision;
  }

  if (!updateTaskInputSchema.safeParse(input).success) return { ok: false, errors: { form: 'Проверьте заполненные поля.' } };
  return { ok: true, input };
}
