import { sqlCalendarDateSchema } from '@workloom/contracts';
import { cn } from '@workloom/ui';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent } from 'react';
import { Temporal } from 'temporal-polyfill';
import { useTranslation } from '../../i18n';
import { CellPopover } from './CellPopover';

export interface TaskDateInputProps {
  startDate: string;
  dueDate: string;
  onChange: (patch: { startDate?: string; dueDate?: string }) => void;
  /** A calendar/Today/Clear choice is explicit; raw typing remains a draft until blur/Enter. */
  onCommit?: ((patch: { startDate?: string; dueDate?: string }) => void) | undefined;
  disabled?: boolean | undefined;
  errors?: { startDate?: string | undefined; dueDate?: string | undefined } | undefined;
  initialShowStart?: boolean | undefined;
  autoFocus?: boolean | undefined;
  /** Full forms keep the calendar out of their layout until a date is focused. */
  calendarPopover?: boolean | undefined;
  /** A bulk editor may deliberately clear an initially mixed/empty endpoint. */
  allowEmptyClear?: boolean | undefined;
}

const FOCUSABLE = 'a[href],button:not(:disabled),input:not(:disabled),select:not(:disabled),textarea:not(:disabled),[tabindex],[contenteditable=""],[contenteditable="true"]';

/**
 * A press on nonfocusable content of an owned cell popover (month heading, weekdays, labels,
 * padding) would blur the editor to the body before mouseup, and a deferred blur check would
 * take it for leaving. Such a press keeps the focus already inside `currentTarget`; controls
 * still take focus, clicks (and label activation) still run, and nothing outside is affected.
 */
export function keepFocusOnPopoverPress(event: MouseEvent<HTMLElement>) {
  const target = event.target;
  if (!(target instanceof Element)) return;
  const popover = target.closest('[data-cell-popover]');
  const owner = event.currentTarget;
  if (popover === null || !owner.contains(popover) || !owner.contains(document.activeElement)) return;
  // A focusable shell (for example the skip-link main) is not a control in this popover.
  const control = target.closest(FOCUSABLE);
  if (control !== null && popover.contains(control)) return;
  event.preventDefault();
}

const valid = (value: string) => sqlCalendarDateSchema.safeParse(value).success;
const monthOf = (value: string) => `${value.slice(0, 7)}-01`;
/** Calendar labels use UTC only as an Intl formatting carrier, never to parse or shift a date. */
function carrier(value: string) {
  const date = Temporal.PlainDate.from(value);
  const result = new Date(0);
  result.setUTCFullYear(date.year, date.month - 1, date.day);
  result.setUTCHours(0, 0, 0, 0);
  return result;
}

/**
 * Date-only local draft controls. The owner validates and explicitly commits the final range.
 * Inputs are canonical YYYY-MM-DD text: a partly typed date stays in the draft as typed (and is
 * rejected by validation), unlike a native date input, which reports it as an empty clear.
 */
