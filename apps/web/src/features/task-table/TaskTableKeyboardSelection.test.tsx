import { fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TaskTable, type TaskTableProps } from './TaskTable';
import { makeSection, makeTask, statuses } from './taskTableFixtures';

afterEach(() => { vi.restoreAllMocks(); });

const planning = makeSection({ id: 'planning', name: 'Planning', position: 0 });
const later = makeSection({ id: 'later', name: 'Later', position: 1 });
const delivery = makeSection({ id: 'delivery', name: 'Delivery', position: 2 });
const sections = [planning, later, delivery];
const alpha = makeTask({ id: 'alpha', title: 'Alpha', sectionId: planning.id, position: 0 });
const bravo = makeTask({ id: 'bravo', title: 'Bravo', sectionId: planning.id, position: 1 });
const bravoChild = makeTask({ id: 'bravo-child', title: 'Bravo child', sectionId: planning.id, parentTaskId: bravo.id, position: 0 });
const folded = makeTask({ id: 'folded', title: 'Folded', sectionId: planning.id, position: 2 });
const foldedChild = makeTask({ id: 'folded-child', title: 'Folded child', sectionId: planning.id, parentTaskId: folded.id, position: 0 });
const charlie = makeTask({ id: 'charlie', title: 'Charlie', sectionId: later.id, position: 0 });
const delta = makeTask({ id: 'delta', title: 'Delta', sectionId: delivery.id, position: 0 });
const tasks = [alpha, bravo, bravoChild, folded, foldedChild, charlie, delta];
// Folded's subtask stays collapsed; the Later group is collapsed by its header where a test needs it.
const foldedIds: ReadonlySet<string> = new Set([folded.id]);

const row = (id: string) => document.querySelector<HTMLTableRowElement>(`tr[data-task-row="${id}"]`) as HTMLTableRowElement;
const gutter = (title: string) => screen.getByRole('button', { name: `Select task: ${title}` });
const selected = () => [...document.querySelectorAll('tr[data-task-row][aria-selected="true"]')].map(item => item.getAttribute('data-task-row'));
const collapseGroupOf = (id: string) => fireEvent.click(row(id).closest('tbody')?.querySelector('button[data-task-group]') as HTMLElement);
const rect = (top: number, height: number) => ({ top, bottom: top + height, left: 0, right: 600, width: 600, height, x: 0, y: top, toJSON: () => ({}) }) as DOMRect;

function Table({ initial = [], onSelectionChange, ...props }: Partial<TaskTableProps> & { initial?: string[] }) {
  const [ids, setIds] = useState<string[]>(initial);
  return <TaskTable tasks={tasks} sections={sections} statuses={statuses} members={[]} writable
    onOpenTask={vi.fn()} onCreateTask={vi.fn()} onCreateChild={vi.fn()} collapsedTaskIds={foldedIds}
    {...props} selectedTaskIds={ids} onSelectionChange={next => { setIds(next); onSelectionChange?.(next); }} />;
}

