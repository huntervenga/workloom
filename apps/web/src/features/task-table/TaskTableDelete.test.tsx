import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { TaskTable } from './TaskTable';
import { makeTask, statuses } from './taskTableFixtures';

describe('Delete task in the row actions', () => {
  const task = makeTask({ id: 't1', title: 'Old plan' });
  const renderIt = (onDeleteTask: ((task: typeof task) => void) | undefined, writable = true) => render(<TaskTable tasks={[task]} sections={[]} statuses={statuses} members={[]} writable={writable}
    onOpenTask={() => undefined} onCreateTask={() => undefined} onCreateChild={() => undefined} onDeleteTask={onDeleteTask} />);

  it('offers Delete task and hands the task to the page, which shows the Undo notice', async () => {
    const onDelete = vi.fn();
    renderIt(onDelete);
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Task actions: Old plan' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Delete task' }));
    expect(onDelete).toHaveBeenCalledWith(task);
  });
  it('does not offer it to someone who cannot edit', async () => {
    renderIt(vi.fn(), false);
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Task actions: Old plan' }));
    await screen.findByRole('menu');
    expect(screen.queryByRole('menuitem', { name: 'Delete task' })).not.toBeInTheDocument();
  });
});
