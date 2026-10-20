import { CancelledError, type Query, type QueryClient, type QueryKey } from '@tanstack/react-query';
import { membershipListResponseSchema, meResponseSchema, workspaceResponseSchema, type MeDto } from '@workloom/contracts';
import { ApiError, apiGet, type ResponseParser } from './api';
import { revokeWorkspaceReadPresentation } from '../features/workspace/workspaceReadPresentation';
import { queryKeys } from './queryKeys';

const ownedReads = new WeakMap<object, () => boolean>();
/** Last error-policy check closes the gap between a guarded queryFn rejection and delivery. */
export function obsoleteWorkspaceHeadRead(query: Query<unknown, unknown, unknown>): boolean {
  const current = ownedReads.get(query);
  return current !== undefined && !current();
}

/** All head-initiated metadata/identity reads share the hook's current safe generation. */
export class WorkspaceHeadRechecks {
  private generation = 0;
  private stopped = false;
  private readonly pending = new Map<'access' | 'identity', { generation: number; keys: QueryKey[]; controller: AbortController }>();

  constructor(private readonly client: QueryClient, private readonly actorId: string,
    private readonly workspaceId: string, private readonly safe: () => boolean) {}

  cancel(): void {
    this.generation++;
    for (const operation of this.pending.values()) {
      operation.controller.abort();
      for (const queryKey of operation.keys) void this.client.cancelQueries({ queryKey, exact: true });
    }
    this.pending.clear();
  }
  stop(): void { this.stopped = true; this.cancel(); }

  access = (): void => {
    revokeWorkspaceReadPresentation(this.client, this.actorId, this.workspaceId);
    void this.start('access', [queryKeys.workspace(this.actorId, this.workspaceId), queryKeys.memberships(this.actorId, this.workspaceId)], generation =>
      Promise.allSettled([
        this.read(generation, queryKeys.workspace(this.actorId, this.workspaceId), `/api/v1/workspaces/${encodeURIComponent(this.workspaceId)}`, workspaceResponseSchema,
          answer => answer.data.id.toLowerCase() === this.workspaceId.toLowerCase()),
        this.read(generation, queryKeys.memberships(this.actorId, this.workspaceId), `/api/v1/workspaces/${encodeURIComponent(this.workspaceId)}/memberships`, membershipListResponseSchema,
          answer => answer.data.every(member => member.workspaceId.toLowerCase() === this.workspaceId.toLowerCase())),
      ]));
  };
  identity = (): void => { void this.verifyIdentity(); };
  verifyIdentity = (): Promise<MeDto | null> => {
    revokeWorkspaceReadPresentation(this.client, this.actorId, this.workspaceId);
    return this.start('identity', [queryKeys.me], async (generation, signal) => {
    // An unsuccessful advisory identity recheck must not replace the denied workspace's
    // neutral recovery UI with a global identity error. Publish only a current validated answer.
    this.guard(generation);
    try {
      const answer = await apiGet('/api/v1/me', meResponseSchema, signal);
      this.guard(generation);
      this.client.setQueryData(queryKeys.me, answer.data);
      return answer.data;
    } catch (error) { this.guard(generation); throw error; }
    });
  };

  isCurrent = (): boolean => this.current(this.generation);

  /** Manual recovery uses the observer's real refetch, with the same owned error-delivery guard. */
  rootRefetch = <T>(refetch: () => Promise<T>): Promise<T | null> => {
    revokeWorkspaceReadPresentation(this.client, this.actorId, this.workspaceId);
    return this.start('access',
    [queryKeys.workspace(this.actorId, this.workspaceId)], async generation => {
      const query = this.client.getQueryCache().find({ queryKey: queryKeys.workspace(this.actorId, this.workspaceId), exact: true });
      const current = () => this.current(generation);
      if (query) ownedReads.set(query, current);
      try { return await refetch(); }
      finally { if (query && ownedReads.get(query) === current) ownedReads.delete(query); }
    });
  };

  private current(generation: number): boolean {
    const actor = this.client.getQueryData<MeDto>(queryKeys.me)?.actor.id;
    return !this.stopped && this.generation === generation && this.safe() &&
      (actor === undefined || actor.toLowerCase() === this.actorId.toLowerCase());
  }
  private guard(generation: number): void {
    if (!this.current(generation)) throw new CancelledError({ revert: true, silent: true });
  }
  private start<T>(kind: 'access' | 'identity', keys: QueryKey[], run: (generation: number, signal: AbortSignal) => Promise<T>): Promise<T | null> {
    if (this.pending.has(kind) || !this.current(this.generation)) return Promise.resolve(null);
    const operation = { generation: this.generation, keys, controller: new AbortController() };
    this.pending.set(kind, operation);
    return (async () => {
      try {
        await Promise.all(keys.map(queryKey => this.client.cancelQueries({ queryKey, exact: true })));
        this.guard(operation.generation);
        return await run(operation.generation, operation.controller.signal);
      } catch { return null; /* Current errors reach QueryCache; cancelled generations stay private. */ }
      finally { if (this.pending.get(kind) === operation) this.pending.delete(kind); }
    })();
  }
  private async read<T extends { data: unknown }>(generation: number, queryKey: QueryKey, path: string,
    parser: ResponseParser<T>, valid: (answer: T) => boolean): Promise<T['data']> {
    this.guard(generation);
    const before = this.client.getQueryCache().find({ queryKey, exact: true });
    const previousOptions = before?.options;
    const current = () => this.current(generation);
    let owner: Query<unknown, unknown, unknown> | undefined;
    const queryFn = async ({ signal }: { signal: AbortSignal }) => {
      owner = this.client.getQueryCache().find({ queryKey, exact: true });
      if (owner) ownedReads.set(owner, current);
      try {
        this.guard(generation);
        const answer = await apiGet(path, parser, signal);
        this.guard(generation);
        if (!valid(answer)) throw new ApiError({ kind: 'invalid_response', status: 200 });
        return answer.data;
      } catch (error) {
        this.guard(generation);
        throw error;
      }
    };
    try { return await this.client.fetchQuery({ queryKey, queryFn, staleTime: 0, retry: false }) as T['data']; }
    finally {
      if (owner && ownedReads.get(owner) === current) ownedReads.delete(owner);
      // Do not leave a completed generation's guarded closure as an ordinary observer's reader.
      if (before && previousOptions && owner === before && before.options.queryFn === queryFn) before.setOptions(previousOptions);
    }
  }
}
