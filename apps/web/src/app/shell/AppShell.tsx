import { t, useTranslation } from '../../i18n';
import { useQueryClient } from '@tanstack/react-query';
import { Button, Logomark, Skeleton } from '@workloom/ui';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Outlet, useNavigate } from 'react-router';
import { LoginScreen } from '../../features/auth/LoginScreen';
import { MeProvider, useMe, useMeQuery } from '../../features/identity/identity';
import { themeManager } from '../../features/theme/ThemeManager';
import { ProfileMenu } from '../../features/profile/ProfileMenu';
import { ProfileSettingsDialog } from '../../features/profile/ProfileSettingsDialog';
import { useWorkspaceQuery } from '../../features/workspace/queries';
import { useWorkspaceLiveRefresh } from '../../features/workspace/useWorkspaceLiveRefresh';
import { WorkspaceNavigationProvider, useWorkspaceRoute } from '../../features/workspace/WorkspaceNavigation';
import { WorkspaceCreationProvider } from '../../features/workspace/WorkspaceCreation';
import { discardWorkspaceData } from '../../lib/cacheScope';
import { QueryErrorState } from '../../shared/QueryErrorState';
import { useSession } from '../session';
import { MobileNav } from './MobileNav';
import { QuickJump } from '../../features/quick-jump/QuickJump';
import { SidebarContent } from './Sidebar';
import { SwitchErrorNotice } from './SwitchErrorNotice';
import { Topbar } from './Topbar';

/** The identity read was answered without a session. */
function isUnauthorized(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'status' in error && error.status === 401;
}

export function AppShell() {
  useTranslation();
  const me = useMeQuery();
  const expired = me.isError && isUnauthorized(me.error);
  const settings = me.data?.settings;
  useLayoutEffect(() => {
    themeManager.setTheme(!expired && settings && settings.userId === me.data?.actor.id ? settings.settings.theme : 'default');
  }, [expired, me.data?.actor.id, settings]);
  useResetOnActorChange(me.isSuccess ? me.data.actor.id : null);

  if (me.isPending) {
    return (
      <>
        <ShellLoading />
      </>
    );
  }

  const previous = me.data;
  if (previous !== undefined && previous.authMode === 'shared') {
    // One stable wrapper for every shared state: an expired session hides the frame behind the
    // sign-in gate without unmounting it, so unsent drafts and uncertain writes keep their owners.
    const expired = me.isError && isUnauthorized(me.error);
    const covered = me.isError;
    return (
      <>
        <div hidden={covered} inert={covered}>
          <MeProvider me={previous}>
            {/* Above the frame, so a new-workspace draft outlives the mobile menu that opened it. */}
            <WorkspaceNavigationProvider actorId={previous.actor.id}><WorkspaceCreationProvider key={previous.actor.id}>
              <ShellFrame key={previous.actor.id} sessionActive={!covered} />
            </WorkspaceCreationProvider></WorkspaceNavigationProvider>
          </MeProvider>
        </div>
        {expired ? (
          <LoginScreen mode="shared" identityError={me.error} retryingIdentity={me.isFetching} onRetryIdentity={() => void me.refetch()} />
        ) : covered ? (
          <IdentityError error={me.error} retrying={me.isFetching} onRetry={() => void me.refetch()} />
        ) : null}
      </>
    );
  }

  if (me.isError && isUnauthorized(me.error)) {
    return (
      <>
        <LoginScreen identityError={me.error} retryingIdentity={me.isFetching} onRetryIdentity={() => void me.refetch()} />
      </>
    );
  }

  if (me.isError) {
    return (
      <>
        <IdentityError error={me.error} retrying={me.isFetching} onRetry={() => void me.refetch()} />
      </>
    );
  }

  return (
    <MeProvider me={me.data}>
      <WorkspaceNavigationProvider actorId={me.data.actor.id}><WorkspaceCreationProvider>
        <ShellFrame />
      </WorkspaceCreationProvider></WorkspaceNavigationProvider>
    </MeProvider>
  );
}

