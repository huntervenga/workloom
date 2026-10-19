import { QueryClientProvider } from '@tanstack/react-query';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, useLocation } from 'react-router';
import { AppRoutes } from '../app/AppRoutes';
import { SessionProvider } from '../app/session';
import { createQueryClient } from '../lib/queryClient';
import type { UserEvent } from '@testing-library/user-event';
import { timeContextLabel } from '../features/work-categories/test/timeContext';
import type { ColumnChoice, PersonalTablePreferenceDto, TaskDto } from '@workloom/contracts';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import { beforeAll, expect, it } from 'vitest';
import { alpha, alphaMembers, anna, failure, installFakeApi, json, ok, renderApp, type RouteTable } from '../test/fakeApi';
import { graph, layout } from '../features/dependencies/test/fixtures';
import { scheduleContext } from '../features/schedule/test/fixtures';
import { availabilityReadRoutes, isAvailabilityRead } from '../features/schedule/test/availability';
import { lostResponse } from '../features/planning/test/fixtures';
import { columns, field } from '../features/fields/test/fixtures';
import { MEMBER_ID, PERIOD_A, PROJECT_ID, categorized, rootPath, task, legacyTablePath, tablePath, tableRoutes } from '../features/work-categories/test/fixtures';
import { queryKeys } from '../lib/queryKeys';
import { chooseFilter, filterPicker } from '../features/tasks/test/filterPickers';

const member = alphaMembers.find(item => item.id === MEMBER_ID); if (!member) throw new Error('Missing member fixture');

async function tableChoice(user: UserEvent, control: HTMLElement, value: 'section' | 'assignee' | 'manual' | 'due_asc') {
  await user.click(control);
  const name = { section: 'Section', assignee: 'Assignee', manual: 'Manual', due_asc: 'Due date' }[value];
  await user.click(within(screen.getByRole('listbox', { name: control.getAttribute('aria-label') ?? '' })).getByRole('option', { name }));
}

function LocationProbe() { const location = useLocation(); return <output data-testid="location">{location.pathname}{location.search}{location.hash}</output>; }
function renderObservedApp(path: string) {
  const queryClient = createQueryClient({ retry: false });
  const view = render(<QueryClientProvider client={queryClient}><MemoryRouter initialEntries={[path]}><SessionProvider><AppRoutes /><LocationProbe /></SessionProvider></MemoryRouter></QueryClientProvider>);
  return { ...view, queryClient, user: userEvent.setup({ pointerEventsCheck: 0 }) };
}
function currentParams() { return new URL(screen.getByTestId('location').textContent ?? '', 'http://workloom.test').searchParams; }

beforeAll(async () => { await import('./ProjectPage'); });
const path = `${rootPath}/projects/${PROJECT_ID}`;
const preferencePath = `${path}/table-preferences/me`;
function routes(extra: RouteTable = {}): RouteTable {
  return { ...tableRoutes(), ...availabilityReadRoutes, [`GET ${rootPath}/tasks`]: () => json(200, { data: [task], meta: { requestId: 'toolbar-fixture', nextCursor: null } }),
    [`GET ${path}/graph`]: request => ok(graph([task], request.searchParams.get('rootTaskIds')?.split(',') ?? [task.id])),
    [`GET ${path}/graph-layout`]: () => ok(layout()), [`GET ${path}/dependency-policy`]: () => ok({ projectId: PROJECT_ID, mode: 'warn', revision: 0, updatedAt: null }),
    [`GET ${path}/schedule-context`]: () => ok(scheduleContext([task])), ...extra };
}
const views = () => within(screen.getByRole('navigation', { name: 'Project views' }));
const names = { table: 'Tasks', board: 'Board', gantt: 'Timeline', graph: 'Graph', import: 'CSV import' } as const;
async function show(user: ReturnType<typeof renderApp>['user'], view: keyof typeof names) {
  await user.click(views().getByRole('button', { name: names[view] }));
  await waitFor(() => expect(views().getByRole('button', { name: names[view] })).toHaveAttribute('aria-current', 'page'));
}
function columnHead(revision = 0, columns: ColumnChoice[] | null = null): PersonalTablePreferenceDto { return { workspaceId: alpha.id, projectId: PROJECT_ID, membershipId: MEMBER_ID, revision, columns }; }
const writes = (calls: ReturnType<typeof installFakeApi>['calls']) => calls.filter(call => call.method !== 'GET' && !isAvailabilityRead(call));

