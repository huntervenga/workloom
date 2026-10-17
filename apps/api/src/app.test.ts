import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { errorResponseSchema, meResponseSchema, workspaceListResponseSchema } from '@workloom/contracts';
import {
  DEMO_MEMBERSHIPS,
  DEMO_USERS,
  DEMO_WORKSPACES,
  FIXTURE_USER_IDS,
  FIXTURE_WORKSPACE_IDS,
  type ReadinessProbe,
  type ReadinessReport,
} from '@workloom/db';
import type { AccessRepository, MembershipRecord, WorkspaceAccessRecord } from '@workloom/domain';
import type { FastifyInstance, InjectOptions } from 'fastify';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { createApp } from './app.js';
import { loadConfig, type AppConfig } from './config.js';

// HTTP-adapter tests with an in-memory port double built from the demo fixtures.
// They prove routing, guards, envelopes and error mapping only; persistence and
// tenant isolation against PostgreSQL are covered by the real-database suites.
const memberships: MembershipRecord[] = DEMO_MEMBERSHIPS.map((membership) => ({
  ...membership,
  displayName: DEMO_USERS.find((user) => user.id === membership.userId)?.displayName ?? '?',
  state: 'active' as const,
  revision: 1,
}));

function access(record: MembershipRecord): WorkspaceAccessRecord {
  const workspace = DEMO_WORKSPACES.find((candidate) => candidate.id === record.workspaceId);
  if (workspace === undefined) throw new Error('fixture workspace missing');
  return { workspace, membership: record };
}

const repository: AccessRepository = {
  async findUser(id) {
    return DEMO_USERS.find((user) => user.id === id) ?? null;
  },
  async findUsers(ids) {
    return DEMO_USERS.filter((user) => ids.includes(user.id));
  },
  async listAccessibleWorkspaces(userId) {
    return memberships.filter((m) => m.userId === userId && m.state === 'active').map(access);
  },
  async findWorkspaceAccess(workspaceId, userId) {
    const record = memberships.find((m) => m.workspaceId === workspaceId && m.userId === userId);
    return record === undefined ? null : access(record);
  },
  async listActiveMemberships(workspaceId) {
    return memberships.filter((m) => m.workspaceId === workspaceId && m.state === 'active');
  },
};

let readinessReport: ReadinessReport = { ready: true, checks: { database: 'ok', schema: 'ok' } };
const readiness: ReadinessProbe = { check: async () => readinessReport };

const HOST = '127.0.0.1:4310';
const ORIGIN = `http://${HOST}`;

function config(overrides: Record<string, string> = {}): AppConfig {
  return loadConfig({
    APP_ENV: 'local',
    AUTH_MODE: 'dev',
    DATABASE_URL: 'postgres://u:p@127.0.0.1:5432/unused',
    ...overrides,
  });
}

function get(app: FastifyInstance, url: string, headers: Record<string, string> = {}) {
  return app.inject({ method: 'GET', url, headers: { host: HOST, ...headers } });
}

function switchActor(app: FastifyInstance, actorId: string, extra: Partial<InjectOptions> = {}, headers: Record<string, string> = {}) {
  return app.inject({
    method: 'POST',
    url: '/api/v1/dev/session',
    headers: { host: HOST, origin: ORIGIN, 'x-workloom-dev-tool': '1', 'content-type': 'application/json', ...headers },
    payload: JSON.stringify({ actorId }),
    ...extra,
  });
}

