import { CancelledError, QueryClient, QueryObserver, onlineManager, type QueryKey } from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { queryKeys } from '../../lib/queryKeys';
import { isWorkspaceLiveKey, refreshWorkspaceLiveQueries } from './workspaceLiveQueries';

const ACTOR = 'actor-a'; const WORKSPACE = 'workspace-a';
const scope = queryKeys.workspace(ACTOR, WORKSPACE);
const clients: QueryClient[] = [];
const disposers: (() => void)[] = [];
function setup() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  clients.push(client); return client;
}
function active(client: QueryClient, key: QueryKey, read: (context: { signal: AbortSignal }) => Promise<unknown>, enabled = true) {
  const observer = new QueryObserver(client, { queryKey: key, queryFn: read, enabled, staleTime: Infinity });
  disposers.push(observer.subscribe(() => undefined)); return observer;
}
function held<T>() {
  let resolve!: (value: T) => void; let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject };
}
async function settle() { for (let i = 0; i < 20; i++) await Promise.resolve(); }
afterEach(() => { disposers.splice(0).forEach(dispose => dispose()); clients.splice(0).forEach(client => client.clear()); });

describe('workspace live query classification', () => {
  it('includes every audited mutable branch, run lists, import reconciliation and MCP metadata', () => {
    for (const branch of ['memberships', 'projects', 'project', 'tags', 'tasks', 'fields', 'workCategoryBinding',
      'timeSummaries', 'planning', 'workCategories', 'meetings', 'recurrence', 'dependencies', 'schedule', 'cutoff', 'imports', 'local-mcp-credentials', 'generic-reports', 'time-off']) {
      expect(isWorkspaceLiveKey([...scope, branch], ACTOR, WORKSPACE)).toBe(true);
    }
    for (const suffix of [[], ['planning', 'period', 'period-a', 'runs'], ['workCategories', 'runs', 'period-a'],
      ['generic-reports', 'definition', 'report-a', 'result', { snapshotId: 'initial-a' }], ['generic-reports', 'aggregate-settings', 'project-a'],
      ['imports', 'project-a', 'import-a', 'reconciliation'], ['planning', 'original-estimate', 'package-a']]) {
      expect(isWorkspaceLiveKey([...scope, ...suffix], ACTOR, WORKSPACE)).toBe(true);
    }
  });
  it('excludes other actors/workspaces, both pinned run branches, the head and unclassified future readers', () => {
    for (const suffix of [['change-head'], ['planning', 'run', 'run-a'], ['planning', 'run', 'run-a', 'rows'],
      ['workCategories', 'run', 'run-a'], ['workCategories', 'run', 'run-a', 'rows'], ['future-explicit-preview']]) {
      expect(isWorkspaceLiveKey([...scope, ...suffix], ACTOR, WORKSPACE)).toBe(false);
    }
    for (const key of [queryKeys.me, queryKeys.workspaces(ACTOR), queryKeys.workspace('actor-b', WORKSPACE), queryKeys.workspace(ACTOR, 'workspace-b')]) {
      expect(isWorkspaceLiveKey(key, ACTOR, WORKSPACE)).toBe(false);
    }
  });
});

