import type { TaskDto } from '@workloom/contracts';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { beforeAll, describe, expect, it } from 'vitest';
import { alpha, alphaMembers, created, deferred, failure, installFakeApi, json, ok, renderApp, type RouteTable } from '../test/fakeApi';
import { lostResponse } from '../features/planning/test/fixtures';
import { PROJECT_ID, rootPath, task, tablePath, tableRoutes } from '../features/work-categories/test/fixtures';
beforeAll(async () => { await import('./ProjectPage'); });
const page = (rows: TaskDto[]) => json(200, { data: rows, meta: { requestId: 'rename-fixture', nextCursor: null } });
const preference = { workspaceId: alpha.id, projectId: PROJECT_ID, membershipId: alphaMembers[0]?.id, revision: 1, columns: [{ column: { kind: 'builtin', key: 'title' }, visible: true }, { column: { kind: 'builtin', key: 'dueDate' }, visible: false }] };
function routes(extra: RouteTable = {}): RouteTable { return { ...tableRoutes(), [`GET ${rootPath}/tasks`]: () => page([task]), [`GET ${rootPath}/tasks/${task.id}`]: () => ok(task), [`GET ${rootPath}/projects/${PROJECT_ID}/table-preferences/me`]: () => ok(preference), ...extra }; }
function views() { return within(screen.getByRole('navigation', { name: 'Project views' })); }
/** The visible task name is the rename target; details have their own action. */
const rename = (title = task.title) => screen.findByRole('button', { name: title });
const details = (title = task.title) => screen.findByRole('button', { name: `Open task “${title}”` });
const titleBox = () => within(screen.getByRole('form', { name: /in the task table$/ })).getByRole('textbox', { name: 'Task name' });

