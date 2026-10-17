import type { TaskDto } from '@workloom/contracts';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { alpha, alphaMembers, anna, installFakeApi } from '../../test/fakeApi';
import { renderFieldUi } from '../fields/test/fixtures';
import { lostResponse, rootPath, task } from '../planning/test/fixtures';
import { InlineTaskEdit } from '../tasks/InlineTaskEdit';
import { taskInlineColumn, type TaskInlineField } from '../tasks/tableEditing';
import { useTaskCommands } from '../tasks/useTaskCommands';
import { TaskTable } from './TaskTable';
import { makeMember, makeSection, makeTask, statuses } from './taskTableFixtures';

// Source presentation contract only; real pointer/geometry acceptance stays in the browser gate.
const main = makeSection({ id: 'main', name: 'Launch preparation' });
const owner = makeMember({ id: 'owner', userId: 'user-owner', displayName: 'Synthetic Owner' });
const launch = makeTask({ id: 'launch', title: 'Prepare the launch checklist', sectionId: main.id, responsibleMembershipId: owner.id, priority: 'high', estimateMinutes: 180 });
const columnIds = ['title', 'status', 'responsible', 'dueDate', 'priority', 'estimate'] as const;
const widths: Record<string, number> = { title: 460, status: 144, responsible: 176, dueDate: 128, priority: 96, estimate: 128 };
const baseMinWidth = columnIds.reduce((sum, id) => sum + (widths[id] ?? 0), 0);
const editorFields: readonly TaskInlineField[] = ['title', 'statusId', 'responsibleMembershipId', 'dueDate', 'priority', 'estimate'];

function handlers() {
  return { onOpenTask: vi.fn(), onCreateTask: vi.fn(), onCreateChild: vi.fn(), onEditTaskField: vi.fn() };
}

function colWidths(): string[] {
  return [...screen.getByRole('table').querySelectorAll('col')].map(col => col.style.width);
}

const baseWidths = columnIds.map(id => id === 'title' ? 'clamp(280px, 42cqw, 460px)' : `${widths[id]}px`);

describe('fixed grid while a cell editor is open', () => {
  it.each(editorFields)('keeps every column width, the table minimum and the single-line row for an open %s editor', field => {
    const column = taskInlineColumn(field);
    render(<TaskTable tasks={[launch]} sections={[main]} members={[owner]} statuses={statuses} {...handlers()} writable
      columnIds={columnIds} activeFieldEditor={{ taskId: launch.id, field }}
      renderTaskFieldEditor={(row, edited) => row.id === launch.id && edited === field ? <form aria-label="Shared editor"><button type="button">Collapse editor</button></form> : null} />);
    expect(screen.getAllByRole('columnheader').map(header => header.textContent)).toEqual(['Task', 'Status', 'Assignee', 'Due date', 'Priority', 'Team estimate']);
    expect(colWidths()).toEqual(baseWidths);
    expect(screen.getByRole('table').querySelectorAll('col[data-inline-editor]')).toHaveLength(0);
    expect(screen.getByRole('table')).toHaveStyle({ minWidth: `calc(clamp(280px, 42cqw, 460px) + ${baseMinWidth - 460}px)` });
    const form = screen.getByRole('form', { name: 'Shared editor' });
    const cell = form.closest('td');
    const row = cell?.closest('tr');
    if (!cell || !row) throw Error('Editor cell required.');
    expect(within(row).getAllByRole('cell').indexOf(cell)).toBe((columnIds as readonly string[]).indexOf(column));
    expect(cell).toHaveAttribute('data-editing');
    expect(row.querySelectorAll('[data-editing]')).toHaveLength(1);
    // Every body cell is one fixed line that truncates instead of wrapping or growing.
    expect(row.className).toContain('h-10');
    for (const td of within(row).getAllByRole('cell')) {
      expect(td.className).toContain('h-10');
      expect(td.className).toContain('whitespace-nowrap');
      expect(td.className).toContain('overflow-hidden');
    }
    expect(within(row).getAllByRole('cell').at(-1)?.className).toContain('lg:sticky');
  });

  it('marks no cell for hidden columns, unloaded tasks or no active editor', () => {
    const renderWith = (activeFieldEditor: { taskId: string; field: TaskInlineField } | undefined, ids: readonly string[] = columnIds) => render(
      <TaskTable tasks={[launch]} sections={[main]} members={[owner]} statuses={statuses} {...handlers()} writable columnIds={ids} activeFieldEditor={activeFieldEditor} />);
    for (const active of [undefined, { taskId: 'unloaded', field: 'priority' as const }]) {
      const view = renderWith(active);
      expect(colWidths()).toEqual(baseWidths);
      expect(document.querySelectorAll('[data-editing]')).toHaveLength(0);
      view.unmount();
    }
    renderWith({ taskId: launch.id, field: 'priority' }, columnIds.filter(id => id !== 'priority'));
    expect(document.querySelectorAll('[data-editing]')).toHaveLength(0);
    expect(screen.getByRole('table')).toHaveStyle({ minWidth: `calc(clamp(280px, 42cqw, 460px) + ${baseMinWidth - 460 - (widths.priority ?? 0)}px)` });
  });
});

