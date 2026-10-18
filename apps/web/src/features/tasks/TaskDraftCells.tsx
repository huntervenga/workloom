import { taskPrioritySchema, type TagDto, type TaskPriority, type TaskStatusGroup } from '@workloom/contracts';
import { cn } from '@workloom/ui';
import { ChevronDown } from 'lucide-react';
import { useId, useRef, useState, type FocusEvent, type KeyboardEvent, type ReactNode } from 'react';
import { useTranslation } from '../../i18n';
import { ChoicePicker, type ChoiceOption } from '../../shared/ChoicePicker';
import { CellPopover } from './CellPopover';
import { keepFocusOnPopoverPress, TaskDateInput } from './TaskDateInput';
import { fieldLabels, formatDraftValue, priorityLabels, type TaskLookups } from './TaskFields';
import type { InlineTagCreateBinding } from './inlineTagCreate';
import { TaskTagPicker } from './TaskTagPicker';
import { changedKeys, emptyDraft, type TaskDraft, type TaskDraftErrors, type TaskDraftKey } from './taskDraft';

/** Built-in table columns an unsaved task row edits locally; nothing is written until its title is submitted. */
export const taskDraftCellIds = ['status', 'responsible', 'participants', 'startDate', 'dueDate', 'priority', 'tags', 'estimate'] as const;
export type TaskDraftCellId = (typeof taskDraftCellIds)[number];

export function isTaskDraftCellId(columnId: string): columnId is TaskDraftCellId {
  return (taskDraftCellIds as readonly string[]).includes(columnId);
}

const draftKeys: Record<TaskDraftCellId, TaskDraftKey> = {
  status: 'statusId', responsible: 'responsibleMembershipId', participants: 'participantMembershipIds', startDate: 'startDate',
  dueDate: 'dueDate', priority: 'priority', tags: 'tagIds', estimate: 'estimate',
};

export interface TaskDraftCellContext {
  draft: TaskDraft;
  onChange: (patch: Partial<TaskDraft>) => void;
  lookups: TaskLookups;
  disabled: boolean;
  errors: TaskDraftErrors;
  /** ID of the visible message for an invalid field. */
  errorId: (field: keyof TaskDraftErrors) => string;
  /** A detail subtask shares its parent's package, so it neither edits nor sends an estimate. */
  inheritsEstimate: boolean;
  /** Marks portalled lists as part of the row, so moving into them does not leave the row. */
  rowKey: string;
  /** The row owner's guarded handoff, unavailable while extras or unresolved commands prevent it. */
  onMoreDetails?: (() => void) | undefined;
  /** Inline workspace tag creation for this row's draft; a confirmed tag is only selected locally. */
  tagCreate?: InlineTagCreateBinding | undefined;
}

/**
 * Renders one draft cell, or null for a column without a local draft value. A later atomic
 * adapter (custom fields, time) wraps this and answers only for its own columns; no cell here
 * writes on its own or shows a value the draft does not hold.
 */
export type TaskDraftCellRenderer = (columnId: string, context: TaskDraftCellContext) => ReactNode;

export const renderTaskDraftCell: TaskDraftCellRenderer = (columnId, context) => {
  if (!isTaskDraftCellId(columnId) || (columnId === 'estimate' && context.inheritsEstimate)) return null;
  return <TaskDraftCell cell={columnId} context={context} />;
};

/** The frozen display text of a submitted draft's cell; unset values and unknown columns show nothing. */
export function taskDraftPreviewText(columnId: string, draft: TaskDraft, lookups: TaskLookups, inheritsEstimate: boolean): string | null {
  if (!isTaskDraftCellId(columnId) || (columnId === 'estimate' && inheritsEstimate)) return null;
  const key = draftKeys[columnId];
  if (key !== 'statusId' && !changedKeys(emptyDraft(draft.statusId, draft.sectionId), draft).includes(key)) return null;
  return formatDraftValue(key, draft, lookups);
}

const statusColors: Record<TaskStatusGroup, string> = { todo: '#94a3b8', in_progress: '#6366f1', done: '#10b981', cancelled: '#cbd5e1' };
const priorityColors: Partial<Record<TaskPriority, string>> = { low: '#94a3b8', medium: '#64748b', high: '#d97706', urgent: '#e11d48' };

/** Same fixed height as table cell editors; the row never grows. */
const cellInputClassName = cn('block h-8 w-full min-w-0 border border-transparent bg-transparent px-2 text-sm text-ink outline-none hover:border-line focus:border-accent-line focus:ring-2 focus:ring-accent-soft read-only:text-muted aria-[invalid=true]:border-red-300', 'rounded');
const cellPickerClassName = 'border-transparent bg-transparent shadow-none';

