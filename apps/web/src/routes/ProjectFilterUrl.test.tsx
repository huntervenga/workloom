import type * as ChoicePickerModule from '../shared/ChoicePicker';
import type { ComponentProps } from 'react';
import type { TagDto } from '@workloom/contracts';
import { QueryClientProvider } from '@tanstack/react-query';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { AppRoutes } from '../app/AppRoutes';
import { ProtectedNavigationGuard } from '../app/ProtectedNavigationGuard';
import { SessionProvider } from '../app/session';
import { createQueryClient } from '../lib/queryClient';
import { alpha, alphaMembers, installFakeApi, ok, type RouteTable } from '../test/fakeApi';
import { chooseFilter, filterPicker } from '../features/tasks/test/filterPickers';
import { MEMBER_ID, PERIOD_A, rootPath, task, legacyTablePath, tablePath, tableRoutes } from '../features/work-categories/test/fixtures';

const pickerCallbacks = vi.hoisted(() => new Map<string, (value: string) => void>());
vi.mock('../shared/ChoicePicker', async importOriginal => {
  const actual = await importOriginal<typeof ChoicePickerModule>();
  return { ...actual, ChoicePicker: (props: ComponentProps<typeof actual.ChoicePicker>) => {
    pickerCallbacks.set(props.label, props.onValueChange);
    return <actual.ChoicePicker {...props} />;
  } };
});
function retainedPicker(label: string) {
  const callback = pickerCallbacks.get(label);
  if (!callback) throw new Error(`Missing picker callback ${label}`);
  return callback;
}

beforeAll(async () => { await import('./ProjectPage'); });
const STATUS_NAME = 'Запланировано';
const member = alphaMembers.find(item => item.id === MEMBER_ID); if (!member) throw new Error('Missing member fixture');
const tag: TagDto = { id: 'f7000000-0000-4000-8000-000000000001', workspaceId: alpha.id, name: 'Synthetic filter tag', color: null, revision: 1, archivedAt: null };
const UNKNOWN = 'f9000000-0000-4000-8000-000000000099';

const cleanups: (() => void)[] = [];
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); });
function app(url: string, extra: RouteTable = {}) {
  const api = installFakeApi({ ...tableRoutes(), [`GET ${rootPath}/tags`]: () => ok([tag]), [`GET ${rootPath}/tasks/${task.id}`]: () => ok(task), ...extra });
  const client = createQueryClient({ retry: false });
  const router = createMemoryRouter([{ path: '*', element: <SessionProvider><ProtectedNavigationGuard /><AppRoutes /></SessionProvider> }], { initialEntries: [url] });
  const view = render(<QueryClientProvider client={client}><RouterProvider router={router} /></QueryClientProvider>);
  cleanups.push(() => { view.unmount(); router.dispose(); client.clear(); });
  return { ...view, ...api, client, router, user: userEvent.setup({ pointerEventsCheck: 0 }) };
}
type Calls = ReturnType<typeof installFakeApi>['calls'];
const taskCalls = (calls: Calls) => calls.filter(call => call.method === 'GET' && call.path === `${rootPath}/tasks`);
const writes = (calls: Calls) => calls.filter(call => call.method !== 'GET');
const params = (ui: ReturnType<typeof app>) => new URLSearchParams(ui.router.state.location.search);
const views = () => within(screen.getByRole('navigation', { name: 'Project views' }));
async function openFilters(user: ReturnType<typeof app>['user']) {
  const summary = await screen.findByText(/^Filters/, { selector: 'summary' });
  if (!summary.closest('details')?.open) await user.click(summary);
}