describe('real inline editor inside its fixed cell', () => {
  it('keeps the custom picker, lost-ACK recovery and Collapse out of the row flow, then restores the plain cell', async () => {
    const first = lostResponse();
    installFakeApi({ [`PATCH ${rootPath}/tasks/${task.id}`]: () => first.promise });
    function Example() {
      const commands = useTaskCommands(anna.id, alpha.id);
      const [active, setActive] = useState<TaskInlineField | null>('priority');
      return <TaskTable tasks={[task]} sections={[]} members={alphaMembers} statuses={statuses} {...handlers()} writable columnIds={columnIds}
        activeFieldEditor={active ? { taskId: task.id, field: active } : undefined}
        renderTaskFieldEditor={(row: TaskDto, field) => row.id === task.id && field === active ? <InlineTaskEdit task={row} field={field} statuses={statuses} members={alphaMembers} commands={commands} writable onClose={() => setActive(null)} onMoreDetails={() => undefined} onSaved={() => undefined} /> : null} />;
    }
    const ui = renderFieldUi(<Example />);
    const priorityIndex = columnIds.indexOf('priority');
    const listbox = screen.getByRole('listbox', { name: 'Priority' });
    // The menu is portalled outside the table, so it can neither clip nor reflow a cell.
    expect(listbox.closest('table')).toBeNull();
    expect(screen.getByRole('table').querySelector('select')).toBeNull();
    await ui.user.click(within(listbox).getByRole('option', { name: 'Urgent' }));
    await act(async () => first.lose());
    const retry = await screen.findByRole('button', { name: 'Retry' });
    const form = retry.closest('form');
    const cell = form?.closest('td');
    if (!form || !cell) throw Error('Inline editor cell required.');
    expect(within(cell.closest('tr') as HTMLElement).getAllByRole('cell').indexOf(cell)).toBe(priorityIndex);
    expect(colWidths()).toEqual(baseWidths);
    expect(form.className).toContain('h-8');
    // Feedback stays in the editor's DOM (focus, Escape, form ownership) but outside the layout flow.
    const popover = retry.closest<HTMLElement>('[data-cell-popover]');
    expect(popover).not.toBeNull();
    expect(popover?.style.position).toBe('fixed');
    expect(within(popover as HTMLElement).getByRole('alert')).toBeInTheDocument();
    const collapse = within(popover as HTMLElement).getByRole('button', { name: 'Collapse editor' });
    expect(collapse).toBeEnabled();
    await ui.user.click(collapse);
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Collapse editor' })).not.toBeInTheDocument());
    expect(colWidths()).toEqual(baseWidths);
    expect(document.querySelectorAll('[data-editing]')).toHaveLength(0);
  });
});

