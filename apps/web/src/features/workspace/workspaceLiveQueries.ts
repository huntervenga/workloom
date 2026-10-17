import type { Query, QueryClient, QueryKey } from '@tanstack/react-query';
import { queryKeys } from '../../lib/queryKeys';

/** Audited mutable readers. Unknown future branches require a deliberate classification. */
const LIVE_BRANCHES = new Set([
  'memberships', 'projects', 'project', 'tags', 'tasks', 'fields', 'workCategoryBinding',
  'timeSummaries', 'planning', 'workCategories', 'meetings', 'recurrence', 'dependencies',
  'schedule', 'cutoff', 'imports', 'local-mcp-credentials',
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

/**
 * Capture exact query objects, cancel pre-head answers, then require a fresh successful read of
 * every enabled active target. invalidateQueries alone swallows errors and can accept old flights.
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
  let followUp = false;
  let cancelled = false;
  const unsubscribe = cache.subscribe(event => {
    if (!eligible(event.query)) return;
    if (event.type === 'removed' && captured.has(event.query)) cancelled = true;
    if (event.query.isActive() && !event.query.isDisabled() && !captured.has(event.query)) followUp = true;
    // A previously inactive target enabled during the pass must be read by the next pass.
  });
  const cancel = () => { void client.cancelQueries({ predicate: query => captured.has(query) }); };
  signal.addEventListener('abort', cancel, { once: true });
  try {
    if (signal.aborted || !safe()) return { complete: false, followUp: false };
    await client.cancelQueries({ predicate: eligible });
    if (signal.aborted || !safe()) return { complete: false, followUp: false };
    await client.invalidateQueries({ predicate: eligible, refetchType: 'none' });
    if (signal.aborted || !safe()) return { complete: false, followUp: false };
    const counts = new Map(targets.map(query => [query, query.state.dataUpdateCount]));
    const answers = await Promise.allSettled(targets.map(query => client.refetchQueries(
      { predicate: candidate => candidate === query, type: 'active' },
      { throwOnError: true, cancelRefetch: true },
    )));
    const complete = !signal.aborted && !cancelled && answers.every(answer => answer.status === 'fulfilled') &&
      targets.every(query => cache.get(query.queryHash) === query && query.state.status === 'success' &&
        query.state.fetchStatus === 'idle' && query.state.dataUpdateCount > (counts.get(query) ?? 0));
    return { complete, followUp };
  } finally {
    signal.removeEventListener('abort', cancel);
    unsubscribe();
  }
}
