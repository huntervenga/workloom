import { describe, expect, it } from 'vitest';
import indexHtml from '../../../index.html?raw';
import { AUTH_CALLBACK_HANDOFF, takeAuthCallback } from './callbackHandoff';

const ORIGIN = 'https://workloom.test';
const FRAGMENT =
  '#access_token=access-fixture&refresh_token=refresh-fixture&state=state-fixture&token_type=bearer&expires_in=3600';
const TOKENS = { accessToken: 'access-fixture', refreshToken: 'refresh-fixture', state: 'state-fixture' };

function parseIndex(): Document {
  return new DOMParser().parseFromString(indexHtml, 'text/html');
}

function inlineScriptSource(): string {
  const script = parseIndex().head.querySelector('script');
  if (!script) throw new Error('index.html has no script in its head');
  return script.text;
}

// Runs the shipped inline script against a window whose history behaves like a browser's.
function runInlineScript(href: string) {
  const start = new URL(href, ORIGIN);
  const location = { pathname: start.pathname, search: start.search, hash: start.hash };
  const replaced: string[] = [];
  const target = {
    location,
    history: {
      state: null,
      replaceState(...args: unknown[]) {
        const next = args[2];
        if (typeof next !== 'string') throw new TypeError('replaceState needs a URL');
        const url = new URL(next, start);
        if (url.origin !== start.origin) throw new TypeError('cross-origin replaceState');
        replaced.push(next);
        location.pathname = url.pathname;
        location.search = url.search;
        location.hash = url.hash;
      },
    },
  };
  const run = new Function('window', inlineScriptSource()) as (window: object) => void;
  run(target);
  return { target, location, replaced };
}

function storedValues(): string[] {
  const values: string[] = [];
  for (const storage of [localStorage, sessionStorage]) {
    for (let index = 0; index < storage.length; index += 1) {
      const key = storage.key(index);
      if (key !== null) values.push(key, storage.getItem(key) ?? '');
    }
  }
  return values;
}

describe('index.html', () => {
  it('runs a classic inline script before any module, stylesheet or icon', () => {
    const page = parseIndex();
    const headChildren = Array.from(page.head.children);
    const scripts = Array.from(page.head.querySelectorAll('script'));
    const inline = scripts[0];
    const icon = page.head.querySelector('link[rel="icon"]');

    expect(scripts).toHaveLength(1);
    expect(inline?.hasAttribute('src')).toBe(false);
    expect(inline?.hasAttribute('type')).toBe(false);
    expect(page.head.querySelector('link[rel="stylesheet"], script[type="module"]')).toBeNull();
    expect(icon).not.toBeNull();
    if (!inline || !icon) return;
    expect(headChildren.indexOf(inline)).toBeLessThan(headChildren.indexOf(icon));
    expect(page.body.querySelector('script[type="module"]')?.getAttribute('src')).toBe('/src/main.tsx');
  });

  it('declares same-origin referrer policy', () => {
    expect(parseIndex().head.querySelector('meta[name="referrer"]')?.getAttribute('content')).toBe('same-origin');
  });

  it('never stores, logs, renders or sends anything from the inline script', () => {
    expect(inlineScriptSource()).not.toMatch(/storage|console|cookie|document|fetch|XMLHttpRequest|innerHTML|sendBeacon/i);
  });
});

describe('callback inline script', () => {
  it.each(['/app/auth/callback', '/app/auth/callback/'])(
    'removes the fragment from %s before anything can take the tokens',
    (path) => {
      const { target, location, replaced } = runInlineScript(`${path}${FRAGMENT}`);

      expect(location.hash).toBe('');
      expect(replaced).toEqual([path]);
      expect(JSON.stringify(location)).not.toContain('fixture');
      expect(Reflect.has(target, AUTH_CALLBACK_HANDOFF)).toBe(true);

      expect(takeAuthCallback(target)).toEqual(TOKENS);
      expect(Reflect.has(target, AUTH_CALLBACK_HANDOFF)).toBe(false);
      expect(takeAuthCallback(target)).toBeNull();
      expect(storedValues().join(' ')).not.toContain('fixture');
    },
  );

  it('drops the callback query too', () => {
    const { location, replaced } = runInlineScript(`/app/auth/callback?code=query-fixture${FRAGMENT}`);

    expect(replaced).toEqual(['/app/auth/callback']);
    expect(location.search).toBe('');
  });

  it('hands the tokens out once even to a caller that kept the function', () => {
    const { target } = runInlineScript(`/app/auth/callback${FRAGMENT}`);
    const take: unknown = Reflect.get(target, AUTH_CALLBACK_HANDOFF);
    expect(typeof take).toBe('function');
    if (typeof take !== 'function') return;

    const first: unknown = Reflect.apply(take, undefined, []);
    const second: unknown = Reflect.apply(take, undefined, []);

    expect(first).toEqual(TOKENS);
    expect(second).toBeNull();
    expect(Reflect.has(target, AUTH_CALLBACK_HANDOFF)).toBe(false);
  });

  it.each([
    ['a duplicated token', '#access_token=access-fixture&access_token=other-fixture&refresh_token=refresh-fixture&state=state-fixture'],
    ['a duplicated state', '#access_token=access-fixture&refresh_token=refresh-fixture&state=state-fixture&state=state-fixture'],
    ['a missing state', '#access_token=access-fixture&refresh_token=refresh-fixture'],
    ['a missing refresh token', '#access_token=access-fixture&state=state-fixture'],
    ['an empty refresh token', '#access_token=access-fixture&refresh_token=&state=state-fixture'],
    ['an oversized token', `#access_token=${'a'.repeat(16_385)}&refresh_token=refresh-fixture&state=state-fixture`],
    ['a provider error', '#error=access_denied&state=state-fixture'],
    ['no fragment', ''],
  ])('strips and refuses %s', (_label, fragment) => {
    const { target, location, replaced } = runInlineScript(`/app/auth/callback${fragment}`);

    expect(location.hash).toBe('');
    expect(replaced).toEqual(['/app/auth/callback']);
    expect(takeAuthCallback(target)).toBeNull();
    expect(Reflect.has(target, AUTH_CALLBACK_HANDOFF)).toBe(false);
  });

  it.each(['/', '/app', '/app/auth', '/app/auth/callbackx', '/app/auth/callback/extra', '/w/auth/callback'])(
    'leaves %s untouched',
    (path) => {
      const { target, location, replaced } = runInlineScript(`${path}${FRAGMENT}`);

      expect(replaced).toEqual([]);
      expect(location.hash).toBe(FRAGMENT);
      expect(Reflect.has(target, AUTH_CALLBACK_HANDOFF)).toBe(false);
      expect(takeAuthCallback(target)).toBeNull();
    },
  );
});

describe('takeAuthCallback', () => {
  it('removes a handoff that yields something other than tokens', () => {
    const target = { [AUTH_CALLBACK_HANDOFF]: () => ({ accessToken: 1, refreshToken: 'refresh-fixture', state: '' }) };

    expect(takeAuthCallback(target)).toBeNull();
    expect(Reflect.has(target, AUTH_CALLBACK_HANDOFF)).toBe(false);
  });

  it('removes a handoff that throws', () => {
    const target = {
      [AUTH_CALLBACK_HANDOFF]: () => {
        throw new Error('broken handoff');
      },
    };

    expect(takeAuthCallback(target)).toBeNull();
    expect(Reflect.has(target, AUTH_CALLBACK_HANDOFF)).toBe(false);
  });
});
