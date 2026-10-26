import { themeManager } from '../features/theme/ThemeManager';

if (typeof document !== 'undefined' && document.body?.classList.contains('landing')) {
  themeManager.start();
  const pickers = [...document.querySelectorAll<HTMLDetailsElement>('.language-picker')];
  document.addEventListener('click', event => {
    for (const picker of pickers) if (event.target instanceof Node && !picker.contains(event.target)) picker.open = false;
  });
  document.addEventListener('keydown', event => {
    if (event.key !== 'Escape') return;
    for (const picker of pickers) if (picker.open) {
      picker.open = false;
      picker.querySelector('summary')?.focus();
    }
  });
}
