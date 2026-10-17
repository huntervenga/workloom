import { workspaceResponseSchema } from '@workloom/contracts';
import type { Query, QueryClient } from '@tanstack/react-query';
import { type ApiError, apiGet, isAccessDenied } from './api';
import { queryKeys, workspaceScopeOf } from './queryKeys';
import { isWorkspaceRefreshProtected } from './workspaceRefreshProtection';
import { setWorkspaceHeadDenial } from './workspaceHeadDenial';

/**
 * An idle head denial is current workspace authorization evidence. A pre-protection reply
 * is discarded so it cannot unmount the local owner of a retained draft or exact command.
 * Intentional departure has different mutation semantics: never call discardWorkspaceData here.
 */
export function handleWorkspaceHeadQueryError(client: QueryClient, error: ApiError, query: Query<unknown, unknown, unknown>): boolean {
  const scope = workspaceScopeOf(query.queryKey);
  if (!scope || query.queryKey.length !== scope.length + 1 || query.queryKey[scope.length] !== 'change-head') return false;
  if (!isAccessDenied(error) && error.kind !== 'unauthenticated') return false;
  // A head begun just before an editor/command acquired protection is obsolete. Do not let
  // its late denial unmount the local owner of exact commands or retained drafts.
  if (isWorkspaceRefreshProtected(client)) return true;

  setWorkspaceHeadDenial(client, scope[1], scope[3], error);

  // cancelQueries dispatches cancellation synchronously before its returned Promise settles.
  void client.cancelQueries({ queryKey: scope, predicate: candidate => candidate !== query });
  const root = client.getQueryCache().find({ queryKey: scope, exact: true });
  if (root) root.setState({ data: undefined, error, status: 'error', fetchStatus: 'idle',
    errorUpdatedAt: Date.now(), errorUpdateCount: root.state.errorUpdateCount + 1 });
  client.removeQueries({ queryKey: scope, predicate: candidate => candidate !== query && candidate !== root });
  void client.invalidateQueries({ queryKey: queryKeys.workspaces(scope[1]), exact: true });
  if (error.kind === 'unauthenticated') void client.invalidateQueries({ queryKey: queryKeys.me, exact: true, refetchType: 'none' });

  // Independently reauthorize the root once without publishing cached success. Only an explicit
  // root recovery read may unlock a new polling generation; a successful automatic root recheck
  // after a head-only denial would otherwise recreate an enabled five-second denial loop.
  void apiGet(`/api/v1/workspaces/${encodeURIComponent(scope[3])}`, workspaceResponseSchema).catch(() => undefined);
  return true;
}