describe('neutral gutter keyboard selection', () => {
  it('moves selection and focus over rendered saved rows across groups and subtasks, without wrapping', async () => {
    const user = userEvent.setup();
    render(<Table />);
    collapseGroupOf(charlie.id);
    expect(row(charlie.id)).toBeNull();
    expect(row(foldedChild.id)).toBeNull();
    await user.click(gutter('Alpha'));
    await user.keyboard('{ArrowUp}');
    expect(selected()).toEqual(['alpha']);
    expect(gutter('Alpha')).toHaveFocus();
    for (const [id, title] of [['bravo', 'Bravo'], ['bravo-child', 'Bravo child'], ['folded', 'Folded'], ['delta', 'Delta']] as const) {
      await user.keyboard('{ArrowDown}');
      expect(selected()).toEqual([id]);
      expect(gutter(title)).toHaveFocus();
      expect(gutter(title)).toHaveAttribute('aria-pressed', 'true');
    }
    await user.keyboard('{ArrowDown}');
    expect(selected()).toEqual(['delta']);
    expect(gutter('Delta')).toHaveFocus();
  });

  it('extends and contracts a Shift+Arrow range from the selection anchor', async () => {
    const user = userEvent.setup();
    render(<Table />);
    collapseGroupOf(charlie.id);
    await user.click(gutter('Folded'));
    await user.keyboard('{Shift>}{ArrowUp}{ArrowUp}{/Shift}');
    expect(selected()).toEqual(['bravo', 'bravo-child', 'folded']);
    expect(gutter('Bravo')).toHaveFocus();
    await user.keyboard('{Shift>}{ArrowDown}{/Shift}');
    expect(selected()).toEqual(['bravo-child', 'folded']);
    expect(gutter('Bravo child')).toHaveFocus();
    // Passing the anchor flips the range to its other side, still skipping the collapsed group.
    await user.keyboard('{Shift>}{ArrowDown}{ArrowDown}{/Shift}');
    expect(selected()).toEqual(['folded', 'delta']);
    expect(gutter('Delta')).toHaveFocus();
    await user.keyboard('{ArrowUp}');
    expect(selected()).toEqual(['folded']);
  });

  it('starts a Shift+Arrow range at the focused row when no visible anchor exists yet', async () => {
    const user = userEvent.setup();
    render(<Table initial={['bravo']} />);
    gutter('Bravo').focus();
    await user.keyboard('{Shift>}{ArrowDown}{/Shift}');
    expect(selected()).toEqual(['bravo', 'bravo-child']);
    expect(gutter('Bravo child')).toHaveFocus();
  });

  it('focuses without scrolling and reveals only within the table scroller when needed', async () => {
    const user = userEvent.setup();
    const original = Object.getOwnPropertyDescriptor(Element.prototype, 'scrollIntoView');
    const scrollIntoView = vi.fn();
    Object.defineProperty(Element.prototype, 'scrollIntoView', { configurable: true, writable: true, value: scrollIntoView });
    const scrollBy = vi.spyOn(window, 'scrollBy').mockImplementation(() => {});
    try {
      render(<Table />);
      const scroller = document.querySelector('[data-task-table-scroll]') as HTMLElement;
      Object.defineProperties(scroller, {
        scrollHeight: { configurable: true, value: 1000 }, clientHeight: { configurable: true, value: 200 },
        scrollTop: { configurable: true, writable: true, value: 0 }, scrollLeft: { configurable: true, writable: true, value: 0 },
      });
      vi.spyOn(scroller, 'getBoundingClientRect').mockReturnValue(rect(0, 200));
      vi.spyOn(scroller.querySelector('thead') as HTMLElement, 'getBoundingClientRect').mockReturnValue(rect(0, 36));
      vi.spyOn(scroller.querySelector('tfoot') as HTMLElement, 'getBoundingClientRect').mockReturnValue(rect(156, 44));
      (scroller.querySelector('thead') as HTMLElement).style.position = 'sticky';
      (scroller.querySelector('tfoot') as HTMLElement).style.position = 'sticky';
      vi.spyOn(row(alpha.id), 'getBoundingClientRect').mockReturnValue(rect(60, 40));
      vi.spyOn(row(bravo.id), 'getBoundingClientRect').mockReturnValue(rect(300, 40));
      await user.click(gutter('Alpha'));
      const focus = vi.spyOn(HTMLElement.prototype, 'focus');
      await user.keyboard('{ArrowDown}');
      expect(gutter('Bravo')).toHaveFocus();
      expect(focus).toHaveBeenCalledWith({ preventScroll: true });
      // Just enough to clear the sticky footer: 340 - (200 - 44).
      expect(scroller.scrollTop).toBe(184);
      await user.keyboard('{ArrowUp}');
      expect(gutter('Alpha')).toHaveFocus();
      expect(scroller.scrollTop).toBe(184);
      expect(scroller.scrollLeft).toBe(0);
      expect(scrollIntoView).not.toHaveBeenCalled();
      expect(scrollBy).not.toHaveBeenCalled();
    } finally {
      if (original) Object.defineProperty(Element.prototype, 'scrollIntoView', original);
      else Reflect.deleteProperty(Element.prototype, 'scrollIntoView');
    }
  });

  it('keeps the old selection, focus and limit warning when Shift+Arrow would pass 100 rows', () => {
    const many = Array.from({ length: 102 }, (_, index) => makeTask({ id: `t${index}`, title: `Task ${index}`, position: index }));
    render(<Table tasks={many} sections={[]} />);
    fireEvent.click(gutter('Task 0'), { detail: 1 });
    fireEvent.click(gutter('Task 99'), { detail: 1, shiftKey: true });
    expect(selected()).toHaveLength(100);
    gutter('Task 99').focus();
    fireEvent.keyDown(gutter('Task 99'), { key: 'ArrowDown', shiftKey: true });
    expect(selected()).toHaveLength(100);
    expect(selected()).not.toContain('t100');
    expect(gutter('Task 99')).toHaveFocus();
    expect(screen.getByRole('status')).toBeVisible();
    fireEvent.keyDown(gutter('Task 99'), { key: 'ArrowUp', shiftKey: true });
    expect(selected()).toHaveLength(99);
    expect(gutter('Task 98')).toHaveFocus();
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('opens the focused gutter row once with Enter while Space selects and a focused title keeps editing', async () => {
    const user = userEvent.setup(), opened = vi.fn(), edit = vi.fn();
    render(<Table onOpenTask={opened} onEditTaskField={edit} />);
    await user.click(gutter('Alpha'));
    await user.keyboard('{ArrowDown}{Enter}');
    expect(opened).toHaveBeenCalledExactlyOnceWith(bravo.id);
    expect(selected()).toEqual(['bravo']);
    expect(gutter('Bravo')).toHaveFocus();
    // A held Enter opens nothing more and still synthesizes no selection click.
    expect(fireEvent.keyDown(gutter('Bravo'), { key: 'Enter', repeat: true })).toBe(false);
    expect(opened).toHaveBeenCalledTimes(1);

    gutter('Delta').focus();
    await user.keyboard(' ');
    expect(selected()).toEqual(['delta']);
    expect(opened).toHaveBeenCalledTimes(1);

    screen.getByRole('button', { name: 'Alpha' }).focus();
    await user.keyboard('{Enter}');
    expect(edit).toHaveBeenCalledTimes(1);
    expect(edit.mock.calls[0]?.slice(0, 2)).toEqual([expect.objectContaining({ id: alpha.id }), 'title']);
    expect(opened).toHaveBeenCalledTimes(1);
    expect(selected()).toEqual(['delta']);
  });

  it('skips unsent drafts and pending confirmed rows, whose own gutter navigates nowhere', async () => {
    const user = userEvent.setup();
    const pending = makeTask({ id: 'pending', title: 'Pending row', sectionId: planning.id, position: 9 });
    render(<Table quickAdd={{ sectionId: planning.id, afterTaskId: alpha.id, confirmedTasks: [pending],
      render: draftRow => draftRow('draft')(column => column === 'title' ? <input aria-label="Unsent title" /> : null) }} />);
    const order = [...document.querySelectorAll('tr[data-task-row], tr[data-task-draft-row]')].map(item => item.getAttribute('data-task-row') ?? 'draft');
    expect(order.slice(0, 4)).toEqual(['alpha', 'pending', 'draft', 'bravo']);
    await user.click(gutter('Alpha'));
    await user.keyboard('{ArrowDown}');
    expect(selected()).toEqual(['bravo']);
    expect(gutter('Bravo')).toHaveFocus();
    await user.keyboard('{ArrowUp}');
    expect(selected()).toEqual(['alpha']);
    expect(gutter('Alpha')).toHaveFocus();

    gutter('Pending row').focus();
    expect(fireEvent.keyDown(gutter('Pending row'), { key: 'ArrowDown' })).toBe(true);
    expect(fireEvent.keyDown(gutter('Pending row'), { key: 'Enter' })).toBe(true);
    expect(gutter('Pending row')).toHaveFocus();
    const draft = screen.getByLabelText('Unsent title');
    await user.click(draft);
    await user.keyboard('{ArrowUp}{ArrowDown}');
    expect(draft).toHaveFocus();
    expect(selected()).toEqual(['alpha']);
  });

  it('does nothing and prevents nothing while selection is disabled', () => {
    const opened = vi.fn(), changed = vi.fn();
    render(<Table initial={['alpha']} selectionDisabled onOpenTask={opened} onSelectionChange={changed} />);
    gutter('Alpha').focus();
    for (const key of ['ArrowDown', 'ArrowUp', 'Enter']) expect(fireEvent.keyDown(gutter('Alpha'), { key })).toBe(true);
    expect(fireEvent.keyDown(gutter('Alpha'), { key: 'ArrowDown', shiftKey: true })).toBe(true);
    expect(changed).not.toHaveBeenCalled();
    expect(opened).not.toHaveBeenCalled();
    expect(selected()).toEqual(['alpha']);
    expect(gutter('Alpha')).toHaveFocus();
  });

  it('leaves editors, cell buttons, drag handles, modified or composing keys and an active drag to their owners', async () => {
    const user = userEvent.setup(), opened = vi.fn(), changed = vi.fn(), moved = vi.fn();
    render(<Table initial={['alpha']} onOpenTask={opened} onSelectionChange={changed} onEditTaskField={vi.fn()} onMoveTask={moved}
      renderTaskFieldEditor={(task, field) => task.id === bravo.id && field === 'title' ? <input aria-label="Rename Bravo" /> : null} />);
    const editor = screen.getByLabelText('Rename Bravo');
    await user.click(editor);
    await user.keyboard('{ArrowDown}{ArrowUp}{Enter}');
    expect(editor).toHaveFocus();

    const status = row(alpha.id).querySelector(`[data-task-cell="${alpha.id}:statusId"]`) as HTMLElement;
    for (const key of ['ArrowDown', 'ArrowUp', 'Enter']) expect(fireEvent.keyDown(status, { key })).toBe(true);

    // The drag handle keeps its own keyboard reorder; the selection does not follow it.
    const handle = within(row(alpha.id)).getByRole('button', { name: 'Move task: Alpha' });
    fireEvent.keyDown(handle, { key: 'ArrowDown' });
    expect(moved).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ id: alpha.id }), expect.objectContaining({ id: bravo.id }), 'after');

    const own = gutter('Alpha');
    own.focus();
    for (const init of [{ ctrlKey: true }, { metaKey: true }, { altKey: true }, { isComposing: true }, { keyCode: 229 }]) {
      expect(fireEvent.keyDown(own, { key: 'ArrowDown', ...init })).toBe(true);
      expect(fireEvent.keyDown(own, { key: 'Enter', ...init })).toBe(true);
    }
    expect(own).toHaveFocus();

    // A key something else already handled is not taken again.
    const scroller = document.querySelector('[data-task-table-scroll]') as HTMLElement;
    const claim = (event: Event) => event.preventDefault();
    scroller.addEventListener('keydown', claim, true);
    fireEvent.keyDown(own, { key: 'ArrowDown' });
    fireEvent.keyDown(own, { key: 'Enter' });
    scroller.removeEventListener('keydown', claim, true);

    await user.pointer({ keys: '[MouseLeft>]', target: handle, coords: { clientX: 1, clientY: 1 } });
    await user.pointer({ target: row(bravo.id), coords: { clientX: 100, clientY: 100 } });
    expect(screen.getByTestId('task-drag-preview')).toBeVisible();
    expect(fireEvent.keyDown(own, { key: 'ArrowDown' })).toBe(true);
    expect(fireEvent.keyDown(own, { key: 'Enter' })).toBe(true);
    fireEvent.keyDown(window, { key: 'Escape' });
    await user.pointer({ keys: '[/MouseLeft]', target: row(bravo.id), coords: { clientX: 100, clientY: 100 } });

    expect(changed).not.toHaveBeenCalled();
    expect(opened).not.toHaveBeenCalled();
    expect(moved).toHaveBeenCalledTimes(1);
    expect(selected()).toEqual(['alpha']);
  });

  it('drives onSelectTask-only owners and adds nothing without selection callbacks', () => {
    const selectTask = vi.fn(), opened = vi.fn();
    const base = { tasks, sections, statuses, members: [], onOpenTask: opened, onCreateTask: vi.fn(), onCreateChild: vi.fn() };
    const view = render(<TaskTable {...base} selectedTaskIds={['alpha']} onSelectTask={selectTask} />);
    gutter('Alpha').focus();
    fireEvent.keyDown(gutter('Alpha'), { key: 'ArrowDown' });
    expect(selectTask.mock.calls).toEqual([['alpha', false], ['bravo', true]]);
    expect(gutter('Bravo')).toHaveFocus();

    view.rerender(<TaskTable {...base} />);
    expect(screen.queryByRole('button', { name: /^Select task:/ })).toBeNull();
    expect(fireEvent.keyDown(screen.getByRole('button', { name: 'Alpha' }), { key: 'ArrowDown' })).toBe(true);
    expect(opened).not.toHaveBeenCalled();
  });
});
