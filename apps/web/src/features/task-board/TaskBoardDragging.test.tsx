import { fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { makeTask, statuses } from '../task-table/taskTableFixtures';
import { TaskBoard, type TaskBoardProps } from './TaskBoard';

const todo = statuses[0]; if (!todo) throw new Error('Missing todo');
const doing = statuses.find(status => status.id !== todo.id); if (!doing) throw new Error('Missing second status');
const task = makeTask({ id: 'board-source', title: 'Board source', statusId: todo.id });
const lane = (id: string) => document.querySelector<HTMLElement>(`[data-board-status="${id}"]`);
function required<T>(value: T | null | undefined): T { if (value === null || value === undefined) throw new Error('Missing board fixture element'); return value; }
function example(overrides: Partial<TaskBoardProps> = {}) {
  const release = vi.fn(), acquire = vi.fn(() => release), move = vi.fn();
  const props: TaskBoardProps = { tasks: [task], statuses, members: [], partial: false, writable: true, onOpenTask: vi.fn(), onEditStatus: vi.fn(), renderStatusEditor: () => null,
    onMoveStatus: move, dragBlocked: false, dragContextKey: 'fixture-context', acquireDragProtection: acquire, ...overrides };
  return { ...render(<TaskBoard {...props} />), props, move, acquire, release, user: userEvent.setup() };
}
afterEach(() => { Reflect.deleteProperty(document, 'elementFromPoint'); vi.restoreAllMocks(); });

describe('status board pointer intent', () => {
  it('shows a real ghost and lane target only after threshold; releases exactly one status intent without changing supplied cards', async () => {
    const ui = example(), handle = screen.getByRole('button', { name: 'Drag task: Board source' }), destination = required(lane(doing.id));
    await ui.user.pointer({ keys: '[MouseLeft>]', target: handle, coords: { clientX: 10, clientY: 10 } });
    expect(ui.acquire).toHaveBeenCalledTimes(1);
    await ui.user.pointer({ target: destination, coords: { clientX: 12, clientY: 10 } });
    expect(screen.queryByTestId('board-drag-preview')).not.toBeInTheDocument();
    await ui.user.pointer({ target: destination, coords: { clientX: 100, clientY: 30 } });
    expect(screen.getByTestId('board-drag-preview')).toHaveTextContent(task.title);
    expect(destination).toHaveAttribute('data-board-drop', 'active'); expect(destination.querySelector('[data-board-drop-placeholder]')).not.toBeNull();
    expect(ui.move).not.toHaveBeenCalled();
    await ui.user.pointer({ keys: '[/MouseLeft]', target: destination, coords: { clientX: 100, clientY: 30 } });
    expect(ui.move).toHaveBeenCalledExactlyOnceWith(task, doing.id); expect(ui.release).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId('board-drag-preview')).not.toBeInTheDocument();
    expect(required(lane(todo.id))).toContainElement(screen.getByRole('button', { name: task.title }));
    expect(ui.props.onOpenTask).not.toHaveBeenCalled();
  });

  it.each(['escape', 'blur', 'cancel', 'unmount', 'same-status'] as const)('cancels %s with no status command and releases protection', async reason => {
    const ui = example(), handle = screen.getByRole('button', { name: 'Drag task: Board source' });
    const destination = required(lane(reason === 'same-status' ? todo.id : doing.id));
    await ui.user.pointer({ keys: '[MouseLeft>]', target: handle, coords: { clientX: 10, clientY: 10 } });
    await ui.user.pointer({ target: destination, coords: { clientX: 100, clientY: 40 } });
    if (reason === 'escape') await ui.user.keyboard('{Escape}');
    if (reason === 'blur') fireEvent(window, new Event('blur'));
    if (reason === 'cancel') { const event = new Event('pointercancel'); Object.defineProperty(event, 'pointerId', { value: 1 }); fireEvent(window, event); }
    if (reason === 'unmount') ui.unmount();
    if (reason !== 'unmount') await ui.user.pointer({ keys: '[/MouseLeft]', target: destination, coords: { clientX: 100, clientY: 40 } });
    expect(ui.move).not.toHaveBeenCalled(); expect(ui.release).toHaveBeenCalledTimes(1);
  });

  it('rehits the actual release lane and refuses stale source revisions or changed view context', async () => {
    const ui = example(); let hit = required(lane(doing.id));
    Object.defineProperty(document, 'elementFromPoint', { configurable: true, value: () => hit });
    const handle = screen.getByRole('button', { name: 'Drag task: Board source' });
    await ui.user.pointer({ keys: '[MouseLeft>]', target: handle, coords: { clientX: 10, clientY: 10 } });
    await ui.user.pointer({ target: hit, coords: { clientX: 100, clientY: 40 } });
    hit = required(lane(todo.id));
    await ui.user.pointer({ keys: '[/MouseLeft]', target: hit, coords: { clientX: 100, clientY: 40 } });
    expect(ui.move).not.toHaveBeenCalled();
    await ui.user.pointer({ keys: '[MouseLeft>]', target: handle, coords: { clientX: 10, clientY: 10 } });
    hit = required(lane(doing.id));
    await ui.user.pointer({ target: hit, coords: { clientX: 100, clientY: 40 } });
    ui.rerender(<TaskBoard {...ui.props} tasks={[{ ...task, revision: task.revision + 1 }]} dragContextKey="changed" />);
    await ui.user.pointer({ keys: '[/MouseLeft]', target: hit, coords: { clientX: 100, clientY: 40 } });
    expect(ui.move).not.toHaveBeenCalled(); expect(ui.release).toHaveBeenCalledTimes(2);
  });

  it('does not offer dragging for read-only, archived, meeting, unknown, retained draft or active editor states', () => {
    const rows = [task, { ...task, id: 'archived', title: 'Archived', archivedAt: task.createdAt }, { ...task, id: 'meeting', title: 'Meeting', meetingId: 'meeting-id' }, { ...task, id: 'unknown', title: 'Unknown', meetingId: undefined }, { ...task, id: 'draft', title: 'Draft' }, { ...task, id: 'editor', title: 'Editor' }];
    const ui = example({ tasks: rows, draftTaskIds: new Set(['draft']), renderStatusEditor: row => row.id === 'editor' ? <input aria-label="Saved status draft" /> : null });
    expect(screen.getAllByRole('button', { name: /^Drag task:/ })).toHaveLength(1);
    ui.rerender(<TaskBoard {...ui.props} tasks={rows} writable={false} />);
    expect(screen.queryByRole('button', { name: /^Drag task:/ })).not.toBeInTheDocument();
    ui.rerender(<TaskBoard {...ui.props} tasks={rows} dragBlocked />);
    expect(screen.queryByRole('button', { name: /^Drag task:/ })).not.toBeInTheDocument();
    expect(screen.getByLabelText('Saved status draft')).toBeInTheDocument();
  });

  it('opens a card from its blank surface while controls and an active editor keep their own actions', async () => {
    const ui = example(), card = required(screen.getByRole('button', { name: task.title }).closest('li'));
    await ui.user.click(card); expect(ui.props.onOpenTask).toHaveBeenCalledExactlyOnceWith(task.id);
    await ui.user.click(within(card).getByRole('button', { name: 'Change status' }));
    expect(ui.props.onEditStatus).toHaveBeenCalledExactlyOnceWith(task); expect(ui.props.onOpenTask).toHaveBeenCalledTimes(1);
  });
});
