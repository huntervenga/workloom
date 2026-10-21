import type { SectionDto, TaskDto } from '@workloom/contracts';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { beforeAll, describe, expect, it } from 'vitest';
import { alpha, alphaMembers, created, deferred, failure, installFakeApi, json, ok, renderApp, type RouteTable } from '../test/fakeApi';
import { PROJECT_ID, rootPath, task, tablePath, tableRoutes } from '../features/work-categories/test/fixtures';
beforeAll(async () => { await import('./ProjectPage'); });
const SECTION_A = 'e1000000-0000-4000-8000-000000000001';
const SECTION_B = 'e1000000-0000-4000-8000-000000000002';
const NEXT_STATUS = 'f6000000-0000-4000-8000-000000000002';
const sections: SectionDto[] = [
  { id: SECTION_A, workspaceId: alpha.id, projectId: PROJECT_ID, name: 'First section', position: 0, revision: 1, archivedAt: null },
  { id: SECTION_B, workspaceId: alpha.id, projectId: PROJECT_ID, name: 'Second section', position: 1, revision: 1, archivedAt: null },
];
const rootA: TaskDto = { ...task, title: 'Root in first', sectionId: SECTION_A };
const rootB: TaskDto = { ...task, id: 'f2000000-0000-4000-8000-000000000003', title: 'Root in second', sectionId: SECTION_B, workPackageId: 'f1000000-0000-4000-8000-000000000003', position: 1 };
const preference = { workspaceId: alpha.id, projectId: PROJECT_ID, membershipId: alphaMembers[0]?.id, revision: 1, columns: [{ column: { kind: 'builtin', key: 'title' }, visible: true }, { column: { kind: 'builtin', key: 'status' }, visible: true }] };
const page = (rows: TaskDto[]) => json(200, { data: rows, meta: { requestId: 'continuation-fixture', nextCursor: null } });
type Calls = ReturnType<typeof installFakeApi>['calls'];
const writes = (calls: Calls, method: string) => calls.filter(call => call.method === method);
const titleBox = () => within(screen.getByRole('form', { name: /in the task table$/ })).getByRole('textbox', { name: 'Task name' });
const quickBox = (section: string) => within(screen.getByRole('form', { name: `Add a task to ${section}` })).getByRole('textbox', { name: 'Task name' });
const liveStatus = () => screen.getAllByRole('status').find(node => node.getAttribute('aria-live') === 'polite' && node.classList.contains('sr-only'));
const pendingNotice = 'A task command is waiting for the server response. Its original values are kept.';

function routes(rows: () => TaskDto[], extra: RouteTable = {}): RouteTable {
  return {
    ...tableRoutes(),
    [`GET ${rootPath}/projects/${PROJECT_ID}/planning-checks/settings`]: () => ok({ workspaceId: alpha.id, projectId: PROJECT_ID, revision: 1, config: { enabled: false, rules: [] } }),
    [`GET ${rootPath}/tasks`]: () => page(rows()),
    [`GET ${rootPath}/projects/${PROJECT_ID}/sections`]: () => ok(sections),
    [`GET ${rootPath}/projects/${PROJECT_ID}/statuses`]: () => ok([
      { id: task.statusId, workspaceId: alpha.id, projectId: PROJECT_ID, name: 'Stored todo', group: 'todo', position: 0, revision: 1 },
      { id: NEXT_STATUS, workspaceId: alpha.id, projectId: PROJECT_ID, name: 'Stored progress', group: 'in_progress', position: 1, revision: 1 },
    ]),
    [`GET ${rootPath}/projects/${PROJECT_ID}/table-preferences/me`]: () => ok(preference),
    ...extra,
  };
}

async function renameWithEnter(title: string, next: string) {
  const { user } = renderApp(tablePath);
  await user.click(await screen.findByRole('button', { name: title }));
  fireEvent.change(titleBox(), { target: { value: next } });
  await user.keyboard('{Enter}');
  return user;
}