describe('API app', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await createApp(config(), { accessRepository: repository, readiness, logger: false, webDistDir: null });
  });

  afterAll(async () => {
    await app.close();
  });

  afterEach(() => {
    readinessReport = { ready: true, checks: { database: 'ok', schema: 'ok' } };
  });

  it('answers liveness and readiness without details', async () => {
    const live = await get(app, '/healthz/live');
    expect(live.statusCode).toBe(200);
    expect(live.json()).toEqual({ status: 'ok' });

    expect((await get(app, '/healthz/ready')).json()).toEqual({ status: 'ok', checks: { database: 'ok', schema: 'ok' } });
    readinessReport = { ready: false, checks: { database: 'failed', schema: 'skipped' }, diagnostic: { error: { type: 'DatabaseError', code: '28P01' } } };
    const notReady = await get(app, '/healthz/ready');
    expect(notReady.statusCode).toBe(503);
    expect(notReady.json()).toEqual({ status: 'unavailable', checks: { database: 'failed', schema: 'skipped' } });
    expect(notReady.body).not.toContain('28P01');
  });

  it('returns the default fixture actor and ignores client identity headers and query', async () => {
    const response = await get(app, `/api/v1/me?userId=${FIXTURE_USER_IDS.outsider}`, {
      'x-user-id': FIXTURE_USER_IDS.outsider,
      'x-actor-id': FIXTURE_USER_IDS.outsider,
    });
    expect(response.statusCode).toBe(200);
    const body = meResponseSchema.parse(response.json());
    expect(body.data).toEqual({ actor: { id: FIXTURE_USER_IDS.owner, displayName: 'Synthetic Owner', kind: 'fixture' }, authMode: 'dev' });
    expect(response.headers['x-request-id']).toBe(body.meta.requestId);
    expect(body.meta.requestId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('generates its own request IDs and never trusts the incoming one', async () => {
    const response = await get(app, '/api/v1/me', { 'x-request-id': 'attacker-controlled' });
    expect(response.headers['x-request-id']).not.toBe('attacker-controlled');
  });

  it('lists only workspaces of the actor and hides foreign ones with an identical 404', async () => {
    const list = workspaceListResponseSchema.parse((await get(app, '/api/v1/workspaces')).json());
    expect(list.data).toEqual([{ id: FIXTURE_WORKSPACE_IDS.team, name: 'Synthetic Team Workspace', role: 'owner', timezone: 'Asia/Nicosia' }]);
    expect(list.meta.nextCursor).toBeNull();

    const foreign = await get(app, `/api/v1/workspaces/${FIXTURE_WORKSPACE_IDS.outside}`);
    const missing = await get(app, '/api/v1/workspaces/5eed0000-0000-4000-8000-0000000002ff');
    expect(foreign.statusCode).toBe(404);
    expect(missing.statusCode).toBe(404);
    expect(foreign.json().error).toEqual(missing.json().error);
    expect(foreign.body).not.toContain('Synthetic Outside');

    const members = await get(app, `/api/v1/workspaces/${FIXTURE_WORKSPACE_IDS.team}/memberships`);
    expect(members.statusCode).toBe(200);
    expect(members.json().data).toHaveLength(6);
    expect((await get(app, `/api/v1/workspaces/${FIXTURE_WORKSPACE_IDS.outside}/memberships`)).statusCode).toBe(404);
  });

  it('validates path parameters', async () => {
    const response = await get(app, '/api/v1/workspaces/not-a-uuid');
    expect(response.statusCode).toBe(400);
    expect(errorResponseSchema.parse(response.json()).error.code).toBe('VALIDATION_FAILED');
  });

  it('returns JSON 404 envelopes for unknown API and health routes', async () => {
    for (const url of ['/api/v1/nope', '/api/v2/workspaces', '/healthz/other', '/anything']) {
      const response = await get(app, url, { accept: 'text/html' });
      expect(response.statusCode).toBe(404);
      expect(response.headers['content-type']).toMatch(/application\/json/);
      expect(errorResponseSchema.parse(response.json()).error.code).toBe('NOT_FOUND');
    }
  });

  it('rejects foreign or missing Host headers (DNS rebinding)', async () => {
    for (const host of ['evil.example:4310', '127.0.0.1:9999', 'localhost', '']) {
      const response = await app.inject({ method: 'GET', url: '/api/v1/me', headers: { host } });
      expect(response.statusCode).toBe(421);
      expect(response.json().error.code).toBe('HOST_NOT_ALLOWED');
      expect(response.headers['x-request-id']).toBeDefined();
    }
    expect((await get(app, '/healthz/live', { host: 'localhost:4310' })).statusCode).toBe(200);
    expect((await get(app, '/healthz/live', { host: '127.0.0.1:4311' })).statusCode).toBe(200);
  });

  it('lists allowlisted fixture actors', async () => {
    const response = await get(app, '/api/v1/dev/actors');
    expect(response.statusCode).toBe(200);
    expect(response.json().data.map((actor: { id: string }) => actor.id)).toEqual(DEMO_USERS.map((user) => user.id));
  });

  it('switches actor via an opaque HttpOnly SameSite=Strict session cookie', async () => {
    const response = await switchActor(app, FIXTURE_USER_IDS.outsider);
    expect(response.statusCode).toBe(200);
    expect(meResponseSchema.parse(response.json()).data.actor.id).toBe(FIXTURE_USER_IDS.outsider);
    const cookie = String(response.headers['set-cookie']);
    expect(cookie).toMatch(/^workloom_dev_session=[A-Za-z0-9_-]{43}; Path=\/; HttpOnly; SameSite=Strict; Max-Age=\d+$/);
    expect(cookie).not.toContain(FIXTURE_USER_IDS.outsider);

    const sessionCookie = cookie.split(';')[0] ?? '';
    const workspaces = await get(app, '/api/v1/workspaces', { cookie: sessionCookie });
    expect(workspaces.json().data.map((w: { id: string }) => w.id)).toEqual([FIXTURE_WORKSPACE_IDS.outside]);
    expect((await get(app, `/api/v1/workspaces/${FIXTURE_WORKSPACE_IDS.team}`, { cookie: sessionCookie })).statusCode).toBe(404);

    // An unknown/forged cookie falls back to the server default, never to a chosen actor.
    const forged = await get(app, '/api/v1/me', { cookie: `workloom_dev_session=${FIXTURE_USER_IDS.outsider}` });
    expect(forged.json().data.actor.id).toBe(FIXTURE_USER_IDS.owner);
  });

  it('refuses actor switching without the dev-tool header, from other origins or without Origin', async () => {
    expect((await switchActor(app, FIXTURE_USER_IDS.viewer, {}, { 'x-workloom-dev-tool': '0' })).statusCode).toBe(403);
    expect((await switchActor(app, FIXTURE_USER_IDS.viewer, {}, { origin: 'http://evil.example' })).statusCode).toBe(403);
    expect((await switchActor(app, FIXTURE_USER_IDS.viewer, {}, { origin: 'null' })).statusCode).toBe(403);
    expect((await switchActor(app, FIXTURE_USER_IDS.viewer, {}, { 'sec-fetch-site': 'cross-site' })).statusCode).toBe(403);
    // Trusted Vite origin, but not the same origin as the addressed Host.
    expect((await switchActor(app, FIXTURE_USER_IDS.viewer, {}, { origin: 'http://127.0.0.1:4311' })).statusCode).toBe(403);

    const noOrigin = await app.inject({
      method: 'POST',
      url: '/api/v1/dev/session',
      headers: { host: HOST, 'x-workloom-dev-tool': '1', 'content-type': 'application/json' },
      payload: JSON.stringify({ actorId: FIXTURE_USER_IDS.viewer }),
    });
    expect(noOrigin.statusCode).toBe(403);
    expect(noOrigin.headers['set-cookie']).toBeUndefined();
  });

  it('accepts switching through the Vite proxy (same origin on the web port)', async () => {
    const response = await switchActor(app, FIXTURE_USER_IDS.viewer, {}, { host: '127.0.0.1:4311', origin: 'http://127.0.0.1:4311' });
    expect(response.statusCode).toBe(200);
  });

  it('rejects non-fixture actors, extra fields and non-JSON bodies', async () => {
    const unknown = await switchActor(app, '5eed0000-0000-4000-8000-000000000999');
    expect(unknown.statusCode).toBe(404);
    const extra = await switchActor(app, FIXTURE_USER_IDS.viewer, {
      payload: JSON.stringify({ actorId: FIXTURE_USER_IDS.viewer, role: 'owner' }),
    });
    expect(extra.statusCode).toBe(400);
    const form = await switchActor(app, FIXTURE_USER_IDS.viewer, {}, { 'content-type': 'application/x-www-form-urlencoded' });
    expect(form.statusCode).toBe(415);
    const broken = await switchActor(app, FIXTURE_USER_IDS.viewer, { payload: '{"actorId":' });
    expect(broken.statusCode).toBe(400);
    expect(errorResponseSchema.safeParse(broken.json()).success).toBe(true);
  });

  it('never emits CORS headers', async () => {
    const response = await get(app, '/api/v1/me', { origin: 'http://evil.example' });
    expect(response.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('maps repository outages to a sanitized 503', async () => {
    const failing = await createApp(config(), {
      accessRepository: {
        ...repository,
        findUser: async () => {
          throw Object.assign(new Error('password authentication failed for user "workloom"'), { code: '28P01' });
        },
      },
      readiness,
      logger: false,
      webDistDir: null,
    });
    try {
      const response = await get(failing, '/api/v1/me');
      expect(response.statusCode).toBe(503);
      expect(response.json().error).toEqual({
        code: 'TEMPORARILY_UNAVAILABLE',
        message: 'The service is temporarily unavailable. Retry the request.',
        retryable: true,
      });
      expect(response.body).not.toContain('workloom"');
    } finally {
      await failing.close();
    }
  });
});

describe('API app serving the web build', () => {
  let app: FastifyInstance;
  let dist: string;

  beforeAll(async () => {
    dist = mkdtempSync(join(tmpdir(), 'workloom-web-dist-'));
    mkdirSync(join(dist, 'assets'));
    writeFileSync(join(dist, 'index.html'), '<!doctype html><div id="root"></div><script type="module" src="/assets/app-abc.js"></script>');
    writeFileSync(join(dist, 'landing.html'), '<!doctype html><main id="landing">Workloom</main>');
    writeFileSync(join(dist, 'assets', 'app-abc.js'), 'console.log(1);');
    writeFileSync(join(dist, 'assets', 'app-abc.css'), 'body{}');
    app = await createApp(config({ NODE_ENV: 'production' }), { accessRepository: repository, readiness, logger: false, webDistDir: dist });
  });

  afterAll(async () => {
    await app.close();
    rmSync(dist, { recursive: true, force: true });
  });

  it('serves the landing at the root and hashed assets with correct content types', async () => {
    const landing = await get(app, '/', { accept: 'text/html' });
    expect(landing.statusCode).toBe(200);
    expect(landing.headers['content-type']).toMatch(/text\/html/);
    expect(landing.headers['cache-control']).toBe('no-cache');
    expect(landing.headers['x-robots-tag']).toBeUndefined();
    expect(landing.body).toContain('<main id="landing">');
    expect(landing.body).not.toContain('<div id="root">');

    const js = await get(app, '/assets/app-abc.js');
    expect(js.statusCode).toBe(200);
    expect(js.headers['content-type']).toMatch(/javascript/);
    expect(js.headers['cache-control']).toContain('immutable');
    expect((await get(app, '/assets/app-abc.css')).headers['content-type']).toMatch(/text\/css/);
  });

  it('falls back to the SPA only for extensionless HTML navigations under /app', async () => {
    const legacy = await get(app, `/w/${FIXTURE_WORKSPACE_IDS.team}/members`, { accept: 'text/html,application/xhtml+xml' });
    expect(legacy.statusCode).toBe(308);
    expect(legacy.headers.location).toBe(`/app/w/${FIXTURE_WORKSPACE_IDS.team}/members`);
    expect(legacy.body).not.toContain('<div id="root">');

    const route = await get(app, `/app/w/${FIXTURE_WORKSPACE_IDS.team}/members`, { accept: 'text/html,application/xhtml+xml' });
    expect(route.statusCode).toBe(200);
    expect(route.headers['content-type']).toMatch(/text\/html/);
    expect(route.headers['x-robots-tag']).toBe('noindex');
    expect(route.headers['cache-control']).toBe('no-cache');
    expect(route.body).toContain('<div id="root">');

    const outsideApp = await get(app, '/anything', { accept: 'text/html' });
    expect(outsideApp.statusCode).toBe(404);
    expect(outsideApp.headers['content-type']).toMatch(/application\/json/);

    const missingAsset = await get(app, '/assets/missing.js', { accept: '*/*' });
    expect(missingAsset.statusCode).toBe(404);
    expect(missingAsset.headers['content-type']).toMatch(/application\/json/);

    const jsonClient = await get(app, '/w/x', { accept: 'application/json' });
    expect(jsonClient.statusCode).toBe(404);

    for (const url of ['/api/v1/unknown', '/api', '/healthz/unknown']) {
      const response = await get(app, url, { accept: 'text/html' });
      expect(response.statusCode).toBe(404);
      expect(response.headers['content-type']).toMatch(/application\/json/);
    }
    expect((await get(app, '/api/v1/me')).statusCode).toBe(200);
  });

  it('does not serve files outside dist', async () => {
    for (const url of ['/../package.json', '/assets/../../package.json', '/%2e%2e/package.json']) {
      const response = await get(app, url, { accept: '*/*' });
      expect(response.statusCode).toBeGreaterThanOrEqual(400);
      expect(response.body).not.toContain('"name"');
    }
  });
});
