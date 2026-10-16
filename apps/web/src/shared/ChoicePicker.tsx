import { useTranslation } from '../i18n';
import { Avatar, cn } from '@workloom/ui';
import { Check, ChevronDown, Search, UserRound } from 'lucide-react';
import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent, type SyntheticEvent } from 'react';
import { createPortal } from 'react-dom';

/** One choice. Clear states such as Unassigned or Not set are ordinary options with their own value. */
export interface ChoiceOption {
  value: string;
  label: string;
  /** A second line in the menu only; the trigger always stays one line. */
  description?: string | undefined;
  /** Initials for a person. When any option has one, options without it get an empty person slot. */
  avatarName?: string | undefined;
  /** A `#rgb`/`#rrggbb` dot for statuses and enum options; other values draw a neutral ring. */
  color?: string | undefined;
  /** Shown but never selectable, e.g. a retained archived option. */
  disabled?: boolean | undefined;
}

export type ChoicePickerOption = ChoiceOption;

export interface ChoicePickerProps {
  value: string;
  options: readonly ChoiceOption[];
  onValueChange: (value: string) => void;
  /** Accessible name of the trigger and list; a visible `<label htmlFor={id}>` may repeat it. */
  label: string;
  disabled?: boolean | undefined;
  autoFocus?: boolean | undefined;
  /** Defaults to searching when there are more than seven options. */
  searchable?: boolean | undefined;
  className?: string | undefined;
  /** A shorter trigger for table cells and toolbars. */
  compact?: boolean | undefined;
  /** Trigger text when `value` matches no option. */
  placeholder?: string | undefined;
  id?: string | undefined;
  'aria-describedby'?: string | undefined;
  'aria-invalid'?: boolean | undefined;
}

const SEARCH_THRESHOLD = 7;
const MENU_MAX_HEIGHT = 320;
const MENU_MIN_HEIGHT = 120;
const MENU_MIN_WIDTH = 224;
const EDGE = 8;
const GAP = 4;
const TYPEAHEAD_MS = 700;
const HEX_COLOR = /^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;
// Selectors are written without spaces: they are DOM queries, never displayed copy.
const TABBABLE = 'a[href],area[href],button,input:not([type="hidden"]),select,textarea,summary,iframe,[tabindex],[contenteditable=""],[contenteditable="true"]';
const MODAL = '[role="dialog"],[role="alertdialog"]';
const HIDDEN = '[hidden],[inert],[aria-hidden="true"]';

type Mark = 'avatar' | 'dot' | null;
type Start = 'selected' | 'first' | 'last' | { value: string };

/** Case- and accent-insensitive text for matching what people type. */
function fold(text: string, locale: string): string {
  return text.normalize('NFD').replace(/\p{M}/gu, '').toLocaleLowerCase(locale);
}

/**
 * A native `<fieldset disabled>` disables the trigger; the portalled menu is outside the
 * fieldset, so selection checks the same rule explicitly (the first legend stays enabled).
 */
function disabledByFieldset(element: HTMLElement): boolean {
  for (let fieldset = element.parentElement?.closest('fieldset'); fieldset; fieldset = fieldset.parentElement?.closest('fieldset')) {
    if (!fieldset.disabled) continue;
    const legend = fieldset.querySelector(':scope>legend');
    if (!legend?.contains(element)) return true;
  }
  return false;
}

function hiddenByClosedDetails(element: HTMLElement): boolean {
  for (let details = element.closest('details'); details; details = details.parentElement?.closest('details') ?? null) {
    if (!details.open && !details.querySelector(':scope>summary')?.contains(element)) return true;
  }
  return false;
}

function tabbables(scope: HTMLElement, exclude: HTMLElement | null): HTMLElement[] {
  return [...scope.querySelectorAll<HTMLElement>(TABBABLE)].filter(
    (element) =>
      element.tabIndex >= 0 &&
      !exclude?.contains(element) &&
      !element.hasAttribute('data-radix-focus-guard') &&
      !('disabled' in element && element.disabled === true) &&
      !disabledByFieldset(element) &&
      element.closest(HIDDEN) === null &&
      !hiddenByClosedDetails(element),
  );
}