describe('project filter URL state', () => {
  it('writes status/participant/tag/archived to the URL, keeps search in memory and preserves every other parameter', async () => {
    const ui = app(`${tablePath}?week=${PERIOD_A}&worker=${MEMBER_ID}&other=kept#anchor`);
    await screen.findByRole('button', { name: task.title }); await openFilters(ui.user);
    await chooseFilter(ui.user, 'Task status', STATUS_NAME);
    await chooseFilter(ui.user, 'Task participant', member.displayName);
    await chooseFilter(ui.user, 'Task tag', tag.name);
    await ui.user.click(screen.getByLabelText('Show archived tasks'));
    await waitFor(() => expect(params(ui).get('includeArchived')).toBe('true'));
    expect(Object.fromEntries(params(ui))).toEqual({ week: PERIOD_A, worker: MEMBER_ID, other: 'kept', status: task.statusId, participant: MEMBER_ID, tag: tag.id, includeArchived: 'true' });
    expect(ui.router.state.location.hash).toBe('#anchor');
    await waitFor(() => expect(taskCalls(ui.calls).at(-1)?.searchParams.get('includeArchived')).toBe('true'));
    const filtered = taskCalls(ui.calls).at(-1);
    expect(filtered?.searchParams.get('statusId')).toBe(task.statusId); expect(filtered?.searchParams.get('participantMembershipId')).toBe(MEMBER_ID); expect(filtered?.searchParams.get('tagId')).toBe(tag.id);
    // Search typing never navigates; it reaches the server only as the debounced request filter.
    const key = ui.router.state.location.key;
    await ui.user.type(screen.getByRole('searchbox', { name: 'Search tasks' }), 'memory only');
    await waitFor(() => expect(taskCalls(ui.calls).at(-1)?.searchParams.get('search')).toBe('memory only'));
    expect(ui.router.state.location.key).toBe(key); expect(params(ui).has('search')).toBe(false);
    expect(taskCalls(ui.calls).at(-1)?.searchParams.get('tagId')).toBe(tag.id);
    expect(writes(ui.calls)).toHaveLength(0);
  });

  it('keeps filters and search through the task drawer, sort, view and week changes, and restores URL filters with Back and a fresh mount', async () => {
    const ui = app(legacyTablePath(`${tablePath}?status=${task.statusId}&tag=${tag.id}&other=kept#anchor`));
    await screen.findByRole('button', { name: task.title });
    await ui.user.type(screen.getByRole('searchbox', { name: 'Search tasks' }), 'kept text');
    await ui.user.click(screen.getByRole('button', { name: `Open task “${task.title}”` }));
    await screen.findByRole('dialog', { name: task.title });
    expect(params(ui).get('task')).toBe(task.id); expect(params(ui).get('status')).toBe(task.statusId); expect(params(ui).get('tag')).toBe(tag.id);
    await ui.user.keyboard('{Escape}'); await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(params(ui).has('task')).toBe(false); expect(params(ui).get('status')).toBe(task.statusId);
    await act(async () => { retainedPicker('Sort')('due_asc'); });
    await waitFor(() => expect(params(ui).get('sort')).toBe('due_asc'));
    await act(async () => { retainedPicker('Week for hours')(PERIOD_A); });
    await waitFor(() => expect(params(ui).get('week')).toBe(PERIOD_A));
    await ui.user.click(views().getByRole('button', { name: 'Board' }));
    await screen.findByRole('region', { name: 'Task status lanes' });
    expect(Object.fromEntries(params(ui))).toEqual({ status: task.statusId, tag: tag.id, other: 'kept', sort: 'due_asc', week: PERIOD_A, view: 'board', legacyTime: '1' });
    expect(screen.getByRole('searchbox', { name: 'Search tasks' })).toHaveValue('kept text');
    expect(filterPicker('Task status')).toHaveTextContent(STATUS_NAME); expect(filterPicker('Task tag')).toHaveTextContent(tag.name);
    // The table query carries every kept filter together (other reads, such as the drawer's, are separate).
    await waitFor(() => expect(taskCalls(ui.calls).some(call => call.searchParams.get('statusId') === task.statusId && call.searchParams.get('tagId') === tag.id
      && call.searchParams.get('sort') === 'due_asc' && call.searchParams.get('search') === 'kept text')).toBe(true));

    // Back removes the latest filter change only; filters made before it stay.
    await openFilters(ui.user); await chooseFilter(ui.user, 'Task participant', member.displayName);
    await waitFor(() => expect(params(ui).get('participant')).toBe(MEMBER_ID));
    await act(async () => ui.router.navigate(-1));
    await waitFor(() => expect(filterPicker('Task participant')).toHaveTextContent('All participants'));
    expect(params(ui).get('status')).toBe(task.statusId); expect(params(ui).has('participant')).toBe(false);
    const reloadUrl = `${ui.router.state.location.pathname}${ui.router.state.location.search}${ui.router.state.location.hash}`;
    expect(writes(ui.calls)).toHaveLength(0);
    cleanups.splice(0).forEach(cleanup => cleanup());

    const reload = app(reloadUrl);
    await screen.findByRole('region', { name: 'Task status lanes' });
    expect(filterPicker('Task status')).toHaveTextContent(STATUS_NAME); expect(filterPicker('Task tag')).toHaveTextContent(tag.name);
    // Search text was memory only, so a fresh mount starts without it.
    expect(screen.getByRole('searchbox', { name: 'Search tasks' })).toHaveValue('');
    const first = taskCalls(reload.calls)[0];
    expect(first?.searchParams.get('statusId')).toBe(task.statusId); expect(first?.searchParams.get('tagId')).toBe(tag.id); expect(first?.searchParams.has('search')).toBe(false);
    expect(reload.router.state.location.hash).toBe('#anchor');
  });

  it.each([
    'status=not-a-uuid&participant=&tag=x&includeArchived=1',
    `status=${task.statusId}&status=${task.statusId}&participant=${MEMBER_ID}&participant=${MEMBER_ID}&includeArchived=True`,
    `statusId=${task.statusId}&participantMembershipId=${MEMBER_ID}&tagId=${tag.id}&includeArchived=false`,
  ])('ignores malformed or repeated filter values without rewriting the URL: %s', async query => {
    const ui = app(`${tablePath}?${query}&other=kept#anchor`); const key = ui.router.state.location.key;
    await screen.findByRole('button', { name: task.title }); await openFilters(ui.user);
    expect(filterPicker('Task status')).toHaveTextContent('All statuses'); expect(filterPicker('Task participant')).toHaveTextContent('All participants'); expect(filterPicker('Task tag')).toHaveTextContent('All tags');
    expect(screen.getByLabelText('Show archived tasks')).not.toBeChecked();
    expect(screen.queryByRole('group', { name: 'Active filters' })).not.toBeInTheDocument();
    const request = taskCalls(ui.calls)[0];
    for (const name of ['statusId', 'participantMembershipId', 'tagId', 'includeArchived', 'search']) expect(request?.searchParams.has(name)).toBe(false);
    expect(ui.router.state.location.search).toBe(`?${query}&other=kept`); expect(ui.router.state.location.key).toBe(key);
    expect(writes(ui.calls)).toHaveLength(0);
  });

  it('shows explicit unavailable choices for held URL references outside the catalog without raw IDs', async () => {
    const ui = app(`${tablePath}?status=${UNKNOWN}&participant=${UNKNOWN}&tag=${UNKNOWN}`, { [`GET ${rootPath}/tasks`]: () => ok([]) });
    await screen.findByRole('table'); await openFilters(ui.user);
    expect(filterPicker('Task status')).toHaveTextContent('Status unavailable');
    expect(filterPicker('Task participant')).toHaveTextContent('Participant unavailable');
    expect(filterPicker('Task tag')).toHaveTextContent('Tag unavailable');
    expect(screen.getByRole('button', { name: 'Clear status filter: Status unavailable' })).toBeInTheDocument();
    expect(document.body).not.toHaveTextContent(UNKNOWN);
    // The held filters are still the applied ones; they are never silently dropped or rewritten.
    const request = taskCalls(ui.calls)[0];
    expect(request?.searchParams.get('statusId')).toBe(UNKNOWN); expect(request?.searchParams.get('participantMembershipId')).toBe(UNKNOWN); expect(request?.searchParams.get('tagId')).toBe(UNKNOWN);
    await ui.user.click(screen.getByRole('button', { name: 'Clear filters' }));
    await waitFor(() => expect(ui.router.state.location.search).toBe(''));
    expect(writes(ui.calls)).toHaveLength(0);
  });

  it('shares one task query for equal filters regardless of parameter order or ID case', async () => {
    const ui = app(`${tablePath}?status=${task.statusId}&tag=${tag.id}`);
    await screen.findByRole('button', { name: task.title });
    expect(taskCalls(ui.calls)).toHaveLength(1);
    await act(async () => ui.router.navigate(`${tablePath}?tag=${tag.id.toUpperCase()}&other=x&status=${task.statusId}`));
    await act(async () => ui.router.navigate(`${tablePath}?tag=${tag.id}&status=${task.statusId.toUpperCase()}&task=${task.id}`));
    await screen.findByRole('dialog', { name: task.title });
    await ui.user.keyboard('{Escape}'); await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    // Only table-list reads with these filters count; the drawer may read its own scope.
    const filteredReads = taskCalls(ui.calls).filter(call => call.searchParams.has('statusId') || call.searchParams.has('tagId'));
    expect(filteredReads).toHaveLength(1);
    expect(filteredReads[0]?.searchParams.get('statusId')).toBe(task.statusId); expect(filteredReads[0]?.searchParams.get('tagId')).toBe(tag.id);
    expect(filterPicker('Task tag')).toHaveTextContent(tag.name);
    expect(writes(ui.calls)).toHaveLength(0);
  });

  it('applies two filter changes from one rendered control set without losing either', async () => {
    const ui = app(`${tablePath}?other=kept#anchor`);
    await screen.findByRole('button', { name: task.title }); await openFilters(ui.user);
    const status = retainedPicker('Task status'); const tagChoice = retainedPicker('Task tag');
    await act(async () => { status(task.statusId); tagChoice(tag.id); });
    await waitFor(() => expect(params(ui).get('tag')).toBe(tag.id));
    expect(params(ui).get('status')).toBe(task.statusId); expect(params(ui).get('other')).toBe('kept'); expect(ui.router.state.location.hash).toBe('#anchor');
    expect(writes(ui.calls)).toHaveLength(0);
  });
});
