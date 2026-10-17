import type { TaskDto, TaskStatusDto } from '@workloom/contracts';
import { QueryClientProvider } from '@tanstack/react-query';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { AppRoutes } from '../app/AppRoutes';
import { ProtectedNavigationGuard } from '../app/ProtectedNavigationGuard';
import { SessionProvider } from '../app/session';
import { createQueryClient } from '../lib/queryClient';
import { alpha, alphaMembers, created, deferred, failure, installFakeApi, json, ok, type FakeRequest } from '../test/fakeApi';
import { chooseFilter, filterPicker } from '../features/tasks/test/filterPickers';
import { lostResponse } from '../features/planning/test/fixtures';
import { PROJECT_ID, rootPath, task, tablePath, tableRoutes } from '../features/work-categories/test/fixtures';

beforeAll(async () => { await import('./ProjectPage'); });
const TODO = task.statusId;
const PROGRESS = 'f6000000-0000-4000-8000-000000000002';
const base: TaskStatusDto = { id: TODO, workspaceId: alpha.id, projectId: PROJECT_ID, name: 'Stored todo', group: 'todo', position: 0, revision: 1 };
const statuses: TaskStatusDto[] = [base, { ...base, id: PROGRESS, name: 'Stored progress', group: 'in_progress', position: 1 }];
const watcher = alphaMembers[1]; if (!watcher) throw new Error('Missing member fixture');
// Matches both the in-progress status filter and the participant filter, so the table stays mounted.
const visible: TaskDto = { ...task, id: 'f2000000-0000-4000-8000-000000000081', workPackageId: 'f1000000-0000-4000-8000-000000000081', title: 'Visible matching task', statusId: PROGRESS, responsibleMembershipId: watcher.id, participants: [{ membershipId: watcher.id, role: 'assignee', active: true, revision: 1 }] };
const CREATED = ['f2000000-0000-4000-8000-000000000091', 'f2000000-0000-4000-8000-000000000092', 'f2000000-0000-4000-8000-000000000093'];

type Post = (request: FakeRequest, commit: (request: FakeRequest) => TaskDto) => Response | Promise<Response>;
const cleanups: (() => void)[] = [];
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); });
/**
 * The mocked server applies `statusId` and `participantMembershipId` itself and builds each created
 * row from the POST body only, so a default-todo unassigned task is left out of filtered reads.
 * A repeated Idempotency-Key replays the one committed row.
 */
