import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { beforeAll, describe, expect, it } from 'vitest';
import { alpha, alphaMembers, anna, deferred, installFakeApi, ok, renderApp } from '../test/fakeApi';
import { rootPath, task, tablePath, tableRoutes } from '../features/work-categories/test/fixtures';

beforeAll(async () => { await import('./ProjectPage'); });
const headPath = `${rootPath}/change-head`;
const tasksPath = `${rootPath}/tasks`;
const tasks = [
  { ...task, title: 'Drag Alpha', position: 0 },
  { ...task, id: 'f6000000-0000-4000-8000-000000000002', title: 'Drag Bravo', position: 1 },
  { ...task, id: 'f6000000-0000-4000-8000-000000000003', title: 'Drag Charlie', position: 2 },
];
const head = { workspaceId: alpha.id, actorUserId: anna.id, membershipId: alphaMembers[0]?.id,
  membershipRevision: 1, role: 'owner', changeSeq: '8', permissionEpoch: '0' };
async function settle() { await act(async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); }); }

describe('project row drag owns its live-refresh interaction', () => {
  it('defers a pre-gesture live head answer while dragging, then catches up after Escape without writing', async () => {
    const answer = deferred<Response>(), refreshed = deferred<Response>();
    let headReads = 0, taskReads = 0;
    const api = installFakeApi({ ...tableRoutes(),
      [`GET ${headPath}`]: () => ++headReads === 1 ? answer.promise : ok(head),
      [`GET ${tasksPath}`]: () => ++taskReads === 1 ? ok(tasks) : refreshed.promise,
    });
    const ui = renderApp(tablePath);
    try {
      const handle = await screen.findByRole('button', { name: 'Move task: Drag Charlie' });
      await waitFor(() => expect(headReads).toBe(1));
      await waitFor(() => expect(handle).not.toHaveAttribute('aria-disabled', 'true'));
      const target = document.querySelector<HTMLTableRowElement>(`tr[data-task-row="${task.id}"]`);
      expect(target).not.toBeNull();
      await ui.user.pointer({ keys: '[MouseLeft>]', target: handle, coords: { clientX: 50, clientY: 100 } });
      await ui.user.pointer({ target: target as HTMLElement, coords: { clientX: 80, clientY: 40 } });
      expect(screen.getByTestId('task-drag-preview')).toHaveTextContent('Drag Charlie');
      await act(async () => answer.resolve(ok(head))); await settle();
      await act(async () => { await new Promise<void>(resolve => { requestAnimationFrame(() => { requestAnimationFrame(() => resolve()); }); }); });
      // An answer begun before pointerdown cannot refresh rows out from under the gesture.
      expect(screen.queryByTestId('task-drag-preview')).toHaveTextContent('Drag Charlie');
      expect(taskReads).toBe(1);
      expect(handle).not.toHaveAttribute('aria-disabled', 'true');
      expect(within(target as HTMLElement).getByRole('button', { name: 'Drag Alpha' })).toBeInTheDocument();
      fireEvent.keyDown(window, { key: 'Escape' });
      await ui.user.pointer({ keys: '[/MouseLeft]', target: target as HTMLElement, coords: { clientX: 80, clientY: 40 } });
      await waitFor(() => expect(taskReads).toBe(2));
      expect(headReads).toBeGreaterThanOrEqual(2);
      await act(async () => refreshed.resolve(ok(tasks.map((item, index) => index === 0 ? { ...item, title: 'Fresh Drag Alpha', revision: item.revision + 1 } : item))));
      await screen.findByRole('button', { name: 'Fresh Drag Alpha' });
      expect(screen.queryByTestId('task-drag-preview')).not.toBeInTheDocument();
      expect(api.calls.filter(call => call.method !== 'GET')).toHaveLength(0);
    } finally { ui.unmount(); ui.queryClient.clear(); }
  });
});
