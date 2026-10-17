import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, it, vi } from 'vitest';
import { TaskTable } from './TaskTable';
import { makeMember, makeSection, makeTask, statuses } from './taskTableFixtures';

const main = makeSection({ id: 'main', name: 'Launch preparation' });
const followup = makeSection({ id: 'followup', name: 'Release follow-up', position: 1 });
const owner = makeMember({ id: 'owner', userId: 'user-owner', displayName: 'Synthetic Owner' });
const titles = [
  'Prepare the launch checklist',
  'Review the mobile experience',
  'Run the weekly workflow checks',
  'Validate keyboard navigation in the task workspace before the next team review',
  'Confirm the team working agreement',
  'Collect the first team feedback',
  'Review adoption signals',
  'Write the quick-start guide',
  'Review the mobile experience after resolving the keyboard navigation findings',
] as const;
const tasks = titles.map((title, depth) => makeTask({
  id: `depth-${depth}`, title, parentTaskId: depth === 0 ? null : `depth-${depth - 1}`,
  sectionId: depth === 8 ? followup.id : main.id, position: depth,
  responsibleMembershipId: owner.id, workPackageId: 'shared-launch', estimateMinutes: 180,
}));
function handlers() {
  return { onOpenTask: vi.fn(), onCreateTask: vi.fn(), onCreateChild: vi.fn(),
    onSelectTask: vi.fn(), onEditTaskField: vi.fn() };
}

it('keeps full deep title names, loaded depth and the authorized parent while rename, details and other actions stay separate', async () => {
  const user = userEvent.setup();
  const calls = handlers();
  render(<TaskTable tasks={tasks} sections={[main, followup]} members={[owner]} statuses={statuses}
    {...calls} writable draftTaskIds={new Set(['depth-8'])}
    renderCompletionAction={task => <button type="button" aria-label={`Complete ${task.title}`}>○</button>} />);
  for (const title of titles) expect(screen.getAllByRole('button', { name: title })).toHaveLength(1);
  const title = titles[8];
  const leaf = screen.getByRole('button', { name: title });
  expect(leaf).toHaveAccessibleDescription(`Loaded hierarchy depth 8. Parent: ${titles[7]}`);
  const row = leaf.closest('tr');
  if (!row) throw Error('Leaf task row required.');
  expect(within(row).getByText('Draft', { exact: true })).toBeVisible();
  expect(within(row).getByText('Section: Release follow-up')).toBeVisible();
  // The visible name renames in place (Asana-style); the separate details action opens the task.
  leaf.focus();
  await user.keyboard('{Enter}');
  expect(calls.onEditTaskField).toHaveBeenCalledExactlyOnceWith(tasks[8], 'title');
  expect(calls.onOpenTask).not.toHaveBeenCalled();
  const details = within(row).getByRole('button', { name: `Open task “${title}”` });
  details.focus();
  await user.keyboard('{Enter}');
  expect(calls.onOpenTask).toHaveBeenCalledExactlyOnceWith('depth-8');
  expect(calls.onEditTaskField).toHaveBeenCalledTimes(1);
  await user.click(within(row).getByRole('button', { name: `Add subtask to “${title}”` }));
  expect(calls.onCreateChild).toHaveBeenCalledExactlyOnceWith(tasks[8]);
  await user.click(within(row).getByRole('checkbox', { name: `Select for graph: ${title}` }));
  expect(calls.onSelectTask).toHaveBeenCalledExactlyOnceWith('depth-8', true);
  expect(calls.onOpenTask).toHaveBeenCalledTimes(1);
  expect(screen.getByText('Loaded team budget').closest('tr')).toHaveTextContent('3h');
});