function TaskDraftCell({ cell, context }: { cell: TaskDraftCellId; context: TaskDraftCellContext }) {
  const { t } = useTranslation();
  const { draft, onChange, lookups, disabled, errors, errorId, rowKey } = context;
  const invalid = (field: keyof TaskDraftErrors) => errors[field] ? { 'aria-invalid': true, 'aria-describedby': errorId(field) } as const : {};
  const members = lookups.members;
  switch (cell) {
    case 'status': {
      const options: ChoiceOption[] = [
        ...(!lookups.statuses.some(status => status.id === draft.statusId) ? [{ value: draft.statusId, label: t('tasks.taskFields.statusUnavailable'), disabled: true }] : []),
        ...[...lookups.statuses].sort((a, b) => a.position - b.position).map(status => ({ value: status.id, label: status.name, color: statusColors[status.group] })),
      ];
      return <ChoicePicker compact className={cellPickerClassName} label={fieldLabels.statusId} value={draft.statusId} options={options} disabled={disabled} onValueChange={statusId => onChange({ statusId })} />;
    }
    case 'responsible': {
      const held = draft.responsibleMembershipId;
      const options: ChoiceOption[] = [
        { value: '', label: t('tasks.taskFields.unassigned') },
        ...(held && !members.some(member => member.id === held) ? [{ value: held, label: t('tasks.taskFields.memberUnavailable'), disabled: true }] : []),
        ...members.map(member => ({ value: member.id, label: member.displayName, avatarName: member.displayName })),
      ];
      return <ChoicePicker compact searchable className={cellPickerClassName} label={fieldLabels.responsibleMembershipId} value={held ?? ''} options={options} disabled={disabled} onValueChange={value => onChange({ responsibleMembershipId: value || null })} />;
    }
    case 'priority': {
      const options: ChoiceOption[] = taskPrioritySchema.options.map(priority => ({ value: priority, label: priorityLabels[priority], color: priorityColors[priority] }));
      return <ChoicePicker compact className={cellPickerClassName} label={fieldLabels.priority} value={draft.priority} options={options} disabled={disabled}
        onValueChange={value => { const priority = taskPrioritySchema.safeParse(value); if (priority.success) onChange({ priority: priority.data }); }} />;
    }
    case 'participants': {
      // A held ID outside the member list stays visible and may only be removed.
      const options: ChoiceOption[] = [
        ...members.map(member => ({ value: member.id, label: member.displayName })),
        ...draft.participantMembershipIds.filter(held => !members.some(member => member.id === held)).map(held => ({ value: held, label: t('tasks.taskFields.memberUnavailable'), disabled: true })),
      ];
      return <DraftMultiPicker label={fieldLabels.participantMembershipIds} summary={formatDraftValue('participantMembershipIds', draft, lookups)} empty={t('tasks.taskFields.noWorkspaceMembers')}
        options={options} values={draft.participantMembershipIds} disabled={disabled} rowKey={rowKey} onChange={participantMembershipIds => onChange({ participantMembershipIds })} />;
    }
    case 'tags':
      // The shared picker keeps archived and missing held tags removable and never offers them anew.
      return <DraftTagPicker summary={formatDraftValue('tagIds', draft, lookups)} tags={[...lookups.tags.values()]} values={draft.tagIds} disabled={disabled} rowKey={rowKey}
        onChange={tagIds => onChange({ tagIds })} creation={context.tagCreate}
        manageAction={context.onMoreDetails ? <button type="button" className="rounded px-1 py-1 text-xs font-medium text-accent-ink hover:bg-canvas" onClick={context.onMoreDetails}>{t('tasks.tags.createInDetails')}</button> : undefined} />;
    case 'startDate':
      // Canonical YYYY-MM-DD text, like TaskDateInput: a partly typed date stays as typed for validation to reject.
      return <input type="text" aria-label={fieldLabels.startDate} min="0001-01-01" max="9999-12-31" placeholder={t('tasks.dates.format')} autoComplete="off" spellCheck={false} readOnly={disabled} aria-disabled={disabled || undefined} {...invalid('startDate')}
        className={cn(cellInputClassName, 'px-1')} value={draft.startDate ?? ''} onChange={event => onChange({ startDate: event.target.value })} />;
    case 'dueDate':
      return <DraftDatePicker context={context} />;
    case 'estimate':
      return <input type="text" aria-label={t('tasks.inlineEstimate.label')} autoComplete="off" readOnly={disabled} aria-disabled={disabled || undefined} {...invalid('estimate')}
        className={cellInputClassName} value={draft.estimate} onChange={event => onChange({ estimate: event.target.value })} />;
  }
}

