export type SelectionKeyIntent = { kind: 'open' } | { kind: 'move'; direction: -1 | 1; extend: boolean };

/**
 * Asana-style keys of a focused selection gutter: ArrowUp/Down move the selection, Shift+Arrow
 * extends or contracts it, Enter opens details. Ctrl/Meta/Alt chords, IME composition and keys
 * someone already handled are never ours.
 */
export function selectionKeyIntent(event: KeyboardEvent): SelectionKeyIntent | null {
  if (event.defaultPrevented || event.isComposing || event.keyCode === 229 || event.ctrlKey || event.metaKey || event.altKey) return null;
  if (event.key === 'ArrowUp' || event.key === 'ArrowDown') return { kind: 'move', direction: event.key === 'ArrowUp' ? -1 : 1, extend: event.shiftKey };
  return event.key === 'Enter' && !event.shiftKey ? { kind: 'open' } : null;
}

interface Band { top: number; bottom: number }
/** Something pinned over scrolled content: the app top bar, a stuck table header/footer or a fixed bottom bar. */
interface Bar { element: Element; edge: 'top' | 'bottom' }

/**
 * Vertical nearest-edge reveal of a keyboard-selected row. Real vertical scrollports are tried from
 * the table scroller outward and the document last; each step stops once the row is clear of every
 * measured bar over its visible cells. It never pans sideways and never uses `scrollIntoView`,
 * which would move every scrolling ancestor.
 */
export function revealTaskRow(row: HTMLElement, scroller: HTMLElement): void {
  const owners = scrollOwners(scroller);
  const shell = scroller.closest('[data-app-shell-main]');
  const bars = shell ? shellBars(shell) : [];
  const table = row.closest('table');
  // A sticky thead/tfoot sticks to the table scroller, so it only covers rows that scroller scrolls.
  const tableBars = table ? pinnedTableEdges(table) : [];
  for (const [index, owner] of owners.entries()) {
    // Inner scrollports move with the row when an outer one scrolls, so they no longer bound it.
    const band = usableBand(row, scroller, owners.slice(index), owner === scroller ? [...tableBars, ...bars] : bars);
    if (band === null) continue;
    const delta = nearestDelta(row.getBoundingClientRect(), band);
    if (delta === 0) return;
    owner.scrollTop += delta;
    // A clamped scrollport leaves the rest to the next owner or the document.
    if (nearestDelta(row.getBoundingClientRect(), band) === 0) return;
  }
  const band = usableBand(row, scroller, [], bars);
  const delta = band === null ? 0 : nearestDelta(row.getBoundingClientRect(), band);
  if (delta !== 0) window.scrollBy(0, delta);
}

const viewportHeight = () => document.documentElement.clientHeight || window.innerHeight;
const viewportWidth = () => document.documentElement.clientWidth || window.innerWidth;

/** Vertical scrollports from the table scroller outward; the document is handled separately. */
function scrollOwners(scroller: HTMLElement): HTMLElement[] {
  const owners: HTMLElement[] = [];
  for (let node: HTMLElement | null = scroller; node && node !== document.body && node !== document.documentElement; node = node.parentElement) {
    if (node.scrollHeight <= node.clientHeight) continue;
    // The table scroller is overflow-auto by construction; an ancestor must say so in computed style.
    if (node === scroller || /^(auto|scroll|overlay)$/.test(getComputedStyle(node).overflowY)) owners.push(node);
  }
  return owners;
}

function pinned(element: Element, fixedOnly = false): boolean {
  const style = getComputedStyle(element);
  return (style.position === 'fixed' || (!fixedOnly && style.position === 'sticky')) && style.visibility !== 'hidden';
}

/** The app top bar beside main and fixed bars inside main that sit in the lower half (bulk toolbar). */
function shellBars(shell: Element): Bar[] {
  const bars: Bar[] = Array.from(shell.parentElement?.children ?? [])
    .filter(element => element.tagName === 'HEADER' && pinned(element))
    .map(element => ({ element, edge: 'top' as const }));
  const middle = viewportHeight() / 2;
  for (const section of shell.querySelectorAll('section')) {
    if (!pinned(section, true)) continue;
    const rect = section.getBoundingClientRect();
    if (rect.top + rect.height / 2 > middle) bars.push({ element: section, edge: 'bottom' });
  }
  return bars;
}

function pinnedTableEdges(table: HTMLTableElement): Bar[] {
  const bars: Bar[] = [];
  if (table.tHead && pinned(table.tHead)) bars.push({ element: table.tHead, edge: 'top' });
  if (table.tFoot && pinned(table.tFoot)) bars.push({ element: table.tFoot, edge: 'bottom' });
  return bars;
}

/** The viewport inside the given scrollports, clear of bars that overlap the row's visible cells. */
function usableBand(row: HTMLElement, scroller: HTMLElement, owners: readonly HTMLElement[], bars: readonly Bar[]): Band | null {
  let top = 0;
  let bottom = viewportHeight();
  for (const owner of owners) {
    const start = owner.getBoundingClientRect().top + owner.clientTop;
    top = Math.max(top, start);
    bottom = Math.min(bottom, start + owner.clientHeight);
  }
  const cells = row.getBoundingClientRect();
  const frame = scroller.getBoundingClientRect();
  const left = Math.max(cells.left, frame.left, 0);
  const right = Math.min(cells.right, frame.right, viewportWidth());
  for (const { element, edge } of bars) {
    const rect = element.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0 || rect.right <= left || rect.left >= right || rect.bottom <= top || rect.top >= bottom) continue;
    if (edge === 'top') top = Math.max(top, rect.bottom);
    else bottom = Math.min(bottom, rect.top);
  }
  return bottom > top ? { top, bottom } : null;
}

/** Nearest-edge distance; a row taller than the band aligns its top, so a repeat call settles at 0. */
function nearestDelta(rect: DOMRect, band: Band): number {
  const delta = rect.top < band.top || rect.height > band.bottom - band.top ? rect.top - band.top
    : rect.bottom > band.bottom ? rect.bottom - band.bottom : 0;
  // Sub-pixel layout never causes a further nudge.
  return Math.abs(delta) < 0.5 ? 0 : delta;
}