it('retains deep task badges and package totals through native descendant disclosure', async () => {
  const user = userEvent.setup();
  render(<TaskTable tasks={tasks} sections={[main, followup]} members={[]} statuses={statuses}
    {...handlers()} partial draftTaskIds={new Set(['depth-8'])} />);
  const parent = titles[7];
  const toggle = screen.getByRole('button', { name: `Collapse subtasks of “${parent}”` });
  const parentRow = toggle.closest('tr');
  if (!parentRow) throw Error('Loaded parent task row required.');
  const count = within(parentRow).getByText('Loaded: 1 subtask');
  expect(count).toHaveClass('sr-only');
  expect(count.parentElement).toHaveAttribute('title', 'Loaded: 1 subtask');
  expect(within(count.parentElement as HTMLElement).getByText('1')).toBeVisible();
  toggle.focus();
  await user.keyboard('{Enter}');
  expect(screen.queryByRole('button', { name: titles[8] })).not.toBeInTheDocument();
  const expand = screen.getByRole('button', { name: `Expand subtasks of “${parent}”` });
  expect(expand).toHaveFocus();
  await user.keyboard('{Enter}');
  const leaf = screen.getByRole('button', { name: titles[8] });
  expect(leaf).toHaveAccessibleDescription(`Loaded hierarchy depth 8. Parent: ${parent}`);
  expect(leaf.closest('tr')).toHaveTextContent('Draft');
  expect(screen.getByText('Loaded team budget').closest('tr')).toHaveTextContent('3h');
});

it('does not invent a parent description when the parent is outside the authorized loaded set', () => {
  const orphan = makeTask({ id: 'orphan', title: 'Review a filtered detail', parentTaskId: 'unloaded', sectionId: main.id });
  render(<TaskTable tasks={[orphan]} sections={[main]} members={[]} statuses={statuses} {...handlers()} partial />);
  const title = screen.getByRole('button', { name: orphan.title });
  expect(title).not.toHaveAttribute('aria-describedby');
  expect(title.closest('tr')).toHaveTextContent('parent task not loaded');
  expect(screen.queryByText(/Parent: unloaded/)).not.toBeInTheDocument();
});

it('keeps Assignee grouping flat with existing parent context instead of a false deep indent', () => {
  render(<TaskTable tasks={tasks} sections={[main, followup]} members={[owner]} statuses={statuses}
    {...handlers()} grouping="assignee" />);
  const leaf = screen.getByRole('button', { name: titles[8] });
  expect(leaf).not.toHaveAttribute('aria-describedby');
  expect(leaf.closest('tr')).toHaveTextContent(`Section: Release follow-up · Subtask of ${titles[7]}`);
  expect(screen.queryByRole('button', { name: /subtasks of/ })).not.toBeInTheDocument();
});

it('keeps every task on one fixed-height line: long names truncate with the full name kept as tooltip and accessible name', () => {
  const long = makeTask({ id: 'long', title: titles[3].repeat(3), sectionId: main.id, responsibleMembershipId: owner.id });
  render(<TaskTable tasks={[long]} sections={[main]} members={[owner]} statuses={statuses} {...handlers()} writable draftTaskIds={new Set(['long'])} />);
  const name = screen.getByRole('button', { name: long.title });
  expect(name).toHaveAttribute('title', long.title);
  expect(name.className).toContain('truncate');
  expect(name.className).not.toContain('whitespace-normal');
  const row = name.closest('tr');
  if (!row) throw Error('Task row required.');
  expect(row.className).toContain('h-10');
  for (const cell of within(row).getAllByRole('cell')) expect(cell.className).toContain('whitespace-nowrap');
  // Secondary badges share the same line instead of adding a second one.
  expect(within(row).getByText('Draft', { exact: true }).closest('[class*="basis-full"]')).toBeNull();
  expect(row.querySelector('p')).toBeNull();
});

it('keeps idle names flexible while reserving the real action width before hover or title editing', () => {
  render(<TaskTable tasks={[makeTask({ id: 'overlay', title: titles[0], sectionId: main.id })]} sections={[main]} members={[]} statuses={statuses} {...handlers()} writable />);
  const title = screen.getByRole('button', { name: titles[0] });
  expect(title.className).toContain('flex-1');
  expect(title.className).toContain('min-w-0');
  const actions = title.closest('td')?.querySelector('[data-task-row-actions]');
  expect(actions).toHaveClass('flex', 'shrink-0', 'opacity-0', 'group-focus-within:opacity-100', '[@media(hover:none)]:opacity-100');
  expect(actions).not.toHaveClass('absolute');
  expect(actions?.parentElement).toBe(title.parentElement);
  expect(title.parentElement?.className).not.toMatch(/pr-(?:16|24)/);
  expect(within(actions as HTMLElement).getByRole('button', { name: `Open task “${titles[0]}”` })).toBeInTheDocument();
  expect(within(actions as HTMLElement).getByRole('button', { name: `Add subtask to “${titles[0]}”` })).toBeInTheDocument();
});
