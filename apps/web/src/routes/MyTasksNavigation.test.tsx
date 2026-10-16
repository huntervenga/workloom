import type { MyTaskDto } from '@workloom/contracts';
import { QueryClientProvider } from '@tanstack/react-query';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeAll, describe, expect, it } from 'vitest';
import { createMemoryRouter, Outlet, RouterProvider, useBlocker } from 'react-router';
import { AppRoutes } from '../app/AppRoutes';
import { SessionProvider } from '../app/session';
import { useMyTasksLens } from '../features/my-tasks/navigation';
import { task, PROJECT_ID, rootPath } from '../features/planning/test/fixtures';
import { tableRoutes } from '../features/work-categories/test/fixtures';
import { createQueryClient } from '../lib/queryClient';
import { queryKeys } from '../lib/queryKeys';
import { alpha, alphaMembers, anna, boris, installFakeApi, json, ok, type RouteTable } from '../test/fakeApi';
import { MyTasksPage } from './MyTasksPage';

beforeAll(async () => { await import('./ProjectPage'); });
const path = `/w/${alpha.id}/my-tasks`;
const apiPath = `${rootPath}/my-tasks`;
const row: MyTaskDto = { task, project: { id: PROJECT_ID, name: 'Stored project', archivedAt: null }, status: { id: task.statusId, name: 'Stored status', group: 'todo' } };
const page = (rows: MyTaskDto[] = [row]) => json(200, { data: rows, meta: { requestId: 'my-navigation', nextCursor: null } });
function api(extra: RouteTable = {}) { return installFakeApi({ ...tableRoutes(), [`GET ${apiPath}`]: () => page(), [`GET ${rootPath}/tasks/${task.id}`]: () => ok(task), ...extra }); }
function app(url: string) {
  const client = createQueryClient({ retry: false });
  const router = createMemoryRouter([{ path: '*', element: <SessionProvider><AppRoutes /></SessionProvider> }], { initialEntries: [url] });
  const view = render(<QueryClientProvider client={client}><RouterProvider router={router} /></QueryClientProvider>);
  return { ...view, client, router, user: userEvent.setup({ pointerEventsCheck: 0 }) };
}
const input = () => screen.getByRole('textbox', { name: 'Search my tasks' });
const relation = () => screen.getByRole('combobox', { name: 'My involvement' });
const completion = () => screen.getByRole('combobox', { name: 'Show' });

it('restores the applied lens after opening a real task and going Back, and after a fresh page mount', async () => {
  const { calls } = api(); const ui = app(`${path}?other=kept#anchor`);
  await screen.findByRole('link', { name: `Open task “${task.title}”` });
  await ui.user.selectOptions(relation(), 'participating'); await ui.user.selectOptions(completion(), 'all');
  await ui.user.click(screen.getByRole('checkbox', { name: 'Include archived' })); await ui.user.type(input(), '  Applied text  ');
  await ui.user.click(screen.getByRole('button', { name: 'Apply search' }));
  await waitFor(() => expect(ui.router.state.location.search).toContain('search=Applied+text'));
  const applied = `${ui.router.state.location.pathname}${ui.router.state.location.search}${ui.router.state.location.hash}`;
  await ui.user.click(screen.getByRole('link', { name: `Open task “${task.title}”` }));
  await screen.findByRole('dialog', { name: task.title }); expect(ui.router.state.location.pathname).toContain(`/projects/${PROJECT_ID}`);
  await act(async () => ui.router.navigate(-1));
  await screen.findByRole('heading', { name: 'My tasks' }); expect(relation()).toHaveValue('participating'); expect(completion()).toHaveValue('all');
  expect(screen.getByRole('checkbox', { name: 'Include archived' })).toBeChecked(); expect(input()).toHaveValue('Applied text');
  expect(ui.router.state.location.hash).toBe('#anchor'); expect(ui.router.state.location.search).toContain('other=kept');
  ui.unmount(); const reload = app(applied);
  await screen.findByRole('link', { name: `Open task “${task.title}”` }); expect(relation()).toHaveValue('participating'); expect(completion()).toHaveValue('all'); expect(input()).toHaveValue('Applied text');
  const last = calls.filter(call => call.path === apiPath).at(-1); expect(last?.searchParams.get('search')).toBe('Applied text'); expect(last?.searchParams.get('includeArchived')).toBe('true');
  expect(reload.router.state.location.hash).toBe('#anchor'); expect(calls.filter(call => call.method !== 'GET')).toHaveLength(0);
});

