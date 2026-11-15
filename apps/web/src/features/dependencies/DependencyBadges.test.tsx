import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, it, vi } from 'vitest';
import { DependencyBadges } from './DependencyBadges';

const taskId = '5eed0000-0000-4000-8000-000000000405';

it('shows an hourglass while the task waits and a raised hand while it blocks, each opening the task', async () => {
  const user = userEvent.setup();
  const open = vi.fn();
  render(<DependencyBadges title="Prepare launch" counts={{ taskId, waitingOn: 2, blocking: 1 }} onOpen={open} />);
  const waiting = screen.getByRole('button', { name: 'Prepare launch: waiting on 2 unfinished tasks. Open the task' });
  const blocking = screen.getByRole('button', { name: 'Prepare launch: blocking 1 unfinished task. Open the task' });
  expect(waiting).toHaveAttribute('title', 'Waiting on 2 unfinished tasks');
  expect(blocking).toHaveAttribute('title', 'Blocking 1 unfinished task');
  await user.click(waiting);
  await user.click(blocking);
  expect(open).toHaveBeenCalledTimes(2);
});

it('shows only the side that has unfinished links, and nothing without counts', () => {
  const { rerender } = render(<DependencyBadges title="Prepare launch" counts={{ taskId, waitingOn: 0, blocking: 3 }} onOpen={vi.fn()} />);
  expect(document.querySelector('[data-dependency-badge="waiting"]')).toBeNull();
  expect(document.querySelector('[data-dependency-badge="blocking"]')).not.toBeNull();
  rerender(<DependencyBadges title="Prepare launch" counts={undefined} onOpen={vi.fn()} />);
  expect(document.querySelector('[data-dependency-badge]')).toBeNull();
});
