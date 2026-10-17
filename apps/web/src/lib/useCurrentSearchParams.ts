import { useCallback, useContext } from 'react';
import { UNSAFE_DataRouterContext, UNSAFE_NavigationContext, useLocation, useNavigate, useSearchParams, type NavigateOptions } from 'react-router';

interface SearchLocation { pathname: string; search: string; hash: string }
function historyLocation(navigator: unknown): SearchLocation | null {
  if (typeof navigator !== 'object' || navigator === null || !('location' in navigator)) return null;
  const value: unknown = navigator.location;
  if (typeof value !== 'object' || value === null || !('pathname' in value) || !('search' in value) || !('hash' in value)) return null;
  return typeof value.pathname === 'string' && typeof value.search === 'string' && typeof value.hash === 'string' ? { pathname: value.pathname, search: value.search, hash: value.hash } : null;
}
// Router heads keep the basename; useLocation and navigate use the stripped application path.
// Mirrors React Router's basename matching: case-insensitive, whole-segment, '/' passthrough.
function stripBasename(pathname: string, basename: string): string | null {
  if (basename === '/') return pathname;
  if (!pathname.toLowerCase().startsWith(basename.toLowerCase())) return null;
  const start = basename.endsWith('/') ? basename.length - 1 : basename.length;
  const nextChar = pathname.charAt(start);
  if (nextChar && nextChar !== '/') return null;
  return pathname.slice(start) || '/';
}
/**
 * React Router's functional search setter closes over render-time params. An old control can
 * still fire after a completed navigation, before its next render commits. Read the router's
 * actual head when the event fires; use normal navigate so blockers/history still apply.
 */
export function useCurrentSearchParams() {
  const [params] = useSearchParams();
  const location = useLocation();
  const navigate = useNavigate();
  const data = useContext(UNSAFE_DataRouterContext);
  const navigation = useContext(UNSAFE_NavigationContext);
  const router = data?.router;
  const navigator = navigation.navigator;
  const basename = navigation.basename;
  const update = useCallback((change: (before: URLSearchParams) => URLSearchParams | null, options?: NavigateOptions) => {
    // Production RouterProvider and declarative MemoryRouter/HistoryRouter expose separate
    // router-owned heads. Neither fallback reads window.location or bypasses navigate.
    const current = router?.state.location ?? historyLocation(navigator);
    if (!current) return false;
    const pathname = stripBasename(current.pathname, basename);
    if (pathname === null || pathname !== location.pathname) return false;
    const next = change(new URLSearchParams(current.search));
    if (next === null) return false;
    void navigate({ pathname, search: next.toString() ? `?${next}` : '', hash: current.hash }, options);
    return true;
  }, [basename, location.pathname, navigate, navigator, router]);
  return [params, update] as const;
}
