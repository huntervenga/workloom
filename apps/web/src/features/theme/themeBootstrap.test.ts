import bootstrapSource from '../../../public/theme-init.js?raw';
import spaSource from '../../../index.html?raw';
import landingTemplate from '../../../landing.html?raw';
import { describe, expect, it } from 'vitest';
import { createThemeManager, type ThemeEnvironment } from './ThemeManager';

describe('anonymous initial theme', () => {
  it.each([false, true])('follows the system before identity loads without reading browser storage (dark=%s)', dark => {
    const doc = document.implementation.createHTMLDocument('bootstrap');
    const env = { document: doc, matchMedia: () => ({ matches: dark }) as MediaQueryList };
    Object.defineProperty(env, 'localStorage', { get() { throw Error('No local theme persistence'); } });
    new Function('window', bootstrapSource)(env);
    expect(doc.documentElement.dataset.theme).toBe(dark ? 'default-dark' : 'light');
    const manager = createThemeManager(env as ThemeEnvironment); manager.start();
    expect(doc.documentElement.dataset.theme).toBe(manager.getTheme());
  });
  it('falls back to light when media queries are unavailable', () => {
    const doc = document.implementation.createHTMLDocument('bootstrap');
    new Function('window', bootstrapSource)({ document: doc });
    expect(doc.documentElement.dataset.theme).toBe('light');
  });
});

const spa = spaSource.replace(/\r\n/g, '\n');
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
