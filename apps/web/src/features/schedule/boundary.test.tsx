import { availabilityReadRoutes, isAvailabilityRead } from './test/availability';
import { QueryClientProvider, type QueryClient } from '@tanstack/react-query';
import { act, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react';
import { taskScheduleContextRowSchema, taskScheduleContextSchema, taskSchedulePreviewSchema, type TaskDto, type TaskScheduleBatchInput, type TaskScheduleContextDto } from '@workloom/contracts';
import type { ReactNode } from 'react';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it } from 'vitest';
import { isUuid } from '../../lib/format';
import { createQueryClient } from '../../lib/queryClient';
import { alpha, alphaMembers, anna, deferred, failure, installFakeApi, ok, project, type FakeRequest, type RouteTable } from '../../test/fakeApi';
import { context as dependencyContext, summary, taskAt } from '../dependencies/test/fixtures';
import { baseline, BASELINE_ID, PERIOD_A, period, PROJECT_ID, rootPath, STAMP } from '../planning/test/fixtures';
import { planningKeys } from '../planning/queries';
import { GanttView } from './GanttView';
import { ScheduleDialog, ScheduleNotices } from './ScheduleDialog';
import { scheduleKeys, useScheduleContext } from './queries';
import { scheduleDraftInput, useScheduleWorkspace, type ScheduleDraft, type ScheduleWorkspace } from './useScheduleWorkspace';

// Production controller/query/components and real QueryClient; fetch is the only transport seam.
const clients: QueryClient[] = [];
afterEach(() => { for (const client of clients.splice(0)) client.clear(); });
const projectPath = `${rootPath}/projects/${PROJECT_ID}`;
const applyPath = `${projectPath}/schedule-apply`;
const previewPath = `${projectPath}/schedule-preview`;
const contextPath = `${projectPath}/schedule-context`;
const hash = 'a'.repeat(64);
function providers() {
  const client = createQueryClient({ retry: false }); clients.push(client);
  return { client, Wrapper: ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}><MemoryRouter>{children}</MemoryRouter></QueryClientProvider> };
}
function row(task: TaskDto, revision = task.revision) {
  return taskScheduleContextRowSchema.parse({ taskId: task.id, taskRevision: revision, current: { startDate: task.startDate ?? null, dueDate: task.dueDate }, meetingId: null, editableDates: true, blocking: summary(task.id), baselineDates: { state: 'not_selected' } });
}
function context(tasks: TaskDto[], revision?: number, withBaseline = false): TaskScheduleContextDto {
  return taskScheduleContextSchema.parse({ projectId: PROJECT_ID, asOfChangeSeq: String(revision ?? 1), baseline: withBaseline ? { baselineId: BASELINE_ID, periodId: PERIOD_A, scope: 'project', membershipId: null, frozenAt: STAMP, sourcePersonalBaselineIds: [] } : null, rows: tasks.map(task => ({ ...row(task, revision ?? task.revision), ...(withBaseline ? { baselineDates: { state: 'captured', startDate: { state: 'not_captured' }, dueDate: { state: 'set', value: '2026-10-20' } } } : {}) })), comparisons: [] });
}
function preview(input: TaskScheduleBatchInput) {
  return taskSchedulePreviewSchema.parse({ projectId: PROJECT_ID, previewHash: hash, asOfChangeSeq: '1', rows: input.rows.map(value => ({ taskId: value.taskId, expectedRevision: value.expectedRevision, before: { startDate: null, dueDate: null }, after: { startDate: value.startDate, dueDate: value.dueDate }, changed: true })), comparisons: [], protectedTargets: [], recoveryPeriodIds: [] });
}
function routes(extra: RouteTable = {}) {
  return installFakeApi({ ...availabilityReadRoutes, [`POST ${previewPath}`]: request => ok(preview(request.body as TaskScheduleBatchInput)), ...extra });
}
function active(c: ScheduleWorkspace): ScheduleDraft { if (!c.active) throw new Error('Expected active draft'); return c.active; }
function open(c: ScheduleWorkspace, task: TaskDto) { c.open([task], new Map([[task.id, row(task)]])); }
function sameRetry(calls: FakeRequest[], input: unknown) {
  const sent = calls.filter(call => call.path === applyPath);
  expect(sent).toHaveLength(2);
  const key = sent[0]?.headers.get('Idempotency-Key') ?? '';
  expect(isUuid(key)).toBe(true);
  for (const call of sent) { expect(call.method).toBe('POST'); expect(call.headers.get('Idempotency-Key')).toBe(key); expect(call.body).toEqual(input); }
}

