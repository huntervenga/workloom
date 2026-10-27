import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, it, vi } from 'vitest';
import { TaskTable } from './TaskTable';
import { makeTask, statuses } from './taskTableFixtures';

it('shows completed attachment counts after titles without changing title editing or details actions', async () => {
  const task = makeTask({ id: 'with-files', title: 'Review designs', attachmentCount: 2 });
  const empty = makeTask({ id: 'empty', title: 'No files', attachmentCount: 0 });
  const legacy = makeTask({ id: 'legacy', title: 'Old response' });
  const edit = vi.fn(), open = vi.fn(), user = userEvent.setup();
  render(<TaskTable tasks={[task, empty, legacy]} sections={[]} members={[]} statuses={statuses}
    writable onEditTaskField={edit} onOpenTask={open} onCreateTask={vi.fn()} onCreateChild={vi.fn()} />);
  const title = screen.getByRole('button', { name: task.title });
  const row = title.closest('tr');
  if (!row) throw new Error('Task row missing.');
  const badge = within(row).getByRole('img', { name: '2 attachments' });
  expect(badge).toHaveAttribute('title', '2 attachments');
  expect(within(badge).getByText('2')).toBeVisible();
  expect(badge.querySelector('svg')).not.toBeNull();
  expect(title.compareDocumentPosition(badge) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(screen.getAllByRole('img')).toHaveLength(1);
  await user.click(title);
  expect(edit).toHaveBeenCalledExactlyOnceWith(task, 'title');
  expect(open).not.toHaveBeenCalled();
  await user.click(within(row).getByRole('button', { name: 'Open task “Review designs”' }));
  expect(open).toHaveBeenCalledExactlyOnceWith(task.id);
});

it('updates the count and removes the badge when the refreshed task has no attachments', () => {
  const task = makeTask({ id: 'refreshed', attachmentCount: 1 });
  const props = { sections: [], members: [], statuses, onOpenTask: vi.fn(), onCreateTask: vi.fn(), onCreateChild: vi.fn() };
  const view = render(<TaskTable {...props} tasks={[task]} />);
  expect(screen.getByRole('img', { name: '1 attachment' })).toBeVisible();
  view.rerender(<TaskTable {...props} tasks={[{ ...task, attachmentCount: 5 }]} />);
  expect(screen.getByRole('img', { name: '5 attachments' })).toBeVisible();
  view.rerender(<TaskTable {...props} tasks={[{ ...task, attachmentCount: 0 }]} />);
  expect(screen.queryByRole('img')).not.toBeInTheDocument();
});