it('keeps unsent search typing local through other filter changes and restores applied search with Back', async () => {
  const { calls } = api(); const ui = app(`${path}?search=First`);
  await screen.findByRole('link', { name: `Open task “${task.title}”` }); const field = input();
  await ui.user.clear(field); await ui.user.type(field, 'Second draft');
  expect(ui.router.state.location.search).toBe('?search=First'); expect(calls.filter(call => call.path === apiPath)).toHaveLength(1);
  await ui.user.selectOptions(completion(), 'closed'); expect(field).toHaveValue('Second draft');
  await waitFor(() => expect(calls.filter(call => call.path === apiPath).at(-1)?.searchParams.get('completion')).toBe('closed'));
  expect(calls.filter(call => call.path === apiPath).at(-1)?.searchParams.get('search')).toBe('First');
  field.focus(); await ui.user.keyboard('{Enter}');
  await waitFor(() => expect(ui.router.state.location.search).toContain('search=Second+draft')); expect(input()).toBe(field); expect(field).toHaveFocus();
  await act(async () => ui.router.navigate(-1)); expect(input()).toHaveValue('First'); expect(completion()).toHaveValue('closed');
  await act(async () => ui.router.navigate(-1)); expect(input()).toHaveValue('First'); expect(completion()).toHaveValue('open');
});

describe('validated applied URL values', () => {
  it.each([
    ['relation=unknown&completion=closed&includeArchived=1', 'all', 'closed', false, ''],
    ['relation=assigned&completion=unknown&includeArchived=false&search=+padded+', 'assigned', 'open', false, 'padded'],
    ['relation=assigned&relation=participating&completion=all&includeArchived=true&includeArchived=false&search=a&search=b', 'all', 'all', false, ''],
    [`relation=participating&includeArchived=True&search=${'x'.repeat(201)}`, 'participating', 'open', false, ''],
    [`search=${'x'.repeat(200)}&includeArchived=true`, 'all', 'open', true, 'x'.repeat(200)],
  ] as const)('uses safe per-field values for %s without navigation or identity/paging injection', async (query, involvement, shown, archived, search) => {
    const { calls } = api(); const suffix = `${query}&actorId=${boris.id}&membershipId=${alphaMembers[1]?.id}&workspaceId=foreign&projectId=foreign&limit=1&cursor=foreign&other=kept`;
    const ui = app(`${path}?${suffix}#anchor`); const initialKey = ui.router.state.location.key;
    await screen.findByRole('link', { name: `Open task “${task.title}”` });
    expect(relation()).toHaveValue(involvement); expect(completion()).toHaveValue(shown); expect(screen.getByRole('checkbox', { name: 'Include archived' })).toHaveProperty('checked', archived); expect(input()).toHaveValue(search);
    const request = calls.find(call => call.path === apiPath); expect(request?.searchParams.get('relation')).toBe(involvement); expect(request?.searchParams.get('completion')).toBe(shown); expect(request?.searchParams.get('includeArchived')).toBe(String(archived));
    expect(request?.searchParams.get('search') ?? '').toBe(search); expect(request?.searchParams.get('limit')).toBe('50');
    for (const key of ['actorId', 'membershipId', 'workspaceId', 'projectId', 'cursor']) expect(request?.searchParams.has(key)).toBe(false);
    expect(ui.router.state.location.search).toBe(`?${suffix}`); expect(ui.router.state.location.hash).toBe('#anchor'); expect(ui.router.state.location.key).toBe(initialKey);
  });
});

