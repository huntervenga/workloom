import { QueryCache, QueryClient, type Query } from '@tanstack/react-query';
import { ApiError, isAccessDenied } from './api';
import { queryKeys, workspaceScopeOf } from './queryKeys';

export interface QueryClientOptions {
  /** Tests disable retries to keep error states deterministic. */
  retry?: boolean | undefined;
}

export function createQueryClient({ retry = true }: QueryClientOptions = {}): QueryClient {
  const client: QueryClient = new QueryClient({
    queryCache: new QueryCache({
      onError: (error, query) => handleQueryError(client, error, query),
    }),
    defaultOptions: {
      queries: {
        staleTime: 30_000,
        gcTime: 5 * 60_000,
        refetchOnWindowFocus: true,
        retry: retry ? shouldRetry : false,
      },
    },
  });
  return client;
}

function shouldRetry(failureCount: number, error: unknown): boolean {
  if (failureCount >= 2 || !(error instanceof ApiError)) return false;
  return error.kind === 'network' || error.kind === 'server' || error.kind === 'unavailable';
}

/**
 * A denial means previously loaded data for that workspace may no longer be
 * visible to this actor, so it is dropped rather than kept as a placeholder.
 */
function handleQueryError(client: QueryClient, error: unknown, query: Query<unknown, unknown, unknown>): void {
  if (!(error instanceof ApiError)) return;

  if (error.kind === 'unauthenticated' && query.queryKey[0] !== 'me') {
    void client.invalidateQueries({ queryKey: queryKeys.me });
    return;
  }

  if (!isAccessDenied(error)) return;
  const scope = workspaceScopeOf(query.queryKey);
  if (!scope) return;

  if (query.queryKey.length === scope.length) {
    client.removeQueries({ queryKey: scope, predicate: (candidate) => candidate !== query });
    void client.invalidateQueries({ queryKey: queryKeys.workspaces(scope[1]), exact: true });
  } else {
    // A nested resource was denied: recheck the workspace itself.
    void client.invalidateQueries({ queryKey: scope, exact: true });
  }
}