describe('project inline task title rename', () => {
  it('separates rename from details and Graph selection, keeps a title editor with Due hidden, and returns focus only after confirmed Save', async () => {
    let current = { ...task, revision: 4 }; const gate = deferred<Response>();
    const { calls } = installFakeApi(routes({ [`GET ${rootPath}/tasks`]: () => page([current]), [`GET ${rootPath}/tasks/${task.id}`]: () => ok(current), [`PATCH ${rootPath}/tasks/${task.id}`]: () => gate.promise }));
    const { user } = renderApp(tablePath);
    await user.click(await screen.findByRole('button', { name: `Select task: ${task.title}` }));
    await user.click(await rename()); const input = titleBox(); expect(input).toHaveFocus(); expect(input).toHaveValue(task.title);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument(); expect(screen.queryByRole('columnheader', { name: 'Due date' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Finish or collapse the current field edit first.' })).toBeDisabled();
    await user.clear(input); await user.type(input, '  Everyday renamed task  '); await user.keyboard('{Control>}{Enter}{/Control}');
    await waitFor(() => expect(calls.filter(call => call.method === 'PATCH')).toHaveLength(1));
    expect(calls.find(call => call.method === 'PATCH')?.body).toEqual({ expectedRevision: 4, title: 'Everyday renamed task' });
    expect(screen.queryByRole('button', { name: 'Everyday renamed task' })).not.toBeInTheDocument();
    expect(input).toHaveAttribute('readonly'); expect(input).toHaveFocus();
    await act(async () => gate.resolve(ok(current = { ...current, title: 'Everyday renamed task', revision: 5 })));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Everyday renamed task' })).toHaveFocus());
    expect(screen.queryByRole('form', { name: /^Add a task to/ })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Select task: Everyday renamed task' })).toHaveAttribute('aria-pressed', 'true');
    await user.click(await details('Everyday renamed task'));
    expect(within(await screen.findByRole('dialog')).getByLabelText('Task name')).toHaveValue('Everyday renamed task');
  });

  it('continues a plain Enter rename into the next focused quick task in the same section, without extra writes', async () => {
    let current = { ...task, revision: 4 };
    const { calls } = installFakeApi(routes({
      [`GET ${rootPath}/tasks`]: () => page([current]),
      [`PATCH ${rootPath}/tasks/${task.id}`]: () => ok(current = { ...current, title: 'Renamed then next', revision: 5 }),
      [`POST ${rootPath}/tasks`]: request => created({ ...task, id: 'f2000000-0000-4000-8000-000000000077', title: (request.body as { title: string }).title, position: 1 }),
    }));
    const { user } = renderApp(tablePath);
    await user.click(await rename()); fireEvent.change(titleBox(), { target: { value: 'Renamed then next' } });
    await user.keyboard('{Enter}');
    const quick = within(await screen.findByRole('form', { name: 'Add a task to No section' }));
    await waitFor(() => expect(quick.getByRole('textbox', { name: 'Task name' })).toHaveFocus());
    expect(calls.filter(call => call.method !== 'GET')).toHaveLength(1);
    await user.keyboard('Next fast task{Enter}');
    await waitFor(() => expect(calls.filter(call => call.method === 'POST')).toHaveLength(1));
    expect(calls.find(call => call.method === 'POST')?.body).toMatchObject({ projectId: PROJECT_ID, title: 'Next fast task' });
    await waitFor(() => expect(quick.getByRole('textbox', { name: 'Task name' })).toHaveValue(''));
    expect(quick.getByRole('textbox', { name: 'Task name' })).toHaveFocus();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('opens the next editable title before the rename ACK and holds explicit creates until that result is known', async () => {
    const gate = deferred<Response>(); let current = task;
    const { calls } = installFakeApi(routes({
      [`GET ${rootPath}/tasks`]: () => page([current]),
      [`PATCH ${rootPath}/tasks/${task.id}`]: () => gate.promise,
      [`POST ${rootPath}/tasks`]: request => created({ ...task, id: 'f2000000-0000-4000-8000-000000000078', title: (request.body as { title: string }).title }),
    }));
    const { user } = renderApp(tablePath);
    await user.click(await rename()); fireEvent.change(titleBox(), { target: { value: 'Held rename then next' } });
    await user.keyboard('{Enter}');
    const quick = within(await screen.findByRole('form', { name: 'Add a task to No section' }));
    const next = quick.getByRole('textbox', { name: 'Task name' });
    expect(next).toHaveValue(''); expect(next).not.toHaveAttribute('readonly'); expect(next).toHaveFocus();
    await user.keyboard('Queued after rename{Enter}Unsent after queue');
    expect(calls.filter(call => call.method === 'POST')).toHaveLength(0);
    const search = screen.getByLabelText('Search tasks'); await user.click(search);
    await act(async () => gate.resolve(ok(current = { ...task, title: 'Held rename then next', revision: task.revision + 1 })));
    await waitFor(() => expect(calls.filter(call => call.method === 'POST')).toHaveLength(1));
    expect(next).toHaveValue('Unsent after queue'); expect(search).toHaveFocus();
    expect(calls.filter(call => call.method === 'PATCH')).toHaveLength(1);
    expect(calls.find(call => call.method === 'PATCH')?.body).toEqual({ expectedRevision: task.revision, title: 'Held rename then next' });
    expect(calls.find(call => call.method === 'POST')?.body).toEqual({ projectId: PROJECT_ID, title: 'Queued after rename', statusId: task.statusId, insertion: { anchorTaskId: task.id, placement: 'after' } });
  });

  it('continues an unchanged plain Enter into the next quick task and Escape returns to its source title without writes', async () => {
    const { calls } = installFakeApi(routes()); const { user } = renderApp(tablePath);
    await user.click(await rename()); await user.keyboard('{Enter}');
    const quick = await screen.findByRole('form', { name: 'Add a task to No section' });
    await waitFor(() => expect(within(quick).getByRole('textbox', { name: 'Task name' })).toHaveFocus());
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.getByRole('button', { name: task.title })).toHaveFocus());
    expect(calls.filter(call => call.method !== 'GET')).toHaveLength(0);
  });

  it('cancels an escaped title, then autosaves only the newly edited title when leaving for Board', async () => {
    const gate = deferred<Response>(); let current = task;
    const { calls } = installFakeApi(routes({
      [`GET ${rootPath}/tasks`]: () => page([current]),
      [`GET ${rootPath}/tasks/${task.id}`]: () => ok(current),
      [`PATCH ${rootPath}/tasks/${task.id}`]: () => gate.promise,
    }));
    const { user } = renderApp(tablePath);
    await user.click(await rename()); fireEvent.change(titleBox(), { target: { value: 'Canceled inline title' } });
    await user.keyboard('{Escape}'); expect(await rename()).toHaveFocus();
    expect(calls.filter(call => call.method !== 'GET')).toHaveLength(0);
    await user.keyboard('{Enter}'); expect(titleBox()).toHaveValue(task.title);
    fireEvent.change(titleBox(), { target: { value: 'Kept inline title' } });
    await user.click(views().getByRole('button', { name: 'Board' })); await screen.findByRole('region', { name: 'Task status lanes' });
    expect(screen.queryByLabelText('Task name')).not.toBeInTheDocument();
    await waitFor(() => expect(calls.filter(call => call.method === 'PATCH')).toHaveLength(1));
    expect(calls.find(call => call.method === 'PATCH')?.body).toEqual({ expectedRevision: task.revision, title: 'Kept inline title' });
    await user.click(screen.getByRole('button', { name: 'Resume original editor' }));
    expect(within(await screen.findByRole('dialog')).getByLabelText('Task name')).toHaveValue('Kept inline title');
    await act(async () => gate.resolve(ok(current = { ...task, title: 'Kept inline title', revision: task.revision + 1 })));
    await waitFor(() => expect(within(screen.getByRole('dialog')).getByLabelText('Task name')).not.toHaveAttribute('readonly'));
    expect(calls.filter(call => call.method !== 'GET')).toHaveLength(1);
  });

  it('autosaves a drawer title before rename opens its confirmed value without a second write', async () => {
    let current = task;
    const { calls } = installFakeApi(routes({
      [`GET ${rootPath}/tasks`]: () => page([current]),
      [`GET ${rootPath}/tasks/${task.id}`]: () => ok(current),
      [`PATCH ${rootPath}/tasks/${task.id}`]: () => ok(current = { ...task, title: 'Rich origin title', revision: task.revision + 1 }),
    }));
    const { user } = renderApp(tablePath);
    await user.click(await details());
    fireEvent.change(within(await screen.findByRole('dialog')).getByLabelText('Task name'), { target: { value: 'Rich origin title' } });
    await user.keyboard('{Escape}'); await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    await waitFor(() => expect(calls.filter(call => call.method !== 'GET')).toHaveLength(1));
    expect(calls.find(call => call.method === 'PATCH')?.body).toEqual({ expectedRevision: task.revision, title: 'Rich origin title' });
    await user.click(await rename('Rich origin title')); expect(titleBox()).toHaveValue('Rich origin title');
    expect(screen.queryByRole('button', { name: 'Resume draft' })).not.toBeInTheDocument();
    await user.keyboard('{Escape}');
    expect(calls.filter(call => call.method !== 'GET')).toHaveLength(1);
  });

  it('retries the original lost title acknowledgement after collapsing and reopening with exact bytes and key', async () => {
    const gate = lostResponse(); let attempts = 0; let current = task;
    const { calls } = installFakeApi(routes({ [`GET ${rootPath}/tasks`]: () => page([current]), [`PATCH ${rootPath}/tasks/${task.id}`]: () => ++attempts === 1 ? gate.promise : ok(current = { ...task, title: 'Exact title retry', revision: 2 }) }));
    const { user } = renderApp(tablePath); await user.click(await rename());
    fireEvent.change(titleBox(), { target: { value: 'Exact title retry' } }); await user.keyboard('{Control>}{Enter}{/Control}'); await waitFor(() => expect(attempts).toBe(1));
    await act(async () => gate.lose());
    const retry = await screen.findByRole('button', { name: 'Retry' });
    expect(retry.closest('form')).toBe(screen.getByRole('form', { name: /in the task table$/ }));
    await user.click(screen.getByRole('button', { name: 'Collapse editor' })); await user.click(await rename()); expect(titleBox()).toHaveAttribute('readonly');
    expect(titleBox()).toHaveValue('Exact title retry'); await user.click(screen.getByRole('button', { name: 'Retry' }));
    await rename('Exact title retry'); const writes = calls.filter(call => call.method === 'PATCH'); expect(writes).toHaveLength(2);
    expect(writes[0]?.body).toEqual({ expectedRevision: task.revision, title: 'Exact title retry' }); expect(writes[1]?.body).toEqual(writes[0]?.body);
    expect(writes[0]?.headers.get('Idempotency-Key')).toBeTruthy(); expect(writes[1]?.headers.get('Idempotency-Key')).toBe(writes[0]?.headers.get('Idempotency-Key'));
    // An explicit Retry never continues into a new task.
    expect(screen.queryByRole('form', { name: /^Add a task to/ })).not.toBeInTheDocument();
  });

  it('clears a hidden pending title session after late confirmation without focus or navigation changes', async () => {
    const gate = deferred<Response>(); let current = task;
    const { calls } = installFakeApi(routes({ [`GET ${rootPath}/tasks`]: request => page(request.searchParams.has('search') ? [] : [current]), [`PATCH ${rootPath}/tasks/${task.id}`]: () => gate.promise }));
    const { user } = renderApp(tablePath); await user.click(await rename()); fireEvent.change(titleBox(), { target: { value: 'Confirmed elsewhere' } });
    await user.keyboard('{Enter}'); await waitFor(() => expect(calls.some(call => call.method === 'PATCH')).toBe(true));
    await user.click(views().getByRole('button', { name: 'Board' })); await user.type(screen.getByLabelText('Search tasks'), 'hidden');
    await screen.findByRole('button', { name: 'Resume original editor' }); const search = screen.getByLabelText('Search tasks'); expect(search).toHaveFocus();
    await act(async () => gate.resolve(ok(current = { ...task, title: 'Confirmed elsewhere', revision: 2 })));
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Resume original editor' })).not.toBeInTheDocument());
    expect(search).toHaveFocus(); expect(screen.queryByRole('dialog')).not.toBeInTheDocument(); expect(screen.queryByRole('form', { name: /^Add a task to/ })).not.toBeInTheDocument();
    await user.clear(search); await screen.findByRole('button', { name: 'Confirmed elsewhere' }); await user.click(views().getByRole('button', { name: 'Tasks' }));
    await user.click(await rename('Confirmed elsewhere')); expect(titleBox()).toHaveValue('Confirmed elsewhere');
    await user.keyboard('{Control>}{Enter}{/Control}'); expect(calls.filter(call => call.method === 'PATCH')).toHaveLength(1);
  });

  it('keeps a refused revision and title visible for explicit review without exposing server copy', async () => {
    const { calls } = installFakeApi(routes({ [`PATCH ${rootPath}/tasks/${task.id}`]: () => failure(409, 'REVISION_CONFLICT', 'private title details') }));
    const { user } = renderApp(tablePath); await user.click(await rename()); fireEvent.change(titleBox(), { target: { value: 'Unconfirmed name' } });
    await user.keyboard('{Control>}{Enter}{/Control}'); await screen.findByRole('alert'); expect(titleBox()).toHaveValue('Unconfirmed name');
    expect(screen.queryByRole('form', { name: /^Add a task to/ })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save' })).toHaveAttribute('aria-disabled', 'true'); expect(screen.queryByText('private title details')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Save' })); expect(calls.filter(call => call.method === 'PATCH')).toHaveLength(1);
    await user.click(screen.getByRole('button', { name: 'More details' })); expect(within(await screen.findByRole('dialog')).getByLabelText('Task name')).toHaveValue('Unconfirmed name');
  });

  it.each(['answered', 'moved-focus', 'unknown'] as const)('opens a cell clicked during another task save only after a confirmed answer (%s)', async outcome => {
    const second: TaskDto = { ...task, id: 'f2000000-0000-4000-8000-000000000055', title: 'Second fast row', workPackageId: 'f1000000-0000-4000-8000-000000000055', position: 1 };
    const gate = deferred<Response>(); const lost = lostResponse(); let current = task;
    const { calls } = installFakeApi(routes({ [`GET ${rootPath}/tasks`]: () => page([current, second]), [`PATCH ${rootPath}/tasks/${task.id}`]: () => outcome === 'unknown' ? lost.promise : gate.promise }));
    const { user } = renderApp(tablePath); await user.click(await rename());
    fireEvent.change(titleBox(), { target: { value: 'First fast row' } }); await user.keyboard('{Control>}{Enter}{/Control}');
    await waitFor(() => expect(calls.filter(call => call.method === 'PATCH')).toHaveLength(1));
    await user.click(screen.getByRole('button', { name: second.title }));
    // One command at a time: the second editor waits instead of racing the first save.
    expect(screen.queryByDisplayValue(second.title)).not.toBeInTheDocument();
    if (outcome === 'moved-focus') await user.click(screen.getByLabelText('Search tasks'));
    if (outcome === 'unknown') await act(async () => lost.lose());
    else await act(async () => gate.resolve(ok(current = { ...task, title: 'First fast row', revision: 2 })));
    if (outcome === 'answered') await waitFor(() => expect(screen.getByDisplayValue(second.title)).toHaveFocus());
    else {
      await (outcome === 'unknown' ? screen.findByRole('button', { name: 'Retry' }) : screen.findByRole('button', { name: 'First fast row' }));
      expect(screen.queryByDisplayValue(second.title)).not.toBeInTheDocument();
      if (outcome === 'moved-focus') expect(screen.getByLabelText('Search tasks')).toHaveFocus();
    }
    expect(calls.filter(call => call.method === 'PATCH')).toHaveLength(1);
  });

  it('keeps viewers read-only while the task title still opens details', async () => {
    const { calls } = installFakeApi(routes({ 'GET /api/v1/workspaces': () => ok([{ ...alpha, role: 'viewer' }]), [`GET ${rootPath}`]: () => ok({ ...alpha, role: 'viewer' }) }));
    const { user } = renderApp(tablePath); const title = await rename();
    expect(title).not.toHaveAttribute('data-task-cell');
    await user.click(title);
    await screen.findByRole('dialog'); expect(screen.queryByRole('form', { name: /in the task table$/ })).not.toBeInTheDocument();
    expect(calls.filter(call => call.method !== 'GET')).toHaveLength(0);
  });
});
