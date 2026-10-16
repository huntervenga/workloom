import type { TaskDto } from '@workloom/contracts';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { beforeAll, describe, expect, it } from 'vitest';
import { alpha, alphaMembers, deferred, failure, installFakeApi, json, ok, renderApp, type RouteTable } from '../test/fakeApi';
import { lostResponse } from '../features/planning/test/fixtures';
import { PROJECT_ID, rootPath, task, tablePath, tableRoutes } from '../features/work-categories/test/fixtures';
beforeAll(async () => { await import('./ProjectPage'); });
const page = (rows: TaskDto[]) => json(200, { data: rows, meta: { requestId: 'rename-fixture', nextCursor: null } });
const preference = { workspaceId: alpha.id, projectId: PROJECT_ID, membershipId: alphaMembers[0]?.id, revision: 1, columns: [{ column: { kind: 'builtin', key: 'title' }, visible: true }, { column: { kind: 'builtin', key: 'dueDate' }, visible: false }] };
function routes(extra: RouteTable = {}): RouteTable { return { ...tableRoutes(), [`GET ${rootPath}/tasks`]: () => page([task]), [`GET ${rootPath}/tasks/${task.id}`]: () => ok(task), [`GET ${rootPath}/projects/${PROJECT_ID}/table-preferences/me`]: () => ok(preference), ...extra }; }
function views() { return within(screen.getByRole('navigation', { name: 'Project views' })); }
const rename = (title = task.title) => screen.findByRole('button', { name: `Rename ${title}` });