describe('a plain Enter title save that already continued into the next new task', () => {
  it('keeps the table in place while pending and announces its one confirmation without moving focus', async () => {
    const gate = deferred<Response>(); let current = rootA;
    const { calls } = installFakeApi(routes(() => [current, rootB], { [`PATCH ${rootPath}/tasks/${rootA.id}`]: () => gate.promise }));
    const user = await renameWithEnter(rootA.title, 'Renamed first');
    await waitFor(() => expect(quickBox('First section')).toHaveFocus());
    expect(writes(calls, 'PATCH')).toHaveLength(1);
    // The ordinary pending continuation adds no page notice above the table and no Draft chip.
    expect(screen.queryByText(pendingNotice)).not.toBeInTheDocument();
    expect(screen.queryByText('Draft', { exact: true })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Resume original editor' })).not.toBeInTheDocument();
    await user.keyboard('Unsent next');
    await act(async () => gate.resolve(ok(current = { ...rootA, title: 'Renamed first', revision: rootA.revision + 1 })));
    await screen.findByRole('button', { name: 'Renamed first' });
    await waitFor(() => expect(liveStatus()).toHaveTextContent('Task saved.'));
    expect(quickBox('First section')).toHaveFocus(); expect(quickBox('First section')).toHaveValue('Unsent next');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.queryByText(pendingNotice)).not.toBeInTheDocument();
    expect(writes(calls, 'PATCH')).toHaveLength(1); expect(writes(calls, 'POST')).toHaveLength(0);
  });

  it('alerts a definite rejection with the retained original, keeping the next new task and its focus', async () => {
    const gate = deferred<Response>();
    const { calls } = installFakeApi(routes(() => [rootA, rootB], { [`GET ${rootPath}/tasks/${rootA.id}`]: () => ok(rootA), [`PATCH ${rootPath}/tasks/${rootA.id}`]: () => gate.promise }));
    const user = await renameWithEnter(rootA.title, 'Refused first');
    await waitFor(() => expect(quickBox('First section')).toHaveFocus());
    await user.keyboard('Unsent next');
    await act(async () => gate.resolve(failure(409, 'REVISION_CONFLICT', 'private conflict details')));
    const alert = await screen.findByRole('alert');
    expect(within(alert).getByRole('button', { name: 'Resume original editor' })).toBeInTheDocument();
    expect(screen.queryByText('private conflict details')).not.toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: 'Resume original editor' })).toHaveLength(1);
    expect(quickBox('First section')).toHaveFocus(); expect(quickBox('First section')).toHaveValue('Unsent next');
    // The refused draft is recoverable, so its row shows it is kept.
    expect(screen.getByText('Draft', { exact: true })).toBeInTheDocument();
    await user.click(within(alert).getByRole('button', { name: 'Resume original editor' }));
    expect(await within(await screen.findByRole('dialog')).findByLabelText('Task name')).toHaveValue('Refused first');
    expect(writes(calls, 'PATCH')).toHaveLength(1); expect(writes(calls, 'POST')).toHaveLength(0);
  });

  it('continues into the retained quick draft of another section without moving or overwriting it', async () => {
    let current = rootB;
    const { calls } = installFakeApi(routes(() => [rootA, current], { [`PATCH ${rootPath}/tasks/${rootB.id}`]: () => ok(current = { ...rootB, title: 'Renamed second', revision: rootB.revision + 1 }) }));
    const { user } = renderApp(tablePath);
    await user.click(await screen.findByRole('button', { name: 'Add task to “First section”' }));
    await user.type(quickBox('First section'), 'Unsent in first');
    await user.click(screen.getByRole('button', { name: rootB.title }));
    expect(screen.queryByRole('form', { name: /^Add a task to/ })).not.toBeInTheDocument();
    fireEvent.change(titleBox(), { target: { value: 'Renamed second' } });
    await user.keyboard('{Enter}');
    await waitFor(() => expect(quickBox('First section')).toHaveFocus());
    expect(quickBox('First section')).toHaveValue('Unsent in first');
    expect(screen.queryByRole('form', { name: 'Add a task to Second section' })).not.toBeInTheDocument();
    await screen.findByRole('button', { name: 'Renamed second' });
    expect(quickBox('First section')).toHaveValue('Unsent in first');
    expect(writes(calls, 'PATCH')).toHaveLength(1); expect(writes(calls, 'POST')).toHaveLength(0);
  });
});

describe('a cell clicked while explicit quick creates are still queued', () => {
  it('opens only after the whole queue drains and the list includes it, then writes the chosen status once', async () => {
    const first = deferred<Response>(); const second = deferred<Response>(); const posts = [first, second];
    const createdRows: TaskDto[] = []; let current = rootB; let sent = 0;
    const { calls } = installFakeApi(routes(() => [rootA, current, ...createdRows], {
      [`POST ${rootPath}/tasks`]: request => {
        const index = sent++; const title = (request.body as { title: string }).title;
        return (posts[index] ?? first).promise.then(() => {
          const row = { ...rootA, id: `f2000000-0000-4000-8000-00000000009${index}`, workPackageId: `f1000000-0000-4000-8000-00000000009${index}`, title, position: 2 + index };
          createdRows.push(row); return created(row);
        });
      },
      [`PATCH ${rootPath}/tasks/${rootB.id}`]: request => ok(current = { ...current, statusId: (request.body as { statusId: string }).statusId, revision: current.revision + 1 }),
    }));
    const { user } = renderApp(tablePath);
    await user.click(await screen.findByRole('button', { name: 'Add task to “First section”' }));
    await user.type(quickBox('First section'), 'Queued one{Enter}Queued two{Enter}');
    await waitFor(() => expect(writes(calls, 'POST')).toHaveLength(1));
    const savedTargetRow = () => within(screen.getByRole('button', { name: rootB.title }).closest('tr') as HTMLTableRowElement);
    await user.click(savedTargetRow().getByRole('button', { name: `Edit status for ${rootB.title}` }));
    // The normal next draft has its own editable Status; only this saved cell waits for the queue.
    expect(savedTargetRow().queryByRole('combobox', { name: 'Status' })).not.toBeInTheDocument();
    await act(async () => first.resolve(new Response()));
    await waitFor(() => expect(writes(calls, 'POST')).toHaveLength(2));
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)); });
    // The first answer momentarily leaves no held command while the second create is sent.
    expect(savedTargetRow().queryByRole('combobox', { name: 'Status' })).not.toBeInTheDocument();
    await act(async () => second.resolve(new Response()));
    const picker = await savedTargetRow().findByRole('combobox', { name: 'Status' });
    await waitFor(() => expect(picker).toHaveFocus());
    expect(screen.getByRole('listbox', { name: 'Status' })).toBeInTheDocument();
    expect(writes(calls, 'PATCH')).toHaveLength(0);
    await user.click(within(screen.getByRole('listbox', { name: 'Status' })).getByRole('option', { name: 'Stored progress' }));
    await waitFor(() => expect(writes(calls, 'PATCH')).toHaveLength(1));
    expect(writes(calls, 'PATCH')[0]?.body).toEqual({ expectedRevision: rootB.revision, statusId: NEXT_STATUS });
    expect(writes(calls, 'POST').map(call => (call.body as { title: string }).title)).toEqual(['Queued one', 'Queued two']);
  });
});
