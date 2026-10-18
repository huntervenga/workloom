import { taskPrioritySchema, type MembershipDto, type SectionDto, type TagDto, type TaskDto, type TaskPriority, type TaskStatusDto, type TaskStatusGroup, type UpdateTaskInput, type BulkUpdateTasksInput } from '@workloom/contracts';
import { Button, cn } from '@workloom/ui';
import { Expand, LoaderCircle, X } from 'lucide-react';
import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type FormEvent, type KeyboardEvent, type ReactNode, type RefObject } from 'react';
import { useTranslation, type TranslationMessage } from '../../i18n';
import { ApiError, isAccessDenied } from '../../lib/api';
import { useUnsavedChangesWarning } from '../../lib/useUnsavedChangesWarning';
import { ChoicePicker, type ChoiceOption } from '../../shared/ChoicePicker';
import { SaveFeedback } from '../../shared/SaveFeedback';
import { CellPopover } from './CellPopover';
import { priorityLabels } from './TaskFields';
import { keepFocusOnPopoverPress, TaskDateInput } from './TaskDateInput';
import { TaskTagPicker } from './TaskTagPicker';
import { useInlineTagCreateBinding } from './inlineTagCreate';
import { buildUpdateInput, changedKeys, draftFromTask, TASK_TITLE_MAX, type TaskDraft, type TaskDraftErrors } from './taskDraft';
import { revealInlineEditor } from '../task-table/TaskTable';
import type { WorkPackageEntry } from '../task-table/workPackages';
import { parseEstimateInput } from '../task-table/estimate';
import { canEditTaskInline, canResumeInlineSession, isCurrentEstimateProjection, type TaskInlineField } from './tableEditing';
import { unresolvedTaskCommand, type EditSession, type TaskCommands } from './useTaskCommands';

/**
 * Why a cell editor closed without a confirmed save: `cancel` (Escape/Collapse) returns focus to
 * the cell, `blur` leaves focus where the person moved it, and `next` is a plain Enter on an
 * unchanged title, which the page may continue into the next quick task.
 */
export type InlineCloseReason = 'cancel' | 'blur' | 'next';

/** What the page should do after this submitted draft is confirmed. */
export interface InlineSaveIntent {
  /** Plain Enter in the title: continue with a new task below when the page finds it appropriate. */
  continueWithNext: boolean;
}

/** The keys one selected cell may apply to its whole selection; never a title, description or personal hours. */
export type InlineBulkChanges = BulkUpdateTasksInput['changes'];
/** `unchanged`: every target already holds the value; `refused`: nothing was sent and the port's notice says why. */
export type InlineBulkVerdict = 'sent' | 'unchanged' | 'refused';
export interface InlineBulkCallbacks {
  /** The exact submitted session; it is confirmed only once the whole batch is. */
  session?: EditSession;
  onConfirmed?: (origin: TaskDto) => void;
  onSuccess: (origin: TaskDto) => void;
  onSettled: () => void;
}
/**
 * Page-owned submission for a cell opened in a selected row of a multi-selection: one atomic
 * batch to the selection frozen at open. While it is given, this editor never writes the row alone.
 */
export interface InlineBulkEditPort {
  count: number;
  pending: boolean;
  uncertain: boolean;
  /** The batch's own definite or unknown failure. */
  error: Error | null;
  /** Why nothing was sent, or why this field stays single-task only. */
  notice: TranslationMessage | null;
  /** The field cannot be applied to a selection yet; the cell only explains that. */
  unsupported: boolean;
  submit: (changes: InlineBulkChanges, callbacks: InlineBulkCallbacks) => InlineBulkVerdict;
  retry: (callbacks: InlineBulkCallbacks) => void;
}

