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
import { INLINE_EDITOR_COLUMN_WIDTH, TaskTable } from './TaskTable';
import { makeMember, makeSection, makeTask, statuses } from './taskTableFixtures';

// Source presentation contract only; real pointer/geometry acceptance stays in the browser gate.
const main = makeSection({ id: 'main', name: 'Launch preparation' });
const owner = makeMember({ id: 'owner', userId: 'user-owner', displayName: 'Synthetic Owner' });
const launch = makeTask({ id: 'launch', title: 'Prepare the launch checklist', sectionId: main.id, responsibleMembershipId: owner.id, priority: 'high', estimateMinutes: 180 });
const columnIds = ['title', 'status', 'responsible', 'dueDate', 'priority', 'estimate'] as const;
const widths: Record<string, number> = { title: 320, status: 144, responsible: 176, dueDate: 128, priority: 96, estimate: 128 };
const baseMinWidth = columnIds.reduce((sum, id) => sum + (widths[id] ?? 0), 0);
const editorFields: readonly TaskInlineField[] = ['statusId', 'responsibleMembershipId', 'dueDate', 'priority', 'estimate'];

function handlers() {
  return { onOpenTask: vi.fn(), onCreateTask: vi.fn(), onCreateChild: vi.fn(), onEditTaskField: vi.fn() };
}

function colWidths(): string[] {
  return [...screen.getByRole('table').querySelectorAll('col')].map(col => col.style.width);
}

describe('active inline editor column budget', () => {
  it.each(editorFields)('gives the shared %s editor a real column width while order, title and sticky budget stay intact', field => {
    const column = taskInlineColumn(field);
    render(<TaskTable tasks={[launch]} sections={[main]} members={[owner]} statuses={statuses} {...handlers()} writable
      columnIds={columnIds} activeFieldEditor={{ taskId: launch.id, field }}
      renderTaskFieldEditor={(task, edited) => task.id === launch.id && edited === field ? <form aria-label="Shared editor"><button type="button">Collapse editor</button></form> : null} />);
    const headers = screen.getAllByRole('columnheader').map(header => header.textContent);
    expect(headers).toEqual(['Task', 'Status', 'Assignee', 'Due date', 'Priority', 'Team estimate']);
    const index = columnIds.indexOf(column);
    const extra = INLINE_EDITOR_COLUMN_WIDTH - (widths[column] ?? 0);
    expect(colWidths()).toEqual(columnIds.map(id => id === 'title' ? '' : `${id === column ? INLINE_EDITOR_COLUMN_WIDTH : widths[id]}px`));
    expect(screen.getByRole('table').querySelectorAll('col[data-inline-editor]')).toHaveLength(1);
    // The title keeps its own minimum: the table grows and scrolls locally instead of squeezing it.
    expect(screen.getByRole('table')).toHaveStyle({ minWidth: `${baseMinWidth + extra}px` });
    const row = screen.getByRole('button', { name: launch.title }).closest('tr');
    if (!row) throw Error('Task row required.');
    const cells = within(row).getAllByRole('cell');
    expect(cells).toHaveLength(columnIds.length);
    expect(within(cells[index] as HTMLElement).getByRole('form', { name: 'Shared editor' })).toBeInTheDocument();
    expect(cells.at(-1)?.className).toContain('lg:sticky');
  });

  it('leaves widths untouched for title editing, hidden columns, unloaded tasks and no active editor', () => {
    const renderWith = (activeFieldEditor: { taskId: string; field: TaskInlineField } | undefined, ids: readonly string[] = columnIds) => render(
      <TaskTable tasks={[launch]} sections={[main]} members={[owner]} statuses={statuses} {...handlers()} writable columnIds={ids} activeFieldEditor={activeFieldEditor} />);
    const base = columnIds.map(id => id === 'title' ? '' : `${widths[id]}px`);
    for (const active of [undefined, { taskId: launch.id, field: 'title' as const }, { taskId: 'unloaded', field: 'priority' as const }]) {
      const view = renderWith(active);
      expect(colWidths()).toEqual(base);
      expect(screen.getByRole('table')).toHaveStyle({ minWidth: `${baseMinWidth}px` });
      view.unmount();
    }
    renderWith({ taskId: launch.id, field: 'priority' }, columnIds.filter(id => id !== 'priority'));
    expect(screen.getByRole('table').querySelectorAll('col[data-inline-editor]')).toHaveLength(0);
    expect(screen.getByRole('table')).toHaveStyle({ minWidth: `${baseMinWidth - (widths.priority ?? 0)}px` });
  });
});

describe('native inline editor inside its budget', () => {
  it('keeps lost-ACK recovery and wrapping Collapse inside the Priority cell, then restores the column', async () => {
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
    await ui.user.selectOptions(screen.getByRole('combobox', { name: 'Priority' }), 'urgent');
    await ui.user.click(screen.getByRole('button', { name: 'Save' }));
    await act(async () => first.lose());
    const retry = await screen.findByRole('button', { name: 'Retry' });
    const form = retry.closest('form');
    const cell = form?.closest('td');
    if (!form || !cell) throw Error('Inline editor cell required.');
    expect(within(cell.closest('tr') as HTMLElement).getAllByRole('cell').indexOf(cell)).toBe(priorityIndex);
    expect(colWidths()[priorityIndex]).toBe(`${INLINE_EDITOR_COLUMN_WIDTH}px`);
    expect(form.className).toContain('min-w-0');
    expect(form.className).toContain('[overflow-wrap:anywhere]');
    expect(within(form).getByRole('alert')).toBeInTheDocument();
    const collapse = within(form).getByRole('button', { name: 'Collapse editor' });
    const actions = collapse.closest('[data-inline-actions]');
    expect(actions?.className).toContain('flex-wrap');
    expect(actions).toContainElement(retry);
    expect(collapse).toBeEnabled();
    await ui.user.click(collapse);
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Collapse editor' })).not.toBeInTheDocument());
    expect(colWidths()[priorityIndex]).toBe(`${widths.priority}px`);
  });
});