it.each(['table', 'board', 'gantt', 'graph', 'import'] as const)('shows only controls that act on the %s presentation', async view => {
  const { calls } = installFakeApi(routes()); renderApp(legacyTablePath(`${tablePath}?${view === 'table' ? '' : `view=${view}&`}week=${PERIOD_A}&worker=${MEMBER_ID}`));
  await screen.findByRole('button', { name: 'Add task' });
  await waitFor(() => expect(views().getByRole('button', { name: names[view] })).toHaveAttribute('aria-current', 'page'));
  await waitFor(() => expect(screen.queryByLabelText('Week for hours') !== null).toBe(view === 'table'));
  expect(screen.queryByLabelText('Whose hours to show') !== null).toBe(view === 'table');
  expect(screen.queryByLabelText('Search tasks') !== null).toBe(view === 'table' || view === 'board' || view === 'gantt');
  expect(screen.queryByRole('combobox', { name: 'Group by' }) !== null).toBe(view === 'table');
  expect(screen.queryByRole('combobox', { name: 'Sort' }) !== null).toBe(view === 'table' || view === 'board');
  expect(screen.queryByRole('button', { name: 'Columns' }) !== null).toBe(view === 'table');
  expect(writes(calls)).toHaveLength(0);
});

it('restores retained week/person, search/filter/group/sort and unsaved personal columns after hidden controls return', async () => {
  const person = alphaMembers[1]?.id; if (!person) throw new Error('Missing colleague');
  const { calls } = installFakeApi(routes()); const { user } = renderObservedApp(legacyTablePath(`${tablePath}?week=${PERIOD_A}&worker=${person}&other=kept#anchor`));
  await screen.findByRole('button', { name: 'Columns' }); await user.type(screen.getByLabelText('Search tasks'), 'retained search');
  await user.click(screen.getByText('Filters', { selector: 'summary' })); await chooseFilter(user, 'Task participant', member.displayName);
  await user.click(screen.getByText('Filters (1)', { selector: 'summary' }));
  await tableChoice(user, screen.getByLabelText('Group by'), 'assignee'); await tableChoice(user, screen.getByLabelText('Sort'), 'due_asc');
  await user.click(screen.getByRole('button', { name: 'Columns' })); await user.click(screen.getByLabelText('Tags')); await user.keyboard('{Escape}');
  const reportHref = `${tablePath}/reports`;
  expect(views().getByRole('link', { name: 'Reports' })).toHaveAttribute('href', reportHref);
  expect(views().queryByRole('link', { name: 'Legacy weekly planning' })).not.toBeInTheDocument();
  for (const view of ['graph', 'import', 'gantt', 'board'] as const) {
    await show(user, view); expect(screen.queryByLabelText('Week for hours')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Columns · unsaved' })).not.toBeInTheDocument();
    expect(views().getByRole('link', { name: 'Reports' })).toHaveAttribute('href', reportHref);
    expect(views().queryByRole('link', { name: 'Legacy weekly planning' })).not.toBeInTheDocument();
    const carried = currentParams();
    expect(carried.get('week')).toBe(PERIOD_A); expect(carried.get('worker')).toBe(person);
  }
  await show(user, 'table');
  expect(screen.getByLabelText('Week for hours')).toHaveTextContent(timeContextLabel('Week for hours', PERIOD_A)); expect(screen.getByLabelText('Whose hours to show')).toHaveTextContent(timeContextLabel('Whose hours to show', person));
  expect(screen.getByLabelText('Search tasks')).toHaveValue('retained search'); expect(screen.getByText('Filters (1)', { selector: 'summary' })).toBeInTheDocument();
  expect(filterPicker('Task participant')).toHaveTextContent(member.displayName);
  expect(screen.getByLabelText('Group by')).toHaveTextContent('Assignee'); expect(screen.getByLabelText('Sort')).toHaveTextContent('Due date');
  await user.click(screen.getByRole('button', { name: 'Columns · unsaved' })); expect(screen.getByLabelText('Tags')).not.toBeChecked();
  expect(writes(calls)).toHaveLength(0);
});

it.each(['board', 'gantt', 'graph', 'import'] as const)('resumes a real unknown column command on %s with exact body/key and returns keyboard focus to the visible view control', async view => {
  const first = lostResponse(); let attempts = 0; let current = columnHead();
  const { calls } = installFakeApi(routes({ [`GET ${preferencePath}`]: () => ok(current), [`PUT ${preferencePath}`]: request => {
    if (++attempts === 1) return first.promise;
    current = columnHead(1, (request.body as { columns: ColumnChoice[] }).columns); return ok(current);
  } }));
  const { user } = renderApp(tablePath); await user.click(await screen.findByRole('button', { name: 'Columns' }));
  await user.click(screen.getByLabelText('Tags')); await user.click(screen.getByRole('button', { name: 'Save columns' }));
  await waitFor(() => expect(attempts).toBe(1)); await user.keyboard('{Escape}'); await show(user, view);
  expect(screen.queryByRole('button', { name: 'Columns · unsaved' })).not.toBeInTheDocument();
  await act(async () => first.lose());
  const resume = await screen.findByRole('button', { name: 'Resume column save' }); resume.focus(); await user.keyboard('{Enter}');
  const dialog = within(await screen.findByRole('dialog', { name: 'My task columns' })); expect(dialog.getByLabelText('Tags')).toBeDisabled();
  await user.click(dialog.getByRole('button', { name: 'Retry original columns' }));
  await dialog.findByText('Columns saved. Current settings refreshed.');
  await user.click(dialog.getByLabelText('Close', { selector: 'button' }));
  await waitFor(() => expect(views().getByRole('button', { name: names[view] })).toHaveFocus());
  const sent = writes(calls); expect(sent).toHaveLength(2); expect(sent[1]?.body).toEqual(sent[0]?.body); expect(sent[1]?.headers.get('Idempotency-Key')).toBe(sent[0]?.headers.get('Idempotency-Key'));
  expect(screen.queryByRole('button', { name: 'Resume column save' })).not.toBeInTheDocument();
});

it.each(['board', 'gantt', 'graph', 'import'] as const)('keeps pending/unknown original hours recovery and its context available on %s', async view => {
  const first = lostResponse(); let attempts = 0;
  const savePath = `${rootPath}/tasks/${task.id}/manual-period-work/${PERIOD_A}/${MEMBER_ID}`;
  const { calls } = installFakeApi(routes({ [`PUT ${savePath}`]: () => ++attempts === 1 ? first.promise : ok(categorized(150)) }));
  const { user } = renderObservedApp(legacyTablePath(`${tablePath}?week=${PERIOD_A}&worker=${MEMBER_ID}`));
  await user.click(await screen.findByRole('button', { name: `Weekly actual hours: ${task.title}` }));
  let dialog = within(await screen.findByRole('dialog', { name: 'Record weekly actual hours' }));
  await user.type(dialog.getByLabelText('Actual hours this week'), '2.5'); await user.click(dialog.getByRole('button', { name: 'Save actual hours' }));
  await waitFor(() => expect(attempts).toBe(1)); await user.click(dialog.getByLabelText('Close', { selector: 'button' })); await show(user, view);
  expect(screen.getAllByRole('button', { name: 'Open original hours save' })).toHaveLength(1); expect(screen.queryByLabelText('Week for hours')).not.toBeInTheDocument();
  await act(async () => first.lose()); await user.click(screen.getByRole('button', { name: 'Open original hours save' }));
  dialog = within(await screen.findByRole('dialog', { name: 'Record weekly actual hours' }));
  expect(dialog.getByLabelText('Actual hours this week')).toHaveValue('2:30'); expect(dialog.getByRole('region', { name: 'Time entry context' })).toHaveTextContent(task.title);
  await user.click(dialog.getByRole('button', { name: 'Retry original save' })); await waitFor(() => expect(attempts).toBe(2));
  const sent = writes(calls); expect(sent).toHaveLength(2); expect(sent[1]?.path).toBe(sent[0]?.path); expect(sent[1]?.body).toEqual(sent[0]?.body); expect(sent[1]?.headers.get('Idempotency-Key')).toBe(sent[0]?.headers.get('Idempotency-Key'));
  expect(views().getByRole('link', { name: 'Reports' })).toHaveAttribute('href', `${tablePath}/reports`);
  expect(views().queryByRole('link', { name: 'Legacy weekly planning' })).not.toBeInTheDocument();
  const carried = currentParams();
  expect(carried.get('week')).toBe(PERIOD_A); expect(carried.get('worker')).toBe(MEMBER_ID);
});

it.each(['catalog', 'columns', 'values'] as const)('keeps the existing %s error boundary visible on Graph instead of hiding it with table controls', async source => {
  const note = field('Authorized note');
  const extra: RouteTable = {
    [`GET ${rootPath}/fields`]: () => ok([note]), [`GET ${path}/columns`]: () => ok(columns([note])),
    [`GET ${path}/field-values`]: () => ok([]),
  };
  const endpoint = source === 'catalog' ? `${rootPath}/fields` : source === 'columns' ? `${path}/columns` : `${path}/field-values`;
  extra[`GET ${endpoint}`] = () => failure(503, 'SERVICE_UNAVAILABLE', 'internal diagnostic is not interface copy');
  const { calls } = installFakeApi(routes(extra)); renderApp(`${tablePath}?view=graph`);
  const title = source === 'catalog' ? 'Unable to load fields' : source === 'columns' ? 'Unable to load column settings' : 'Unable to load field values';
  expect(await screen.findByRole('heading', { name: title })).toBeVisible();
  expect(screen.queryByLabelText('Search tasks')).not.toBeInTheDocument(); expect(screen.queryByLabelText('Week for hours')).not.toBeInTheDocument();
  expect(screen.queryByText('internal diagnostic is not interface copy')).not.toBeInTheDocument(); expect(writes(calls)).toHaveLength(0);
});

it('hides cached column choices on a current denial when the command is resumed from Graph', async () => {
  const first = lostResponse(); let attempts = 0;
  const { calls } = installFakeApi(routes({ [`GET ${preferencePath}`]: () => ok(columnHead()), [`PUT ${preferencePath}`]: () => ++attempts === 1 ? first.promise : failure(403, 'FORBIDDEN', 'private preference details') }));
  const { user } = renderApp(tablePath); await user.click(await screen.findByRole('button', { name: 'Columns' }));
  await user.click(screen.getByLabelText('Tags')); await user.click(screen.getByRole('button', { name: 'Save columns' }));
  await waitFor(() => expect(attempts).toBe(1)); await user.keyboard('{Escape}'); await show(user, 'graph'); await act(async () => first.lose());
  await user.click(await screen.findByRole('button', { name: 'Resume column save' }));
  const dialog = within(await screen.findByRole('dialog', { name: 'My task columns' })); await user.click(dialog.getByRole('button', { name: 'Retry original columns' }));
  await dialog.findByRole('heading', { name: 'Project unavailable' }); expect(dialog.queryByLabelText('Tags')).not.toBeInTheDocument();
  expect(screen.queryByText('private preference details')).not.toBeInTheDocument(); expect(writes(calls)).toHaveLength(2);
});

it.each(['gantt', 'graph', 'import'] as const)('keeps weekly read errors visible in %s without restoring unrelated pickers', async view => {
  const { calls } = installFakeApi(routes({ [`GET ${path}/periods/${PERIOD_A}/task-time-summary`]: () => failure(503, 'SERVICE_UNAVAILABLE', 'hidden weekly diagnostic') }));
  renderApp(legacyTablePath(`${tablePath}?view=${view}&week=${PERIOD_A}&worker=${MEMBER_ID}`));
  expect(await screen.findByRole('heading', { name: 'Unable to load weekly time' })).toBeVisible();
  expect(screen.queryByLabelText('Week for hours')).not.toBeInTheDocument(); expect(screen.queryByText('hidden weekly diagnostic')).not.toBeInTheDocument(); expect(writes(calls)).toHaveLength(0);
});


it('settles the timeline after the page successfully reads an empty task list, before its first dated task arrives', async () => {
  let loaded: TaskDto[] = [];
  const { calls } = installFakeApi(routes({
    [`GET ${rootPath}/tasks`]: () => json(200, { data: loaded, meta: { requestId: 'empty-timeline', nextCursor: null } }),
    [`GET ${path}/schedule-context`]: () => ok(scheduleContext(loaded)),
  }));
  const { queryClient } = renderApp(`${tablePath}?view=gantt`);
  await screen.findByText('No tasks are loaded; the window stays at 28 days.');
  await waitFor(() => expect(queryClient.getQueriesData({ queryKey: queryKeys.tasks(anna.id, alpha.id) }).some(([, data]) => data !== undefined)).toBe(true));
  const opened = (screen.getByLabelText('Window start') as HTMLInputElement).value;
  loaded = [{ ...task, startDate: '2000-01-10', dueDate: '2000-01-11' }];
  await act(async () => { await queryClient.invalidateQueries({ queryKey: queryKeys.tasks(anna.id, alpha.id) }); });
  await screen.findByRole('group', { name: `Calendar dates: ${task.title}` });
  await screen.findByText(/No loaded dates in this window: 1 earlier, 0 later/);
  expect(screen.getByLabelText('Window start')).toHaveValue(opened);
  expect(writes(calls)).toHaveLength(0);
});
