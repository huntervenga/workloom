import bootstrapSource from '../../../public/theme-init.js?raw';
import spa from '../../../index.html?raw';
import landingTemplate from '../../../landing.html?raw';
import { describe, expect, it } from 'vitest';
import { createThemeManager, THEME_STORAGE_KEY, type ThemeEnvironment } from './ThemeManager';

type Storage = 'ok' | 'throws-on-access' | 'throws-on-use';
type Media = 'ok' | 'missing' | 'throws';
interface Scenario { saved: string | null; systemDark: boolean; storage: Storage; media: Media }

/** A fresh document plus a window slice that records every property the code reads. */
function browser({ saved, systemDark, storage, media }: Scenario) {
  const document = window.document.implementation.createHTMLDocument('bootstrap');
  const meta = document.createElement('meta');
  meta.setAttribute('name', 'theme-color');
  meta.setAttribute('content', '#f8fafc');
  meta.setAttribute('data-light', '#f8fafc');
  meta.setAttribute('data-dark', '#0b1120');
  document.head.append(meta);
  const reads: string[] = [];
  const keys: string[] = [];
  let writes = 0;
  const localStorage = {
    getItem(key: string) {
      keys.push(key);
      if (storage === 'throws-on-use') throw new DOMException('blocked', 'SecurityError');
      return key === THEME_STORAGE_KEY ? saved : null;
    },
    setItem() { writes += 1; },
  };
  const target: Record<string, unknown> = {
    document,
    get localStorage() {
      if (storage === 'throws-on-access') throw new DOMException('blocked', 'SecurityError');
      return localStorage;
    },
  };
  if (media === 'ok') target.matchMedia = (query: string) => ({ matches: query === '(prefers-color-scheme: dark)' && systemDark, addEventListener() {}, removeEventListener() {} });
  if (media === 'throws') target.matchMedia = () => { throw new Error('unsupported'); };
  const win = new Proxy(target, { get: (object, property) => { reads.push(String(property)); return Reflect.get(object, property); } });
  return { win, document, reads, keys, writes: () => writes };
}

/** Executes the real public/theme-init.js file, exactly as the browser would as a classic script. */
function runBootstrap(win: object) {
  new Function('globalThis', bootstrapSource)(win);
}

const state = (document: Document) => ({
  theme: document.documentElement.getAttribute('data-theme'),
  scheme: document.documentElement.style.colorScheme,
  meta: document.querySelector('meta[name="theme-color"]')?.getAttribute('content'),
});

const scenarios: Scenario[] = [];
for (const saved of [null, 'light', 'dark', 'Dark', 'system', '']) {
  for (const systemDark of [false, true]) {
    for (const storage of ['ok', 'throws-on-access', 'throws-on-use'] as const) {
      for (const media of ['ok', 'missing', 'throws'] as const) scenarios.push({ saved, systemDark, storage, media });
    }
  }
}