function isPrintable(event: ReactKeyboardEvent): boolean {
  return event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey;
}

function ChoiceMark({ option, mark }: { option: ChoiceOption; mark: Mark }) {
  if (mark === 'avatar') {
    return option.avatarName ? (
      <Avatar name={option.avatarName} seed={option.value} size="sm" />
    ) : (
      <span aria-hidden="true" className="inline-flex size-6 shrink-0 items-center justify-center rounded-full border border-dashed border-line-strong text-subtle">
        <UserRound size={12} />
      </span>
    );
  }
  if (mark === 'dot') {
    const color = option.color !== undefined && HEX_COLOR.test(option.color) ? option.color : null;
    return (
      <span
        aria-hidden="true"
        className={cn('size-2.5 shrink-0 rounded-full', color === null && 'border border-line-strong')}
        style={color === null ? undefined : { backgroundColor: color }}
      />
    );
  }
  return null;
}

const triggerClassName = cn(
  'flex w-full min-w-0 items-center gap-2 rounded-lg border border-line bg-surface text-left text-sm text-ink shadow-xs outline-none transition-colors',
  'cursor-pointer hover:border-line-strong focus:border-accent-line focus:ring-4 focus:ring-accent-soft',
  'aria-expanded:border-accent-line aria-expanded:ring-4 aria-expanded:ring-accent-soft',
  'aria-[invalid=true]:border-red-300 aria-[invalid=true]:focus:ring-red-100',
  'disabled:cursor-not-allowed disabled:bg-canvas disabled:text-muted disabled:shadow-none disabled:hover:border-line',
);

/** Keeps menu interactions away from row/editor handlers rendered around the trigger. */
const stop = (event: SyntheticEvent) => event.stopPropagation();

/**
 * Searchable single-choice picker with select-only combobox semantics. The menu is portalled
 * into the enclosing modal dialog (to stay inside its focus trap) or the document body, and is
 * positioned against the viewport so table cells, sticky columns and scroll areas never clip or
 * reflow it. Focus returns to the trigger on selection or Escape; option changes never move focus.
 */
