import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { errorResponseSchema } from '@workloom/contracts';
import { DEMO_USERS, type ReadinessProbe } from '@workloom/db';
import type { AccessRepository } from '@workloom/domain';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createApp } from '../app.js';
import { loadConfig } from '../config.js';
import { legacyAppLocation, resolveWebDist, shouldServeSpa } from './static-web.js';

// Routing tests over a synthetic dist with distinct landing/SPA documents; the in-memory
// repository and readiness doubles open no database connection.
const LANDING_MARKER = 'data-marker="public-landing"';
const SPA_MARKER = 'data-marker="spa-shell"';
const LANDING_HTML =
  '<!doctype html><html><head><title>Workloom</title><meta name="description" content="Team task tracker">' +
  `<link rel="canonical" href="https://workloom.pavelignatov.com/"></head><body><main ${LANDING_MARKER}>Workloom</main></body></html>`;
const SPA_HTML =
  '<!doctype html><html><head><meta name="robots" content="noindex"></head>' +
  `<body><div id="root" ${SPA_MARKER}></div><script type="module" src="/assets/app-abc.js"></script></body></html>`;
const START_MARKER = 'data-marker="start-page"';
const START_HTML = `<!doctype html><html><head><title>Start</title></head><body><main ${START_MARKER}>Start</main></body></html>`;
const ROBOTS_TXT = 'User-agent: *\nAllow: /\nDisallow: /app\nSitemap: https://workloom.pavelignatov.com/sitemap.xml\n';
const SITEMAP_XML =
  '<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">' +
  '<url><loc>https://workloom.pavelignatov.com/</loc></url></urlset>';

const repository: AccessRepository = {
  async findUser(id) {
    return DEMO_USERS.find((user) => user.id === id) ?? null;
  },
  async findUsers(ids) {
    return DEMO_USERS.filter((user) => ids.includes(user.id));
  },
  async listAccessibleWorkspaces() {
    return [];
  },
  async findWorkspaceAccess() {
    return null;
  },
  async listActiveMemberships() {
    return [];
  },
};
const readiness: ReadinessProbe = { check: async () => ({ ready: true, checks: { database: 'ok', schema: 'ok' } }) };

const HOST = '127.0.0.1:4310';
const ORIGIN = `http://${HOST}`;
const HTML = 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8';

function writeDist(files: { readonly landing: boolean; readonly index: boolean }): string {
  const dist = mkdtempSync(join(tmpdir(), 'workloom-static-web-'));
  mkdirSync(join(dist, 'assets'));
  if (files.landing) writeFileSync(join(dist, 'landing.html'), LANDING_HTML);
  if (files.index) writeFileSync(join(dist, 'index.html'), SPA_HTML);
  writeFileSync(join(dist, 'assets', 'app-abc.js'), 'console.log(1);');
  writeFileSync(join(dist, 'assets', 'app-abc.css'), 'body{}');
  writeFileSync(join(dist, 'start.html'), START_HTML);
  for (const locale of ['ru', 'ja', 'ko', 'es', 'pt-br']) {
    mkdirSync(join(dist, locale), { recursive: true });
    mkdirSync(join(dist, 'start', locale), { recursive: true });
    writeFileSync(join(dist, locale, 'index.html'), `<html lang="${locale}"><main data-locale="${locale}">Localized landing</main></html>`);
    writeFileSync(join(dist, 'start', locale, 'index.html'), `<html lang="${locale}"><main data-locale="${locale}">Localized start</main></html>`);
  }
  writeFileSync(join(dist, 'robots.txt'), ROBOTS_TXT);
  writeFileSync(join(dist, 'sitemap.xml'), SITEMAP_XML);
  return dist;
}

function buildApp(dist: string): Promise<FastifyInstance> {
  const config = loadConfig({ APP_ENV: 'local', AUTH_MODE: 'dev', DATABASE_URL: 'postgres://u:p@127.0.0.1:5432/unused', NODE_ENV: 'production' });
  return createApp(config, { accessRepository: repository, readiness, logger: false, webDistDir: dist });
}

function request(app: FastifyInstance, method: 'GET' | 'HEAD', url: string, accept = HTML) {
  return app.inject({ method, url, headers: { host: HOST, accept } });
}

