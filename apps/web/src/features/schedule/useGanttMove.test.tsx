import { QueryClient, QueryClientProvider, QueryObserver } from '@tanstack/react-query';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { useRef, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { protectedDraftsFor } from '../../lib/protectedDrafts';
import { queryKeys } from '../../lib/queryKeys';
import { dateMoveSource, type DateMoveSource } from './dateGesture';
import { dateMoveActive, protectDateMove, useGanttMove, type DateMoveProtection } from './useGanttMove';
import { scheduleContext, scheduledTask, PROJECT_ID } from './test/fixtures';

const ACTOR = 'actor', WORKSPACE = 'workspace';
const clients: QueryClient[] = [];
beforeEach(() => {
  class PointerEventStub extends MouseEvent {
    readonly pointerId: number;
    readonly isPrimary: boolean;
    constructor(type: string, init: PointerEventInit = {}) {
      super(type, init); this.pointerId = init.pointerId ?? 1; this.isPrimary = init.isPrimary ?? true;
    }
  }
  vi.stubGlobal('PointerEvent', PointerEventStub);
});
afterEach(() => { clients.splice(0).forEach(client => client.clear()); });
function client() { const value = new QueryClient({ defaultOptions: { queries: { retry: false } } }); clients.push(value); return value; }
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
const task = scheduledTask(1, '2026-10-24', '2026-10-26');
const original = dateMoveSource(task, scheduleContext([task]).rows[0], { projectId: PROJECT_ID, writable: true, ready: true });

function setup(overrides: { source?: DateMoveSource | null; width?: number; left?: number; accepted?: boolean } = {}) {
  const queryClient = client();
  let release: DateMoveProtection | undefined;
  const onDrop = vi.fn((_proposal, lease: DateMoveProtection) => { release = lease; return overrides.accepted ?? false; });
  const onCancel = vi.fn();
  const capture = vi.fn(), releaseCapture = vi.fn();
  let hasCapture = false;
  const bounds = { left: overrides.left ?? -317, width: 1008 };
  function Harness({ source = original, viewportKey = '28-days', width = 36 }: { source?: DateMoveSource | null; viewportKey?: string; width?: number }) {
    const track = useRef<HTMLDivElement>(null);
    const move = useGanttMove({ actorId: ACTOR, workspaceId: WORKSPACE, source, viewportKey, pixelsPerDay: width,
      getTrack: () => track.current, onDrop, onCancel });
    return <div ref={track} data-testid="track"><button type="button" onPointerDown={move.onPointerDown} onClickCapture={move.onClickCapture}>Move dates</button>
      <output>{move.proposal ? JSON.stringify(move.proposal) : 'saved'}</output></div>;
  }
  const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
  const view = render(<Harness source={overrides.source === undefined ? original : overrides.source} width={overrides.width} />, { wrapper });
  const track = screen.getByTestId('track');
  track.getBoundingClientRect = () => ({ ...bounds, right: bounds.left + bounds.width, top: 0, bottom: 60, height: 60, x: bounds.left, y: 0, toJSON: () => ({}) });
  const button = screen.getByRole('button', { name: 'Move dates' });
  button.setPointerCapture = id => { hasCapture = true; capture(id); };
  button.hasPointerCapture = () => hasCapture;
  button.releasePointerCapture = id => { hasCapture = false; releaseCapture(id); };
  const down = (extra: PointerEventInit = {}) => fireEvent.pointerDown(button, { pointerId: 1, isPrimary: true, button: 0, clientX: 100, ...extra });
  const move = (x: number, pointerId = 1) => fireEvent.pointerMove(document, { pointerId, clientX: x, cancelable: true });
  const up = (x: number, pointerId = 1) => fireEvent.pointerUp(document, { pointerId, clientX: x });
  return { queryClient, onDrop, onCancel, capture, releaseCapture, button, track, bounds, down, move, up, view,
    disposeTransferred: () => release?.dispose(),
    rerender: (props: { source?: DateMoveSource | null; viewportKey?: string; width?: number }) => view.rerender(<Harness {...props} />),
  };
}

describe('Gantt move pointer lifecycle', () => {
  it('protects synchronously at pointerdown before capture and keeps proposal separate from saved source', () => {
    const s = setup({ accepted: true });
    s.capture.mockImplementation(() => expect(protectedDraftsFor(s.queryClient).protecting).toBe(true));
    s.down();
    expect(protectedDraftsFor(s.queryClient).protecting).toBe(true);
    expect(screen.getByRole('status').textContent).toBe('saved');
    s.move(172);
    expect(JSON.parse(screen.getByRole('status').textContent ?? '')).toMatchObject({ startDate: '2026-10-26', dueDate: '2026-10-28', dayDelta: 2 });
    s.up(172);
    expect(s.onDrop).toHaveBeenCalledTimes(1);
    expect(s.onDrop.mock.calls[0]?.[0]).toMatchObject({ source: original, dayDelta: 2 });
    expect(original).toMatchObject({ startDate: '2026-10-24', dueDate: '2026-10-26' });
    expect(protectedDraftsFor(s.queryClient).protecting).toBe(true);
    // A late lostcapture/unmount cannot release a lease already adopted by the persistent draft.
    fireEvent.lostPointerCapture(s.button, { pointerId: 1 }); s.view.unmount();
    expect(protectedDraftsFor(s.queryClient).protecting).toBe(true);
    s.disposeTransferred(); expect(protectedDraftsFor(s.queryClient).protecting).toBe(false);
  });

  it.each([36, 20, 12])('uses client deltas at %ipx per day despite an already scrolled track', width => {
    const s = setup({ width, left: -317 }); s.down(); s.move(100 - width / 2); s.up(100 - width / 2);
    expect(s.onDrop.mock.calls[0]?.[0]).toMatchObject({ dayDelta: -1, startDate: '2026-10-23', dueDate: '2026-10-25' });
    expect(protectedDraftsFor(s.queryClient).protecting).toBe(false);
  });

  it('has a movement threshold, never previews clicks/zero deltas, and ignores unrelated pointers', () => {
    const s = setup(); s.down(); s.move(172, 2); s.up(172, 2); expect(s.onDrop).not.toHaveBeenCalled();
    s.move(103); s.up(103); expect(s.onDrop).not.toHaveBeenCalled();
    expect(protectedDraftsFor(s.queryClient).protecting).toBe(false);
    s.down(); s.move(136); s.move(100); s.up(100); expect(s.onDrop).not.toHaveBeenCalled();
    s.down(); s.move(104); s.up(104); expect(s.onDrop).not.toHaveBeenCalled();
  });

  it('accepts only an eligible source and the primary left pointer', () => {
    const s = setup(); s.down({ isPrimary: false }); s.down({ button: 2 }); expect(s.capture).not.toHaveBeenCalled();
    expect(protectedDraftsFor(s.queryClient).protecting).toBe(false);
    s.rerender({ source: null }); s.down(); expect(s.capture).not.toHaveBeenCalled();
    expect(s.onDrop).not.toHaveBeenCalled();
  });

  it.each(['escape', 'pointercancel', 'lostcapture', 'scroll', 'resize', 'blur'] as const)('cancels %s without dropping or retaining protection', reason => {
    const s = setup(); s.down(); s.move(172);
    if (reason === 'escape') fireEvent.keyDown(document, { key: 'Escape' });
    else if (reason === 'pointercancel') fireEvent.pointerCancel(document, { pointerId: 1 });
    else if (reason === 'lostcapture') fireEvent.lostPointerCapture(s.button, { pointerId: 1 });
    else if (reason === 'scroll') fireEvent.scroll(s.track);
    else fireEvent(window, new Event(reason));
    s.up(172);
    expect(s.onDrop).not.toHaveBeenCalled(); expect(s.onCancel).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('status').textContent).toBe('saved');
    expect(protectedDraftsFor(s.queryClient).protecting).toBe(false);
  });

  it('cancels when a source head, viewport or track geometry changes', () => {
    const s = setup(); s.down(); s.move(172); s.rerender({ source: original ? { ...original, expectedRevision: 2 } : null });
    s.up(172); expect(s.onDrop).not.toHaveBeenCalled();
    s.rerender({}); s.down(); s.rerender({ viewportKey: '84-days', width: 20 }); s.up(172); expect(s.onDrop).not.toHaveBeenCalled();
    s.rerender({}); s.down(); s.bounds.left += 10; s.up(172); expect(s.onDrop).not.toHaveBeenCalled();
    expect(protectedDraftsFor(s.queryClient).protecting).toBe(false);
  });

  it('cleans up failed capture/unmount and suppresses only the click following an activated drag', () => {
    const s = setup(); s.button.setPointerCapture = () => { throw new Error('unsupported'); };
    s.down(); expect(protectedDraftsFor(s.queryClient).protecting).toBe(false); expect(s.onCancel).toHaveBeenCalledWith('capture');
    s.button.setPointerCapture = () => undefined; s.down(); s.move(172); s.up(172);
    expect(fireEvent.click(s.button)).toBe(false); expect(fireEvent.click(s.button)).toBe(true);
    s.down(); s.move(136); s.view.unmount(); expect(protectedDraftsFor(s.queryClient).protecting).toBe(false);
  });

  it('keeps a point endpoint null and refuses a boundary-clamped no-op drop', () => {
    const s = setup({ source: original ? { ...original, startDate: null } : null }); s.down(); s.up(136);
    expect(s.onDrop.mock.calls[0]?.[0]).toMatchObject({ startDate: null, dueDate: '2026-10-27' });
    s.onDrop.mockClear(); s.rerender({ source: original ? { ...original, startDate: null, dueDate: '9999-12-31' } : null });
    s.down(); s.up(136); expect(s.onDrop).not.toHaveBeenCalled();
  });
});

