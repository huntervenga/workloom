import { QueryClientProvider, type QueryClient } from '@tanstack/react-query';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ScheduleDependencyComparisonDto, TaskDto } from '@workloom/contracts';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createQueryClient } from '../../lib/queryClient';
import { alpha, alphaMembers, anna, failure, installFakeApi, ok, project, type FakeRequest } from '../../test/fakeApi';
import { context as dependencyContext, taskAt } from '../dependencies/test/fixtures';
import { baseline, period, PERIOD_A, rootPath } from '../planning/test/fixtures';
import { GanttView } from './GanttView';
import { shiftDay, todayIn } from './dates';
import { scheduleKeys } from './queries';
import { BASELINE_ID, PROJECT_ID, scheduleContext, scheduledTask, schedulePath } from './test/fixtures';
import { anchorAttribute } from './useConnectorAnchors';
import { useScheduleWorkspace, type ScheduleWorkspace } from './useScheduleWorkspace';

// Real GanttView/controller/queries; jsdom has no layout, so rows report rects by their rendered order.
const clients: QueryClient[] = [];
let restoreRect: () => void;
beforeEach(() => {
  const original = HTMLElement.prototype.getBoundingClientRect;
  const spy = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    if (this.classList.contains('isolate')) return new DOMRect(0, 0, 1248, 600);
    if (this.hasAttribute(anchorAttribute)) {
      const row = this.closest('[data-gantt-row]');
      const index = [...document.querySelectorAll('[data-gantt-row]')].indexOf(row as Element);
      return new DOMRect(240, 40 + index * 50, 1008, 24);
    }
    return original.call(this);
  });
  restoreRect = () => spy.mockRestore();
});
afterEach(() => { restoreRect(); for (const client of clients.splice(0)) client.clear(); });
const today = todayIn(alpha.timezone);
function day(offset: number) { const value = shiftDay(today, offset); if (!value) throw new Error('Expected day'); return value; }
const writes = (calls: FakeRequest[]) => calls.filter(call => call.method !== 'GET');
let sequence = 0;
function link(from: TaskDto, to: TaskDto, state: 'compatible' | 'conflict' = 'compatible'): ScheduleDependencyComparisonDto {
  return { dependencyId: `d1000000-0000-4000-8000-${String(++sequence).padStart(12, '0')}`, predecessorTaskId: from.id, successorTaskId: to.id, predecessorDueDate: from.dueDate, successorStartDate: to.startDate ?? null, predecessorContext: dependencyContext(from), successorContext: dependencyContext(to), state };
}
const A = scheduledTask(1, day(1), day(3)), B = scheduledTask(2, day(5), day(8)), C = scheduledTask(3, day(2), null);
const M = { ...scheduledTask(4, day(4), day(4)), meetingId: 'af000000-0000-4000-8000-000000000001' };
const F = scheduledTask(5, day(200), day(210)), external = taskAt(40);
const loaded = [A, B, C, M, F];
function comparisons(): ScheduleDependencyComparisonDto[] {
  sequence = 0;
  return [link(A, B), link(A, C, 'conflict'), link(A, M), { ...link(B, F), state: 'unknown', reason: 'missing_date' }, link(B, external), link(B, F)];
}
function mount() {
  const state = { deny: false };
  const { calls } = installFakeApi({
    [`GET ${schedulePath}/schedule-context`]: request => {
      if (state.deny) return failure(403, 'CAPABILITY_REQUIRED', 'Denied');
      const ids = new Set(request.searchParams.get('taskIds')?.split(','));
      return ok({ ...scheduleContext(loaded.filter(task => ids.has(task.id)), request.searchParams.get('baselineId') === BASELINE_ID), comparisons: comparisons() });
    },
    [`GET ${rootPath}/periods/${PERIOD_A}/baselines`]: () => ok([baseline()]),
  });
  const client = createQueryClient({ retry: false }); clients.push(client);
  let latest: ScheduleWorkspace | undefined;
  function Host() {
    const controller = useScheduleWorkspace(anna.id, alpha.id, PROJECT_ID, alpha.timezone); latest = controller;
    return <GanttView actorId={anna.id} workspace={alpha} project={project(alpha.id, PROJECT_ID, 'Project')} tasks={loaded} selectedIds={[]} onSelect={() => undefined} periods={[period()]} members={alphaMembers} controller={controller} writable hasMore={false} loadingMore={false} onLoadMore={() => undefined} onOpen={() => undefined} />;
  }
  render(<QueryClientProvider client={client}><MemoryRouter><Host /></MemoryRouter></QueryClientProvider>);
  return { calls, client, state, controller: () => { if (!latest) throw new Error('Expected controller'); return latest; } };
}
const gantt = () => screen.getByRole('region', { name: 'Project timeline' });
async function showFourWeeksFromToday() {
  await within(gantt()).findByRole('group', { name: `Calendar dates: ${A.title}` });
  fireEvent.click(within(gantt()).getByRole('button', { name: 'Today' }));
  fireEvent.change(within(gantt()).getByLabelText('Days in window'), { target: { value: '28' } });
}

