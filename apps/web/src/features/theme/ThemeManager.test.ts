import { afterEach, describe, expect, it, vi } from 'vitest';
import { createThemeManager, THEME_STORAGE_KEY, type ThemeEnvironment } from './ThemeManager';

interface FakeOptions {
  saved?: string | null;
  systemDark?: boolean;
  storage?: 'ok' | 'throws-on-access' | 'throws-on-use';
  matchMedia?: 'ok' | 'missing' | 'throws' | 'legacy';
  meta?: boolean;
}

/** A self-contained browser slice: its own document, storage, media query and window listeners. */
function fakeBrowser({ saved = null, systemDark = false, storage = 'ok', matchMedia = 'ok', meta = true }: FakeOptions = {}) {
  const document = window.document.implementation.createHTMLDocument('theme');
  if (meta) {
    const tag = document.createElement('meta');
    tag.setAttribute('name', 'theme-color');
    tag.setAttribute('content', '#f8fafc');
    tag.setAttribute('data-light', '#f8fafc');
    tag.setAttribute('data-dark', '#0b1120');
    document.head.append(tag);
  }
  const store = new Map<string, string>();
  if (saved !== null) store.set(THEME_STORAGE_KEY, saved);
  const writes: Array<[string, string]> = [];
  const state = { dark: systemDark };
  const mediaListeners = new Set<() => void>();
  const windowListeners = new Map<string, Set<(event: Event) => void>>();
  const notify = (key: string | null, newValue: string | null) => {
    const event = new StorageEvent('storage', { key, newValue });
    for (const listener of [...(windowListeners.get('storage') ?? [])]) listener(event);
  };
  const localStorage = {
    getItem: (key: string) => {
      if (storage === 'throws-on-use') throw new DOMException('blocked', 'SecurityError');
      return store.get(key) ?? null;
    },
    setItem: (key: string, value: string) => {
      if (storage === 'throws-on-use') throw new DOMException('quota', 'QuotaExceededError');
      writes.push([key, value]);
      store.set(key, value);
    },
  };
  const query = {
    get matches() { return state.dark; },
    media: '(prefers-color-scheme: dark)',
    ...(matchMedia === 'legacy'
      ? { addListener: (listener: () => void) => { mediaListeners.add(listener); }, removeListener: (listener: () => void) => { mediaListeners.delete(listener); } }
      : { addEventListener: (_: string, listener: () => void) => { mediaListeners.add(listener); }, removeEventListener: (_: string, listener: () => void) => { mediaListeners.delete(listener); } }),
  };
  const env: Record<string, unknown> = {
    document,
    addEventListener: (type: string, listener: (event: Event) => void) => {
      const set = windowListeners.get(type) ?? new Set();
      set.add(listener);
      windowListeners.set(type, set);
    },
    removeEventListener: (type: string, listener: (event: Event) => void) => { windowListeners.get(type)?.delete(listener); },
  };
  Object.defineProperty(env, 'localStorage', {
    enumerable: true,
    get: () => {
      if (storage === 'throws-on-access') throw new DOMException('blocked', 'SecurityError');
      return localStorage;
    },
  });
  if (matchMedia === 'ok' || matchMedia === 'legacy') env.matchMedia = () => query;
  if (matchMedia === 'throws') env.matchMedia = () => { throw new Error('unsupported'); };
  return {
    env: env as unknown as ThemeEnvironment,
    document,
    store,
    writes,
    setSystem(dark: boolean) {
      state.dark = dark;
      for (const listener of [...mediaListeners]) listener();
    },
    otherTab(key: string | null, newValue: string | null) {
      if (key === null) store.clear();
      else if (newValue === null) store.delete(key);
      else store.set(key, newValue);
      notify(key, newValue);
    },
    /** Delivers another tab's notification late, after storage has already moved on. */
    staleNotification: notify,
    listenerCounts: () => ({ media: mediaListeners.size, storage: windowListeners.get('storage')?.size ?? 0 }),
  };
}