describe('one Gantt gesture per QueryClient', () => {
  it('refuses another bar while a gesture is active, including a second primary pointer, and frees the lock on end/unmount', () => {
    const queryClient = client();
    const onDrop = vi.fn(() => false);
    function Bar({ name }: { name: string }) {
      const track = useRef<HTMLDivElement>(null);
      const move = useGanttMove({ actorId: ACTOR, workspaceId: WORKSPACE, source: original, viewportKey: '28-days', pixelsPerDay: 36, getTrack: () => track.current, onDrop });
      return <div ref={track} data-testid={`track-${name}`}><button type="button" onPointerDown={move.onPointerDown}>{name}</button></div>;
    }
    const view = render(<QueryClientProvider client={queryClient}><Bar name="A" /><Bar name="B" /></QueryClientProvider>);
    const captures = ['A', 'B'].map(name => {
      screen.getByTestId(`track-${name}`).getBoundingClientRect = () => ({ left: 0, width: 1008, right: 1008, top: 0, bottom: 60, height: 60, x: 0, y: 0, toJSON: () => ({}) });
      const button = screen.getByRole('button', { name }), capture = vi.fn();
      button.setPointerCapture = capture; button.hasPointerCapture = () => false; button.releasePointerCapture = () => undefined;
      return { button, capture };
    });
    const [a, b] = captures;
    if (!a || !b) throw new Error('Expected bars');
    fireEvent.pointerDown(a.button, { pointerId: 1, isPrimary: true, button: 0, clientX: 100 });
    expect(dateMoveActive(queryClient)).toBe(true);
    fireEvent.pointerDown(b.button, { pointerId: 2, isPrimary: true, button: 0, clientX: 100 });
    expect(b.capture).not.toHaveBeenCalled();
    fireEvent.pointerUp(document, { pointerId: 2, clientX: 172 });
    expect(onDrop).not.toHaveBeenCalled();
    fireEvent.pointerUp(document, { pointerId: 1, clientX: 172 });
    expect(onDrop).toHaveBeenCalledTimes(1);
    expect(dateMoveActive(queryClient)).toBe(false);
    expect(protectedDraftsFor(queryClient).protecting).toBe(false);
    fireEvent.pointerDown(b.button, { pointerId: 2, isPrimary: true, button: 0, clientX: 100 });
    expect(b.capture).toHaveBeenCalledTimes(1);
    expect(dateMoveActive(queryClient)).toBe(true);
    view.unmount();
    expect(dateMoveActive(queryClient)).toBe(false);
    expect(protectedDraftsFor(queryClient).protecting).toBe(false);
  });
});

