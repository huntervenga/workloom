import { QueryClient, QueryObserver, type QueryKey } from '@tanstack/react-query';
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
function active(client: QueryClient, key: QueryKey, read: () => Promise<unknown>, enabled = true) {
  const observer = new QueryObserver(client, { queryKey: key, queryFn: read, enabled, staleTime: Infinity });
  disposers.push(observer.subscribe(() => undefined)); return observer;
}
function held<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(yes => { resolve = yes; }); return { promise, resolve };
}
async function settle() { for (let i = 0; i < 20; i++) await Promise.resolve(); }
afterEach(() => { disposers.splice(0).forEach(dispose => dispose()); clients.splice(0).forEach(client => client.clear()); });

describe('workspace live query classification', () => {
  it('includes every audited mutable branch, run lists, import reconciliation and MCP metadata', () => {
    for (const branch of ['memberships', 'projects', 'project', 'tags', 'tasks', 'fields', 'workCategoryBinding',
      'timeSummaries', 'planning', 'workCategories', 'meetings', 'recurrence', 'dependencies', 'schedule', 'cutoff', 'imports', 'local-mcp-credentials']) {
      expect(isWorkspaceLiveKey([...scope, branch], ACTOR, WORKSPACE)).toBe(true);
    }
    for (const suffix of [[], ['planning', 'period', 'period-a', 'runs'], ['workCategories', 'runs', 'period-a'],
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
  it('cancels a pre-head read and only accepts its replacement from the server', async () => {
    const client = setup(); const key = [...scope, 'tasks', 'list']; const before = held<string>(); const fresh = held<string>();
    const read = vi.fn().mockReturnValueOnce(before.promise).mockReturnValueOnce(fresh.promise);
    active(client, key, read); await settle();
    const pass = refreshWorkspaceLiveQueries(client, ACTOR, WORKSPACE, new AbortController().signal, () => true);
    await settle(); expect(read).toHaveBeenCalledTimes(2);
    before.resolve('old'); await settle(); expect(client.getQueryData(key)).toBeUndefined();
    fresh.resolve('fresh'); expect(await pass).toEqual({ complete: true, followUp: false });
    expect(client.getQueryData(key)).toBe('fresh');
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
});
