import { useEffect, useId, useRef, useState } from 'react';
import { useTranslation } from '../../i18n';
import { APP_HOME, checkSession, loginHref } from './authApi';
import type { CallbackOutcome } from './callbackExchange';

export interface AuthCallbackPageProps {
  /** Started once by the caller; this page only observes it. */
  exchange: Promise<CallbackOutcome>;
  /** Top-level navigation that replaces the callback entry in history. */
  navigate: (url: string) => void;
}

type CheckState = 'idle' | 'checking' | 'failed';

export function AuthCallbackPage({ exchange, navigate }: AuthCallbackPageProps) {
  const { t } = useTranslation();
  const titleId = useId();
  const [outcome, setOutcome] = useState<CallbackOutcome | null>(null);
  const [check, setCheck] = useState<CheckState>('idle');
  const checking = useRef(false);

  useEffect(() => {
    let active = true;
    void exchange.then((result) => {
      if (!active) return;
      setOutcome(result);
      if (result.kind === 'signed_in') navigate(result.returnTo);
    });
    return () => {
      active = false;
    };
  }, [exchange, navigate]);

  // Only a read: the callback tokens are never sent again, whatever happened to the exchange.
  const checkSignIn = () => {
    if (checking.current) return;
    checking.current = true;
    setCheck('checking');
    void checkSession().then(
      () => {
        navigate(APP_HOME);
      },
      () => {
        checking.current = false;
        setCheck('failed');
      },
    );
  };

  const failure = outcome && outcome.kind !== 'signed_in' ? outcome.kind : null;

  return (
    <main aria-labelledby={titleId} className="mx-auto flex min-h-screen max-w-md flex-col justify-center gap-4 p-6">
      <h1 id={titleId} className="text-xl font-semibold">
        {t('auth.callbackTitle')}
      </h1>
      <p>{t('auth.callbackDescription')}</p>
      {failure === null ? (
        <p role="status" aria-live="polite">
          {t('auth.callbackSigningIn')}
        </p>
      ) : (
        <>
          <p role="alert">{t(failure === 'invalid' ? 'auth.callbackInvalid' : 'auth.callbackFailed')}</p>
          {check === 'failed' && <p role="alert">{t('auth.checkSessionFailed')}</p>}
          <div className="flex flex-wrap items-center gap-3">
            <button type="button" onClick={checkSignIn} disabled={check === 'checking'} aria-busy={check === 'checking'}>
              {t(check === 'checking' ? 'auth.checkingSession' : 'auth.checkSession')}
            </button>
            <a href={loginHref(APP_HOME)}>{t('auth.restartSignIn')}</a>
            <a href="/">{t('auth.backToSite')}</a>
          </div>
        </>
      )}
    </main>
  );
}
