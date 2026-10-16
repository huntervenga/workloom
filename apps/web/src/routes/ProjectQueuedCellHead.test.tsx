import type { TaskDto } from '@workloom/contracts';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { beforeAll, describe, expect, it } from 'vitest';
import { alpha, alphaMembers, deferred, failure, installFakeApi, json, ok, renderApp, type RouteTable } from '../test/fakeApi';
import { PROJECT_ID, rootPath, task, tablePath, tableRoutes } from '../features/work-categories/test/fixtures';
beforeAll(async () => { await import('./ProjectPage'); });
const NEXT_STATUS = 'f6000000-0000-4000-8000-000000000002';
const statuses = [
  { id: task.statusId, workspaceId: alpha.id, projectId: PROJECT_ID, name: 'Planned', group: 'todo', position: 0, revision: 1 },
  { id: NEXT_STATUS, workspaceId: alpha.id, projectId: PROJECT_ID, name: 'Stored progress', group: 'in_progress', position: 1, revision: 1 },
];
const preference = { workspaceId: alpha.id, projectId: PROJECT_ID, membershipId: alphaMembers[0]?.id, revision: 1, columns: [{ column: { kind: 'builtin', key: 'title' }, visible: true }, { column: { kind: 'builtin', key: 'status' }, visible: true }] };
const page = (rows: TaskDto[]) => json(200, { data: rows, meta: { requestId: 'queued-head-fixture', nextCursor: null } });
const titleBox = () => within(screen.getByRole('form', { name: /in the task table$/ })).getByRole('textbox', { name: 'Task name' });
const patches = (calls: { method: string; body: unknown }[]) => calls.filter(call => call.method === 'PATCH');

/** The list GET after the title ACK is held, then answered by `answer`. */
function heldListFixture() {
  let current: TaskDto = { ...task, revision: 1 };
  let hold = false; const list = deferred<Response>(); const title = deferred<Response>();
  const routes: RouteTable = {
    ...tableRoutes(),
    [`GET ${rootPath}/projects/${PROJECT_ID}/statuses`]: () => ok(statuses),
    [`GET ${rootPath}/projects/${PROJECT_ID}/table-preferences/me`]: () => ok(preference),
    [`GET ${rootPath}/tasks/${task.id}`]: () => ok(current),
    [`GET ${rootPath}/tasks`]: () => hold ? list.promise : page([current]),
    [`PATCH ${rootPath}/tasks/${task.id}`]: request => {
      const body = request.body as { expectedRevision: number; title?: string; statusId?: string };
      if (body.title !== undefined) return title.promise;
      return ok(current = { ...current, statusId: body.statusId ?? current.statusId, revision: current.revision + 1 });
    },
  };
  return {
    routes, list,
    holdList: () => { hold = true; },
    confirmTitle: () => title.resolve(ok(current = { ...current, title: 'Renamed before status', revision: 2 })),
    answerList: (response: () => Response) => { hold = false; list.resolve(response()); },
    current: () => current,
  };
}

async function editTitleThenClickStatus(fixture: ReturnType<typeof heldListFixture>) {
  const { calls } = installFakeApi(fixture.routes);
  const { user } = renderApp(tablePath);
  await user.click(await screen.findByRole('button', { name: task.title }));
  fireEvent.change(titleBox(), { target: { value: 'Renamed before status' } });
  // Leaving the title for the adjacent status cell autosaves it; the cell waits for that answer.
  await user.click(screen.getByRole('button', { name: `Edit status for ${task.title}` }));
  await waitFor(() => expect(patches(calls)).toHaveLength(1));
  expect(patches(calls)[0]?.body).toEqual({ expectedRevision: 1, title: 'Renamed before status' });
  expect(screen.queryByRole('combobox', { name: 'Status' })).not.toBeInTheDocument();
  fixture.holdList();
  await act(async () => fixture.confirmTitle());
  // The title is confirmed at revision 2, but the list still shows revision 1.
  await waitFor(() => expect(screen.queryByRole('form', { name: /in the task table$/ })).not.toBeInTheDocument());
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)); });
  expect(screen.queryByRole('combobox', { name: 'Status' })).not.toBeInTheDocument();
  expect(patches(calls)).toHaveLength(1);
  return { calls, user };
}

async function saveTitleThenClickStatusAfterAck(fixture: ReturnType<typeof heldListFixture>) {
  const { calls } = installFakeApi(fixture.routes);
  const { user } = renderApp(tablePath);
  await user.click(await screen.findByRole('button', { name: task.title }));
  fireEvent.change(titleBox(), { target: { value: 'Renamed before status' } });
  await user.keyboard('{Control>}{Enter}{/Control}');
  await waitFor(() => expect(patches(calls)).toHaveLength(1));
  expect(patches(calls)[0]?.body).toEqual({ expectedRevision: 1, title: 'Renamed before status' });
  fixture.holdList();
  await act(async () => fixture.confirmTitle());
  await waitFor(() => expect(screen.queryByRole('form', { name: /in the task table$/ })).not.toBeInTheDocument());
  // No command is held any more, but the refetched list head is not loaded yet.
  await user.click(screen.getByRole('button', { name: `Edit status for ${task.title}` }));
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)); });
  expect(screen.queryByRole('combobox', { name: 'Status' })).not.toBeInTheDocument();
  expect(patches(calls)).toHaveLength(1);
  return { calls, user };
}

describe.each([
  ['clicked while the save is pending', editTitleThenClickStatus],
  ['clicked after the save ACK while the list refetches', saveTitleThenClickStatusAfterAck],
])('a cell %s', (_case, start) => {
  it('opens only on the refreshed list head and writes the explicit status at the confirmed revision once', async () => {
    const fixture = heldListFixture();
    const { calls, user } = await start(fixture);
    await act(async () => fixture.answerList(() => page([fixture.current()])));
    const picker = await screen.findByRole('combobox', { name: 'Status' });
    await waitFor(() => expect(picker).toHaveFocus());
    expect(patches(calls)).toHaveLength(1);
    await user.click(within(screen.getByRole('listbox', { name: 'Status' })).getByRole('option', { name: 'Stored progress' }));
    await waitFor(() => expect(patches(calls)).toHaveLength(2));
    expect(patches(calls)[1]?.body).toEqual({ expectedRevision: 2, statusId: NEXT_STATUS });
    await screen.findByRole('button', { name: 'Renamed before status' });
    expect(patches(calls)).toHaveLength(2);
    expect(fixture.current()).toMatchObject({ title: 'Renamed before status', statusId: NEXT_STATUS, revision: 3, description: task.description, dueDate: task.dueDate, priority: task.priority });
  });

  it('shows a failed list refresh instead of opening the stale head, then edits the retried head explicitly', async () => {
    const fixture = heldListFixture();
    const { calls, user } = await start(fixture);
    await act(async () => fixture.answerList(() => failure(503, 'UNAVAILABLE', 'private refresh details')));
    const retry = await screen.findByRole('button', { name: 'Try again' });
    expect(screen.queryByRole('combobox', { name: 'Status' })).not.toBeInTheDocument();
    expect(screen.queryByText('private refresh details')).not.toBeInTheDocument();
    await user.click(retry);
    await user.click(await screen.findByRole('button', { name: 'Edit status for Renamed before status' }));
    expect(patches(calls)).toHaveLength(1);
    await user.click(within(await screen.findByRole('listbox', { name: 'Status' })).getByRole('option', { name: 'Stored progress' }));
    await waitFor(() => expect(patches(calls)).toHaveLength(2));
    expect(patches(calls)[1]?.body).toEqual({ expectedRevision: 2, statusId: NEXT_STATUS });
  });
});
