import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TaskTable } from './TaskTable';
import { makeSection, makeTask, statuses } from './taskTableFixtures';
import { useTableExpansionState } from './useTableExpansionState';

const uuid = (n: number) => `b0000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const scope = { actorId: uuid(1), workspaceId: uuid(2), projectId: uuid(3) };
const section = makeSection({ id: uuid(4), name: 'Engineering' });
const parent = makeTask({ id: uuid(5), title: 'Parent', sectionId: section.id });
const child = makeTask({ id: uuid(6), title: 'Child', parentTaskId: parent.id, sectionId: section.id });
const grandchild = makeTask({ id: uuid(7), title: 'Grandchild', parentTaskId: child.id, sectionId: section.id });
const tasks = [parent, child, grandchild];
function Table({ actor = scope.actorId }: { actor?: string }) {
  const state = useTableExpansionState({ ...scope, actorId: actor }, tasks.map(task => task.id));
  return <TaskTable tasks={tasks} sections={[section]} statuses={statuses} members={[]} writable={false}
    onOpenTask={vi.fn()} onCreateTask={vi.fn()} onCreateChild={vi.fn()} collapsedTaskIds={state.collapsedTaskIds} onTaskCollapsedChange={state.setTaskCollapsed}
    collapsedGroupKeys={state.collapsedGroupKeys} onGroupCollapsedChange={state.setGroupCollapsed} />;
}
beforeEach(() => { localStorage.clear(); });
afterEach(() => { localStorage.clear(); });

describe('task table expansion backed by browser preferences', () => {
  it('renders only roots initially, restores nested expansion after remount and remembers hidden children through section collapse', async () => {
    const user = userEvent.setup(), first = render(<Table />);
    expect(screen.getByRole('button', { name: 'Parent' })).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Child' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Expand subtasks of “Parent”' }));
    expect(screen.getByRole('button', { name: 'Child' })).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Grandchild' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Expand subtasks of “Child”' }));
    expect(screen.getByRole('button', { name: 'Grandchild' })).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Collapse section “Engineering”' }));
    expect(screen.queryByRole('button', { name: 'Parent' })).not.toBeInTheDocument();
    first.unmount();
    render(<Table />);
    expect(screen.getByRole('button', { name: 'Expand section “Engineering”' })).toHaveAttribute('aria-expanded', 'false');
    await user.click(screen.getByRole('button', { name: 'Expand section “Engineering”' }));
    expect(screen.getByRole('button', { name: 'Grandchild' })).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Collapse subtasks of “Parent”' }));
    expect(screen.queryByRole('button', { name: 'Child' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Expand subtasks of “Parent”' }));
    expect(screen.getByRole('button', { name: 'Grandchild' })).toBeVisible();
  });
  it('keeps another signed-in user on their own collapsed defaults', async () => {
    const user = userEvent.setup(), first = render(<Table />);
    await user.click(screen.getByRole('button', { name: 'Expand subtasks of “Parent”' }));
    first.rerender(<Table actor={uuid(20)} />);
    expect(screen.queryByRole('button', { name: 'Child' })).not.toBeInTheDocument();
    first.rerender(<Table />);
    expect(screen.getByRole('button', { name: 'Child' })).toBeVisible();
  });
});