function IdentityError({ error, retrying, onRetry }: { error: unknown; retrying: boolean; onRetry: () => void }) {
  useTranslation();
  return (
    <div className="grid min-h-dvh place-items-center px-4 py-10">
      <div className="w-full max-w-md">
        <div className="mb-6 flex items-center justify-center gap-2.5">
          <Logomark className="size-7" />
          <span className="text-[15px] font-semibold tracking-tight">{t('common.brand')}</span>
        </div>
        <QueryErrorState error={error} subject="identity" headingLevel={1} retrying={retrying} onRetry={onRetry} />
      </div>
    </div>
  );
}

/** Logout was not confirmed: everything stays, and only the user sends it again. */
function SignOutNotice() {
  useTranslation();
  const session = useSession();
  if (session.logoutError === null || session.signingOut) return null;
  return (
    <div role="alert" className="mb-4 rounded-xl border border-line bg-surface p-4 text-sm">
      <p className="font-medium text-ink">{t('auth.signOutFailed')}</p>
      <p className="mt-1 leading-relaxed text-ink-soft">{t('auth.signOutUnknown')}</p>
      <div className="mt-3">
        <Button size="sm" onClick={() => void session.signOut()}>
          {t('auth.tryAgain')}
        </Button>
      </div>
    </div>
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
function useDiscardPreviousWorkspace(actorId: string, workspaceId: string | null, resolving = false): void {
  const queryClient = useQueryClient();
  const previous = useRef(workspaceId);

  useEffect(() => {
    if (resolving) return;
    const before = previous.current;
    previous.current = workspaceId;
    if (before !== null && before !== workspaceId) void discardWorkspaceData(queryClient, actorId, before);
  }, [actorId, workspaceId, queryClient, resolving]);
}

/** `sessionActive` is false while a shared frame is kept mounted behind the sign-in gate. */
function ShellFrame({ sessionActive = true }: { sessionActive?: boolean }) {
  useTranslation();
  const me = useMe();
  const actorId = me.actor.id;
  const route = useWorkspaceRoute(actorId);
  const workspaceId = route.workspaceId;
  const workspace = useWorkspaceQuery(actorId, workspaceId);
  const currentWorkspace = workspace.isSuccess ? workspace.data : null;
  useDiscardPreviousWorkspace(actorId, workspaceId, route.pending);
  // A covered frame stays mounted for its drafts but must not keep polling workspace heads.
  useWorkspaceLiveRefresh(actorId, workspaceId, sessionActive && workspace.isSuccess && workspace.headDenial === null);

  const [settingsOpen, setSettingsOpen] = useState(false);
  const shared = me.authMode === 'shared';

  const sidebar = (onNavigate?: () => void) => (
    <SidebarContent me={me} workspaceId={workspaceId} role={currentWorkspace?.role ?? null} onNavigate={onNavigate} onSettings={() => { onNavigate?.(); setSettingsOpen(true); }} />
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
      {/* Topbar and page together; an open task pane (styles.css) sits below the full-width Topbar and narrows only the main page. */}
      <div className="app-shell-workspace flex min-h-dvh min-w-0 flex-col lg:pl-60">
        <Topbar
          actorId={actorId}
          workspaceId={workspaceId}
          workspaceName={currentWorkspace?.name ?? null}
          menu={<MobileNav>{(close) => sidebar(close)}</MobileNav>}
          localMode={!shared}
          search={workspaceId ? <QuickJump actorId={actorId} workspaceId={workspaceId} /> : undefined}
          account={<ProfileMenu me={me} onSettings={() => setSettingsOpen(true)} />}
        />
        <main
          id="main"
          tabIndex={-1}
          data-app-shell-main=""
          className="app-shell-main w-full min-w-0 flex-1 px-3 py-4 outline-none sm:px-4 sm:py-5 lg:py-6"
        >
          <SwitchErrorNotice />
          {shared ? <SignOutNotice /> : null}
          <Outlet />
          {settingsOpen && sessionActive ? <ProfileSettingsDialog key={actorId} me={me} onClose={() => setSettingsOpen(false)} /> : null}
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
      <div className="min-w-0 space-y-4 px-3 py-8 sm:px-4">
        <Skeleton className="h-8 w-64 max-w-full" />
        <Skeleton className="h-4 w-full max-w-xl" />
        <Skeleton className="h-48 rounded-2xl" />
      </div>
    </div>
  );
}
