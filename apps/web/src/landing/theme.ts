import copy from '../i18n/locales/en/theme.json';
import { themeManager, type ThemeManager } from '../features/theme/ThemeManager';

/**
 * Wires the prerendered theme button; nothing else on the landing page runs script.
 * The icon follows `data-theme` in CSS, so only the pressed state and title change here.
 */
export function wireThemeToggle(root: ParentNode = document, manager: ThemeManager = themeManager): () => void {
  const buttons = [...root.querySelectorAll<HTMLButtonElement>('button[data-theme-toggle]')];
  const stop = manager.start();
  const render = () => {
    const dark = manager.getTheme() === 'dark';
    for (const button of buttons) {
      button.setAttribute('aria-pressed', String(dark));
      button.title = dark ? copy.toLight : copy.toDark;
    }
  };
  const onClick = () => manager.toggle();
  for (const button of buttons) button.addEventListener('click', onClick);
  render();
  const unsubscribe = manager.subscribe(render);
  return () => {
    unsubscribe();
    for (const button of buttons) button.removeEventListener('click', onClick);
    stop();
  };
}

if (typeof document !== 'undefined' && document.body?.classList.contains('landing')) wireThemeToggle();
