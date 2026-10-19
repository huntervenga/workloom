import type { Query, QueryClient, QueryKey } from '@tanstack/react-query';
import { queryKeys } from '../../lib/queryKeys';

/** Audited mutable readers. Unknown future branches require a deliberate classification. */
const LIVE_BRANCHES = new Set([
  'memberships', 'projects', 'project', 'tags', 'tasks', 'fields', 'workCategoryBinding',
  'timeSummaries', 'planning', 'workCategories', 'meetings', 'recurrence', 'dependencies',
  'schedule', 'cutoff', 'imports', 'local-mcp-credentials', 'generic-reports', 'time-off',
]);

export function isWorkspaceLiveKey(key: QueryKey, actorId: string, workspaceId: string): boolean {
  const scope = queryKeys.workspace(actorId, workspaceId);
  if (!scope.every((part, index) => key[index] === part)) return false;
  if (key.length === scope.length) return true;
  const branch = key[scope.length];
  if (typeof branch !== 'string' || !LIVE_BRANCHES.has(branch)) return false;
  // Singular runs and all their descendants are immutable; plural run lists stay live.
  return !((branch === 'planning' || branch === 'workCategories') && key[scope.length + 1] === 'run');
}

export interface WorkspaceRefreshResult {
  complete: boolean;
  followUp: boolean;
}

/** A query that has completed at least one successful ordinary read; cached refresh errors still qualify. */
function isInitialized(query: Query): boolean {
  return query.state.dataUpdateCount > 0 && query.state.data !== undefined;
}

/**
 * Capture exact query objects, cancel pre-head answers, then require a fresh successful read of
 * every enabled active target. invalidateQueries alone swallows errors and can accept old flights.
 * Never-successful initial reads stay with their ordinary owner and keep this pass incomplete.
 */
export async function refreshWorkspaceLiveQueries(
  client: QueryClient,
  actorId: string,
  workspaceId: string,
  signal: AbortSignal,
  safe: () => boolean,
): Promise<WorkspaceRefreshResult> {
  const cache = client.getQueryCache();
  const eligible = (query: Query) => isWorkspaceLiveKey(query.queryKey, actorId, workspaceId);
  const targets = cache.findAll({ predicate: eligible }).filter(query => query.isActive() && !query.isDisabled() && !query.isStatic());
  const captured = new Set(targets);
  const initialized = targets.filter(isInitialized);
  // Any initial target means its pre-head answer cannot count as applied, even if it succeeds now.
  const awaitingInitialRead = initialized.length < targets.length;
  // Exact Query.promise flights this pass started (or took over); later same-key successors are not ours.
  const owned = new Map<Query, Promise<unknown>>();
  let followUp = false;
  let cancelled = false;
  const unsubscribe = cache.subscribe(event => {
    if (!eligible(event.query)) return;
    if (event.type === 'removed' && captured.has(event.query)) cancelled = true;
    if (event.query.isActive() && !event.query.isDisabled() && !captured.has(event.query)) followUp = true;
    // A previously inactive target enabled during the pass must be read by the next pass.
  });
  const cancelOwned = () => {
    for (const [query, promise] of owned) {
      // Paused flights are still in flight; an ordinary successor has a different promise.
      if (query.promise === promise && query.state.fetchStatus !== 'idle') void query.cancel({ revert: true });
    }
  };
  signal.addEventListener('abort', cancelOwned, { once: true });
  try {
    if (signal.aborted || !safe()) return { complete: false, followUp: false };
    await Promise.all(initialized.map(query => query.cancel({ revert: true })));
    if (signal.aborted || !safe()) return { complete: false, followUp: false };
    await client.invalidateQueries({ predicate: eligible, refetchType: 'none' });
    if (signal.aborted || !safe()) return { complete: false, followUp: false };
    const counts = new Map(initialized.map(query => [query, query.state.dataUpdateCount]));
    const flights = initialized.map(query => {
      const previous = query.promise;
      const answer = client.refetchQueries(
        { predicate: candidate => candidate === query, type: 'active' },
        { throwOnError: true, cancelRefetch: true },
      );
      const flight = query.promise;
      if (!flight || flight === previous) return answer;
      owned.set(query, flight);
      const release = () => { if (owned.get(query) === flight) owned.delete(query); };
      void flight.then(release, release);
      // The wrapper resolves immediately for a paused flight; wait for the actual owned promise too.
      return Promise.all([answer, flight]);
    });
    if (signal.aborted) cancelOwned();
    const answers = await Promise.allSettled(flights);
    // Safety can flip without an abort event while owned flights settle; recheck it after they do.
    const complete = !awaitingInitialRead && !signal.aborted && !cancelled && safe() &&
      answers.every(answer => answer.status === 'fulfilled') &&
      initialized.every(query => cache.get(query.queryHash) === query && query.state.status === 'success' &&
        query.state.fetchStatus === 'idle' && query.state.dataUpdateCount > (counts.get(query) ?? 0));
    return { complete, followUp };
  } finally {
    signal.removeEventListener('abort', cancelOwned);
    unsubscribe();
  }
}
