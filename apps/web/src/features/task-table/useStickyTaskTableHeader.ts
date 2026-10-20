import { useLayoutEffect, useRef } from 'react';

/**
 * Keep the genuine table heading visible during page scrolling. The local horizontal scrollport
 * establishes CSS sticky's containing block, even though its unconstrained height never scrolls
 * vertically. Translate only the existing thead within that block, retaining its columns, menus,
 * focus and left-pinned title; no duplicate table or nested vertical scroll is needed.
 */
export function useStickyTaskTableHeader() {
  const scrollRef = useRef<HTMLDivElement>(null);
  const headerRef = useRef<HTMLTableSectionElement>(null);
  const refresh = useRef<(() => void) | null>(null);

  useLayoutEffect(() => {
    const port = scrollRef.current, head = headerRef.current;
    const table = head?.closest('table');
    if (!port || !head || !table) return;
    const shellHeader = document.querySelector<HTMLElement>('.app-shell-workspace > header');
    let frame: number | null = null, appliedOffset = 0;
    const update = () => {
      frame = null;
      const headRect = head.getBoundingClientRect(), portRect = port.getBoundingClientRect();
      const tableRect = table.getBoundingClientRect();
      // Remove our previous translation from the measured rectangle. Native sticky positioning
      // still handles an explicitly height-constrained scrollport without a second offset.
      const naturalTop = headRect.top - appliedOffset;
      const shellRect = shellHeader?.getBoundingClientRect();
      const clearance = shellRect && shellRect.height > 0 && shellRect.top < window.innerHeight
        ? Math.max(0, shellRect.bottom) : 0;
      const visibleBottom = Math.min(tableRect.bottom, portRect.top + port.clientTop + port.clientHeight);
      const desiredTop = Math.min(Math.max(naturalTop, clearance), Math.max(naturalTop, visibleBottom - headRect.height));
      const offset = Math.max(0, desiredTop - naturalTop);
      if (offset !== appliedOffset) {
        appliedOffset = offset;
        head.style.translate = offset > 0 ? `0 ${offset}px` : '';
      }
      head.toggleAttribute('data-task-table-header-stuck', offset > 0);
    };
    const schedule = () => { frame ??= window.requestAnimationFrame(update); };
    refresh.current = schedule;
    // Capture also sees scrolling on ancestors and on the table's own horizontal scrollport.
    window.addEventListener('scroll', schedule, { capture: true, passive: true });
    window.addEventListener('resize', schedule, { passive: true });
    const observer = new ResizeObserver(schedule);
    for (const node of [port, table, head, shellHeader, port.closest('main')]) if (node) observer.observe(node);
    update();
    return () => {
      refresh.current = null;
      window.removeEventListener('scroll', schedule, true);
      window.removeEventListener('resize', schedule);
      observer.disconnect();
      if (frame !== null) window.cancelAnimationFrame(frame);
      head.style.translate = '';
      head.removeAttribute('data-task-table-header-stuck');
    };
  }, []);

  // Parent content/columns/disclosure can move the table without a viewport scroll.
  useLayoutEffect(() => { refresh.current?.(); });
  return { scrollRef, headerRef };
}