/** Only this cell's own keys reach a selection; an explicit choice applies even where this row already holds it. */
function bulkChanges(field: TaskInlineField, draft: TaskDraft, input: UpdateTaskInput | null, chosen: boolean, touched: ReadonlySet<keyof TaskDraft>): InlineBulkChanges | null {
  switch (field) {
    case 'statusId': return chosen || input?.statusId !== undefined ? { statusId: draft.statusId } : null;
    case 'priority': return chosen || input?.priority !== undefined ? { priority: draft.priority } : null;
    case 'responsibleMembershipId': return chosen || input?.responsibleMembershipId !== undefined ? { responsibleMembershipId: draft.responsibleMembershipId } : null;
    case 'sectionId': return chosen || input?.sectionId !== undefined ? { sectionId: draft.sectionId } : null;
    case 'tagIds': return touched.has('tagIds') ? { tagIds: [...draft.tagIds] } : null;
    // Only deliberately edited endpoints propagate; typing the origin's existing value is still intentional.
    case 'dueDate':
      return touched.has('startDate') || touched.has('dueDate') ? {
        ...(touched.has('startDate') ? { startDate: draft.startDate || null } : {}),
        ...(touched.has('dueDate') ? { dueDate: draft.dueDate || null } : {}),
      } : null;
    case 'estimate': {
      const parsed = parseEstimateInput(draft.estimate);
      return touched.has('estimate') && parsed.valid ? { estimateMinutes: parsed.minutes } : null;
    }
    case 'title': return null;
  }
}

export interface InlineTaskEditProps {
  /** One claim per explicit open; card/view remounts must not steal focus. */
  focusClaim?: RefObject<boolean>;
  /** Title only: the clicked character's offset, applied once by the open that consumes `focusClaim`. */
  titleCaret?: number | undefined;
  task: TaskDto;
  field: TaskInlineField;
  statuses: readonly TaskStatusDto[];
  members: readonly MembershipDto[];
  /** Project sections for the section move; only active ones are offered. */
  sections?: readonly SectionDto[] | undefined;
  tags?: readonly TagDto[] | undefined;
  commands: TaskCommands;
  writable: boolean;
  estimatePackages?: ReadonlyMap<string, WorkPackageEntry> | undefined;
  onClose: (reason?: InlineCloseReason) => void;
  onMoreDetails: () => void;
  onSaved: (task: TaskDto) => void;
  /** Page-owned completion survives a row moving to another group or Board lane. */
  onSaveStarted?: ((form: HTMLFormElement, intent: InlineSaveIntent) => { onSuccess: (task: TaskDto) => void; onSettled: () => void }) | undefined;
  /** Given only for a selected row of a multi-selection; absent keeps the single-task command. */
  bulkEdit?: InlineBulkEditPort | undefined;
  singleOnly?: boolean | undefined;
}

const statusColors: Record<TaskStatusGroup, string> = { todo: '#94a3b8', in_progress: '#6366f1', done: '#10b981', cancelled: '#cbd5e1' };
const priorityColors: Partial<Record<TaskPriority, string>> = { low: '#94a3b8', medium: '#64748b', high: '#d97706', urgent: '#e11d48' };
const choiceFields = new Set<TaskInlineField>(['statusId', 'priority', 'responsibleMembershipId', 'sectionId']);

/** A fixed-height cell control: it fills the cell and never changes the row or column size. */
const cellInputClassName = cn('block h-8 w-full min-w-0 border border-accent-line bg-surface px-2 text-sm text-ink outline-none ring-2 ring-accent-soft placeholder:text-subtle read-only:bg-canvas read-only:text-muted aria-[invalid=true]:border-red-300 aria-[invalid=true]:ring-red-100', 'rounded');
const iconActionClassName = cn('inline-flex size-7 shrink-0 items-center justify-center text-muted hover:bg-canvas hover:text-ink disabled:opacity-50', 'rounded');

/**
 * Uses the exact seen task revision; only this cell's field can enter the update. Choices save
 * at once through the same command; text saves on Enter or when focus leaves the editor.
 */
