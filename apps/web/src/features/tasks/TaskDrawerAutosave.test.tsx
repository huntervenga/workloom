import { QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { useState } from 'react';
import { renderFieldUi } from '../fields/test/fixtures';
import { alpha, alphaMembers, anna, project } from '../../test/fakeApi';
import { TaskDrawer } from './TaskDrawer';
import { draftFromTask } from './taskDraft';
import { queryKeys } from '../../lib/queryKeys';
import { protectedDraftsFor } from '../../lib/protectedDrafts';
import { useTaskCommands } from './useTaskCommands';
import { AppRoutes } from '../../app/AppRoutes';
import { ProtectedNavigationGuard } from '../../app/ProtectedNavigationGuard';
import { SessionProvider } from '../../app/session';
import { createQueryClient } from '../../lib/queryClient';
import { failure, installFakeApi, ok, type RouteTable } from '../../test/fakeApi';
import { rootPath, task, tablePath, tableRoutes } from '../../features/work-categories/test/fixtures';

beforeAll(async () => { await import('../../routes/ProjectPage'); });
const cleanups: (() => void)[] = [];
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); });

function unload() { const event = new Event('beforeunload', { cancelable: true }); window.dispatchEvent(event); return event.defaultPrevented; }

/** A PATCH answer the test releases explicitly, so a second save could only overlap it visibly. */
function heldAnswer() {
  let release: (response: Response) => void = () => undefined;
  const promise = new Promise<Response>((resolve) => { release = resolve; });
  return { promise, release };
}

function setup(extra: RouteTable = {}) {
  const api = installFakeApi({ ...tableRoutes(), [`GET ${rootPath}/tasks/${task.id}`]: () => ok(task), ...extra });
  const client = createQueryClient({ retry: false });
  const router = createMemoryRouter([{ path: '*', element: <SessionProvider><ProtectedNavigationGuard /><AppRoutes /></SessionProvider> }], { initialEntries: [`${tablePath}?task=${task.id}`] });
  const ui = render(<QueryClientProvider client={client}><RouterProvider router={router} /></QueryClientProvider>);
  cleanups.push(() => { ui.unmount(); router.dispose(); client.clear(); });
  return { ...ui, ...api, client, router, user: userEvent.setup({ pointerEventsCheck: 0 }) };
}

type Call = { method: string; body?: unknown };
const bodyOf = (call: Call | undefined) => (typeof call?.body === 'string' ? JSON.parse(call.body) : call?.body);
const writes = (calls: readonly Call[]) => calls.filter((call) => call.method === 'PATCH');

