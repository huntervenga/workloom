import { tableExpansionStorageKey } from '../features/task-table/useTableExpansionState';
import type * as ChoicePickerModule from '../shared/ChoicePicker';
import type { ComponentProps } from 'react';
import type { UserEvent } from '@testing-library/user-event';
import { timeContextLabel } from '../features/work-categories/test/timeContext';
import type { SectionDto, TaskDto } from '@workloom/contracts';
import { QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { beforeAll, expect, it, vi } from 'vitest';
import { AppRoutes } from '../app/AppRoutes';
import { SessionProvider } from '../app/session';
import { createQueryClient } from '../lib/queryClient';
import { alpha, alphaMembers, anna, created, deferred, installFakeApi, json, ok, renderApp, type RouteTable } from '../test/fakeApi';
import { lostResponse } from '../features/planning/test/fixtures';
import { chooseFilter } from '../features/tasks/test/filterPickers';
import { MEMBER_ID, PERIOD_A, PROJECT_ID, rootPath, task, legacyTablePath, tablePath, tableRoutes } from '../features/work-categories/test/fixtures';

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

async function tableChoice(user: UserEvent, control: HTMLElement, value: 'section' | 'assignee' | 'manual' | 'due_asc') {
  await user.click(control);
  const name = { section: 'Section', assignee: 'Assignee', manual: 'Manual', due_asc: 'Due date' }[value];
  await user.click(within(screen.getByRole('listbox', { name: control.getAttribute('aria-label') ?? '' })).getByRole('option', { name }));
}

beforeAll(async () => { await import('./ProjectPage'); });
const SECTION_A = 'e1000000-0000-4000-8000-000000000001';
const SECTION_B = 'e1000000-0000-4000-8000-000000000002';
const owner = alphaMembers[0]; if (!owner) throw new Error('Missing owner fixture');
const sections: SectionDto[] = [
  { id: SECTION_A, workspaceId: alpha.id, projectId: PROJECT_ID, name: 'First section', position: 0, revision: 1, archivedAt: null },
  { id: SECTION_B, workspaceId: alpha.id, projectId: PROJECT_ID, name: 'Second section', position: 1, revision: 1, archivedAt: null },
];
const parent: TaskDto = { ...task, title: 'Later parent', sectionId: SECTION_A, dueDate: '2027-03-01', position: 0, responsibleMembershipId: owner.id, estimateMinutes: 120 };
const child: TaskDto = { ...parent, id: 'f2000000-0000-4000-8000-000000000002', title: 'Earlier child', parentTaskId: parent.id, sectionId: SECTION_B, dueDate: '2027-01-01' };
const peer: TaskDto = { ...parent, id: 'f2000000-0000-4000-8000-000000000003', title: 'Middle root', dueDate: '2027-02-01', position: 1, workPackageId: 'f1000000-0000-4000-8000-000000000003', estimateMinutes: 60 };
const page = (rows: TaskDto[], nextCursor: string | null = null) => json(200, { data: rows, meta: { requestId: 'sort-fixture', nextCursor } });
function routes(extra: RouteTable = {}): RouteTable {
  return { ...tableRoutes(), [`GET ${rootPath}/tasks`]: () => page([parent, child, peer]), [`GET ${rootPath}/tasks/${parent.id}`]: () => ok(parent), [`GET ${rootPath}/tasks/${child.id}`]: () => ok(child), [`GET ${rootPath}/projects/${PROJECT_ID}/sections`]: () => ok(sections), ...extra };
}
function app(url: string) {
  const client = createQueryClient({ retry: false });
  const router = createMemoryRouter([{ path: '*', element: <SessionProvider><AppRoutes /></SessionProvider> }], { initialEntries: [url] });
  const view = render(<QueryClientProvider client={client}><RouterProvider router={router} /></QueryClientProvider>);
  return { ...view, router, client, user: userEvent.setup({ pointerEventsCheck: 0 }) };
}
const sort = () => screen.getByRole('combobox', { name: 'Sort' });
const views = () => within(screen.getByRole('navigation', { name: 'Project views' }));
const taskCalls = (calls: ReturnType<typeof installFakeApi>['calls']) => calls.filter(call => call.path === `${rootPath}/tasks`);
const writes = (calls: ReturnType<typeof installFakeApi>['calls']) => calls.filter(call => call.method !== 'GET');
function rowOrder() { return within(screen.getByRole('table')).getAllByRole('row').flatMap(row => { const selected = within(row).queryByRole('button', { name: /^Select task: / }); return selected ? [selected.getAttribute('aria-label')] : []; }); }

it('applies server due paging, preserves grouped hierarchy and Manual positions, and keeps sort outside filter clearing', async () => {
  const { calls } = installFakeApi(routes()); const ui = app(legacyTablePath(`${tablePath}?week=${PERIOD_A}&worker=${MEMBER_ID}&other=kept#anchor`));
  try {
    await screen.findByRole('button', { name: parent.title }); expect(sort()).toHaveTextContent('Manual');
    await ui.user.click(screen.getByRole('button', { name: `Expand subtasks of “${parent.title}”` }));
    expect(rowOrder()).toEqual([`Select task: ${parent.title}`, `Select task: ${child.title}`, `Select task: ${peer.title}`]);
    await tableChoice(ui.user, sort(), 'due_asc');
    await waitFor(() => expect(rowOrder()).toEqual([`Select task: ${peer.title}`, `Select task: ${parent.title}`, `Select task: ${child.title}`]));
    expect(taskCalls(calls).at(-1)?.searchParams.get('sort')).toBe('due_asc');
    expect(ui.router.state.location.search).toContain('other=kept'); expect(ui.router.state.location.hash).toBe('#anchor');
    expect(screen.getByLabelText('Week for hours')).toHaveTextContent(timeContextLabel('Week for hours', PERIOD_A)); expect(screen.getByLabelText('Whose hours to show')).toHaveTextContent(timeContextLabel('Whose hours to show', MEMBER_ID));
    expect(screen.getByText('Loaded team budget').closest('tr')).toHaveTextContent('3h');
    await ui.user.click(screen.getByText('Filters', { selector: 'summary' }));
    await chooseFilter(ui.user, 'Task participant', owner.displayName);
    expect(new URLSearchParams(ui.router.state.location.search).get('participant')).toBe(owner.id);
    await ui.user.click(screen.getByRole('button', { name: 'Clear filters' }));
    expect(sort()).toHaveTextContent('Due date'); expect(ui.router.state.location.search).toContain('sort=due_asc');
    expect(ui.router.state.location.search).not.toContain('participant='); expect(ui.router.state.location.search).toContain('other=kept');
    await tableChoice(ui.user, sort(), 'manual');
    await waitFor(() => expect(rowOrder()[0]).toBe(`Select task: ${parent.title}`));
    expect(ui.router.state.location.search).not.toContain('sort='); expect(writes(calls)).toHaveLength(0);
  } finally { ui.unmount(); ui.router.dispose(); ui.client.clear(); }
});

it('restores the sort URL through Back and a fresh mount without taking identity/cursor from URL parameters', async () => {
  const { calls } = installFakeApi(routes()); const ui = app(`${tablePath}?sort=due_asc&cursor=foreign&actorId=foreign&other=kept#anchor`);
  let reloadUrl = '';
  try {
    await screen.findByRole('button', { name: parent.title }); expect(sort()).toHaveTextContent('Due date');
    await ui.user.click(screen.getByRole('button', { name: `Open task “${parent.title}”` })); await screen.findByRole('dialog');
    await act(async () => ui.router.navigate(-1)); await screen.findByRole('table');
    expect(sort()).toHaveTextContent('Due date'); expect(ui.router.state.location.hash).toBe('#anchor');
    reloadUrl = `${ui.router.state.location.pathname}${ui.router.state.location.search}${ui.router.state.location.hash}`;
    const first = taskCalls(calls)[0]; expect(first?.searchParams.get('sort')).toBe('due_asc');
    expect(first?.searchParams.has('cursor')).toBe(false); expect(first?.searchParams.has('actorId')).toBe(false);
  } finally { ui.unmount(); ui.router.dispose(); ui.client.clear(); }
  const reload = app(reloadUrl);
  try { await screen.findByRole('table'); expect(sort()).toHaveTextContent('Due date'); expect(reload.router.state.location.hash).toBe('#anchor'); }
  finally { reload.unmount(); reload.router.dispose(); reload.client.clear(); }
});

it.each(['sort=unknown', 'sort=manual', 'sort=due_asc&sort=due_asc', 'sort='])('uses safe Manual without rewriting malformed/legacy URL %s', async query => {
  const { calls } = installFakeApi(routes()); const ui = app(`${tablePath}?${query}&other=kept#anchor`); const key = ui.router.state.location.key;
  try {
    await screen.findByRole('table'); expect(sort()).toHaveTextContent('Manual'); expect(taskCalls(calls)[0]?.searchParams.has('sort')).toBe(false);
    expect(ui.router.state.location.search).toBe(`?${query}&other=kept`); expect(ui.router.state.location.key).toBe(key); expect(writes(calls)).toHaveLength(0);
  } finally { ui.unmount(); ui.router.dispose(); ui.client.clear(); }
});

it('keeps a child draft exactly once when a due first page precedes its previously expanded parent and the next page rejoins the canonical tree', async () => {
  localStorage.setItem(tableExpansionStorageKey({ actorId: anna.id, workspaceId: alpha.id, projectId: PROJECT_ID }), JSON.stringify({ version: 1, expandedTaskIds: [parent.id], collapsedGroupKeys: [] }));
  const { calls } = installFakeApi(routes({ [`GET ${rootPath}/tasks`]: request => request.searchParams.get('sort') !== 'due_asc' ? page([parent]) : request.searchParams.has('cursor') ? page([parent], 'another-due-page') : page([child], 'due-parent-page') }));
  const { user } = renderApp(legacyTablePath(tablePath)); await screen.findByRole('button', { name: parent.title }); await tableChoice(user, sort(), 'due_asc');
  await user.click(await screen.findByRole('button', { name: child.title }));
  fireEvent.change(screen.getByLabelText('Task name'), { target: { value: 'Raw child draft retained' } });
  expect(screen.getByTitle('Parent task is outside the loaded set')).toBeInTheDocument();
  // Moving focus out of a text cell commits it, so load the page without leaving the editor.
  fireEvent.click(screen.getByRole('button', { name: 'Load more tasks' }));
  await waitFor(() => expect(screen.queryByTitle('Parent task is outside the loaded set')).not.toBeInTheDocument());
  // The row rejoins its parent's group; the remounted editor keeps the raw draft but never reclaims focus.
  expect(screen.getByLabelText('Task name')).toHaveValue('Raw child draft retained'); expect(screen.getByLabelText('Task name')).not.toHaveFocus();
  expect(screen.getAllByRole('button', { name: `Select task: ${child.title}` })).toHaveLength(1);
  expect(screen.getByRole('button', { name: 'Collapse section “First section”' }).closest('th')).toHaveTextContent('loaded: 2 tasks');
  expect(screen.getByRole('button', { name: 'Collapse section “Second section”' }).closest('th')).toHaveTextContent('loaded: 0 tasks');
  expect(screen.getByText('Loaded team budget').closest('tr')).toHaveTextContent('2h');
  expect(taskCalls(calls).at(-1)?.searchParams.get('cursor')).toBe('due-parent-page'); expect(writes(calls)).toHaveLength(0);
});

it('resorts flat Assignee groups and deduped Board heads after a newer duplicate changes its due date', async () => {
  const updated = { ...parent, dueDate: '2026-01-01', revision: 2 };
  const { calls } = installFakeApi(routes({ [`GET ${rootPath}/tasks`]: request => page(request.searchParams.get('sort') === 'due_asc' ? [child, peer, parent, updated] : [parent, peer, child]) }));
  const { user } = renderApp(`${tablePath}?sort=due_asc`); await screen.findByRole('table'); await tableChoice(user, screen.getByRole('combobox', { name: 'Group by' }), 'assignee');
  expect(rowOrder()).toEqual([`Select task: ${parent.title}`, `Select task: ${child.title}`, `Select task: ${peer.title}`]);
  await user.click(views().getByRole('button', { name: 'Board' }));
  const cards = screen.getAllByRole('button', { name: /^(Later parent|Earlier child|Middle root)$/ }).filter(button => !button.hasAttribute('aria-describedby'));
  expect(cards.map(card => card.textContent)).toEqual([parent.title, child.title, peer.title]);
  expect(screen.getByText('3 tasks in this view.')).toBeInTheDocument(); expect(sort()).toHaveTextContent('Due date');
  await user.click(views().getByRole('button', { name: 'Tasks' })); expect(screen.getByRole('combobox', { name: 'Group by' })).toHaveTextContent('Assignee'); expect(writes(calls)).toHaveLength(0);
});

it('keeps a held quick command and its exact retry through a sort change without writing positions', async () => {
  const first = lostResponse(); let attempts = 0;
  const { calls } = installFakeApi(routes({ [`POST ${rootPath}/tasks`]: () => ++attempts === 1 ? first.promise : created({ ...parent, title: 'Original quick draft' }) }));
  const { user } = renderApp(tablePath); await user.click(await screen.findByRole('button', { name: 'Add task to “First section”' }));
  await user.type(screen.getByLabelText('Task name'), 'Original quick draft');
  await user.keyboard('{Enter}');
  await waitFor(() => expect(attempts).toBe(1)); await tableChoice(user, sort(), 'due_asc'); await act(async () => first.lose());
  const retry = await screen.findByRole('button', { name: 'Retry original' }); expect(screen.getByLabelText('Task name')).toHaveValue(''); expect(screen.getByText('Submitted task: Original quick draft')).toBeInTheDocument();
  await user.click(retry); await waitFor(() => expect(writes(calls)).toHaveLength(2)); await waitFor(() => expect(screen.getByLabelText('Task name')).toHaveValue(''));
  const sent = writes(calls); expect(sent).toHaveLength(2); expect(sent[1]?.body).toEqual(sent[0]?.body); expect(sent[1]?.headers.get('Idempotency-Key')).toBe(sent[0]?.headers.get('Idempotency-Key')); expect(sort()).toHaveTextContent('Due date');
});

it('does not let a pre-sort inline acknowledgement close a remounted editor or steal focus', async () => {
  const gate = deferred<Response>(); let current = parent;
  const { calls } = installFakeApi(routes({ [`GET ${rootPath}/tasks`]: () => page([current, child]), [`PATCH ${rootPath}/tasks/${parent.id}`]: () => gate.promise }));
  const { user } = renderApp(tablePath); await user.click(await screen.findByRole('button', { name: parent.title }));
  fireEvent.change(screen.getByLabelText('Task name'), { target: { value: 'Confirmed renamed parent' } }); await user.keyboard('{Control>}{Enter}{/Control}');
  await waitFor(() => expect(writes(calls)).toHaveLength(1)); await tableChoice(user, sort(), 'due_asc');
  const search = screen.getByLabelText('Search tasks'); await user.click(search);
  await act(async () => gate.resolve(ok(current = { ...parent, title: 'Confirmed renamed parent', revision: 2 })));
  await waitFor(() => expect(screen.getByLabelText('Task name')).not.toHaveAttribute('readonly')); expect(search).toHaveFocus();
  expect(screen.queryByRole('form', { name: /^Add a task to/ })).not.toBeInTheDocument();
  expect(screen.getByLabelText('Task name')).toHaveValue('Confirmed renamed parent'); await user.click(screen.getByLabelText('Task name')); await user.keyboard('{Control>}{Enter}{/Control}'); expect(writes(calls)).toHaveLength(1);
});

it.each([false, true])('preserves same-turn retained Sort and Week partial intents in either order (week first: %s)', async weekFirst => {
  const { calls } = installFakeApi(routes()); const ui = app(legacyTablePath(`${tablePath}?worker=${MEMBER_ID}&other=kept#anchor`));
  try {
    await screen.findByRole('table'); const retainedSort = retainedPicker('Sort'); const retainedWeek = retainedPicker('Week for hours');
    await act(async () => {
      const changeSort = () => retainedSort('due_asc');
      const changeWeek = () => retainedWeek(PERIOD_A);
      if (weekFirst) { changeWeek(); changeSort(); } else { changeSort(); changeWeek(); }
    });
    await waitFor(() => expect(sort()).toHaveTextContent('Due date'));
    expect(screen.getByLabelText('Week for hours')).toHaveTextContent(timeContextLabel('Week for hours', PERIOD_A));
    const params = new URLSearchParams(ui.router.state.location.search);
    expect(params.get('sort')).toBe('due_asc'); expect(params.get('week')).toBe(PERIOD_A); expect(params.get('worker')).toBe(MEMBER_ID); expect(params.get('other')).toBe('kept'); expect(ui.router.state.location.hash).toBe('#anchor'); expect(writes(calls)).toHaveLength(0);
  } finally { ui.unmount(); ui.router.dispose(); ui.client.clear(); }
});

it('does not resurrect a closed task when an already-rendered Sort control fires in the same turn', async () => {
  installFakeApi(routes()); const ui = app(`${tablePath}?other=kept#anchor`);
  try {
    await screen.findByRole('table'); const retainedSort = retainedPicker('Sort');
    await ui.user.click(screen.getByRole('button', { name: `Open task “${parent.title}”` }));
    const drawer = within(await screen.findByRole('dialog')); const close = drawer.getByLabelText('Close', { selector: 'button' });
    await act(async () => { fireEvent.click(close); retainedSort('due_asc'); });
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    const params = new URLSearchParams(ui.router.state.location.search);
    expect(params.has('task')).toBe(false); expect(params.get('sort')).toBe('due_asc'); expect(params.get('other')).toBe('kept'); expect(ui.router.state.location.hash).toBe('#anchor');
  } finally { ui.unmount(); ui.router.dispose(); ui.client.clear(); }
});

it('retains descendant collapse through a cold pending sort query and a Board round trip', async () => {
  const due = deferred<Response>();
  installFakeApi(routes({ [`GET ${rootPath}/tasks`]: request => request.searchParams.get('sort') === 'due_asc' ? due.promise : page([parent, child, peer]) }));
  const { user } = renderApp(tablePath); await screen.findByRole('table');
  await user.click(screen.getByRole('button', { name: `Expand subtasks of “${parent.title}”` }));
  await user.click(screen.getByRole('button', { name: `Collapse subtasks of “${parent.title}”` }));
  expect(screen.queryByRole('button', { name: `Select task: ${child.title}` })).not.toBeInTheDocument();
  await tableChoice(user, sort(), 'due_asc'); await act(async () => due.resolve(page([child, peer, parent])));
  await screen.findByRole('button', { name: parent.title });
  expect(screen.queryByRole('button', { name: `Select task: ${child.title}` })).not.toBeInTheDocument();
  await user.click(views().getByRole('button', { name: 'Board' })); await screen.findAllByRole('button', { name: parent.title });
  await user.click(views().getByRole('button', { name: 'Tasks' }));
  expect(screen.getByRole('button', { name: `Expand subtasks of “${parent.title}”` })).toHaveAttribute('aria-expanded', 'false');
  await user.click(screen.getByRole('button', { name: `Expand subtasks of “${parent.title}”` }));
  expect(screen.getByRole('button', { name: `Select task: ${child.title}` })).toBeInTheDocument();
});

it('retains the original blur-submitted child command when descendant disclosure hides it and sorting changes', async () => {
  const gate = deferred<Response>(); let current = child;
  const { calls } = installFakeApi(routes({
    [`GET ${rootPath}/tasks`]: () => page([parent, current, peer]),
    [`GET ${rootPath}/tasks/${child.id}`]: () => ok(current),
    [`PATCH ${rootPath}/tasks/${child.id}`]: () => gate.promise,
  }));
  const { user } = renderApp(tablePath);
  await user.click(await screen.findByRole('button', { name: `Expand subtasks of “${parent.title}”` }));
  await user.click(await screen.findByRole('button', { name: child.title }));
  fireEvent.change(screen.getByLabelText('Task name'), { target: { value: 'Child saved under collapsed parent' } });
  await user.click(screen.getByRole('button', { name: `Collapse subtasks of “${parent.title}”` }));
  await waitFor(() => expect(writes(calls)).toHaveLength(1));
  expect(writes(calls)[0]?.body).toEqual({ expectedRevision: child.revision, title: 'Child saved under collapsed parent' });
  expect(screen.queryByLabelText('Task name')).not.toBeInTheDocument(); await screen.findByRole('button', { name: 'Resume original editor' });
  await tableChoice(user, sort(), 'due_asc');
  await screen.findByRole('button', { name: `Expand subtasks of “${parent.title}”` });
  await user.click(screen.getByRole('button', { name: 'Resume original editor' }));
  const drawer = within(await screen.findByRole('dialog'));
  expect(drawer.getByLabelText('Task name')).toHaveValue('Child saved under collapsed parent');
  expect(drawer.getByLabelText('Task name')).toBeDisabled();
  await act(async () => gate.resolve(ok(current = { ...child, title: 'Child saved under collapsed parent', revision: child.revision + 1 })));
  await waitFor(() => expect(drawer.getByLabelText('Task name')).not.toBeDisabled());
  expect(writes(calls)).toHaveLength(1);
});