describe('schedule command boundaries', () => {
  it('globally retries uncertain A with its exact input/key and retires only A while typed B remains', async () => {
    const answer = deferred<undefined>(); let sends = 0;
    const a = taskAt(1), b = taskAt(2);
    const { calls } = routes({ [`POST ${applyPath}`]: async () => { sends++; if (sends === 1) { await answer.promise; throw new TypeError('Failed to fetch'); } return ok({ projectId: PROJECT_ID, tasks: [{ ...a, revision: 2, startDate: '2026-10-21', dueDate: '2026-10-22' }], asOfChangeSeq: '2' }); } });
    const { Wrapper } = providers(); let current: ScheduleWorkspace | undefined;
    function Host() { current = useScheduleWorkspace(anna.id, alpha.id, PROJECT_ID, alpha.timezone); return <ScheduleNotices controller={current} />; }
    render(<Host />, { wrapper: Wrapper });
    const c = () => { if (!current) throw new Error('Expected controller'); return current; };
    act(() => open(c(), a));
    const idA = active(c()).id;
    act(() => c().change(idA, a.id, { startDate: '2026-10-21', dueDate: '2026-10-22' }));
    await act(async () => { await c().preview(active(c())); });
    const input = { ...scheduleDraftInput(active(c())), previewHash: hash };
    act(() => c().apply(active(c())));
    await waitFor(() => expect(calls.filter(call => call.path === applyPath)).toHaveLength(1));
    act(() => open(c(), b));
    const idB = active(c()).id;
    act(() => c().change(idB, b.id, { startDate: '2026-11-02', dueDate: '2026-11-06' }));
    // Unrelated B is editable but cannot replace the still-unconfirmed A command.
    act(() => { c().apply(active(c())); c().change(idA, a.id, { dueDate: '2026-12-31' }); c().discard(idA); });
    expect(c().drafts[idA]?.rows[0]?.dueDate).toBe('2026-10-22');
    await act(async () => { answer.resolve(undefined); });
    await waitFor(() => expect(c().mutation.uncertain?.variables.draftId).toBe(idA));
    await act(async () => { await c().preview(active(c())); });
    expect(calls.filter(call => call.path === applyPath)).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: "Retry original date submission" }));
    await waitFor(() => expect(c().drafts[idA]).toBeUndefined());
    expect(c().activeId).toBe(idB);
    expect(c().drafts[idB]?.rows[0]).toMatchObject({ startDate: '2026-11-02', dueDate: '2026-11-06' });
    sameRetry(calls, input);
  });

  it('rebases only after a confirmed stale outcome, keeps typed dates and requires a new preview with fresh revisions', async () => {
    const a = taskAt(1); let sends = 0;
    const { calls } = routes({ [`GET ${contextPath}`]: () => ok(context([{ ...a, startDate: '2026-10-01', dueDate: '2026-10-02' }], 7)), [`POST ${applyPath}`]: () => ++sends === 1 ? failure(409, 'PREVIEW_STALE', 'Changed sources') : ok({ projectId: PROJECT_ID, tasks: [{ ...a, revision: 8 }], asOfChangeSeq: '8' }) });
    const { Wrapper } = providers(); const view = renderHook(() => useScheduleWorkspace(anna.id, alpha.id, PROJECT_ID, alpha.timezone), { wrapper: Wrapper });
    act(() => open(view.result.current, a));
    const id = active(view.result.current).id;
    act(() => view.result.current.change(id, a.id, { startDate: '2026-11-02', dueDate: '2026-11-06' }));
    await act(async () => { await view.result.current.preview(active(view.result.current)); });
    act(() => view.result.current.apply(active(view.result.current)));
    await waitFor(() => expect(view.result.current.mutation.error).not.toBeNull());
    expect(view.result.current.mutation.uncertain).toBeNull();
    expect(active(view.result.current).rows[0]?.expectedRevision).toBe(1);
    await act(async () => { await view.result.current.rebase(active(view.result.current)); });
    expect(active(view.result.current).rows[0]).toMatchObject({ expectedRevision: 7, startDate: '2026-11-02', dueDate: '2026-11-06', baseStart: '2026-10-01', baseDue: '2026-10-02' });
    expect(active(view.result.current).preview).toBeNull();
    act(() => view.result.current.apply(active(view.result.current)));
    expect(calls.filter(call => call.path === applyPath)).toHaveLength(1);
    await act(async () => { await view.result.current.preview(active(view.result.current)); });
    act(() => view.result.current.apply(active(view.result.current)));
    await waitFor(() => expect(view.result.current.drafts[id]).toBeUndefined());
    const writes = calls.filter(call => call.path === applyPath);
    expect(writes[1]?.body).toEqual({ rows: [{ taskId: a.id, expectedRevision: 7, startDate: '2026-11-02', dueDate: '2026-11-06' }], previewHash: hash });
    expect(writes[1]?.headers.get('Idempotency-Key')).not.toBe(writes[0]?.headers.get('Idempotency-Key'));
  });

  it('ignores a late preview after its source draft changed instead of applying an old review', async () => {
    const a = taskAt(1), response = deferred<Response>();
    routes({ [`POST ${previewPath}`]: () => response.promise });
    const { Wrapper } = providers(); const view = renderHook(() => useScheduleWorkspace(anna.id, alpha.id, PROJECT_ID, alpha.timezone), { wrapper: Wrapper });
    act(() => open(view.result.current, a)); const id = active(view.result.current).id;
    const oldInput = scheduleDraftInput(active(view.result.current)); if (!oldInput) throw new Error('Expected input');
    let request: Promise<void> | undefined;
    act(() => { request = view.result.current.preview(active(view.result.current)); });
    act(() => view.result.current.change(id, a.id, { startDate: '2026-11-01', dueDate: '2026-11-02' }));
    await act(async () => { response.resolve(ok(preview(oldInput))); await request; });
    expect(active(view.result.current).preview).toBeNull();
    expect(active(view.result.current).rows[0]).toMatchObject({ startDate: '2026-11-01', dueDate: '2026-11-02' });
  });

  it('does not replace a newer context revision/overlay with a lower change sequence after refetch', async () => {
    const a = taskAt(1); const fresh = context([a], 9, true); const older = context([a], 2, true);
    routes({ [`GET ${contextPath}`]: () => ok(older) });
    const { client, Wrapper } = providers();
    const key = scheduleKeys.context(anna.id, alpha.id, PROJECT_ID, [a.id], BASELINE_ID);
    client.setQueryData(key, { ...fresh, asOfChangeSeq: '9007199254740997' });
    const view = renderHook(() => useScheduleContext(anna.id, alpha.id, PROJECT_ID, [a.id], BASELINE_ID), { wrapper: Wrapper });
    await act(async () => { await view.result.current.refetch(); });
    expect(view.result.current.rows.get(a.id)?.taskRevision).toBe(9);
    expect(client.getQueryData<TaskScheduleContextDto>(key)?.asOfChangeSeq).toBe('9007199254740997');
  });
});