interface DraftMultiPickerProps {
  label: string;
  summary: string;
  empty: string;
  options: readonly ChoiceOption[];
  values: readonly string[];
  disabled: boolean;
  rowKey: string;
  onChange: (values: string[]) => void;
  emptyAction?: ReactNode | undefined;
}

/** A bounded checkbox list in a cell popover; toggling changes only the local draft. */
function DraftMultiPicker({ label, summary, empty, options, values, disabled, rowKey, onChange, emptyAction }: DraftMultiPickerProps) {
  const [open, setOpen] = useState(false);
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLFieldSetElement>(null);
  const id = useId();
  const held = new Set(values.map(value => value.toLowerCase()));
  const inside = (node: unknown) => node instanceof Node && (anchor?.contains(node) === true || panelRef.current?.contains(node) === true);
  const close = (restoreFocus: boolean) => { setOpen(false); if (restoreFocus) triggerRef.current?.focus({ preventScroll: true }); };
  const toggle = (value: string, checked: boolean) => onChange(checked ? [...values, value] : values.filter(kept => kept.toLowerCase() !== value.toLowerCase()));
  // Portalled panel events reach this wrapper through React; a real move elsewhere closes the list.
  const blur = (event: FocusEvent) => {
    if (inside(event.relatedTarget)) return;
    window.setTimeout(() => { if (!inside(document.activeElement)) setOpen(false); }, 0);
  };
  const escape = (event: KeyboardEvent) => {
    if (event.key !== 'Escape') return;
    event.preventDefault(); event.stopPropagation();
    close(true);
  };
  return <div ref={setAnchor} className="flex h-8 min-w-0 items-center" onMouseDown={keepFocusOnPopoverPress} onBlur={blur}>
    <button ref={triggerRef} type="button" aria-label={label} aria-describedby={`${id}-value`} aria-expanded={open} aria-controls={open ? `${id}-list` : undefined} disabled={disabled}
      onClick={() => setOpen(value => !value)} onKeyDown={open ? escape : undefined}
      className={cn('flex h-8 w-full min-w-0 items-center gap-1 rounded px-2 text-left text-sm text-ink hover:bg-canvas disabled:text-muted', values.length === 0 && 'text-subtle')}>
      <span id={`${id}-value`} className="min-w-0 flex-1 truncate">{summary}</span>
      <ChevronDown size={14} aria-hidden="true" className="shrink-0 text-muted" />
    </button>
    {open ? <CellPopover anchor={anchor}>
      <fieldset ref={panelRef} id={`${id}-list`} data-quick-draft={rowKey} data-task-draft-popup="" onKeyDown={escape} className="flex max-h-64 min-w-48 flex-col gap-1 overflow-y-auto">
        <legend className="sr-only">{label}</legend>
        {options.length === 0 ? <><p className="text-muted">{empty}</p>{emptyAction}</> : options.map(option => {
          const checked = held.has(option.value.toLowerCase());
          return <label key={option.value} className="flex min-h-8 items-center gap-2 text-sm">
            <input type="checkbox" checked={checked} disabled={disabled || (option.disabled === true && !checked)} onChange={event => toggle(option.value, event.target.checked)} />
            <span className="min-w-0 truncate">{option.label}</span>
          </label>;
        })}
      </fieldset>
    </CellPopover> : null}
  </div>;
}

interface DraftTagPickerProps {
  summary: string;
  tags: readonly TagDto[];
  values: readonly string[];
  disabled: boolean;
  rowKey: string;
  onChange: (values: string[]) => void;
  creation?: InlineTagCreateBinding | undefined;
  manageAction?: ReactNode | undefined;
}

/**
 * The tag cell's popover around the shared picker. Toggling and a confirmed inline tag change only
 * the local draft; the first Escape closes this list and leaves the row's draft alone.
 */
