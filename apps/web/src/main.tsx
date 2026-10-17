import '@fontsource/inter/400.css';
import '@fontsource/inter/500.css';
import '@fontsource/inter/600.css';
import '@fontsource/inter/700.css';
import './styles.css';

import { runBootstrap } from './app/bootstrap';

void runBootstrap(window.location, () => import('./app/mountApp').then((m) => m.mountApp()));
