import type { TaskDto } from '@workloom/contracts';
import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import { beforeAll, describe, expect, it } from 'vitest';
import { alpha, alphaMembers, anna, created, deferred, failure, installFakeApi, json, ok, renderApp, type RouteTable } from '../test/fakeApi';
import { queryKeys } from '../lib/queryKeys';
import { PROJECT_ID, rootPath, task, tablePath, tableRoutes } from '../features/work-categories/test/fixtures';

beforeAll(async () => { await import('./ProjectPage'); });
const anchor = { ...task, title: 'Existing anchor', position: 0 };
const added: TaskDto = { ...task, id: 'f2000000-0000-4000-8000-000000000091', title: 'New chain task', position: 1 };
const preference = { workspaceId: alpha.id, projectId: PROJECT_ID, membershipId: alphaMembers[0]?.id, revision: 1, columns: [{ column: { kind: 'builtin', key: 'title' }, visible: true }] };
const nameInput = () => screen.getByRole('textbox', { name: 'Task name' });
const addedRow = () => document.querySelector(`tr[data-task-row="${added.id}"]`);

function fixture(extra: RouteTable = {}) {
  const state = { rows: [anchor] as TaskDto[], holdLists: false, heldReads: 0 };
  const list = deferred<Response>();
  const api = installFakeApi({ ...tableRoutes(),
    [`GET ${rootPath}/tasks`]: () => { if (state.holdLists) { state.heldReads++; return list.promise; } return json(200, { data: state.rows, meta: { requestId: 'delete-list', nextCursor: null } }); },
    [`GET ${rootPath}/projects/${PROJECT_ID}/table-preferences/me`]: () => ok(preference),
    // The real placement reader shares the list cache prefix, but its pages contain rows, not tasks.
    [`GET ${rootPath}/projects/${PROJECT_ID}/rows`]: () => json(200, { data: [], meta: { requestId: 'placement-list', nextCursor: null } }),
    [`POST ${rootPath}/tasks`]: () => { state.rows = [anchor, added]; return created(added); },
    ...extra,
  });
  return { ...api, state, list };
}
async function createChain(ui: ReturnType<typeof renderApp>) {
  await ui.user.click(await screen.findByRole('button', { name: anchor.title }));
  await ui.user.keyboard('{Enter}');
  await waitFor(() => expect(nameInput()).toHaveValue(''));
  await ui.user.keyboard(`${added.title}{Enter}`);
  await screen.findByRole('button', { name: added.title });
  await waitFor(() => expect(nameInput()).toHaveValue(''));
  await ui.user.keyboard('{Escape}');
  await waitFor(() => expect(screen.queryByRole('textbox', { name: 'Task name' })).not.toBeInTheDocument());
  await waitFor(() => expect(addedRow()?.querySelector('[data-task-cell]')).not.toBeNull());
}
async function erase(ui: ReturnType<typeof renderApp>) {
  await ui.user.click(screen.getByRole('button', { name: added.title }));
  fireEvent.change(nameInput(), { target: { value: '' } });
  await ui.user.keyboard('{Backspace}');
}

