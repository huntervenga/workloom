import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TaskTable } from './TaskTable';
import { revealTaskRow } from './taskSelectionNavigation';
import { makeTask, statuses } from './taskTableFixtures';

// jsdom has no stylesheet or layout: inline styles stand in for computed styles, and every rect is a
// function of the current scroll state, so a reveal is checked against the geometry it produces.
const box = (top: number, height: number, left = 0, width = 900) =>
  ({ top, bottom: top + height, left, right: left + width, width, height, x: left, y: top, toJSON: () => ({}) }) as DOMRect;
const place = (element: Element, rect: () => DOMRect) => vi.spyOn(element, 'getBoundingClientRect').mockImplementation(rect);

let pageY = 0;
let scrollerWidth = 900;
const mounted: HTMLElement[] = [];
const scrollIntoView = vi.fn();
const originalScrollIntoView = Object.getOwnPropertyDescriptor(Element.prototype, 'scrollIntoView');

beforeEach(() => {
  pageY = 0;
  scrollerWidth = 900;
  Object.defineProperty(document.documentElement, 'clientHeight', { configurable: true, value: 600 });
  Object.defineProperty(document.documentElement, 'clientWidth', { configurable: true, value: 1000 });
  Object.defineProperty(Element.prototype, 'scrollIntoView', { configurable: true, writable: true, value: scrollIntoView });
  vi.spyOn(window, 'scrollBy').mockImplementation((_x, y) => { pageY += Number(y); });
});

afterEach(() => {
  expect(scrollIntoView).not.toHaveBeenCalled();
  scrollIntoView.mockClear();
  vi.restoreAllMocks();
  for (const root of mounted.splice(0)) root.remove();
  for (const key of ['clientHeight', 'clientWidth']) Reflect.deleteProperty(document.documentElement, key);
  if (originalScrollIntoView) Object.defineProperty(Element.prototype, 'scrollIntoView', originalScrollIntoView);
  else Reflect.deleteProperty(Element.prototype, 'scrollIntoView');
});

/** A clamping scrollport; horizontal offsets start non-zero so any sideways pan would show. */
function scrollport(element: HTMLElement, clientHeight: number, scrollHeight: number) {
  let top = 0;
  Object.defineProperties(element, {
    clientHeight: { configurable: true, value: clientHeight },
    scrollHeight: { configurable: true, value: scrollHeight },
    scrollTop: { configurable: true, get: () => top, set: (value: number) => { top = Math.max(0, Math.min(value, scrollHeight - clientHeight)); } },
    scrollLeft: { configurable: true, writable: true, value: 7 },
  });
}

interface Fixture { topbar: HTMLElement; page: HTMLElement; scroller: HTMLElement; thead: HTMLElement; tfoot: HTMLElement; toolbar: HTMLElement; plain: HTMLElement; rows: HTMLElement[] }

/** The app shell around a task table: sticky top bar, main, a fixed bulk bar and a plain section. */
function build({ nested = false, shell = true } = {}): Fixture {
  const root = document.createElement('div');
  const rows = Array.from({ length: 20 }, (_, index) => `<tr data-task-row="t${index}"><td>Row ${index}</td></tr>`).join('');
  const table = `<div data-task-table-scroll=""><table><thead class="sticky top-0"><tr><th>Task</th></tr></thead><tbody>${rows}</tbody><tfoot class="sticky bottom-0"><tr><td>Total</td></tr></tfoot></table></div>`;
  root.innerHTML = shell
    ? `<div class="app-shell-workspace"><header style="position: sticky; top: 0"></header><main data-app-shell-main=""><div data-page=""${nested ? ' style="overflow-y: auto"' : ''}>${table}</div><section data-bulk="" style="position: fixed; bottom: 12px"></section><section data-plain=""></section></main></div>`
    : `<header style="position: sticky; top: 0"></header><div data-page="">${table}</div>`;
  document.body.append(root);
  mounted.push(root);
  const get = (selector: string) => root.querySelector<HTMLElement>(selector) as HTMLElement;
  return { topbar: get('header'), page: get('[data-page]'), scroller: get('[data-task-table-scroll]'), thead: get('thead'), tfoot: get('tfoot'), toolbar: get('[data-bulk]'), plain: get('[data-plain]'), rows: [...root.querySelectorAll<HTMLElement>('tr[data-task-row]')] };
}

/** A 48px top bar (not 56), a centered bulk bar over later cells and an overlapping non-fixed section. */
function placeBars(view: Fixture) {
  place(view.topbar, () => box(0, 48, 0, 1000));
  place(view.toolbar, () => box(536, 52, 200, 500));
  place(view.plain, () => box(300, 40, 0, 1000));
}

