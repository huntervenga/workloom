export type Theme = 'light' | 'dark';

/** Same key and query as public/theme-init.js, which applies the theme before first paint. */
export const THEME_STORAGE_KEY = 'workloom.theme';
export const DARK_QUERY = '(prefers-color-scheme: dark)';

type StorageLike = Pick<Storage, 'getItem' | 'setItem'>;
type Listener = () => void;

/** The slice of `window` the manager touches; tests pass their own. */
export interface ThemeEnvironment {
  readonly document?: Document | undefined;
  readonly localStorage?: StorageLike | undefined;
  matchMedia?: ((query: string) => MediaQueryList) | undefined;
  addEventListener?: Window['addEventListener'] | undefined;
  removeEventListener?: Window['removeEventListener'] | undefined;
}

export interface ThemeManager {
  /** The theme in effect: the explicit choice, else the system preference, else light. */
  getTheme(): Theme;
  /** The explicit choice, or null when following the system. */
  getChoice(): Theme | null;
  setTheme(theme: Theme): void;
  toggle(): void;
  subscribe(listener: Listener): () => void;
  /** Applies the theme and follows other tabs and the OS. Idempotent; returns a stop function. */
  start(): () => void;
}

export function parseTheme(value: unknown): Theme | null {
  return value === 'light' || value === 'dark' ? value : null;
}

/** Defaults to the real window; `null` means no browser at all (server rendering, workers). */
export function createThemeManager(browser?: ThemeEnvironment | null): ThemeManager {
  const env: ThemeEnvironment | undefined = browser === undefined ? (typeof window === 'undefined' ? undefined : window) : browser ?? undefined;
  const listeners = new Set<Listener>();
  let choice = readChoice();
  let system = readSystem();
  let stop: (() => void) | null = null;

  function storage(): StorageLike | null {
    try {
      return env?.localStorage ?? null;
    } catch {
      return null;
    }
  }

  function readChoice(): Theme | null {
    try {
      return parseTheme(storage()?.getItem(THEME_STORAGE_KEY));
    } catch {
      return null;
    }
  }

  function media(): MediaQueryList | null {
    try {
      return env?.matchMedia?.(DARK_QUERY) ?? null;
    } catch {
      return null;
    }
  }

  function readSystem(): Theme {
    try {
      return media()?.matches === true ? 'dark' : 'light';
    } catch {
      return 'light';
    }
  }

  const getTheme = (): Theme => choice ?? system;

  function apply() {
    const doc = env?.document;
    if (!doc) return;
    const theme = getTheme();
    try {
      const root = doc.documentElement;
      if (root.getAttribute('data-theme') !== theme) root.setAttribute('data-theme', theme);
      root.style.colorScheme = theme;
      const meta = doc.querySelector('meta[name="theme-color"]');
      const color = meta?.getAttribute(`data-${theme}`);
      if (meta && color) meta.setAttribute('content', color);
    } catch {
      // A missing or locked-down document leaves the page in its default light look.
    }
  }

  function update(nextChoice: Theme | null, nextSystem: Theme) {
    const before = getTheme();
    choice = nextChoice;
    system = nextSystem;
    if (getTheme() === before) return;
    apply();
    for (const listener of [...listeners]) listener();
  }

  const onStorage = (event: StorageEvent) => {
    if (event.key !== THEME_STORAGE_KEY && event.key !== null) return;
    // Events can arrive after newer writes, so storage itself, not the event payload, is canonical.
    // A cleared or removed key, or a stored value that is not a theme, means "follow the system".
    update(readChoice(), readSystem());
  };

  const onSystemChange = () => update(choice, readSystem());

  const setTheme = (theme: Theme) => {
    const valid = parseTheme(theme);
    if (!valid) return;
    try {
      storage()?.setItem(THEME_STORAGE_KEY, valid);
    } catch {
      // Private mode or a full quota: the choice still holds for this page.
    }
    update(valid, system);
  };

  return {
    getTheme,
    getChoice: () => choice,
    setTheme,
    toggle: () => setTheme(getTheme() === 'dark' ? 'light' : 'dark'),
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    start() {
      if (stop) return stop;
      choice = readChoice();
      system = readSystem();
      apply();
      const query = media();
      try {
        env?.addEventListener?.('storage', onStorage);
      } catch {
        // No cross-tab sync without storage events.
      }
      try {
        if (query?.addEventListener) query.addEventListener('change', onSystemChange);
        else query?.addListener?.(onSystemChange);
      } catch {
        // No OS following without media change events.
      }
      const current = () => {
        if (stop !== current) return;
        stop = null;
        try {
          env?.removeEventListener?.('storage', onStorage);
        } catch {
          // Nothing to remove.
        }
        try {
          if (query?.removeEventListener) query.removeEventListener('change', onSystemChange);
          else query?.removeListener?.(onSystemChange);
        } catch {
          // Nothing to remove.
        }
      };
      stop = current;
      return current;
    },
  };
}

/** Shared by the app and the landing page; React-free so the landing bundle stays small. */
export const themeManager = createThemeManager();
