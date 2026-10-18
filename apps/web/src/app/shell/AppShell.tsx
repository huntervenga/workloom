import { t, useTranslation } from '../../i18n';
import { useQueryClient } from '@tanstack/react-query';
import { Button, Logomark, Skeleton } from '@workloom/ui';
import { LogOut } from 'lucide-react';
import { useEffect, useRef } from 'react';
import { Outlet, useMatch, useNavigate } from 'react-router';
import { LoginScreen } from '../../features/auth/LoginScreen';
import { MeProvider, useMe, useMeQuery } from '../../features/identity/identity';
import { ThemeToggle } from '../../features/theme/ThemeToggle';
import { useWorkspaceQuery } from '../../features/workspace/queries';
import { useWorkspaceLiveRefresh } from '../../features/workspace/useWorkspaceLiveRefresh';
import { WorkspaceCreationProvider } from '../../features/workspace/WorkspaceCreation';
import { discardWorkspaceData } from '../../lib/cacheScope';
import { QueryErrorState } from '../../shared/QueryErrorState';
import { useSession } from '../session';
import { MobileNav } from './MobileNav';
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
  useResetOnActorChange(me.isSuccess ? me.data.actor.id : null);

  if (me.isPending) {
    return (
      <>
        <ShellLoading />
        <PublicThemeControl />
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
            <WorkspaceCreationProvider key={previous.actor.id}>
              <ShellFrame key={previous.actor.id} sessionActive={!covered} />
            </WorkspaceCreationProvider>
          </MeProvider>
        </div>
        {expired ? (
          <LoginScreen mode="shared" identityError={me.error} retryingIdentity={me.isFetching} onRetryIdentity={() => void me.refetch()} />
        ) : covered ? (
          <IdentityError error={me.error} retrying={me.isFetching} onRetry={() => void me.refetch()} />
        ) : null}
        {/* Last, so the kept frame never shifts position; the hidden frame's Topbar toggle is not reachable. */}
        {covered ? <PublicThemeControl /> : null}
      </>
    );
  }

  if (me.isError && isUnauthorized(me.error)) {
    return (
      <>
        <LoginScreen identityError={me.error} retryingIdentity={me.isFetching} onRetryIdentity={() => void me.refetch()} />
        <PublicThemeControl />
      </>
    );
  }

  if (me.isError) {
    return (
      <>
        <IdentityError error={me.error} retrying={me.isFetching} onRetry={() => void me.refetch()} />
        <PublicThemeControl />
      </>
    );
  }

  return (
    <MeProvider me={me.data}>
      <WorkspaceCreationProvider>
        <ShellFrame />
      </WorkspaceCreationProvider>
    </MeProvider>
  );
}

/** The theme switch for screens without a Topbar: loading, sign-in and identity errors. */
function PublicThemeControl() {
  return (
    <div className="fixed top-3 right-3 z-40">
      <ThemeToggle />
    </div>
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

/** The real actor's name and sign-out, at every width; only for a shared session. */
function AccountControls({ name }: { name: string }) {
  useTranslation();
  const session = useSession();
  const label = t('auth.signedInAs', { name });
  return (
    <div className="flex min-w-0 shrink items-center gap-2">
      <p className="min-w-0">
        <span className="sr-only">{label}</span>
        <span aria-hidden="true" title={label} className="hidden max-w-48 truncate text-sm text-ink-soft md:block">
          {name}
        </span>
      </p>
      <Button
        size="sm"
        onClick={() => {
          if (!session.signingOut) void session.signOut();
        }}
        aria-disabled={session.signingOut || undefined}
      >
        <LogOut size={16} aria-hidden="true" />
        <span className="sr-only sm:not-sr-only">{session.signingOut ? t('auth.signingOut') : t('auth.signOut')}</span>
      </Button>
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
function useDiscardPreviousWorkspace(actorId: string, workspaceId: string | null): void {
  const queryClient = useQueryClient();
  const previous = useRef(workspaceId);

  useEffect(() => {
    const before = previous.current;
    previous.current = workspaceId;
    if (before !== null && before !== workspaceId) void discardWorkspaceData(queryClient, actorId, before);
  }, [actorId, workspaceId, queryClient]);
}

/** `sessionActive` is false while a shared frame is kept mounted behind the sign-in gate. */
function ShellFrame({ sessionActive = true }: { sessionActive?: boolean }) {
  useTranslation();
  const me = useMe();
  const actorId = me.actor.id;
  const workspaceId = useMatch('/w/:workspaceId/*')?.params.workspaceId ?? null;
  const workspace = useWorkspaceQuery(actorId, workspaceId);
  const currentWorkspace = workspace.isSuccess ? workspace.data : null;
  useDiscardPreviousWorkspace(actorId, workspaceId);
  // A covered frame stays mounted for its drafts but must not keep polling workspace heads.
  useWorkspaceLiveRefresh(actorId, workspaceId, sessionActive && workspace.isSuccess && workspace.headDenial === null);

  const shared = me.authMode === 'shared';

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
          localMode={!shared}
          account={shared ? <AccountControls name={me.actor.displayName} /> : undefined}
        />
        <main
          id="main"
          tabIndex={-1}
          className="mx-auto w-full max-w-6xl min-w-0 flex-1 px-4 py-4 outline-none sm:px-6 sm:py-5 lg:px-8 lg:py-6"
        >
          <SwitchErrorNotice />
          {shared ? <SignOutNotice /> : null}
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