/** The document scrolls; the table scroller is horizontal only and its summary is in flow. */
function documentGeometry(view: Fixture) {
  placeBars(view);
  scrollport(view.scroller, 880, 880);
  place(view.scroller, () => box(60 - pageY, 880, 0, scrollerWidth));
  place(view.thead, () => box(60 - pageY, 36));
  view.rows.forEach((row, index) => place(row, () => box(96 + index * 40 - pageY, 40)));
  place(view.tfoot, () => box(896 - pageY, 44));
}

/** A 300px vertical table scroller at y=100; inline sticky makes its header/footer really stick. */
function tableScrollerGeometry(view: Fixture) {
  placeBars(view);
  scrollport(view.scroller, 300, 1180);
  place(view.scroller, () => box(100, 300));
  place(view.thead, () => view.thead.style.position === 'sticky' ? box(100, 36) : box(100 - view.scroller.scrollTop, 36));
  view.rows.forEach((row, index) => place(row, () => box(136 + index * 40 - view.scroller.scrollTop, 40)));
  place(view.tfoot, () => view.tfoot.style.position === 'sticky' ? box(356, 44) : box(936 - view.scroller.scrollTop, 44));
}

/** A nested page scrollport below the top bar, taller than the viewport, around a horizontal table. */
function nestedGeometry(view: Fixture, scrollHeight: number) {
  placeBars(view);
  scrollport(view.page, 652, scrollHeight);
  scrollport(view.scroller, 880, 880);
  const shift = () => pageY + view.page.scrollTop;
  place(view.page, () => box(48 - pageY, 652, 0, 1000));
  place(view.scroller, () => box(48 - shift(), 880));
  place(view.thead, () => box(48 - shift(), 36));
  view.rows.forEach((row, index) => place(row, () => box(84 + index * 40 - shift(), 40)));
  place(view.tfoot, () => box(884 - shift(), 44));
}

describe('keyboard row reveal geometry', () => {
  it('leaves an already visible row, the page and every horizontal offset alone', () => {
    const view = build();
    documentGeometry(view);
    revealTaskRow(view.rows[2] as HTMLElement, view.scroller);
    expect(window.scrollBy).not.toHaveBeenCalled();
    expect(view.scroller.scrollTop).toBe(0);
    expect(view.scroller.scrollLeft).toBe(7);
  });

  it('moves the document by exactly the overlap of a fixed bottom bar over the row cells, once', () => {
    const view = build();
    documentGeometry(view);
    pageY = 16;
    // Row 11 sits at 520..560; the bar covers only later cells (x 200..700), not the gutter, from 536.
    revealTaskRow(view.rows[11] as HTMLElement, view.scroller);
    expect(window.scrollBy).toHaveBeenCalledExactlyOnceWith(0, 24);
    expect(pageY).toBe(40);
    revealTaskRow(view.rows[11] as HTMLElement, view.scroller);
    expect(window.scrollBy).toHaveBeenCalledTimes(1);
    expect(view.scroller.scrollLeft).toBe(7);
  });

  it('moves the document up by exactly the part hidden under the measured top bar', () => {
    const view = build();
    documentGeometry(view);
    pageY = 200;
    // Row 3 sits at 16..56 under a 48px bar.
    revealTaskRow(view.rows[3] as HTMLElement, view.scroller);
    expect(window.scrollBy).toHaveBeenCalledExactlyOnceWith(0, -32);
    expect(view.scroller.scrollLeft).toBe(7);
  });

  it('ignores a bar outside the row visible cells, a hidden bar and non-fixed sections', () => {
    const view = build();
    documentGeometry(view);
    pageY = 16;
    scrollerWidth = 180;
    revealTaskRow(view.rows[11] as HTMLElement, view.scroller);
    expect(window.scrollBy).not.toHaveBeenCalled();
    scrollerWidth = 900;
    view.toolbar.style.visibility = 'hidden';
    revealTaskRow(view.rows[11] as HTMLElement, view.scroller);
    expect(window.scrollBy).not.toHaveBeenCalled();
  });

  it('reserves no space for a normal-flow summary footer but clears a really sticky one', () => {
    const view = build();
    tableScrollerGeometry(view);
    // Row 6 sits at 376..416 in a scroller ending at 400.
    revealTaskRow(view.rows[6] as HTMLElement, view.scroller);
    expect(view.scroller.scrollTop).toBe(16);
    view.scroller.scrollTop = 0;
    view.tfoot.style.position = 'sticky';
    revealTaskRow(view.rows[6] as HTMLElement, view.scroller);
    expect(view.scroller.scrollTop).toBe(60);
    expect(view.scroller.scrollLeft).toBe(7);
    expect(window.scrollBy).not.toHaveBeenCalled();
  });

  it('clears a stuck table header with a minimal upward table scroll and no page move', () => {
    const view = build();
    tableScrollerGeometry(view);
    view.thead.style.position = 'sticky';
    view.scroller.scrollTop = 190;
    // Row 4 sits at 106..146 under a header ending at 136.
    revealTaskRow(view.rows[4] as HTMLElement, view.scroller);
    expect(view.scroller.scrollTop).toBe(160);
    expect(view.scroller.scrollLeft).toBe(7);
    expect(window.scrollBy).not.toHaveBeenCalled();
  });

  it('scrolls the nearest vertical page scrollport, never the document, when that is enough', () => {
    const view = build({ nested: true });
    nestedGeometry(view, 2000);
    // Row 12 sits at 564..604; the scrollport ends below the viewport, the bulk bar starts at 536.
    revealTaskRow(view.rows[12] as HTMLElement, view.scroller);
    expect(view.page.scrollTop).toBe(68);
    expect(window.scrollBy).not.toHaveBeenCalled();
    expect(view.page.scrollLeft).toBe(7);
    expect(view.scroller.scrollLeft).toBe(7);
  });

  it('moves the document only by what an exhausted nested scrollport could not', () => {
    const view = build({ nested: true });
    nestedGeometry(view, 700);
    revealTaskRow(view.rows[12] as HTMLElement, view.scroller);
    expect(view.page.scrollTop).toBe(48);
    expect(window.scrollBy).toHaveBeenCalledExactlyOnceWith(0, 20);
    expect(view.page.scrollLeft).toBe(7);
  });

  it('aligns a row taller than the usable viewport to its top once in a standalone table', () => {
    Object.defineProperty(document.documentElement, 'clientHeight', { configurable: true, value: 100 });
    const view = build({ shell: false });
    // Outside the app shell a sticky header is not the top bar.
    place(view.topbar, () => box(0, 48, 0, 1000));
    place(view.scroller, () => box(-pageY, 1000));
    place(view.rows[0] as HTMLElement, () => box(130 - pageY, 120));
    revealTaskRow(view.rows[0] as HTMLElement, view.scroller);
    revealTaskRow(view.rows[0] as HTMLElement, view.scroller);
    expect(window.scrollBy).toHaveBeenCalledExactlyOnceWith(0, 130);
  });
});

