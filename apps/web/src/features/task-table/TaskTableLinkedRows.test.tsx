import type { TaskDto } from '@workloom/contracts';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { TaskTable, type TaskTableProps } from './TaskTable';
import { linkedRowBlocks, placeLinkedBlocks, type TaskTableLinkedRow } from './linkedRows';
import { buildTaskGroups, visibleTaskRows } from './taskTree';
import { makeMember, makeSection, makeTask, statuses } from './taskTableFixtures';

const backlog = makeSection({ id: 'sec-backlog', name: 'Backlog', position: 0 });
const doing = makeSection({ id: 'sec-doing', name: 'Doing', position: 1 });
const anna = makeMember({ id: 'm-anna', userId: 'u-anna', displayName: 'Анна Ковалёва' });

const own = (id: string, position: number, sectionId: string | null = backlog.id, extra: Partial<TaskDto> = {}) =>
  makeTask({ id, title: `Own ${id}`, sectionId, position, workPackageId: `wp-${id}`, ...extra });
const linked = (id: string, position: number, sectionId: string | null = backlog.id, task: Partial<TaskDto> = {}): TaskTableLinkedRow => ({
  id: `placement-${id}`, sectionId, position,
  task: makeTask({ id, title: `Linked ${id}`, projectId: 'home-project', sectionId: 'home-section', position: 0, workPackageId: `wp-${id}`, ...task }),
  status: { name: 'In review', group: 'in_progress' },
  homeProject: { id: 'home-project', name: '45 week' },
});

function renderTable(props: Partial<TaskTableProps> & Pick<TaskTableProps, 'tasks'>) {
  const onOpenTask = vi.fn<(taskId: string) => void>();
  render(<TaskTable sections={[backlog, doing]} statuses={statuses} members={[anna]} onOpenTask={onOpenTask} onCreateTask={vi.fn()} onCreateChild={vi.fn()} {...props} />);
  return { onOpenTask };
}

/** Own (`Own <id>`) and linked (`Linked <id>`) rows of the section whose header names it, in table order. */
function sectionRows(name: string): string[] {
  const body = [...document.querySelectorAll('tbody')].find(item => item.querySelector('tr')?.textContent?.includes(name));
  if (!body) throw new Error(`No section ${name}`);
  return [...body.querySelectorAll('tr')].flatMap(row => row.dataset['linkedTask'] ? [`Linked ${row.dataset['linkedTask']}`] : row.dataset['taskRow'] ? [`Own ${row.dataset['taskRow']}`] : []);
}

describe('linked rows in the task table', () => {
  it('places a linked task in its section, in its place in the manual order', () => {
    renderTable({ tasks: [own('a', 0), own('b', 2), own('c', 0, doing.id)], linkedRows: [linked('x', 1), linked('y', 5), linked('z', 0, doing.id)] });
    expect(sectionRows('Backlog')).toEqual(['Own a', 'Linked x', 'Own b', 'Linked y']);
    // On a tie the project's own task stays first.
    expect(sectionRows('Doing')).toEqual(['Own c', 'Linked z']);
  });

  it('marks a linked row with its home project and opens it in the task pane', async () => {
    const user = userEvent.setup();
    const { onOpenTask } = renderTable({ tasks: [own('a', 0)], linkedRows: [linked('x', 1)] });
    const row = document.querySelector('tr[data-linked-row="placement-x"]');
    expect(row).not.toBeNull();
    expect(within(row as HTMLElement).getByText('45 week')).toBeInTheDocument();
    expect(within(row as HTMLElement).getByText('In review')).toBeInTheDocument();
    // Not a row of this project's own tasks: no selection, drag or row number.
    expect((row as HTMLElement).hasAttribute('data-task-row')).toBe(false);
    await user.click(screen.getByRole('button', { name: 'Open Linked x, linked from 45 week' }));
    expect(onOpenTask).toHaveBeenCalledWith('x');
  });

  it('adds a group for a section that holds only linked tasks', () => {
    renderTable({ tasks: [own('a', 0)], linkedRows: [linked('x', 0, null)] });
    const row = document.querySelector('tr[data-linked-row="placement-x"]');
    // Its own group, after the project's sections.
    expect(row?.closest('tbody')?.querySelector('tr[data-task-row]')).toBeNull();
    expect(row?.closest('tbody')).toBe([...document.querySelectorAll('tbody')].filter(body => body.querySelector('tr[data-linked-row], tr[data-task-row]')).at(-1));
  });

  it('puts a linked task in its assignee group when grouped by assignee', () => {
    const boris = makeMember({ id: 'm-boris', userId: 'u-boris', displayName: 'Борис Петров' });
    renderTable({ tasks: [own('a', 0, backlog.id, { responsibleMembershipId: anna.id })], members: [anna, boris], grouping: 'assignee',
      linkedRows: [linked('x', 1, backlog.id, { responsibleMembershipId: anna.id }), linked('y', 0, backlog.id, { responsibleMembershipId: boris.id })] });
    expect(sectionRows('Анна')).toEqual(['Own a', 'Linked x']);
    // A person with only linked tasks gets a group too.
    expect(sectionRows('Борис')).toEqual(['Linked y']);
  });

  it('shows a linked custom field value through the page renderer', () => {
    renderTable({
      tasks: [own('a', 0)], linkedRows: [linked('x', 1)],
      customColumns: [{ id: 'field-hours', label: 'Hours', width: 120, renderCell: () => 'own value' }],
      renderLinkedCell: (row, columnId) => `${row.task.id}:${columnId}`,
    });
    const row = document.querySelector('tr[data-linked-row="placement-x"]') as HTMLElement;
    expect(within(row).getByText('x:field-hours')).toBeInTheDocument();
  });
});

describe('linked row placement', () => {
  it('keeps a linked subtask under its linked parent and never splits an own subtree', () => {
    const parent = own('p', 1), child = own('c', 0, backlog.id, { parentTaskId: 'p' });
    const rows = visibleTaskRows(buildTaskGroups([parent, child], [backlog])[0]?.roots ?? [], new Set());
    const blocks = linkedRowBlocks([linked('x', 2), linked('y', 0, backlog.id, { parentTaskId: 'x' })], 'manual').get(backlog.id) ?? [];
    expect(blocks.map(block => block.rows.map(item => [item.row.task.id, item.depth]))).toEqual([[['x', 0], ['y', 1]]]);
    // After the own parent and its subtask, not between them.
    expect([...placeLinkedBlocks(rows, blocks, 'manual').keys()]).toEqual([2]);
  });

  it('orders by due date when the table is sorted by due date', () => {
    const early = own('e', 0, backlog.id, { dueDate: '2026-11-10' }), late = own('l', 1, backlog.id, { dueDate: '2026-11-20' });
    const rows = visibleTaskRows(buildTaskGroups([early, late], [backlog], undefined, 'due_asc')[0]?.roots ?? [], new Set());
    const blocks = linkedRowBlocks([linked('x', 9, backlog.id, { dueDate: '2026-11-15' })], 'due_asc').get(backlog.id) ?? [];
    expect([...placeLinkedBlocks(rows, blocks, 'due_asc').keys()]).toEqual([1]);
  });
});