describe('Gantt dependency arrows', () => {
  it('draws measured finish-to-start arrows only between visible loaded endpoints and explains every other link', async () => {
    const { calls } = mount();
    await showFourWeeksFromToday();
    const svg = within(gantt()).getByRole('img', { name: 'Dependency arrows — aligned: 1, date conflicts: 1' });
    expect(svg).toHaveClass('pointer-events-none');
    expect(svg).toHaveClass('z-[1]');
    const aligned = svg.querySelector('[data-state="compatible"]'), conflict = svg.querySelector('[data-state="conflict"]');
    // A ends after its inclusive due day (track 240 + 4 days × 36); B starts at day 5; rows are 50px apart.
    expect(aligned?.querySelector('path')).toHaveAttribute('d', 'M384,52H390V102H420');
    // C is a start-only diamond before A's due date: the conflict detours between the rows into its side.
    expect(conflict?.querySelector('path')).toHaveAttribute('d', 'M384,52H390V102H312.7V152H318.7');
    expect(conflict?.querySelector('path')).toHaveAttribute('stroke-dasharray', '5,3');
    expect(aligned?.querySelector('path')).not.toHaveAttribute('stroke-dasharray');
    expect(svg.querySelectorAll('g')).toHaveLength(2);
    const legend = within(gantt()).getByRole('group', { name: 'Dependency arrows' });
    expect(legend).toHaveTextContent('1 aligned');
    expect(legend).toHaveTextContent('1 date conflict');
    expect(legend).toHaveTextContent('Not drawn: 1 with a meeting (see calendar), 1 missing a date, 1 to a task not loaded here, 1 outside this window.');
    const review = within(legend).getByRole('link', { name: 'Review dependency checks' });
    const checks = document.getElementById(review.getAttribute('href')?.slice(1) ?? '');
    expect(checks).toContainElement(within(gantt()).getByRole('region', { name: 'Dependency date checks' }));
    // The authoritative list keeps every link, including the four that have no arrow.
    expect(within(within(gantt()).getByRole('region', { name: 'Dependency date checks' })).getAllByRole('listitem')).toHaveLength(6);
    expect(writes(calls)).toHaveLength(0);
  });

  it('removes arrows as soon as the window moves their endpoints out, without stale coordinates', async () => {
    mount();
    await showFourWeeksFromToday();
    expect(within(gantt()).getByRole('img', { name: /^Dependency arrows/ })).toBeInTheDocument();
    fireEvent.click(within(gantt()).getByRole('button', { name: 'Next window' }));
    expect(within(gantt()).queryByRole('img', { name: /^Dependency arrows/ })).not.toBeInTheDocument();
    expect(within(gantt()).getByRole('group', { name: 'Dependency arrows' })).toHaveTextContent('Not drawn: 1 with a meeting (see calendar), 1 missing a date, 1 to a task not loaded here, 3 outside this window.');
    fireEvent.click(within(gantt()).getByRole('button', { name: 'Previous window' }));
    expect(within(gantt()).getByRole('img', { name: /^Dependency arrows/ }).querySelectorAll('g')).toHaveLength(2);
  });

  it('clears arrows on denial and redraws them only from the re-authorized, re-measured layout', async () => {
    const view = mount();
    await showFourWeeksFromToday();
    view.state.deny = true;
    await act(async () => { await view.client.invalidateQueries({ queryKey: scheduleKeys.root(anna.id, alpha.id) }); });
    await screen.findByRole('button', { name: 'Check timeline access' });
    expect(document.querySelector('[data-gantt-connectors]')).toBeNull();
    view.state.deny = false;
    fireEvent.click(screen.getByRole('button', { name: 'Check timeline access' }));
    await within(await screen.findByRole('region', { name: 'Project timeline' })).findByRole('img', { name: 'Dependency arrows — aligned: 1, date conflicts: 1' });
    expect(writes(view.calls)).toHaveLength(0);
  });

  it('names the task column after the dates it shows and keeps arrows on current dates under a frozen plan', async () => {
    const user = userEvent.setup();
    const view = mount();
    await showFourWeeksFromToday();
    expect(within(gantt()).getByText('Task · current dates')).toBeInTheDocument();
    await user.click(within(gantt()).getByRole('button', { name: 'Compare with frozen plan' }));
    await user.selectOptions(within(gantt()).getByRole('combobox', { name: 'Plan period' }), PERIOD_A);
    await waitFor(() => expect(within(gantt()).getByRole('combobox', { name: 'Frozen plan to compare' })).toBeEnabled());
    await user.selectOptions(within(gantt()).getByRole('combobox', { name: 'Frozen plan to compare' }), BASELINE_ID);
    await within(gantt()).findByText('Task · current and frozen dates');
    await waitFor(() => expect(within(gantt()).getByRole('img', { name: 'Dependency arrows — aligned: 1, date conflicts: 1' })).toBeInTheDocument());
    expect(view.controller().baselineId).toBe(BASELINE_ID);
    expect(writes(view.calls)).toHaveLength(0);
  });
});