describe('one-shot local reveal of an explicitly opened editor', () => {
  it('pans only the table scroller once per explicit open; lost ACK, remounts and a consumed claim never pan or steal focus', async () => {
    const first = lostResponse();
    installFakeApi({ [`PATCH ${rootPath}/tasks/${task.id}`]: () => first.promise });
    // Stubbed boxes only exercise the guard; real occlusion/hit-testing is the browser gate's job.
    let scrollLeft = 0;
    const pans: number[] = [];
    const box = (left: number, width: number) => ({ left, right: left + width, top: 0, bottom: 40, width, height: 40, x: left, y: 0, toJSON: () => ({}) }) as DOMRect;
    const geometry = vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
      if (this.matches('[data-task-table-scroll]')) return box(0, 600);
      return this.tagName === 'FORM' ? box(700 - scrollLeft, 88) : box(0, 0);
    });
    Object.defineProperty(document.documentElement, 'clientWidth', { configurable: true, get: () => 1000 });
    function Example() {
      const commands = useTaskCommands(anna.id, alpha.id);
      const [active, setActive] = useState<{ claim: { current: boolean }; mount: number } | null>(null);
      return <>
        <button onClick={() => setActive({ claim: { current: false }, mount: 0 })}>Open Priority explicitly</button>
        <button onClick={() => setActive(before => before && { ...before, mount: before.mount + 1 })}>Remount editor</button>
        <TaskTable tasks={[task]} sections={[]} members={alphaMembers} statuses={statuses} {...handlers()} writable columnIds={columnIds}
          activeFieldEditor={active ? { taskId: task.id, field: 'priority' } : undefined}
          renderTaskFieldEditor={(row: TaskDto, field) => active && row.id === task.id && field === 'priority' ? <InlineTaskEdit key={active.mount} focusClaim={active.claim} task={row} field={field} statuses={statuses} members={alphaMembers} commands={commands} writable onClose={() => setActive(null)} onMoreDetails={() => undefined} onSaved={() => undefined} /> : null} />
      </>;
    }
    try {
      const ui = renderFieldUi(<Example />);
      const scroller = document.querySelector<HTMLElement>('[data-task-table-scroll]');
      if (!scroller) throw Error('Task table scroller required.');
      Object.defineProperty(scroller, 'clientWidth', { configurable: true, get: () => 600 });
      Object.defineProperty(scroller, 'scrollLeft', { configurable: true, get: () => scrollLeft, set: (value: number) => { scrollLeft = value; pans.push(value); } });
      const pageScroll = vi.spyOn(window, 'scrollTo');

      await ui.user.click(screen.getByRole('button', { name: 'Open Priority explicitly' }));
      expect(pans).toEqual([188]);
      expect(screen.getByRole('combobox', { name: 'Priority' })).toHaveFocus();
      expect(screen.getByRole('listbox', { name: 'Priority' })).toBeInTheDocument();

      await ui.user.click(screen.getByRole('option', { name: 'Urgent' }));
      await act(async () => first.lose());
      await screen.findByRole('button', { name: 'Retry' });
      expect(pans).toEqual([188]);

      // The consumed claim survives a remount: no focus steal, no reopened list and no second pan.
      scrollLeft = 0;
      const remount = screen.getByRole('button', { name: 'Remount editor' });
      await ui.user.click(remount);
      expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
      expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
      expect(remount).toHaveFocus();
      expect(pans).toEqual([188]);

      await ui.user.click(screen.getByRole('button', { name: 'Collapse editor' }));
      await waitFor(() => expect(screen.queryByRole('form')).not.toBeInTheDocument());
      await ui.user.click(screen.getByRole('button', { name: 'Open Priority explicitly' }));
      expect(pans).toEqual([188, 188]);
      expect(pageScroll).not.toHaveBeenCalled();
    } finally {
      geometry.mockRestore();
      Reflect.deleteProperty(document.documentElement, 'clientWidth');
    }
  });
});