describe('project inline task title rename', () => {
  it('separates rename from opening and Graph selection, keeps a title editor with Due hidden, and returns focus only after confirmed Save', async () => {
    let current = { ...task, revision: 4 }; const gate = deferred<Response>();
    const { calls } = installFakeApi(routes({ [`GET ${rootPath}/tasks`]: () => page([current]), [`GET ${rootPath}/tasks/${task.id}`]: () => ok(current), [`PATCH ${rootPath}/tasks/${task.id}`]: () => gate.promise }));
    const { user } = renderApp(tablePath);
    await user.click(await screen.findByRole('checkbox', { name: `Select for graph: ${task.title}` }));
    await user.click(await rename()); const input = screen.getByLabelText('Task name'); expect(input).toHaveFocus();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument(); expect(screen.queryByRole('columnheader', { name: 'Due date' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Finish or collapse the current field edit first.' })).toBeDisabled();
    await user.clear(input); await user.type(input, '  Everyday renamed task  '); await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(calls.filter(call => call.method === 'PATCH')).toHaveLength(1));
    expect(calls.find(call => call.method === 'PATCH')?.body).toEqual({ expectedRevision: 4, title: 'Everyday renamed task' });
    expect(screen.queryByRole('button', { name: 'Everyday renamed task' })).not.toBeInTheDocument(); expect(input).toBeDisabled();
    await act(async () => gate.resolve(ok(current = { ...current, title: 'Everyday renamed task', revision: 5 })));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Rename Everyday renamed task' })).toHaveFocus());
    expect(screen.getByRole('checkbox', { name: 'Select for graph: Everyday renamed task' })).toBeChecked();
    await user.click(screen.getByRole('button', { name: 'Everyday renamed task' }));
    expect(within(await screen.findByRole('dialog')).getByLabelText('Task name')).toHaveValue('Everyday renamed task');
  });

  it('retains an escaped title and exposes hidden Board recovery through the rich drawer without saving', async () => {
    const { calls } = installFakeApi(routes()); const { user } = renderApp(tablePath);
    await user.click(await rename()); fireEvent.change(screen.getByLabelText('Task name'), { target: { value: 'Kept inline title' } });
    await user.keyboard('{Escape}'); expect(await rename()).toHaveFocus();
    await user.keyboard('{Enter}'); expect(screen.getByLabelText('Task name')).toHaveValue('Kept inline title');
    await user.click(views().getByRole('button', { name: 'Board' })); await screen.findByRole('region', { name: 'Task status lanes' });
    expect(screen.queryByLabelText('Task name')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Resume original editor' }));
    expect(within(await screen.findByRole('dialog')).getByLabelText('Task name')).toHaveValue('Kept inline title');
    expect(calls.filter(call => call.method !== 'GET')).toHaveLength(0);
  });

  it('never saves a preexisting drawer title-only draft through rename', async () => {
    const { calls } = installFakeApi(routes()); const { user } = renderApp(tablePath);
    await user.click(await screen.findByRole('button', { name: task.title }));
    fireEvent.change(within(await screen.findByRole('dialog')).getByLabelText('Task name'), { target: { value: 'Rich origin title' } });
    await user.keyboard('{Escape}'); await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    await user.click(await rename()); expect(screen.queryByLabelText('Task name')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Resume draft' }));
    expect(within(await screen.findByRole('dialog')).getByLabelText('Task name')).toHaveValue('Rich origin title'); expect(calls.filter(call => call.method !== 'GET')).toHaveLength(0);
  });

  it('retries the original lost title acknowledgement after collapsing and reopening with exact bytes and key', async () => {
    const gate = lostResponse(); let attempts = 0; let current = task;
    const { calls } = installFakeApi(routes({ [`GET ${rootPath}/tasks`]: () => page([current]), [`PATCH ${rootPath}/tasks/${task.id}`]: () => ++attempts === 1 ? gate.promise : ok(current = { ...task, title: 'Exact title retry', revision: 2 }) }));
    const { user } = renderApp(tablePath); await user.click(await rename());
    fireEvent.change(screen.getByLabelText('Task name'), { target: { value: 'Exact title retry' } }); await user.keyboard('{Enter}'); await waitFor(() => expect(attempts).toBe(1));
    await act(async () => gate.lose()); await screen.findByRole('button', { name: 'Retry' });
    await user.click(screen.getByRole('button', { name: 'Collapse editor' })); await user.click(await rename()); expect(screen.getByLabelText('Task name')).toBeDisabled();
    expect(screen.getByLabelText('Task name')).toHaveValue('Exact title retry'); await user.click(screen.getByRole('button', { name: 'Retry' }));
    await rename('Exact title retry'); const writes = calls.filter(call => call.method === 'PATCH'); expect(writes).toHaveLength(2);
    expect(writes[0]?.body).toEqual({ expectedRevision: task.revision, title: 'Exact title retry' }); expect(writes[1]?.body).toEqual(writes[0]?.body);
    expect(writes[0]?.headers.get('Idempotency-Key')).toBeTruthy(); expect(writes[1]?.headers.get('Idempotency-Key')).toBe(writes[0]?.headers.get('Idempotency-Key'));
  });

  it('clears a hidden pending title session after late confirmation without focus or navigation changes', async () => {
    const gate = deferred<Response>(); let current = task;
    const { calls } = installFakeApi(routes({ [`GET ${rootPath}/tasks`]: request => page(request.searchParams.has('search') ? [] : [current]), [`PATCH ${rootPath}/tasks/${task.id}`]: () => gate.promise }));
    const { user } = renderApp(tablePath); await user.click(await rename()); fireEvent.change(screen.getByLabelText('Task name'), { target: { value: 'Confirmed elsewhere' } });
    await user.keyboard('{Enter}'); await waitFor(() => expect(calls.some(call => call.method === 'PATCH')).toBe(true));
    await user.click(views().getByRole('button', { name: 'Board' })); await user.type(screen.getByLabelText('Search tasks'), 'hidden');
    await screen.findByRole('button', { name: 'Resume original editor' }); const search = screen.getByLabelText('Search tasks'); expect(search).toHaveFocus();
    await act(async () => gate.resolve(ok(current = { ...task, title: 'Confirmed elsewhere', revision: 2 })));
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Resume original editor' })).not.toBeInTheDocument());
    expect(search).toHaveFocus(); expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    await user.clear(search); await screen.findByRole('button', { name: 'Confirmed elsewhere' }); await user.click(views().getByRole('button', { name: 'Tasks' }));
    await user.click(await rename('Confirmed elsewhere')); expect(screen.getByLabelText('Task name')).toHaveValue('Confirmed elsewhere');
    await user.keyboard('{Enter}'); expect(calls.filter(call => call.method === 'PATCH')).toHaveLength(1);
  });

  it('keeps a refused revision and title visible for explicit review without exposing server copy', async () => {
    const { calls } = installFakeApi(routes({ [`PATCH ${rootPath}/tasks/${task.id}`]: () => failure(409, 'REVISION_CONFLICT', 'private title details') }));
    const { user } = renderApp(tablePath); await user.click(await rename()); fireEvent.change(screen.getByLabelText('Task name'), { target: { value: 'Unconfirmed name' } });
    await user.keyboard('{Enter}'); await screen.findByRole('alert'); expect(screen.getByLabelText('Task name')).toHaveValue('Unconfirmed name');
    expect(screen.getByRole('button', { name: 'Save' })).toHaveAttribute('aria-disabled', 'true'); expect(screen.queryByText('private title details')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Save' })); expect(calls.filter(call => call.method === 'PATCH')).toHaveLength(1);
    await user.click(screen.getByRole('button', { name: 'More details' })); expect(within(await screen.findByRole('dialog')).getByLabelText('Task name')).toHaveValue('Unconfirmed name');
  });

  it('keeps viewers read-only while the task title still opens details', async () => {
    const { calls } = installFakeApi(routes({ 'GET /api/v1/workspaces': () => ok([{ ...alpha, role: 'viewer' }]), [`GET ${rootPath}`]: () => ok({ ...alpha, role: 'viewer' }) }));
    const { user } = renderApp(tablePath); await user.click(await screen.findByRole('button', { name: task.title }));
    await screen.findByRole('dialog'); expect(screen.queryByRole('button', { name: `Rename ${task.title}` })).not.toBeInTheDocument();
    expect(calls.filter(call => call.method !== 'GET')).toHaveLength(0);
  });
});