function mounted() {
  const a = { ...taskAt(1), startDate: '2026-10-21', dueDate: '2026-10-22' };
  const state = { readDenied: false, baselinesDenied: false, applyDenied: false };
  const { calls } = routes({
    [`GET ${contextPath}`]: request => state.readDenied ? failure(403, 'CAPABILITY_REQUIRED', 'Denied current context') : ok(context([a], 1, request.searchParams.has('baselineId'))),
    [`GET ${rootPath}/periods/${PERIOD_A}/baselines`]: () => state.baselinesDenied ? failure(403, 'CAPABILITY_REQUIRED', 'Denied current baseline') : ok([baseline()]),
    [`POST ${applyPath}`]: () => state.applyDenied ? failure(403, 'CAPABILITY_REQUIRED', 'Denied current write') : ok({ projectId: PROJECT_ID, tasks: [a], asOfChangeSeq: '2' }),
  });
  const { client, Wrapper } = providers(); let latest: ScheduleWorkspace | undefined;
  const current = () => { if (!latest) throw new Error('Expected controller'); return latest; };
  function Host() {
    const controller = useScheduleWorkspace(anna.id, alpha.id, PROJECT_ID, alpha.timezone); latest = controller;
    return <><GanttView actorId={anna.id} workspace={alpha} project={project(alpha.id, PROJECT_ID, 'Project')} tasks={[a]} selectedIds={[]} onSelect={() => undefined} periods={[period()]} members={alphaMembers} controller={controller} writable hasMore={false} loadingMore={false} onLoadMore={() => undefined} onOpen={() => undefined} /><ScheduleDialog controller={controller} workspaceId={alpha.id} projectId={PROJECT_ID} periods={[period()]} writable /></>;
  }
  const view = render(<Host />, { wrapper: Wrapper });
  act(() => { current().setBaselinePeriodId(PERIOD_A); current().setBaselineId(BASELINE_ID); current().setWindowStart('2026-10-19'); });
  return { ...view, client, calls, state, a, current };
}

