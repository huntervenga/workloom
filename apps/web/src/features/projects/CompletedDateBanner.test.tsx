import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { TaskTable } from '../task-table/TaskTable';
import { makeTask, statuses as fixtureStatuses } from '../task-table/taskTableFixtures';

const doneStatus = { ...(fixtureStatuses[0] as (typeof fixtureStatuses)[number]), id: 'status-done', name: 'Done', group: 'done' as const, position: 9 };
const statuses = [...fixtureStatuses, doneStatus];
import { CompletedDateBanner } from './CompletedDateBanner';
import { completedDateIssues } from './dateConsistency';

const project = { dateRange: { from: '2026-01-01', to: '2026-01-14' } };
const done = doneStatus;

describe('completed tasks outside the project dates', () => {
  const tasks = [
    makeTask({ id: 'ok', title: 'Fine', statusId: done?.id ?? '', dueDate: '2026-01-10' }),
    makeTask({ id: 'late', title: 'Closed late', statusId: done?.id ?? '', dueDate: '2026-01-20' }),
    makeTask({ id: 'none', title: 'Closed undated', statusId: done?.id ?? '', dueDate: null }),
  ];
  const issues = completedDateIssues(project, tasks, statuses);

  it('summarises the problem, lists the tasks on request and opens one', async () => {
    const open = vi.fn();
    render(<CompletedDateBanner project={project} issues={issues} tasks={tasks} partial={false} onOpenTask={open} />);
    expect(screen.getByRole('status')).toHaveTextContent('2 completed task(s) do not fit the project dates (2026-01-01 – 2026-01-14).');
    expect(screen.getByRole('status')).toHaveTextContent('1 without a due date, 1 with a due date outside the project dates.');
    expect(screen.getByRole('status')).not.toHaveTextContent('open top-level');
    expect(screen.queryByText('Closed late')).not.toBeInTheDocument();
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Show tasks' }));
    const list = screen.getByRole('list');
    expect(within(list).getByText(/due after the project ends \(2026-01-20\)/)).toBeInTheDocument();
    expect(within(list).getByText(/no due date/)).toBeInTheDocument();
    await user.click(within(list).getByRole('button', { name: 'Closed undated' }));
    expect(open).toHaveBeenCalledWith('none');
  });

  it('is absent when every finished task fits', () => {
    const { container } = render(<CompletedDateBanner project={project} issues={[]} tasks={tasks} partial={false} onOpenTask={() => undefined} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('marks the date cell of a flagged task in the table', () => {
    render(<TaskTable tasks={tasks} sections={[]} statuses={statuses} members={[]} onOpenTask={() => undefined} onCreateTask={() => undefined} onCreateChild={() => undefined}
      dateIssues={new Map(issues.map(issue => [issue.taskId, { kind: issue.kind, finished: issue.finished }] as const))} />);
    const flagged = [...document.querySelectorAll('[data-date-issue]')].map(node => node.getAttribute('data-date-issue')).sort();
    expect(flagged).toEqual(['after', 'missing']);
  });

  it('also flags an open top-level task with no date, in red, and says period reports cannot count it', () => {
    const open = [makeTask({ id: 'open-undated', title: 'Plan the launch', statusId: 'status-todo', dueDate: null }), makeTask({ id: 'child', title: 'Sub', statusId: 'status-todo', dueDate: null, parentTaskId: 'open-undated' }), makeTask({ id: 'dated', title: 'Dated', statusId: 'status-todo', dueDate: '2026-01-05' })];
    const found = completedDateIssues(project, open, statuses);
    expect(found).toEqual([{ taskId: 'open-undated', kind: 'missing', finished: false }]);
    render(<TaskTable tasks={open} sections={[]} statuses={statuses} members={[]} onOpenTask={() => undefined} onCreateTask={() => undefined} onCreateChild={() => undefined}
      dateIssues={new Map(found.map(issue => [issue.taskId, { kind: issue.kind, finished: issue.finished }] as const))} />);
    const flagged = document.querySelector('[data-date-issue="missing"]');
    expect(flagged?.getAttribute('title')).toContain('period reports cannot count this task');
    expect(flagged?.className).toContain('text-rose-700');
    render(<CompletedDateBanner project={project} issues={found} tasks={open} partial={false} onOpenTask={() => undefined} />);
    expect(screen.getByRole('status', { name: 'Completed tasks outside the project dates' })).toHaveTextContent('1 open task(s) have no due date');
  });
});