describe('synchronous Gantt refresh lease', () => {
  it('cancels old mount-affecting reads even if transport ignores abort, before late answers can replace cache', async () => {
    const queryClient = client();
    const scope = queryKeys.workspace(ACTOR, WORKSPACE);
    const branches = [scope, [...scope, 'project', PROJECT_ID], [...scope, 'tasks', 'list', PROJECT_ID], [...scope, 'schedule', PROJECT_ID], [...scope, 'change-head']];
    const observers: (() => void)[] = [];
    const answers = branches.map(() => deferred<string>());
    const signals: AbortSignal[] = [];
    const inFlights = branches.map((queryKey, index) => {
      queryClient.setQueryData(queryKey, 'retained');
      const observer = new QueryObserver(queryClient, { queryKey, queryFn: ({ signal }) => { signals.push(signal); return answers[index].promise; }, staleTime: Infinity });
      observers.push(observer.subscribe(() => undefined));
      return observer.refetch();
    });
    const reportKey = [...scope, 'planning', 'run', 'immutable'];
    const otherKey = queryKeys.taskList(ACTOR, 'other-workspace', PROJECT_ID, {});
    const reportAnswer = deferred<string>(), otherAnswer = deferred<string>();
    const untouchedSignals: AbortSignal[] = [];
    const untouched = [[reportKey, reportAnswer], [otherKey, otherAnswer]] as const;
    const extraFlights = untouched.map(([queryKey, answer]) => {
      const observer = new QueryObserver(queryClient, { queryKey, queryFn: ({ signal }) => { untouchedSignals.push(signal); return answer.promise; } });
      observers.push(observer.subscribe(() => undefined)); return observer.refetch();
    });
    let lease!: DateMoveProtection;
    act(() => { lease = protectDateMove(queryClient, ACTOR, WORKSPACE); });
    expect(protectedDraftsFor(queryClient).protecting).toBe(true);
    expect(signals.every(signal => signal.aborted)).toBe(true);
    expect(untouchedSignals.every(signal => !signal.aborted)).toBe(true);
    await act(async () => {
      answers.forEach(answer => answer.resolve('late old content'));
      reportAnswer.resolve('immutable report'); otherAnswer.resolve('other workspace');
      await Promise.all([...inFlights, ...extraFlights]);
    });
    branches.forEach(key => expect(queryClient.getQueryData(key)).toBe('retained'));
    expect(queryClient.getQueryData(reportKey)).toBe('immutable report');
    expect(queryClient.getQueryData(otherKey)).toBe('other workspace');
    lease.dispose(); lease.dispose(); expect(protectedDraftsFor(queryClient).protecting).toBe(false);
    observers.forEach(unsubscribe => unsubscribe());
  });
});