it('uses the current actor after session identity changes and never forwards a URL-selected actor or a prior local draft', async () => {
  let actor = anna; const second = { ...row, task: { ...task, id: 'f2000000-0000-4000-8000-000000000002', title: 'Boris current task' } };
  const { calls } = api({ 'GET /api/v1/me': () => ok({ actor, authMode: 'dev' }), [`GET ${apiPath}`]: () => page(actor.id === anna.id ? [row] : [second]) });
  const url = `${path}?relation=assigned&search=Applied&actorId=${anna.id}`; const ui = app(url);
  await screen.findByRole('link', { name: `Open task “${task.title}”` }); await ui.user.clear(input()); await ui.user.type(input(), 'Anna unsent private draft');
  actor = boris; await act(async () => { await ui.client.refetchQueries({ queryKey: queryKeys.me, exact: true }); });
  await waitFor(() => expect(ui.router.state.location.pathname).not.toBe(path));
  await act(async () => ui.router.navigate(url)); await screen.findByRole('link', { name: 'Open task “Boris current task”' });
  expect(screen.queryByRole('link', { name: `Open task “${task.title}”` })).not.toBeInTheDocument(); expect(input()).toHaveValue('Applied');
  const personal = ui.client.getQueryCache().getAll().filter(query => query.queryKey.includes('my'));
  expect(personal.every(query => query.queryKey[1] === boris.id)).toBe(true);
  expect(calls.filter(call => call.path === apiPath).every(call => !call.searchParams.has('actorId') && !call.searchParams.has('membershipId'))).toBe(true);
});

it('keeps search typing and the current query unchanged when normal router blockers refuse applying the lens', async () => {
  const { calls } = api(); const client = createQueryClient({ retry: false });
  function Parent() { const blocker = useBlocker(() => true); return <><output data-testid="blocker">{blocker.state}</output><Outlet context={{ actorId: anna.id, workspace: alpha }} /></>; }
  const router = createMemoryRouter([{ element: <Parent />, children: [{ path, element: <MyTasksPage /> }] }], { initialEntries: [path] });
  render(<QueryClientProvider client={client}><RouterProvider router={router} /></QueryClientProvider>); const user = userEvent.setup();
  await screen.findByRole('link', { name: `Open task “${task.title}”` }); await user.type(input(), 'Not applied'); await user.click(screen.getByRole('button', { name: 'Apply search' }));
  expect(screen.getByTestId('blocker')).toHaveTextContent('blocked'); expect(router.state.location.search).toBe(''); expect(input()).toHaveValue('Not applied');
  expect(calls.filter(call => call.path === apiPath)).toHaveLength(1);
});

for (const order of ['relation-completion', 'completion-relation', 'search-archive', 'archive-search'] as const) {
  it(`applies both retained control callbacks in ${order} order without waiting for a render`, async () => {
    let retained: ReturnType<typeof useMyTasksLens> | undefined;
    function Page() { const lens = useMyTasksLens(); retained ??= lens; return <p>Lens test</p>; }
    const router = createMemoryRouter([{ path, element: <Page /> }], { initialEntries: [`${path}?other=kept#anchor`] });
    render(<RouterProvider router={router} />); if (!retained) throw new Error('Missing retained controls'); const first = retained;
    await act(async () => {
      if (order === 'relation-completion') { first.changeRelation('assigned'); first.changeCompletion('closed'); }
      else if (order === 'completion-relation') { first.changeCompletion('closed'); first.changeRelation('assigned'); }
      else if (order === 'search-archive') { first.applySearch('Applied'); first.changeArchived(true); }
      else { first.changeArchived(true); first.applySearch('Applied'); }
    });
    const current = new URLSearchParams(router.state.location.search);
    if (order.includes('relation')) { expect(current.get('relation')).toBe('assigned'); expect(current.get('completion')).toBe('closed'); }
    else { expect(current.get('search')).toBe('Applied'); expect(current.get('includeArchived')).toBe('true'); }
    expect(current.get('other')).toBe('kept'); expect(router.state.location.hash).toBe('#anchor');
    await act(async () => router.navigate(-1)); const previous = new URLSearchParams(router.state.location.search);
    if (order === 'relation-completion') { expect(previous.get('relation')).toBe('assigned'); expect(previous.has('completion')).toBe(false); }
    if (order === 'completion-relation') { expect(previous.get('completion')).toBe('closed'); expect(previous.has('relation')).toBe(false); }
    if (order === 'search-archive') { expect(previous.get('search')).toBe('Applied'); expect(previous.has('includeArchived')).toBe(false); }
    if (order === 'archive-search') { expect(previous.get('includeArchived')).toBe('true'); expect(previous.has('search')).toBe(false); }
  });
}
