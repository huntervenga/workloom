// Black-box HTTP acceptance for the P0 workspace API: the real API source entrypoint on a
// real PostgreSQL throwaway database with the demo seed. Identity comes from server config
// (DEV_ACTOR_ID) or a same-origin dev session cookie only; forged headers, query parameters
// and cross-origin dev sessions must not change it, and hidden workspaces answer exactly
// like unknown ones.
import { randomUUID } from 'node:crypto';

import {
  devActorListResponseSchema,
  errorResponseSchema,
  meResponseSchema,
  membershipListResponseSchema,
  workspaceListResponseSchema,
  workspaceResponseSchema,
  type ErrorResponseDto,
} from '@workloom/contracts';
import {
  DEFAULT_DEV_ACTOR_ID,
  DEMO_MEMBERSHIPS,
  DEMO_USERS,
  DEMO_WORKSPACES,
  FIXTURE_ACTOR_IDS,
  FIXTURE_MEMBERSHIP_IDS,
  FIXTURE_USER_IDS,
  FIXTURE_WORKSPACE_IDS,
} from '@workloom/db/fixtures';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { startApi, type ApiProcess } from './support/api-process.js';
import { migrateAndSeed } from './support/db-cli.js';
import { header, rawRequest, type RawResponse } from './support/http.js';
import { createThrowawayDatabase, type ThrowawayDatabase } from './support/test-database.js';
import { requireTestDatabaseUrl } from './support/test-database-url.js';

// Fails the file at collection time when TEST_DATABASE_URL is missing or unsafe.
requireTestDatabaseUrl();

const TEAM_ID = FIXTURE_WORKSPACE_IDS.team;
const OUTSIDE_ID = FIXTURE_WORKSPACE_IDS.outside;
const OWNER_ID = FIXTURE_USER_IDS.owner;
const OUTSIDER_ID = FIXTURE_USER_IDS.outsider;
const EVIL_ORIGIN = 'https://evil.invalid';

const teamWorkspace = fixture(DEMO_WORKSPACES.find((workspace) => workspace.id === TEAM_ID));
const outsideWorkspace = fixture(DEMO_WORKSPACES.find((workspace) => workspace.id === OUTSIDE_ID));
const ownerUser = fixture(DEMO_USERS.find((user) => user.id === OWNER_ID));
const outsiderUser = fixture(DEMO_USERS.find((user) => user.id === OUTSIDER_ID));
const teamMemberships = DEMO_MEMBERSHIPS.filter((membership) => membership.workspaceId === TEAM_ID);
const outsideMemberships = DEMO_MEMBERSHIPS.filter((membership) => membership.workspaceId === OUTSIDE_ID);
const teamUserIds = new Set(teamMemberships.map((membership) => membership.userId));
const teamUsers = DEMO_USERS.filter((user) => teamUserIds.has(user.id));

/** Strings that must never appear in a response the owner gets for the outside workspace. */
const outsideSecrets = [
  outsideWorkspace.name,
  OUTSIDER_ID,
  outsiderUser.displayName,
  ...outsideMemberships.map((membership) => membership.id),
];
/** Strings that must never appear in a response the outsider gets for the team workspace. */
const teamSecrets = [
  teamWorkspace.name,
  ...teamMemberships.map((membership) => membership.id),
  ...teamUsers.flatMap((user) => [user.id, user.displayName]),
];

function fixture<T>(value: T | undefined): T {
  if (value === undefined) throw new Error('Demo fixture constant missing from @workloom/db/fixtures.');
  return value;
}

interface Parser<T> {
  parse(value: unknown): T;
}

function get(api: ApiProcess, path: string, headers?: Record<string, string>): Promise<RawResponse> {
  return rawRequest(api.baseUrl, path, { headers });
}

function jsonOf(response: RawResponse): unknown {
  expect(header(response, 'content-type'), response.text()).toMatch(/^application\/json\b/i);
  return response.json();
}

