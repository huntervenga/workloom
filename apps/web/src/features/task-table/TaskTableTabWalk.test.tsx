import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, it, vi } from 'vitest';
import { TaskTable } from './TaskTable';
import { makeMember, makeSection, makeTask, statuses } from './taskTableFixtures';

const main = makeSection({ id: 'main', name: 'Launch preparation' });
const owner = makeMember({ id: 'owner', userId: 'user-owner', displayName: 'Synthetic Owner' });
const task = makeTask({ id: 'walk-1', title: 'Walk the row', sectionId: main.id, position: 0, responsibleMembershipId: owner.id });

function table(onEditTaskField = vi.fn()) {
  render(<TaskTable tasks={[task]} sections={[main]} members={[owner]} statuses={statuses} onOpenTask={vi.fn()} onCreateTask={vi.fn()} onCreateChild={vi.fn()}
    onSelectTask={vi.fn()} onEditTaskField={onEditTaskField} writable />);
  const row = screen.getByRole('button', { name: task.title }).closest('tr');
  if (!row) throw Error('Row required.');
  return { row: within(row), onEditTaskField };
}

it('opens the next cell of the row for editing when Tab moves to it from a cell of the same row', async () => {
  const user = userEvent.setup();
  const { row, onEditTaskField } = table();
  row.getByRole('button', { name: task.title }).focus();
  // Entering the row from elsewhere (focus() here, no Tab key) opens nothing.
  expect(onEditTaskField).not.toHaveBeenCalled();
  await user.tab();
  await user.tab();
  await user.tab();
  const opened = onEditTaskField.mock.calls.map(call => call[1] as string);
  // The details and actions buttons pass focus on; every field cell reached by Tab from the row opens.
  expect(opened.length).toBeGreaterThan(0);
  expect(opened).toContain('statusId');
});

it('does not open an editor for a focus move that did not come from Tab or from inside the row', async () => {
  const user = userEvent.setup();
  const { row, onEditTaskField } = table();
  const status = row.getByRole('button', { name: `Edit status for ${task.title}` });
  status.focus();
  await user.click(row.getByRole('button', { name: task.title }));
  // A click opens the title once (the click handler); focusing a cell by script or pointer never opens a second one.
  expect(onEditTaskField).toHaveBeenCalledTimes(1);
  expect(onEditTaskField).toHaveBeenCalledWith(task, 'title');
});