describe('fresh catch-up completion', () => {
  it('cancels a pre-head read of previously successful data and only accepts its replacement from the server', async () => {
    const client = setup(); const key = [...scope, 'tasks', 'list']; const before = held<string>(); const fresh = held<string>();
    client.setQueryData(key, 'cached'); await client.invalidateQueries({ queryKey: key, refetchType: 'none' });
    const read = vi.fn().mockReturnValueOnce(before.promise).mockReturnValueOnce(fresh.promise);
    active(client, key, read); await settle(); expect(read).toHaveBeenCalledTimes(1);
    const pass = refreshWorkspaceLiveQueries(client, ACTOR, WORKSPACE, new AbortController().signal, () => true);
    await settle(); expect(read).toHaveBeenCalledTimes(2);
    before.resolve('old'); await settle(); expect(client.getQueryState(key)).toMatchObject({ data: 'cached', dataUpdateCount: 1 });
    fresh.resolve('fresh'); expect(await pass).toEqual({ complete: true, followUp: false });
    expect(client.getQueryState(key)).toMatchObject({ status: 'success', data: 'fresh', dataUpdateCount: 2 });
  });

  it.each(['success', 'error'] as const)('leaves a never-successful initial read and its signal untouched across catch-up and protection abort until %s', async outcome => {
    const client = setup(); const key = [...scope, 'projects']; const initial = held<string>(); const signals: AbortSignal[] = [];
    const read = vi.fn(({ signal }: { signal: AbortSignal }) => { signals.push(signal); return initial.promise; });
    const observer = active(client, key, read); await settle();
    expect(observer.getCurrentResult()).toMatchObject({ status: 'pending', fetchStatus: 'fetching' });
    const protection = new AbortController();
    const pass = refreshWorkspaceLiveQueries(client, ACTOR, WORKSPACE, protection.signal, () => true);
    await settle(); expect(read).toHaveBeenCalledTimes(1); expect(signals[0]?.aborted).toBe(false);
    expect(client.getQueryState(key)).toMatchObject({ status: 'pending', fetchStatus: 'fetching', dataUpdateCount: 0 });
    protection.abort(); await settle(); expect(signals[0]?.aborted).toBe(false);
    expect(client.getQueryState(key)).toMatchObject({ status: 'pending', fetchStatus: 'fetching', dataUpdateCount: 0 });
    expect((await pass).complete).toBe(false);
    const failure = new Error('offline');
    if (outcome === 'success') initial.resolve('projects'); else initial.reject(failure);
    await settle(); expect(read).toHaveBeenCalledTimes(1);
    expect(observer.getCurrentResult()).toMatchObject(outcome === 'success'
      ? { status: 'success', fetchStatus: 'idle', data: 'projects' }
      : { status: 'error', fetchStatus: 'idle', data: undefined, error: failure });
    expect(client.getQueryState(key)?.dataUpdateCount).toBe(outcome === 'success' ? 1 : 0);
  });

  it('never force-refetches an initial error and leaves its explicit retry to the feature owner', async () => {
    const client = setup(); const key = [...scope, 'projects']; const initialError = new Error('initial');
    const retry = held<string>(); const signals: AbortSignal[] = [];
    const read = vi.fn<(context: { signal: AbortSignal }) => Promise<string>>()
      .mockImplementationOnce(() => Promise.reject(initialError))
      .mockImplementationOnce(({ signal }) => { signals.push(signal); return retry.promise; })
      .mockResolvedValueOnce('fresh');
    const observer = active(client, key, read); await settle();
    expect(observer.getCurrentResult()).toMatchObject({ status: 'error', fetchStatus: 'idle', data: undefined, error: initialError });
    const first = refreshWorkspaceLiveQueries(client, ACTOR, WORKSPACE, new AbortController().signal, () => true);
    await settle(); expect(read).toHaveBeenCalledTimes(1);
    expect((await first).complete).toBe(false);
    expect(client.getQueryState(key)).toMatchObject({ status: 'error', fetchStatus: 'idle', error: initialError, dataUpdateCount: 0 });

    const retrying = observer.refetch(); await settle(); expect(read).toHaveBeenCalledTimes(2);
    expect(client.getQueryState(key)).toMatchObject({ status: 'pending', fetchStatus: 'fetching', dataUpdateCount: 0 });
    const protection = new AbortController();
    const during = refreshWorkspaceLiveQueries(client, ACTOR, WORKSPACE, protection.signal, () => true);
    await settle(); expect(read).toHaveBeenCalledTimes(2); expect(signals[0]?.aborted).toBe(false);
    protection.abort(); await settle(); expect(signals[0]?.aborted).toBe(false);
    expect(client.getQueryState(key)).toMatchObject({ status: 'pending', fetchStatus: 'fetching', dataUpdateCount: 0 });
    expect((await during).complete).toBe(false);
    retry.resolve('projects');
    expect(await retrying).toMatchObject({ status: 'success', fetchStatus: 'idle', data: 'projects' });
    expect(client.getQueryState(key)?.dataUpdateCount).toBe(1);

    expect(await refreshWorkspaceLiveQueries(client, ACTOR, WORKSPACE, new AbortController().signal, () => true))
      .toEqual({ complete: true, followUp: false });
    expect(read).toHaveBeenCalledTimes(3);
    expect(client.getQueryState(key)).toMatchObject({ status: 'success', data: 'fresh', dataUpdateCount: 2 });
  });

  it('does not apply an initial read that succeeds during a pass and rereads it in a later pass', async () => {
    const client = setup(); const projects = [...scope, 'projects']; const tasks = [...scope, 'tasks'];
    const initial = held<string>(); const taskRefresh = held<string>(); client.setQueryData(tasks, 'cached tasks');
    const readProjects = vi.fn().mockReturnValueOnce(initial.promise).mockResolvedValueOnce('fresh projects');
    const readTasks = vi.fn().mockReturnValueOnce(taskRefresh.promise).mockResolvedValueOnce('tasks again');
    const observer = active(client, projects, readProjects); active(client, tasks, readTasks); await settle();
    expect(readProjects).toHaveBeenCalledTimes(1); expect(readTasks).not.toHaveBeenCalled();
    const first = refreshWorkspaceLiveQueries(client, ACTOR, WORKSPACE, new AbortController().signal, () => true);
    await settle(); expect(readProjects).toHaveBeenCalledTimes(1); expect(readTasks).toHaveBeenCalledTimes(1);
    initial.resolve('initial projects'); await settle();
    expect(client.getQueryState(projects)).toMatchObject({ status: 'success', fetchStatus: 'idle', data: 'initial projects', dataUpdateCount: 1 });
    taskRefresh.resolve('fresh tasks');
    expect((await first).complete).toBe(false);
    expect(client.getQueryState(tasks)).toMatchObject({ status: 'success', data: 'fresh tasks', dataUpdateCount: 2 });

    expect(await refreshWorkspaceLiveQueries(client, ACTOR, WORKSPACE, new AbortController().signal, () => true))
      .toEqual({ complete: true, followUp: false });
    expect(readProjects).toHaveBeenCalledTimes(2);
    expect(observer.getCurrentResult()).toMatchObject({ status: 'success', data: 'fresh projects' });
    expect(client.getQueryState(projects)?.dataUpdateCount).toBe(2);
  });

  it('retains old data and reports failure when an active read rejects; an equal-head pass can retry', async () => {
    const client = setup(); const key = [...scope, 'tasks']; client.setQueryData(key, 'retained');
    const read = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce('new'); active(client, key, read);
    expect(await refreshWorkspaceLiveQueries(client, ACTOR, WORKSPACE, new AbortController().signal, () => true))
      .toEqual({ complete: false, followUp: false });
    expect(client.getQueryData(key)).toBe('retained');
    expect(await refreshWorkspaceLiveQueries(client, ACTOR, WORKSPACE, new AbortController().signal, () => true))
      .toEqual({ complete: true, followUp: false });
    expect(read).toHaveBeenCalledTimes(2); expect(client.getQueryData(key)).toBe('new');
  });

  it('marks inactive live reads stale, preserves immutable payloads and never refetches disabled controls', async () => {
    const client = setup(); const inactive = [...scope, 'projects']; const pinned = [...scope, 'planning', 'run', 'run-a'];
    const categoryPinned = [...scope, 'workCategories', 'run', 'run-a', 'rows']; const head = [...scope, 'change-head'];
    for (const key of [inactive, pinned, categoryPinned, head]) client.setQueryData(key, 'cached');
    const disabledRead = vi.fn().mockResolvedValue('disabled'); active(client, [...scope, 'planning', 'period', 'invalid'], disabledRead, false);
    expect(await refreshWorkspaceLiveQueries(client, ACTOR, WORKSPACE, new AbortController().signal, () => true))
      .toEqual({ complete: true, followUp: false });
    expect(client.getQueryState(inactive)?.isInvalidated).toBe(true);
    for (const key of [pinned, categoryPinned, head]) expect(client.getQueryState(key)?.isInvalidated).toBe(false);
    expect(disabledRead).not.toHaveBeenCalled();
  });

  it.each(['mount', 'enable'] as const)('requires a follow-up for an active query that becomes eligible by %s during catch-up', async mode => {
    const client = setup(); const key = [...scope, 'tasks']; const later = [...scope, 'memberships'];
    client.setQueryData(key, 'old'); const response = held<string>(); active(client, key, () => response.promise);
    const observer = mode === 'enable' ? active(client, later, async () => 'members', false) : null;
    const pass = refreshWorkspaceLiveQueries(client, ACTOR, WORKSPACE, new AbortController().signal, () => true);
    await settle();
    if (observer) observer.setOptions({ queryKey: later, queryFn: async () => 'members', enabled: true });
    else active(client, later, async () => 'members');
    response.resolve('new'); expect(await pass).toEqual({ complete: true, followUp: true });
  });

  it('does not count removed or aborted targets as applied after scope departure', async () => {
    const client = setup(); const key = [...scope, 'tasks']; client.setQueryData(key, 'old');
    const response = held<string>(); active(client, key, () => response.promise);
    const abort = new AbortController();
    const pass = refreshWorkspaceLiveQueries(client, ACTOR, WORKSPACE, abort.signal, () => true);
    await settle(); abort.abort(); client.removeQueries({ queryKey: scope }); response.resolve('late');
    expect((await pass).complete).toBe(false); expect(client.getQueryData(key)).toBeUndefined();
  });

  it('rechecks interaction safety after cancellation before initiating fresh reads', async () => {
    const client = setup(); const key = [...scope, 'tasks']; client.setQueryData(key, 'old');
    const read = vi.fn().mockResolvedValue('new'); active(client, key, read);
    let checks = 0;
    const pass = refreshWorkspaceLiveQueries(client, ACTOR, WORKSPACE, new AbortController().signal, () => ++checks === 1);
    expect((await pass).complete).toBe(false); expect(read).not.toHaveBeenCalled();
  });

  it('rechecks interaction safety after owned fresh reads settle even without an abort event', async () => {
    const client = setup(); const key = [...scope, 'tasks']; client.setQueryData(key, 'old');
    const response = held<string>(); const read = vi.fn(() => response.promise); active(client, key, read);
    let isSafe = true; const protection = new AbortController();
    const pass = refreshWorkspaceLiveQueries(client, ACTOR, WORKSPACE, protection.signal, () => isSafe);
    await settle(); expect(read).toHaveBeenCalledTimes(1);
    isSafe = false; response.resolve('fresh');
    expect(await pass).toEqual({ complete: false, followUp: false });
    expect(protection.signal.aborted).toBe(false);
    expect(client.getQueryState(key)).toMatchObject({ status: 'success', fetchStatus: 'idle', data: 'fresh', dataUpdateCount: 2 });
  });
});