function DraftTagPicker({ summary, tags, values, disabled, rowKey, onChange, creation, manageAction }: DraftTagPickerProps) {
  const [open, setOpen] = useState(false);
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const id = useId();
  const inside = (node: unknown) => node instanceof Node && (anchor?.contains(node) === true || panelRef.current?.contains(node) === true);
  const close = (restoreFocus: boolean) => { setOpen(false); if (restoreFocus) triggerRef.current?.focus({ preventScroll: true }); };
  const blur = (event: FocusEvent) => {
    if (inside(event.relatedTarget)) return;
    window.setTimeout(() => { if (!inside(document.activeElement)) setOpen(false); }, 0);
  };
  const escape = (event: KeyboardEvent) => {
    if (event.key !== 'Escape') return;
    event.preventDefault(); event.stopPropagation();
    close(true);
  };
  return <div ref={setAnchor} className="flex h-8 min-w-0 items-center" onMouseDown={keepFocusOnPopoverPress} onBlur={blur}>
    <button ref={triggerRef} type="button" aria-label={fieldLabels.tagIds} aria-describedby={`${id}-value`} aria-expanded={open} aria-controls={open ? `${id}-list` : undefined} disabled={disabled}
      onClick={() => setOpen(value => !value)} onKeyDown={open ? escape : undefined}
      className={cn('flex h-8 w-full min-w-0 items-center gap-1 rounded px-2 text-left text-sm text-ink hover:bg-canvas disabled:text-muted', values.length === 0 && 'text-subtle')}>
      <span id={`${id}-value`} className="min-w-0 flex-1 truncate">{summary}</span>
      <ChevronDown size={14} aria-hidden="true" className="shrink-0 text-muted" />
    </button>
    {open ? <CellPopover anchor={anchor}>
      <div ref={panelRef} id={`${id}-list`} data-quick-draft={rowKey} data-task-draft-popup="" onKeyDown={escape} className="flex max-h-80 min-w-56 max-w-72 flex-col gap-1 overflow-y-auto">
        <TaskTagPicker tags={tags} values={values} onChange={onChange} disabled={disabled} autoFocus creation={creation}
          onRequestClose={() => close(true)} manageAction={manageAction} />
      </div>
    </CellPopover> : null}
  </div>;
}

/** A new row keeps both date endpoints in its own unsent draft, without growing the grid. */
function DraftDatePicker({ context }: { context: TaskDraftCellContext }) {
  const { t } = useTranslation();
  const { draft, onChange, disabled, errors, rowKey } = context;
  const [open, setOpen] = useState(false);
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const id = useId();
  const close = () => { setOpen(false); trigger.current?.focus({ preventScroll: true }); };
  const inside = (node: unknown) => node instanceof Node && (anchor?.contains(node) === true || panel.current?.contains(node) === true);
  return <div ref={setAnchor} className="flex h-8 min-w-0 flex-1 items-center" onMouseDown={keepFocusOnPopoverPress} onBlur={event => {
    if (inside(event.relatedTarget)) return;
    window.setTimeout(() => { if (!inside(document.activeElement)) setOpen(false); }, 0);
  }}>
    <button ref={trigger} type="button" disabled={disabled} aria-label={t('tasks.dates.editNew')} aria-haspopup="dialog" aria-expanded={open}
      aria-controls={open ? `${id}-panel` : undefined} className="h-8 min-w-0 flex-1 truncate rounded px-2 text-left text-sm text-ink hover:bg-canvas disabled:text-muted"
      onClick={() => setOpen(value => !value)}>{draft.dueDate || t('tasks.taskFields.noDueDate')}</button>
    {open ? <CellPopover anchor={anchor} className="max-h-[calc(100dvh-16px)] overflow-y-auto" role="dialog" ariaLabel={t('tasks.dates.edit')} id={`${id}-panel`}>
      <div ref={panel} data-quick-draft={rowKey} data-task-draft-popup="" onKeyDown={event => {
        if (event.key === 'Enter' && event.target instanceof HTMLInputElement) {
          event.preventDefault(); event.stopPropagation(); return;
        }
        if (event.key !== 'Escape') return;
        event.preventDefault(); event.stopPropagation(); close();
      }}>
        <TaskDateInput startDate={draft.startDate ?? ''} dueDate={draft.dueDate} onChange={onChange} disabled={disabled} autoFocus
          errors={{ startDate: errors.startDate ? t(errors.startDate.key, errors.startDate.params) : undefined, dueDate: errors.dueDate ? t(errors.dueDate.key, errors.dueDate.params) : undefined }} />
        <button type="button" className="mt-3 rounded px-2 py-1 text-xs font-medium text-accent-ink hover:bg-canvas" onClick={close}>{t('tasks.dates.done')}</button>
      </div>
    </CellPopover> : null}
  </div>;
}
