import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TaskTable, type TaskTableProps } from './TaskTable';
import { makeSection, makeTask, statuses } from './taskTableFixtures';

afterEach(() => { vi.restoreAllMocks(); });

const planning = makeSection({ id: 'planning', name: 'Planning', position: 0 });
const later = makeSection({ id: 'later', name: 'Later', position: 1 });
const sections = [planning, later];
const alpha = makeTask({ id: 'alpha', title: 'Alpha', sectionId: planning.id, position: 0 });
const bravo = makeTask({ id: 'bravo', title: 'Bravo', sectionId: planning.id, position: 1 });
const bravoChild = makeTask({ id: 'bravo-child', title: 'Bravo child', sectionId: planning.id, parentTaskId: bravo.id, position: 0 });
const folded = makeTask({ id: 'folded', title: 'Folded', sectionId: planning.id, position: 2 });
const foldedChild = makeTask({ id: 'folded-child', title: 'Folded child', sectionId: planning.id, parentTaskId: folded.id, position: 0 });
const charlie = makeTask({ id: 'charlie', title: 'Charlie', sectionId: later.id, position: 0 });
const tasks = [alpha, bravo, bravoChild, folded, foldedChild, charlie];
// Folded's subtask stays collapsed: a sweep over Folded never reaches it.
const foldedIds: ReadonlySet<string> = new Set([folded.id]);

const row = (id: string) => document.querySelector<HTMLTableRowElement>(`tr[data-task-row="${id}"]`) as HTMLTableRowElement;
const gutter = (title: string) => screen.getByRole('button', { name: `Select task: ${title}` });
const selected = () => [...document.querySelectorAll('tr[data-task-row][aria-selected="true"]')].map(item => item.getAttribute('data-task-row'));
const sweeping = () => document.querySelector('[data-task-table-scroll]')?.hasAttribute('data-task-range-select') ?? false;

function Table({ initial = [], onSelectionChange, ...props }: Partial<TaskTableProps> & { initial?: string[] }) {
  const [ids, setIds] = useState<string[]>(initial);
  return <TaskTable tasks={tasks} sections={sections} statuses={statuses} members={[]} writable
    onOpenTask={vi.fn()} onCreateTask={vi.fn()} onCreateChild={vi.fn()} collapsedTaskIds={foldedIds}
    {...props} selectedTaskIds={ids} onSelectionChange={next => { setIds(next); onSelectionChange?.(next); }} />;
}