export function TaskDateInput({ startDate, dueDate, onChange, disabled = false, errors, initialShowStart = false, autoFocus = false, calendarPopover = false, allowEmptyClear = false, onCommit }: TaskDateInputProps) {
  const { t, locale } = useTranslation();
  const id = useId();
  const startRef = useRef<HTMLInputElement>(null);
  const dueRef = useRef<HTMLInputElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const [calendarOpen, setCalendarOpen] = useState(false);
  useEffect(() => {
    if (!calendarPopover || !calendarOpen) return undefined;
    const view = rootRef.current?.ownerDocument.defaultView ?? window;
    // Radix modal Escape runs at document capture, before the calendar's React
    // bubble handler. Claim only this open calendar's own key at window capture;
    // the existing bubble handler still closes it and restores endpoint focus.
    const claimCalendarEscape = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape' && !event.isComposing && event.target instanceof Node && rootRef.current?.contains(event.target)) event.preventDefault();
    };
    view.addEventListener('keydown', claimCalendarEscape, true);
    return () => view.removeEventListener('keydown', claimCalendarEscape, true);
  }, [calendarPopover, calendarOpen]);

  const buttons = useRef(new Map<string, HTMLButtonElement>());
  const [expanded, setExpanded] = useState(initialShowStart || startDate !== '');
  const [active, setActive] = useState<'startDate' | 'dueDate'>('dueDate');
  const today = Temporal.Now.plainDateISO().toString();
  const initial = valid(dueDate) ? dueDate : valid(startDate) ? startDate : today;
  const [viewMonth, setViewMonth] = useState(() => monthOf(initial));
  const [cursor, setCursor] = useState(initial);
  const showStart = expanded || startDate !== '' || Boolean(errors?.startDate);
  const month = Temporal.PlainDate.from(viewMonth);
  const selected = active === 'startDate' ? startDate : dueDate;
  const format = useMemo(() => ({
    month: new Intl.DateTimeFormat(locale, { month: 'long', year: 'numeric', timeZone: 'UTC' }),
    day: new Intl.DateTimeFormat(locale, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' }),
    weekday: new Intl.DateTimeFormat(locale, { weekday: 'short', timeZone: 'UTC' }),
    number: new Intl.NumberFormat(locale, { useGrouping: false }),
  }), [locale]);
  const inputClass = 'mt-1 block h-9 w-full min-w-0 rounded border border-line bg-surface px-2 text-sm text-ink outline-none focus:border-accent-line focus:ring-2 focus:ring-accent-soft disabled:bg-canvas disabled:text-muted aria-[invalid=true]:border-red-300';
  const navigateTo = (value: string) => { if (valid(value)) { setViewMonth(monthOf(value)); setCursor(value); } };
  const edit = (field: 'startDate' | 'dueDate', value: string) => { onChange({ [field]: value }); navigateTo(value); };
  const choose = (field: 'startDate' | 'dueDate', value: string) => {
    const patch = { [field]: value };
    onChange(patch);
    onCommit?.(patch);
    navigateTo(value);
  };
  /**
   * Clearing disables its own button, and a browser then blurs that focused button to the body,
   * which an owner reads as leaving the editor. Focus first moves to the active endpoint's input,
   * kept mounted by `expanded` for the start date, so the draft stays open until an explicit save.
   */
  const clear = () => {
    if (active === 'startDate') setExpanded(true);
    (active === 'startDate' ? startRef : dueRef).current?.focus({ preventScroll: true });
    choose(active, '');
  };
  const focusField = (field: 'startDate' | 'dueDate') => { if (calendarPopover) setCalendarOpen(true); setActive(field); navigateTo(field === 'startDate' ? startDate : dueDate); };
  const shiftMonth = (delta: -1 | 1) => {
    if (disabled || delta === -1 && month.year === 1 && month.month === 1 || delta === 1 && month.year === 9999 && month.month === 12) return;
    const next = month.add({ months: delta }).toString();
    setViewMonth(next); setCursor(next);
  };
  const moveDay = (event: KeyboardEvent<HTMLButtonElement>, value: string) => {
    const days = event.key === 'ArrowLeft' ? -1 : event.key === 'ArrowRight' ? 1 : event.key === 'ArrowUp' ? -7 : event.key === 'ArrowDown' ? 7 : null;
    if (days === null || disabled) return;
    event.preventDefault();
    const next = Temporal.PlainDate.from(value).add({ days }).toString();
    if (!valid(next)) return;
    navigateTo(next);
    requestAnimationFrame(() => buttons.current.get(next)?.focus({ preventScroll: true }));
  };
  const days = Array.from({ length: month.daysInMonth }, (_, index) => month.with({ day: index + 1 }).toString());
  const calendar = <>
    <section aria-label={t('tasks.dates.calendar')} className="w-64 max-w-full min-w-0 border-t border-line pt-2">
      <div className="mb-2 flex items-center justify-between gap-2">
        <button type="button" aria-label={t('tasks.dates.previousMonth')} disabled={disabled || month.year === 1 && month.month === 1} onClick={() => shiftMonth(-1)} className="inline-flex size-7 shrink-0 items-center justify-center rounded hover:bg-canvas disabled:text-subtle"><ChevronLeft size={16} aria-hidden="true" /></button>
        <span aria-live="polite" className="min-w-0 text-center text-sm font-medium">{format.month.format(carrier(viewMonth))}</span>
        <button type="button" aria-label={t('tasks.dates.nextMonth')} disabled={disabled || month.year === 9999 && month.month === 12} onClick={() => shiftMonth(1)} className="inline-flex size-7 shrink-0 items-center justify-center rounded hover:bg-canvas disabled:text-subtle"><ChevronRight size={16} aria-hidden="true" /></button>
      </div>
      <p className="sr-only">{t(active === 'startDate' ? 'tasks.dates.choosingStart' : 'tasks.dates.choosingDue')}</p>
      <div className="grid grid-cols-7 gap-0.5">
        {Array.from({ length: 7 }, (_, offset) => <span key={offset} className="py-1 text-center text-[11px] text-muted">{format.weekday.format(carrier(Temporal.PlainDate.from('2023-01-02').add({ days: offset }).toString()))}</span>)}
        {Array.from({ length: month.dayOfWeek - 1 }, (_, index) => <span key={`empty-${index}`} aria-hidden="true" />)}
        {days.map(value => <button key={value} ref={node => { if (node) buttons.current.set(value, node); else buttons.current.delete(value); }} type="button"
          disabled={disabled} aria-label={format.day.format(carrier(value))} aria-pressed={selected === value} tabIndex={value === cursor ? 0 : -1}
          onKeyDown={event => moveDay(event, value)} onClick={() => { setCursor(value); choose(active, value); }}
          className={cn('h-7 min-w-0 rounded text-center text-xs outline-none hover:bg-accent-soft focus-visible:ring-2 focus-visible:ring-accent disabled:text-subtle',
            startDate && dueDate && startDate <= value && value <= dueDate && 'bg-accent-soft', selected === value && 'bg-accent text-white hover:bg-accent', value === today && selected !== value && 'font-bold underline underline-offset-2')}>
          {format.number.format(Temporal.PlainDate.from(value).day)}
        </button>)}
      </div>
      <div className="mt-2 flex justify-between gap-2 border-t border-line pt-2 text-xs">
        <button type="button" disabled={disabled} className="rounded px-1 py-1 font-medium text-accent-ink hover:bg-canvas disabled:text-muted" onClick={() => choose(active, today)}>{t('tasks.dates.today')}</button>
        <button type="button" disabled={disabled || selected === '' && !allowEmptyClear} className="rounded px-1 py-1 text-muted hover:bg-canvas disabled:text-subtle" onClick={clear}>{t(active === 'startDate' ? 'tasks.dates.clearStart' : 'tasks.dates.clearDue')}</button>
      </div>
    </section>
  </>;
  // min/max stay only as inert hints for existing consumers; the bounds are enforced by validation.
  const dateProps = { type: 'text', min: '0001-01-01', max: '9999-12-31', placeholder: t('tasks.dates.format'), autoComplete: 'off', spellCheck: false, disabled, className: inputClass } as const;
  return <div ref={rootRef} className="w-full min-w-0 space-y-3" onMouseDown={calendarPopover ? keepFocusOnPopoverPress : undefined} onBlur={event => {
    if (!calendarPopover || event.relatedTarget instanceof Node && rootRef.current?.contains(event.relatedTarget)) return;
    window.setTimeout(() => { if (!rootRef.current?.contains(document.activeElement)) setCalendarOpen(false); }, 0);
  }} onKeyDown={event => {
    if (!calendarPopover || !calendarOpen || event.key !== 'Escape') return;
    event.preventDefault(); event.stopPropagation();
    (active === 'startDate' ? startRef : dueRef).current?.focus({ preventScroll: true });
    setCalendarOpen(false);
  }}>
    <div className={cn('grid min-w-0 gap-2', showStart && 'grid-cols-2')}>
      {showStart ? <div className="min-w-0">
        <label htmlFor={`${id}-start`} className="text-xs font-medium">{t('tasks.taskFields.startDate')}</label>
        <input {...dateProps} ref={startRef} id={`${id}-start`} value={startDate}
          aria-invalid={Boolean(errors?.startDate) || undefined} aria-describedby={errors?.startDate ? `${id}-start-error` : undefined}
          onFocus={() => focusField('startDate')} onChange={event => edit('startDate', event.target.value)} />
      </div> : null}
      <div className="min-w-0">
        <label htmlFor={`${id}-due`} className="text-xs font-medium">{t('tasks.taskFields.dueDate')}</label>
        <input {...dateProps} ref={dueRef} id={`${id}-due`} value={dueDate} autoFocus={autoFocus}
          aria-invalid={Boolean(errors?.dueDate) || undefined} aria-describedby={errors?.dueDate ? `${id}-due-error` : undefined}
          onFocus={() => focusField('dueDate')} onChange={event => edit('dueDate', event.target.value)} />
      </div>
    </div>
    {errors?.startDate ? <p id={`${id}-start-error`} role="alert" className="text-xs text-red-700">{errors.startDate}</p> : null}
    {errors?.dueDate ? <p id={`${id}-due-error`} role="alert" className="text-xs text-red-700">{errors.dueDate}</p> : null}
    {!showStart ? <button type="button" disabled={disabled} className="rounded px-1 py-1 text-xs font-medium text-accent-ink hover:bg-canvas disabled:text-muted"
      onClick={() => { setExpanded(true); setActive('startDate'); requestAnimationFrame(() => startRef.current?.focus({ preventScroll: true })); }}>{t('tasks.dates.addStart')}</button> : null}
    {calendarPopover ? calendarOpen ? <CellPopover anchor={rootRef.current}>{calendar}</CellPopover> : null : calendar}
  </div>;
}
