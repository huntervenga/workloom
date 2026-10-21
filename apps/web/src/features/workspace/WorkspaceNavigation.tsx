import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { Link, NavLink, useMatch, useNavigate, type LinkProps, type NavLinkProps, type NavigateFunction, type NavigateOptions, type To } from 'react-router';
import { isUuid } from '../../lib/format';
import { useWorkspacesQuery } from './queries';
import { canonicalWorkspaceTo, resolveWorkspaceReference, type WorkspaceAddress } from './workspaceRouting';

const WorkspaceAddresses = createContext<readonly WorkspaceAddress[]>([]);

/** The list is already authorized for this actor; it is never a public slug directory. */
export function WorkspaceNavigationProvider({ actorId, children }: { actorId: string; children: ReactNode }) {
  const query = useWorkspacesQuery(actorId);
  return <WorkspaceAddresses.Provider value={query.isSuccess ? query.data : []}>{children}</WorkspaceAddresses.Provider>;
}

export function useCanonicalWorkspaceTo() {
  const workspaces = useContext(WorkspaceAddresses);
  return useCallback((to: To) => canonicalWorkspaceTo(to, workspaces), [workspaces]);
}

/** All actual anchors, including new-tab and copied links, carry the canonical company address. */
export function WorkspaceLink({ to, ...props }: LinkProps) {
  const canonical = useCanonicalWorkspaceTo();
  return <Link {...props} to={canonical(to)} />;
}
export function WorkspaceNavLink({ to, ...props }: NavLinkProps) {
  const canonical = useCanonicalWorkspaceTo();
  return <NavLink {...props} to={canonical(to)} />;
}
export function useWorkspaceNavigate(): NavigateFunction {
  const navigate = useNavigate(), canonical = useCanonicalWorkspaceTo();
  return useCallback((to: To | number, options?: NavigateOptions) => typeof to === 'number' ? navigate(to) : navigate(canonical(to), options), [canonical, navigate]) as NavigateFunction;
}

/** A slug is resolved before issuing any workspace query; callers never send it to UUID APIs. */
export function useWorkspaceRoute(actorId: string) {
  const reference = useMatch('/w/:workspaceId/*')?.params.workspaceId ?? null;
  const query = useWorkspacesQuery(actorId);
  const found = reference && query.isSuccess ? resolveWorkspaceReference(reference, query.data) : undefined;
  const workspaceId = found?.id ?? (reference && isUuid(reference) ? reference.toLowerCase() : null);
  const initialReference = useRef(reference);
  const attempted = useRef<string | null>(null);
  const [verified, setVerified] = useState<string | null>(null);
  const key = `${actorId}:${reference ?? ''}`;
  // A fresh cache can predate a rename in another tab. Recheck an unknown address once,
  // using the authorized list endpoint; never probe an arbitrary workspace path.
  const recheck = reference !== null && workspaceId === null && !query.isError && verified !== key &&
    (reference !== initialReference.current || !query.isFetchedAfterMount);
  useEffect(() => {
    if (!recheck || query.isPending || query.isFetching || attempted.current === key) return;
    attempted.current = key;
    void query.refetch({ cancelRefetch: false }).finally(() => setVerified(key));
  }, [key, query, recheck]);
  return { reference, workspaceId, pending: reference !== null && workspaceId === null && (query.isPending || query.isFetching || recheck), error: workspaceId === null && query.isError ? query.error : null, refetch: query.refetch, isFetching: query.isFetching };
}
