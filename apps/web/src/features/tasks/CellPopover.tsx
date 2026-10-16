import { cn } from '@workloom/ui';
import { useLayoutEffect, useRef, type ReactNode } from 'react';

const EDGE = 8;
const GAP = 4;

function supportsTopLayer(node: HTMLElement): boolean {
  return typeof node.showPopover === 'function' && typeof node.hidePopover === 'function';
}

/**
 * Detailed cell feedback (errors, retry, notices) anchored to a fixed-size table cell editor.
 * It stays a DOM child of the editor, so focus, Escape and form ownership keep working, but it is
 * shown in the browser top layer where available and positioned against the viewport. It never
 * takes layout space, so a cell, its row and the grid keep their size; it never takes focus itself.
 */
export function CellPopover({ anchor, side = 'bottom', className, children }: {
  anchor: HTMLElement | null;
  /** Choice pickers open their menu below, so their feedback prefers the space above. */
  side?: 'bottom' | 'top' | undefined;
  className?: string | undefined;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const node = ref.current;
    if (!node || !anchor) return undefined;
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
  }, [anchor, side]);
  return (
    <div
      ref={ref}
      data-cell-popover=""
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
