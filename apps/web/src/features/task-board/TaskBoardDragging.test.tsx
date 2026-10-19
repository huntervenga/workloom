import { fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useLayoutEffect } from 'react';
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
function CompletionProbe({ id, mount, unmount }: { id: string; mount: () => void; unmount: () => void }) {
  useLayoutEffect(() => { mount(); return unmount; }, [mount, unmount]);
  return <button type="button" data-task-completion={id}>Complete</button>;
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
    // A pending/refetch block disables the eligible handle in place; it never makes ineligible cards draggable.
    const blocked = screen.getAllByRole('button', { name: /^Drag task:/ });
    expect(blocked).toHaveLength(1); expect(blocked[0]).toHaveAccessibleName('Drag task: Board source'); expect(blocked[0]).toBeDisabled();
    expect(screen.getByLabelText('Saved status draft')).toBeInTheDocument();
    // Eligible and ineligible cards reserve the same handle chrome, so titles wrap alike.
    expect(new Set([...document.querySelectorAll('[data-board-card] [data-board-card-body]')].map(body => body.className)).size).toBe(1);
  });

  it('keeps the same card chrome and a mounted, visibly disabled handle across dragBlocked false/true/false', () => {
    const ui = example({ onMoveCard: vi.fn() });
    const handle = screen.getByRole('button', { name: 'Drag task: Board source' });
    const chrome = () => {
      const current = screen.getByRole('button', { name: 'Drag task: Board source' }), card = required(current.closest<HTMLElement>('[data-board-card]'));
      return { same: current === handle, first: card.firstElementChild === current, card: card.className, handle: current.className,
        body: required(card.querySelector('[data-board-card-body]')).className, title: required(screen.getByRole('button', { name: task.title }).parentElement).className };
    };
    const idle = chrome();
    expect(idle).toMatchObject({ same: true, first: true }); expect(handle).toBeEnabled();
    ui.rerender(<TaskBoard {...ui.props} dragBlocked />);
    expect(chrome()).toEqual(idle); expect(handle).toBeDisabled();
    fireEvent.pointerDown(handle, { button: 0, isPrimary: true, pointerId: 1, clientX: 10, clientY: 10 });
    expect(ui.acquire).not.toHaveBeenCalled(); expect(screen.queryByTestId('board-drag-preview')).not.toBeInTheDocument();
    ui.rerender(<TaskBoard {...ui.props} dragBlocked={false} />);
    expect(chrome()).toEqual(idle); expect(handle).toBeEnabled();
  });

  it('draws the lane-end landing marker as an overlay without adding lane flow children', async () => {
    const ui = example({ onMoveCard: vi.fn() }), destination = required(lane(doing.id));
    const flow = (element: Element) => [...element.children].map(child => `${child.tagName}.${child.className}`);
    const body = required(destination.querySelector('[data-board-lane-body]'));
    const laneFlow = flow(destination), bodyFlow = flow(body);
    await ui.user.pointer({ keys: '[MouseLeft>]', target: screen.getByRole('button', { name: 'Drag task: Board source' }), coords: { clientX: 10, clientY: 10 } });
    await ui.user.pointer({ target: destination, coords: { clientX: 100, clientY: 100 } });
    const marker = required(destination.querySelector('[data-board-drop-placeholder]'));
    const overlay = required(marker.closest<HTMLElement>('[data-board-lane-end]'));
    expect(flow(destination)).toEqual(laneFlow);
    expect(overlay.parentElement).toBe(body); expect(body).toHaveClass('relative');
    expect(overlay).toHaveClass('absolute', 'pointer-events-none');
    expect(flow(body).filter(entry => !entry.includes('absolute'))).toEqual(bodyFlow);
    await ui.user.pointer({ keys: '[/MouseLeft]', target: destination, coords: { clientX: 100, clientY: 100 } });
    expect(destination.querySelector('[data-board-lane-end]')).toBeNull(); expect(flow(body)).toEqual(bodyFlow);
  });

  it('opens a card from its blank surface while controls and an active editor keep their own actions', async () => {
    const ui = example(), card = required(screen.getByRole('button', { name: task.title }).closest('li'));
    await ui.user.click(card); expect(ui.props.onOpenTask).toHaveBeenCalledExactlyOnceWith(task.id);
    await ui.user.click(within(card).getByRole('button', { name: 'Change status' }));
    expect(ui.props.onEditStatus).toHaveBeenCalledExactlyOnceWith(task); expect(ui.props.onOpenTask).toHaveBeenCalledTimes(1);
  });
  it.each([
    { name: 'before the first card', same: false, y: 120, anchor: 'first' },
    { name: 'between cards in another lane', same: false, y: 200, anchor: 'second' },
    { name: 'between cards in the same lane', same: true, y: 200, anchor: 'second' },
    { name: 'at the full lane end', same: false, y: 320, anchor: null },
  ])('emits one atomic status/order intent $name and leaves supplied card order unchanged', async ({ same, y, anchor }) => {
    const statusId = same ? todo.id : doing.id, ordered = vi.fn();
    const first = makeTask({ id: 'first', title: 'First anchor', statusId, position: 10 });
    const second = makeTask({ id: 'second', title: 'Second anchor', statusId, position: 20 });
    const ui = example({ tasks: [task, first, second], onMoveCard: ordered });
    const destination = required(lane(statusId));
    for (const [row, top] of [[first, 100], [second, 220]] as const) {
      vi.spyOn(required(document.querySelector<HTMLElement>(`[data-board-card="${row.id}"]`)), 'getBoundingClientRect').mockReturnValue(new DOMRect(20, top, 274, 80));
    }
    await ui.user.pointer({ keys: '[MouseLeft>]', target: screen.getByRole('button', { name: 'Drag task: Board source' }), coords: { clientX: 10, clientY: 10 } });
    await ui.user.pointer({ target: destination, coords: { clientX: 100, clientY: y } });
    const line = required(destination.querySelector('[data-board-drop-placeholder]'));
    if (anchor !== null) expect(line.closest('[data-board-card]')).toHaveAttribute('data-board-card', anchor);
    else expect(line.closest('[data-board-card]')).toBeNull();
    expect(ordered).not.toHaveBeenCalled();
    expect([...destination.querySelectorAll('[data-board-card]')].map(element => element.getAttribute('data-board-card'))).toEqual(same ? [task.id, first.id, second.id] : [first.id, second.id]);
    await ui.user.pointer({ keys: '[/MouseLeft]', target: destination, coords: { clientX: 100, clientY: y } });
    expect(ordered).toHaveBeenCalledExactlyOnceWith(task, statusId, anchor === 'first' ? first : anchor === 'second' ? second : null, anchor === null ? 'after' : 'before');
    expect(ui.move).not.toHaveBeenCalled(); expect(ui.release).toHaveBeenCalledTimes(1);
    expect(required(lane(todo.id))).toContainElement(screen.getByRole('button', { name: task.title }));
  });

  it('moves to an empty lane and carries full card metadata in an inert floating preview', async () => {
    const ordered = vi.fn(), source = { ...task, dueDate: '2027-03-20', responsibleMembershipId: null };
    const mount = vi.fn(), unmount = vi.fn();
    const ui = example({ tasks: [source], onMoveCard: ordered, renderCompletionAction: row => <CompletionProbe id={row.id} mount={mount} unmount={unmount} /> });
    const handle = screen.getByRole('button', { name: 'Drag task: Board source' });
    const sourceCard = required(handle.closest('[data-board-card]'));
    expect(sourceCard.firstElementChild).toBe(handle);
    const destination = required(lane(doing.id));
    await ui.user.pointer({ keys: '[TouchA>]', target: handle, coords: { clientX: 10, clientY: 10 } });
    await ui.user.pointer({ pointerName: 'TouchA', target: destination, coords: { clientX: 100, clientY: 100 } });
    const ghost = screen.getByTestId('board-drag-preview');
    expect(ghost).toHaveAttribute('inert'); expect(ghost).toHaveAttribute('aria-hidden', 'true');
    expect(ghost).toHaveTextContent(source.title); expect(ghost).toHaveTextContent('Unassigned'); expect(ghost).toHaveTextContent('Due');
    expect(screen.getAllByRole('button', { name: source.title })).toHaveLength(1);
    // Same body chrome, handle shape and status-control shape as the source, without live control hooks.
    expect(required(ghost.querySelector('[data-board-card-body]')).className).toBe(required(sourceCard.querySelector('[data-board-card-body]')).className);
    expect(ghost.querySelector('li > span[aria-hidden="true"]')).not.toBeNull(); expect(ghost).toHaveTextContent('Change status');
    expect(ghost.querySelector('[data-task-cell]')).toBeNull(); expect(ghost.querySelector('[data-task-completion]')).toBeNull(); expect(ghost.querySelector('[data-board-card]')).toBeNull();
    expect(document.querySelectorAll(`[data-task-completion="${source.id}"]`)).toHaveLength(1);
    expect(mount).toHaveBeenCalledTimes(1); expect(unmount).not.toHaveBeenCalled();
    await ui.user.pointer({ keys: '[/TouchA]', target: destination, coords: { clientX: 100, clientY: 100 } });
    expect(ordered).toHaveBeenCalledExactlyOnceWith(source, doing.id, null, 'after');
  });

  it('rehits the insertion gap at release and cancels when the anchor changes under a drag', async () => {
    const ordered = vi.fn(), first = makeTask({ id: 'first', statusId: doing.id }), second = makeTask({ id: 'second', statusId: doing.id });
    const ui = example({ tasks: [task, first, second], onMoveCard: ordered });
    const destination = required(lane(doing.id));
    for (const [row, top] of [[first, 100], [second, 220]] as const) vi.spyOn(required(document.querySelector<HTMLElement>(`[data-board-card="${row.id}"]`)), 'getBoundingClientRect').mockReturnValue(new DOMRect(20, top, 274, 80));
    const handle = screen.getByRole('button', { name: 'Drag task: Board source' });
    await ui.user.pointer({ keys: '[MouseLeft>]', target: handle, coords: { clientX: 10, clientY: 10 } });
    await ui.user.pointer({ target: destination, coords: { clientX: 100, clientY: 120 } });
    await ui.user.pointer({ keys: '[/MouseLeft]', target: destination, coords: { clientX: 100, clientY: 200 } });
    expect(ordered).toHaveBeenCalledExactlyOnceWith(task, doing.id, second, 'before');
    ordered.mockClear();
    await ui.user.pointer({ keys: '[MouseLeft>]', target: handle, coords: { clientX: 10, clientY: 10 } });
    await ui.user.pointer({ target: destination, coords: { clientX: 100, clientY: 200 } });
    ui.rerender(<TaskBoard {...ui.props} tasks={[task, first, { ...second, revision: second.revision + 1 }]} />);
    await ui.user.pointer({ keys: '[/MouseLeft]', target: destination, coords: { clientX: 100, clientY: 200 } });
    expect(ordered).not.toHaveBeenCalled(); expect(ui.release).toHaveBeenCalledTimes(2);
  });

});