describe('theme-init.js before first paint', () => {
  it('applies saved choice, else system, else light', () => {
    const cases: Array<[Partial<Scenario>, string]> = [
      [{ saved: 'dark' }, 'dark'],
      [{ saved: 'light', systemDark: true }, 'light'],
      [{ saved: null, systemDark: true }, 'dark'],
      [{ saved: 'bogus', systemDark: true }, 'dark'],
      [{ saved: null, systemDark: false }, 'light'],
      [{ saved: 'dark', storage: 'throws-on-access' }, 'light'],
      [{ saved: 'dark', storage: 'throws-on-use', systemDark: true }, 'dark'],
      [{ saved: null, systemDark: true, media: 'missing' }, 'light'],
      [{ saved: null, systemDark: true, media: 'throws' }, 'light'],
    ];
    for (const [partial, expected] of cases) {
      const fake = browser({ saved: null, systemDark: false, storage: 'ok', media: 'ok', ...partial });
      expect(() => runBootstrap(fake.win)).not.toThrow();
      expect(state(fake.document)).toEqual({ theme: expected, scheme: expected, meta: expected === 'dark' ? '#0b1120' : '#f8fafc' });
    }
  });

  it('matches the theme manager in every scenario, so the module start never repaints', () => {
    for (const scenario of scenarios) {
      const fake = browser(scenario);
      runBootstrap(fake.win);
      const painted = state(fake.document);
      const observer = new MutationObserver(() => undefined);
      observer.observe(fake.document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
      const manager = createThemeManager(fake.win as unknown as ThemeEnvironment);
      const stop = manager.start();
      expect({ scenario, theme: manager.getTheme() }).toEqual({ scenario, theme: painted.theme });
      expect(state(fake.document)).toEqual(painted);
      expect(observer.takeRecords()).toHaveLength(0);
      observer.disconnect();
      stop();
    }
  });

  it('reads only the theme key and the color-scheme query, and writes nothing', () => {
    const fake = browser({ saved: null, systemDark: true, storage: 'ok', media: 'ok' });
    runBootstrap(fake.win);
    expect(new Set(fake.reads)).toEqual(new Set(['localStorage', 'matchMedia', 'document']));
    expect(fake.keys).toEqual([THEME_STORAGE_KEY]);
    expect(fake.writes()).toBe(0);
    expect(bootstrapSource).not.toMatch(/fetch|XMLHttpRequest|location|cookie|sessionStorage|setItem|eval|innerHTML/);
  });

  it('leaves a page without a theme-color tag or document untouched', () => {
    const document = window.document.implementation.createHTMLDocument('bare');
    expect(() => runBootstrap({ document, localStorage: { getItem: () => 'dark' } })).not.toThrow();
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
    expect(() => runBootstrap({})).not.toThrow();
  });
});

// The original sign-in callback script, byte for byte. It must stay the first script in the SPA.
const AUTH_SCRIPT = `    <script>
      // Runs before any other resource: takes sign-in tokens out of the callback fragment and
      // removes them from the address bar. They stay in this closure until the entry script takes them once.
      (function (w) {
        var path = w.location.pathname;
        if (path !== '/app/auth/callback' && path !== '/app/auth/callback/') return;
        var fragment = w.location.hash;
        try {
          w.history.replaceState(null, '', path);
        } catch (e) {
          fragment = '';
        }
        if (w.location.hash !== '') fragment = '';
        var tokens = read(fragment);
        fragment = '';
        Object.defineProperty(w, '__workloomTakeAuthCallback', {
          configurable: true,
          value: function () {
            var taken = tokens;
            tokens = null;
            delete w.__workloomTakeAuthCallback;
            return taken;
          }
        });

        function read(hash) {
          if (hash.length < 2 || hash.length > 65536) return null;
          var params = new URLSearchParams(hash.slice(1));
          var names = ['access_token', 'refresh_token', 'state'];
          var values = [];
          for (var i = 0; i < names.length; i += 1) {
            var all = params.getAll(names[i]);
            if (all.length !== 1 || all[0].length === 0 || all[0].length > 16384) return null;
            values.push(all[0]);
          }
          return { accessToken: values[0], refreshToken: values[1], state: values[2] };
        }
      })(window);
    </script>
`;
const THEME_SCRIPT = '<script src="/theme-init.js"></script>';

describe('theme-init.js placement in both HTML entry points', () => {
  it('keeps the SPA auth callback script exact and first, then loads the theme before the app', () => {
    const authAt = spa.indexOf(AUTH_SCRIPT);
    expect(authAt).toBeGreaterThan(0);
    expect(spa.indexOf('<script')).toBe(authAt + 4);
    expect(spa.indexOf('<meta name="referrer" content="same-origin" />')).toBeLessThan(authAt);
    const themeAt = spa.indexOf(THEME_SCRIPT);
    expect(themeAt).toBeGreaterThan(authAt + AUTH_SCRIPT.length);
    expect(spa.indexOf('name="theme-color"')).toBeLessThan(themeAt);
    expect(themeAt).toBeLessThan(spa.indexOf('</head>'));
    expect(themeAt).toBeLessThan(spa.indexOf('/src/main.tsx'));
    expect(spa.match(/<script/g)).toHaveLength(3);
    expect(spa.match(/<script>/g)).toHaveLength(1);
    expect(spa).toContain('<meta name="robots" content="noindex" />');
  });

  it('loads the theme in the landing head before its stylesheet with no inline script', () => {
    const themeAt = landingTemplate.indexOf(THEME_SCRIPT);
    expect(themeAt).toBeGreaterThan(0);
    expect(themeAt).toBeLessThan(landingTemplate.indexOf('<link rel="stylesheet"'));
    expect(landingTemplate.indexOf('name="theme-color"')).toBeLessThan(themeAt);
    expect(landingTemplate).not.toMatch(/<script>/);
  });

  it('declares light and dark browser colors on both theme-color tags', () => {
    for (const html of [spa, landingTemplate]) {
      const meta = new DOMParser().parseFromString(html, 'text/html').querySelector('meta[name="theme-color"]');
      expect(meta?.getAttribute('content')).toBe(meta?.getAttribute('data-light'));
      expect(meta?.getAttribute('data-dark')).toMatch(/^#[0-9a-f]{6}$/);
    }
  });
});