const root = (document: Document) => ({
  theme: document.documentElement.getAttribute('data-theme'),
  scheme: document.documentElement.style.colorScheme,
  meta: document.querySelector('meta[name="theme-color"]')?.getAttribute('content'),
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('initial theme', () => {
  it('uses a saved light or dark choice over the system preference', () => {
    for (const [saved, systemDark] of [['light', true], ['dark', false]] as const) {
      const browser = fakeBrowser({ saved, systemDark });
      const manager = createThemeManager(browser.env);
      manager.start();
      expect(manager.getTheme()).toBe(saved);
      expect(manager.getChoice()).toBe(saved);
      expect(root(browser.document)).toEqual({ theme: saved, scheme: saved, meta: saved === 'dark' ? '#0b1120' : '#f8fafc' });
    }
  });

  it('follows the system when nothing valid is saved', () => {
    for (const saved of [null, '', 'DARK', 'system', '"dark"', 'light ']) {
      const browser = fakeBrowser({ saved, systemDark: true });
      const manager = createThemeManager(browser.env);
      manager.start();
      expect(manager.getChoice()).toBeNull();
      expect(root(browser.document)).toEqual({ theme: 'dark', scheme: 'dark', meta: '#0b1120' });
    }
    const light = fakeBrowser({ systemDark: false });
    const manager = createThemeManager(light.env);
    manager.start();
    expect(root(light.document)).toEqual({ theme: 'light', scheme: 'light', meta: '#f8fafc' });
  });

  it('falls back safely when storage or matchMedia is unavailable', () => {
    for (const storage of ['throws-on-access', 'throws-on-use'] as const) {
      const browser = fakeBrowser({ saved: 'light', systemDark: true, storage });
      const manager = createThemeManager(browser.env);
      expect(() => manager.start()).not.toThrow();
      expect(manager.getTheme()).toBe('dark');
      expect(() => manager.setTheme('light')).not.toThrow();
      expect(manager.getTheme()).toBe('light');
      expect(root(browser.document).theme).toBe('light');
    }
    for (const matchMedia of ['missing', 'throws'] as const) {
      const browser = fakeBrowser({ matchMedia });
      const manager = createThemeManager(browser.env);
      expect(() => manager.start()).not.toThrow();
      expect(root(browser.document)).toEqual({ theme: 'light', scheme: 'light', meta: '#f8fafc' });
    }
  });

  it('defaults to light with no browser at all and without a theme-color tag', () => {
    const manager = createThemeManager(null);
    expect(manager.getTheme()).toBe('light');
    expect(() => manager.start()()).not.toThrow();
    expect(() => manager.toggle()).not.toThrow();
    const browser = fakeBrowser({ systemDark: true, meta: false });
    createThemeManager(browser.env).start();
    expect(root(browser.document)).toEqual({ theme: 'dark', scheme: 'dark', meta: undefined });
  });
});

describe('explicit choice', () => {
  it('persists only the theme key and notifies subscribers', () => {
    const browser = fakeBrowser();
    const manager = createThemeManager(browser.env);
    manager.start();
    const listener = vi.fn();
    manager.subscribe(listener);
    manager.toggle();
    expect(manager.getTheme()).toBe('dark');
    expect(root(browser.document)).toEqual({ theme: 'dark', scheme: 'dark', meta: '#0b1120' });
    manager.setTheme('light');
    expect(browser.writes).toEqual([[THEME_STORAGE_KEY, 'dark'], [THEME_STORAGE_KEY, 'light']]);
    expect([...browser.store.keys()]).toEqual([THEME_STORAGE_KEY]);
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it('ignores values that are not a theme', () => {
    const browser = fakeBrowser();
    const manager = createThemeManager(browser.env);
    manager.start();
    manager.setTheme('blue' as never);
    expect(browser.writes).toEqual([]);
    expect(manager.getTheme()).toBe('light');
  });

  it('never touches the network', () => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    const browser = fakeBrowser();
    const manager = createThemeManager(browser.env);
    manager.start();
    manager.toggle();
    browser.otherTab(THEME_STORAGE_KEY, 'light');
    browser.setSystem(true);
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe('following the system and other tabs', () => {
  it('follows OS changes only while there is no explicit choice', () => {
    const browser = fakeBrowser();
    const manager = createThemeManager(browser.env);
    manager.start();
    browser.setSystem(true);
    expect(root(browser.document).theme).toBe('dark');
    manager.setTheme('light');
    browser.setSystem(false);
    browser.setSystem(true);
    expect(manager.getTheme()).toBe('light');
    expect(root(browser.document).theme).toBe('light');
  });

  it('supports the legacy media listener API', () => {
    const browser = fakeBrowser({ matchMedia: 'legacy' });
    const manager = createThemeManager(browser.env);
    const stop = manager.start();
    browser.setSystem(true);
    expect(manager.getTheme()).toBe('dark');
    stop();
    expect(browser.listenerCounts()).toEqual({ media: 0, storage: 0 });
  });

  it('applies another tab’s change, and its removal falls back to the current system theme', () => {
    const browser = fakeBrowser({ systemDark: true });
    const manager = createThemeManager(browser.env);
    manager.start();
    browser.otherTab(THEME_STORAGE_KEY, 'light');
    expect(manager.getChoice()).toBe('light');
    expect(root(browser.document).theme).toBe('light');
    browser.otherTab(THEME_STORAGE_KEY, null);
    expect(manager.getChoice()).toBeNull();
    expect(root(browser.document).theme).toBe('dark');
    browser.otherTab(THEME_STORAGE_KEY, 'light');
    browser.otherTab(null, null);
    expect(manager.getChoice()).toBeNull();
    expect(root(browser.document).theme).toBe('dark');
    browser.setSystem(false);
    expect(root(browser.document).theme).toBe('light');
  });

  it('treats an invalid value from another tab as no choice and ignores unrelated keys', () => {
    const browser = fakeBrowser({ saved: 'light', systemDark: true });
    const manager = createThemeManager(browser.env);
    manager.start();
    const listener = vi.fn();
    manager.subscribe(listener);
    browser.otherTab('workloom.locale', 'de');
    expect(listener).not.toHaveBeenCalled();
    expect(manager.getTheme()).toBe('light');
    browser.otherTab(THEME_STORAGE_KEY, '<script>');
    expect(manager.getChoice()).toBeNull();
    expect(root(browser.document).theme).toBe('dark');
    expect(browser.writes).toEqual([]);
  });

  it('keeps the persisted choice when another tab’s queued light or clear notification arrives late', () => {
    const browser = fakeBrowser({ systemDark: false });
    const manager = createThemeManager(browser.env);
    manager.start();
    const listener = vi.fn();
    manager.subscribe(listener);
    // Another tab wrote light, then this tab chose dark before that tab's notification was delivered.
    browser.store.set(THEME_STORAGE_KEY, 'light');
    manager.setTheme('dark');
    browser.staleNotification(THEME_STORAGE_KEY, 'light');
    expect(manager.getChoice()).toBe('dark');
    expect(root(browser.document)).toEqual({ theme: 'dark', scheme: 'dark', meta: '#0b1120' });
    // Another tab cleared storage, then this tab chose dark again before the clear was delivered.
    browser.store.clear();
    manager.setTheme('dark');
    browser.staleNotification(null, null);
    expect(manager.getChoice()).toBe('dark');
    expect(root(browser.document)).toEqual({ theme: 'dark', scheme: 'dark', meta: '#0b1120' });
    expect(browser.store.get(THEME_STORAGE_KEY)).toBe('dark');
    expect(browser.writes).toEqual([[THEME_STORAGE_KEY, 'dark'], [THEME_STORAGE_KEY, 'dark']]);
    expect(listener).toHaveBeenCalledTimes(1);
  });
});

describe('lifecycle', () => {
  it('starts once, and the stop function removes every listener', () => {
    const browser = fakeBrowser();
    const manager = createThemeManager(browser.env);
    const stop = manager.start();
    expect(manager.start()).toBe(stop);
    expect(browser.listenerCounts()).toEqual({ media: 1, storage: 1 });
    stop();
    stop();
    expect(browser.listenerCounts()).toEqual({ media: 0, storage: 0 });
    browser.setSystem(true);
    expect(root(browser.document).theme).toBe('light');
    const again = manager.start();
    expect(again).not.toBe(stop);
    expect(root(browser.document).theme).toBe('dark');
    expect(browser.listenerCounts()).toEqual({ media: 1, storage: 1 });
    again();
  });

  it('unsubscribes listeners', () => {
    const browser = fakeBrowser();
    const manager = createThemeManager(browser.env);
    manager.start();
    const listener = vi.fn();
    const unsubscribe = manager.subscribe(listener);
    unsubscribe();
    manager.toggle();
    expect(listener).not.toHaveBeenCalled();
  });

  it('only sets attributes on the root, so the page content is never replaced', () => {
    const browser = fakeBrowser();
    const app = browser.document.createElement('div');
    browser.document.body.append(app);
    const manager = createThemeManager(browser.env);
    manager.start();
    manager.toggle();
    expect(browser.document.body.firstElementChild).toBe(app);
    expect(browser.document.documentElement.getAttributeNames().sort()).toEqual(['data-theme', 'style']);
  });
});
