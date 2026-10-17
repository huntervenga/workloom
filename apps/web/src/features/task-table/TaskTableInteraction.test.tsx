import { act, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TaskTable } from './TaskTable';
import { captureDraftPlacement } from './draftPlacement';
import { buildTableGroups } from './taskGrouping';
import { makeMember, makeTask, statuses } from './taskTableFixtures';

afterEach(() => { vi.restoreAllMocks(); for (const key of ['elementFromPoint', 'scrollingElement', 'visibilityState']) Reflect.deleteProperty(document, key); });

const anna = makeMember({ id: 'anna', userId: 'user-anna', displayName: 'Anna' });
const boris = makeMember({ id: 'boris', userId: 'user-boris', displayName: 'Boris' });
const a = makeTask({ id: 'a', title: 'Alpha', position: 0, responsibleMembershipId: anna.id });
const b = makeTask({ id: 'b', title: 'Bravo', position: 1, responsibleMembershipId: anna.id });
const c = makeTask({ id: 'c', title: 'Charlie', position: 2, responsibleMembershipId: anna.id });
const d = makeTask({ id: 'd', title: 'Delta', position: 3, responsibleMembershipId: boris.id });
const row = (id: string) => document.querySelector<HTMLTableRowElement>(`tr[data-task-row="${id}"]`) as HTMLTableRowElement;
const gutter = (title: string) => screen.getByRole('button', { name: `Select task: ${title}` });

function Example() {
  const [selected, setSelected] = useState<readonly string[]>([]);
  return <TaskTable tasks={[a, b, c]} sections={[]} statuses={statuses} members={[anna, boris]} writable
    onOpenTask={vi.fn()} onCreateTask={vi.fn()} onCreateChild={vi.fn()} onEditTaskField={vi.fn()}
    selectedTaskIds={selected} onSelectionChange={setSelected} />;
}

