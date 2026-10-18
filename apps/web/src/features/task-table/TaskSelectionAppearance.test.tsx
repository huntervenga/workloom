import { fireEvent, render, screen, within } from '@testing-library/react';
import { useState } from 'react';
import { expect, it, vi } from 'vitest';
import { TaskTable, type TaskTableCustomColumn } from './TaskTable';
import { makeMember, makeSection, makeTag, makeTask, statuses } from './taskTableFixtures';

// Source paint contract only; actual computed Chrome paint stays in the browser gate.
const main = makeSection({ id: 'main', name: 'Launch preparation' });
const owner = makeMember({ id: 'owner', userId: 'user-owner', displayName: 'Synthetic Owner' });
const ux = makeTag({ id: 'tag-ux', name: 'UX' });
const tasks = [
  makeTask({ id: 'launch', title: 'Prepare the launch checklist', sectionId: main.id, position: 0, responsibleMembershipId: owner.id, tags: [ux], estimateMinutes: 180 }),
  makeTask({ id: 'review', title: 'Review the mobile experience', sectionId: main.id, position: 1, tags: [ux], estimateMinutes: 60 }),
  makeTask({ id: 'checks', title: 'Run the weekly workflow checks', sectionId: main.id, position: 2 }),
] as const;
const customColumns: TaskTableCustomColumn[] = [{ id: 'field-effort', label: 'Effort', width: 160, renderCell: task => <span>{task.id === 'launch' ? 'High' : 'Low'}</span> }];
const columnIds = ['title', 'status', 'responsible', 'tags', 'field-effort', 'estimate'];
const accentSoft = 'var(--color-selection)';

function handlers() {
  return { onOpenTask: vi.fn(), onCreateTask: vi.fn(), onCreateChild: vi.fn(), onEditTaskField: vi.fn() };
}

function rowOf(title: string): HTMLElement {
  const row = screen.getByRole('button', { name: title }).closest('tr');
  if (!row) throw Error('Task row required.');
  return row;
}

const paint = (row: HTMLElement) => within(row).getAllByRole('cell').map(cell => cell.style.backgroundColor);
const gutter = (title: string) => screen.getByRole('button', { name: `Select task: ${title}` });

it('paints every cell of a selected row, sticky title and estimate included, with one opaque semantic accent and the same fixed row', () => {
  render(<TaskTable tasks={tasks} sections={[main]} members={[owner]} statuses={statuses} {...handlers()} writable
    columnIds={columnIds} customColumns={customColumns} selectedTaskIds={['launch']} onSelectionChange={vi.fn()} />);
  const selected = rowOf(tasks[0].title);
  const plain = rowOf(tasks[1].title);
  expect(selected).toHaveAttribute('aria-selected', 'true');
  expect(plain).toHaveAttribute('aria-selected', 'false');
  expect(within(selected).getAllByRole('cell')).toHaveLength(columnIds.length);

  expect(paint(selected)).toEqual(columnIds.map(() => accentSoft));
  expect(paint(plain)).not.toContain(accentSoft);
  // No translucent tint that the sticky cells' own surface would cover.
  for (const element of [selected, ...within(selected).getAllByRole('cell')]) expect(element.className).not.toMatch(/bg-accent-soft\/\d+/);

  // Selection adds paint only: the same 40px row plus its 1px rule, and the same title inset.
  for (const row of [selected, plain]) {
    expect(row).toHaveClass('h-10', 'border-t');
    for (const cell of within(row).getAllByRole('cell')) expect(cell).toHaveClass('h-10');
    expect(within(row).getAllByRole('cell')[0]).toHaveStyle({ paddingLeft: '12px' });
  }
});

it('keeps a blank, stripe-free selection gutter whose pressed state, Shift range and Ctrl toggle drive the row paint', () => {
  const calls = handlers();
  function Selectable() {
    const [ids, setIds] = useState<string[]>([]);
    return <TaskTable tasks={tasks} sections={[main]} members={[owner]} statuses={statuses} {...calls} writable
      columnIds={columnIds} customColumns={customColumns} selectedTaskIds={ids} onSelectionChange={setIds} />;
  }
  render(<Selectable />);
  const pressed = () => tasks.map(task => gutter(task.title).getAttribute('aria-pressed'));
  expect(pressed()).toEqual(['false', 'false', 'false']);
  fireEvent.click(gutter(tasks[0].title), { detail: 1 });
  expect(pressed()).toEqual(['true', 'false', 'false']);
  fireEvent.click(gutter(tasks[2].title), { detail: 1, shiftKey: true });
  expect(pressed()).toEqual(['true', 'true', 'true']);
  fireEvent.click(gutter(tasks[1].title), { detail: 1, ctrlKey: true });
  expect(pressed()).toEqual(['true', 'false', 'true']);
  expect(calls.onEditTaskField).not.toHaveBeenCalled();
  expect(calls.onOpenTask).not.toHaveBeenCalled();

  expect(paint(rowOf(tasks[2].title))).toEqual(columnIds.map(() => accentSoft));
  expect(paint(rowOf(tasks[1].title))).not.toContain(accentSoft);

  // The gutter is a blank press target: no vertical separator stripe in any row or the header.
  for (const task of tasks) {
    const button = gutter(task.title);
    expect(button).toBeEmptyDOMElement();
    expect(button.closest('td')?.querySelectorAll('.border-r, .border-l')).toHaveLength(0);
  }
  expect(screen.getAllByRole('columnheader')[0]?.querySelectorAll('.border-r, .border-l')).toHaveLength(0);
});
