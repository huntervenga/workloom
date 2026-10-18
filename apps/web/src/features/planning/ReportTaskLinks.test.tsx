import { QueryClientProvider } from '@tanstack/react-query';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { TaskDto, WeeklyPlanFactRowDto } from '@workloom/contracts';
import { MemoryRouter, useLocation } from 'react-router';
import { describe, expect, it } from 'vitest';
import { AppRoutes } from '../../app/AppRoutes';
import { SessionProvider } from '../../app/session';
import { createQueryClient } from '../../lib/queryClient';
import { queryKeys } from '../../lib/queryKeys';
import { alpha, alphaMembers, anna, beta, deferred, failure, installFakeApi, json, ok, renderApp, type RouteTable } from '../../test/fakeApi';
import { categorized, categoryReport, TYPE_RUN } from '../work-categories/test/fixtures';
import { ReportTaskLinks } from './ReportTaskLinks';
import { MEMBER_ID, PACKAGE_ID, PERIOD_A, PROJECT_ID, RUN_ID, TASK_ID, log, report, rootPath, routes, task, weekPath } from './test/fixtures';
import { periodPicker, periodLabel } from './test/pickers';

function taskAt(index: number): TaskDto {
  return { ...task, id: `f2000000-0000-4000-8000-${String(index).padStart(12, '0')}`, title: `Current task ${index}` };
}
function Location() { const location = useLocation(); return <output aria-label="Source location">{location.pathname}{location.search}</output>; }
function renderLinks(ids: string[], cached: TaskDto[] = []) {
  const queryClient = createQueryClient({ retry: false });
  for (const item of cached) queryClient.setQueryData(queryKeys.task(anna.id, alpha.id, item.id), item);
  const user = userEvent.setup();
  const view = render(<QueryClientProvider client={queryClient}><MemoryRouter initialEntries={[`${weekPath}?period=${PERIOD_A}&worker=${MEMBER_ID}&view=report&run=${RUN_ID}`]}><Location /><ReportTaskLinks actorId={anna.id} workspaceId={alpha.id} projectId={PROJECT_ID} periodId={PERIOD_A} membershipId={MEMBER_ID} taskIds={ids} /></MemoryRouter></QueryClientProvider>);
  return { ...view, queryClient, user };
}
/** renderApp with the source location probe inside the same router. */
function renderAppWithLocation(path: string) {
  const queryClient = createQueryClient({ retry: false });
  const user = userEvent.setup({ pointerEventsCheck: 0 });
  const view = render(<QueryClientProvider client={queryClient}><MemoryRouter initialEntries={[path]}><Location /><SessionProvider><AppRoutes /></SessionProvider></MemoryRouter></QueryClientProvider>);
  return { ...view, queryClient, user };
}
function reportRow(overrides: Partial<WeeklyPlanFactRowDto> = {}): WeeklyPlanFactRowDto {
  return { id: 'saved-row', scope: 'original', commitmentId: null, workPackageId: PACKAGE_ID, membershipId: MEMBER_ID, title: 'Название в сохранённом отчёте', memberName: anna.displayName, plannedMinutes: 360, actualMinutes: 300, factRecorded: true, varianceMinutes: -60, packageEstimateMinutes: 1200, packageBaselineId: null, taskIds: [TASK_ID], workLogs: [log(300)], ...overrides };
}
const taskReads = (calls: ReturnType<typeof installFakeApi>['calls']) => calls.filter(call => /\/tasks\/[^/]+$/.test(call.path));