describe('deleting an acknowledged Enter-chain task', () => {
  it('never revives the confirmed-create fallback while archive and its list refresh finish', async () => {
    const archive = deferred<Response>();
    const setup = fixture({ [`POST ${rootPath}/tasks/${added.id}/archive`]: () => archive.promise });
    const ui = renderApp(tablePath);
    await createChain(ui);
    await erase(ui);
    expect(addedRow()).toBeNull();
    setup.state.rows = [anchor]; setup.state.holdLists = true;
    act(() => archive.resolve(ok({ ...added, revision: 2, archivedAt: '2026-10-24T12:00:00.000Z' })));
    await waitFor(() => expect(setup.state.heldReads).toBeGreaterThan(0));
    expect(addedRow()).toBeNull();
    await screen.findByRole('button', { name: 'Undo' });
    expect(addedRow()).toBeNull();
    act(() => setup.list.resolve(json(200, { data: [anchor], meta: { requestId: 'delete-finished', nextCursor: null } })));
    await waitFor(() => expect(addedRow()).toBeNull());
    expect(setup.calls.filter(call => call.method === 'PATCH')).toHaveLength(0);
  });

  it('keeps a late stale list hidden after acknowledgement, but accepts a newer Undo restore', async () => {
    const restored = { ...added, revision: 3 };
    let current = added;
    const setup = fixture({
      [`POST ${rootPath}/tasks/${added.id}/archive`]: () => { current = { ...current, revision: current.revision + 1, archivedAt: '2026-10-24T12:00:00.000Z' }; setup.state.rows = [anchor]; return ok(current); },
      [`POST ${rootPath}/tasks/${added.id}/restore`]: () => { current = { ...current, revision: current.revision + 1, archivedAt: null }; setup.state.rows = [anchor, current]; return ok(current); },
    });
    setup.state.rows = [anchor, added];
    const ui = renderApp(tablePath);
    await screen.findByRole('button', { name: added.title });
    await erase(ui);
    await screen.findByRole('button', { name: 'Undo' });
    await act(() => ui.queryClient.invalidateQueries({ queryKey: queryKeys.projectTaskLists(anna.id, alpha.id, PROJECT_ID) }));
    expect(addedRow()).toBeNull();
    // Simulate a response from a lagging reader, after a completed absent-list read.
    setup.state.rows = [anchor, added];
    await act(() => ui.queryClient.invalidateQueries({ queryKey: queryKeys.projectTaskLists(anna.id, alpha.id, PROJECT_ID) }));
    expect(addedRow()).toBeNull();
    await ui.user.click(screen.getByRole('button', { name: 'Undo' }));
    await screen.findByRole('button', { name: added.title });
    await ui.user.click(screen.getByRole('button', { name: added.title }));
    expect(nameInput()).toHaveValue(added.title);
    await ui.user.keyboard('{Escape}');
    await erase(ui);
    await waitFor(() => expect(setup.calls.filter(call => call.path.endsWith('/archive'))).toHaveLength(2));
    setup.state.rows = [anchor, restored];
    await act(() => ui.queryClient.invalidateQueries({ queryKey: queryKeys.projectTaskLists(anna.id, alpha.id, PROJECT_ID) }));
    expect(addedRow()).toBeNull(); // The old restore ACK at revision 3 cannot undo archive revision 4.
  });

  it('restores a rejected deletion instead of retaining an empty draft', async () => {
    const setup = fixture({ [`POST ${rootPath}/tasks/${added.id}/archive`]: () => failure(422, 'DOMAIN_VALIDATION_FAILED', 'Cannot delete this task') });
    setup.state.rows = [anchor, added];
    const ui = renderApp(tablePath);
    await screen.findByRole('button', { name: added.title });
    await erase(ui);
    await screen.findByRole('button', { name: added.title });
    await ui.user.click(screen.getByRole('button', { name: added.title }));
    expect(nameInput()).toHaveValue(added.title);
    expect(setup.calls.filter(call => call.method === 'PATCH')).toHaveLength(0);
  });

  it('shows the confirmed archived head when the person explicitly includes archived tasks', async () => {
    const setup = fixture({ [`POST ${rootPath}/tasks/${added.id}/archive`]: () => {
      const archived = { ...added, revision: 2, archivedAt: '2026-10-24T12:00:00.000Z' };
      setup.state.rows = [anchor, archived]; return ok(archived);
    } });
    setup.state.rows = [anchor, added];
    const ui = renderApp(`${tablePath}?includeArchived=true`);
    await screen.findByRole('button', { name: added.title });
    await erase(ui);
    await act(() => ui.queryClient.invalidateQueries({ queryKey: queryKeys.projectTaskLists(anna.id, alpha.id, PROJECT_ID) }));
    expect(addedRow()).not.toBeNull();
    expect(addedRow()).toHaveTextContent('Archived');
  });


  it('keeps a never-listed creation visible while its first authoritative read is pending', async () => {
    const setup = fixture({ [`POST ${rootPath}/tasks`]: () => {
      setup.state.rows = [anchor, added]; setup.state.holdLists = true; return created(added);
    } });
    const ui = renderApp(tablePath);
    await ui.user.click(await screen.findByRole('button', { name: anchor.title }));
    await ui.user.keyboard('{Enter}');
    await waitFor(() => expect(nameInput()).toHaveValue(''));
    await ui.user.keyboard(`${added.title}{Enter}`);
    await waitFor(() => expect(setup.state.heldReads).toBeGreaterThan(0));
    expect(addedRow()).not.toBeNull();
    expect(document.querySelectorAll(`tr[data-task-row="${added.id}"]`)).toHaveLength(1);
    await ui.user.keyboard('{Escape}');
    expect(addedRow()).not.toBeNull();
    act(() => setup.list.resolve(json(200, { data: [anchor, added], meta: { requestId: 'created-first-read', nextCursor: null } })));
    await waitFor(() => expect(addedRow()?.querySelector('[data-task-cell]')).not.toBeNull());
    expect(document.querySelectorAll(`tr[data-task-row="${added.id}"]`)).toHaveLength(1);
  });

  it('hides the whole loaded subtree even if descendant rows arrive before their parents', async () => {
    const child = { ...added, id: 'f2000000-0000-4000-8000-000000000092', parentTaskId: added.id, title: 'Nested child' };
    const grandchild = { ...added, id: 'f2000000-0000-4000-8000-000000000093', parentTaskId: child.id, title: 'Nested grandchild' };
    const archive = deferred<Response>();
    const setup = fixture({ [`POST ${rootPath}/tasks/${added.id}/archive`]: () => archive.promise });
    setup.state.rows = [grandchild, anchor, child, added];
    const ui = renderApp(tablePath);
    await ui.user.click(await screen.findByRole('button', { name: `Expand subtasks of “${added.title}”` }));
    await ui.user.click(await screen.findByRole('button', { name: `Expand subtasks of “${child.title}”` }));
    await screen.findByRole('button', { name: grandchild.title });
    await erase(ui);
    for (const id of [added.id, child.id, grandchild.id]) expect(document.querySelector(`tr[data-task-row="${id}"]`)).toBeNull();
    setup.state.rows = [anchor, grandchild, child];
    act(() => archive.resolve(ok({ ...added, revision: 2, archivedAt: '2026-10-24T12:00:00.000Z' })));
    await screen.findByRole('button', { name: 'Undo' });
    await act(() => ui.queryClient.invalidateQueries({ queryKey: queryKeys.projectTaskLists(anna.id, alpha.id, PROJECT_ID) }));
    for (const id of [added.id, child.id, grandchild.id]) expect(document.querySelector(`tr[data-task-row="${id}"]`)).toBeNull();
    expect(screen.getByRole('button', { name: anchor.title })).toBeInTheDocument();
  });


  it('releases a restored subtree even when the current search excludes its parent', async () => {
    const child = { ...added, id: 'f2000000-0000-4000-8000-000000000094', parentTaskId: added.id, title: 'Matching child' };
    const setup: ReturnType<typeof fixture> = fixture({
      [`GET ${rootPath}/tasks`]: request => json(200, { data: setup.state.rows.filter(item => item.title.includes(request.searchParams.get('search') ?? '')), meta: { requestId: 'filtered-delete', nextCursor: null } }),
      [`POST ${rootPath}/tasks/${added.id}/archive`]: () => { setup.state.rows = [anchor]; return ok({ ...added, revision: 2, archivedAt: '2026-10-24T12:00:00.000Z' }); },
      [`POST ${rootPath}/tasks/${added.id}/restore`]: () => { setup.state.rows = [anchor, { ...added, revision: 3 }, { ...child, revision: 3 }]; return ok({ ...added, revision: 3 }); },
    });
    setup.state.rows = [anchor, added, child];
    const ui = renderApp(tablePath);
    await screen.findByRole('button', { name: added.title });
    await erase(ui);
    await screen.findByRole('button', { name: 'Undo' });
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search tasks' }), { target: { value: 'Matching' } });
    await waitFor(() => expect(setup.calls.some(call => call.path.endsWith('/tasks') && call.searchParams.get('search') === 'Matching')).toBe(true));
    await ui.user.click(screen.getByRole('button', { name: 'Undo' }));
    await screen.findByRole('button', { name: child.title });
    expect(addedRow()).toBeNull();
  });

});
