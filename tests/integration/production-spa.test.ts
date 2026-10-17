// Black-box acceptance for the built P0 bundle: apps/api/dist/main.js in NODE_ENV=production
// (still APP_ENV=local, AUTH_MODE=dev, loopback) serves the built public landing at '/', the
// built SPA under /app, their assets and the API on one origin over a real PostgreSQL throwaway
// database. Requires `npm run build` first; missing build output fails the file, it never skips.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { devActorListResponseSchema, errorResponseSchema, meResponseSchema } from '@workloom/contracts';
import { DEFAULT_DEV_ACTOR_ID, FIXTURE_ACTOR_IDS, FIXTURE_WORKSPACE_IDS } from '@workloom/db/fixtures';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { repoRoot, startApi, type ApiProcess } from './support/api-process.js';
import { migrateAndSeed } from './support/db-cli.js';
import { header, rawRequest, type RawResponse } from './support/http.js';
import { createThrowawayDatabase, type ThrowawayDatabase } from './support/test-database.js';
import { requireTestDatabaseUrl } from './support/test-database-url.js';

// Fails the file at collection time when TEST_DATABASE_URL is missing or unsafe.
requireTestDatabaseUrl();

const webIndex = join(repoRoot, 'apps/web/dist/index.html');
const webLanding = join(repoRoot, 'apps/web/dist/landing.html');
const CANONICAL_LANDING_URL = 'https://workloom.pavelignatov.com/';
/** Accept header of a browser navigation; the SPA fallback only answers HTML-accepting requests. */
const NAVIGATION_HEADERS = { accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8' };

function looksLikeHtml(response: RawResponse): boolean {
  return /^\s*<(!doctype|html)\b/i.test(response.text());
}

function attribute(tag: string, name: string): string | undefined {
  const match = new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i').exec(tag);
  return match ? (match[1] ?? match[2] ?? match[3]) : undefined;
}

function hasToken(value: string | undefined, token: string): boolean {
  return (value ?? '').toLowerCase().split(/\s+/).includes(token);
}

/** Same-origin script and stylesheet references of the served HTML document. */
function assetReferences(html: string): { scripts: string[]; stylesheets: string[] } {
  const scripts = [...html.matchAll(/<script\b[^>]*>/gi)]
    .map(([tag]) => attribute(tag, 'src'))
    .filter((src): src is string => Boolean(src));
  const stylesheets = [...html.matchAll(/<link\b[^>]*>/gi)]
    .map(([tag]) => tag)
    .filter((tag) => hasToken(attribute(tag, 'rel'), 'stylesheet'))
    .map((tag) => attribute(tag, 'href'))
    .filter((href): href is string => Boolean(href));
  return { scripts, stylesheets };
}

function linkHrefs(html: string, rel: string): string[] {
  return [...html.matchAll(/<link\b[^>]*>/gi)]
    .map(([tag]) => tag)
    .filter((tag) => hasToken(attribute(tag, 'rel'), rel))
    .map((tag) => attribute(tag, 'href') ?? '');
}

function metaContents(html: string, name: string): string[] {
  return [...html.matchAll(/<meta\b[^>]*>/gi)]
    .map(([tag]) => tag)
    .filter((tag) => (attribute(tag, 'name') ?? '').toLowerCase() === name)
    .map((tag) => attribute(tag, 'content') ?? '');
}

describe('production build served by the dist API entrypoint', () => {
  let db: ThrowawayDatabase;
  let api: ApiProcess | undefined;
  let builtSpa: string;
  let builtLanding: string;

  beforeAll(async () => {
    for (const file of [webIndex, webLanding]) {
      if (!existsSync(file)) {
        throw new Error(`Missing ${file}. Run \`npm run build\` from the repository root before this test.`);
      }
    }
    builtSpa = readFileSync(webIndex, 'utf8');
    builtLanding = readFileSync(webLanding, 'utf8');
    db = await createThrowawayDatabase('spa');
    await migrateAndSeed(db.url);
    api = await startApi({
      entry: 'dist',
      databaseUrl: db.url,
      env: {
        NODE_ENV: 'production',
        APP_ENV: 'local',
        AUTH_MODE: 'dev',
        HOST: '127.0.0.1',
        DEV_ACTOR_ID: DEFAULT_DEV_ACTOR_ID,
      },
    });
  });

  afterAll(async () => {
    // Stop the API before dropping its database.
    await api?.stop();
    await db?.drop();
  });

  function server(): ApiProcess {
    if (!api) throw new Error('API process did not start.');
    return api;
  }

  async function getHtml(path: string): Promise<RawResponse> {
    const response = await rawRequest(server().baseUrl, path, { headers: NAVIGATION_HEADERS });
    expect(response.status, response.text()).toBe(200);
    expect(header(response, 'content-type')).toMatch(/^text\/html\b/i);
    expect(response.text()).toMatch(/^\s*<!doctype html/i);
    return response;
  }

  async function getSpa(path: string): Promise<RawResponse> {
    const response = await getHtml(path);
    expect(response.text(), path).toBe(builtSpa);
    expect(header(response, 'x-robots-tag'), path).toMatch(/\bnoindex\b/i);
    expect(header(response, 'cache-control'), path).toMatch(/\bno-cache\b/i);
    return response;
  }

  /** Every reference must be a same-origin, root /assets file with its real MIME type and immutable caching. */
  async function expectAssetsServed(html: string): Promise<void> {
    const { scripts, stylesheets } = assetReferences(html);
    const origin = new URL(server().baseUrl).origin;
    const checks = [
      ...scripts.map((ref) => ({ ref, contentType: /^(text|application)\/javascript\b/i })),
      ...stylesheets.map((ref) => ({ ref, contentType: /^text\/css\b/i })),
    ];
    for (const { ref, contentType } of checks) {
      const url = new URL(ref, `${server().baseUrl}/app/w/nested`);
      expect(url.origin, `${ref} must be served by the same origin`).toBe(origin);
      expect(url.pathname, `${ref} must resolve under the root /assets/ path from any route`).toMatch(/^\/assets\//);

      const asset = await rawRequest(server().baseUrl, `${url.pathname}${url.search}`);
      expect(asset.status, `${ref}: ${asset.text().slice(0, 200)}`).toBe(200);
      expect(asset.body.length, ref).toBeGreaterThan(0);
      expect(header(asset, 'content-type'), ref).toMatch(contentType);
      expect(header(asset, 'cache-control'), ref).toMatch(/\bmax-age=31536000\b/);
      expect(header(asset, 'cache-control'), ref).toMatch(/\bimmutable\b/);
      expect(looksLikeHtml(asset), `${ref} must not fall back to an HTML document`).toBe(false);
    }
  }

  async function expectJsonNotFound(path: string): Promise<void> {
    const response = await rawRequest(server().baseUrl, path, { headers: NAVIGATION_HEADERS });
    expect(response.status, `${path}: ${response.text().slice(0, 200)}`).toBe(404);
    expect(header(response, 'content-type'), path).toMatch(/^application\/json\b/i);
    expect(looksLikeHtml(response), path).toBe(false);
    const body = errorResponseSchema.parse(response.json());
    expect(body.meta.requestId.trim()).not.toBe('');
  }

  it('serves the built SPA document at /app whose script and stylesheet references all resolve to real assets', async () => {
    const spa = await getSpa('/app');
    const { scripts, stylesheets } = assetReferences(spa.text());
    expect(scripts.length, spa.text()).toBeGreaterThan(0);
    expect(stylesheets.length, spa.text()).toBeGreaterThan(0);
    await expectAssetsServed(spa.text());
  });

  it('serves the built, indexable prerendered landing at / distinct from the SPA', async () => {
    const landing = await getHtml('/');
    const html = landing.text();
    expect(html).toBe(builtLanding);
    expect(html).not.toBe(builtSpa);
    expect(header(landing, 'x-robots-tag')).not.toMatch(/noindex/i);
    for (const robots of metaContents(html, 'robots')) expect(robots).not.toMatch(/noindex/i);

    const heading = /<main\b[^>]*>[\s\S]*?<h1\b[^>]*>([\s\S]*?)<\/h1>[\s\S]*?<\/main>/i.exec(html);
    expect(heading, 'landing must contain prerendered <main> with an <h1>').not.toBeNull();
    expect(heading?.[1]?.replace(/<[^>]*>/g, '').trim()).not.toBe('');
    expect(linkHrefs(html, 'canonical')).toEqual([CANONICAL_LANDING_URL]);
    const descriptions = metaContents(html, 'description');
    expect(descriptions).toHaveLength(1);
    expect(descriptions[0]?.trim()).not.toBe('');

    await expectAssetsServed(html);

    const head = await rawRequest(server().baseUrl, '/', { method: 'HEAD', headers: NAVIGATION_HEADERS });
    expect(head.status).toBe(200);
    expect(header(head, 'content-type')).toMatch(/^text\/html\b/i);
    expect(head.body.length).toBe(0);
  });

  it('answers client routes under /app with the same SPA document', async () => {
    await getSpa(`/app/w/${FIXTURE_WORKSPACE_IDS.team}`);
  });

  it('redirects legacy /w navigations to /app with the raw query preserved and no fragment or body', async () => {
    const query = '?view=board&q=a%2Cb&plus=a+b&dup=1&dup=2';
    const path = `/w/${FIXTURE_WORKSPACE_IDS.team}`;
    for (const method of ['GET', 'HEAD']) {
      const response = await rawRequest(server().baseUrl, `${path}${query}`, { method, headers: NAVIGATION_HEADERS });
      expect(response.status, `${method}: ${response.text().slice(0, 200)}`).toBe(308);
      expect(header(response, 'location'), method).toBe(`/app${path}${query}`);
      expect(header(response, 'location'), method).not.toContain('#');
      expect(looksLikeHtml(response), method).toBe(false);
      expect(response.text(), method).not.toContain(builtSpa);
    }

    const bare = await rawRequest(server().baseUrl, '/w', { headers: NAVIGATION_HEADERS });
    expect(bare.status).toBe(308);
    expect(header(bare, 'location')).toBe('/app/w');
  });

  it('redirects direct document file requests to their canonical routes', async () => {
    const index = await rawRequest(server().baseUrl, '/index.html', { headers: NAVIGATION_HEADERS });
    expect(index.status, index.text().slice(0, 200)).toBe(308);
    expect(header(index, 'location')).toBe('/app');

    const landing = await rawRequest(server().baseUrl, '/landing.html', { headers: NAVIGATION_HEADERS });
    expect(landing.status, landing.text().slice(0, 200)).toBe(308);
    expect(header(landing, 'location')).toBe('/');
  });

  it('answers unknown HTML navigations outside /app with a JSON 404, not the SPA or landing', async () => {
    for (const path of ['/does-not-exist', '/application', '/wiki', '/assets/definitely-missing']) {
      await expectJsonNotFound(path);
    }
  });

  it('answers unknown API routes with a structured JSON 404, not the SPA document', async () => {
    const response = await rawRequest(server().baseUrl, '/api/v1/does-not-exist', { headers: NAVIGATION_HEADERS });
    expect(response.status, response.text()).toBe(404);
    expect(header(response, 'content-type')).toMatch(/^application\/json\b/i);
    expect(looksLikeHtml(response)).toBe(false);
    const body = errorResponseSchema.parse(response.json());
    expect(body.meta.requestId.trim()).not.toBe('');
    const echoed = header(response, 'x-request-id');
    if (echoed) expect(echoed).toBe(body.meta.requestId);
  });

  it('answers missing assets with 404, not an HTML document', async () => {
    for (const path of ['/assets/definitely-missing.js', '/app/definitely-missing.js']) {
      const response = await rawRequest(server().baseUrl, path, { headers: NAVIGATION_HEADERS });
      expect(response.status, `${path}: ${response.text().slice(0, 200)}`).toBe(404);
      expect(header(response, 'content-type'), path).not.toMatch(/^text\/html\b/i);
      expect(looksLikeHtml(response), path).toBe(false);
    }
  });

  it('serves GET /api/v1/me from PostgreSQL for the configured actor', async () => {
    const [row] = await db.sql<{ display_name: string }[]>`
      select display_name from users where id = ${DEFAULT_DEV_ACTOR_ID}`;
    expect(row).toBeDefined();

    const response = await rawRequest(server().baseUrl, '/api/v1/me');
    expect(response.status, response.text()).toBe(200);
    expect(header(response, 'content-type')).toMatch(/^application\/json\b/i);
    const me = meResponseSchema.parse(response.json());
    expect(me.data).toEqual({
      actor: { id: DEFAULT_DEV_ACTOR_ID, displayName: row?.display_name, kind: 'fixture' },
      authMode: 'dev',
    });
    expect(me.meta.requestId.trim()).not.toBe('');
  });

  // NODE_ENV=production only selects the optimized build; it is not a deployment and not an
  // authentication mode. Dev routes follow APP_ENV=local + AUTH_MODE=dev, so this loopback-only
  // process keeps them; a non-local APP_ENV is refused at startup instead.
  it('keeps the local dev actor list in the optimized local build, limited to the fixture allowlist', async () => {
    const response = await rawRequest(server().baseUrl, '/api/v1/dev/actors');
    expect(response.status, response.text()).toBe(200);
    expect(header(response, 'content-type')).toMatch(/^application\/json\b/i);
    const actors = devActorListResponseSchema.parse(response.json());
    expect(actors.data.map((actor) => actor.id).sort()).toEqual([...FIXTURE_ACTOR_IDS].sort());
    for (const actor of actors.data) expect(actor.kind).toBe('fixture');
  });
});