export function ChoicePicker({
  value,
  options,
  onValueChange,
  label,
  disabled = false,
  autoFocus = false,
  searchable,
  className,
  compact = false,
  placeholder,
  id,
  'aria-describedby': describedBy,
  'aria-invalid': invalid,
}: ChoicePickerProps) {
  const { t, locale } = useTranslation();
  const baseId = useId();
  const listId = `${baseId}-listbox`;
  const optionId = (index: number) => `${baseId}-option-${index}`;
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const keyboardClickRef = useRef(false);
  const typeaheadRef = useRef({ text: '', at: 0 });
  // Search mode and container are fixed when the menu opens, so later option loads never move focus.
  const [menu, setMenu] = useState<{ container: HTMLElement; search: boolean } | null>(null);
  const [query, setQuery] = useState('');
  const [activeValue, setActiveValue] = useState<string | null>(null);
  const open = menu !== null;

  const selected = options.find((option) => option.value === value);
  const mark: Mark = options.some((option) => option.avatarName !== undefined)
    ? 'avatar'
    : options.some((option) => option.color !== undefined)
      ? 'dot'
      : null;
  const needle = menu?.search ? fold(query.trim(), locale) : '';
  const visible = options
    .map((option, index) => ({ option, index }))
    .filter(({ option }) => needle === '' || fold(option.label, locale).includes(needle));
  const enabled = visible.filter(({ option }) => !option.disabled);
  const active = open ? (enabled.find(({ option }) => option.value === activeValue) ?? enabled[0] ?? null) : null;
  const activeId = active ? optionId(active.index) : undefined;

  const isBlocked = () => {
    const trigger = triggerRef.current;
    return disabled || trigger === null || trigger.disabled || disabledByFieldset(trigger);
  };

  const close = useCallback((restoreFocus: boolean) => {
    setMenu(null);
    setQuery('');
    if (restoreFocus) triggerRef.current?.focus({ preventScroll: true });
  }, []);

  const openMenu = (start: Start, seed = '') => {
    const trigger = triggerRef.current;
    if (trigger === null || isBlocked()) return;
    const search = searchable ?? options.length > SEARCH_THRESHOLD;
    const seedNeedle = search ? fold(seed.trim(), locale) : '';
    const pool = options.filter((option) => !option.disabled && (seedNeedle === '' || fold(option.label, locale).includes(seedNeedle)));
    const initial =
      typeof start === 'object'
        ? start.value
        : start === 'first'
          ? pool[0]?.value
          : start === 'last'
            ? pool.at(-1)?.value
            : (pool.find((option) => option.value === value) ?? pool[0])?.value;
    setMenu({ container: trigger.closest<HTMLElement>(MODAL) ?? trigger.ownerDocument.body, search });
    setQuery(search ? seed : '');
    setActiveValue(initial ?? null);
  };

  const commit = (choice: ChoiceOption | undefined) => {
    if (choice === undefined || choice.disabled) return;
    if (isBlocked()) {
      close(false);
      return;
    }
    close(true);
    if (choice.value !== value) onValueChange(choice.value);
  };

  const move = (to: 'next' | 'previous' | 'first' | 'last' | 'pageDown' | 'pageUp') => {
    if (enabled.length === 0) return;
    const current = active ? enabled.indexOf(active) : -1;
    const last = enabled.length - 1;
    const index = {
      first: 0,
      last,
      next: Math.min(current + 1, last),
      previous: Math.max(current - 1, 0),
      pageDown: Math.min(current + 10, last),
      pageUp: Math.max(current - 10, 0),
    }[to];
    setActiveValue(enabled[index]?.option.value ?? null);
  };

  /** Native-select typeahead: repeating one letter cycles; a longer prefix refines the match. */
  const typeahead = (key: string): string | null => {
    const now = Date.now();
    const previous = typeaheadRef.current;
    const text = now - previous.at < TYPEAHEAD_MS ? previous.text + key : key;
    typeaheadRef.current = { text, at: now };
    const repeated = [...text].every((character) => character === text[0]);
    const prefix = fold(repeated ? key : text, locale);
    const candidates = options.filter((option) => !option.disabled);
    const current = candidates.findIndex((option) => option.value === (active?.option.value ?? value));
    const from = repeated ? current + 1 : Math.max(current, 0);
    const ordered = [...candidates.slice(from), ...candidates.slice(0, from)];
    return ordered.find((option) => fold(option.label, locale).startsWith(prefix))?.value ?? null;
  };
  const typing = () => typeaheadRef.current.text !== '' && Date.now() - typeaheadRef.current.at < TYPEAHEAD_MS;

  const handleMenuKey = (event: ReactKeyboardEvent<HTMLElement>, fromSearch: boolean) => {
    if (event.nativeEvent.isComposing || event.key === 'Process') return;
    switch (event.key) {
      case 'ArrowDown':
        move('next');
        break;
      case 'ArrowUp':
        if (event.altKey) commit(active?.option);
        else move('previous');
        break;
      case 'Home':
        move('first');
        break;
      case 'End':
        move('last');
        break;
      case 'PageDown':
        move('pageDown');
        break;
      case 'PageUp':
        move('pageUp');
        break;
      case 'Escape':
        close(true);
        break;
      case 'Enter':
        // Modified Enter (such as Ctrl+Enter to save) stays with the surrounding form.
        if (event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return;
        commit(active?.option);
        break;
      case 'Tab': {
        if (!fromSearch) {
          // Focus is already on the trigger, so native Tab order continues from it.
          close(false);
          return;
        }
        // The search box lives in a portal; continue the tab order from the trigger instead.
        const trigger = triggerRef.current;
        const scope = menu?.container ?? null;
        const exclude = menuRef.current;
        close(true);
        if (trigger !== null && scope !== null && !event.shiftKey) {
          const order = tabbables(scope, exclude);
          const index = order.indexOf(trigger);
          // Modal dialogs keep focus inside, like their own focus trap.
          const next = index < 0 ? undefined : (order[index + 1] ?? (scope === trigger.ownerDocument.body ? undefined : order[0]));
          next?.focus();
        }
        break;
      }
      case ' ':
        if (fromSearch) return;
        if (typing()) {
          const match = typeahead(' ');
          if (match !== null) setActiveValue(match);
        } else commit(active?.option);
        break;
      default: {
        if (fromSearch || !isPrintable(event)) return;
        const match = typeahead(event.key);
        if (match !== null) setActiveValue(match);
      }
    }
    event.preventDefault();
    event.stopPropagation();
  };

  const onTriggerKeyDown = (event: ReactKeyboardEvent<HTMLButtonElement>) => {
    if (event.key === 'Enter' || event.key === ' ') keyboardClickRef.current = true;
    if (open) {
      handleMenuKey(event, false);
      return;
    }
    if (isBlocked() || event.nativeEvent.isComposing) return;
    switch (event.key) {
      case 'ArrowDown':
      case 'ArrowUp':
      case 'Enter':
      case ' ':
        openMenu('selected');
        break;
      case 'Home':
        openMenu('first');
        break;
      case 'End':
        openMenu('last');
        break;
      default: {
        if (!isPrintable(event)) return;
        if (searchable ?? options.length > SEARCH_THRESHOLD) openMenu('first', event.key);
        else {
          const match = typeahead(event.key);
          openMenu(match === null ? 'selected' : { value: match });
        }
      }
    }
    event.preventDefault();
    event.stopPropagation();
  };

  const onTriggerKeyUp = (event: ReactKeyboardEvent<HTMLButtonElement>) => {
    // Space activates a button on key up; the key down already opened or chose.
    if (event.key === ' ' || event.key === 'Enter') event.preventDefault();
  };

  const onTriggerClick = (event: ReactMouseEvent<HTMLButtonElement>) => {
    if (keyboardClickRef.current && event.detail === 0) {
      keyboardClickRef.current = false;
      return;
    }
    keyboardClickRef.current = false;
    if (open) close(true);
    else openMenu('selected');
  };

  const place = useCallback(() => {
    const trigger = triggerRef.current;
    const element = menuRef.current;
    const list = listRef.current;
    const container = menu?.container;
    if (!trigger || !element || !list || !container) return;
    const doc = trigger.ownerDocument;
    const view = doc.defaultView ?? window;
    const viewport = view.visualViewport;
    const anchor = trigger.getBoundingClientRect();
    let top = (viewport?.offsetTop ?? 0) + EDGE;
    let bottom = (viewport ? viewport.offsetTop + viewport.height : view.innerHeight) - EDGE;
    let left = (viewport?.offsetLeft ?? 0) + EDGE;
    let right = (viewport ? viewport.offsetLeft + viewport.width : doc.documentElement.clientWidth || view.innerWidth) - EDGE;
    if (container !== doc.body) {
      // A centered dialog may clip fixed descendants; stay within its box as well.
      const bounds = container.getBoundingClientRect();
      if (bounds.width > 0 && bounds.height > 0) {
        top = Math.max(top, bounds.top + EDGE);
        bottom = Math.min(bottom, bounds.bottom - EDGE);
        left = Math.max(left, bounds.left + EDGE);
        right = Math.min(right, bounds.right - EDGE);
      }
    }
    const width = Math.max(0, Math.min(Math.max(anchor.width, MENU_MIN_WIDTH), right - left));
    const x = Math.max(left, Math.min(anchor.left, right - width));
    element.style.width = `${width}px`;
    // Search, padding and notice height plus the whole option list.
    const natural = element.offsetHeight - list.clientHeight + list.scrollHeight;
    const wanted = Math.min(natural, MENU_MAX_HEIGHT);
    const below = bottom - anchor.bottom - GAP;
    const above = anchor.top - GAP - top;
    const placeBelow = below >= wanted || below >= above;
    const height = Math.max(Math.min(wanted, placeBelow ? below : above), Math.min(wanted, MENU_MIN_HEIGHT));
    const y = Math.max(top, Math.min(placeBelow ? anchor.bottom + GAP : anchor.top - GAP - height, bottom - height));
    element.style.maxHeight = `${height}px`;
    element.style.left = `${x}px`;
    element.style.top = `${y}px`;
    element.dataset.side = placeBelow ? 'bottom' : 'top';
    // A transformed ancestor becomes the containing block of fixed elements; cancel its offset.
    const actual = element.getBoundingClientRect();
    if (actual.width > 0) {
      const dx = actual.left - x;
      const dy = actual.top - y;
      if (Math.abs(dx) > 0.5 || Math.abs(dy) > 0.5) {
        element.style.left = `${x - dx}px`;
        element.style.top = `${y - dy}px`;
      }
    }
  }, [menu]);

  // Every render while open: the option list or trigger size may have changed.
  useLayoutEffect(() => {
    if (open) place();
  });

  // A user-opened searchable menu takes focus once; later renders never move it.
  useLayoutEffect(() => {
    if (menu?.search) searchRef.current?.focus({ preventScroll: true });
  }, [menu]);

  useLayoutEffect(() => {
    const list = listRef.current;
    if (!list || activeId === undefined) return;
    const element = list.ownerDocument.getElementById(activeId);
    if (!element) return;
    const top = element.offsetTop;
    const bottom = top + element.offsetHeight;
    if (top < list.scrollTop) list.scrollTop = top;
    else if (bottom > list.scrollTop + list.clientHeight) list.scrollTop = bottom - list.clientHeight;
  }, [activeId]);

  // The trigger may be disabled by a prop or fieldset while the menu is open.
  useEffect(() => {
    const trigger = triggerRef.current;
    if (open && (disabled || trigger === null || trigger.disabled || disabledByFieldset(trigger))) close(false);
  });

  useEffect(() => {
    if (!menu) return undefined;
    const trigger = triggerRef.current;
    const doc = menu.container.ownerDocument;
    const view = doc.defaultView ?? window;
    const inside = (target: EventTarget | null) =>
      target instanceof Node && (triggerRef.current?.contains(target) === true || menuRef.current?.contains(target) === true);
    let frame = 0;
    const schedule = (event?: Event) => {
      if (event && inside(event.target) && event.target !== triggerRef.current) return;
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(place);
    };
    const onPointerDown = (event: PointerEvent) => {
      if (!inside(event.target)) close(false);
    };
    const onFocusIn = (event: FocusEvent) => {
      if (!inside(event.target)) close(false);
    };
    // Radix dialogs close on a document-capture Escape unless it was already handled.
    const onEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !event.isComposing && inside(event.target)) event.preventDefault();
    };
    const observer = new MutationObserver(() => {
      if (trigger !== null && disabledByFieldset(trigger)) close(false);
    });
    for (let fieldset = trigger?.parentElement?.closest('fieldset'); fieldset; fieldset = fieldset.parentElement?.closest('fieldset')) {
      observer.observe(fieldset, { attributes: true, attributeFilter: ['disabled'] });
    }
    view.addEventListener('keydown', onEscape, true);
    doc.addEventListener('pointerdown', onPointerDown, true);
    doc.addEventListener('focusin', onFocusIn);
    view.addEventListener('resize', schedule);
    view.addEventListener('scroll', schedule, true);
    view.visualViewport?.addEventListener('resize', schedule);
    view.visualViewport?.addEventListener('scroll', schedule);
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      view.removeEventListener('keydown', onEscape, true);
      doc.removeEventListener('pointerdown', onPointerDown, true);
      doc.removeEventListener('focusin', onFocusIn);
      view.removeEventListener('resize', schedule);
      view.removeEventListener('scroll', schedule, true);
      view.visualViewport?.removeEventListener('resize', schedule);
      view.visualViewport?.removeEventListener('scroll', schedule);
    };
  }, [menu, place, close]);

  return (
    <>
      <button
        ref={triggerRef}
        id={id}
        type="button"
        role="combobox"
        aria-label={label}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-activedescendant={menu !== null && !menu.search ? activeId : undefined}
        aria-describedby={describedBy}
        aria-invalid={invalid ? true : undefined}
        disabled={disabled}
        autoFocus={autoFocus}
        className={cn(triggerClassName, compact ? 'h-8 px-2' : 'h-10 px-3', className)}
        onClick={onTriggerClick}
        onKeyDown={onTriggerKeyDown}
        onKeyUp={onTriggerKeyUp}
        onBlur={() => {
          keyboardClickRef.current = false;
        }}
      >
        {selected ? <ChoiceMark option={selected} mark={mark} /> : null}
        <span className={cn('min-w-0 flex-1 truncate', selected === undefined && 'text-subtle')}>
          {selected?.label ?? placeholder ?? t('picker.choose')}
        </span>
        <ChevronDown size={compact ? 14 : 16} aria-hidden="true" className={cn('shrink-0 text-muted transition-transform', open && 'rotate-180')} />
      </button>
      {menu
        ? createPortal(
            <div
              ref={menuRef}
              data-choice-picker-menu=""
              className="fixed top-0 left-0 z-[60] flex flex-col overflow-hidden rounded-xl border border-line bg-surface text-sm text-ink shadow-lg"
              onClick={stop}
              onPointerDown={stop}
              onMouseDown={stop}
              onKeyDown={stop}
              onKeyUp={stop}
            >
              {menu.search ? (
                <div className="shrink-0 border-b border-line p-1.5">
                  <div className="relative">
                    <Search size={14} aria-hidden="true" className="pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2 text-subtle" />
                    <input
                      ref={searchRef}
                      type="text"
                      role="combobox"
                      aria-label={t('picker.searchLabel', { label })}
                      aria-expanded="true"
                      aria-controls={listId}
                      aria-autocomplete="list"
                      aria-activedescendant={activeId}
                      placeholder={t('picker.searchPlaceholder')}
                      autoComplete="off"
                      autoCorrect="off"
                      spellCheck={false}
                      value={query}
                      className="h-8 w-full rounded-md bg-canvas pr-2 pl-8 text-base text-ink outline-none placeholder:text-subtle focus:ring-2 focus:ring-accent-soft sm:text-sm"
                      onChange={(event) => {
                        const next = event.target.value;
                        const nextNeedle = fold(next.trim(), locale);
                        const pool = options.filter((option) => !option.disabled && (nextNeedle === '' || fold(option.label, locale).includes(nextNeedle)));
                        setQuery(next);
                        setActiveValue((nextNeedle === '' ? pool.find((option) => option.value === value) : undefined)?.value ?? pool[0]?.value ?? null);
                      }}
                      onKeyDown={(event) => handleMenuKey(event, true)}
                    />
                  </div>
                </div>
              ) : null}
              <ul
                ref={listRef}
                id={listId}
                role="listbox"
                aria-label={label}
                tabIndex={-1}
                className="relative min-h-0 flex-1 overflow-y-auto overscroll-contain p-1 outline-none"
                // Keep focus on the trigger or search box while choosing with a pointer.
                onMouseDown={(event) => event.preventDefault()}
              >
                {visible.map(({ option, index }) => {
                  const isSelected = option.value === value;
                  const isActive = active?.index === index;
                  return (
                    <li
                      key={`${index}:${option.value}`}
                      id={optionId(index)}
                      role="option"
                      aria-selected={isSelected}
                      aria-disabled={option.disabled ? true : undefined}
                      data-active={isActive ? '' : undefined}
                      className={cn(
                        'flex min-h-9 items-center gap-2 rounded-lg px-2.5 py-1.5 select-none',
                        option.disabled ? 'cursor-not-allowed text-subtle' : 'cursor-pointer text-ink-soft',
                        isActive && 'bg-accent-soft text-ink',
                        isSelected && 'font-medium text-ink',
                      )}
                      onMouseMove={() => {
                        if (!option.disabled && activeValue !== option.value) setActiveValue(option.value);
                      }}
                      onClick={() => commit(option)}
                    >
                      <ChoiceMark option={option} mark={mark} />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate" title={option.label}>
                          {option.label}
                        </span>
                        {option.description ? <span className="block truncate text-xs font-normal text-muted">{option.description}</span> : null}
                      </span>
                      <Check size={16} aria-hidden="true" className={cn('shrink-0 text-accent-strong', !isSelected && 'invisible')} />
                    </li>
                  );
                })}
              </ul>
              <p aria-live="polite" className={visible.length === 0 ? 'shrink-0 px-3 py-3 text-center text-sm text-muted' : 'sr-only'}>
                {visible.length === 0 ? (needle === '' ? t('picker.noOptions') : t('picker.noResults')) : ''}
              </p>
            </div>,
            menu.container,
          )
        : null}
    </>
  );
}