describe('saved task pane autosave', () => {
  it('keeps raw spaces while appending words and sends only the committed normalized title', async () => {
    const title = `${task.title} two words`;
    const ui = setup({ [`PATCH ${rootPath}/tasks/${task.id}`]: () => ok({ ...task, title, revision: task.revision + 1 }) });
    const name = await screen.findByLabelText('Task name');
    await ui.user.type(name, ' two words');
    expect(name).toHaveValue(title);
    expect(writes(ui.calls)).toHaveLength(0);
    await ui.user.type(name, ' ');
    expect(name).toHaveValue(`${title} `);
    fireEvent.blur(name);
    await waitFor(() => expect(writes(ui.calls)).toHaveLength(1));
    expect(bodyOf(writes(ui.calls)[0])).toEqual({ expectedRevision: task.revision, title });
    await waitFor(() => expect(unload()).toBe(false));
  });

  it('sends the blurred field without any Save click and never per keystroke', async () => {
    const ui = setup({ [`PATCH ${rootPath}/tasks/${task.id}`]: () => ok({ ...task, title: 'Autosaved title', revision: task.revision + 1 }) });
    const name = await screen.findByLabelText('Task name');
    fireEvent.change(name, { target: { value: 'Autosaved' } });
    fireEvent.change(name, { target: { value: 'Autosaved title' } });
    expect(writes(ui.calls)).toHaveLength(0);

    fireEvent.blur(name);
    await waitFor(() => expect(writes(ui.calls)).toHaveLength(1));
    expect(bodyOf(writes(ui.calls)[0])).toEqual({ expectedRevision: task.revision, title: 'Autosaved title' });
    expect(screen.queryByRole('button', { name: 'Save' })).not.toBeInTheDocument();
    expect(await screen.findByText('Saved')).toBeInTheDocument();
    await waitFor(() => expect(unload()).toBe(false));
  });

  it('queues a second field behind the held first answer and sends it on the confirmed revision', async () => {
    const first = heldAnswer();
    let attempts = 0;
    const ui = setup({
      [`PATCH ${rootPath}/tasks/${task.id}`]: () => (++attempts === 1 ? first.promise : ok({ ...task, title: 'First field', description: 'Second field', revision: task.revision + 2 })),
    });
    const name = await screen.findByLabelText('Task name');
    fireEvent.change(name, { target: { value: 'First field' } });
    fireEvent.blur(name);
    await waitFor(() => expect(attempts).toBe(1));

    // The input stays editable while the first save is pending.
    const description = screen.getByLabelText('Description');
    expect(description).not.toBeDisabled();
    fireEvent.change(description, { target: { value: 'Second field' } });
    fireEvent.keyDown(description, { key: 'Enter', ctrlKey: true });
    expect(writes(ui.calls)).toHaveLength(1);

    await act(async () => { first.release(ok({ ...task, title: 'First field', revision: task.revision + 1 })); });
    await waitFor(() => expect(writes(ui.calls)).toHaveLength(2));
    expect(bodyOf(writes(ui.calls)[1])).toEqual({ expectedRevision: task.revision + 1, description: 'Second field' });
  });

  it('flushes the latest text on Escape close behind a held save and clears protection after both acknowledgments', async () => {
    const first = heldAnswer(), second = heldAnswer();
    let attempts = 0;
    const ui = setup({ [`PATCH ${rootPath}/tasks/${task.id}`]: () => ++attempts === 1 ? first.promise : second.promise });
    const name = await screen.findByLabelText('Task name');
    fireEvent.change(name, { target: { value: 'Held title' } });
    fireEvent.blur(name);
    await waitFor(() => expect(writes(ui.calls)).toHaveLength(1));
    fireEvent.change(screen.getByLabelText('Description'), { target: { value: 'Latest description' } });
    // No synthetic blur: pane Close/Escape itself commits the current text.
    await ui.user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(unload()).toBe(true);
    await act(async () => first.release(ok({ ...task, title: 'Held title', revision: task.revision + 1 })));
    await waitFor(() => expect(writes(ui.calls)).toHaveLength(2));
    expect(bodyOf(writes(ui.calls)[1])).toEqual({ expectedRevision: task.revision + 1, description: 'Latest description' });
    await act(async () => second.release(ok({ ...task, title: 'Held title', description: 'Latest description', revision: task.revision + 2 })));
    await waitFor(() => expect(unload()).toBe(false));
    await act(async () => { await ui.router.navigate(`${tablePath}?task=${task.id}`); });
    expect(await screen.findByLabelText('Task name')).toHaveValue('Held title');
    expect(screen.getByLabelText('Description')).toHaveValue('Latest description');
    expect(writes(ui.calls)).toHaveLength(2);
  });

  it('adopts an unsent rich handoff and flushes it before Close instead of replacing it with server values', async () => {
    const seed = { base: task, draft: { ...draftFromTask(task), title: 'Retained title', description: 'Retained description' } };
    const api = installFakeApi({ ...tableRoutes(), [`GET ${rootPath}/tasks/${task.id}`]: () => ok(task),
      [`PATCH ${rootPath}/tasks/${task.id}`]: () => ok({ ...task, title: seed.draft.title, description: seed.draft.description, revision: task.revision + 1 }) });
    function Example() {
      const commands = useTaskCommands(anna.id, alpha.id);
      const [open, setOpen] = useState(() => { commands.editSessions.current.set(task.id, seed); return true; });
      return open ? <TaskDrawer actorId={anna.id} workspace={alpha} project={project(alpha.id, task.projectId, 'Handoff project')}
        sections={[]} statuses={[]} members={alphaMembers} tags={[]} writable commands={commands} taskId={task.id} creating={null}
        onClose={() => setOpen(false)} onOpenTask={() => undefined} onResumeCreate={() => undefined} onCreated={() => undefined} onAnnounce={() => undefined} /> : null;
    }
    const ui = renderFieldUi(<Example />);
    expect(await screen.findByLabelText('Task name')).toHaveValue(seed.draft.title);
    expect(screen.getByLabelText('Description')).toHaveValue(seed.draft.description);
    expect(writes(api.calls)).toHaveLength(0);
    await ui.user.click(screen.getByRole('button', { name: 'Close' }));
    await waitFor(() => expect(writes(api.calls)).toHaveLength(1));
    expect(bodyOf(writes(api.calls)[0])).toEqual({ expectedRevision: task.revision, title: seed.draft.title, description: seed.draft.description });
    await waitFor(() => expect(unload()).toBe(false));
  });

  it('pins the opening task base for dates and rejects a concurrent refetch instead of silently overwriting it', async () => {
    let current = task;
    const ui = setup({
      [`GET ${rootPath}/tasks/${task.id}`]: () => ok(current),
      [`PATCH ${rootPath}/tasks/${task.id}`]: request => {
        const input = request.body as { expectedRevision: number; dueDate?: string };
        if (input.expectedRevision !== current.revision) return failure(409, 'REVISION_CONFLICT', 'Concurrent change');
        current = { ...current, dueDate: input.dueDate ?? null, revision: current.revision + 1 };
        return ok(current);
      },
    });
    await ui.user.click(await screen.findByRole('button', { name: 'Edit dates' }));
    // Refetch arrives after opening, before the first key: the editor still owns its original base.
    current = { ...task, revision: task.revision + 1, dueDate: '2027-04-02' };
    act(() => ui.client.setQueryData(queryKeys.task(anna.id, alpha.id, task.id), current));
    fireEvent.change(screen.getByLabelText('Due date'), { target: { value: '2027-03-21' } });
    expect(protectedDraftsFor(ui.client).protecting).toBe(true);
    await ui.user.keyboard('{Enter}');
    await waitFor(() => expect(writes(ui.calls)).toHaveLength(1));
    expect(bodyOf(writes(ui.calls)[0])).toEqual({ expectedRevision: task.revision, dueDate: '2027-03-21' });
    expect(await screen.findByText('This task changed on the server. Review the latest version to keep saving.')).toBeVisible();
    expect(current.dueDate).toBe('2027-04-02');
    expect(current.revision).toBe(task.revision + 1);
    expect(unload()).toBe(true);
    expect(writes(ui.calls)).toHaveLength(1);
  });

  it('protects raw calendar typing on keyboard routing, retains it on Stay, and Escape releases the draft without a write', async () => {
    const ui = setup();
    await ui.user.click(await screen.findByRole('button', { name: 'Edit dates' }));
    fireEvent.change(screen.getByLabelText('Due date'), { target: { value: 'raw invalid date' } });
    expect(protectedDraftsFor(ui.client).protecting).toBe(true);
    expect(unload()).toBe(true);
    await act(async () => { await ui.router.navigate('/keyboard-date-departure'); });
    const guard = await screen.findByRole('dialog', { name: 'Leave this page?' });
    expect(guard).toHaveTextContent('You have an unsaved draft');
    await ui.user.click(within(guard).getByRole('button', { name: 'Stay' }));
    expect(screen.getByLabelText('Due date')).toHaveValue('raw invalid date');
    screen.getByLabelText('Due date').focus();
    await ui.user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog', { name: 'Edit dates' })).not.toBeInTheDocument();
    expect(screen.getByRole('dialog', { name: task.title })).toBeInTheDocument();
    expect(protectedDraftsFor(ui.client).protecting).toBe(false);
    expect(unload()).toBe(false);
    expect(writes(ui.calls)).toHaveLength(0);
    await act(async () => { await ui.router.navigate('/clean-date-departure'); });
    expect(ui.router.state.location.pathname).toBe('/clean-date-departure');
    expect(writes(ui.calls)).toHaveLength(0);
  });

});
