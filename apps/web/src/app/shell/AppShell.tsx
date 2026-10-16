import { t, useTranslation } from '../../i18n';
import { useQueryClient } from '@tanstack/react-query';
import { Logomark, Skeleton } from '@workloom/ui';
import { useEffect, useRef } from 'react';
import { Outlet, useMatch, useNavigate } from 'react-router';
import { MeProvider, useMe, useMeQuery } from '../../features/identity/identity';
import { useWorkspaceQuery } from '../../features/workspace/queries';
import { discardWorkspaceData } from '../../lib/cacheScope';
import { QueryErrorState } from '../../shared/QueryErrorState';
import { MobileNav } from './MobileNav';
import { SidebarContent } from './Sidebar';
import { SwitchErrorNotice } from './SwitchErrorNotice';
import { Topbar } from './Topbar';

export function AppShell() {
  useTranslation();
  const me = useMeQuery();
  useResetOnActorChange(me.isSuccess ? me.data.actor.id : null);

  if (me.isPending) return <ShellLoading />;

  if (me.isError) {
    return (
      <div className="grid min-h-dvh place-items-center px-4 py-10">
        <div className="w-full max-w-md">
          <div className="mb-6 flex items-center justify-center gap-2.5">
            <Logomark className="size-7" />
            <span className="text-[15px] font-semibold tracking-tight">{t('common.brand')}</span>
          </div>
          <QueryErrorState
            error={me.error}
            subject="identity"
            headingLevel={1}
            retrying={me.isFetching}
            onRetry={() => void me.refetch()}
          />
        </div>
      </div>
    );
  }

  return (
    <MeProvider me={me.data}>
      <ShellFrame />
    </MeProvider>
  );
}

/**
 * The server may report a different actor on refetch (for example after a
 * switch in another tab). Drop the previous actor's cache and leave its routes.
 */
function useResetOnActorChange(actorId: string | null): void {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const previous = useRef(actorId);

  useEffect(() => {
    if (actorId === null) return;
    const before = previous.current;
    previous.current = actorId;
    if (before !== null && before !== actorId) {
      queryClient.removeQueries({ predicate: (query) => query.queryKey[0] === 'actor' && query.queryKey[1] !== actorId });
      // Recorded writes are not keyed by actor; none of the previous actor's may linger.
      queryClient.getMutationCache().clear();
      navigate('/', { replace: true });
    }
  }, [actorId, navigate, queryClient]);
}

/** Leaving a workspace cancels and forgets everything loaded for it. */
function useDiscardPreviousWorkspace(actorId: string, workspaceId: string | null): void {
  const queryClient = useQueryClient();
  const previous = useRef(workspaceId);

  useEffect(() => {
    const before = previous.current;
    previous.current = workspaceId;
    if (before !== null && before !== workspaceId) void discardWorkspaceData(queryClient, actorId, before);
  }, [actorId, workspaceId, queryClient]);
}

function ShellFrame() {
  useTranslation();
  const me = useMe();
  const actorId = me.actor.id;
  const workspaceId = useMatch('/w/:workspaceId/*')?.params.workspaceId ?? null;
  const workspace = useWorkspaceQuery(actorId, workspaceId);
  const currentWorkspace = workspace.isSuccess ? workspace.data : null;
  useDiscardPreviousWorkspace(actorId, workspaceId);

  const sidebar = (onNavigate?: () => void) => (
    <SidebarContent me={me} workspaceId={workspaceId} role={currentWorkspace?.role ?? null} onNavigate={onNavigate} />
  );

  return (
    <div className="min-h-dvh">
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:fixed focus:top-3 focus:left-3 focus:z-[60] focus:rounded-lg focus:bg-surface focus:px-3 focus:py-2 focus:text-sm focus:font-medium focus:shadow-lg"
      >

        {t('shell.skipToContent')}
      </a>
      <aside
        aria-label={t('shell.sidebar')}
        className="fixed inset-y-0 left-0 z-20 hidden w-60 flex-col border-r border-line bg-surface lg:flex"
      >
        {sidebar()}
      </aside>
      <div className="flex min-h-dvh min-w-0 flex-col lg:pl-60">
        <Topbar
          actorId={actorId}
          workspaceId={workspaceId}
          workspaceName={currentWorkspace?.name ?? null}
          menu={<MobileNav>{(close) => sidebar(close)}</MobileNav>}
        />
        <main
          id="main"
          tabIndex={-1}
          className="mx-auto w-full max-w-6xl min-w-0 flex-1 px-4 py-4 outline-none sm:px-6 sm:py-5 lg:px-8 lg:py-6"
        >
          <SwitchErrorNotice />
          <Outlet />
        </main>
      </div>
    </div>
  );
}

function ShellLoading() {
  useTranslation();
  return (
    <div role="status" className="min-h-dvh lg:pl-60">
      <span className="sr-only">{t('shell.loadingApp')}</span>
      <div aria-hidden="true" className="fixed inset-y-0 left-0 hidden w-60 flex-col gap-6 border-r border-line bg-surface p-5 lg:flex">
        <Skeleton className="h-7 w-32" />
        <Skeleton className="h-[3.25rem] w-full rounded-xl" />
        <div className="space-y-2">
          <Skeleton className="h-8 w-full" />
          <Skeleton className="h-8 w-full" />
        </div>
      </div>
      <div className="h-14 border-b border-line" />
      <div className="mx-auto max-w-6xl space-y-4 px-4 py-8 sm:px-6 lg:px-10">
        <Skeleton className="h-8 w-64 max-w-full" />
        <Skeleton className="h-4 w-full max-w-xl" />
        <Skeleton className="h-48 rounded-2xl" />
      </div>
    </div>
  );
}