describe('keyboard row reveal in the table', () => {
  const alpha = makeTask({ id: 'alpha', title: 'Alpha', position: 0 });
  const bravo = makeTask({ id: 'bravo', title: 'Bravo', position: 1 });
  const charlie = makeTask({ id: 'charlie', title: 'Charlie', position: 2 });
  const gutter = (title: string) => screen.getByRole('button', { name: `Select task: ${title}` });

  function Shell({ onOpenTask }: { onOpenTask: (id: string) => void }) {
    const [ids, setIds] = useState<string[]>([]);
    return <div className="app-shell-workspace">
      <header style={{ position: 'sticky', top: 0 }} />
      <main data-app-shell-main="">
        <TaskTable tasks={[alpha, bravo, charlie]} sections={[]} statuses={statuses} members={[]}
          onOpenTask={onOpenTask} onCreateTask={vi.fn()} onCreateChild={vi.fn()} selectedTaskIds={ids} onSelectionChange={setIds} />
        <section style={{ position: 'fixed', bottom: 12 }} />
      </main>
    </div>;
  }

  it('reveals only after an accepted gutter arrow, never on clicks, Space, title keys or the last row', async () => {
    const user = userEvent.setup(), opened = vi.fn();
    const { container } = render(<Shell onOpenTask={opened} />);
    place(container.querySelector('header') as HTMLElement, () => box(0, 48, 0, 1000));
    place(container.querySelector('section') as HTMLElement, () => box(536, 52, 200, 500));
    place(container.querySelector('[data-task-table-scroll]') as HTMLElement, () => box(400 - pageY, 300));
    [alpha, bravo, charlie].forEach((task, index) =>
      place(container.querySelector(`tr[data-task-row="${task.id}"]`) as HTMLElement, () => box(456 + index * 40 - pageY, 40)));

    // Charlie (536..576) is under the bulk bar, but a click is not a keyboard reveal.
    await user.click(gutter('Charlie'));
    await user.keyboard('{ArrowUp}{ArrowUp}');
    expect(gutter('Alpha')).toHaveFocus();
    expect(window.scrollBy).not.toHaveBeenCalled();
    await user.keyboard('{ArrowDown}{ArrowDown}');
    expect(gutter('Charlie')).toHaveFocus();
    expect(window.scrollBy).toHaveBeenCalledExactlyOnceWith(0, 40);

    await user.keyboard('{ArrowDown} ');
    screen.getByRole('button', { name: 'Alpha' }).focus();
    await user.keyboard('{ArrowDown}');
    expect(window.scrollBy).toHaveBeenCalledTimes(1);
    expect(opened).not.toHaveBeenCalled();
  });
});
