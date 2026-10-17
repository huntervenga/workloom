const EDGE = 48;
/** Bounded per-frame movement; the pointer itself never moves when the viewport scrolls. */
export function edgeScrollStep(position: number, start: number, end: number): number {
  if (position < start || position > end) return 0;
  if (position < start + EDGE) return -Math.ceil(18 * (1 - (position - start) / EDGE));
  if (position > end - EDGE) return Math.ceil(18 * (1 - (end - position) / EDGE));
  return 0;
}
/** Prefer the scrollport under the pointer (including a drawer), then the page. */
export function scrollDragEdge(point: { x: number; y: number }, over: Element | null): boolean {
  for (let element = over?.parentElement; element && element !== document.body; element = element.parentElement) {
    if (!/(auto|scroll)/.test(getComputedStyle(element).overflowY) || element.scrollHeight <= element.clientHeight) continue;
    const rect = element.getBoundingClientRect();
    if (point.x < rect.left || point.x > rect.right) continue;
    const step = edgeScrollStep(point.y, rect.top, rect.bottom);
    const next = Math.max(0, Math.min(element.scrollHeight - element.clientHeight, element.scrollTop + step));
    if (next === element.scrollTop) continue;
    element.scrollTop = next;
    return true;
  }
  const page = document.scrollingElement;
  if (!page) return false;
  const step = edgeScrollStep(point.y, 0, window.innerHeight);
  const next = Math.max(0, Math.min(page.scrollHeight - window.innerHeight, page.scrollTop + step));
  if (next === page.scrollTop) return false;
  window.scrollBy(0, next - page.scrollTop);
  return true;
}
