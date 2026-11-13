import { userThemeSchema, type UserTheme } from '@workloom/contracts';

import { desktopPalettes } from './palettes';

/** default-dark preserves the original system dark palette; all explicit choices are account themes. */
export type Theme = Exclude<UserTheme, 'default'> | 'default-dark';
/** Browser chrome follows the selected canvas; original palettes read it from page metadata. */
const CHROME: Partial<Record<Theme, string>> = { dark: '#0d1117', ...Object.fromEntries(desktopPalettes.map(palette => [palette.id, palette.canvas])) };
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
  const parsed = userThemeSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
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
      doc.documentElement.style.colorScheme = theme === 'light' || desktopPalettes.some(palette => palette.id === theme && palette.mode === 'light') ? 'light' : 'dark';
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
