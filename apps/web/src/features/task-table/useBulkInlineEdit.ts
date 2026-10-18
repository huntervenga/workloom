import type { BulkUpdateTasksInput, TaskDto, TaskFieldDefinitionDto, TaskFieldValueDto } from '@workloom/contracts';
import { useEffect, useRef, useState } from 'react';
import { message, type TranslationMessage } from '../../i18n';
import type { InlineBulkCallbacks, InlineBulkChanges, InlineBulkEditPort, InlineBulkVerdict } from '../tasks/InlineTaskEdit';
import { canEditTaskInline, canMoveTaskSection, type TaskInlineField } from '../tasks/tableEditing';
import { changedKeys, draftFromTask } from '../tasks/taskDraft';
import { unresolvedTaskCommand, type TaskCommands } from '../tasks/useTaskCommands';

/** Cells whose one field a selected row may apply to its whole selection; title and description stay single-task. */
const bulkFields: ReadonlySet<TaskInlineField> = new Set<TaskInlineField>(['statusId', 'priority', 'responsibleMembershipId', 'dueDate', 'tagIds', 'sectionId', 'estimate']);
/** Cells a selected row must neither batch nor fall back to a single-task write for, until the batch supports them. */
const unsupportedFields: ReadonlySet<TaskInlineField> = new Set<TaskInlineField>();

type BulkOrigin = TaskInlineField | 'completion' | 'custom';

interface Target { taskId: string; expectedRevision: number; expectedWorkPackageRevision?: number; expectedFieldValueRevision?: number }

/** One selection frozen when an eligible cell opened or a circle was pressed; it is never retargeted. */
interface Capture {
  originTaskId: string;
  field: BulkOrigin;
  /** The selection size when captured, shown as the batch's count. */
  count: number;
  targets: readonly Target[];
  /** A selected ID had neither a loaded nor a ledger row: this capture refuses to send. */
  missing: boolean;
  unsupported: boolean;
  custom?: { fieldId: string; definitionRevision: number };
}

interface Attempt {
  capture: Capture;
  /** The exact frozen body handed to the shared tracker; its retries resend it under the same key. */
  input: BulkUpdateTasksInput;
  callbacks: InlineBulkCallbacks | null;
  /** The sending editor's callbacks still run; after they settle only its retained session is confirmed. */
  live: boolean;
  /** The command's answer before this send, so a later Toolbar retry's own answer is recognised. */
  dataBefore: readonly TaskDto[] | undefined;
  state: 'sent' | 'confirmed' | 'unconfirmed';
}

export interface BulkInlineContext {
  projectId: string;
  selectedTaskIds: readonly string[];
  /** Every loaded row, collapsed or not; the ledger answers for selected rows a filter hides. */
  shownTasks: readonly TaskDto[];
  ledger: ReadonlyMap<string, TaskDto>;
  writable: boolean;
  fieldValues?: readonly TaskFieldValueDto[];
  knownFieldTaskIds?: readonly string[];
  fields?: readonly TaskFieldDefinitionDto[];
  /** Quick creates or a list read still settling: refused like the Toolbar's own apply. */
  busy: boolean;
  onConfirmed: (rows: readonly TaskDto[]) => void;
  onAnnounce: (announcement: TranslationMessage) => void;
}

function sameIds(left: readonly string[], right: readonly string[]): boolean {
  const known = new Set(left.map(id => id.toLowerCase()));
  return known.size === new Set(right.map(id => id.toLowerCase())).size && right.every(id => known.has(id.toLowerCase()));
}

/** Every target already holds the value: nothing is sent. */
function alreadyApplied(row: TaskDto, changes: InlineBulkChanges): boolean {
  return (changes.statusId === undefined || row.statusId === changes.statusId)
    && (changes.priority === undefined || row.priority === changes.priority)
    && (changes.responsibleMembershipId === undefined || row.responsibleMembershipId === changes.responsibleMembershipId)
    && (changes.sectionId === undefined || row.sectionId === changes.sectionId)
    && (changes.startDate === undefined || (row.startDate ?? null) === changes.startDate)
    && (changes.dueDate === undefined || row.dueDate === changes.dueDate)
    && (changes.estimateMinutes === undefined || row.estimateMinutes === changes.estimateMinutes)
    && changes.customField === undefined
    && (changes.tagIds === undefined || sameIds(row.tags.map(tag => tag.id), changes.tagIds));
}