describe('saved report current-task destinations', () => {
  it('reveals every linked task in explicit batches of ten without navigating or writing', async () => {
    const tasks = Array.from({ length: 23 }, (_, index) => taskAt(index + 1));
    const table: RouteTable = {};
    for (const current of tasks) table[`GET ${rootPath}/tasks/${current.id}`] = () => ok(current);
    const { calls } = installFakeApi(table);
    const { user } = renderLinks(tasks.map(item => item.id));
    const source = screen.getByLabelText('Source location').textContent;
    expect(calls).toHaveLength(0);
    await user.click(screen.getByRole('button', { name: 'View linked tasks (23)' }));
    await waitFor(() => expect(screen.getAllByRole('link')).toHaveLength(10));
    expect(taskReads(calls)).toHaveLength(10);
    expect(screen.getByText('Showing 10 of 23 linked tasks.')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Show 10 more tasks' }));
    await waitFor(() => expect(screen.getAllByRole('link')).toHaveLength(20));
    expect(taskReads(calls)).toHaveLength(20);
    await user.click(screen.getByRole('button', { name: 'Show 3 more tasks' }));
    await waitFor(() => expect(screen.getAllByRole('link')).toHaveLength(23));
    expect(taskReads(calls)).toHaveLength(23);
    expect(screen.getByText('Showing 23 of 23 linked tasks.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Show \d+ more/ })).not.toBeInTheDocument();
    for (const current of tasks) {
      const link = screen.getByRole('link', { name: `${current.title} Open current task in a new tab` });
      expect(link).toHaveAttribute('target', '_blank');
      expect(link).toHaveAttribute('rel', 'noopener');
      expect(link).toHaveAttribute('href', `/w/${alpha.id}/projects/${PROJECT_ID}?week=${PERIOD_A}&worker=${MEMBER_ID}&task=${current.id}`);
    }
    expect(screen.getByLabelText('Source location')).toHaveTextContent(source ?? '');
    expect(calls.every(call => call.method === 'GET')).toBe(true);
  });

  it('shows an explicit empty row without querying or choosing a different task', () => {
    const { calls } = installFakeApi({});
    renderLinks([]);
    expect(screen.getByText('No linked tasks in this saved report row.')).toBeInTheDocument();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
    expect(calls).toHaveLength(0);
  });

  it('waits for authorized revalidation even with a fresh cache and hides it again after access is lost', async () => {
    const current = { ...task, title: 'Current authorized title' };
    const gate = deferred<Response>();
    let reads = 0;
    const { calls } = installFakeApi({ [`GET ${rootPath}/tasks/${TASK_ID}`]: () => ++reads === 1 ? gate.promise : failure(403, 'FORBIDDEN', 'Private internal denial') });
    const { user } = renderLinks([TASK_ID], [{ ...task, title: 'Stale cached secret title' }]);
    await user.click(screen.getByRole('button', { name: 'View linked task (1)' }));
    expect(screen.queryByText('Stale cached secret title')).not.toBeInTheDocument();
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
    expect(screen.getByText('Checking current task access…')).toBeInTheDocument();
    await act(async () => gate.resolve(ok(current)));
    expect(await screen.findByRole('link', { name: `${current.title} Open current task in a new tab` })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Hide linked tasks' }));
    await user.click(screen.getByRole('button', { name: 'View linked task (1)' }));
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
    expect(await screen.findByText('This task is no longer available to you.')).toBeInTheDocument();
    expect(screen.queryByText(current.title)).not.toBeInTheDocument();
    expect(document.body).not.toHaveTextContent('Private internal denial');
    expect(taskReads(calls)).toHaveLength(2);
  });

  it('keeps allowed tasks reachable when other tasks are missing or their reads fail', async () => {
    const allowed = taskAt(3);
    const { calls } = installFakeApi({
      [`GET ${rootPath}/tasks/${taskAt(1).id}`]: () => failure(404, 'NOT_FOUND', 'Private missing title'),
      [`GET ${rootPath}/tasks/${taskAt(2).id}`]: () => { throw new Error('Private native failure'); },
      [`GET ${rootPath}/tasks/${allowed.id}`]: () => ok(allowed),
    });
    const { user } = renderLinks([taskAt(1).id, taskAt(2).id, allowed.id]);
    await user.click(screen.getByRole('button', { name: 'View linked tasks (3)' }));
    expect(await screen.findByRole('link', { name: `${allowed.title} Open current task in a new tab` })).toBeInTheDocument();
    expect(screen.getByText('This task is no longer available to you.')).toBeInTheDocument();
    expect(screen.getByText('Unable to check current task access. Try again.')).toBeInTheDocument();
    expect(screen.getAllByRole('link')).toHaveLength(1);
    expect(document.body).not.toHaveTextContent('Private missing title');
    expect(document.body).not.toHaveTextContent('Private native failure');
    expect(taskReads(calls)).toHaveLength(3);
  });

  it('opens a moved task in its current project without carrying the old project period', async () => {
    const moved = { ...task, projectId: 'e0000000-0000-4000-8000-000000000002' };
    installFakeApi({ [`GET ${rootPath}/tasks/${TASK_ID}`]: () => ok(moved) });
    const { user } = renderLinks([TASK_ID]);
    await user.click(screen.getByRole('button', { name: 'View linked task (1)' }));
    const link = await screen.findByRole('link');
    expect(link).toHaveAttribute('href', `/w/${alpha.id}/projects/${moved.projectId}?worker=${MEMBER_ID}&task=${TASK_ID}`);
    expect(link).not.toHaveAttribute('href', expect.stringContaining('week='));
  });

  it('refuses a task response belonging to another workspace', async () => {
    installFakeApi({ [`GET ${rootPath}/tasks/${TASK_ID}`]: () => ok({ ...task, workspaceId: beta.id, title: 'Wrong workspace title' }) });
    const { user } = renderLinks([TASK_ID]);
    await user.click(screen.getByRole('button', { name: 'View linked task (1)' }));
    expect(await screen.findByText('This task is no longer available to you.')).toBeInTheDocument();
    expect(screen.queryByText('Wrong workspace title')).not.toBeInTheDocument();
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
  });

  it('keeps pinned totals and source person while task links use the saved row person', async () => {
    const colleague = alphaMembers[1]; if (!colleague) throw new Error('Missing colleague');
    const second = taskAt(2);
    const third = taskAt(3);
    const run = { ...report(), rowCount: 2 };
    let rowReads = 0;
    const { calls } = installFakeApi({
      ...routes(),
      [`GET ${rootPath}/report-runs/${RUN_ID}`]: () => ok(run),
      [`GET ${rootPath}/report-runs/${RUN_ID}/rows`]: () => json(200, { data: ++rowReads === 1 ? [reportRow({ taskIds: [TASK_ID, second.id] })] : [reportRow({ id: 'later-row', title: 'Вторая сохранённая строка', plannedMinutes: null, factRecorded: false, actualMinutes: 0, varianceMinutes: null, packageEstimateMinutes: null, workLogs: [], taskIds: [third.id] })], meta: { requestId: 'req_report_rows', nextCursor: rowReads === 1 ? 'later' : null } }),
      [`GET ${rootPath}/tasks/${TASK_ID}`]: () => ok({ ...task, title: 'Changed current title', estimateMinutes: 9999 }),
      [`GET ${rootPath}/tasks/${second.id}`]: () => ok(second),
      [`GET ${rootPath}/tasks/${third.id}`]: () => ok(third),
    });
    const sourcePath = `${weekPath}?period=${PERIOD_A}&worker=${colleague.id}&view=report&run=${RUN_ID}`;
    const { user } = renderAppWithLocation(sourcePath);
    await screen.findByText('Название в сохранённом отчёте');
    const summary = screen.getByRole('region', { name: 'Saved report' });
    const pinnedText = summary.textContent;
    expect(taskReads(calls)).toHaveLength(0);
    await user.click(screen.getByRole('button', { name: 'View linked tasks (2)' }));
    const link = await screen.findByRole('link', { name: 'Changed current title Open current task in a new tab' });
    expect(link).toHaveAttribute('href', `/w/${alpha.id}/projects/${PROJECT_ID}?week=${PERIOD_A}&worker=${MEMBER_ID}&task=${TASK_ID}`);
    expect(await screen.findByRole('link', { name: `${second.title} Open current task in a new tab` })).toHaveAttribute('href', `/w/${alpha.id}/projects/${PROJECT_ID}?week=${PERIOD_A}&worker=${MEMBER_ID}&task=${second.id}`);
    expect(screen.getByText('Title in saved report')).toBeInTheDocument();
    expect(screen.getAllByText('Current task title')).toHaveLength(2);
    expect(screen.getByText('Название в сохранённом отчёте')).toBeInTheDocument();
    expect(summary.textContent).toBe(pinnedText);
    expect(screen.getByRole('img', { name: `${anna.displayName}, plan: 6h` })).toBeInTheDocument();
    expect(screen.getByRole('img', { name: `${anna.displayName}, actual: 5h` })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Load more report rows' }));
    await screen.findByText('Вторая сохранённая строка');
    expect(summary.textContent).toBe(pinnedText);
    expect(screen.getByText('Not recorded')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'View linked task (1)' }));
    expect(await screen.findByRole('link', { name: `${third.title} Open current task in a new tab` })).toHaveAttribute('href', `/w/${alpha.id}/projects/${PROJECT_ID}?week=${PERIOD_A}&worker=${MEMBER_ID}&task=${third.id}`);
    expect(screen.queryByRole('combobox', { name: 'Time entry for' })).not.toBeInTheDocument();
    expect(screen.getByLabelText('Source location').textContent).toBe(sourcePath);
    expect(periodPicker()).toHaveTextContent(periodLabel(PERIOD_A));
    expect(screen.getByRole('button', { name: /^Report$/ })).toHaveAttribute('aria-current', 'page');
    expect(calls.filter(call => call.method !== 'GET')).toHaveLength(0);
  });

  it('keeps saved work-type source labels and percentages separate from current task titles', async () => {
    const source = categorized();
    const run = { ...categoryReport(), rowCount: 1, workLogRevisionIds: [source.revisionId] };
    const { calls } = installFakeApi({
      ...routes(),
      [`GET ${rootPath}/work-type-report-runs/${TYPE_RUN}`]: () => ok(run),
      [`GET ${rootPath}/work-type-report-runs/${TYPE_RUN}/rows`]: () => ok([{ id: source.id, workLog: source, taskTitle: 'Историческое название задачи', memberName: anna.displayName, excluded: false }]),
      [`GET ${rootPath}/tasks/${TASK_ID}`]: () => ok({ ...task, title: 'Current work-type task title', estimateMinutes: null }),
    });
    const { user } = renderApp(`${weekPath}?period=${PERIOD_A}&worker=${MEMBER_ID}&view=work-types&typeRun=${TYPE_RUN}`);
    await screen.findByText('Историческое название задачи');
    const summary = screen.getByRole('region', { name: 'Saved breakdown' });
    const pinnedText = summary.textContent;
    const distribution = screen.getByRole('table', { name: 'Share of recorded hours' });
    const pinnedDistribution = distribution.textContent;
    expect(taskReads(calls)).toHaveLength(0);
    await user.click(screen.getByRole('button', { name: 'View linked task (1)' }));
    expect(await screen.findByRole('link', { name: 'Current work-type task title Open current task in a new tab' })).toBeInTheDocument();
    expect(screen.getByText('Title in saved report')).toBeInTheDocument();
    expect(screen.getByText('Current task title')).toBeInTheDocument();
    expect(screen.getByText('Историческое название задачи')).toBeInTheDocument();
    expect(summary.textContent).toBe(pinnedText);
    expect(distribution.textContent).toBe(pinnedDistribution);
    expect(within(distribution).getAllByText('25%')).toHaveLength(2);
    expect(calls.filter(call => call.method !== 'GET')).toHaveLength(0);
  });
});