function expectJsonNotFound(response: LightMyRequestResponse): void {
  expect(response.statusCode).toBe(404);
  expect(response.headers['content-type']).toMatch(/application\/json/);
  expect(response.headers.location).toBeUndefined();
  expect(errorResponseSchema.parse(response.json()).error.code).toBe('NOT_FOUND');
}

function navigation(method: string, url: string, accept?: string): Parameters<typeof shouldServeSpa>[0] {
  return { method, url, headers: accept === undefined ? {} : { accept } };
}

describe('static web navigation helpers', () => {
  it('limits the SPA fallback to extensionless HTML navigations at /app or below', () => {
    for (const url of ['/app', '/app/', '/app/w/abc/tasks?view=board', '/app?x=1']) {
      expect(shouldServeSpa(navigation('GET', url, HTML))).toBe(true);
      expect(shouldServeSpa(navigation('HEAD', url, '*/*'))).toBe(true);
    }
    for (const url of ['/', '/apps', '/application', '/w/abc', '/anything', '/app/main.js', '/api/v1/x', '/healthz/live']) {
      expect(shouldServeSpa(navigation('GET', url, HTML))).toBe(false);
    }
    expect(shouldServeSpa(navigation('POST', '/app/w', HTML))).toBe(false);
    expect(shouldServeSpa(navigation('GET', '/app/w', 'application/json'))).toBe(false);
    expect(shouldServeSpa(navigation('GET', '/app/w'))).toBe(false);
  });

  it('maps only legacy /w HTML navigations to an origin-relative /app location without a fragment', () => {
    expect(legacyAppLocation(navigation('GET', '/w', HTML))).toBe('/app/w');
    expect(legacyAppLocation(navigation('HEAD', '/w/', HTML))).toBe('/app/w/');
    expect(legacyAppLocation(navigation('GET', '/w/abc?a=%2C&b=x+y&&c', HTML))).toBe('/app/w/abc?a=%2C&b=x+y&&c');
    expect(legacyAppLocation(navigation('GET', '/w/abc?a=1#task-7', HTML))).toBe('/app/w/abc?a=1');
    expect(legacyAppLocation(navigation('GET', '/w/abc#task-7', HTML))).toBe('/app/w/abc');
    for (const url of ['/workspace?other', '/wx', '/w.html', '/w/abc/export.csv', '/app/w', '/', '/x/w']) {
      expect(legacyAppLocation(navigation('GET', url, HTML))).toBeNull();
    }
    expect(legacyAppLocation(navigation('POST', '/w/abc', HTML))).toBeNull();
    expect(legacyAppLocation(navigation('GET', '/w/abc', 'application/json'))).toBeNull();
  });
});

describe('web dist resolution', () => {
  const dists: string[] = [];

  afterAll(() => {
    for (const dist of dists) rmSync(dist, { recursive: true, force: true });
  });

  it('requires both the SPA index and the landing document', async () => {
    const both = writeDist({ landing: true, index: true });
    const landingOnly = writeDist({ landing: true, index: false });
    const indexOnly = writeDist({ landing: false, index: true });
    dists.push(both, landingOnly, indexOnly);

    expect(resolveWebDist(both)).toBe(both);
    expect(resolveWebDist(landingOnly)).toBeNull();
    expect(resolveWebDist(indexOnly)).toBeNull();

    for (const dist of [landingOnly, indexOnly]) {
      const app = await buildApp(dist);
      try {
        for (const url of ['/', '/app', '/app/w/abc', '/assets/app-abc.js', '/robots.txt']) {
          expectJsonNotFound(await request(app, 'GET', url));
        }
        expectJsonNotFound(await request(app, 'GET', '/w/abc'));
        expect((await request(app, 'GET', '/healthz/live', 'application/json')).statusCode).toBe(200);
      } finally {
        await app.close();
      }
    }
  });
});