function expectRequestId(response: RawResponse, requestId: string): void {
  expect(requestId.trim()).not.toBe('');
  const echoed = header(response, 'x-request-id');
  if (echoed) expect(echoed).toBe(requestId);
}

function expectOk<T extends { meta: { requestId: string } }>(response: RawResponse, schema: Parser<T>): T {
  expect(response.status, response.text()).toBe(200);
  const body = schema.parse(jsonOf(response));
  expectRequestId(response, body.meta.requestId);
  return body;
}

function expectError(response: RawResponse, status?: number): ErrorResponseDto {
  if (status === undefined) {
    expect(response.status, response.text()).toBeGreaterThanOrEqual(400);
  } else {
    expect(response.status, response.text()).toBe(status);
  }
  const body = errorResponseSchema.parse(jsonOf(response));
  expectRequestId(response, body.meta.requestId);
  return body;
}

function expectNotFound(response: RawResponse, hidden: readonly string[]): ErrorResponseDto {
  const body = expectError(response, 404);
  expect(body.error.code).toBe('NOT_FOUND');
  const text = response.text();
  for (const value of hidden) expect(text).not.toContain(value);
  return body;
}

function expectNoWildcardCors(response: RawResponse): void {
  const allowOrigin = header(response, 'access-control-allow-origin');
  expect(allowOrigin).not.toBe('*');
  expect(allowOrigin).not.toBe(EVIL_ORIGIN);
}

