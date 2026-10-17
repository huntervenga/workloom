import { t, useTranslation } from '../../i18n';
import { useQuery } from '@tanstack/react-query';
import { Button, Logomark } from '@workloom/ui';
import { LogIn, RefreshCw } from 'lucide-react';
import type { ReactNode } from 'react';
import { useLocation } from 'react-router';
import { useOptionalSession } from '../../app/session';
import { QueryErrorState } from '../../shared/QueryErrorState';
import { boundedReturnTo, fetchAuthMode, loginHref } from './authApi';

export type AuthMode = 'dev' | 'shared';

/** Read only after the server reported no session; the answer does not change within a tab. */
function useAuthModeQuery(enabled: boolean) {
  return useQuery({
    queryKey: ['auth', 'config'],
    queryFn: ({ signal }) => fetchAuthMode(signal),
    enabled,
    staleTime: Infinity,
    retry: false,
  });
}

// Only plain in-page anchors come back; anything shaped like parameters stays behind.
const ordinaryHash = /^#[^\s\\?=&]+$/;

/** Where sign-in should return: the current app page with its query and an ordinary hash. */
function useCurrentReturnTo(): string {
  const { pathname, search, hash } = useLocation();
  // The router strips the /app basename; a path that still carries it is not prefixed twice.
  const inApp = pathname === '/app' || pathname.startsWith('/app/');
  const path = inApp ? pathname : pathname === '/' ? '/app' : `/app${pathname}`;
  return boundedReturnTo(`${path}${search}${ordinaryHash.test(hash) ? hash : ''}`);
}

function GateFrame({ children }: { children: ReactNode }) {
  useTranslation();
  return (
    <div className="grid min-h-dvh place-items-center px-4 py-10">
      <div className="w-full max-w-md">
        <div className="mb-6 flex items-center justify-center gap-2.5">
          <Logomark className="size-7" />
          <span className="text-[15px] font-semibold tracking-tight">{t('common.brand')}</span>
        </div>
        {children}
      </div>
    </div>
  );
}

export interface LoginScreenProps {
  /** The identity read that answered without a session; shown as before in dev mode. */
  identityError: unknown;
  retryingIdentity: boolean;
  onRetryIdentity: () => void;
  /** Known from a previous shared identity; skips the configuration read. */
  mode?: AuthMode | undefined;
}

/**
 * Shown when the server reports no session. Shared mode offers sign-in through a full-tab
 * navigation; dev mode keeps the identity error with its retry. Server messages never appear.
 */
export function LoginScreen({ identityError, retryingIdentity, onRetryIdentity, mode }: LoginScreenProps) {
  useTranslation();
  const config = useAuthModeQuery(mode === undefined);
  const resolved = mode ?? (config.isSuccess ? config.data : undefined);

  if (resolved === 'dev') {
    return (
      <GateFrame>
        <QueryErrorState error={identityError} subject="identity" headingLevel={1} retrying={retryingIdentity} onRetry={onRetryIdentity} />
      </GateFrame>
    );
  }

  if (resolved === 'shared') {
    return (
      <GateFrame>
        <SignInCard />
      </GateFrame>
    );
  }

  if (config.isPending) {
    return (
      <GateFrame>
        <p role="status" className="text-center text-sm text-muted">
          {t('auth.checkingMode')}
        </p>
      </GateFrame>
    );
  }

  // A failed read or an answer this app does not know: offer a retry, never a guessed mode.
  return (
    <GateFrame>
      <section role="alert" className="rounded-2xl border border-line bg-surface p-6 text-center">
        <h1 className="text-lg font-semibold text-ink">{t('auth.modeFailed')}</h1>
        <div className="mt-4 flex justify-center">
          <Button onClick={() => { if (!config.isFetching) void config.refetch(); }} aria-disabled={config.isFetching || undefined}>
            <RefreshCw size={16} aria-hidden="true" className={config.isFetching ? 'motion-safe:animate-spin' : undefined} />
            {t('auth.tryAgain')}
          </Button>
        </div>
      </section>
    </GateFrame>
  );
}

function SignInCard() {
  useTranslation();
  const session = useOptionalSession();
  const returnTo = useCurrentReturnTo();
  return (
    <section aria-labelledby="sign-in-title" className="rounded-2xl border border-line bg-surface p-6 text-center">
      <h1 id="sign-in-title" className="text-lg font-semibold text-ink">
        {t('auth.signInTitle')}
      </h1>
      <p className="mt-2 text-sm leading-relaxed text-ink-soft">{t('auth.signInDescription')}</p>
      <a
        href={loginHref(returnTo)}
        onClick={(event) => {
          // A plain click asks first when work would be lost; other clicks stay native.
          if (!session || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
          event.preventDefault();
          void session.startSignIn(returnTo);
        }}
        className="mt-5 inline-flex h-10 items-center justify-center gap-2 rounded-lg bg-accent-strong px-4 text-sm font-medium text-white hover:opacity-90"
      >
        <LogIn size={16} aria-hidden="true" />
        {t('auth.signIn')}
      </a>
    </section>
  );
}
