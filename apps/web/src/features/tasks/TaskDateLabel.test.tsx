import { render, screen } from '@testing-library/react';
import { expect, it } from 'vitest';
import { TaskDateLabel } from './TaskDateLabel';

it('keeps real dates and relative badges when done, but removes the overdue warning', () => {
  const today = '2026-11-05';
  const { rerender } = render(<>
    <TaskDateLabel date={today} today={today} finished />
    <TaskDateLabel date="2026-11-06" today={today} finished />
    <TaskDateLabel date="2026-11-04" today={today} />
  </>);
  expect(screen.getByText('Today')).toBeVisible();
  expect(screen.getByText('Thu, Nov 5')).toBeVisible();
  expect(screen.getByText('Tomorrow')).toBeVisible();
  expect(screen.getByText('Fri, Nov 6')).toBeVisible();
  expect(screen.getByText(/overdue/i)).toBeInTheDocument();
  rerender(<TaskDateLabel date="2026-11-04" today={today} finished />);
  expect(screen.getByText('Wed, Nov 4')).toBeVisible();
  expect(screen.queryByText(/overdue/i)).not.toBeInTheDocument();
});
