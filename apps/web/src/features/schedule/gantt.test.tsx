import { QueryClientProvider, useQuery, type QueryClient } from '@tanstack/react-query';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { TaskDto } from '@workloom/contracts';
import type { ReactNode } from 'react';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it } from 'vitest';
import { createQueryClient } from '../../lib/queryClient';
import { queryKeys } from '../../lib/queryKeys';
import { alpha, alphaMembers, anna, deferred, failure, installFakeApi, ok, project, type FakeRequest } from '../../test/fakeApi';
import { baseline, period, PERIOD_A, rootPath } from '../planning/test/fixtures';
import { GanttView } from './GanttView';
import { shiftDay, todayIn } from './dates';
import { scheduleKeys } from './queries';
import { BASELINE_ID, PROJECT_ID, scheduleContext, scheduledTask, schedulePath } from './test/fixtures';
import { useScheduleWorkspace, type ScheduleWorkspace } from './useScheduleWorkspace';

// Production controller, queries and GanttView; fetch is the only seam and dates come from today's workspace calendar.
const clients: QueryClient[] = [];
afterEach(() => { for (const client of clients.splice(0)) client.clear(); });
const today = todayIn(alpha.timezone);
const medium = new Intl.DateTimeFormat('en', { dateStyle: 'medium', timeZone: 'UTC' });
// Testing Library normalizes the thin spaces Intl puts around the range dash.
const range = (start: string, end: string) => medium.formatRange(new Date(`${start}T00:00:00Z`), new Date(`${end}T00:00:00Z`)).replace(/\s/g, ' ');
function day(offset: number) { const value = shiftDay(today, offset); if (!value) throw new Error('Expected calendar day'); return value; }
const writes = (calls: FakeRequest[]) => calls.filter(call => call.method !== 'GET');
interface HostProps { tasks: TaskDto[]; shown?: boolean; hasMore?: boolean; pageList?: Promise<TaskDto[]>; tasksSettled?: boolean }
function mount(initial: HostProps, routes: { context?: (request: FakeRequest, tasks: TaskDto[]) => Response | Promise<Response> } = {}) {
  let current = initial.tasks;
  const { calls } = installFakeApi({
    [`GET ${schedulePath}/schedule-context`]: request => {
      if (routes.context) return routes.context(request, current);
      const ids = new Set(request.searchParams.get('taskIds')?.split(','));
      return ok(scheduleContext(current.filter(task => ids.has(task.id)), request.searchParams.get('baselineId') === BASELINE_ID));
    },
    [`GET ${rootPath}/periods/${PERIOD_A}/baselines`]: () => ok([baseline()]),
  });
  const client = createQueryClient({ retry: false }); clients.push(client);
  let latest: ScheduleWorkspace | undefined;
  // Mirrors ProjectPage: the controller outlives the view and an unsettled page list passes no tasks.
  function PageList({ list, children }: { list: Promise<TaskDto[]>; children: (tasks: TaskDto[] | undefined) => ReactNode }) {
    const query = useQuery({ queryKey: queryKeys.taskList(anna.id, alpha.id, PROJECT_ID, {}), queryFn: () => list });
    return children(query.data);
  }
  function Host({ tasks, shown = true, hasMore = false, pageList, tasksSettled }: HostProps) {
    const controller = useScheduleWorkspace(anna.id, alpha.id, PROJECT_ID, alpha.timezone); latest = controller;
    const view = (loaded: readonly TaskDto[]) => shown ? <GanttView actorId={anna.id} workspace={alpha} project={project(alpha.id, PROJECT_ID, 'Project')} tasks={loaded} {...(tasksSettled === undefined ? {} : { tasksSettled })} selectedIds={[]} onSelect={() => undefined} periods={[period()]} members={alphaMembers} controller={controller} writable hasMore={hasMore} loadingMore={false} onLoadMore={() => undefined} onOpen={() => undefined} /> : <p>{'table'}</p>;
    return pageList ? <PageList list={pageList}>{loaded => view(loaded ?? [])}</PageList> : view(tasks);
  }
  const wrap = (props: HostProps) => <QueryClientProvider client={client}><MemoryRouter><Host {...props} /></MemoryRouter></QueryClientProvider>;
  const view = render(wrap(initial));
  return {
    calls, client,
    gantt: () => screen.getByRole('region', { name: 'Project timeline' }),
    controller: () => { if (!latest) throw new Error('Expected controller'); return latest; },
    update: (props: HostProps) => { current = props.tasks; view.rerender(wrap(props)); },
  };
}
const windowStart = () => within(screen.getByRole('region', { name: 'Project timeline' })).getByLabelText('Window start');

