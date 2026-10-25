import type { FocusEvent } from 'react';

/**
 * Tab inside a row walks its cells and opens each one for typing, as in a spreadsheet. Only a focus move
 * made by the Tab key itself from another cell of the same row counts; arriving from elsewhere never
 * opens an editor, so keyboard users can still pass through the table.
 */
let tabKeyDown = false;
let tabBackward = false;
let tabFromRow: Element | null = null;
let walking = false;
if (typeof window !== 'undefined') {
  window.addEventListener('keydown', event => {
    tabKeyDown = event.key === 'Tab' && !event.ctrlKey && !event.altKey && !event.metaKey;
    tabBackward = event.shiftKey;
    tabFromRow = tabKeyDown && event.target instanceof Element ? event.target.closest('tr') : null;
  }, true);
  window.addEventListener('keyup', () => { tabKeyDown = false; }, true);
  window.addEventListener('pointerdown', () => { tabKeyDown = false; }, true);
}

export function isTabWalkBackward(): boolean { return tabBackward; }
export function isTabKeyDown(): boolean { return tabKeyDown; }

/** Opens the cell the person just reached with Tab (or that `walkToNeighbourCell` focused) in the same row. */
export function openOnTabFromSameRow(event: FocusEvent<HTMLElement>, open: () => void): void {
  const row = event.currentTarget.closest('tr');
  if (walking || (tabKeyDown && row !== null && row === tabFromRow)) open();
}

const fieldCell = '[data-inline-field-cell]';
const cellTarget = ['button[data-task-cell]', `${fieldCell} button`, `${fieldCell} input`].join(',');

/**
 * Moves focus to the next (or previous) cell of the row and opens it. A cell that is still disabled by a
 * save in flight is waited for, so a quick Tab never skips it or drops focus.
 */
export function walkToNeighbourCell(from: Element, backward: boolean): void {
  const row = from.closest('tr');
  if (row === null) return;
  const cells = [...row.children];
  const here = cells.findIndex(cell => cell.contains(from));
  if (here < 0) return;
  const candidates = backward ? cells.slice(0, here).reverse() : cells.slice(here + 1);
  for (const cell of candidates) {
    const target = cell.querySelector<HTMLElement>(cellTarget);
    if (target === null) continue;
    let attempts = 0;
    const attempt = () => {
      if (!target.isConnected) return;
      if (target instanceof HTMLButtonElement && target.disabled && attempts++ < 60) { setTimeout(attempt, 30); return; }
      walking = true;
      try { target.focus(); } finally { walking = false; }
    };
    setTimeout(attempt, 0);
    return;
  }
}
