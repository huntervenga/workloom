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
    [`GET ${rootPath}/tasks`]: () => hold ? list.promise.then(response => response.clone()) : page([current]),
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
  // Leaving the title for the adjacent status cell autosaves it; the cell opens at once, without that answer.
  await user.click(screen.getByRole('button', { name: `Edit status for ${task.title}` }));
  await waitFor(() => expect(patches(calls)).toHaveLength(1));
  expect(patches(calls)[0]?.body).toEqual({ expectedRevision: 1, title: 'Renamed before status' });
  const picker = await screen.findByRole('combobox', { name: 'Status' });
  await waitFor(() => expect(picker).toHaveFocus());
  expect(picker).not.toBeDisabled();
  fixture.holdList();
  return { calls, user, confirm: () => act(async () => fixture.confirmTitle()) };
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
  // No command is held any more and the refetched list head is not loaded yet: the cell still opens at once.
  await user.click(screen.getByRole('button', { name: `Edit status for ${task.title}` }));
  const picker = await screen.findByRole('combobox', { name: 'Status' });
  await waitFor(() => expect(picker).toHaveFocus());
  expect(patches(calls)).toHaveLength(1);
  return { calls, user, confirm: async () => undefined };
}

describe.each([
  ['clicked while the save is pending', editTitleThenClickStatus],
  ['clicked after the save ACK while the list refetches', saveTitleThenClickStatusAfterAck],
])('a cell %s', (_case, start) => {
  it('opens at once and writes the explicit status at the confirmed revision once', async () => {
    const fixture = heldListFixture();
    const { calls, user, confirm } = await start(fixture);
    await user.click(within(screen.getByRole('listbox', { name: 'Status' })).getByRole('option', { name: 'Stored progress' }));
    // Still one command at a time: the choice waits for the title's answer (if it is still outstanding).
    await confirm();
    await waitFor(() => expect(patches(calls)).toHaveLength(2));
    // The list still shows revision 1; the guard comes from the title's confirmed answer.
    expect(patches(calls)[1]?.body).toEqual({ expectedRevision: 2, statusId: NEXT_STATUS });
    await act(async () => fixture.answerList(() => page([fixture.current()])));
    await screen.findByRole('button', { name: 'Renamed before status' });
    expect(patches(calls)).toHaveLength(2);
    expect(fixture.current()).toMatchObject({ title: 'Renamed before status', statusId: NEXT_STATUS, revision: 3, description: task.description, dueDate: task.dueDate, priority: task.priority });
  });

  // After the ACK a failed refresh replaces the rows by its error, so there is no open cell left to write from.
  it.runIf(_case.includes('pending'))('still writes against the confirmed revision when the list refresh fails', async () => {
    const fixture = heldListFixture();
    const { calls, user, confirm } = await start(fixture);
    await act(async () => fixture.answerList(() => failure(503, 'UNAVAILABLE', 'private refresh details')));
    await confirm();
    await user.click(within(await screen.findByRole('listbox', { name: 'Status' })).getByRole('option', { name: 'Stored progress' }));
    await waitFor(() => expect(patches(calls)).toHaveLength(2));
    expect(patches(calls)[1]?.body).toEqual({ expectedRevision: 2, statusId: NEXT_STATUS });
    expect(screen.queryByText('private refresh details')).not.toBeInTheDocument();
  });
});

describe('Tab from a title being edited', () => {
  it('saves the title in the background and opens the next cell at once for editing', async () => {
    const fixture = heldListFixture();
    const { calls } = installFakeApi(fixture.routes);
    const { user } = renderApp(tablePath);
    await user.click(await screen.findByRole('button', { name: task.title }));
    fireEvent.change(titleBox(), { target: { value: 'Renamed before status' } });
    await user.tab();
    const picker = await screen.findByRole('combobox', { name: 'Status' });
    await waitFor(() => expect(picker).toHaveFocus());
    expect(screen.getByRole('listbox', { name: 'Status' })).toBeInTheDocument();
    await waitFor(() => expect(patches(calls)).toHaveLength(1));
    expect(patches(calls)[0]?.body).toEqual({ expectedRevision: 1, title: 'Renamed before status' });
    await act(async () => fixture.confirmTitle());
    await user.click(within(screen.getByRole('listbox', { name: 'Status' })).getByRole('option', { name: 'Stored progress' }));
    await waitFor(() => expect(patches(calls)).toHaveLength(2));
    expect(patches(calls)[1]?.body).toEqual({ expectedRevision: 2, statusId: NEXT_STATUS });
  });
});