function app(url: string, post: Post) {
  const rows: TaskDto[] = [task, visible];
  const committed = new Map<string, TaskDto>();
  const commit = (request: FakeRequest) => {
    const key = request.headers.get('Idempotency-Key') ?? '';
    const known = committed.get(key);
    if (known) return known;
    const body = request.body as { title: string; statusId: string; sectionId?: string; responsibleMembershipId?: string; participantMembershipIds?: string[] };
    const n = committed.size;
    const row: TaskDto = { ...task, id: CREATED[n] ?? '', workPackageId: `f1000000-0000-4000-8000-00000000009${n + 1}`, title: body.title, statusId: body.statusId, sectionId: body.sectionId ?? null,
      responsibleMembershipId: body.responsibleMembershipId ?? null, participants: (body.participantMembershipIds ?? []).map(membershipId => ({ membershipId, role: 'assignee' as const, active: true, revision: 1 })) };
    committed.set(key, row); rows.push(row);
    return row;
  };
  const matches = (row: TaskDto, request: FakeRequest) => {
    const parent = request.searchParams.get('parentTaskId'); const status = request.searchParams.get('statusId'); const participant = request.searchParams.get('participantMembershipId');
    return (parent ? row.parentTaskId === parent : row.parentTaskId === null) && (!status || row.statusId === status)
      && (!participant || row.responsibleMembershipId === participant || row.participants.some(item => item.active && item.membershipId === participant));
  };
  const details = Object.fromEntries([visible.id, ...CREATED].map(id => [`GET ${rootPath}/tasks/${id}`, () => {
    const row = rows.find(item => item.id === id);
    return row ? ok(row) : failure(404, 'NOT_FOUND', 'Task not found');
  }]));
  const api = installFakeApi({
    ...tableRoutes(),
    [`GET ${rootPath}/projects/${PROJECT_ID}/statuses`]: () => ok(statuses),
    [`GET ${rootPath}/tasks`]: request => json(200, { data: rows.filter(row => matches(row, request)), meta: { requestId: 'quick-create-feedback-fixture', nextCursor: null } }),
    [`POST ${rootPath}/tasks`]: request => post(request, commit),
    ...details,
  });
  const client = createQueryClient({ retry: false });
  const router = createMemoryRouter([{ path: '*', element: <SessionProvider><ProtectedNavigationGuard /><AppRoutes /></SessionProvider> }], { initialEntries: [url] });
  const view = render(<QueryClientProvider client={client}><RouterProvider router={router} /></QueryClientProvider>);
  cleanups.push(() => { view.unmount(); router.dispose(); client.clear(); });
  return { ...view, ...api, rows, client, router, user: userEvent.setup({ pointerEventsCheck: 0 }) };
}
type Ui = ReturnType<typeof app>;
type Calls = Ui['calls'];
// Only the project list reads; the drawer may read its own subtask scope.
const listCalls = (calls: Calls) => calls.filter(call => call.method === 'GET' && call.path === `${rootPath}/tasks` && !call.searchParams.has('parentTaskId'));
const posts = (calls: Calls) => calls.filter(call => call.method === 'POST' && call.path === `${rootPath}/tasks`);
const params = (ui: Ui) => new URLSearchParams(ui.router.state.location.search);
const openRow = (title: string) => ({ name: `Open task “${title}”` });
const defaults = (title: string) => ({ projectId: PROJECT_ID, title, statusId: TODO });
const titleInput = () => screen.getByRole<HTMLInputElement>('textbox', { name: 'Task name' });
const tableScroller = () => { const node = document.querySelector<HTMLElement>('[data-task-table-scroll]'); if (!node) throw new Error('Missing table scrollport'); return node; };
async function openQuickRow(user: Ui['user']) {
  await user.click(await screen.findByRole('button', { name: 'Add task without a section' }));
  await screen.findByRole('form', { name: 'Add a task to No section' });
  return titleInput();
}
async function openFilters(user: Ui['user']) {
  const summary = await screen.findByText(/^Filters/, { selector: 'summary' });
  if (!summary.closest('details')?.open) await user.click(summary);
}

const announced = (title: string) => `Task “${title}” created.`;
const feedbackText = (title: string) => `Task “${title}” created. Your filters are still applied.`;
const occurrences = (text: string) => (document.body.textContent ?? '').split(text).length - 1;
const createdStatuses = (title: string) => screen.queryAllByRole('status').filter(node => node.textContent?.includes(feedbackText(title)));
/** No success of any kind for this title: neither visible feedback nor the sr-only page announcement. */
function expectNoCreated(title: string) {
  expect(occurrences(announced(title))).toBe(0);
}
/**
 * The one visible confirmation of this create. jsdom applies no sr-only CSS (toBeVisible would pass
 * inside it), so placement is asserted from the rendered classes: fixed, outside layout flow, never sr-only.
 */
async function findCreatedFeedback(title: string) {
  await waitFor(() => expect(createdStatuses(title)).toHaveLength(1));
  const [status] = createdStatuses(title);
  if (!status) throw new Error('Missing created feedback');
  expect(status.closest('.sr-only')).toBeNull();
  const region = status.closest<HTMLElement>('.fixed');
  if (!region) throw new Error('Created feedback is not fixed outside the layout flow');
  // Announced once: the sr-only page live region does not repeat the same create.
  expect([...document.querySelectorAll('.sr-only')].some(node => node.textContent?.includes(announced(title)))).toBe(false);
  expect(occurrences(announced(title))).toBe(1);
  return region;
}

