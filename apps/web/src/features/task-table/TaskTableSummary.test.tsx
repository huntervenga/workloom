import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, it, vi } from 'vitest';
import { TaskTable, type TaskTableProps } from './TaskTable';
import { makeTask, statuses } from './taskTableFixtures';

function renderTable(props: Pick<TaskTableProps, 'tasks'> & Partial<TaskTableProps>) {
  return render(<TaskTable sections={[]} statuses={statuses} members={[]} onOpenTask={vi.fn()} onCreateTask={vi.fn()} onCreateChild={vi.fn()} {...props} />);
}
function summaryRow() {
  const row = screen.getByText('Loaded team budget').closest('tr');
  if (!row) throw new Error('Missing loaded team budget');
  return row;
}

it('keeps deduplicated loaded scope, shared estimates counted once and missing estimates separate from known zero', async () => {
  const user = userEvent.setup();
  const parent = makeTask({ id: 'parent', title: 'Shared parent', workPackageId: 'shared', estimateMinutes: 120 });
  const child = makeTask({ id: 'child', title: 'Shared child', parentTaskId: parent.id, workPackageId: 'shared', estimateMinutes: 120 });
  renderTable({ tasks: [parent, child, parent, makeTask({ id: 'zero', workPackageId: 'zero', estimateMinutes: 0 }), makeTask({ id: 'missing', workPackageId: 'missing', estimateMinutes: null })], partial: true });
  const row = summaryRow();
  expect(within(row).getByText('2h')).toBeVisible();
  expect(row).toHaveTextContent('Loaded: 4 tasks');
  expect(row).toHaveTextContent('Not estimated: 1 task');
  expect(row).toHaveTextContent('Shared estimates counted once.');
  expect(row.textContent).toMatch(/Loaded: 4 tasks.*Not estimated: 1 task.*Shared estimates counted once/);
  expect(row).toHaveTextContent('Budget covers loaded tasks only.');
  expect(row.closest('details')).toBeNull();
  const text = row.textContent;
  await user.click(screen.getByRole('button', { name: 'Collapse subtasks of “Shared parent”' }));
  expect(screen.queryByRole('button', { name: 'Shared child' })).not.toBeInTheDocument();
  expect(row.textContent).toBe(text);
});

it('continues to identify a complete loaded page as loaded scope', () => {
  renderTable({ tasks: [makeTask({ id: 'zero', workPackageId: 'zero', estimateMinutes: 0 })] });
  const row = summaryRow();
  expect(within(row).getByText('0m')).toBeVisible();
  expect(row).toHaveTextContent('Loaded team budget');
  expect(row).toHaveTextContent('Loaded: 1 task');
  expect(row).toHaveTextContent('Not estimated: 0 tasks');
  expect(row).not.toHaveTextContent('Budget covers loaded tasks only.');
});

it('does not turn unknown estimates into known-zero task counts', () => {
  renderTable({ tasks: [makeTask({ id: 'unknown-one', workPackageId: 'missing', estimateMinutes: null }), makeTask({ id: 'unknown-two', workPackageId: 'missing', estimateMinutes: null })] });
  const row = summaryRow();
  expect(within(row).getByText('0m')).toBeVisible();
  expect(row).toHaveTextContent('Loaded: 2 tasks');
  expect(row).toHaveTextContent('Not estimated: 2 tasks');
  expect(screen.getAllByText('Not estimated')).toHaveLength(2);
});

it('keeps conflicting estimate recovery visible and withholds an invented total', () => {
  renderTable({ tasks: [makeTask({ id: 'first', workPackageId: 'conflict', workPackageRevision: 2, estimateMinutes: 60 }), makeTask({ id: 'second', workPackageId: 'conflict', workPackageRevision: 2, estimateMinutes: 120 })], partial: true });
  const row = summaryRow();
  expect(within(row).getByText('Total unavailable')).toBeVisible();
  const recovery = within(row).getByText(/Shared estimates disagree. Refresh data to calculate the total/);
  expect(recovery).toBeVisible();
  expect(recovery.closest('details')).toBeNull();
  expect(row).toHaveTextContent('Loaded: 2 tasks');
  expect(row).toHaveTextContent('Budget covers loaded tasks only.');
  expect(within(row).queryByText('3h')).not.toBeInTheDocument();
  expect(screen.getAllByText('Refresh data', { exact: false })).toHaveLength(3);
});