describe('mounted schedule current access', () => {
  for (const source of ['read', 'write'] as const) it(`hides cached dates and overlay on ${source} denial until every authoritative recovery read succeeds`, async () => {
    const view = mounted();
    await waitFor(() => expect(screen.getByRole('button', { name: view.a.title })).toBeInTheDocument());
    expect(screen.getByText(/Start date was not captured in this plan/)).toBeInTheDocument();
    act(() => open(view.current(), view.a));
    const id = active(view.current()).id;
    act(() => view.current().change(id, view.a.id, { startDate: '2026-11-02', dueDate: '2026-11-06' }));
    if (source === 'read') {
      view.state.readDenied = true;
      await act(async () => { await view.client.invalidateQueries({ queryKey: scheduleKeys.context(anna.id, alpha.id, PROJECT_ID, [view.a.id], BASELINE_ID), exact: true }); });
    } else {
      await act(async () => { await view.current().preview(active(view.current())); });
      view.state.applyDenied = true;
      act(() => view.current().apply(active(view.current())));
    }
    await waitFor(() => expect(screen.queryByRole('button', { name: view.a.title })).not.toBeInTheDocument());
    expect(screen.queryByText(/Start date was not captured in this plan/)).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Start date")).not.toBeInTheDocument();
    expect(view.current().drafts[id]?.rows[0]?.startDate).toBe('2026-11-02');
    fireEvent.click(screen.getAllByRole('button', { name: "Close" })[0] as HTMLButtonElement);
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    // One successful context read must not clear denial while the baseline read is still denied.
    view.state.readDenied = false; view.state.baselinesDenied = true;
    fireEvent.click(screen.getByRole('button', { name: "Check timeline access" }));
    await waitFor(() => expect(view.calls.filter(call => call.path.endsWith('/baselines')).length).toBeGreaterThan(1));
    await waitFor(() => expect(screen.getByRole('button', { name: "Check timeline access" })).toBeEnabled());
    expect(screen.queryByRole('button', { name: view.a.title })).not.toBeInTheDocument();
    view.state.baselinesDenied = false;
    fireEvent.click(screen.getByRole('button', { name: "Check timeline access" }));
    await waitFor(() => expect(screen.getByRole('button', { name: view.a.title })).toBeInTheDocument());
    act(() => view.current().setActiveId(id));
    expect(screen.getByLabelText("Start date")).toHaveValue('2026-11-02');
    expect(view.current().drafts[id]?.rows[0]?.startDate).toBe('2026-11-02');
    expect(view.calls.filter(call => call.path === applyPath)).toHaveLength(source === 'write' ? 1 : 0);
    expect(view.client.getQueryData(planningKeys.baselines(anna.id, alpha.id, PERIOD_A))).toBeDefined();
  });
});


