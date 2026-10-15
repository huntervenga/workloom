// Black-box acceptance for the built P0 bundle: apps/api/dist/main.js in NODE_ENV=production
// (still APP_ENV=local, AUTH_MODE=dev, loopback) serves the built SPA, its assets and the API
// on one origin over a real PostgreSQL throwaway database. Requires `npm run build` first;
// missing build output fails the file, it never skips.
import { existsSync } from 'node:fs';
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
/** Accept header of a browser navigation; the SPA fallback only answers HTML-accepting requests. */
const NAVIGATION_HEADERS = { accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8' };

function looksLikeHtml(response: RawResponse): boolean {
  return /^\s*<(!doctype|html)\b/i.test(response.text());
}

function attribute(tag: string, name: string): string | undefined {
  const match = new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i').exec(tag);
  return match ? (match[1] ?? match[2] ?? match[3]) : undefined;
}

/** Same-origin script and stylesheet references of the served HTML document. */
function assetReferences(html: string): { scripts: string[]; stylesheets: string[] } {
  const scripts = [...html.matchAll(/<script\b[^>]*>/gi)]
    .map(([tag]) => attribute(tag, 'src'))
    .filter((src): src is string => Boolean(src));
  const stylesheets = [...html.matchAll(/<link\b[^>]*>/gi)]
    .map(([tag]) => tag)
    .filter((tag) => (attribute(tag, 'rel') ?? '').toLowerCase().split(/\s+/).includes('stylesheet'))
    .map((tag) => attribute(tag, 'href'))
    .filter((href): href is string => Boolean(href));
  return { scripts, stylesheets };
}

describe('production build served by the dist API entrypoint', () => {
  let db: ThrowawayDatabase;
  let api: ApiProcess | undefined;

  beforeAll(async () => {
    if (!existsSync(webIndex)) {
      throw new Error(`Missing ${webIndex}. Run \`npm run build\` from the repository root before this test.`);
    }
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

  async function getIndex(path: string): Promise<RawResponse> {
    const response = await rawRequest(server().baseUrl, path, { headers: NAVIGATION_HEADERS });
    expect(response.status, response.text()).toBe(200);
    expect(header(response, 'content-type')).toMatch(/^text\/html\b/i);
    expect(response.text()).toMatch(/^\s*<!doctype html/i);
    return response;
  }

  it('serves the SPA document whose script and stylesheet references all resolve to real assets', async () => {
    const index = await getIndex('/');
    const { scripts, stylesheets } = assetReferences(index.text());
    expect(scripts.length, index.text()).toBeGreaterThan(0);
    expect(stylesheets.length, index.text()).toBeGreaterThan(0);

    const origin = new URL(server().baseUrl).origin;
    const checks = [
      ...scripts.map((ref) => ({ ref, contentType: /^(text|application)\/javascript\b/i })),
      ...stylesheets.map((ref) => ({ ref, contentType: /^text\/css\b/i })),
    ];
    for (const { ref, contentType } of checks) {
      const url = new URL(ref, `${server().baseUrl}/`);
      expect(url.origin, `${ref} must be served by the same origin`).toBe(origin);

      const asset = await rawRequest(server().baseUrl, `${url.pathname}${url.search}`);
      expect(asset.status, `${ref}: ${asset.text().slice(0, 200)}`).toBe(200);
      expect(asset.body.length, ref).toBeGreaterThan(0);
      expect(header(asset, 'content-type'), ref).toMatch(contentType);
      expect(looksLikeHtml(asset), `${ref} must not fall back to the SPA document`).toBe(false);
    }
  });

  it('answers client routes with the same SPA document', async () => {
    const index = await getIndex('/');
    const workspaceRoute = await getIndex(`/w/${FIXTURE_WORKSPACE_IDS.team}`);
    expect(workspaceRoute.text()).toBe(index.text());
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

  it('answers missing assets with 404, not the SPA document', async () => {
    const response = await rawRequest(server().baseUrl, '/assets/definitely-missing.js', { headers: NAVIGATION_HEADERS });
    expect(response.status, response.text().slice(0, 200)).toBe(404);
    expect(header(response, 'content-type')).not.toMatch(/^text\/html\b/i);
    expect(looksLikeHtml(response)).toBe(false);
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