describe('API app routing the landing and /app SPA', () => {
  let app: FastifyInstance;
  let dist: string;

  beforeAll(async () => {
    dist = writeDist({ landing: true, index: true });
    app = await buildApp(dist);
  });

  afterAll(async () => {
    await app.close();
    rmSync(dist, { recursive: true, force: true });
  });

  it('serves only the explicit localized public routes and not their HTML file aliases', async () => {
    for (const locale of ['ru', 'ja', 'ko', 'es', 'pt-br']) {
      for (const path of [`/${locale}`, `/start/${locale}`]) {
        for (const suffix of ['', '/', '?ref=a%20b']) {
          const get = await request(app, 'GET', path + suffix);
          expect(get.statusCode).toBe(200);
          expect(get.body).toContain(`data-locale="${locale}"`);
          expect(get.headers['cache-control']).toBe('no-cache');
          const head = await request(app, 'HEAD', path + suffix);
          expect(head.statusCode).toBe(200);
          expect(head.body).toBe('');
        }
        for (const alias of [`${path}/index.html`, `${path.toUpperCase()}/index.html`]) {
          const response = await request(app, 'GET', alias);
          expect([403, 404]).toContain(response.statusCode);
          expect(response.body).not.toContain('data-locale=');
        }
      }
    }
    for (const path of ['/de', '/start/de', '/ru/app', '/start/ru/anything', '/api/ru']) expectJsonNotFound(await request(app, 'GET', path));
  });

  it('serves the public sign-up chooser at /start and redirects its document alias', async () => {
    for (const url of ['/start', '/start/', '/start?utm_source=landing']) {
      const get = await request(app, 'GET', url);
      expect(get.statusCode).toBe(200);
      expect(get.headers['content-type']).toMatch(/^text\/html/);
      expect(get.headers['x-robots-tag']).toBeUndefined();
      expect(get.body).toContain(START_MARKER);
    }
    const alias = await request(app, 'GET', '/start.html?ref=a%20b');
    expect(alias.statusCode).toBe(308);
    expect(alias.headers.location).toBe('/start?ref=a%20b');
    for (const url of ['/START.HTML', '/%73tart.html', '/assets/../start.html']) expect((await request(app, 'GET', url)).body).not.toContain(START_MARKER);
  });

  it('serves the public landing at / for GET and HEAD without SPA or noindex', async () => {
    for (const url of ['/', '/?utm_source=newsletter&ref=a%20b']) {
      const get = await request(app, 'GET', url);
      expect(get.statusCode).toBe(200);
      expect(get.headers['content-type']).toMatch(/^text\/html/);
      expect(get.headers['cache-control']).toBe('no-cache');
      expect(get.headers['x-robots-tag']).toBeUndefined();
      expect(get.body).toBe(LANDING_HTML);
      expect(get.body).not.toContain(SPA_MARKER);

      const head = await request(app, 'HEAD', url);
      expect(head.statusCode).toBe(200);
      expect(head.headers['content-type']).toMatch(/^text\/html/);
      expect(head.headers['cache-control']).toBe('no-cache');
      expect(head.headers['x-robots-tag']).toBeUndefined();
      expect(Number(head.headers['content-length'])).toBe(Buffer.byteLength(LANDING_HTML));
      expect(head.body).toBe('');
    }
  });

  it('serves the noindex SPA for /app and nested HTML navigations with queries', async () => {
    for (const url of ['/app', '/app/', '/app/w/abc', '/app/w/abc/tasks?view=board&filter=a%2Cb']) {
      for (const accept of [HTML, 'text/html', '*/*']) {
        const get = await request(app, 'GET', url, accept);
        expect(get.statusCode).toBe(200);
        expect(get.headers['content-type']).toMatch(/^text\/html/);
        expect(get.headers['x-robots-tag']).toBe('noindex');
        expect(get.headers['cache-control']).toBe('no-cache');
        expect(get.body).toBe(SPA_HTML);
        expect(get.body).not.toContain(LANDING_MARKER);
      }

      const head = await request(app, 'HEAD', url);
      expect(head.statusCode).toBe(200);
      expect(head.headers['content-type']).toMatch(/^text\/html/);
      expect(head.headers['x-robots-tag']).toBe('noindex');
      expect(head.headers['cache-control']).toBe('no-cache');
      expect(Number(head.headers['content-length'])).toBe(Buffer.byteLength(SPA_HTML));
      expect(head.body).toBe('');
    }
  });

  it('serves the auth callback SPA with no-store while other /app documents keep no-cache', async () => {
    for (const method of ['GET', 'HEAD'] as const) {
      const callback = await request(app, method, '/app/auth/callback?x=1');
      expect(callback.statusCode).toBe(200);
      expect(callback.headers['content-type']).toMatch(/^text\/html/);
      expect(callback.headers['x-robots-tag']).toBe('noindex');
      expect(callback.headers['cache-control']).toBe('no-store');
      expect(callback.headers['referrer-policy']).toBe('no-referrer');
      if (method === 'GET') expect(callback.body).toBe(SPA_HTML);
      else expect(Number(callback.headers['content-length'])).toBe(Buffer.byteLength(SPA_HTML));

      const ordinary = await request(app, method, '/app/w');
      expect(ordinary.statusCode).toBe(200);
      expect(ordinary.headers['cache-control']).toBe('no-cache');
    }
  });

  it('redirects legacy /w HTML navigations to /app with the raw query and no fragment', async () => {
    const query = '?view=board&filter=a%2Cb&q=caf%C3%A9&plus=a+b&empty=&flag&&dup=1&dup=2';
    const cases: ReadonlyArray<readonly [string, string]> = [
      ['/w', '/app/w'],
      ['/w/', '/app/w/'],
      ['/w/abc/tasks', '/app/w/abc/tasks'],
      [`/w/abc/tasks${query}`, `/app/w/abc/tasks${query}`],
      // The fragment never reaches the server; the browser re-applies it to the Location.
      ['/w/abc/tasks?task=7#comment-3', '/app/w/abc/tasks?task=7'],
    ];
    for (const [url, location] of cases) {
      for (const method of ['GET', 'HEAD'] as const) {
        const response = await request(app, method, url);
        expect(response.statusCode).toBe(308);
        expect(response.headers.location).toBe(location);
        expect(response.headers.location).not.toContain('#');
        expect(response.body).not.toContain(SPA_MARKER);
      }
    }
  });

  it('does not redirect or serve HTML for near-miss paths, non-HTML clients or unsafe methods', async () => {
    for (const url of ['/workspace?other', '/wx', '/w.html', '/apps', '/anything', '/x/w/abc', '/app/main.js', '/w/abc/export.csv']) {
      expectJsonNotFound(await request(app, 'GET', url));
    }
    for (const url of ['/w/abc', '/app/w/abc', '/app']) {
      expectJsonNotFound(await request(app, 'GET', url, 'application/json'));
    }

    for (const url of ['/w/abc', '/w', '/app/w/abc', '/index.html', '/landing.html']) {
      const post = await app.inject({ method: 'POST', url, headers: { host: HOST, origin: ORIGIN, accept: HTML } });
      expectJsonNotFound(post);
    }
    const untrusted = await app.inject({ method: 'POST', url: '/w/abc', headers: { host: HOST, accept: HTML } });
    expect(untrusted.statusCode).toBe(403);
    expect(untrusted.headers['content-type']).toMatch(/application\/json/);
    expect(untrusted.json().error.code).toBe('ORIGIN_NOT_ALLOWED');

    const foreignHost = await app.inject({ method: 'GET', url: '/app/w/abc', headers: { host: 'evil.example:4310', accept: HTML } });
    expect(foreignHost.statusCode).toBe(421);
    expect(foreignHost.headers['content-type']).toMatch(/application\/json/);
    expect(foreignHost.body).not.toContain(SPA_MARKER);
  });

  it('redirects the document aliases to their canonical routes, keeping the raw query', async () => {
    const cases: ReadonlyArray<readonly [string, string]> = [
      ['/index.html', '/app'],
      ['/index.html?tab=1&x=a%2Cb', '/app?tab=1&x=a%2Cb'],
      ['/landing.html', '/'],
      ['/landing.html?ref=a%20b', '/?ref=a%20b'],
    ];
    for (const [url, location] of cases) {
      for (const method of ['GET', 'HEAD'] as const) {
        const response = await request(app, method, url);
        expect(response.statusCode).toBe(308);
        expect(response.headers.location).toBe(location);
        expect(response.body).not.toContain(SPA_MARKER);
        expect(response.body).not.toContain(LANDING_MARKER);
      }
    }
  });

  it('never leaks a document through directory, case, encoded or nested aliases', async () => {
    const urls = [
      '/INDEX.HTML',
      '/Index.html',
      '/%69ndex.html',
      '/index.html/',
      '//index.html',
      '/assets/../index.html',
      '/app/%2e%2e/index.html',
      '/app/index.html',
      '/app/landing.html',
      '/assets/index.html',
      '/LANDING.HTML',
      '/%6Canding.html',
      '/landing.html/',
      '/assets/',
      '/assets',
    ];
    for (const url of urls) {
      for (const method of ['GET', 'HEAD'] as const) {
        const response = await request(app, method, url);
        expect([308, 403, 404]).toContain(response.statusCode);
        expect(response.body).not.toContain(SPA_MARKER);
        expect(response.body).not.toContain(LANDING_MARKER);
        if (response.statusCode === 308) {
          expect(['/app', '/']).toContain(response.headers.location);
        } else {
          expect(response.headers['content-type']).toMatch(/application\/json/);
        }
      }
    }
  });

  it('keeps missing assets, API and health JSON while real API and health respond unchanged', async () => {
    for (const url of ['/assets', '/assets/missing', '/assets/missing.js', '/favicon.ico', '/api', '/api/v1/unknown', '/healthz/unknown']) {
      expectJsonNotFound(await request(app, 'GET', url));
      expectJsonNotFound(await request(app, 'GET', url, '*/*'));
    }

    const me = await request(app, 'GET', '/api/v1/me', 'application/json');
    expect(me.statusCode).toBe(200);
    expect(me.headers['content-type']).toMatch(/application\/json/);
    expect(me.headers['cache-control']).toBe('no-store');
    expect(me.json().data.authMode).toBe('dev');

    const live = await request(app, 'GET', '/healthz/live', HTML);
    expect(live.statusCode).toBe(200);
    expect(live.json()).toEqual({ status: 'ok' });
    expect((await request(app, 'GET', '/healthz/ready', HTML)).json()).toEqual({ status: 'ok', checks: { database: 'ok', schema: 'ok' } });
  });

  it('serves hashed assets with their MIME types and immutable caching', async () => {
    for (const method of ['GET', 'HEAD'] as const) {
      const js = await request(app, method, '/assets/app-abc.js', '*/*');
      expect(js.statusCode).toBe(200);
      expect(js.headers['content-type']).toMatch(/javascript/);
      expect(js.headers['cache-control']).toBe('public, max-age=31536000, immutable');
      expect(js.headers['x-robots-tag']).toBeUndefined();

      const css = await request(app, method, '/assets/app-abc.css', 'text/css,*/*;q=0.1');
      expect(css.statusCode).toBe(200);
      expect(css.headers['content-type']).toMatch(/^text\/css/);
      expect(css.headers['cache-control']).toBe('public, max-age=31536000, immutable');
    }
    expect((await request(app, 'GET', '/assets/app-abc.js', '*/*')).body).toBe('console.log(1);');
  });

  it('serves robots.txt and sitemap.xml publicly with their own MIME types and revalidation', async () => {
    for (const method of ['GET', 'HEAD'] as const) {
      const robots = await request(app, method, '/robots.txt', '*/*');
      expect(robots.statusCode).toBe(200);
      expect(robots.headers['content-type']).toMatch(/^text\/plain/);
      expect(robots.headers['cache-control']).toBe('no-cache');
      expect(robots.headers['x-robots-tag']).toBeUndefined();

      const sitemap = await request(app, method, '/sitemap.xml', '*/*');
      expect(sitemap.statusCode).toBe(200);
      expect(sitemap.headers['content-type']).toMatch(/xml/);
      expect(sitemap.headers['cache-control']).toBe('no-cache');
      expect(sitemap.headers['x-robots-tag']).toBeUndefined();
    }
    expect((await request(app, 'GET', '/robots.txt', '*/*')).body).toBe(ROBOTS_TXT);
    expect((await request(app, 'GET', '/sitemap.xml', '*/*')).body).toBe(SITEMAP_XML);
  });
});
