// Real PostgreSQL + real HTTP listener. Requires TEST_DATABASE_URL pointing at a
// loopback "…_test"/"workloom_test…" database; migrations and the synthetic seed are
// applied idempotently (no data is cleared). A missing URL fails the run.
import { FIXTURE_USER_IDS, FIXTURE_WORKSPACE_IDS, parseDatabaseUrl, runMigrations, seedDemoData, createDatabase } from '@workloom/db';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';

const TEST_DATABASE_NAME = /^workloom_test(_[a-z0-9_]+)?$|^[a-z0-9_]+_test$/;

function testDatabaseUrl(): string {
  const info = parseDatabaseUrl(process.env.TEST_DATABASE_URL, { variableName: 'TEST_DATABASE_URL', requireLoopback: true });
  if (!TEST_DATABASE_NAME.test(info.database)) {
    throw new Error('TEST_DATABASE_URL must name a synthetic test database ("workloom_test…" or "…_test").');
  }
  return info.url;
}

describe('API against real PostgreSQL', () => {
  let app: FastifyInstance;
  let baseUrl: string;

  beforeAll(async () => {
    const url = testDatabaseUrl();
    await runMigrations(url, { requireLoopback: true });
    const seedDb = createDatabase(url, { requireLoopback: true, maxConnections: 1 });
    try {
      await seedDemoData(seedDb);
    } finally {
      await seedDb.close();
    }

    const config = loadConfig({ APP_ENV: 'local', AUTH_MODE: 'dev', DATABASE_URL: url, PORT: '0', LOG_LEVEL: 'silent' });
    app = await createApp(config, { webDistDir: null });
    await app.listen({ host: '127.0.0.1', port: 0 });
    const address = app.server.address();
    if (typeof address !== 'object' || address === null) throw new Error('no listen address');
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterAll(async () => {
    await app?.close();
  });

  it('is live and ready with the exact migrated schema', async () => {
    expect((await fetch(`${baseUrl}/healthz/live`)).status).toBe(200);
    const ready = await fetch(`${baseUrl}/healthz/ready`);
    expect(ready.status).toBe(200);
    expect(await ready.json()).toEqual({ status: 'ok', checks: { database: 'ok', schema: 'ok' } });
  });

  it('serves the actor and workspace from the database', async () => {
    const me = (await (await fetch(`${baseUrl}/api/v1/me`)).json()) as { data: { actor: { id: string } } };
    expect(me.data.actor.id).toBe(FIXTURE_USER_IDS.owner);

    const workspaces = (await (await fetch(`${baseUrl}/api/v1/workspaces`)).json()) as { data: { id: string; name: string }[] };
    expect(workspaces.data.map((workspace) => workspace.id)).toContain(FIXTURE_WORKSPACE_IDS.team);
    expect(workspaces.data.map((workspace) => workspace.id)).not.toContain(FIXTURE_WORKSPACE_IDS.outside);

    const members = await fetch(`${baseUrl}/api/v1/workspaces/${FIXTURE_WORKSPACE_IDS.team}/memberships`);
    expect(members.status).toBe(200);
  });

  it('denies the outside workspace exactly like a missing one', async () => {
    const foreign = await fetch(`${baseUrl}/api/v1/workspaces/${FIXTURE_WORKSPACE_IDS.outside}`);
    const missing = await fetch(`${baseUrl}/api/v1/workspaces/5eed0000-0000-4000-8000-0000000002ff`);
    expect(foreign.status).toBe(404);
    expect(missing.status).toBe(404);
    const foreignBody = (await foreign.json()) as { error: unknown };
    const missingBody = (await missing.json()) as { error: unknown };
    expect(foreignBody.error).toEqual(missingBody.error);
  });

  it('switches to the outsider with a same-origin dev session', async () => {
    const response = await fetch(`${baseUrl}/api/v1/dev/session`, {
      method: 'POST',
      headers: { origin: baseUrl, 'x-workloom-dev-tool': '1', 'content-type': 'application/json' },
      body: JSON.stringify({ actorId: FIXTURE_USER_IDS.outsider }),
    });
    expect(response.status).toBe(200);
    const cookie = (response.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
    const workspaces = (await (await fetch(`${baseUrl}/api/v1/workspaces`, { headers: { cookie } })).json()) as { data: { id: string }[] };
    expect(workspaces.data.map((workspace) => workspace.id)).toEqual([FIXTURE_WORKSPACE_IDS.outside]);
  });
});