describe('head-owned flight identity', () => {
  const find = (client: QueryClient, key: QueryKey) => {
    const query = client.getQueryCache().find({ queryKey: key, exact: true });
    if (!query) throw new Error('Missing synthetic query'); return query;
  };

  it.each(['success', 'error'] as const)('aborts only the still head-owned flight and keeps a successor explicit refetch of a refreshed target until its %s', async outcome => {
    const client = setup(); const tasks = [...scope, 'tasks']; const projects = [...scope, 'projects'];
    client.setQueryData(tasks, 'cached tasks'); client.setQueryData(projects, 'cached projects');
    const headTasks = held<string>(); const headProjects = held<string>(); const successor = held<string>();
    const taskSignals: AbortSignal[] = []; const projectSignals: AbortSignal[] = [];
    const readTasks = vi.fn<(context: { signal: AbortSignal }) => Promise<string>>()
      .mockImplementationOnce(({ signal }) => { taskSignals.push(signal); return headTasks.promise; })
      .mockImplementationOnce(({ signal }) => { taskSignals.push(signal); return successor.promise; });
    const readProjects = vi.fn(({ signal }: { signal: AbortSignal }) => { projectSignals.push(signal); return headProjects.promise; });
    const tasksObserver = active(client, tasks, readTasks); active(client, projects, readProjects); await settle();
    expect(readTasks).not.toHaveBeenCalled(); expect(readProjects).not.toHaveBeenCalled();

    const protection = new AbortController();
    const pass = refreshWorkspaceLiveQueries(client, ACTOR, WORKSPACE, protection.signal, () => true);
    await settle(); expect(readTasks).toHaveBeenCalledTimes(1); expect(readProjects).toHaveBeenCalledTimes(1);
    const taskQuery = find(client, tasks); const ownedProjects = find(client, projects).promise;
    expect(ownedProjects).toBeDefined();
    headTasks.resolve('fresh tasks'); await settle();
    expect(client.getQueryState(tasks)).toMatchObject({ status: 'success', fetchStatus: 'idle', data: 'fresh tasks', dataUpdateCount: 2 });
    expect(taskQuery.promise).toBeUndefined();

    // The same query object starts a new ordinary flight; the head still owns only the projects read.
    const explicit = tasksObserver.refetch(); await settle(); expect(readTasks).toHaveBeenCalledTimes(2);
    const successorFlight = taskQuery.promise; expect(successorFlight).toBeDefined();
    expect(client.getQueryState(projects)?.fetchStatus).toBe('fetching');

    protection.abort(); await settle();
    expect(projectSignals[0]?.aborted).toBe(true);
    await expect(ownedProjects).rejects.toBeInstanceOf(CancelledError);
    expect(client.getQueryState(projects)).toMatchObject({ status: 'success', fetchStatus: 'idle', data: 'cached projects', dataUpdateCount: 1 });
    expect(taskSignals[0]?.aborted).toBe(false); expect(taskSignals[1]?.aborted).toBe(false);
    expect(taskQuery.promise).toBe(successorFlight);
    expect(client.getQueryState(tasks)).toMatchObject({ fetchStatus: 'fetching', data: 'fresh tasks', dataUpdateCount: 2 });

    const failure = new Error('successor offline');
    if (outcome === 'success') successor.resolve('successor tasks'); else successor.reject(failure);
    if (outcome === 'success') await expect(successorFlight).resolves.toBe('successor tasks');
    else await expect(successorFlight).rejects.toBe(failure);
    expect(await explicit).toMatchObject(outcome === 'success'
      ? { status: 'success', fetchStatus: 'idle', data: 'successor tasks' }
      : { status: 'error', fetchStatus: 'idle', data: 'fresh tasks', error: failure });
    expect(client.getQueryState(tasks)?.dataUpdateCount).toBe(outcome === 'success' ? 3 : 2);
    expect((await pass).complete).toBe(false);
    expect(readTasks).toHaveBeenCalledTimes(2); expect(readProjects).toHaveBeenCalledTimes(1);
  });

  it.each(['protection abort', 'reconnect'] as const)('owns a paused offline refresh through its actual query promise until %s', async ending => {
    const client = setup(); const key = [...scope, 'tasks']; client.setQueryData(key, 'cached');
    // Mounting subscribes the client to onlineManager, so reconnect really continues paused flights.
    client.mount(); disposers.push(() => client.unmount(), () => onlineManager.setOnline(true));
    const response = held<string>(); const signals: AbortSignal[] = [];
    const read = vi.fn(({ signal }: { signal: AbortSignal }) => { signals.push(signal); return response.promise; });
    // No ordinary reconnect/focus refetch: only the head-owned flight can resume.
    const observer = new QueryObserver(client, { queryKey: key, queryFn: read, staleTime: Infinity, refetchOnReconnect: false, refetchOnWindowFocus: false });
    disposers.unshift(observer.subscribe(() => undefined)); await settle(); expect(read).not.toHaveBeenCalled();

    onlineManager.setOnline(false);
    const protection = new AbortController(); let finished = false;
    const pass = refreshWorkspaceLiveQueries(client, ACTOR, WORKSPACE, protection.signal, () => true)
      .then(result => { finished = true; return result; });
    await settle();
    const query = find(client, key); const owned = query.promise;
    expect(query.state).toMatchObject({ status: 'success', fetchStatus: 'paused', data: 'cached', dataUpdateCount: 1 });
    expect(owned).toBeDefined(); expect(read).not.toHaveBeenCalled();
    // refetchQueries resolves at once for a paused query; the pass must wait for the actual flight.
    expect(finished).toBe(false);

    if (ending === 'protection abort') {
      protection.abort(); await settle();
      await expect(owned).rejects.toBeInstanceOf(CancelledError);
      expect(query.promise).toBeUndefined();
      expect(query.state).toMatchObject({ status: 'success', fetchStatus: 'idle', data: 'cached', dataUpdateCount: 1 });
      expect((await pass).complete).toBe(false);
      onlineManager.setOnline(true); await settle(); await settle();
      expect(read).not.toHaveBeenCalled(); expect(signals).toEqual([]); expect(query.promise).toBeUndefined();
      expect(client.getQueryState(key)).toMatchObject({ status: 'success', fetchStatus: 'idle', data: 'cached', dataUpdateCount: 1 });
      expect(observer.getCurrentResult()).toMatchObject({ status: 'success', data: 'cached' });
    } else {
      onlineManager.setOnline(true); await settle(); await settle();
      expect(read).toHaveBeenCalledTimes(1); expect(query.promise).toBe(owned);
      expect(query.state.fetchStatus).toBe('fetching'); expect(finished).toBe(false);
      response.resolve('fresh'); await expect(owned).resolves.toBe('fresh');
      expect(await pass).toEqual({ complete: true, followUp: false });
      expect(client.getQueryState(key)).toMatchObject({ status: 'success', fetchStatus: 'idle', data: 'fresh', dataUpdateCount: 2 });
      expect(signals[0]?.aborted).toBe(false);
    }
  });

  it('neither cancels nor takes over an inactive ordinary in-flight read, while idle inactive caches still become stale', async () => {
    const client = setup(); const inflight = [...scope, 'projects']; const idle = [...scope, 'memberships']; const target = [...scope, 'tasks'];
    client.setQueryData(inflight, 'cached projects'); client.setQueryData(idle, 'cached members'); client.setQueryData(target, 'cached tasks');
    const ordinaryResponse = held<string>(); const signals: AbortSignal[] = [];
    const ordinaryRead = vi.fn(({ signal }: { signal: AbortSignal }) => { signals.push(signal); return ordinaryResponse.promise; });
    const ordinary = client.fetchQuery({ queryKey: inflight, queryFn: ordinaryRead, staleTime: 0 }); await settle();
    const query = find(client, inflight); const flight = query.promise;
    expect(query.isActive()).toBe(false); expect(query.state.fetchStatus).toBe('fetching'); expect(flight).toBeDefined();
    const targetResponse = held<string>(); active(client, target, () => targetResponse.promise);

    const protection = new AbortController();
    const pass = refreshWorkspaceLiveQueries(client, ACTOR, WORKSPACE, protection.signal, () => true);
    await settle();
    expect(client.getQueryState(target)?.fetchStatus).toBe('fetching');
    expect(signals[0]?.aborted).toBe(false); expect(query.promise).toBe(flight); expect(ordinaryRead).toHaveBeenCalledTimes(1);
    expect(client.getQueryState(idle)?.isInvalidated).toBe(true);
    protection.abort(); await settle();
    expect(signals[0]?.aborted).toBe(false); expect(query.promise).toBe(flight);
    expect(client.getQueryState(inflight)).toMatchObject({ fetchStatus: 'fetching', data: 'cached projects', dataUpdateCount: 1 });
    expect((await pass).complete).toBe(false);

    ordinaryResponse.resolve('ordinary projects');
    expect(await ordinary).toBe('ordinary projects'); await expect(flight).resolves.toBe('ordinary projects');
    expect(client.getQueryState(inflight)).toMatchObject({ status: 'success', fetchStatus: 'idle', data: 'ordinary projects', dataUpdateCount: 2 });
    expect(client.getQueryState(idle)).toMatchObject({ data: 'cached members', isInvalidated: true });
    expect(ordinaryRead).toHaveBeenCalledTimes(1);
  });
});
