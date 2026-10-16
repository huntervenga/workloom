import '@fontsource/inter/400.css';
import '@fontsource/inter/500.css';
import '@fontsource/inter/600.css';
import '@fontsource/inter/700.css';
import './styles.css';

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './app/App';
import { createQueryClient } from './lib/queryClient';
import { initializeLocalization } from './i18n';

initializeLocalization();

const container = document.getElementById('root');
if (!container) {
  throw new Error('Root element #root is missing');
}

createRoot(container).render(
  <StrictMode>
    <App queryClient={createQueryClient()} />
  </StrictMode>,
);
