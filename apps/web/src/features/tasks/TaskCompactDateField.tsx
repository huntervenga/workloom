import { sqlCalendarDateSchema } from '@workloom/contracts';
import { CalendarDays } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { formatDate, useTranslation } from '../../i18n';
import { useUnsavedChangesWarning } from '../../lib/useUnsavedChangesWarning';
import { CellPopover } from './CellPopover';
import { TaskDateInput, keepFocusOnPopoverPress } from './TaskDateInput';

interface Dates { startDate: string; dueDate: string }
/** A later modal temporarily owns focus; its navigation decision must not commit the editor. */
function inCoveringDialog(target: EventTarget | null, owner: HTMLElement | null) {
  if (!(target instanceof Element) || owner === null) return false;
  const dialog = target.closest('[role="dialog"],[role="alertdialog"]');
  return dialog !== null && !dialog.contains(owner);
}
function carrier(value: string) {
  const [year = 0, month = 1, day = 1] = value.split('-').map(Number);
  const date = new Date(0);
  date.setUTCHours(0, 0, 0, 0);
  date.setUTCFullYear(year, month - 1, day);
  return date;
}

/** The table calendar, anchored to a compact value. Leaving saves; Escape cancels typing. */
export function TaskCompactDateField({ startDate, dueDate, disabled = false, errors, onCommit, onDraftChange }: Dates & {
  disabled?: boolean;
  errors?: { startDate?: string | undefined; dueDate?: string | undefined };
  onCommit: (dates: Dates) => void;
  /** Stage only: the parent owns the opening base, retained drafts and navigation protection. */
  onDraftChange?: ((dates: Dates) => void) | undefined;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<Dates>({ startDate, dueDate });
  const opening = useRef<{ dates: Dates; commit: (dates: Dates) => void; stage: ((dates: Dates) => void) | undefined } | null>(null);
  useUnsavedChangesWarning(open && opening.current !== null && (draft.startDate !== opening.current.dates.startDate || draft.dueDate !== opening.current.dates.dueDate));
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const openRef = useRef(false);
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const close = useCallback((save: boolean) => {
    if (!openRef.current) return;
    openRef.current = false;
    const session = opening.current;
    if (session && (draftRef.current.startDate !== session.dates.startDate || draftRef.current.dueDate !== session.dates.dueDate)) {
      if (save) session.commit(draftRef.current);
      else session.stage?.(session.dates);
    }
    setOpen(false);
  }, []);
  useEffect(() => {
    if (!open) return undefined;
    const outside = (event: PointerEvent) => {
      if (event.target instanceof Node && !root.current?.contains(event.target) && !inCoveringDialog(event.target, root.current)) close(true);
    };
    const claimEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !event.isComposing && event.target instanceof Node && root.current?.contains(event.target)) event.preventDefault();
    };
    document.addEventListener('pointerdown', outside);
    window.addEventListener('keydown', claimEscape, true);
    return () => { document.removeEventListener('pointerdown', outside); window.removeEventListener('keydown', claimEscape, true); };
  }, [open, close]);
  const short = (value: string) => {
    if (!sqlCalendarDateSchema.safeParse(value).success) return value;
    const date = carrier(value);
    return formatDate(date, date.getUTCFullYear() === new Date().getFullYear()
      ? { day: 'numeric', month: 'short', timeZone: 'UTC' }
      : { day: '2-digit', month: '2-digit', year: 'numeric', timeZone: 'UTC' });
  };
  const text = startDate && dueDate ? t('taskTable.dates.range', { start: short(startDate), due: short(dueDate) })
    : dueDate ? short(dueDate) : startDate ? t('taskTable.dates.startOnly', { start: short(startDate) }) : t('tasks.taskFields.noDueDate');
  return <div ref={root} className="min-w-0" onMouseDown={keepFocusOnPopoverPress}
    onBlur={event => {
      // Chrome may run a microtask between focusout and focusin with body active.
      // A known internal destination already proves this is not leaving the editor.
      if (!open || event.relatedTarget instanceof Node && root.current?.contains(event.relatedTarget) || inCoveringDialog(event.relatedTarget, root.current)) return;
      queueMicrotask(() => { if (!root.current?.contains(document.activeElement) && !inCoveringDialog(document.activeElement, root.current)) close(true); });
    }}
    onKeyDown={event => {
      if (!open || event.nativeEvent.isComposing) return;
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(false); trigger.current?.focus(); }
      if (event.key === 'Enter' && event.target instanceof HTMLInputElement) { event.preventDefault(); event.stopPropagation(); close(true); trigger.current?.focus(); }
    }}>
    <button ref={trigger} type="button" disabled={disabled} aria-label={t('tasks.dates.edit')} aria-haspopup="dialog" aria-expanded={open}
      className="flex min-h-8 max-w-full items-center gap-2 rounded px-1.5 text-left text-sm text-ink-soft hover:bg-canvas focus-visible:outline-2 focus-visible:outline-accent disabled:opacity-60"
      onClick={() => { if (open) close(true); else { const dates = { startDate, dueDate }; opening.current = { dates, commit: onCommit, stage: onDraftChange }; draftRef.current = dates; setDraft(dates); openRef.current = true; setOpen(true); } }}>
      <CalendarDays size={16} className="shrink-0 text-muted" aria-hidden="true" /><span className="truncate">{text}</span>
    </button>
    {open ? <CellPopover anchor={trigger.current} role="dialog" ariaLabel={t('tasks.dates.edit')} className="max-h-[calc(100dvh-16px)] overflow-y-auto">
      <TaskDateInput startDate={draft.startDate} dueDate={draft.dueDate} autoFocus disabled={disabled} errors={errors}
        onChange={patch => { const next = { ...draftRef.current, ...patch }; draftRef.current = next; setDraft(next); opening.current?.stage?.(next); }} />
    </CellPopover> : null}
    {!open && (errors?.startDate || errors?.dueDate) ? <p role="alert" className="mt-1 text-xs text-red-700">{errors.startDate ?? errors.dueDate}</p> : null}
  </div>;
}
