import { t } from '../i18n';
import { X } from 'lucide-react';
import {
  cloneElement,
  useCallback,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type FocusEvent,
  type KeyboardEvent,
  type MouseEvent,
  type ReactElement,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';

/** Widths where the task drawer sits beside the page instead of covering it; matches styles.css. */
export const TASK_PANE_DESKTOP_QUERY = '(min-width: 1280px)';

function desktopList(): MediaQueryList | null {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return null;
  return window.matchMedia(TASK_PANE_DESKTOP_QUERY);
}

/** Whether the task pane is shown beside the page; always `false` when not `enabled`. */
export function useDesktopTaskPane(enabled: boolean): boolean {
  const subscribe = useCallback(
    (onChange: () => void) => {
      const list = enabled ? desktopList() : null;
      if (!list) return () => {};
      if (typeof list.addEventListener === 'function') {
        list.addEventListener('change', onChange);
        return () => list.removeEventListener('change', onChange);
      }
      list.addListener(onChange);
      return () => list.removeListener(onChange);
    },
    [enabled],
  );
  const matches = () => enabled && (desktopList()?.matches ?? false);
  return useSyncExternalStore(subscribe, matches, () => false);
}

const animationName = (element: HTMLElement) => getComputedStyle(element).animationName || 'none';

export interface TaskPanelFrameProps {
  title: string;
  description: string;
  trigger?: ReactElement | undefined;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  zIndex: number;
  /** A visible control to return to before the opener, e.g. when an action menu hid its trigger. */
  returnTarget?: (() => HTMLElement | null | undefined) | undefined;
  children: ReactNode;
}

/**
 * A non-modal dialog beside the page: no overlay, focus trap, scroll lock or hidden page, and no
 * document listeners, so the page keeps its own clicks, focus and Escape. Escape inside the pane
 * closes it unless a nested picker or dialog handled it first.
 */
export function TaskPanelFrame({ title, description, trigger, open, onOpenChange, zIndex, returnTarget, children }: TaskPanelFrameProps) {
  const titleId = useId();
  const descriptionId = useId();
  const paneRef = useRef<HTMLDivElement>(null);
  // The parent may reset its selected task immediately on close. Keep its last open
  // presentation through exit without replacing the retained task's controllers.
  const presentation = useRef({ title, description, children });
  const openRef = useRef(open);
  openRef.current = open;
  if (open) presentation.current = { title, description, children };
  const openerRef = useRef<HTMLElement | null>(null);
  const clickedTriggerRef = useRef<HTMLElement | null>(null);
  const ownsFocusRef = useRef(false);
  const openAnimationRef = useRef('none');
  const returnTargetRef = useRef(returnTarget);
  returnTargetRef.current = returnTarget;
  // Kept mounted while the closing animation runs.
  const [present, setPresent] = useState(open);
  const [wasOpen, setWasOpen] = useState(false);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) {
      // Focus has not moved yet, so this is the control that opened the pane.
      openerRef.current = clickedTriggerRef.current ?? (document.activeElement instanceof HTMLElement ? document.activeElement : null);
      clickedTriggerRef.current = null;
      setPresent(true);
    }
  }

  // Only on opening: a refetch or new children never pull focus back into the pane.
  useLayoutEffect(() => {
    if (!open) return;
    const pane = paneRef.current;
    if (!pane) return;
    openAnimationRef.current = animationName(pane);
    if (!pane.contains(document.activeElement)) pane.focus({ preventScroll: true });
  }, [open]);

  // Focus returns only when the pane had it; work outside the pane keeps its focus.
  useLayoutEffect(() => {
    if (open) return;
    const pane = paneRef.current;
    const owned = ownsFocusRef.current;
    ownsFocusRef.current = false;
    if (!pane) return;
    const active = document.activeElement;
    if (!pane.contains(active) && !(owned && (active === null || active === document.body))) return;
    const target = [returnTargetRef.current?.(), openerRef.current].find((element) => element?.isConnected && element !== document.body);
    // Returning focus never scrolls the page the user is working in.
    target?.focus({ preventScroll: true });
  }, [open]);

  useLayoutEffect(() => {
    if (open || !present) return;
    const pane = paneRef.current;
    const closing = pane ? animationName(pane) : 'none';
    // Without a closing animation (reduced motion, no styles) the pane leaves at once.
    if (!pane || closing === 'none' || closing === openAnimationRef.current) {
      setPresent(false);
      return;
    }
    const finish = (event: AnimationEvent) => {
      if (event.target === pane && !openRef.current) setPresent(false);
    };
    pane.addEventListener('animationend', finish);
    pane.addEventListener('animationcancel', finish);
    return () => {
      pane.removeEventListener('animationend', finish);
      pane.removeEventListener('animationcancel', finish);
    };
  }, [open, present]);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'Escape' || event.defaultPrevented || event.nativeEvent.isComposing || !open) return;
    // Scoped to the pane's own DOM: Escape in a portalled picker or dialog belongs to that layer.
    if (!(event.target instanceof Node) || !event.currentTarget.contains(event.target)) return;
    event.preventDefault();
    event.stopPropagation();
    onOpenChange(false);
  };
  const onBlur = (event: FocusEvent<HTMLDivElement>) => {
    const next = event.relatedTarget;
    if (next instanceof Node && !event.currentTarget.contains(next)) ownsFocusRef.current = false;
  };

  const triggerElement = trigger as ReactElement<{ onClick?: (event: MouseEvent<HTMLElement>) => void }> | undefined;
  return (
    <>
      {triggerElement
        ? cloneElement(triggerElement, {
            onClick: (event: MouseEvent<HTMLElement>) => {
              triggerElement.props.onClick?.(event);
              if (event.defaultPrevented) return;
              clickedTriggerRef.current = event.currentTarget;
              onOpenChange(true);
            },
          })
        : null}
      {present
        ? createPortal(
            <div
              ref={paneRef}
              role="dialog"
              aria-labelledby={titleId}
              aria-describedby={descriptionId}
              tabIndex={-1}
              data-task-panel=""
              data-state={open ? 'open' : 'closed'}
              inert={!open || undefined}
              aria-hidden={!open || undefined}
              // Below the global header (styles.css sets its top and height).
              className="task-panel fixed right-0 flex flex-col overflow-hidden border-l border-line bg-surface p-5 outline-none sm:p-6"
              style={{ zIndex }}
              onKeyDown={onKeyDown}
              onFocus={() => {
                ownsFocusRef.current = true;
              }}
              onBlur={onBlur}
            >
              <div className="flex min-h-8 shrink-0 items-start justify-end">
                <div className="sr-only">
                  <h2 id={titleId} className="text-base font-semibold [overflow-wrap:anywhere] text-ink">{presentation.current.title}</h2>
                  <p id={descriptionId} className="mt-1 text-sm leading-relaxed text-muted">{presentation.current.description}</p>
                </div>
                <button
                  type="button"
                  aria-label={t('common.close')}
                  className="inline-flex size-8 shrink-0 items-center justify-center rounded-md text-muted transition-colors hover:bg-slate-100 hover:text-ink"
                  onClick={() => onOpenChange(false)}
                >
                  <X size={16} aria-hidden="true" />
                </button>
              </div>
              {presentation.current.children}
            </div>,
            document.body,
          )
        : null}
    </>
  );
}