/** Exactly one row per target, of this project and at least its sent revision; otherwise nothing is confirmed. */
function confirmedOrigin(attempt: Attempt, rows: readonly TaskDto[]): TaskDto | null {
  const { targets, originTaskId } = attempt.capture;
  if (!Array.isArray(rows) || rows.length !== targets.length) return null;
  const byId = new Map(rows.map(row => [row.id.toLowerCase(), row]));
  if (byId.size !== rows.length) return null;
  for (const target of targets) {
    const row = byId.get(target.taskId.toLowerCase());
    if (!row || row.projectId !== attempt.input.projectId || row.revision < target.expectedRevision) return null;
  }
  return byId.get(originTaskId.toLowerCase()) ?? null;
}

/**
 * Page-owned selected-cell editing: a cell opened in a selected row of a multi-selection applies
 * only its own field to the selection frozen at open, through the existing atomic `commands.bulk`
 * (its exact body, idempotency key and cache writes). The last attempt outlives its editor, so the
 * Toolbar's recovery and a reopened origin cell both show and retry that one command.
 */
export function useBulkInlineEdit(commands: TaskCommands, context: BulkInlineContext) {
  const latest = useRef(context); latest.current = context;
  const latestCommands = useRef(commands); latestCommands.current = commands;
  const captures = useRef(new WeakMap<object, Capture>());
  const last = useRef<Attempt | null>(null);
  const [notice, setNotice] = useState<{ capture: Capture; message: TranslationMessage } | null>(null);
  const [, rerender] = useState(0);
  const { bulk } = commands;
  const owns = (attempt: Attempt | null, variables: { input: BulkUpdateTasksInput } | null | undefined) => attempt !== null && variables?.input === attempt.input;
  const isHeld = (attempt: Attempt | null) => owns(attempt, latestCommands.current.bulk.pendingCommand?.variables) || owns(attempt, latestCommands.current.bulk.uncertain?.variables);
  const rowFor = (id: string) => latest.current.shownTasks.find(row => row.id === id) ?? latest.current.ledger.get(id);

  const captureFor = (task: TaskDto, field: BulkOrigin): Capture | null => {
    const { selectedTaskIds } = latest.current;
    if (field !== 'completion' && field !== 'custom' && !bulkFields.has(field) && !unsupportedFields.has(field)) return null;
    if (selectedTaskIds.length < 2 || !selectedTaskIds.includes(task.id)) return null;
    const kept = field === 'completion' || field === 'custom' ? undefined : latestCommands.current.editSessions.current.get(task.id);
    // The same base the cell's editor starts from: a changed retained draft keeps the head it was made against.
    const originBase = kept && changedKeys(draftFromTask(kept.base), kept.draft).length > 0 ? kept.base : task;
    const targets = selectedTaskIds.flatMap(id => {
      const row = id === task.id ? originBase : rowFor(id);
      return row ? [{ taskId: id, expectedRevision: row.revision, ...(field === 'estimate' ? { expectedWorkPackageRevision: row.workPackageRevision } : {}) }] : [];
    });
    return { originTaskId: task.id, field, count: selectedTaskIds.length, targets, missing: targets.length !== selectedTaskIds.length, unsupported: field !== 'completion' && field !== 'custom' && unsupportedFields.has(field) };
  };

  const refuse = (capture: Capture, key: Parameters<typeof message>[0]): InlineBulkVerdict => {
    setNotice({ capture, message: message(key) });
    return 'refused';
  };

  const settle = (attempt: Attempt, rows: readonly TaskDto[]) => {
    if (attempt.state !== 'sent') return;
    const origin = confirmedOrigin(attempt, rows);
    if (!origin) {
      // A partial or foreign answer confirms nothing; the retained draft and Reload stay.
      attempt.state = 'unconfirmed';
      setNotice({ capture: attempt.capture, message: message('bulkInline.unconfirmed') });
      return;
    }
    attempt.state = 'confirmed';
    latest.current.onConfirmed(rows);
    const { callbacks } = attempt;
    // The origin session is confirmed only now, after every selected row is.
    callbacks?.onConfirmed?.(origin);
    if (callbacks && attempt.live) callbacks.onSuccess(origin);
    else if (callbacks?.session) latestCommands.current.confirmSession(callbacks.session, origin);
    latest.current.onAnnounce(message(attempt.capture.field === 'completion' ? 'bulkInline.completed' : 'bulkInline.saved', { count: rows.length }));
    rerender(version => version + 1);
  };
  const release = (attempt: Attempt) => {
    if (attempt.live) { attempt.live = false; attempt.callbacks?.onSettled(); }
    rerender(version => version + 1);
  };

  const submit = (capture: Capture, changes: InlineBulkChanges, callbacks: InlineBulkCallbacks | null): InlineBulkVerdict => {
    const head = latest.current;
    const current = latestCommands.current;
    if (capture.unsupported) return refuse(capture, 'bulkInline.estimateUnsupported');
    if (unresolvedTaskCommand(current) !== null || head.busy) return refuse(capture, 'bulkInline.wait');
    if (!head.writable) return refuse(capture, 'bulkInline.notWritable');
    const rows = capture.targets.map(target => rowFor(target.taskId));
    if (capture.missing || rows.some(row => row === undefined)) return refuse(capture, 'bulkInline.missing');
    const loaded = rows as TaskDto[];
    if (loaded.some(row => row.projectId !== head.projectId || !canEditTaskInline(row))) return refuse(capture, 'bulkInline.ineligible');
    if (loaded.some((row, index) => row.revision !== capture.targets[index]?.expectedRevision || (changes.estimateMinutes !== undefined && row.workPackageRevision !== capture.targets[index]?.expectedWorkPackageRevision))) return refuse(capture, 'bulkInline.changed');
    if (capture.custom) {
      const field = head.fields?.find(field => field.id === capture.custom?.fieldId);
      if (!field || field.revision !== capture.custom.definitionRevision || field.locked || field.archivedAt !== null) return refuse(capture, 'bulkInline.changed');
      if (capture.targets.some(target => (head.fieldValues?.find(value => value.taskId === target.taskId && value.fieldId === field.id)?.revision ?? 0) !== target.expectedFieldValueRevision)) return refuse(capture, 'bulkInline.changed');
    }
    // The cell's own retained session is the one being sent; a circle has none of its own.
    if (capture.targets.some(target => (capture.field === 'completion' || target.taskId !== capture.originTaskId) && current.editSessions.current.has(target.taskId))) return refuse(capture, 'bulkInline.draft');
    if (changes.sectionId !== undefined && loaded.some(row => !canMoveTaskSection(row))) return refuse(capture, 'bulkInline.sectionRoots');
    const badRange = loaded.some(row => {
      const start = (changes.startDate === undefined ? row.startDate : changes.startDate) ?? null;
      const due = (changes.dueDate === undefined ? row.dueDate : changes.dueDate) ?? null;
      return start !== null && due !== null && start > due;
    });
    if (badRange) return refuse(capture, 'bulkInline.dateRange');
    if (loaded.every(row => alreadyApplied(row, changes))) { setNotice(null); return 'unchanged'; }
    // Only the cell's own keys, cloned once: later drafts, selections and views never reach this body.
    const input = { projectId: head.projectId, tasks: capture.targets.map(target => ({ ...target })), changes: structuredClone(changes) } as BulkUpdateTasksInput;
    const attempt: Attempt = { capture, input, callbacks, live: callbacks !== null, dataBefore: current.bulk.data, state: 'sent' };
    last.current = attempt;
    setNotice(null);
    current.bulk.mutate({ input }, { onSuccess: answer => settle(attempt, answer), onSettled: () => release(attempt) });
    return 'sent';
  };

  const retry = (capture: Capture, callbacks: InlineBulkCallbacks) => {
    const attempt = last.current;
    const current = latestCommands.current.bulk;
    if (!attempt || attempt.capture !== capture || attempt.state !== 'sent' || current.pendingCommand || !owns(attempt, current.uncertain?.variables) || !latest.current.writable) return;
    attempt.callbacks = callbacks; attempt.live = true;
    current.retryUncertain({ onSuccess: answer => settle(attempt, answer), onSettled: () => release(attempt) });
  };

  // An exact retry from the Toolbar settles the same attempt; the editor that sent it may be gone.
  const answer = bulk.data;
  useEffect(() => {
    const attempt = last.current;
    const current = latestCommands.current.bulk;
    if (!attempt || attempt.state !== 'sent' || answer === undefined || answer === attempt.dataBefore || current.pendingCommand || current.uncertain || !owns(attempt, current.variables)) return;
    settle(attempt, answer);
  });

  /** The held batch's origin cell, which alone may reopen while that batch is unresolved. */
  const holds = (taskId: string, field: TaskInlineField) => {
    const attempt = last.current;
    return attempt !== null && isHeld(attempt) && attempt.capture.originTaskId === taskId && attempt.capture.field === field;
  };

  return {
    holds,
    captureCustom: (task: TaskDto, field: TaskFieldDefinitionDto, value: TaskFieldValueDto | null, claim: object) => {
      const existing = captures.current.get(claim);
      if (existing) return;
      const capture = captureFor(task, 'custom');
      if (!capture) return;
      capture.custom = { fieldId: field.id, definitionRevision: field.revision };
      capture.missing ||= capture.targets.some(target => !latest.current.knownFieldTaskIds?.includes(target.taskId));
      capture.targets = capture.targets.map(target => ({ ...target, expectedFieldValueRevision: target.taskId === task.id ? value?.revision ?? 0 : latest.current.fieldValues?.find(value => value.taskId === target.taskId && value.fieldId === field.id)?.revision ?? 0 }));
      captures.current.set(claim, capture);
    },
    /** Freezes the selection for this explicit open; a plain or unselected row stays single-task. */
    capture: (task: TaskDto, field: TaskInlineField, claim: object) => {
      const attempt = last.current;
      const capture = attempt !== null && holds(task.id, field) ? attempt.capture : captureFor(task, field);
      if (capture) captures.current.set(claim, capture); else captures.current.delete(claim);
    },
    port: (claim: object): InlineBulkEditPort | undefined => {
      const capture = captures.current.get(claim);
      if (!capture) return undefined;
      const attempt = last.current?.capture === capture ? last.current : null;
      const pending = owns(attempt, bulk.pendingCommand?.variables);
      const uncertain = !pending && owns(attempt, bulk.uncertain?.variables);
      const error = uncertain ? bulk.uncertain?.error ?? null
        : attempt?.state === 'sent' && !pending && owns(attempt, bulk.variables) ? bulk.error : null;
      return {
        count: capture.count, pending, uncertain, error, unsupported: capture.unsupported,
        notice: notice?.capture === capture ? notice.message : capture.unsupported ? message('bulkInline.estimateUnsupported') : null,
        submit: (changes, callbacks) => submit(capture, changes, callbacks),
        retry: callbacks => retry(capture, callbacks),
      };
    },
    /** A circle pressed in a selected row of a multi-selection; false leaves the single-task completion. */
    complete: (task: TaskDto, statusId: string): boolean => {
      const capture = captureFor(task, 'completion');
      if (!capture) return false;
      submit(capture, { statusId }, null);
      return true;
    },
    completionPending: (taskId: string) => {
      const attempt = last.current;
      return attempt?.capture.field === 'completion' && attempt.capture.originTaskId === taskId && owns(attempt, bulk.pendingCommand?.variables);
    },
    /** A selected row of a multi-selection: its unsupported cells explain instead of writing alone. */
    selectsMany: (taskId: string) => context.selectedTaskIds.length > 1 && context.selectedTaskIds.includes(taskId),
    completionNotice: notice?.capture.field === 'completion' ? notice.message : null,
    dismissNotice: () => setNotice(null),
  };
}