/** Health bodies are not enveloped: exactly the expected status/checks, without credentials, workspace or user data. */
function expectSafeHealthBody(response: RawResponse, expected: unknown, databaseUrl: string): void {
  expect(jsonOf(response)).toEqual(expected);

  const text = response.text();
  const url = new URL(databaseUrl);
  expect(text).not.toContain(databaseUrl);
  expect(text).not.toMatch(/postgres(ql)?:\/\//i);
  if (url.password) expect(text).not.toContain(decodeURIComponent(url.password));
  for (const workspace of DEMO_WORKSPACES) expect(text).not.toContain(workspace.name);
  for (const user of DEMO_USERS) {
    expect(text).not.toContain(user.id);
    expect(text).not.toContain(user.displayName);
  }
}

async function expectMeIs(api: ApiProcess, actorId: string): Promise<void> {
  const me = expectOk(await get(api, '/api/v1/me'), meResponseSchema);
  expect(me.data.actor.id).toBe(actorId);
}

describe('workspace HTTP API with the server-configured owner actor', () => {
  let db: ThrowawayDatabase;
  let api: ApiProcess | undefined;

  beforeAll(async () => {
    db = await createThrowawayDatabase('http');
    await migrateAndSeed(db.url);
    api = await startApi({ entry: 'source', databaseUrl: db.url, env: { DEV_ACTOR_ID: DEFAULT_DEV_ACTOR_ID } });
  });

  afterAll(async () => {
    // Stop the API before dropping its database.
    await api?.stop();
    await db?.drop();
  });

  function owner(): ApiProcess {
    if (!api) throw new Error('API process did not start.');
    return api;
  }

  it('reports liveness and readiness with exact safe JSON bodies', async () => {
    const live = await get(owner(), '/healthz/live');
    expect(live.status, live.text()).toBe(200);
    expectSafeHealthBody(live, { status: 'ok' }, db.url);

    const ready = await get(owner(), '/healthz/ready');
    expect(ready.status, ready.text()).toBe(200);
    expectSafeHealthBody(ready, { status: 'ok', checks: { database: 'ok', schema: 'ok' } }, db.url);
  });

  it('GET /api/v1/me returns exactly the server-configured fixture actor', async () => {
    const [row] = await db.sql<{ display_name: string; kind: string; avatar_url: string | null }[]>`
      select display_name, kind, avatar_url from users where id = ${DEFAULT_DEV_ACTOR_ID}`;
    expect(row).toBeDefined();
    expect(row?.avatar_url).toBeNull();
    expect(row?.kind).toBe('fixture');

    const me = expectOk(await get(owner(), '/api/v1/me'), meResponseSchema);
    expect(me.data).toEqual({
      actor: { id: DEFAULT_DEV_ACTOR_ID, displayName: row?.display_name, kind: 'fixture', avatarUrl: row?.avatar_url },
      authMode: 'dev',
    });
    expect(me.data.actor.displayName).toBe(ownerUser.displayName);
  });

  it('lists only the team workspace, with the owner role', async () => {
    const response = await get(owner(), '/api/v1/workspaces');
    const list = expectOk(response, workspaceListResponseSchema);
    expect(list.data.map((workspace) => ({ id: workspace.id, name: workspace.name, role: workspace.role }))).toEqual([
      { id: TEAM_ID, name: teamWorkspace.name, role: 'owner' },
    ]);
    for (const value of outsideSecrets) expect(response.text()).not.toContain(value);
  });

  it('reads the team workspace and its six active memberships from PostgreSQL', async () => {
    const detail = expectOk(await get(owner(), `/api/v1/workspaces/${TEAM_ID}`), workspaceResponseSchema);
    expect(detail.data).toMatchObject({ id: TEAM_ID, name: teamWorkspace.name, role: 'owner', timezone: teamWorkspace.timezone });

    const rows = await db.sql<{ id: string; workspace_id: string; user_id: string; display_name: string; role: string; avatar_url: string | null }[]>`
      select m.id::text as id, m.workspace_id::text as workspace_id, m.user_id::text as user_id, u.display_name, m.role::text as role, u.avatar_url
      from memberships m join users u on u.id = m.user_id
      where m.workspace_id = ${TEAM_ID} and m.state = 'active'`;
    expect(rows).toHaveLength(6);
    for (const row of rows) expect(row.avatar_url).toBeNull();
    expect(rows.map((row) => row.id).sort()).toEqual(teamMemberships.map((membership) => membership.id).sort());

    const members = expectOk(
      await get(owner(), `/api/v1/workspaces/${TEAM_ID}/memberships`),
      membershipListResponseSchema,
    );
    expect(members.data).toHaveLength(6);
    const byId = (a: { id: string }, b: { id: string }) => a.id.localeCompare(b.id);
    expect([...members.data].sort(byId)).toEqual(
      rows
        .map((row) => ({
          id: row.id,
          workspaceId: row.workspace_id,
          userId: row.user_id,
          displayName: row.display_name,
          avatarUrl: row.avatar_url,
          role: row.role,
        }))
        .sort(byId),
    );
    for (const value of outsideSecrets) expect(JSON.stringify(members)).not.toContain(value);
  });

  it('resolves an uppercased workspace UUID to the same workspace and six memberships', async () => {
    // Regression: the domain compared raw path IDs, so an uppercased UUID answered 200 with [].
    const upperTeamId = TEAM_ID.toUpperCase();
    expect(upperTeamId).not.toBe(TEAM_ID);

    const detail = expectOk(await get(owner(), `/api/v1/workspaces/${TEAM_ID}`), workspaceResponseSchema);
    const upperDetail = expectOk(await get(owner(), `/api/v1/workspaces/${upperTeamId}`), workspaceResponseSchema);
    expect(upperDetail.data).toEqual(detail.data);
    expect(upperDetail.data.id).toBe(TEAM_ID);

    const byId = (a: { id: string }, b: { id: string }) => a.id.localeCompare(b.id);
    const members = expectOk(
      await get(owner(), `/api/v1/workspaces/${TEAM_ID}/memberships`),
      membershipListResponseSchema,
    );
    const upperMembers = expectOk(
      await get(owner(), `/api/v1/workspaces/${upperTeamId}/memberships`),
      membershipListResponseSchema,
    );
    expect(upperMembers.data).toHaveLength(6);
    expect([...upperMembers.data].sort(byId)).toEqual([...members.data].sort(byId));
    expect(upperMembers.data.map((membership) => membership.id).sort()).toEqual(
      teamMemberships.map((membership) => membership.id).sort(),
    );
    for (const membership of upperMembers.data) {
      expect(membership.workspaceId).toBe(TEAM_ID);
      expect(membership.id).toBe(membership.id.toLowerCase());
      expect(membership.userId).toBe(membership.userId.toLowerCase());
    }
    expect(upperMembers.data.map((membership) => membership.userId).sort()).toEqual([...teamUserIds].sort());
  });

  it('hides the outside workspace behind the same 404 as an unknown workspace', async () => {
    const hiddenDetail = expectNotFound(await get(owner(), `/api/v1/workspaces/${OUTSIDE_ID}`), outsideSecrets);
    const hiddenMembers = expectNotFound(
      await get(owner(), `/api/v1/workspaces/${OUTSIDE_ID}/memberships`),
      outsideSecrets,
    );

    const unknownId = randomUUID();
    const unknownDetail = expectNotFound(await get(owner(), `/api/v1/workspaces/${unknownId}`), outsideSecrets);
    const unknownMembers = expectNotFound(
      await get(owner(), `/api/v1/workspaces/${unknownId}/memberships`),
      outsideSecrets,
    );

    expect({ code: hiddenDetail.error.code, message: hiddenDetail.error.message }).toEqual({
      code: unknownDetail.error.code,
      message: unknownDetail.error.message,
    });
    expect({ code: hiddenMembers.error.code, message: hiddenMembers.error.message }).toEqual({
      code: unknownMembers.error.code,
      message: unknownMembers.error.message,
    });
    expect(hiddenDetail.meta.requestId).not.toBe(unknownDetail.meta.requestId);
  });

  it('ignores forged actor headers and query parameters on regular endpoints', async () => {
    const forgedHeaders = {
      'x-user-id': OUTSIDER_ID,
      'x-actor-id': OUTSIDER_ID,
      'x-workloom-actor-id': OUTSIDER_ID,
    };
    const forgedQuery = `actorId=${OUTSIDER_ID}&userId=${OUTSIDER_ID}&actor=${OUTSIDER_ID}`;

    for (const path of ['/api/v1/me', `/api/v1/me?${forgedQuery}`]) {
      const me = expectOk(await get(owner(), path, forgedHeaders), meResponseSchema);
      expect(me.data.actor.id).toBe(OWNER_ID);
    }

    for (const path of ['/api/v1/workspaces', `/api/v1/workspaces?${forgedQuery}`]) {
      const list = expectOk(await get(owner(), path, forgedHeaders), workspaceListResponseSchema);
      expect(list.data.map((workspace) => workspace.id)).toEqual([TEAM_ID]);
    }

    for (const path of [`/api/v1/workspaces/${OUTSIDE_ID}`, `/api/v1/workspaces/${OUTSIDE_ID}?${forgedQuery}`]) {
      expectNotFound(await get(owner(), path, forgedHeaders), outsideSecrets);
    }
    expectNotFound(
      await get(owner(), `/api/v1/workspaces/${OUTSIDE_ID}/memberships?${forgedQuery}`, forgedHeaders),
      outsideSecrets,
    );
  });

  describe('local developer tooling guard', () => {
    it('lists only allowlisted fixture actors to a loopback same-origin request', async () => {
      const actors = expectOk(await get(owner(), '/api/v1/dev/actors'), devActorListResponseSchema);
      expect(actors.data.map((actor) => actor.id).sort()).toEqual([...FIXTURE_ACTOR_IDS].sort());
      for (const actor of actors.data) {
        expect(actor).toEqual(DEMO_USERS.find((user) => user.id === actor.id));
      }
    });

    it('refuses a cross-origin dev session switch with 403 and keeps the actor', async () => {
      const response = await rawRequest(owner().baseUrl, '/api/v1/dev/session', {
        method: 'POST',
        headers: {
          origin: EVIL_ORIGIN,
          'content-type': 'application/json',
          'x-workloom-dev-tool': '1',
        },
        body: JSON.stringify({ actorId: OUTSIDER_ID }),
      });
      expect(expectError(response, 403).error.code).toBe('ORIGIN_NOT_ALLOWED');
      expect(header(response, 'set-cookie')).toBe('');
      expectNoWildcardCors(response);
      await expectMeIs(owner(), OWNER_ID);
    });

    it('switches a same-origin dev session to an allowlisted actor via an opaque HttpOnly cookie', async () => {
      const response = await rawRequest(owner().baseUrl, '/api/v1/dev/session', {
        method: 'POST',
        headers: {
          origin: owner().baseUrl,
          'content-type': 'application/json',
          'x-workloom-dev-tool': '1',
        },
        body: JSON.stringify({ actorId: OUTSIDER_ID }),
      });
      const switched = expectOk(response, meResponseSchema);
      expect(switched.data.actor.id).toBe(OUTSIDER_ID);

      const setCookie = response.headers['set-cookie'];
      const firstCookie = (Array.isArray(setCookie) ? setCookie[0] : setCookie) ?? '';
      expect(firstCookie).toMatch(/;\s*HttpOnly\b/i);
      expect(firstCookie).toMatch(/;\s*SameSite=Strict\b/i);
      const cookiePair = firstCookie.split(';')[0]?.trim() ?? '';
      const cookieValue = cookiePair.slice(cookiePair.indexOf('=') + 1);
      expect(cookieValue).not.toBe('');
      expect(cookieValue.toLowerCase()).not.toContain(OUTSIDER_ID.toLowerCase());
      expect(cookieValue.toLowerCase()).not.toContain(OUTSIDER_ID.replace(/-/g, '').toLowerCase());

      const me = expectOk(await get(owner(), '/api/v1/me', { cookie: cookiePair }), meResponseSchema);
      expect(me.data.actor.id).toBe(OUTSIDER_ID);
      const listResponse = await get(owner(), '/api/v1/workspaces', { cookie: cookiePair });
      const list = expectOk(listResponse, workspaceListResponseSchema);
      expect(list.data.map((workspace) => workspace.id)).toEqual([OUTSIDE_ID]);
      for (const value of teamSecrets) expect(listResponse.text()).not.toContain(value);

      // Requests without the cookie still resolve the server-configured default actor.
      await expectMeIs(owner(), OWNER_ID);
    });

    it('never switches to an actor outside the fixture allowlist, even from the same origin', async () => {
      const response = await rawRequest(owner().baseUrl, '/api/v1/dev/session', {
        method: 'POST',
        headers: {
          origin: owner().baseUrl,
          'content-type': 'application/json',
          'x-workloom-dev-tool': '1',
        },
        body: JSON.stringify({ actorId: randomUUID() }),
      });
      expectNotFound(response, []);
      expect(header(response, 'set-cookie')).toBe('');
      await expectMeIs(owner(), OWNER_ID);
    });

    it('rejects a forged Host with a JSON error and no actor data', async () => {
      const response = await get(owner(), '/api/v1/me', { host: 'evil.invalid' });
      expect(expectError(response, 421).error.code).toBe('HOST_NOT_ALLOWED');
      expect(response.text()).not.toContain(OWNER_ID);
      expect(response.text()).not.toContain(ownerUser.displayName);
    });

    it('never answers with a wildcard or attacker-reflecting Access-Control-Allow-Origin', async () => {
      const crossOrigin = { origin: EVIL_ORIGIN };
      expectNoWildcardCors(await get(owner(), '/api/v1/me', crossOrigin));
      expectNoWildcardCors(await get(owner(), '/api/v1/workspaces', crossOrigin));
      expectNoWildcardCors(
        await rawRequest(owner().baseUrl, '/api/v1/dev/session', {
          method: 'OPTIONS',
          headers: {
            origin: EVIL_ORIGIN,
            'access-control-request-method': 'POST',
            'access-control-request-headers': 'content-type, x-workloom-dev-tool',
          },
        }),
      );
    });
  });

  it('re-checks membership on every request: a revoked owner sees nothing without a restart', async () => {
    // Warm any per-process state first so a cache would be exercised.
    expectOk(await get(owner(), `/api/v1/workspaces/${TEAM_ID}`), workspaceResponseSchema);

    await db.sql`
      update memberships set state = 'revoked', revoked_at = now(), revision = revision + 1
      where id = ${FIXTURE_MEMBERSHIP_IDS.teamOwner}`;
    try {
      const list = expectOk(await get(owner(), '/api/v1/workspaces'), workspaceListResponseSchema);
      expect(list.data).toEqual([]);
      expectNotFound(await get(owner(), `/api/v1/workspaces/${TEAM_ID}`), [teamWorkspace.name]);
      expectNotFound(await get(owner(), `/api/v1/workspaces/${TEAM_ID}/memberships`), [teamWorkspace.name]);
    } finally {
      await db.sql`
        update memberships set state = 'active', revoked_at = null, revision = revision + 1
        where id = ${FIXTURE_MEMBERSHIP_IDS.teamOwner}`;
    }

    const restored = expectOk(await get(owner(), '/api/v1/workspaces'), workspaceListResponseSchema);
    expect(restored.data.map((workspace) => workspace.id)).toEqual([TEAM_ID]);
  });

  describe('a separate API process configured with the outsider actor', () => {
    let outsiderApi: ApiProcess | undefined;

    beforeAll(async () => {
      outsiderApi = await startApi({ entry: 'source', databaseUrl: db.url, env: { DEV_ACTOR_ID: OUTSIDER_ID } });
    });

    afterAll(async () => {
      await outsiderApi?.stop();
    });

    function outsider(): ApiProcess {
      if (!outsiderApi) throw new Error('Outsider API process did not start.');
      return outsiderApi;
    }

    it('resolves the outsider and lists only the outside workspace', async () => {
      await expectMeIs(outsider(), OUTSIDER_ID);
      const response = await get(outsider(), '/api/v1/workspaces');
      const list = expectOk(response, workspaceListResponseSchema);
      expect(list.data.map((workspace) => ({ id: workspace.id, name: workspace.name, role: workspace.role }))).toEqual([
        { id: OUTSIDE_ID, name: outsideWorkspace.name, role: 'owner' },
      ]);
      for (const value of teamSecrets) expect(response.text()).not.toContain(value);
    });

    it('gets 404 without team metadata for the team workspace and its memberships', async () => {
      expectNotFound(await get(outsider(), `/api/v1/workspaces/${TEAM_ID}`), teamSecrets);
      expectNotFound(await get(outsider(), `/api/v1/workspaces/${TEAM_ID}/memberships`), teamSecrets);
    });
  });
});

describe('readiness without an applied schema', () => {
  let emptyDb: ThrowawayDatabase;
  let api: ApiProcess | undefined;

  beforeAll(async () => {
    emptyDb = await createThrowawayDatabase('http_noschema');
    api = await startApi({ entry: 'source', databaseUrl: emptyDb.url, env: { DEV_ACTOR_ID: DEFAULT_DEV_ACTOR_ID } });
  });

  afterAll(async () => {
    await api?.stop();
    await emptyDb?.drop();
  });

  it('stays live but reports 503 not-ready with a safe JSON body', async () => {
    if (!api) throw new Error('API process did not start.');
    const live = await get(api, '/healthz/live');
    expect(live.status, live.text()).toBe(200);
    expectSafeHealthBody(live, { status: 'ok' }, emptyDb.url);

    const ready = await get(api, '/healthz/ready');
    expect(ready.status, ready.text()).toBe(503);
    expectSafeHealthBody(ready, { status: 'unavailable', checks: { database: 'ok', schema: 'failed' } }, emptyDb.url);
  });
});
