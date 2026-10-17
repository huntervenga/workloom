/**
 * Canonical encoder from the staged extras of an unsaved row (`InitialTaskCellsDraft`) to the
 * optional `initial` part of an atomic task row create. Pure: no request, no cache, no clock.
 *
 * Every staged value is validated first; any issue blocks the whole payload and the raw drafts are
 * left untouched for review. Nothing is implied: hours keep their captured week and person, and a
 * plan for a shared parent package is only sent at the captured parent commitment revision.
 */
import { createTaskRowInputSchema, type CreateTaskInput, type CreateTaskRowInput, type TaskFieldDefinitionDto } from '@workloom/contracts';
import { t } from '../../i18n';
import { sameId } from '../fields/valueDraft';
import {
  hasInitialTaskCells,
  validateInitialTaskCells,
  type InitialTaskCellsData,
  type InitialTaskCellsDraft,
  type InitialTaskCellsIssue,
  type InitialTimeContext,
} from './InitialTaskCells';

/** What an atomic row create sends besides the task itself. */
export type InitialTaskPayload = Omit<CreateTaskRowInput, 'task'>;

export interface InitialTaskPayloadOptions {
  /** Current definitions of the project; a staged value whose field changed or left is reported. */
  readonly definitions?: readonly TaskFieldDefinitionDto[] | undefined;
  /** Current explicit week and person, only to report a review; the captured context always wins. */
  readonly currentContext?: InitialTimeContext | null | undefined;
  /** The task joins its parent's work package (a detail subtask). */
  readonly sharesParentPackage: boolean;
  /** The parent's package at submit time; a shared plan captured for another package is refused. */
  readonly parentWorkPackageId?: string | null | undefined;
}

export type InitialTaskPayloadResult =
  /** `initial` is absent when nothing is staged, so the legacy create is sent unchanged. */
  | { readonly ok: true; readonly initial: InitialTaskPayload | undefined; readonly contextChanged: boolean }
  | { readonly ok: false; readonly issues: readonly InitialTaskCellsIssue[] };

/** Planned hours typed while the row shared its parent package carry that package's commitment. */
function capturedForParentPackage(draft: InitialTaskCellsDraft): boolean {
  return draft.time.context?.plan !== undefined && draft.time.planned.raw.trim() !== '';
}

/**
 * Staged planned hours whose package intent no longer matches: entered as the parent package total
 * but now sent for the task's own package, or captured for a different parent package. They are
 * never re-targeted; the person clears or re-enters them.
 */
function packageIntentIssue(draft: InitialTaskCellsDraft, options: InitialTaskPayloadOptions): InitialTaskCellsIssue | null {
  if (!capturedForParentPackage(draft)) return null;
  const captured = draft.time.context?.plan;
  const moved = !options.sharesParentPackage
    || (options.parentWorkPackageId !== undefined && (options.parentWorkPackageId === null || captured === undefined || !sameId(captured.workPackageId, options.parentWorkPackageId)));
  return moved ? { kind: 'hours', hours: 'planned', message: t('taskRows.time.sharedPackagePlan') } : null;
}

/** Maps validated data to the contract shape; helper-only metadata is dropped. */
export function encodeInitialTaskData(data: InitialTaskCellsData, sharesParentPackage: boolean): InitialTaskPayload | undefined {
  const initial: InitialTaskPayload = {};
  if (data.fields.length > 0) {
    initial.fields = data.fields.map(({ fieldId, expectedDefinitionRevision, value }) => ({ fieldId, expectedDefinitionRevision, value }));
  }
  const { time } = data;
  if (time !== null && time.plannedMinutes !== undefined) {
    // A shared parent plan is only sent at its captured revision; an own new package has none yet.
    if (sharesParentPackage && time.expectedPlanRevision === undefined) return undefined;
    initial.plan = {
      periodId: time.periodId,
      membershipId: time.membershipId,
      expectedRevision: sharesParentPackage ? (time.expectedPlanRevision ?? null) : null,
      plannedMinutes: time.plannedMinutes,
    };
  }
  if (time !== null && time.actualMinutes !== undefined) {
    initial.actual = { periodId: time.periodId, membershipId: time.membershipId, minutes: time.actualMinutes };
  }
  return Object.keys(initial).length > 0 ? initial : undefined;
}

/**
 * The `initial` part for `useCreateTaskMutation`, validated against the real row contract with
 * `input` as its task. Absent staged extras give `initial: undefined`. With `input: null` (the
 * built-in fields are invalid) the extras are still checked, so every issue shows at once.
 */
export function buildInitialTaskPayload(
  input: CreateTaskInput | null,
  draft: InitialTaskCellsDraft | undefined,
  options: InitialTaskPayloadOptions,
): InitialTaskPayloadResult {
  if (draft === undefined || !hasInitialTaskCells(draft)) return { ok: true, initial: undefined, contextChanged: false };
  const intent = packageIntentIssue(draft, options);
  const checked = validateInitialTaskCells(draft, {
    definitions: options.definitions,
    currentContext: options.currentContext,
    sharesParentPackage: options.sharesParentPackage,
  });
  if (!checked.ok) return { ok: false, issues: intent ? [intent, ...checked.issues] : checked.issues };
  if (intent) return { ok: false, issues: [intent] };
  const planned = checked.data.time?.plannedMinutes !== undefined;
  const initial = encodeInitialTaskData(checked.data, options.sharesParentPackage);
  if (planned && initial?.plan === undefined) {
    return { ok: false, issues: [{ kind: 'hours', hours: 'planned', message: t('taskRows.time.sharedPackagePlan') }] };
  }
  if (initial !== undefined && input !== null && !createTaskRowInputSchema.safeParse({ task: input, ...initial }).success) {
    const message = t('tasks.taskDraft.checkTheCompletedFields');
    const issues: InitialTaskCellsIssue[] = checked.data.fields.map(({ fieldId }) => ({ kind: 'field', fieldId, message }));
    return { ok: false, issues: issues.length > 0 ? issues : [{ kind: 'hours', hours: 'planned', message }] };
  }
  return { ok: true, initial, contextChanged: checked.contextChanged };
}

/** A frozen deep copy for a queued or held create, so later edits of the draft cannot reach it. */
export function snapshotInitialTaskPayload(initial: InitialTaskPayload | undefined): InitialTaskPayload | undefined {
  return initial === undefined ? undefined : structuredClone(initial);
}