describe('quick create confirmation under active filters', () => {
  it('confirms a status-hidden create in fixed page feedback without moving the next title, focus, selection or scroll, and opens it only explicitly', async () => {
    const gate = deferred<Response>();
    const ui = app(`${tablePath}?status=${PROGRESS}&other=kept#anchor`, (request, commit) => { commit(request); return gate.promise; });
    await screen.findByRole('button', openRow(visible.title));
    expect(screen.queryByRole('button', openRow(task.title))).not.toBeInTheDocument();
    expect(listCalls(ui.calls).at(-1)?.searchParams.get('statusId')).toBe(PROGRESS);
    const input = await openQuickRow(ui.user);
    await ui.user.type(input, 'Hidden quick todo{Enter}');
    await waitFor(() => expect(posts(ui.calls)).toHaveLength(1));
    await ui.user.type(input, 'Next unsent title');
    input.setSelectionRange(5, 11);
    const scroller = tableScroller(); scroller.scrollTop = 48; scroller.scrollLeft = 24;
    const { search, key } = ui.router.state.location;
    // Still being sent is not a success.
    expectNoCreated('Hidden quick todo');
    const readsBefore = listCalls(ui.calls).length;

    await act(async () => gate.resolve(created(ui.rows.find(row => row.title === 'Hidden quick todo'))));
    const feedback = await findCreatedFeedback('Hidden quick todo');
    expect(feedback).toHaveTextContent(feedbackText('Hidden quick todo'));
    // The authoritative refetch keeps the status filter and still leaves the confirmed row out.
    await waitFor(() => expect(listCalls(ui.calls).length).toBeGreaterThan(readsBefore));
    const refetch = listCalls(ui.calls).at(-1);
    expect(refetch?.searchParams.get('statusId')).toBe(PROGRESS); expect(refetch?.searchParams.has('cursor')).toBe(false);
    await screen.findByRole('button', openRow(visible.title));
    expect(screen.queryByRole('button', openRow('Hidden quick todo'))).not.toBeInTheDocument();
    expect(filterPicker('Task status')).toHaveTextContent('Stored progress');
    // No automatic navigation, drawer or focus move; the next unsent input is untouched.
    expect(ui.router.state.location.search).toBe(search); expect(ui.router.state.location.key).toBe(key);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(titleInput()).toBe(input); expect(input).toHaveValue('Next unsent title'); expect(input).toHaveFocus();
    expect([input.selectionStart, input.selectionEnd]).toEqual([5, 11]);
    expect(tableScroller()).toBe(scroller); expect([scroller.scrollTop, scroller.scrollLeft]).toEqual([48, 24]);
    const sent = posts(ui.calls);
    expect(sent).toHaveLength(1); expect(sent[0]?.body).toEqual(defaults('Hidden quick todo')); expect(sent[0]?.headers.get('Idempotency-Key')).toBeTruthy();

    await ui.user.click(within(feedback).getByRole('button', { name: 'Open details' }));
    expect(await screen.findByRole('dialog', { name: 'Hidden quick todo' })).toBeInTheDocument();
    expect(ui.calls.some(call => call.method === 'GET' && call.path === `${rootPath}/tasks/${CREATED[0]}`)).toBe(true);
    expect(Object.fromEntries(params(ui))).toEqual({ status: PROGRESS, other: 'kept', task: CREATED[0] });
    expect(ui.router.state.location.hash).toBe('#anchor');
    expect(posts(ui.calls)).toHaveLength(1);

    // Opening details closed the quick editor but kept its newer unsent title for the same Add task row.
    await ui.user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(params(ui).has('task')).toBe(false);
    expect(await openQuickRow(ui.user)).toHaveValue('Next unsent title');
    expect(posts(ui.calls)).toHaveLength(1);
  });

  it('keeps only the latest participant-hidden confirmation and clears it on a filter change without reviving it on Back', async () => {
    const ui = app(`${tablePath}?participant=${watcher.id}`, (request, commit) => created(commit(request)));
    await screen.findByRole('button', openRow(visible.title));
    const input = await openQuickRow(ui.user);
    await ui.user.type(input, 'First hidden create{Enter}');
    await findCreatedFeedback('First hidden create');
    await ui.user.type(input, 'Second hidden create{Enter}');
    await findCreatedFeedback('Second hidden create');
    expectNoCreated('First hidden create');
    // Unassigned defaults are sent as typed; the participant filter is never injected into the create.
    expect(posts(ui.calls).map(call => call.body)).toEqual([defaults('First hidden create'), defaults('Second hidden create')]);
    expect(listCalls(ui.calls).at(-1)?.searchParams.get('participantMembershipId')).toBe(watcher.id);
    expect(screen.queryByRole('button', openRow('First hidden create'))).not.toBeInTheDocument();
    expect(screen.queryByRole('button', openRow('Second hidden create'))).not.toBeInTheDocument();
    expect(input).toHaveValue(''); expect(input).toHaveFocus();
    expect(params(ui).has('task')).toBe(false); expect(screen.queryByRole('dialog')).not.toBeInTheDocument();

    await openFilters(ui.user);
    await chooseFilter(ui.user, 'Task participant', 'All participants');
    await waitFor(() => expect(params(ui).has('participant')).toBe(false));
    expect(await screen.findByRole('button', openRow('Second hidden create'))).toBeInTheDocument();
    expectNoCreated('Second hidden create');
    await act(async () => ui.router.navigate(-1));
    await waitFor(() => expect(params(ui).get('participant')).toBe(watcher.id));
    await waitFor(() => expect(screen.queryByRole('button', openRow('Second hidden create'))).not.toBeInTheDocument());
    expect(screen.getByRole('button', openRow(visible.title))).toBeInTheDocument();
    expectNoCreated('Second hidden create'); expectNoCreated('First hidden create');
    expect(posts(ui.calls)).toHaveLength(2);
  });

  it('drops the confirmation of a create whose filtered scope changed before its answer, without reviving it on Back', async () => {
    const gate = deferred<Response>();
    const ui = app(`${tablePath}?status=${PROGRESS}`, (request, commit) => { commit(request); return gate.promise; });
    await screen.findByRole('button', openRow(visible.title));
    const input = await openQuickRow(ui.user);
    await ui.user.type(input, 'Stale scope create{Enter}');
    await waitFor(() => expect(posts(ui.calls)).toHaveLength(1));
    // The scope changes while the create is still being sent.
    await ui.user.click(screen.getByRole('button', { name: 'Clear filters' }));
    await waitFor(() => expect(params(ui).has('status')).toBe(false));
    expectNoCreated('Stale scope create');
    const readsBefore = listCalls(ui.calls).length;

    await act(async () => gate.resolve(created(ui.rows.find(row => row.title === 'Stale scope create'))));
    // The confirmed answer refetches the new unfiltered scope, which shows the real row.
    await waitFor(() => expect(listCalls(ui.calls).length).toBeGreaterThan(readsBefore));
    expect(listCalls(ui.calls).at(-1)?.searchParams.has('statusId')).toBe(false);
    expect(await screen.findByRole('button', openRow('Stale scope create'))).toBeInTheDocument();
    // Neither the old scope's visible feedback nor the generic sr-only success.
    expectNoCreated('Stale scope create');
    expect(posts(ui.calls)).toHaveLength(1);

    await act(async () => ui.router.navigate(-1));
    await waitFor(() => expect(params(ui).get('status')).toBe(PROGRESS));
    await waitFor(() => expect(screen.queryByRole('button', openRow('Stale scope create'))).not.toBeInTheDocument());
    expectNoCreated('Stale scope create');
    expect(posts(ui.calls)).toHaveLength(1);
  });

  it('shows no success for a pending or lost answer and confirms once only after the explicit exact retry', async () => {
    const first = lostResponse(); let attempts = 0;
    const ui = app(`${tablePath}?status=${PROGRESS}`, (request, commit) => { const row = commit(request); return ++attempts === 1 ? first.promise : created(row); });
    await screen.findByRole('button', openRow(visible.title));
    const input = await openQuickRow(ui.user);
    await ui.user.type(input, 'Unknown hidden create{Enter}');
    await waitFor(() => expect(posts(ui.calls)).toHaveLength(1));
    expectNoCreated('Unknown hidden create');
    await act(async () => first.lose());
    const retry = await screen.findByRole('button', { name: 'Retry original' });
    expectNoCreated('Unknown hidden create');
    await ui.user.type(input, 'Typed after loss');
    expect(posts(ui.calls)).toHaveLength(1);

    await ui.user.click(retry);
    await findCreatedFeedback('Unknown hidden create');
    const sent = posts(ui.calls);
    expect(sent).toHaveLength(2); expect(sent[0]?.body).toEqual(defaults('Unknown hidden create')); expect(sent[1]?.body).toEqual(sent[0]?.body);
    expect(sent[0]?.headers.get('Idempotency-Key')).toBeTruthy(); expect(sent[1]?.headers.get('Idempotency-Key')).toBe(sent[0]?.headers.get('Idempotency-Key'));
    expect(ui.rows.filter(row => row.title === 'Unknown hidden create')).toHaveLength(1);
    expect(titleInput()).toBe(input); expect(input).toHaveValue('Typed after loss');
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Retry original' })).not.toBeInTheDocument());
    expect(screen.queryByRole('button', openRow('Unknown hidden create'))).not.toBeInTheDocument();
    expect(occurrences(announced('Unknown hidden create'))).toBe(1);

    // A scope change clears it; returning to the old filter does not bring it back.
    await ui.user.clear(input);
    await ui.user.click(screen.getByRole('button', { name: 'Clear filters' }));
    await waitFor(() => expect(params(ui).has('status')).toBe(false));
    expect(await screen.findByRole('button', openRow('Unknown hidden create'))).toBeInTheDocument();
    expectNoCreated('Unknown hidden create');
    await act(async () => ui.router.navigate(-1));
    await waitFor(() => expect(params(ui).get('status')).toBe(PROGRESS));
    await waitFor(() => expect(screen.queryByRole('button', openRow('Unknown hidden create'))).not.toBeInTheDocument());
    expectNoCreated('Unknown hidden create');
    expect(posts(ui.calls)).toHaveLength(2);
  });

  it('never confirms a rejected create and confirms only the replacement after an explicit discard', async () => {
    let attempts = 0;
    const ui = app(`${tablePath}?status=${PROGRESS}`, (request, commit) => ++attempts === 1 ? failure(409, 'REVISION_CONFLICT', 'private') : created(commit(request)));
    await screen.findByRole('button', openRow(visible.title));
    const input = await openQuickRow(ui.user);
    await ui.user.type(input, 'Rejected hidden create{Enter}');
    const discard = await screen.findByRole('button', { name: 'Discard rejected task' });
    expectNoCreated('Rejected hidden create');
    await ui.user.click(discard);
    await ui.user.type(titleInput(), 'Replacement hidden create{Enter}');
    await findCreatedFeedback('Replacement hidden create');
    expectNoCreated('Rejected hidden create');
    expect(posts(ui.calls).map(call => call.body)).toEqual([defaults('Rejected hidden create'), defaults('Replacement hidden create')]);
    expect(posts(ui.calls)[1]?.headers.get('Idempotency-Key')).not.toBe(posts(ui.calls)[0]?.headers.get('Idempotency-Key'));
    expect(screen.queryByRole('button', openRow('Replacement hidden create'))).not.toBeInTheDocument();
    expect(params(ui).get('status')).toBe(PROGRESS); expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
});