describe('first-open window', () => {
  it('opens once at overdue loaded dates, then Today/Fit stay explicit and nothing is written', async () => {
    const overdue = scheduledTask(1, day(-40), day(-35));
    const dueOnly = scheduledTask(2, null, day(-20));
    const undated = scheduledTask(3);
    const { calls, gantt } = mount({ tasks: [undated, overdue, dueOnly], hasMore: true });
    await within(gantt()).findByRole('group', { name: `Calendar dates: ${overdue.title}` });
    // Span 21 days → 28-day window with a one-day lead-in before the earliest overdue start.
    expect(windowStart()).toHaveValue(day(-41));
    expect(within(gantt()).getByLabelText('Days in window')).toHaveValue('28');
    expect(within(gantt()).getByRole('status')).toHaveTextContent(`Opened at 2 dated tasks: ${range(day(-40), day(-20))}. Loaded, filtered tasks only; more pages not loaded.`);
    expect(within(gantt()).getByText(`${range(day(-41), day(-14))} · 3 loaded tasks · more not loaded`, { exact: false })).toBeInTheDocument();
    expect(within(gantt()).getByRole('img', { name: `Current: start ${day(-40)}, due ${day(-35)}` })).toBeInTheDocument();
    expect(within(gantt()).getByRole('img', { name: `Current: start Not set, due ${day(-20)}; only due date` })).toBeInTheDocument();

    fireEvent.click(within(gantt()).getByRole('button', { name: 'Today' }));
    expect(windowStart()).toHaveValue(today);
    expect(within(gantt()).getByRole('status')).toHaveTextContent('No loaded dates in this window: 2 earlier, 0 later. Use Fit loaded tasks to show them.');
    const fit = within(gantt()).getByRole('button', { name: 'Fit loaded tasks' });
    expect(fit).toHaveClass('bg-accent');
    fireEvent.click(fit);
    expect(windowStart()).toHaveValue(day(-41));
    expect(within(gantt()).getByRole('status')).toHaveTextContent(`Fitted to 2 dated tasks: ${range(day(-40), day(-20))}.`);
    expect(writes(calls)).toHaveLength(0);
  });

  it('lets a manual window choice made before a delayed context win over the late snapshot', async () => {
    const overdue = scheduledTask(1, day(-60), day(-58));
    const response = deferred<Response>();
    const { calls, gantt, controller } = mount({ tasks: [overdue] }, { context: () => response.promise });
    expect(within(gantt()).getByRole('status')).toHaveTextContent('Loading current dates…');
    fireEvent.click(within(gantt()).getByRole('button', { name: 'Next window' }));
    expect(windowStart()).toHaveValue(day(28));
    await act(async () => { response.resolve(ok(scheduleContext([overdue]))); });
    await within(gantt()).findByRole('group', { name: `Calendar dates: ${overdue.title}` });
    expect(windowStart()).toHaveValue(day(28));
    expect(controller().windowFit).toBeNull();
    expect(within(gantt()).getByRole('status')).toHaveTextContent('No loaded dates in this window: 1 earlier, 0 later.');
    expect(writes(calls)).toHaveLength(0);
  });

  it('does not refit after refetch, a newly loaded task or a view remount', async () => {
    const first = scheduledTask(1, day(-30), day(-28));
    const harness = mount({ tasks: [first] });
    await within(harness.gantt()).findByRole('group', { name: `Calendar dates: ${first.title}` });
    const opened = day(-31);
    expect(windowStart()).toHaveValue(opened);
    const later = scheduledTask(2, day(200), day(210));
    harness.update({ tasks: [first, later] });
    await within(harness.gantt()).findByRole('group', { name: `Calendar dates: ${later.title}` });
    await act(async () => { await harness.client.invalidateQueries({ queryKey: scheduleKeys.root(anna.id, alpha.id) }); });
    expect(windowStart()).toHaveValue(opened);
    harness.update({ tasks: [first, later], shown: false });
    expect(screen.queryByRole('region', { name: 'Project timeline' })).not.toBeInTheDocument();
    harness.update({ tasks: [first, later], shown: true });
    await within(harness.gantt()).findByRole('group', { name: `Calendar dates: ${later.title}` });
    expect(windowStart()).toHaveValue(opened);
    expect(harness.controller().windowFit?.origin).toBe('initial');
    expect(writes(harness.calls)).toHaveLength(0);
  });

  it('settles on today when loaded tasks have no dates, and a later dated task does not move it', async () => {
    const harness = mount({ tasks: [scheduledTask(1), scheduledTask(2)] });
    await within(harness.gantt()).findByRole('group', { name: 'No dates · 2 tasks' });
    expect(windowStart()).toHaveValue(today);
    const fit = within(harness.gantt()).getByRole('button', { name: 'Fit loaded tasks' });
    expect(fit).toBeDisabled();
    expect(fit).toHaveAccessibleDescription('No loaded task has a start or due date; the window stays at 28 days.');
    const dated = scheduledTask(3, day(-50), day(-49));
    harness.update({ tasks: [scheduledTask(1), scheduledTask(2), dated] });
    await within(harness.gantt()).findByRole('group', { name: `Calendar dates: ${dated.title}` });
    expect(windowStart()).toHaveValue(today);
    expect(within(harness.gantt()).getByRole('status')).toHaveTextContent('No loaded dates in this window: 1 earlier, 0 later.');
  });

  it('waits for the page task list instead of settling on its empty placeholder', async () => {
    const list = deferred<TaskDto[]>();
    const task = scheduledTask(1, day(-90), day(-89));
    const harness = mount({ tasks: [task], pageList: list.promise });
    expect(within(harness.gantt()).getByText('No tasks match the current filter.')).toBeInTheDocument();
    expect(windowStart()).toHaveValue(today);
    await act(async () => { list.resolve([task]); });
    await within(harness.gantt()).findByRole('group', { name: `Calendar dates: ${task.title}` });
    expect(windowStart()).toHaveValue(day(-91));
  });

  it('settles an empty project only on an explicit page signal, so its first new task does not move the window', async () => {
    const harness = mount({ tasks: [], tasksSettled: true });
    await within(harness.gantt()).findByText('No tasks are loaded; the window stays at 28 days.');
    const created = scheduledTask(1, day(-10), day(-9));
    harness.update({ tasks: [created], tasksSettled: true });
    await within(harness.gantt()).findByRole('group', { name: `Calendar dates: ${created.title}` });
    expect(windowStart()).toHaveValue(today);
    expect(harness.controller().windowFit).toBeNull();
  });

  it('never initializes from denied data; the first authorized snapshot after recovery does', async () => {
    const task = scheduledTask(1, day(-20), day(-19));
    let deny = true;
    const harness = mount({ tasks: [task] }, { context: (_request, tasks) => deny ? failure(403, 'CAPABILITY_REQUIRED', 'Denied') : ok(scheduleContext(tasks)) });
    const check = await screen.findByRole('button', { name: 'Check timeline access' });
    expect(harness.controller().windowStart).toBe(today);
    expect(harness.controller().windowFit).toBeNull();
    deny = false;
    fireEvent.click(check);
    await within(await screen.findByRole('region', { name: 'Project timeline' })).findByRole('group', { name: `Calendar dates: ${task.title}` });
    expect(windowStart()).toHaveValue(day(-21));
    expect(writes(harness.calls)).toHaveLength(0);
  });

  it('bounds and explains a first-open span wider than 366 days', async () => {
    const early = scheduledTask(1, '2020-01-06', '2020-01-10'), late = scheduledTask(2, null, day(5));
    const { gantt } = mount({ tasks: [early, late] });
    await within(gantt()).findByRole('group', { name: `Calendar dates: ${early.title}` });
    expect(windowStart()).toHaveValue('2020-01-06');
    expect(within(gantt()).getByLabelText('Days in window')).toHaveValue('366');
    expect(within(gantt()).getByRole('status')).toHaveTextContent(`(${range('2020-01-06', day(5))}); showing the first 366 from the earliest. Loaded, filtered tasks only.`);
    expect(within(within(gantt()).getByRole('list', { name: 'Calendar window days' })).getAllByRole('listitem')).toHaveLength(366);
  });
});

