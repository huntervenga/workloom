import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { makeTask, statuses as fixtureStatuses } from '../task-table/taskTableFixtures';
import { CompleteSplitButton } from './CompleteSplitButton';

const doneStatus = { ...(fixtureStatuses[0] as (typeof fixtureStatuses)[number]), id: 'status-done', name: 'Done', group: 'done' as const, position: 9 };
const cancelled = { ...doneStatus, id: 'status-cancelled', name: 'Cancelled', group: 'cancelled' as const, position: 10 };
const statuses = [...fixtureStatuses, doneStatus, cancelled];

describe('complete split button', () => {
  it('completes with the primary click and offers "complete and continue" in the menu', async () => {
    const onComplete = vi.fn(), onContinue = vi.fn();
    const task = makeTask({ id: 't1', statusId: 'status-todo' });
    render(<CompleteSplitButton task={task} statuses={statuses} busy={false} onComplete={onComplete} onContinue={onContinue} />);
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Mark complete' }));
    expect(onComplete).toHaveBeenCalledWith(task, 'status-done', expect.anything());
    await user.click(screen.getByRole('button', { name: 'More ways to complete' }));
    await user.click(await screen.findByRole('menuitem', { name: /Complete and continue in another project/ }));
    expect(onContinue).toHaveBeenCalledWith(task);
  });
  it('shows a completed task as such, reopens it and still offers to continue', async () => {
    const onComplete = vi.fn(), onContinue = vi.fn();
    const task = makeTask({ id: 't2', statusId: 'status-done' });
    render(<CompleteSplitButton task={task} statuses={statuses} busy={false} onComplete={onComplete} onContinue={onContinue} />);
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Completed' }));
    expect(onComplete).toHaveBeenCalledWith(task, 'status-todo', expect.anything());
    await user.click(screen.getByRole('button', { name: 'More ways to complete' }));
    expect(await screen.findByRole('menuitem', { name: 'Continue in another project…' })).toBeInTheDocument();
  });
  it('is hidden for a cancelled task', () => {
    const { container } = render(<CompleteSplitButton task={makeTask({ id: 't3', statusId: 'status-cancelled' })} statuses={statuses} busy={false} onComplete={() => undefined} onContinue={() => undefined} />);
    expect(container).toBeEmptyDOMElement();
  });
});
