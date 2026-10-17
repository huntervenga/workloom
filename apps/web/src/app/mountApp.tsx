import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { createQueryClient } from '../lib/queryClient';
import { initializeLocalization, t } from '../i18n';

export function mountApp(): void {
  initializeLocalization();

  const container = document.getElementById('root');
  if (!container) {
    throw new Error(t('shell.appRootMissing'));
  }

  createRoot(container).render(
    <StrictMode>
      <App queryClient={createQueryClient()} />
    </StrictMode>,
  );
}
