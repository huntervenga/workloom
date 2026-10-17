import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { initializeLocalization, t } from '../../i18n';
import { AuthCallbackPage } from './AuthCallbackPage';
import type { CallbackTokens } from './authApi';
import { startCallbackExchange } from './callbackExchange';

function leaveTo(url: string): void {
  window.location.replace(url);
}

/** Standalone entry for the sign-in callback: no app shell, router, session or query cache. */
export function mountAuthCallback(tokens: CallbackTokens | null): void {
  const container = document.getElementById('root');
  if (!container) throw new Error(t('shell.appRootMissing'));
  initializeLocalization();
  const exchange = startCallbackExchange(tokens);
  createRoot(container).render(
    <StrictMode>
      <AuthCallbackPage exchange={exchange} navigate={leaveTo} />
    </StrictMode>,
  );
}