describe('pointer sweep over the selection gutters', () => {
  it('selects the visible saved rows between the pressed gutter and the pointer, live, and stops on release', async () => {
    const user = userEvent.setup();
    const changes = vi.fn();
    render(<Table onSelectionChange={changes} />);
    await user.pointer({ keys: '[MouseLeft>]', target: gutter('Alpha'), coords: { clientX: 10, clientY: 10 } });
    expect(sweeping()).toBe(false);
    await user.pointer({ target: row(charlie.id), coords: { clientX: 10, clientY: 200 } });
    expect(sweeping()).toBe(true);
    expect(selected()).toEqual(['alpha', 'bravo', 'bravo-child', 'folded', 'charlie']);
    // Sweeping back shrinks the range: the rows passed earlier are not kept.
    await user.pointer({ target: row(bravoChild.id), coords: { clientX: 10, clientY: 100 } });
    expect(selected()).toEqual(['alpha', 'bravo', 'bravo-child']);
    await user.pointer({ keys: '[/MouseLeft]', target: row(bravoChild.id), coords: { clientX: 10, clientY: 100 } });
    expect(selected()).toEqual(['alpha', 'bravo', 'bravo-child']);
    expect(sweeping()).toBe(false);
    expect(changes).toHaveBeenCalledTimes(2);
    // The sweep set the anchor at the pressed row: Shift+click extends from Alpha.
    await user.keyboard('{Shift>}');
    await user.click(gutter('Folded'));
    await user.keyboard('{/Shift}');
    expect(selected()).toEqual(['alpha', 'bravo', 'bravo-child', 'folded']);
  });

  it('keeps a press that stays inside its own row as an ordinary click', async () => {
    const user = userEvent.setup();
    const changes = vi.fn();
    render(<Table initial={['charlie']} onSelectionChange={changes} />);
    await user.pointer({ keys: '[MouseLeft>]', target: gutter('Alpha'), coords: { clientX: 10, clientY: 10 } });
    await user.pointer({ target: row(alpha.id), coords: { clientX: 30, clientY: 14 } });
    expect(selected()).toEqual(['charlie']);
    expect(sweeping()).toBe(false);
    await user.pointer({ keys: '[/MouseLeft]', target: gutter('Alpha'), coords: { clientX: 30, clientY: 14 } });
    expect(selected()).toEqual(['alpha']);
    expect(changes).toHaveBeenCalledTimes(1);
    expect(gutter('Alpha')).toHaveFocus();
  });

  it('adds the swept range to the existing selection with Ctrl and ignores the click a release on the pressed gutter synthesizes', async () => {
    const user = userEvent.setup();
    render(<Table initial={['charlie', 'alpha']} />);
    await user.keyboard('{Control>}');
    await user.pointer({ keys: '[MouseLeft>]', target: gutter('Alpha'), coords: { clientX: 10, clientY: 10 } });
    await user.pointer({ target: row(bravo.id), coords: { clientX: 10, clientY: 60 } });
    expect(selected()).toEqual(['alpha', 'bravo', 'charlie']);
    // Back on the pressed row the range is Alpha alone; the release click must not toggle Alpha off.
    await user.pointer({ target: gutter('Alpha'), coords: { clientX: 10, clientY: 12 } });
    expect(selected()).toEqual(['alpha', 'charlie']);
    await user.pointer({ keys: '[/MouseLeft]', target: gutter('Alpha'), coords: { clientX: 10, clientY: 12 } });
    await user.keyboard('{/Control}');
    expect(selected()).toEqual(['alpha', 'charlie']);
    // A later plain click still selects normally: the swallowed click was only the release's.
    await user.click(gutter('Bravo'));
    expect(selected()).toEqual(['bravo']);
  });

  it('extends from the existing anchor with Shift', async () => {
    const user = userEvent.setup();
    render(<Table />);
    await user.click(gutter('Alpha'));
    await user.keyboard('{Shift>}');
    await user.pointer({ keys: '[MouseLeft>]', target: gutter('Folded'), coords: { clientX: 10, clientY: 150 } });
    await user.pointer({ target: row(charlie.id), coords: { clientX: 10, clientY: 200 } });
    await user.pointer({ keys: '[/MouseLeft]', target: row(charlie.id), coords: { clientX: 10, clientY: 200 } });
    await user.keyboard('{/Shift}');
    expect(selected()).toEqual(['alpha', 'bravo', 'bravo-child', 'folded', 'charlie']);
  });

  it('restores the selection the press started from on Escape', async () => {
    const user = userEvent.setup();
    render(<Table initial={['charlie']} />);
    await user.pointer({ keys: '[MouseLeft>]', target: gutter('Alpha'), coords: { clientX: 10, clientY: 10 } });
    await user.pointer({ target: row(bravo.id), coords: { clientX: 10, clientY: 60 } });
    expect(selected()).toEqual(['alpha', 'bravo']);
    await user.keyboard('{Escape}');
    expect(selected()).toEqual(['charlie']);
    expect(sweeping()).toBe(false);
    // The cancelled pointer no longer extends anything.
    await user.pointer({ target: row(folded.id), coords: { clientX: 10, clientY: 150 } });
    await user.pointer({ keys: '[/MouseLeft]', target: row(folded.id), coords: { clientX: 10, clientY: 150 } });
    expect(selected()).toEqual(['charlie']);
  });

  it('does not start from a touch pointer or while selection is disabled', async () => {
    const user = userEvent.setup();
    const { rerender } = render(<Table />);
    await user.pointer({ keys: '[TouchA>]', target: gutter('Alpha'), coords: { clientX: 10, clientY: 10 } });
    await user.pointer({ pointerName: 'TouchA', target: row(bravo.id), coords: { clientX: 10, clientY: 60 } });
    expect(selected()).toEqual([]);
    expect(sweeping()).toBe(false);
    await user.pointer({ keys: '[/TouchA]', target: row(bravo.id), coords: { clientX: 10, clientY: 60 } });
    rerender(<Table selectionDisabled />);
    await user.pointer({ keys: '[MouseLeft>]', target: gutter('Alpha'), coords: { clientX: 10, clientY: 10 } });
    await user.pointer({ target: row(bravo.id), coords: { clientX: 10, clientY: 60 } });
    await user.pointer({ keys: '[/MouseLeft]', target: row(bravo.id), coords: { clientX: 10, clientY: 60 } });
    expect(selected()).toEqual([]);
    expect(sweeping()).toBe(false);
  });
});
