import { cn } from '@workloom/ui';
import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';

const EDGE = 8;
const GAP = 4;
// Selectors are written without spaces: they are DOM queries, never displayed copy.
const MODAL = '[role="dialog"],[role="alertdialog"]';
const HIDDEN = '[hidden],[inert]';

function supportsTopLayer(node: HTMLElement): boolean {
  return typeof node.showPopover === 'function' && typeof node.hidePopover === 'function';
}

/**
 * True while the newest open dialog is not the one holding `anchor`. Top-layer feedback would
 * otherwise paint above that dialog; feedback of a cell inside the topmost dialog stays shown.
 * A popover that is itself a dialog never counts against itself or dialogs inside it. An anchor
 * under a hidden or inert ancestor (such as a frame covered by sign-in) also hides it, since the
 * top layer would otherwise keep showing it.
 */
function coveredByDialog(anchor: HTMLElement, self: HTMLElement | null): boolean {
  if (anchor.closest(HIDDEN) !== null) return true;
  const open = [...anchor.ownerDocument.querySelectorAll<HTMLElement>(MODAL)].filter(
    dialog => !dialog.hidden && dialog.dataset.state !== 'closed'
      // The desktop task pane deliberately leaves the table interactive. Actual modal dialogs,
      // including a later dialog inside that pane, still cover outside editors.
      && !(dialog.hasAttribute('data-task-panel') && dialog.getAttribute('aria-modal') !== 'true')
      && !(self?.contains(dialog) ?? false),
  );
  const top = open.at(-1);
  return top !== undefined && !top.contains(anchor);
}

/**
 * Detailed cell feedback (errors, retry, notices) anchored to a fixed-size table cell editor.
 * It stays a DOM child of the editor, so focus, Escape and form ownership keep working, but it is
 * shown in the browser top layer where available and positioned against the viewport. It never
 * takes layout space, so a cell, its row and the grid keep their size; it never takes focus itself.
 * While a later dialog is open elsewhere it is only hidden: its content, the command it describes
 * and its actions stay mounted and reappear unchanged when that dialog closes.
 * With `role="dialog"` it is a non-modal editor panel; the owner moves focus into it on open.
 */
export function CellPopover({ anchor, side = 'bottom', className, id, role, ariaLabel, children }: {
  anchor: HTMLElement | null;
  /** Choice pickers open their menu below, so their feedback prefers the space above. */
  side?: 'bottom' | 'top' | undefined;
  className?: string | undefined;
  id?: string | undefined;
  role?: 'dialog' | undefined;
  ariaLabel?: string | undefined;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [covered, setCovered] = useState(false);
  useLayoutEffect(() => {
    if (!anchor) return undefined;
    const doc = anchor.ownerDocument;
    const check = () => setCovered(coveredByDialog(anchor, ref.current));
    check();
    // Dialogs are portalled to the body; their mount, unmount and state changes are all mutations.
    const observer = new MutationObserver(check);
    observer.observe(doc.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['role', 'data-state', 'hidden', 'inert'] });
    return () => observer.disconnect();
  }, [anchor]);
  useLayoutEffect(() => {
    const node = ref.current;
    if (!node || !anchor || covered) return undefined;
    const topLayer = supportsTopLayer(node);
    if (topLayer) {
      // Manual popovers have no light dismiss and never move focus.
      node.setAttribute('popover', 'manual');
      try { node.showPopover(); } catch { /* already shown */ }
    }
    let frame = 0;
    const place = () => {
      const rect = anchor.getBoundingClientRect();
      const width = node.offsetWidth;
      const height = node.offsetHeight;
      const viewWidth = document.documentElement.clientWidth || window.innerWidth;
      const viewHeight = window.innerHeight;
      const below = rect.bottom + GAP;
      const above = rect.top - GAP - height;
      const fitsBelow = below + height <= viewHeight - EDGE;
      const fitsAbove = above >= EDGE;
      const top = side === 'top' ? (fitsAbove || !fitsBelow ? above : below) : (fitsBelow || !fitsAbove ? below : above);
      node.style.top = `${Math.max(EDGE, Math.min(top, viewHeight - EDGE - height))}px`;
      node.style.left = `${Math.max(EDGE, Math.min(rect.left, viewWidth - EDGE - width))}px`;
    };
    const schedule = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(place);
    };
    place();
    window.addEventListener('scroll', schedule, true);
    window.addEventListener('resize', schedule);
    const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(schedule) : null;
    observer?.observe(node);
    observer?.observe(anchor);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener('scroll', schedule, true);
      window.removeEventListener('resize', schedule);
      observer?.disconnect();
      if (topLayer) {
        try { node.hidePopover(); } catch { /* already hidden */ }
        node.removeAttribute('popover');
      }
    };
  }, [anchor, side, covered]);
  return (
    <div
      ref={ref}
      id={id}
      role={role}
      aria-label={ariaLabel}
      data-cell-popover=""
      hidden={covered || undefined}
      style={{ position: 'fixed', inset: 'auto', margin: 0, top: 0, left: 0 }}
      className={cn(
        'z-40 w-max max-w-[min(22rem,calc(100vw-16px))] space-y-2 overflow-visible rounded-lg border border-line bg-surface p-2 text-left text-xs whitespace-normal text-ink shadow-lg [overflow-wrap:anywhere]',
        className,
      )}
    >
      {children}
    </div>
  );
}