describe('normal row interaction', () => {
  it('selects from the blank gutter, ranges in visible order and toggles without a selection checkbox', async () => {
    const user = userEvent.setup(); render(<Example />);
    expect(screen.queryByRole('checkbox', { name: /Select for graph/ })).not.toBeInTheDocument();
    await user.click(gutter('Alpha'));
    expect(gutter('Alpha')).toHaveAttribute('aria-pressed', 'true');
    await user.keyboard('{Shift>}'); await user.click(gutter('Charlie')); await user.keyboard('{/Shift}');
    expect(['Alpha', 'Bravo', 'Charlie'].map(title => gutter(title).getAttribute('aria-pressed'))).toEqual(['true', 'true', 'true']);
    await user.keyboard('{Control>}'); await user.click(gutter('Bravo')); await user.keyboard('{/Control}');
    expect(gutter('Bravo')).toHaveAttribute('aria-pressed', 'false');
    expect(gutter('Alpha')).toHaveAttribute('aria-pressed', 'true');
    await user.keyboard('{Meta>}'); await user.click(gutter('Charlie')); await user.keyboard('{/Meta}');
    expect(gutter('Charlie')).toHaveAttribute('aria-pressed', 'false');
    await user.click(screen.getByRole('button', { name: 'Bravo' }));
    expect(gutter('Alpha')).toHaveAttribute('aria-pressed', 'true');
    expect(gutter('Bravo')).toHaveAttribute('aria-pressed', 'false');
  });

  it('shows a floating task card at the pointer and drops into the explicit assignee group', async () => {
    const user = userEvent.setup();
    const moved = vi.fn();
    render(<TaskTable tasks={[a, d]} sections={[]} statuses={statuses} members={[anna, boris]} writable grouping="assignee"
      onOpenTask={vi.fn()} onCreateTask={vi.fn()} onCreateChild={vi.fn()} onMoveTask={moved} />);
    const handle = within(row(a.id)).getByRole('button', { name: 'Move task: Alpha' });
    await user.pointer({ keys: '[MouseLeft>]', target: handle, coords: { clientX: 10, clientY: 20 } });
    await user.pointer({ target: row(d.id), coords: { clientX: 110, clientY: 120 } });
    const preview = screen.getByTestId('task-drag-preview');
    expect(preview).toBeVisible(); expect(preview).toHaveTextContent('Alpha');
    expect(preview).toHaveStyle({ position: 'fixed', left: '122px', top: '132px', pointerEvents: 'none' });
    expect(row(d.id)).toHaveAttribute('data-task-drop', 'after');
    // A row-only shadow is painted under sticky cells' opaque backgrounds.
    for (const cell of within(row(d.id)).getAllByRole('cell')) expect(cell.style.boxShadow).toContain('var(--color-accent)');
    await user.pointer({ keys: '[/MouseLeft]', target: row(d.id), coords: { clientX: 110, clientY: 120 } });
    expect(moved).toHaveBeenCalledExactlyOnceWith(a, d, 'after', { responsibleMembershipId: boris.id });
    expect(screen.queryByTestId('task-drag-preview')).not.toBeInTheDocument();
  });

  it('cancels the visible drag with Escape without sending a move', async () => {
    const user = userEvent.setup();
    const moved = vi.fn();
    render(<TaskTable tasks={[a, b]} sections={[]} statuses={statuses} members={[anna]} writable
      onOpenTask={vi.fn()} onCreateTask={vi.fn()} onCreateChild={vi.fn()} onMoveTask={moved} />);
    await user.pointer({ keys: '[MouseLeft>]', target: within(row(a.id)).getByRole('button', { name: 'Move task: Alpha' }), coords: { clientX: 1, clientY: 1 } });
    await user.pointer({ target: row(b.id), coords: { clientX: 100, clientY: 100 } });
    expect(screen.getByTestId('task-drag-preview')).toHaveTextContent('Alpha');
    fireEvent.keyDown(window, { key: 'Escape' });
    await user.pointer({ keys: '[/MouseLeft]', target: row(b.id), coords: { clientX: 100, clientY: 100 } });
    expect(moved).not.toHaveBeenCalled();
    expect(screen.queryByTestId('task-drag-preview')).not.toBeInTheDocument();
  });
  it('drops a child across parent anchors in flat Assignee mode without changing its lineage locally', async () => {
    const user = userEvent.setup(), moved = vi.fn();
    const child = { ...a, parentTaskId: 'parent-a' }, other = { ...d, parentTaskId: 'parent-b' };
    render(<TaskTable tasks={[child, other]} sections={[]} statuses={statuses} members={[anna, boris]} writable grouping="assignee"
      onOpenTask={vi.fn()} onCreateTask={vi.fn()} onCreateChild={vi.fn()} onMoveTask={moved} />);
    await user.pointer({ keys: '[MouseLeft>]', target: within(row(a.id)).getByRole('button', { name: 'Move task: Alpha' }), coords: { clientX: 1, clientY: 1 } });
    await user.pointer({ target: row(d.id), coords: { clientX: 100, clientY: 100 } });
    await user.pointer({ keys: '[/MouseLeft]', target: row(d.id), coords: { clientX: 100, clientY: 100 } });
    expect(moved).toHaveBeenCalledExactlyOnceWith(child, other, 'after', { responsibleMembershipId: boris.id });
    expect(child.parentTaskId).toBe('parent-a'); expect(child.workPackageId).toBe(a.workPackageId);
  });

  it('targets an empty person group and unassigned group with explicit null anchors', async () => {
    const user = userEvent.setup(), moved = vi.fn();
    render(<TaskTable tasks={[a]} sections={[]} statuses={statuses} members={[anna, boris]} writable grouping="assignee"
      onOpenTask={vi.fn()} onCreateTask={vi.fn()} onCreateChild={vi.fn()} onMoveTask={moved} />);
    for (const membershipId of [boris.id, '']) {
      const target = document.querySelector(`[data-task-group-drop="${membershipId}"]`) as HTMLElement;
      expect(target).toBeVisible();
      await user.pointer({ keys: '[MouseLeft>]', target: within(row(a.id)).getByRole('button', { name: 'Move task: Alpha' }), coords: { clientX: 1, clientY: 1 } });
      await user.pointer({ target, coords: { clientX: 100, clientY: 100 } });
      expect(target).toHaveAttribute('data-task-drop', 'after');
      expect(target).toHaveClass('shadow-[inset_0_-2px_0_var(--color-accent)]');
      expect(target.querySelector('td')?.style.boxShadow).toContain('var(--color-accent)');
      expect(moved).toHaveBeenCalledTimes(membershipId === boris.id ? 0 : 1);
      await user.pointer({ keys: '[/MouseLeft]', target, coords: { clientX: 100, clientY: 100 } });
      expect(moved).toHaveBeenLastCalledWith(a, null, 'after', { responsibleMembershipId: membershipId || null });
    }
  });

  it('refuses a stale drop after grouping/sort context changes and preserves Due sort without handles', async () => {
    const user = userEvent.setup(), moved = vi.fn();
    const props = { tasks: [a, d], sections: [], statuses, members: [anna, boris], writable: true, grouping: 'assignee' as const, onOpenTask: vi.fn(), onCreateTask: vi.fn(), onCreateChild: vi.fn(), onMoveTask: moved };
    const view = render(<TaskTable {...props} dragScope="old" />);
    await user.pointer({ keys: '[MouseLeft>]', target: within(row(a.id)).getByRole('button', { name: 'Move task: Alpha' }), coords: { clientX: 1, clientY: 1 } });
    await user.pointer({ target: row(d.id), coords: { clientX: 100, clientY: 100 } });
    view.rerender(<TaskTable {...props} dragScope="new" sortMode="due_asc" />);
    await user.pointer({ keys: '[/MouseLeft]', target: row(d.id), coords: { clientX: 100, clientY: 100 } });
    expect(moved).not.toHaveBeenCalled(); expect(screen.queryByRole('button', { name: 'Move task: Alpha' })).not.toBeInTheDocument();
  });

  it('displays date-only ranges and start-only dates without widening the normal cell', () => {
    render(<TaskTable tasks={[{ ...a, startDate: '2027-01-02', dueDate: '2027-01-04' }, { ...b, startDate: '2027-02-01' }]} sections={[]} statuses={statuses} members={[anna]} writable
      today="2027-01-01" onOpenTask={vi.fn()} onCreateTask={vi.fn()} onCreateChild={vi.fn()} />);
    expect(within(row(a.id)).getByLabelText('Start date: January 2, 2027; due date: January 4, 2027')).toHaveTextContent('Jan 2 – Jan 4');
    expect(within(row(b.id)).getByLabelText('From February 1, 2027')).toHaveTextContent('From Feb 1');
  });

  it('keeps scrolling a held pointer, recomputes the insertion target, and cancels the frame on Escape', async () => {
    const user = userEvent.setup(), moved = vi.fn();
    let callback: FrameRequestCallback | null = null;
    const request = vi.spyOn(window, 'requestAnimationFrame').mockImplementation(next => { callback = next; return 42; });
    const cancel = vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => { callback = null; });
    const page = document.createElement('div'); Object.defineProperties(page, { scrollHeight: { value: 3000 }, scrollTop: { value: 0, writable: true } });
    Object.defineProperty(document, 'scrollingElement', { configurable: true, get: () => page });
    const scroll = vi.spyOn(window, 'scrollBy').mockImplementation((_x, y) => { page.scrollTop += Number(y); });
    render(<TaskTable tasks={[a, d]} sections={[]} statuses={statuses} members={[anna, boris]} writable grouping="assignee"
      onOpenTask={vi.fn()} onCreateTask={vi.fn()} onCreateChild={vi.fn()} onMoveTask={moved} />);
    Object.defineProperty(document, 'elementFromPoint', { configurable: true, value: () => page.scrollTop > 0 ? row(d.id) : row(a.id) });
    await user.pointer({ keys: '[MouseLeft>]', target: within(row(a.id)).getByRole('button', { name: 'Move task: Alpha' }), coords: { clientX: 1, clientY: 1 } });
    await user.pointer({ target: row(a.id), coords: { clientX: 100, clientY: window.innerHeight - 1 } });
    act(() => { const next = callback as FrameRequestCallback | null; next?.(16); });
    expect(scroll).toHaveBeenCalled(); expect(page.scrollTop).toBe(18); expect(row(d.id)).toHaveAttribute('data-task-drop', 'after');
    expect(screen.getByTestId('task-drag-preview')).toBeVisible(); expect(moved).not.toHaveBeenCalled();
    fireEvent.keyDown(window, { key: 'Escape' }); expect(cancel).toHaveBeenCalledWith(42); expect(callback).toBeNull();
    await user.pointer({ keys: '[/MouseLeft]', target: row(d.id) }); expect(moved).not.toHaveBeenCalled();
    request.mockRestore(); cancel.mockRestore(); scroll.mockRestore(); Reflect.deleteProperty(document, 'scrollingElement'); Reflect.deleteProperty(document, 'elementFromPoint');
  });

  it.each(['blur', 'hidden'] as const)('cancels a held drag on %s so a later pointer-up cannot commit', async reason => {
    const user = userEvent.setup(), moved = vi.fn();
    render(<TaskTable tasks={[a, d]} sections={[]} statuses={statuses} members={[anna, boris]} writable grouping="assignee"
      onOpenTask={vi.fn()} onCreateTask={vi.fn()} onCreateChild={vi.fn()} onMoveTask={moved} />);
    await user.pointer({ keys: '[MouseLeft>]', target: within(row(a.id)).getByRole('button', { name: 'Move task: Alpha' }), coords: { clientX: 1, clientY: 1 } });
    await user.pointer({ target: row(d.id), coords: { clientX: 100, clientY: 100 } });
    expect(screen.getByTestId('task-drag-preview')).toBeVisible();
    if (reason === 'blur') fireEvent(window, new Event('blur'));
    else { Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' }); fireEvent(document, new Event('visibilitychange')); }
    expect(screen.queryByTestId('task-drag-preview')).not.toBeInTheDocument();
    await user.pointer({ keys: '[/MouseLeft]', target: row(d.id) }); expect(moved).not.toHaveBeenCalled();
    Reflect.deleteProperty(document, 'visibilityState');
  });

  it('shows a group-end line on an assignee header before committing a null-anchor drop', async () => {
    const user = userEvent.setup(), moved = vi.fn();
    render(<TaskTable tasks={[a, d]} sections={[]} statuses={statuses} members={[anna, boris]} writable grouping="assignee"
      onOpenTask={vi.fn()} onCreateTask={vi.fn()} onCreateChild={vi.fn()} onMoveTask={moved} />);
    const header = row(d.id).closest('tbody')?.querySelector('tr') as HTMLElement;
    await user.pointer({ keys: '[MouseLeft>]', target: within(row(a.id)).getByRole('button', { name: 'Move task: Alpha' }), coords: { clientX: 1, clientY: 1 } });
    await user.pointer({ target: header, coords: { clientX: 100, clientY: 100 } });
    expect(header).toHaveAttribute('data-task-drop', 'after'); expect(header.querySelector('th')?.style.boxShadow).toContain('var(--color-accent)'); expect(moved).not.toHaveBeenCalled();
    await user.pointer({ keys: '[/MouseLeft]', target: header, coords: { clientX: 100, clientY: 100 } });
    expect(moved).toHaveBeenCalledExactlyOnceWith(a, null, 'after', { responsibleMembershipId: boris.id });
  });

  it('rehits a stationary pointer after ordinary scrolling and commits the visible Section target', async () => {
    const user = userEvent.setup(), moved = vi.fn();
    render(<TaskTable tasks={[a, b, c]} sections={[]} statuses={statuses} members={[anna]} writable
      onOpenTask={vi.fn()} onCreateTask={vi.fn()} onCreateChild={vi.fn()} onMoveTask={moved} />);
    let hit = row(b.id);
    Object.defineProperty(document, 'elementFromPoint', { configurable: true, value: () => hit });
    await user.pointer({ keys: '[MouseLeft>]', target: within(row(a.id)).getByRole('button', { name: 'Move task: Alpha' }), coords: { clientX: 1, clientY: 1 } });
    await user.pointer({ target: row(b.id), coords: { clientX: 100, clientY: 100 } });
    expect(row(b.id)).toHaveAttribute('data-task-drop', 'after');
    hit = row(c.id); fireEvent.scroll(window);
    expect(row(c.id)).toHaveAttribute('data-task-drop', 'after'); expect(row(b.id)).not.toHaveAttribute('data-task-drop');
    await user.pointer({ keys: '[/MouseLeft]', target: row(c.id), coords: { clientX: 100, clientY: 100 } });
    expect(moved).toHaveBeenCalledExactlyOnceWith(a, c, 'after');
    Reflect.deleteProperty(document, 'elementFromPoint');
  });

  it('ignores another pointer lifting while the original drag is held', async () => {
    const user = userEvent.setup(), moved = vi.fn();
    render(<TaskTable tasks={[a, d]} sections={[]} statuses={statuses} members={[anna, boris]} writable grouping="assignee"
      onOpenTask={vi.fn()} onCreateTask={vi.fn()} onCreateChild={vi.fn()} onMoveTask={moved} />);
    await user.pointer({ keys: '[MouseLeft>]', target: within(row(a.id)).getByRole('button', { name: 'Move task: Alpha' }), coords: { clientX: 1, clientY: 1 } });
    await user.pointer({ target: row(d.id), coords: { clientX: 100, clientY: 100 } });
    const foreign = new Event('pointerup', { bubbles: true });
    Object.defineProperties(foreign, { pointerId: { value: 999 }, clientX: { value: 100 }, clientY: { value: 100 } });
    fireEvent(window, foreign); expect(moved).not.toHaveBeenCalled(); expect(screen.getByTestId('task-drag-preview')).toBeVisible();
    await user.pointer({ keys: '[/MouseLeft]', target: row(d.id), coords: { clientX: 100, clientY: 100 } });
    expect(moved).toHaveBeenCalledTimes(1);
  });

  it('does not treat an unsent full-row draft as a committed assignee group-end position', async () => {
    const user = userEvent.setup(), moved = vi.fn();
    const group = buildTableGroups([a, d], [], [anna, boris], 'assignee', 'en').find(item => item.kind === 'assignee' && item.membershipId === boris.id);
    if (!group) throw new Error('Expected target person group');
    render(<TaskTable tasks={[a, d]} sections={[]} statuses={statuses} members={[anna, boris]} writable grouping="assignee"
      quickAdd={{ sectionId: null, afterTaskId: d.id, placement: captureDraftPlacement(group, d.id) ?? undefined, render: draftRow => draftRow('draft')(column => column === 'title' ? <input aria-label="Unsent draft title" /> : null) }}
      onOpenTask={vi.fn()} onCreateTask={vi.fn()} onCreateChild={vi.fn()} onMoveTask={moved} />);
    const draft = screen.getByLabelText('Unsent draft title');
    await user.pointer({ keys: '[MouseLeft>]', target: within(row(a.id)).getByRole('button', { name: 'Move task: Alpha' }), coords: { clientX: 1, clientY: 1 } });
    await user.pointer({ target: draft, coords: { clientX: 100, clientY: 100 } });
    await user.pointer({ keys: '[/MouseLeft]', target: draft, coords: { clientX: 100, clientY: 100 } });
    expect(moved).not.toHaveBeenCalled();
  });

  it('cancels a release outside the viewport instead of falling back to the former hovered row', async () => {
    const user = userEvent.setup(), moved = vi.fn();
    render(<TaskTable tasks={[a, b]} sections={[]} statuses={statuses} members={[anna]} writable
      onOpenTask={vi.fn()} onCreateTask={vi.fn()} onCreateChild={vi.fn()} onMoveTask={moved} />);
    let hit: Element | null = row(b.id);
    Object.defineProperty(document, 'elementFromPoint', { configurable: true, value: () => hit });
    await user.pointer({ keys: '[MouseLeft>]', target: within(row(a.id)).getByRole('button', { name: 'Move task: Alpha' }), coords: { clientX: 1, clientY: 1 } });
    await user.pointer({ target: row(b.id), coords: { clientX: 100, clientY: 100 } });
    hit = null;
    await user.pointer({ keys: '[/MouseLeft]', target: document.body, coords: { clientX: -5, clientY: -5 } });
    expect(moved).not.toHaveBeenCalled(); expect(screen.queryByTestId('task-drag-preview')).not.toBeInTheDocument();
  });

});