export function InlineTaskEdit({ task, field, statuses, members, sections = [], tags = [], commands, writable, onClose, onMoreDetails, onSaved, focusClaim, titleCaret, onSaveStarted, estimatePackages, bulkEdit, singleOnly }: InlineTaskEditProps) {
  const { t } = useTranslation();
  const shouldFocus = focusClaim?.current !== true;
  useLayoutEffect(() => { if (focusClaim) focusClaim.current = true; }, [focusClaim]);
  // Latched at mount with the claim: refreshes, ACKs and remounts with a consumed claim never move the caret.
  const [mountCaret] = useState(() => shouldFocus && field === 'title' && titleCaret !== undefined && Number.isFinite(titleCaret) ? titleCaret : undefined);
  const titleInput = useRef<HTMLInputElement | null>(null);
  const caretPending = useRef(mountCaret !== undefined);
  useLayoutEffect(() => {
    if (!caretPending.current || mountCaret === undefined) return;
    caretPending.current = false;
    const input = titleInput.current;
    if (!input) return;
    const at = Math.min(Math.max(Math.trunc(mountCaret), 0), input.value.length);
    input.focus({ preventScroll: true });
    input.setSelectionRange(at, at);
  }, [mountCaret]);
  // The same one-shot claim reveals the explicitly opened editor once; late ACKs, refreshes and remounts never pan.
  const revealOnMount = useRef(shouldFocus);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const formRef = useRef<HTMLFormElement | null>(null);
  const attach = useCallback((node: HTMLElement | null) => {
    formRef.current = node instanceof HTMLFormElement ? node : null;
    setAnchor(node);
    if (!node || !revealOnMount.current) return;
    revealOnMount.current = false;
    revealInlineEditor(node);
  }, []);
  const [foreignDraft] = useState(() => {
    const kept = commands.editSessions.current.get(task.id);
    return kept !== undefined && !canResumeInlineSession(kept, field);
  });
  const [session, setSession] = useState<EditSession>(() => {
    const kept = commands.editSessions.current.get(task.id);
    if (!kept || changedKeys(draftFromTask(kept.base), kept.draft).length === 0) return { base: task, draft: draftFromTask(task), inlineField: field, draftId: crypto.randomUUID() };
    // Stamped in place: the kept object's identity is its confirmation key across remounts.
    kept.draftId ??= crypto.randomUUID();
    return kept;
  });
  const touched = useRef(new Set<keyof TaskDraft>());
  const [errors, setErrors] = useState<TaskDraftErrors>({});
  const id = useId();
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const { update, editSessions } = commands;
  const confirmed = commands.confirmedSessions.current.get(session);
  useEffect(() => {
    if (!confirmed) return;
    setSession({ base: confirmed, draft: draftFromTask(confirmed), inlineField: field, draftId: crypto.randomUUID() });
    setErrors({});
  }, [confirmed, field]);
  const choice = choiceFields.has(field);
  const unresolved = unresolvedTaskCommand(commands);
  // A selection port answers for its own batch first; any other held command still blocks this cell.
  const pending = update.pendingCommand?.variables.taskId === task.id || bulkEdit?.pending === true;
  const uncertain = update.uncertain?.variables.taskId === task.id || bulkEdit?.uncertain === true;
  const blocked = unresolved !== null && !pending && !uncertain;
  const ownError = bulkEdit ? (bulkEdit.uncertain ? null : bulkEdit.error)
    : update.variables?.taskId === task.id && update.variables.input.expectedRevision === session.base.revision ? update.error : null;
  const denied = isAccessDenied(ownError);
  const needsReview = ownError instanceof ApiError && ownError.kind === 'conflict';
  const editable = writable && canEditTaskInline(task) && !denied;
  const staleEstimate = field === 'estimate' && !isCurrentEstimateProjection(session.base, estimatePackages);
  const frozen = pending || uncertain || blocked || !editable;
  const dirty = changedKeys(draftFromTask(session.base), session.draft).length > 0;
  useUnsavedChangesWarning(dirty || uncertain);
  useEffect(() => {
    if (foreignDraft || confirmed) return;
    if (dirty || pending || uncertain) editSessions.current.set(task.id, session);
    else editSessions.current.delete(task.id);
  }, [confirmed, dirty, editSessions, foreignDraft, pending, session, task.id, uncertain]);
  // A created tag is only added to the very draft and base it was created from, never saved by it.
  const tagDraftId = session.draftId;
  const tagBaseRevision = session.base.revision;
  const tagOriginId = `edit:${task.id}:${tagDraftId}:${tagBaseRevision}`;
  const creation = useInlineTagCreateBinding(commands.inlineTags, {
    origin: { id: tagOriginId, taskId: task.id, label: task.title },
    canAttach: field === 'tagIds' && !foreignDraft && editable && !frozen && !needsReview && !pending && !uncertain,
    onSelect: tag => { touched.current.add('tagIds'); setSession(before => before.draftId !== tagDraftId || before.base.revision !== tagBaseRevision ? before
      : before.draft.tagIds.some(kept => kept.toLowerCase() === tag.id.toLowerCase()) ? before
      : { ...before, draft: { ...before.draft, tagIds: [...before.draft.tagIds, tag.id] } }); },
  });
  // This cell's own unanswered create holds its submit; other cells and recovery are unaffected.
  const tagHeld = field === 'tagIds' && creation.held;
  // Read live at event time: a create started this turn holds before React re-renders.
  const isTagHeld = () => field === 'tagIds' && commands.inlineTags.isHeld(tagOriginId);

  const currentError = errors.dueDate ?? errors.form ?? errors.title ?? errors.description ?? errors.startDate ?? errors.estimate;
  const bulkNotice = bulkEdit?.notice ?? null;
  const bulkCopy = bulkEdit && !bulkEdit.unsupported ? t('bulkInline.appliesTo', { count: bulkEdit.count }) : null;
  const hasFeedback = staleEstimate || Boolean(currentError) || blocked || ownError !== null || uncertain || bulkNotice !== null;

  const saved = (submitted: EditSession, result: TaskDto, bridge?: ReturnType<NonNullable<InlineTaskEditProps['onSaveStarted']>>) => {
    if (!commands.confirmSession(submitted, result)) return;
    if (bridge) { bridge.onSuccess(result); return; }
    onSaved(result);
    if (!mounted.current) return;
    setSession({ base: result, draft: draftFromTask(result), inlineField: field, draftId: crypto.randomUUID() });
    setErrors({});
    onClose();
  };
  /** The selection's one batch: never a single-task write, and the session is retained exactly as sent. */
  const submitBulk = (form: HTMLFormElement, current: EditSession, changes: InlineBulkChanges | null) => {
    if (!bulkEdit || bulkEdit.unsupported) return;
    if (changes === null) { editSessions.current.delete(task.id); onClose('cancel'); return; }
    editSessions.current.set(task.id, current);
    const bridge = onSaveStarted?.(form, { continueWithNext: false });
    const verdict = bulkEdit.submit(changes, { session: current, onSuccess: origin => saved(current, origin, bridge), onSettled: () => bridge?.onSettled() });
    if (verdict === 'sent') return;
    bridge?.onSettled();
    if (verdict === 'unchanged') { editSessions.current.delete(task.id); onClose('cancel'); }
  };
  /** One explicit submission of exactly this session object; its identity is the confirmation key. */
  const submitSession = (current: EditSession, intent: InlineSaveIntent, chosen = false) => {
    const form = formRef.current;
    if (!form || confirmed || pending || blocked || !editable || needsReview || staleEstimate || isTagHeld()) return;
    // A drawer or another cell's draft must never be submitted through this control.
    if (!canResumeInlineSession(current, field)) return;
    const result = buildUpdateInput(current.base, draftFromTask(current.base), current.draft);
    if (!result.ok) { setErrors(result.errors); return; }
    setErrors({});
    if (bulkEdit) { submitBulk(form, current, bulkChanges(field, current.draft, result.input, chosen, touched.current)); return; }
    if (result.input === null) { editSessions.current.delete(task.id); onClose(intent.continueWithNext ? 'next' : 'cancel'); return; }
    // Retain the sent session before rendering, so recovery and confirmation see the same object.
    editSessions.current.set(task.id, current);
    const bridge = onSaveStarted?.(form, intent);
    update.mutate({ taskId: task.id, input: result.input }, { onSuccess: confirmedTask => saved(current, confirmedTask, bridge), onSettled: () => bridge?.onSettled() });
  };
  const retry = () => {
    const form = formRef.current;
    if (!form || !uncertain) return;
    const bridge = onSaveStarted?.(form, { continueWithNext: false });
    if (bulkEdit?.uncertain) { bulkEdit.retry({ session, onSuccess: result => saved(session, result, bridge), onSettled: () => bridge?.onSettled() }); return; }
    update.retryUncertain({ onSuccess: result => saved(session, result, bridge), onSettled: () => bridge?.onSettled() });
  };

  // Leaving the editor commits text (with validation) or closes an unchanged one. Read at event time.
  const leave = useRef<() => void>(() => undefined);
  leave.current = () => {
    if (choice || confirmed || pending || uncertain || blocked || isTagHeld()) return;
    if (!dirty) { if (!hasFeedback) onClose('blur'); return; }
    submitSession(session, { continueWithNext: false });
  };
  // A dismissed picker (Escape, outside press, Tab) closes the editor unless it shows feedback.
  // Only a keyboard dismissal that leaves focus on the trigger returns it to the cell.
  const chose = useRef(false);
  const continueNext = useRef(false);
  const dismiss = useRef<(trigger: HTMLElement, pressedOutside: boolean) => void>(() => undefined);
  dismiss.current = (trigger, pressedOutside) => {
    if (confirmed || pending || uncertain || hasFeedback) return;
    onClose(!pressedOutside && document.activeElement === trigger ? 'cancel' : 'blur');
  };
  // Latched at mount: this editor's own claim is consumed by its first commit, and a sent or
  // blocked command at mount keeps the list closed.
  const openOnMount = useRef(shouldFocus && !frozen);
  useLayoutEffect(() => {
    if (!choice || !anchor) return undefined;
    const trigger = anchor.querySelector<HTMLElement>('[role="combobox"]');
    if (!trigger) return undefined;
    // An explicit open shows the choices at once; remounts and late answers never reopen them.
    if (openOnMount.current) { openOnMount.current = false; trigger.click(); }
    let wasOpen = trigger.getAttribute('aria-expanded') === 'true';
    // The picker closes on an outside press before focus moves, so the press itself is recorded.
    // Window capture runs before the picker's own document listener; any key resets it.
    let pressedOutside = false;
    const press = (event: PointerEvent) => {
      const target = event.target;
      pressedOutside = target instanceof Element && !anchor.contains(target) && target.closest('[data-choice-picker-menu]') === null;
    };
    const key = () => { pressedOutside = false; };
    window.addEventListener('pointerdown', press, true);
    window.addEventListener('keydown', key, true);
    const observer = new MutationObserver(() => {
      const open = trigger.getAttribute('aria-expanded') === 'true';      setPickerOpen(open);
      if (wasOpen && !open) {
        const madeChoice = chose.current;
        chose.current = false;
        if (!madeChoice) dismiss.current(trigger, pressedOutside);
        pressedOutside = false;
      }
      wasOpen = open;
    });
    observer.observe(trigger, { attributes: true, attributeFilter: ['aria-expanded'] });
    return () => {
      observer.disconnect();
      window.removeEventListener('pointerdown', press, true);
      window.removeEventListener('keydown', key, true);
    };
  }, [anchor, choice]);

  // Escape cancels only this field's never-submitted buffer. Sent/unknown commands and a
  // foreign full-form draft keep their owner and exact recovery payload after the view closes.
  const cancelInline = () => {
    if (!foreignDraft && !confirmed && !pending && !uncertain && ownError === null && !isTagHeld()) {
      const retained = editSessions.current.get(task.id);
      if (retained === session) editSessions.current.delete(task.id);
    }
    onClose('cancel');
  };
  const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); cancelInline(); } };
  const actions = (primary: ReactNode) => <div data-inline-actions="" className="flex min-w-0 flex-wrap items-center gap-1">
    {primary}
    <button type="button" className={iconActionClassName} title={t('tasks.quickAdd.moreDetails')} aria-label={t('tasks.quickAdd.moreDetails')} disabled={pending || uncertain || blocked} onClick={() => { editSessions.current.set(task.id, session); onMoreDetails(); }}><Expand size={14} aria-hidden="true" /></button>
    <button type="button" className={iconActionClassName} title={t('tasks.quickAdd.collapse')} aria-label={t('tasks.quickAdd.collapse')} onClick={() => onClose('cancel')}><X size={14} aria-hidden="true" /></button>
  </div>;

  // A selection cannot take this field yet: the cell explains that and sends nothing, not even for this row.
  const bulkUnsupported = bulkEdit?.unsupported === true && !foreignDraft && editable;
  // Recovery-only states keep the cell one line; their explanation and actions sit in the popover.
  if (foreignDraft || (!editable && !uncertain) || bulkUnsupported) return <div ref={attach} onKeyDown={escape} className="flex h-8 min-w-0 items-center px-1.5">
    <span className="truncate rounded-full bg-amber-50 px-1.5 py-px text-[11px] font-medium text-amber-800 ring-1 ring-inset ring-amber-200">{foreignDraft ? t('tasks.inlineEdit.draft') : bulkUnsupported ? t('bulkInline.unsupportedShort') : t('tasks.inlineEdit.notEditableShort')}</span>
    <CellPopover anchor={anchor}>
      <p>{foreignDraft ? t('tasks.inlineEdit.existingDraft') : bulkUnsupported ? bulkNotice ? t(bulkNotice.key, bulkNotice.params) : t('bulkInline.estimateUnsupported') : t('tasks.inlineEdit.notEditable')}</p>
      <div data-inline-actions="" className="flex min-w-0 flex-wrap items-center gap-1">
        {bulkUnsupported ? null : <Button autoFocus={shouldFocus} size="sm" onClick={onMoreDetails}>{foreignDraft ? t('tasks.quickAdd.resumeDraft') : t('tasks.quickAdd.moreDetails')}</Button>}
        <Button autoFocus={bulkUnsupported && shouldFocus} size="sm" variant="ghost" onClick={() => onClose('cancel')}>{t('tasks.quickAdd.collapse')}</Button>
      </div>
    </CellPopover>
  </div>;

  const change = (patch: Partial<TaskDraft>) => {
    for (const key of Object.keys(patch) as (keyof TaskDraft)[]) touched.current.add(key);
    setSession(before => ({ ...before, draft: { ...before.draft, ...patch } }));
    setErrors({});
  };
  const choose = (value: string) => {
    chose.current = true;
    const patch: Partial<TaskDraft> | null = field === 'statusId' ? { statusId: value } : field === 'responsibleMembershipId' ? { responsibleMembershipId: value || null } : field === 'sectionId' ? { sectionId: value || null } : (() => {
      const priority = taskPrioritySchema.safeParse(value);
      return priority.success ? { priority: priority.data } : null;
    })();
    if (!patch) return;
    const next: EditSession = { ...session, draft: { ...session.draft, ...patch } };
    setSession(next);
    setErrors({});
    submitSession(next, { continueWithNext: false }, true);
  };
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (event.target !== event.currentTarget || confirmed || pending || blocked) return;
    if (uncertain) { retry(); return; }
    submitSession(session, { continueWithNext: continueNext.current });
    continueNext.current = false;
  };
  const describedBy = [field === 'estimate' ? `${id}-estimate-help` : '', currentError ? `${id}-error` : '', staleEstimate ? `${id}-estimate-source` : ''].filter(Boolean).join(' ') || undefined;
  const textProps = {
    autoFocus: shouldFocus, readOnly: frozen, 'aria-disabled': frozen || undefined, 'aria-invalid': Boolean(currentError) || undefined,
    'aria-describedby': describedBy, autoComplete: 'off', className: cellInputClassName,
  } as const;
  const statusOptions: ChoiceOption[] = [
    ...(!statuses.some(status => status.id === session.draft.statusId) ? [{ value: session.draft.statusId, label: t('tasks.taskFields.statusUnavailable'), disabled: true }] : []),
    ...[...statuses].sort((a, b) => a.position - b.position).map(status => ({ value: status.id, label: status.name, color: statusColors[status.group] })),
  ];
  const assigneeOptions: ChoiceOption[] = [
    { value: '', label: t('tasks.taskFields.unassigned') },
    ...(session.draft.responsibleMembershipId && !members.some(member => member.id === session.draft.responsibleMembershipId) ? [{ value: session.draft.responsibleMembershipId, label: t('tasks.taskFields.memberUnavailable'), disabled: true }] : []),
    ...members.map(member => ({ value: member.id, label: member.displayName, avatarName: member.displayName, avatarUrl: member.avatarUrl })),
  ];
  const priorityOptions: ChoiceOption[] = taskPrioritySchema.options.map(priority => ({ value: priority, label: priorityLabels[priority], color: priorityColors[priority] }));
  // Active sections in their project order. A current archived or unknown section stays visible
  // and selected, but is never offered as a move target.
  const draftSection = session.draft.sectionId;
  const heldSection = draftSection === null ? undefined : sections.find(section => section.id === draftSection);
  const heldUnavailable = draftSection !== null && (heldSection === undefined || heldSection.archivedAt !== null);
  const sectionOptions: ChoiceOption[] = [
    { value: '', label: t('tasks.taskFields.noSection') },
    ...(heldUnavailable ? [{ value: draftSection ?? '', label: heldSection ? t('tasks.taskFields.valueArchived', { p0: heldSection.name }) : t('tasks.taskFields.sectionUnavailable'), disabled: true }] : []),
    ...sections.filter(section => section.archivedAt === null).sort((a, b) => a.position - b.position || a.id.localeCompare(b.id)).map(section => ({ value: section.id, label: section.name })),
  ];
  // Tags created inline fill the catalog until the tag list refetches; fetched tags win.
  const knownTags = [...task.tags, ...tags];
  const tagCatalog = [...new Map([...knownTags, ...commands.createdTags.filter(created => !knownTags.some(tag => tag.id.toLowerCase() === created.id.toLowerCase()))]
    .map(tag => [tag.id.toLowerCase(), tag])).values()];
  const picker = (label: string, value: string, options: readonly ChoiceOption[], searchable?: boolean) => <ChoicePicker compact autoFocus={shouldFocus} label={label} value={value} options={options} searchable={searchable}
    disabled={frozen || needsReview} aria-describedby={describedBy} aria-invalid={Boolean(currentError) || undefined} onValueChange={choose} />;
  const control = field === 'statusId' ? picker(t('tasks.taskFields.status'), session.draft.statusId, statusOptions)
    : field === 'priority' ? picker(t('tasks.taskFields.priority'), session.draft.priority, priorityOptions)
    : field === 'responsibleMembershipId' ? picker(t('tasks.taskFields.assignee'), session.draft.responsibleMembershipId ?? '', assigneeOptions, true)
    : field === 'sectionId' ? picker(t('tasks.taskFields.section'), draftSection ?? '', sectionOptions)
    : field === 'estimate' ? <input {...textProps} type="text" aria-label={t('tasks.inlineEstimate.label')} value={session.draft.estimate} onChange={event => change({ estimate: event.target.value })} />
    : field === 'title' ? <input {...textProps} ref={titleInput} autoFocus={shouldFocus && mountCaret === undefined} type="text" aria-label={t('tasks.taskFields.taskName')} maxLength={TASK_TITLE_MAX} value={session.draft.title} onChange={event => change({ title: event.target.value })} />
    : <span className="min-w-0 truncate px-1 text-sm">{field === 'tagIds'
      ? tagCatalog.filter(tag => session.draft.tagIds.some(id => id.toLowerCase() === tag.id.toLowerCase())).map(tag => tag.name).join(', ') || t('tasks.taskFields.noTags')
      : session.draft.dueDate || t('tasks.taskFields.noDueDate')}</span>;
  const primary = uncertain ? <Button size="sm" className="h-7 px-2" variant="primary" type="submit">{t('tasks.inlineEdit.retry')}</Button>
    : choice ? null
    : <Button size="sm" className="h-7 px-2" variant="primary" type="submit" aria-disabled={pending || blocked || !writable || needsReview || staleEstimate || tagHeld || undefined}>{pending ? t('tasks.inlineEdit.saving') : t('tasks.inlineEdit.save')}</Button>;
  const popoverShown = (hasFeedback || singleOnly || bulkCopy !== null || field === 'estimate' || field === 'dueDate' || field === 'tagIds') && !pickerOpen;
  return <form ref={attach} noValidate aria-label={t('tasks.inlineEdit.form', { title: task.title })} aria-busy={pending || undefined} onSubmit={submit}
    // A held press on a date/tag panel's static content must not blur into the deferred autosave below.
    onMouseDown={field === 'dueDate' || field === 'tagIds' ? keepFocusOnPopoverPress : undefined}
    onKeyDown={event => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); cancelInline(); return; }
      if (choice || event.key !== 'Enter' || !(event.target instanceof HTMLInputElement) || event.target.closest('form') !== event.currentTarget) return;
      if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
      event.preventDefault();
      if (frozen || needsReview || staleEstimate || event.altKey || event.shiftKey) return;
      // Plain Enter on a title continues to the next quick task; Ctrl/Cmd+Enter only saves.
      continueNext.current = field === 'title' && !event.ctrlKey && !event.metaKey;
      event.currentTarget.requestSubmit();
    }}
    onBlur={event => {
      const form = event.currentTarget;
      if (event.relatedTarget instanceof Node) {
        if (form.contains(event.relatedTarget)) return;
        // Commit before the next cell's click can replace this form. Null relatedTarget
        // still needs the deferred active-element check for window switches.
        leave.current();
        return;
      }
      window.setTimeout(() => {
        // A window switch keeps the active element; only a real move out of the editor commits.
        if (!mounted.current || !form.isConnected || (document.activeElement !== null && form.contains(document.activeElement))) return;
        leave.current();
      }, 0);
    }}
    className="relative flex h-8 min-w-0 items-center">
    {control}
    {pending ? <><LoaderCircle size={14} aria-hidden="true" className="pointer-events-none absolute right-2 text-muted motion-safe:animate-spin" /><span role="status" className="sr-only">{t('tasks.inlineEdit.saving')}</span></> : null}
    {/* The selection count overlays the fixed cell; while an open list hides the popover, it is also the live copy. */}
    {bulkCopy !== null ? <span aria-hidden="true" data-bulk-count="" className="pointer-events-none absolute right-7 rounded-full bg-accent-soft px-1.5 text-[11px] font-medium leading-4 text-accent-ink tabular-nums">{t('bulkInline.badge', { count: bulkEdit?.count ?? 0 })}</span> : null}
    {bulkCopy !== null && !popoverShown ? <span role="status" className="sr-only">{bulkCopy}</span> : null}
    {popoverShown ? <CellPopover anchor={anchor} side={choice ? 'top' : 'bottom'}
      className={field === 'dueDate' ? 'max-h-[calc(100dvh-16px)] overflow-y-auto' : undefined}
      role={field === 'dueDate' || field === 'tagIds' ? 'dialog' : undefined}
      ariaLabel={field === 'dueDate' ? t('tasks.dates.edit') : field === 'tagIds' ? t('tasks.tags.edit') : undefined}>
      {singleOnly ? <p role="status" className="font-medium text-muted">{t('bulkInline.singleOnly')}</p> : null}
      {bulkCopy !== null ? <p role="status" className="font-medium text-accent-ink">{bulkCopy}</p> : null}
      {field === 'dueDate' ? <TaskDateInput startDate={session.draft.startDate ?? ''} dueDate={session.draft.dueDate} onChange={change} disabled={frozen || needsReview}
        autoFocus={shouldFocus} errors={{ startDate: errors.startDate ? t(errors.startDate.key, errors.startDate.params) : undefined, dueDate: errors.dueDate ? t(errors.dueDate.key, errors.dueDate.params) : undefined }} /> : null}
      {field === 'tagIds' ? <TaskTagPicker tags={tagCatalog} values={session.draft.tagIds} onChange={tagIds => change({ tagIds })} disabled={frozen || needsReview} autoFocus={shouldFocus}
        creation={creation} onRequestClose={cancelInline}
        // Always offered; an unanswered save or create keeps this mount, so its answer is not lost.
        manageAction={<Button size="sm" variant="ghost" disabled={pending || uncertain || blocked || tagHeld} onClick={() => { if (isTagHeld()) return; editSessions.current.set(task.id, session); onMoreDetails(); }}>{t('tasks.tags.createInDetails')}</Button>} /> : null}
      {field === 'estimate' ? <p id={`${id}-estimate-help`} className="text-muted">{t('tasks.inlineEstimate.sharedHelp')} {t('tasks.inlineEstimate.formatHelp')}</p> : null}
      {staleEstimate ? <p id={`${id}-estimate-source`} role="status" className="text-amber-800">{t('tasks.inlineEstimate.refreshRequired')}</p> : null}
      {currentError && !(field === 'dueDate' && (errors.startDate || errors.dueDate)) ? <p role="alert" id={`${id}-error`} className="text-red-700">{t(currentError.key, currentError.params)}</p> : null}
      {blocked ? <p role="status" className="text-amber-800">{t('tasks.quickAdd.otherCommand')}</p> : null}
      {bulkNotice !== null ? <p role="alert" className="text-red-700">{t(bulkNotice.key, bulkNotice.params)}</p> : null}
      <SaveFeedback subject="taskSave" error={ownError} uncertainError={uncertain ? (bulkEdit?.uncertain ? bulkEdit.error : update.uncertain?.error) ?? null : null} />
      {actions(primary)}
    </CellPopover> : null}
  </form>;
}