describe('multiple schedule context batches', () => {
  const many = () => Array.from({ length: 101 }, (_, index) => taskAt(index + 1));
  it('keeps the newer repeated dependency comparison by numeric sequence across differently aged batches', async () => {
    const tasks = many(), first = tasks[0], last = tasks.at(-1);
    if (!first || !last) throw new Error('Expected endpoint tasks');
    const common = { dependencyId: 'd1000000-0000-4000-8000-000000000001', predecessorTaskId: first.id, successorTaskId: last.id, predecessorContext: dependencyContext(first), successorContext: dependencyContext(last) };
    routes({ [`GET ${contextPath}`]: request => {
      const ids = new Set((request.searchParams.get('taskIds') ?? '').split(','));
      const newest = ids.has(first.id);
      const result = context(tasks.filter(task => ids.has(task.id)));
      return ok({ ...result, asOfChangeSeq: newest ? '100' : '99', comparisons: [{ ...common, predecessorDueDate: newest ? '2026-11-02' : '2026-10-01', successorStartDate: '2026-10-31', state: newest ? 'conflict' : 'compatible' }] });
    } });
    const { Wrapper } = providers();
    const view = renderHook(() => useScheduleContext(anna.id, alpha.id, PROJECT_ID, tasks.map(task => task.id), ''), { wrapper: Wrapper });
    await waitFor(() => expect(view.result.current.pending).toBe(false));
    expect(view.result.current.rows.size).toBe(101);
    expect(view.result.current.comparisons).toEqual([{ ...common, predecessorDueDate: '2026-11-02', successorStartDate: '2026-10-31', state: 'conflict' }]);
  });

  it('hides every cached row and overlay when the first chunk errors500 but a later chunk denies403', async () => {
    const tasks = many(), first = tasks[0]; if (!first) throw new Error('Expected first task');
    let rejectReads = false;
    const { calls } = routes({
      [`GET ${contextPath}`]: request => {
        const ids = new Set((request.searchParams.get('taskIds') ?? '').split(','));
        if (rejectReads) return ids.has(first.id) ? failure(500, 'INTERNAL_ERROR', 'First chunk failed') : failure(403, 'CAPABILITY_REQUIRED', 'Second chunk denied');
        return ok(context(tasks.filter(task => ids.has(task.id)), 1, request.searchParams.has('baselineId')));
      },
      [`GET ${rootPath}/periods/${PERIOD_A}/baselines`]: () => ok([baseline()]),
    });
    const { client, Wrapper } = providers(); let current: ScheduleWorkspace | undefined;
    function Host() {
      const c = useScheduleWorkspace(anna.id, alpha.id, PROJECT_ID, alpha.timezone); current = c;
      return <GanttView actorId={anna.id} workspace={alpha} project={project(alpha.id, PROJECT_ID, 'Project')} tasks={tasks} selectedIds={[]} onSelect={() => undefined} periods={[period()]} members={alphaMembers} controller={c} writable hasMore={false} loadingMore={false} onLoadMore={() => undefined} onOpen={() => undefined} />;
    }
    render(<Host />, { wrapper: Wrapper });
    act(() => { current?.setBaselinePeriodId(PERIOD_A); current?.setBaselineId(BASELINE_ID); });
    await waitFor(() => expect(screen.getByRole('button', { name: first.title })).toBeInTheDocument());
    expect(screen.getAllByText(/Start date was not captured in this plan/)).toHaveLength(101);
    rejectReads = true;
    await act(async () => { await client.invalidateQueries({ queryKey: scheduleKeys.root(anna.id, alpha.id) }); });
    await waitFor(() => expect(screen.queryByRole('button', { name: first.title })).not.toBeInTheDocument());
    expect(screen.queryAllByText(/Start date was not captured in this plan/)).toHaveLength(0);
    expect(screen.getByRole('button', { name: "Check timeline access" })).toBeInTheDocument();
    expect(calls.filter(call => call.method === 'POST' && !isAvailabilityRead(call))).toHaveLength(0);
  });
});
