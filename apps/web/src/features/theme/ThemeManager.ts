import type { UserTheme } from '@workloom/contracts';

/** default-dark preserves the original blue palette; dark is the explicit neutral palette; omnissiah is the warm brass one. */
export type Theme = 'light' | 'dark' | 'default-dark' | 'omnissiah';
/** Browser chrome colour for explicit dark palettes; light and default-dark read it from the page meta. */
const CHROME: Partial<Record<Theme, string>> = { dark: '#0d1117', omnissiah: '#121010' };
export interface ThemeEnvironment {
  readonly document?: Document | undefined;
  matchMedia?: ((query: string) => MediaQueryList) | undefined;
}
export interface ThemeManager {
  getTheme(): Theme;
  getChoice(): UserTheme;
  setTheme(theme: UserTheme): void;
  subscribe(listener: () => void): () => void;
  start(): () => void;
}
export const DARK_QUERY = '(prefers-color-scheme: dark)';
export function parseTheme(value: unknown): UserTheme | null {
  return value === 'default' || value === 'dark' || value === 'light' || value === 'omnissiah' ? value : null;
}

/** Presentation only. The signed-in user's API settings are the sole persistence source. */
export function createThemeManager(browser?: ThemeEnvironment | null): ThemeManager {
  const env = browser === undefined ? (typeof window === 'undefined' ? undefined : window) : browser ?? undefined;
  const listeners = new Set<() => void>();
  let choice: UserTheme = 'default', stop: (() => void) | null = null;
  const media = () => { try { return env?.matchMedia?.(DARK_QUERY) ?? null; } catch { return null; } };
  const getTheme = (): Theme => choice === 'default' ? (media()?.matches ? 'default-dark' : 'light') : choice;
  const apply = () => {
    const theme = getTheme(), doc = env?.document;
    if (doc) {
      doc.documentElement.setAttribute('data-theme', theme);
      doc.documentElement.style.colorScheme = theme === 'light' ? 'light' : 'dark';
      const meta = doc.querySelector('meta[name="theme-color"]');
      const color = CHROME[theme] ?? meta?.getAttribute(`data-${theme === 'default-dark' ? 'dark' : 'light'}`);
      if (meta && color) meta.setAttribute('content', color);
    }
    for (const listener of listeners) listener();
  };
  return {
    getTheme,
    getChoice: () => choice,
    setTheme(theme) { const valid = parseTheme(theme); if (valid) { choice = valid; apply(); } },
    subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    start() {
      if (stop) return stop;
      apply();
      const query = media();
      const changed = () => { if (choice === 'default') apply(); };
      if (query?.addEventListener) query.addEventListener('change', changed);
      else query?.addListener?.(changed);
      stop = () => {
        if (query?.removeEventListener) query.removeEventListener('change', changed);
        else query?.removeListener?.(changed);
        stop = null;
      };
      return stop;
    },
  };
}
export const themeManager = createThemeManager();
