import type { ComponentProps } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { protectedDraftsFor } from '../../lib/protectedDrafts';
import { TaskTable } from './TaskTable';
import { makeTask, statuses } from './taskTableFixtures';
import { usePointerRowDragProtection } from './usePointerRowDrag';

const first = makeTask({ id: 'first', title: 'First', position: 0 });
const middle = makeTask({ id: 'middle', title: 'Middle', position: 1 });
const last = makeTask({ id: 'last', title: 'Last', position: 2 });
const row = (id: string) => document.querySelector<HTMLElement>(`tr[data-task-row="${id}"]`) as HTMLElement;
afterEach(() => { Reflect.deleteProperty(document, 'visibilityState'); });

function Example({ blocked = false, scope = 'same', moved }: { blocked?: boolean; scope?: string; moved: NonNullable<ComponentProps<typeof TaskTable>['onMoveTask']> }) {
  const acquire = usePointerRowDragProtection();
  return <TaskTable tasks={[first, middle, last]} statuses={statuses} sections={[]} members={[]} writable
    onOpenTask={vi.fn()} onCreateTask={vi.fn()} onCreateChild={vi.fn()} onMoveTask={moved}
    moveBlocked={blocked} dragScope={scope} acquireDragProtection={acquire} />;
}

describe('row gesture interaction protection lifecycle', () => {
  it.each(['click', 'drop', 'Escape', 'blur', 'hidden', 'unmount', 'context', 'blocked'] as const)('releases its own lease after %s', async reason => {
    const client = new QueryClient(), moved = vi.fn(), user = userEvent.setup();
    const view = render(<QueryClientProvider client={client}><Example moved={moved} /></QueryClientProvider>);
    const other = protectedDraftsFor(client).register();
    try {
      const handle = within(row(last.id)).getByRole('button', { name: 'Move task: Last' });
      await user.pointer({ keys: '[MouseLeft>]', target: handle, coords: { clientX: 50, clientY: 100 } });
      // Protection starts before the movement threshold, covering a queued head answer.
      expect(protectedDraftsFor(client).protecting).toBe(true);
      if (reason !== 'click') {
        await user.pointer({ target: row(first.id), coords: { clientX: 80, clientY: 80 } });
        expect(screen.getByTestId('task-drag-preview')).toHaveTextContent('Last');
      }
      // Releasing a gesture must not clear another owner's dirty work.
      other.set(true);
      if (reason === 'Escape') fireEvent.keyDown(window, { key: 'Escape' });
      else if (reason === 'blur') fireEvent(window, new Event('blur'));
      else if (reason === 'hidden') {
        Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
        fireEvent(document, new Event('visibilitychange'));
      } else if (reason === 'unmount') view.unmount();
      else if (reason === 'context' || reason === 'blocked') {
        view.rerender(<QueryClientProvider client={client}><Example moved={moved} scope={reason === 'context' ? 'different' : 'same'} blocked={reason === 'blocked'} /></QueryClientProvider>);
        await act(async () => { await new Promise<void>(resolve => { requestAnimationFrame(() => resolve()); }); });
      } else await user.pointer({ keys: '[/MouseLeft]', target: row(first.id), coords: { clientX: 80, clientY: 80 } });
      expect(protectedDraftsFor(client).protecting).toBe(true);
      other.dispose();
      expect(protectedDraftsFor(client).protecting).toBe(false);
      expect(screen.queryByTestId('task-drag-preview')).not.toBeInTheDocument();
      expect(moved).toHaveBeenCalledTimes(reason === 'drop' ? 1 : 0);
    } finally { other.dispose(); view.unmount(); client.clear(); }
  });

  it.each(['blocked', 'non-primary'] as const)('does not acquire a lease for a refused %s pointer', reason => {
    const client = new QueryClient(), moved = vi.fn();
    const view = render(<QueryClientProvider client={client}><Example moved={moved} blocked={reason === 'blocked'} /></QueryClientProvider>);
    try {
      const event = new Event('pointerdown', { bubbles: true, cancelable: true });
      Object.defineProperties(event, { button: { value: 0 }, pointerId: { value: 7 }, isPrimary: { value: reason !== 'non-primary' }, clientX: { value: 50 }, clientY: { value: 100 } });
      fireEvent(within(row(last.id)).getByRole('button', { name: 'Move task: Last' }), event);
      expect(protectedDraftsFor(client).protecting).toBe(false);
      expect(screen.queryByTestId('task-drag-preview')).not.toBeInTheDocument();
      expect(moved).not.toHaveBeenCalled();
    } finally { view.unmount(); client.clear(); }
  });
});