describe('compact readable Gantt', () => {
  it('keeps undated tasks in an explicit No dates group with complete names, compact edit control and today cue', async () => {
    const dated = scheduledTask(1, day(1), day(3));
    const undated = { ...scheduledTask(2), title: 'A very long task title that must stay complete for assistive technology and tooltips' };
    const { gantt } = mount({ tasks: [undated, dated] });
    const datedRow = await within(gantt()).findByRole('group', { name: `Calendar dates: ${dated.title}` });
    expect(within(datedRow).getByText(`Start: ${day(1)} · Due: ${day(3)}`)).toBeInTheDocument();
    expect(within(datedRow).getByRole('button', { name: 'Edit dates' })).toHaveTextContent('Edit');
    const noDates = within(gantt()).getByRole('group', { name: 'No dates · 1 task' });
    const undatedRow = within(noDates).getByRole('group', { name: `Calendar dates: ${undated.title}` });
    const name = within(undatedRow).getByRole('button', { name: undated.title });
    expect(name).toHaveAttribute('title', undated.title);
    expect(name).toHaveClass('truncate');
    const rows = within(gantt()).getAllByRole('group', { name: /^Calendar dates:/ });
    expect(rows.map(row => row.getAttribute('aria-label'))).toEqual([`Calendar dates: ${dated.title}`, `Calendar dates: ${undated.title}`]);
    const axis = within(gantt()).getByRole('list', { name: 'Calendar window days' });
    const current = axis.querySelector('[aria-current="date"]');
    expect(current).toHaveAttribute('title', today);
    expect(current).toHaveTextContent('(today)');
    expect(axis.style.width).toBe(`${28 * 36}px`);
  });

  it('opens About and comparison by keyboard, labels the active plan outside the disclosure and clears it without writes', async () => {
    const user = userEvent.setup();
    const task = scheduledTask(1, day(1), day(2));
    const { calls, gantt } = mount({ tasks: [task] });
    await within(gantt()).findByRole('group', { name: `Calendar dates: ${task.title}` });
    const about = within(gantt()).getByRole('button', { name: 'About timeline' });
    expect(about).toHaveAttribute('aria-expanded', 'false');
    expect(within(gantt()).queryByText(/workspace calendar \(/)).not.toBeVisible();
    about.focus(); await user.keyboard('{Enter}');
    expect(about).toHaveAttribute('aria-expanded', 'true');
    expect(within(gantt()).getByText(new RegExp(`inclusive, in the workspace calendar \\(${alpha.timezone}\\)`))).toBeVisible();
    expect(within(gantt()).getByText('Dates do not change the team estimate, personal plan, or actual hours.')).toBeVisible();

    const compare = within(gantt()).getByRole('region', { name: 'Compare with a frozen plan' });
    const toggle = within(compare).getByRole('button', { name: 'Compare with frozen plan' });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(within(compare).queryByRole('combobox', { name: 'Plan period' })).not.toBeInTheDocument();
    toggle.focus(); await user.keyboard('{Enter}');
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    await user.selectOptions(within(compare).getByRole('combobox', { name: 'Plan period' }), PERIOD_A);
    await waitFor(() => expect(within(compare).getByRole('combobox', { name: 'Frozen plan to compare' })).toBeEnabled());
    await user.selectOptions(within(compare).getByRole('combobox', { name: 'Frozen plan to compare' }), BASELINE_ID);
    const edit = await within(compare).findByRole('button', { name: 'Edit comparison' });
    await user.click(edit);
    expect(edit).toHaveAttribute('aria-expanded', 'false');
    expect(within(compare).queryByRole('combobox', { name: 'Plan period' })).not.toBeInTheDocument();
    expect(within(compare).getByText(/^Comparing with Project · /)).toBeVisible();
    const row = within(gantt()).getByRole('group', { name: `Calendar dates: ${task.title}` });
    await within(row).findByText(/Start date was not captured in this plan/);
    // The uncaptured start is never replaced by the current start: only the frozen due endpoint is drawn.
    expect(within(row).getByRole('img', { name: `Frozen: start Start date was not captured in this plan, due ${day(2)}; only due date` })).toBeInTheDocument();
    await user.click(within(compare).getByRole('button', { name: 'Clear comparison' }));
    expect(within(compare).queryByText(/^Comparing with/)).not.toBeInTheDocument();
    expect(within(compare).getByRole('button', { name: 'Compare with frozen plan' })).toBeInTheDocument();
    await waitFor(() => expect(within(row).queryByText(/Start date was not captured in this plan/)).not.toBeInTheDocument());
    expect(writes(calls)).toHaveLength(0);
  });
});
