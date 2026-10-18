import '@fontsource/inter/400.css';
import '@fontsource/inter/500.css';
import '@fontsource/inter/600.css';
import '@fontsource/inter/700.css';
import './styles.css';

import { runBootstrap } from './app/bootstrap';
import { takeAuthCallback } from './features/auth/callbackHandoff';
import { themeManager } from './features/theme/ThemeManager';

// Once per page, outside React: /theme-init.js already painted this theme, the manager keeps it.
themeManager.start();

void runBootstrap(
  window.location,
  () => import('./app/mountApp').then((m) => m.mountApp()),
  () => {
    // Take the tokens before awaiting anything, so the one-shot handoff is gone before more code loads.
    const tokens = takeAuthCallback();
    return import('./features/auth/mountAuthCallback').then((m) => m.mountAuthCallback(tokens));
  },
);
