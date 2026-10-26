import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TaskTable } from './TaskTable';
import { makeTask, statuses } from './taskTableFixtures';
import { tableLayoutStorageKey } from './useLocalTableLayout';

const scope = { actorId: 'a0000000-0000-4000-8000-000000000001', workspaceId: 'a0000000-0000-4000-8000-000000000002', projectId: 'a0000000-0000-4000-8000-000000000003' };
const key = tableLayoutStorageKey(scope);
const field = 'a0000000-0000-4000-8000-000000000004';
const calls = { onOpenTask: vi.fn(), onCreateTask: vi.fn(), onCreateChild: vi.fn(), onClearSelection: vi.fn() };
function Example({ projectId = scope.projectId }) {
  return <TaskTable {...calls} tasks={[makeTask({ id: 'resize-task', title: 'Resize fixture' })]} sections={[]} statuses={statuses} members={[]}
    layoutScope={{ ...scope, projectId }} columnIds={['title', 'status', field]} customColumns={[{ id: field, label: 'Score', width: 160, renderCell: () => '10' }]} />;
}
const widths = () => [...screen.getByRole('table').querySelectorAll('col')].map(col => col.style.width);
const handle = (name = 'Status') => screen.getByRole('separator', { name: `Resize ${name} column` });
afterEach(() => { vi.restoreAllMocks(); vi.clearAllMocks(); });

describe('column resizing in the task table', () => {
  it('previews a drag and persists only the completed width, restored after remount', async () => {
    const save = vi.spyOn(Storage.prototype, 'setItem');
    const user = userEvent.setup();
    const ui = render(<Example />);
    await user.pointer({ keys: '[MouseLeft>]', target: handle(), coords: { clientX: 200 } });
    await user.pointer({ target: handle(), coords: { clientX: 280 } });
    await waitFor(() => expect(widths()[1]).toBe('224px'));
    expect(save).not.toHaveBeenCalled();
    await user.pointer({ keys: '[/MouseLeft]', target: handle(), coords: { clientX: 280 } });
    expect(JSON.parse(localStorage.getItem(key) ?? '{}')).toEqual({ version: 1, columnWidths: { status: 224 } });
    expect(save).toHaveBeenCalledTimes(1);
    expect(calls.onOpenTask).not.toHaveBeenCalled();
    expect(document.body.style.userSelect).toBe('');
    ui.unmount(); render(<Example />);
    expect(widths()[1]).toBe('224px');
    await user.dblClick(handle());
    expect(widths()[1]).toBe('144px');
    expect(JSON.parse(localStorage.getItem(key) ?? '{}').columnWidths).toEqual({});
  });

  it.each(['Escape', 'pointercancel'])('cancels a preview on %s without saving or clearing row selection', async cancellation => {
    const user = userEvent.setup(); render(<Example />);
    await user.pointer({ keys: '[MouseLeft>]', target: handle(), coords: { clientX: 200 } });
    await user.pointer({ target: handle(), coords: { clientX: 290 } });
    await waitFor(() => expect(widths()[1]).toBe('234px'));
    if (cancellation === 'Escape') await user.keyboard('{Escape}'); else fireEvent.pointerCancel(handle());
    expect(widths()[1]).toBe('144px');
    expect(localStorage.getItem(key)).toBeNull();
    expect(calls.onClearSelection).not.toHaveBeenCalled();
    expect(document.body.style.cursor).toBe('');
  });

  it('supports keyboard sizing and resets custom fields independently', async () => {
    const user = userEvent.setup(); render(<Example />);
    handle('Score').focus();
    await user.keyboard('{ArrowRight}{Shift>}{ArrowRight}{/Shift}');
    expect(widths()[2]).toBe('240px');
    expect(widths()[1]).toBe('144px');
    await user.keyboard('{Home}'); expect(widths()[2]).toBe('64px');
    await user.keyboard('{End}'); expect(widths()[2]).toBe('1200px');
    await user.keyboard('{Delete}'); expect(widths()[2]).toBe('160px');
  });

  it('cancels an active drag when the project changes and cleans up global pointer styles', async () => {
    const user = userEvent.setup(); const ui = render(<Example />);
    await user.pointer({ keys: '[MouseLeft>]', target: handle(), coords: { clientX: 200 } });
    await user.pointer({ target: handle(), coords: { clientX: 260 } });
    await waitFor(() => expect(widths()[1]).toBe('204px'));
    ui.rerender(<Example projectId={field} />);
    expect(widths()[1]).toBe('144px');
    expect(document.body.style.cursor).toBe('');
    expect(localStorage.getItem(key)).toBeNull();
    expect(localStorage.getItem(tableLayoutStorageKey({ ...scope, projectId: field }))).toBeNull();
  });
});
