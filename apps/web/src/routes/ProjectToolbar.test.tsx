import type { ColumnChoice, PersonalTablePreferenceDto } from '@workloom/contracts';
import { act, screen, waitFor, within } from '@testing-library/react';
import { beforeAll, expect, it } from 'vitest';
import { alpha, alphaMembers, failure, installFakeApi, json, ok, renderApp, type RouteTable } from '../test/fakeApi';
import { graph, layout } from '../features/dependencies/test/fixtures';
import { scheduleContext } from '../features/schedule/test/fixtures';
import { lostResponse } from '../features/planning/test/fixtures';
import { columns, field } from '../features/fields/test/fixtures';
import { MEMBER_ID, PERIOD_A, PROJECT_ID, categorized, rootPath, task, tablePath, tableRoutes } from '../features/work-categories/test/fixtures';

beforeAll(async () => { await import('./ProjectPage'); });
const path = `${rootPath}/projects/${PROJECT_ID}`;
const preferencePath = `${path}/table-preferences/me`;
function routes(extra: RouteTable = {}): RouteTable {
  return { ...tableRoutes(), [`GET ${rootPath}/tasks`]: () => json(200, { data: [task], meta: { requestId: 'toolbar-fixture', nextCursor: null } }),
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
const writes = (calls: ReturnType<typeof installFakeApi>['calls']) => calls.filter(call => call.method !== 'GET');

it.each(['table', 'board', 'gantt', 'graph', 'import'] as const)('shows only controls that act on the %s presentation', async view => {
  const { calls } = installFakeApi(routes()); renderApp(`${tablePath}?${view === 'table' ? '' : `view=${view}&`}week=${PERIOD_A}&worker=${MEMBER_ID}`);
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
  const { calls } = installFakeApi(routes()); const { user } = renderApp(`${tablePath}?week=${PERIOD_A}&worker=${person}&other=kept#anchor`);
  await screen.findByRole('button', { name: 'Columns' }); await user.type(screen.getByLabelText('Search tasks'), 'retained search');
  await user.click(screen.getByText('Filters', { selector: 'summary' })); await user.selectOptions(screen.getByLabelText('Task participant'), MEMBER_ID);
  await user.click(screen.getByText('Filters (1)', { selector: 'summary' }));
  await user.selectOptions(screen.getByLabelText('Group by'), 'assignee'); await user.selectOptions(screen.getByLabelText('Sort'), 'due_asc');
  await user.click(screen.getByRole('button', { name: 'Columns' })); await user.click(screen.getByLabelText('Tags')); await user.keyboard('{Escape}');
  const weekHref = views().getByRole('link', { name: 'Week' }).getAttribute('href');
  for (const view of ['graph', 'import', 'gantt', 'board'] as const) {
    await show(user, view); expect(screen.queryByLabelText('Week for hours')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Columns · unsaved' })).not.toBeInTheDocument();
    expect(views().getByRole('link', { name: 'Week' })).toHaveAttribute('href', weekHref);
  }
  await show(user, 'table');
  expect(screen.getByLabelText('Week for hours')).toHaveValue(PERIOD_A); expect(screen.getByLabelText('Whose hours to show')).toHaveValue(person);
  expect(screen.getByLabelText('Search tasks')).toHaveValue('retained search'); expect(screen.getByText('Filters (1)', { selector: 'summary' })).toBeInTheDocument();
  expect(screen.getByLabelText('Group by')).toHaveValue('assignee'); expect(screen.getByLabelText('Sort')).toHaveValue('due_asc');
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
  const { user } = renderApp(`${tablePath}?week=${PERIOD_A}&worker=${MEMBER_ID}`);
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
  expect(views().getByRole('link', { name: 'Week' }).getAttribute('href')).toContain(`period=${PERIOD_A}`);
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
  renderApp(`${tablePath}?view=${view}&week=${PERIOD_A}&worker=${MEMBER_ID}`);
  expect(await screen.findByRole('heading', { name: 'Unable to load weekly time' })).toBeVisible();
  expect(screen.queryByLabelText('Week for hours')).not.toBeInTheDocument(); expect(screen.queryByText('hidden weekly diagnostic')).not.toBeInTheDocument(); expect(writes(calls)).toHaveLength(0);
});
