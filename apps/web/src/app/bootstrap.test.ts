import { describe, expect, it, vi } from 'vitest';
import { getAppEntry, runBootstrap, type BootstrapLocation } from './bootstrap';

const ORIGIN = 'https://workloom.test';

// Builds the location the browser would expose for a real URL, recording replace() calls.
function locationFor(href: string): BootstrapLocation & { replaced: string[] } {
  const url = new URL(href, ORIGIN);
  const replaced: string[] = [];
  return {
    pathname: url.pathname,
    search: url.search,
    hash: url.hash,
    replaced,
    replace(next: string) {
      replaced.push(next);
    },
  };
}

function recordingLoader(): { load: () => Promise<void>; calls: number } {
  const loader = {
    calls: 0,
    load: async () => {
      loader.calls += 1;
    },
  };
  return loader;
}

describe('getAppEntry', () => {
  it.each(['/app', '/app/', '/app/w/team', '/app/w/team/daily?d=2026-10-17#top'])(
    'treats %s as the app',
    (href) => {
      expect(getAppEntry(locationFor(href))).toEqual({ kind: 'app' });
    },
  );

  it.each([
    ['/w', '/app/w'],
    ['/w/', '/app/w/'],
    ['/w/team', '/app/w/team'],
    ['/w/team/daily?d=2026-10-17&view=graph#entry-3', '/app/w/team/daily?d=2026-10-17&view=graph#entry-3'],
    ['/w/caf%C3%A9/notes?q=a%20b%26c#sec%20one', '/app/w/caf%C3%A9/notes?q=a%20b%26c#sec%20one'],
    ['/w/café', '/app/w/caf%C3%A9'],
  ])('forwards legacy %s to %s', (href, to) => {
    expect(getAppEntry(locationFor(href))).toEqual({ kind: 'redirect', to });
  });

  it.each(['/w//evil.example/x', '/w/%2F%2Fevil.example', '/w/team?next=https://evil.example#//evil.example'])(
    'keeps the redirect for %s on this origin',
    (href) => {
      const entry = getAppEntry(locationFor(href));
      expect(entry.kind).toBe('redirect');
      if (entry.kind !== 'redirect') return;
      const target = new URL(entry.to, ORIGIN);
      expect(target.origin).toBe(ORIGIN);
      expect(target.pathname.startsWith('/app/w')).toBe(true);
    },
  );

  it.each(['/', '/?ref=mail', '/pricing', '/apple', '/application', '/wiki', '/w-old', '/w%2Fteam'])(
    'leaves %s public',
    (href) => {
      expect(getAppEntry(locationFor(href))).toEqual({ kind: 'public' });
    },
  );

  it.each(['/app/auth/callback', '/app/auth/callback/', '/app/auth/callback?from=idp'])(
    'treats %s as the sign-in callback',
    (href) => {
      expect(getAppEntry(locationFor(href))).toEqual({ kind: 'callback' });
    },
  );

  it.each(['/app/auth', '/app/auth/callbackx', '/app/auth/callback/extra', '/app/auth/callback//', '/app/auth/CALLBACK'])(
    'keeps lookalike %s in the ordinary app',
    (href) => {
      expect(getAppEntry(locationFor(href))).toEqual({ kind: 'app' });
    },
  );

  it.each(['/auth/callback', '/callback'])('leaves %s public', (href) => {
    expect(getAppEntry(locationFor(href))).toEqual({ kind: 'public' });
  });
});

describe('runBootstrap', () => {
  it('loads the app for /app and resolves after it has mounted', async () => {
    const location = locationFor('/app');
    const loader = recordingLoader();

    await expect(runBootstrap(location, loader.load)).resolves.toEqual({ kind: 'app' });

    expect(loader.calls).toBe(1);
    expect(location.replaced).toEqual([]);
  });

  it('loads the app for nested /app paths', async () => {
    const location = locationFor('/app/w/team/daily?d=2026-10-17#top');
    const loader = recordingLoader();

    await runBootstrap(location, loader.load);

    expect(loader.calls).toBe(1);
    expect(location.replaced).toEqual([]);
  });

  it('propagates a failed app load', async () => {
    const location = locationFor('/app');

    await expect(
      runBootstrap(location, () => Promise.reject(new Error('chunk failed'))),
    ).rejects.toThrow('chunk failed');
  });

  it('replaces legacy links with the /app address and does not load the app', async () => {
    const location = locationFor('/w/caf%C3%A9?q=a%20b#sec');
    const loader = recordingLoader();

    await expect(runBootstrap(location, loader.load)).resolves.toEqual({
      kind: 'redirect',
      to: '/app/w/caf%C3%A9?q=a%20b#sec',
    });

    expect(location.replaced).toEqual(['/app/w/caf%C3%A9?q=a%20b#sec']);
    expect(loader.calls).toBe(0);
  });

  it.each(['/', '/pricing', '/no/such/page'])(
    'does nothing on public path %s: no app load, no redirect, no request',
    async (href) => {
      const fetchSpy = vi.fn();
      vi.stubGlobal('fetch', fetchSpy);
      const location = locationFor(href);
      const loader = recordingLoader();

      await expect(runBootstrap(location, loader.load)).resolves.toEqual({ kind: 'public' });

      expect(loader.calls).toBe(0);
      expect(location.replaced).toEqual([]);
      expect(fetchSpy).not.toHaveBeenCalled();
    },
  );

  it.each(['/app/auth/callback', '/app/auth/callback/'])(
    'loads only the callback entry for %s, never the app',
    async (href) => {
      const location = locationFor(href);
      const app = recordingLoader();
      const callback = recordingLoader();

      await expect(runBootstrap(location, app.load, callback.load)).resolves.toEqual({ kind: 'callback' });

      expect(callback.calls).toBe(1);
      expect(app.calls).toBe(0);
      expect(location.replaced).toEqual([]);
    },
  );

  it('loads nothing at the callback for callers without a callback loader', async () => {
    const app = recordingLoader();

    await expect(runBootstrap(locationFor('/app/auth/callback'), app.load)).resolves.toEqual({ kind: 'callback' });

    expect(app.calls).toBe(0);
  });

  it('keeps app paths on the app loader when a callback loader is given', async () => {
    const app = recordingLoader();
    const callback = recordingLoader();

    await runBootstrap(locationFor('/app/w/team?d=2026-10-17#top'), app.load, callback.load);

    expect(app.calls).toBe(1);
    expect(callback.calls).toBe(0);
  });

  it.each(['/', '/pricing', '/w/team'])(
    'never loads the callback entry or sends a request on %s',
    async (href) => {
      const fetchSpy = vi.fn();
      vi.stubGlobal('fetch', fetchSpy);
      const app = recordingLoader();
      const callback = recordingLoader();

      await runBootstrap(locationFor(href), app.load, callback.load);

      expect(callback.calls).toBe(0);
      expect(app.calls).toBe(0);
      expect(fetchSpy).not.toHaveBeenCalled();
    },
  );
});
