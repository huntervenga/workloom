import { createHash, randomBytes, randomUUID } from 'node:crypto';

import type { ReadinessProbe } from '@workloom/db';
import type { AccessRepository, SharedAuthSessionRecord, SharedAuthSessionUpdate, SharedAuthStore } from '@workloom/domain';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT, type JWTVerifyGetKey } from 'jose';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createApp } from '../app.js';
import { loadConfig } from '../config.js';
import { LOGIN_ATTEMPT_COOKIE, SHARED_SESSION_COOKIE, type AuthFetch } from '../identity/shared-auth.js';

type UserRecord = NonNullable<Awaited<ReturnType<AccessRepository['findUser']>>>;
type WorkspaceAccessRecord = NonNullable<Awaited<ReturnType<AccessRepository['findWorkspaceAccess']>>>;
type WorkspaceRecord = WorkspaceAccessRecord['workspace'];
type MembershipRecord = WorkspaceAccessRecord['membership'];
type SharedAuthIdentity = Awaited<ReturnType<SharedAuthStore['provisionIdentity']>>;
type SigningKey = Awaited<ReturnType<typeof generateKeyPair>>['privateKey'];

const NOW = Date.parse('2026-10-17T12:00:00.000Z');
const HOST = '127.0.0.1:4310';
const APP_ORIGIN = 'http://127.0.0.1:4310';
const AUTH_BASE = 'http://127.0.0.1:4999';
const ISSUER = AUTH_BASE;
const AUDIENCE = 'pet-projects';
const KID = 'focused-rs256';
const ACCESS_TTL_SECONDS = 900;
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const OPAQUE = /^[A-Za-z0-9_-]{43}$/;
const SUB_A = '0f6e2b4c-1a3d-4e5f-8a9b-0c1d2e3f4a5b';
const SUB_B = '7c8d9e0f-2b3a-4c5d-9e6f-1a2b3c4d5e6f';
const FIXTURE_USER: UserRecord = { id: '5eed0000-0000-4000-8000-000000000101', displayName: 'Fixture Owner', kind: 'fixture' };
const FIXTURE_WORKSPACE_ID = '5eed0000-0000-4000-8000-0000000000a1';
const DATABASE_URL = 'postgres://workloom:unused@127.0.0.1:54329/workloom';

const sharedEnv = {
  APP_ENV: 'local',
  AUTH_MODE: 'shared',
  DATABASE_URL,
  AUTH_SESSION_KEY: Buffer.from('workloom-synthetic-test-key-0032', 'utf8').toString('base64url'),
  AUTH_BASE_URL: AUTH_BASE,
  AUTH_ISSUER: ISSUER,
  AUTH_AUDIENCE: AUDIENCE,
  AUTH_APP_ORIGIN: APP_ORIGIN,
};

const readiness = {} as ReadinessProbe;

let signingKey: SigningKey;
let foreignKey: SigningKey;
let jwtKey: JWTVerifyGetKey;
let clockMs = NOW;
const clock = (): Date => new Date(clockMs);

function advance(ms: number): void {
  clockMs += ms;
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

interface MintOptions {
  readonly issuer?: string;
  readonly audience?: string;
  /** Lifetime relative to the controlled clock; null omits exp. */
  readonly expSeconds?: number | null;
  readonly key?: SigningKey;
  readonly claims?: Record<string, unknown>;
}

async function mintAccess(sub: string, options: MintOptions = {}): Promise<string> {
  const iat = Math.floor(clockMs / 1000);
  const jwt = new SignJWT({ ...options.claims })
    .setProtectedHeader({ alg: 'RS256', kid: KID, typ: 'JWT' })
    .setSubject(sub)
    .setIssuer(options.issuer ?? ISSUER)
    .setAudience(options.audience ?? AUDIENCE)
    .setIssuedAt(iat);
  if (options.expSeconds !== null) jwt.setExpirationTime(iat + (options.expSeconds ?? ACCESS_TTL_SECONDS));
  return jwt.sign(options.key ?? signingKey);
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

/** Root Auth refresh success shape. */
function rotatedResponse(accessToken: string, refreshToken: string): Response {
  return jsonResponse(200, { success: true, data: { access_token: accessToken, refresh_token: refreshToken, expires_in: ACCESS_TTL_SECONDS } });
}

interface FakeAuth {
  readonly fetch: AuthFetch;
  /** Refresh tokens presented to /auth/refresh, in order. */
  readonly refreshCalls: string[];
  readonly logoutCalls: string[];
  /** Every raw token the fake ever issued, for leak checks. */
  readonly issued: string[];
  /** Returning undefined falls through to the default single-use rotation. */
  onRefresh: ((refreshToken: string) => Promise<Response | undefined>) | null;
  onLogout: (() => Promise<Response>) | null;
  issue(sub: string, claims?: Record<string, unknown>): Promise<{ readonly accessToken: string; readonly refreshToken: string }>;
}

function createFakeAuth(): FakeAuth {
  const live = new Map<string, { readonly sub: string; readonly claims: Record<string, unknown> }>();
  const issued: string[] = [];

  function newRefreshToken(sub: string, claims: Record<string, unknown>): string {
    const token = `rt_${randomBytes(24).toString('base64url')}`;
    live.set(token, { sub, claims });
    issued.push(token);
    return token;
  }

  async function newAccessToken(sub: string, claims: Record<string, unknown>): Promise<string> {
    const token = await mintAccess(sub, { claims });
    issued.push(token);
    return token;
  }

  const auth: FakeAuth = {
    refreshCalls: [],
    logoutCalls: [],
    issued,
    onRefresh: null,
    onLogout: null,
    async issue(sub, claims = { name: 'Ada Example' }) {
      return { accessToken: await newAccessToken(sub, claims), refreshToken: newRefreshToken(sub, claims) };
    },
    async fetch(url, init) {
      const presented = (JSON.parse(String(init.body)) as { refresh_token?: string }).refresh_token ?? '';
      if (url === `${AUTH_BASE}/auth/refresh`) {
        auth.refreshCalls.push(presented);
        const override = await auth.onRefresh?.(presented);
        if (override !== undefined) return override;
        const entry = live.get(presented);
        if (entry === undefined) return jsonResponse(401, { success: false, error: { code: 'INVALID_REFRESH_TOKEN' } });
        live.delete(presented);
        return rotatedResponse(await newAccessToken(entry.sub, entry.claims), newRefreshToken(entry.sub, entry.claims));
      }
      if (url === `${AUTH_BASE}/auth/logout`) {
        auth.logoutCalls.push(presented);
        live.delete(presented);
        return (await auth.onLogout?.()) ?? jsonResponse(200, { success: true });
      }
      throw new Error('unexpected Auth call');
    },
  };
  return auth;
}

interface MemoryStore extends SharedAuthStore {
  readonly sessions: Map<string, SharedAuthSessionRecord>;
  readonly attempts: Map<string, { readonly browserHash: string; readonly returnTo: string; readonly expiresAt: string }>;
  readonly identities: Map<string, SharedAuthIdentity>;
  readonly users: Map<string, UserRecord>;
  readonly workspaces: Map<string, WorkspaceRecord>;
  readonly memberships: MembershipRecord[];
  readonly provisionCalls: string[];
  /** accessExpiresAt each locked callback observed, per entry. */
  readonly lockedReads: Array<{ readonly sessionHash: string; readonly accessExpiresAt: string | null }>;
  failCommits: boolean;
}

function identityKey(issuer: string, subject: string): string {
  return `${issuer}\u0000${subject}`;
}

/** Exact SharedAuthStore: hashes and ciphertext only; per-hash serialized lock commits the patch after the callback. */
function createMemoryStore(): MemoryStore {
  const locks = new Map<string, Promise<void>>();
  const store: MemoryStore = {
    sessions: new Map(),
    attempts: new Map(),
    identities: new Map(),
    users: new Map(),
    workspaces: new Map([[FIXTURE_WORKSPACE_ID, { id: FIXTURE_WORKSPACE_ID, name: 'Fixture workspace', timezone: 'UTC', weekStart: 1 }]]),
    memberships: [
      {
        id: randomUUID(),
        workspaceId: FIXTURE_WORKSPACE_ID,
        userId: FIXTURE_USER.id,
        displayName: FIXTURE_USER.displayName,
        role: 'owner',
        state: 'active',
        revision: 1,
      },
    ],
    provisionCalls: [],
    lockedReads: [],
    failCommits: false,

    async provisionIdentity(input) {
      store.provisionCalls.push(input.subject);
      const key = identityKey(input.issuer, input.subject);
      const existing = store.identities.get(key);
      if (existing !== undefined) return existing;
      const user = { id: randomUUID(), displayName: input.displayName, kind: 'real' as const };
      const workspace: WorkspaceRecord = { id: randomUUID(), name: input.workspaceName, timezone: input.timezone, weekStart: 1 };
      const membershipId = randomUUID();
      store.users.set(user.id, user);
      store.workspaces.set(workspace.id, workspace);
      store.memberships.push({
        id: membershipId,
        workspaceId: workspace.id,
        userId: user.id,
        displayName: user.displayName,
        role: 'owner',
        state: 'active',
        revision: 1,
      });
      const identity: SharedAuthIdentity = { user, workspaceId: workspace.id, membershipId };
      store.identities.set(key, identity);
      return identity;
    },

    async createSession(input) {
      store.sessions.set(input.sessionHash, { ...input, revision: 1, revokedAt: null });
    },

    async withLockedSession<T>(
      sessionHash: string,
      callback: (record: SharedAuthSessionRecord | null) => Promise<{ readonly result: T; readonly update?: SharedAuthSessionUpdate }>,
    ): Promise<T> {
      const previous = locks.get(sessionHash) ?? Promise.resolve();
      let release: () => void = () => undefined;
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      const tail = previous.then(() => held);
      locks.set(sessionHash, tail);
      await previous;
      try {
        const current = store.sessions.get(sessionHash) ?? null;
        store.lockedReads.push({ sessionHash, accessExpiresAt: current?.accessExpiresAt ?? null });
        const { result, update } = await callback(current === null ? null : { ...current });
        if (update !== undefined && current !== null) {
          if (store.failCommits) throw new Error('synthetic commit failure');
          store.sessions.set(sessionHash, { ...current, ...update, revision: current.revision + 1 });
        }
        return result;
      } finally {
        release();
        if (locks.get(sessionHash) === tail) locks.delete(sessionHash);
      }
    },

    async revokeSession(sessionHash) {
      const current = store.sessions.get(sessionHash);
      if (current !== undefined && current.revokedAt === null) {
        store.sessions.set(sessionHash, { ...current, revokedAt: clock().toISOString(), revision: current.revision + 1 });
      }
    },

    async createLoginAttempt(input) {
      store.attempts.set(input.stateHash, { browserHash: input.browserHash, returnTo: input.returnTo, expiresAt: input.expiresAt });
    },

    async consumeLoginAttempt(input) {
      const attempt = store.attempts.get(input.stateHash);
      if (attempt === undefined || attempt.browserHash !== input.browserHash || !(Date.parse(attempt.expiresAt) > Date.parse(input.now))) {
        return null;
      }
      store.attempts.delete(input.stateHash);
      return { returnTo: attempt.returnTo };
    },
  };
  return store;
}

function createRepository(store: MemoryStore): AccessRepository {
  const findUser = (userId: string): UserRecord | null => (userId === FIXTURE_USER.id ? FIXTURE_USER : store.users.get(userId) ?? null);
  const access = (membership: MembershipRecord): WorkspaceAccessRecord | null => {
    const workspace = store.workspaces.get(membership.workspaceId);
    return workspace === undefined ? null : { workspace, membership };
  };
  const repository: Partial<AccessRepository> = {
    async findUser(userId) {
      return findUser(userId);
    },
    async findUsers(userIds) {
      return userIds.flatMap((id) => findUser(id) ?? []);
    },
    async listAccessibleWorkspaces(userId) {
      return store.memberships.filter((m) => m.userId === userId && m.state === 'active').flatMap((m) => access(m) ?? []);
    },
    async findWorkspaceAccess(workspaceId, userId) {
      const membership = store.memberships.find((m) => m.workspaceId === workspaceId && m.userId === userId);
      return membership === undefined ? null : access(membership);
    },
    async listActiveMemberships(workspaceId) {
      return store.memberships.filter((m) => m.workspaceId === workspaceId && m.state === 'active');
    },
  };
  return repository as AccessRepository;
}

interface Harness {
  readonly app: FastifyInstance;
  readonly store: MemoryStore;
  readonly auth: FakeAuth;
}

let h: Harness;

beforeAll(async () => {
  const pair = await generateKeyPair('RS256');
  const foreign = await generateKeyPair('RS256');
  signingKey = pair.privateKey;
  foreignKey = foreign.privateKey;
  jwtKey = createLocalJWKSet({ keys: [{ ...(await exportJWK(pair.publicKey)), kid: KID, alg: 'RS256', use: 'sig' }] });
});

beforeEach(async () => {
  clockMs = NOW;
  const store = createMemoryStore();
  const auth = createFakeAuth();
  const app = await createApp(loadConfig(sharedEnv), {
    accessRepository: createRepository(store),
    readiness,
    sharedAuthStore: store,
    authJwtKey: jwtKey,
    authFetch: auth.fetch,
    clock,
    logger: false,
    webDistDir: null,
  });
  h = { app, store, auth };
});

afterEach(async () => {
  await h.app.close();
});

function setCookies(response: LightMyRequestResponse): readonly string[] {
  const raw = response.headers['set-cookie'];
  if (raw === undefined) return [];
  return Array.isArray(raw) ? raw : [String(raw)];
}

function cookieFrom(response: LightMyRequestResponse, name: string): string | undefined {
  const entry = setCookies(response).find((cookie) => cookie.startsWith(`${name}=`));
  return entry?.slice(name.length + 1).split(';', 1)[0];
}

function clears(response: LightMyRequestResponse, name: string): boolean {
  return setCookies(response).some((cookie) => cookie.startsWith(`${name}=;`) && cookie.includes('Max-Age=0'));
}

function errorCode(response: LightMyRequestResponse): string {
  return response.json<{ error: { code: string } }>().error.code;
}

function attemptCookie(value: string): string {
  return `${LOGIN_ATTEMPT_COOKIE}=${value}`;
}

/** Boolean so a failing assertion never prints a token. */
function leaks(text: string, secrets: readonly string[]): boolean {
  return secrets.some((secret) => text.includes(secret));
}

function persisted(): string {
  return JSON.stringify({ sessions: [...h.store.sessions], attempts: [...h.store.attempts], identities: [...h.store.identities] });
}

function record(sessionHash: string): SharedAuthSessionRecord {
  const found = h.store.sessions.get(sessionHash);
  if (found === undefined) throw new Error('session record missing');
  return found;
}

function identityOf(subject: string): SharedAuthIdentity {
  const found = h.store.identities.get(identityKey(ISSUER, subject));
  if (found === undefined) throw new Error('identity missing');
  return found;
}

async function beginLogin(returnTo?: string) {
  const url = returnTo === undefined ? '/api/v1/auth/login' : `/api/v1/auth/login?returnTo=${encodeURIComponent(returnTo)}`;
  const response = await h.app.inject({ method: 'GET', url, headers: { host: HOST } });
  expect(response.statusCode).toBe(302);
  const location = new URL(String(response.headers.location));
  return { response, location, state: location.searchParams.get('state') ?? '', attempt: cookieFrom(response, LOGIN_ATTEMPT_COOKIE) ?? '' };
}

interface PostOptions {
  readonly cookie?: string;
  /** null omits the Origin header. */
  readonly origin?: string | null;
  readonly headers?: Record<string, string>;
}

function postSession(payload: string | object, options: PostOptions = {}) {
  return h.app.inject({
    method: 'POST',
    url: '/api/v1/auth/session',
    headers: {
      host: HOST,
      ...(options.origin === null ? {} : { origin: options.origin ?? APP_ORIGIN }),
      ...(options.cookie === undefined ? {} : { cookie: options.cookie }),
      ...options.headers,
    },
    payload,
  });
}

async function signIn(sub: string, options: { readonly returnTo?: string; readonly claims?: Record<string, unknown>; readonly cookie?: string } = {}) {
  const login = await beginLogin(options.returnTo);
  const tokens = await h.auth.issue(sub, options.claims);
  const response = await postSession(
    { ...tokens, state: login.state },
    { cookie: [attemptCookie(login.attempt), options.cookie].filter((part) => part !== undefined).join('; ') },
  );
  expect(response.statusCode).toBe(200);
  const session = cookieFrom(response, SHARED_SESSION_COOKIE) ?? '';
  return { login, tokens, response, session, cookie: `${SHARED_SESSION_COOKIE}=${session}` };
}

function me(cookie?: string) {
  return h.app.inject({ method: 'GET', url: '/api/v1/me', headers: { host: HOST, ...(cookie === undefined ? {} : { cookie }) } });
}

function meActorId(response: LightMyRequestResponse): string {
  return response.json<{ data: { actor: { id: string } } }>().data.actor.id;
}

function logout(options: { readonly cookie?: string; readonly origin?: string | null; readonly payload?: object } = {}) {
  return h.app.inject({
    method: 'POST',
    url: '/api/v1/auth/logout',
    headers: {
      host: HOST,
      ...(options.origin === null ? {} : { origin: options.origin ?? APP_ORIGIN }),
      ...(options.cookie === undefined ? {} : { cookie: options.cookie }),
    },
    ...(options.payload === undefined ? {} : { payload: options.payload }),
  });
}

/** Bounded event-loop turns so a concurrent request is queued behind the held refresh. */
async function settle(): Promise<void> {
  for (let turn = 0; turn < 20; turn += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

describe('shared Auth public surface', () => {
  it('serves the public auth config in both modes, hides dev routes and never falls back to fixtures', async () => {
    const shared = await h.app.inject({ method: 'GET', url: '/api/v1/auth/config', headers: { host: HOST } });
    expect(shared.statusCode).toBe(200);
    expect(shared.headers['cache-control']).toBe('no-store');
    expect(shared.json()).toEqual({ data: { authMode: 'shared' }, meta: { requestId: expect.any(String) } });

    const devApp = await createApp(loadConfig({ APP_ENV: 'local', AUTH_MODE: 'dev', DATABASE_URL }), {
      accessRepository: createRepository(h.store),
      readiness,
      logger: false,
      webDistDir: null,
    });
    try {
      const dev = await devApp.inject({ method: 'GET', url: '/api/v1/auth/config', headers: { host: HOST } });
      expect(dev.statusCode).toBe(200);
      expect(dev.headers['cache-control']).toBe('no-store');
      expect(dev.json()).toEqual({ data: { authMode: 'dev' }, meta: { requestId: expect.any(String) } });
    } finally {
      await devApp.close();
    }

    expect((await h.app.inject({ method: 'GET', url: '/api/v1/dev/actors', headers: { host: HOST } })).statusCode).toBe(404);
    const devSession = await h.app.inject({
      method: 'POST',
      url: '/api/v1/dev/session',
      headers: { host: HOST, origin: APP_ORIGIN },
      payload: { actorId: FIXTURE_USER.id },
    });
    expect(devSession.statusCode).toBe(404);

    const guest = await me();
    expect(guest.statusCode).toBe(401);
    expect(errorCode(guest)).toBe('UNAUTHENTICATED');
    expect(guest.body.includes(FIXTURE_USER.id)).toBe(false);
    const malformed = await me(`${SHARED_SESSION_COOKIE}=not-an-opaque-token`);
    expect(malformed.statusCode).toBe(401);
    expect(clears(malformed, SHARED_SESSION_COOKIE)).toBe(true);
  });
});

describe('GET /api/v1/auth/login', () => {
  const e = encodeURIComponent;
  it.each([
    `returnTo=${e('https://evil.example/app')}`,
    `returnTo=${e('//evil.example/app')}`,
    `returnTo=${e('/app//evil.example')}`,
    `returnTo=${e('/app\\evil')}`,
    `returnTo=${e('/app/\r\nSet-Cookie: x=1')}`,
    `returnTo=${e('/app/%0d%0aSet-Cookie')}`,
    `returnTo=${e('/app/%5c%5cevil')}`,
    `returnTo=${e('/app/%2e%2e/admin')}`,
    `returnTo=${e('/app/../admin')}`,
    `returnTo=${e('/application')}`,
    `returnTo=${e('/APP')}`,
    `returnTo=${e('/')}`,
    'returnTo=',
    'returnTo',
    `returnTo=${e('/app')}&returnTo=${e('/app/x')}`,
    `returnTo=${e('/app')}&next=${e('/app')}`,
    `next=${e('/app')}`,
  ])('refuses %s without recording an attempt', async (query) => {
    const response = await h.app.inject({ method: 'GET', url: `/api/v1/auth/login?${query}`, headers: { host: HOST } });
    expect(response.statusCode).toBe(400);
    expect(errorCode(response)).toBe('VALIDATION_FAILED');
    expect(setCookies(response)).toEqual([]);
    expect(h.store.attempts.size).toBe(0);
  });

  it('redirects to the fixed Auth login with an independent state and a hashed 600 s attempt', async () => {
    const { response, location, state, attempt } = await beginLogin('/app/projects?view=board#top');
    expect(`${location.origin}${location.pathname}`).toBe(`${AUTH_BASE}/auth/login`);
    expect([...location.searchParams.keys()].sort()).toEqual(['mode', 'redirect_uri', 'state']);
    expect(location.searchParams.get('redirect_uri')).toBe(`${APP_ORIGIN}/app/auth/callback`);
    expect(location.searchParams.get('mode')).toBe('redirect');
    expect(OPAQUE.test(state) && OPAQUE.test(attempt)).toBe(true);
    expect(state === attempt).toBe(false);

    const cookie = setCookies(response).find((value) => value.startsWith(`${LOGIN_ATTEMPT_COOKIE}=`)) ?? '';
    for (const attribute of ['HttpOnly', 'SameSite=Lax', 'Path=/', 'Max-Age=600']) expect(cookie).toContain(attribute);
    expect(cookie).not.toContain('Secure');

    expect([...h.store.attempts]).toEqual([
      [sha256(state), { browserHash: sha256(attempt), returnTo: '/app/projects?view=board#top', expiresAt: new Date(NOW + 600_000).toISOString() }],
    ]);
    expect(leaks(persisted(), [state, attempt])).toBe(false);

    const plain = await beginLogin();
    expect(h.store.attempts.get(sha256(plain.state))?.returnTo).toBe('/app');
  });
});

describe('POST /api/v1/auth/session', () => {
  it('rejects wrong, missing, malformed, cross-browser, expired and replayed attempts before rotation or provisioning', async () => {
    const valid = await beginLogin();
    const other = await beginLogin();
    const tokens = await h.auth.issue(SUB_A);
    const cases: ReadonlyArray<readonly [string, string, string | undefined]> = [
      ['wrong state', randomBytes(32).toString('base64url'), attemptCookie(valid.attempt)],
      ['missing cookie', valid.state, undefined],
      ['malformed cookie', valid.state, attemptCookie('short')],
      ['cross-browser cookie', valid.state, attemptCookie(other.attempt)],
    ];
    for (const [label, state, cookie] of cases) {
      const response = await postSession({ ...tokens, state }, cookie === undefined ? {} : { cookie });
      expect([label, response.statusCode, errorCode(response), clears(response, LOGIN_ATTEMPT_COOKIE)]).toEqual([label, 401, 'UNAUTHENTICATED', true]);
    }

    advance(601_000);
    const expired = await postSession({ ...(await h.auth.issue(SUB_A)), state: valid.state }, { cookie: attemptCookie(valid.attempt) });
    expect(expired.statusCode).toBe(401);
    expect(h.auth.refreshCalls).toHaveLength(0);
    expect(h.store.provisionCalls).toHaveLength(0);
    expect(h.store.sessions.size).toBe(0);

    const first = await signIn(SUB_A);
    const replay = await postSession({ ...(await h.auth.issue(SUB_A)), state: first.login.state }, { cookie: attemptCookie(first.login.attempt) });
    expect(replay.statusCode).toBe(401);
    expect(h.auth.refreshCalls).toHaveLength(1);
    expect(h.store.provisionCalls).toHaveLength(1);
    expect(h.store.sessions.size).toBe(1);
  });

  it('enforces the canonical origin and a strict JSON body before consuming the attempt', async () => {
    const login = await beginLogin();
    const tokens = await h.auth.issue(SUB_A);
    const body = { ...tokens, state: login.state };
    const cookie = attemptCookie(login.attempt);

    const csrf: ReadonlyArray<readonly [string, PostOptions]> = [
      ['foreign origin', { cookie, origin: 'http://evil.example' }],
      ['missing origin', { cookie, origin: null }],
      ['cross-site fetch', { cookie, headers: { 'sec-fetch-site': 'cross-site' } }],
      ['trusted but non-canonical origin', { cookie, origin: 'http://localhost:4310' }],
    ];
    for (const [label, options] of csrf) {
      const response = await postSession(body, options);
      expect([label, response.statusCode, errorCode(response)]).toEqual([label, 403, 'ORIGIN_NOT_ALLOWED']);
    }

    const invalid: ReadonlyArray<readonly [string, object]> = [
      ['unknown field', { ...body, extra: true }],
      ['missing refresh token', { accessToken: tokens.accessToken, state: login.state }],
      ['empty state', { ...body, state: '' }],
      ['non-string token', { ...body, accessToken: 42 }],
    ];
    for (const [label, payload] of invalid) {
      const response = await postSession(payload, { cookie });
      expect([label, response.statusCode, errorCode(response)]).toEqual([label, 400, 'VALIDATION_FAILED']);
    }
    for (const contentType of ['text/plain', 'application/x-www-form-urlencoded']) {
      const response = await postSession(JSON.stringify(body), { cookie, headers: { 'content-type': contentType } });
      expect([400, 415]).toContain(response.statusCode);
    }

    expect(h.auth.refreshCalls).toHaveLength(0);
    expect(h.store.provisionCalls).toHaveLength(0);
    expect(h.store.attempts.size).toBe(1);
    expect((await postSession(body, { cookie })).statusCode).toBe(200);
  });

  it('rejects forged or malformed initial access tokens with a sanitized 401 before rotation', async () => {
    const iat = Math.floor(NOW / 1000);
    const cases: ReadonlyArray<readonly [string, () => Promise<string>]> = [
      ['foreign signature', () => mintAccess(SUB_A, { key: foreignKey })],
      [
        'HS256',
        () =>
          new SignJWT({})
            .setProtectedHeader({ alg: 'HS256', kid: KID })
            .setSubject(SUB_A)
            .setIssuer(ISSUER)
            .setAudience(AUDIENCE)
            .setIssuedAt(iat)
            .setExpirationTime(iat + ACCESS_TTL_SECONDS)
            .sign(new TextEncoder().encode('h'.repeat(32))),
      ],
      ['wrong issuer', () => mintAccess(SUB_A, { issuer: 'http://127.0.0.1:4998' })],
      ['wrong audience', () => mintAccess(SUB_A, { audience: 'other-project' })],
      ['expired', () => mintAccess(SUB_A, { expSeconds: -60 })],
      ['missing exp', () => mintAccess(SUB_A, { expSeconds: null })],
      ['non-UUID subject', () => mintAccess('user-123')],
      ['not a JWT', async () => 'not-a-jwt'],
    ];
    for (const [label, mint] of cases) {
      const login = await beginLogin();
      const { refreshToken } = await h.auth.issue(SUB_A);
      const accessToken = await mint();
      const response = await postSession({ accessToken, refreshToken, state: login.state }, { cookie: attemptCookie(login.attempt) });
      expect([label, response.statusCode, errorCode(response)]).toEqual([label, 401, 'UNAUTHENTICATED']);
      expect(response.json<{ error: { message: string } }>().error.message).toBe('Sign in to continue.');
      expect(leaks(response.body, [accessToken, refreshToken]) || /jws|jwt|signature|claim/i.test(response.body)).toBe(false);
    }
    expect(h.auth.refreshCalls).toHaveLength(0);
    expect(h.store.provisionCalls).toHaveLength(0);
    expect(h.store.sessions.size).toBe(0);
  });

  it('rejects a refresh that returns another subject and never retries an unknown refresh outcome', async () => {
    const mixedLogin = await beginLogin();
    const mixedTokens = await h.auth.issue(SUB_A);
    h.auth.onRefresh = async () => rotatedResponse(await mintAccess(SUB_B), `rt_${randomBytes(24).toString('base64url')}`);
    const mixed = await postSession({ ...mixedTokens, state: mixedLogin.state }, { cookie: attemptCookie(mixedLogin.attempt) });
    expect(mixed.statusCode).toBe(401);
    expect(h.auth.refreshCalls).toHaveLength(1);

    const unknown: ReadonlyArray<readonly [string, () => Promise<Response>]> = [
      ['network', async () => Promise.reject(new TypeError('network down'))],
      ['5xx', async () => jsonResponse(502, { success: false })],
      ['malformed success', async () => jsonResponse(200, { success: true, data: { access_token: 'x' } })],
    ];
    for (const [label, respond] of unknown) {
      h.auth.onRefresh = respond;
      const before = h.auth.refreshCalls.length;
      const login = await beginLogin();
      const response = await postSession({ ...(await h.auth.issue(SUB_A)), state: login.state }, { cookie: attemptCookie(login.attempt) });
      expect([label, response.statusCode, h.auth.refreshCalls.length - before]).toEqual([label, 503, 1]);
      expect(response.json()).toMatchObject({ error: { code: 'AUTH_UNAVAILABLE', retryable: false } });
      expect(clears(response, LOGIN_ATTEMPT_COOKIE)).toBe(true);
    }
    expect(h.store.provisionCalls).toHaveLength(0);
    expect(h.store.sessions.size).toBe(0);
  });

  it('completes the handshake: one rotation, real provisioning, opaque cookie and encrypted storage', async () => {
    const login = await beginLogin('/app/settings?tab=profile#notifications');
    const tokens = await h.auth.issue(SUB_A, { name: 'Ada Example', email: 'ada@example.test' });
    const response = await postSession({ ...tokens, state: login.state }, { cookie: attemptCookie(login.attempt) });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ data: { returnTo: '/app/settings?tab=profile#notifications' }, meta: { requestId: expect.any(String) } });
    expect(h.auth.refreshCalls).toHaveLength(1);
    expect(h.auth.refreshCalls[0] === tokens.refreshToken).toBe(true);

    const session = cookieFrom(response, SHARED_SESSION_COOKIE) ?? '';
    const sessionCookie = setCookies(response).find((value) => value.startsWith(`${SHARED_SESSION_COOKIE}=`)) ?? '';
    expect(OPAQUE.test(session)).toBe(true);
    for (const attribute of ['HttpOnly', 'SameSite=Lax', 'Path=/', 'Max-Age=2592000']) expect(sessionCookie).toContain(attribute);
    expect(clears(response, LOGIN_ATTEMPT_COOKIE)).toBe(true);

    expect([...h.store.sessions.keys()]).toEqual([sha256(session)]);
    const stored = record(sha256(session));
    expect(stored).toMatchObject({
      expiresAt: new Date(NOW + SESSION_TTL_MS).toISOString(),
      accessExpiresAt: new Date(NOW + ACCESS_TTL_SECONDS * 1000).toISOString(),
      revokedAt: null,
    });
    expect(stored.encryptedTokens.startsWith('v1.')).toBe(true);
    expect(h.auth.issued).toHaveLength(4);
    expect(leaks(persisted(), [session, ...h.auth.issued])).toBe(false);
    expect(leaks(response.body, [session, ...h.auth.issued])).toBe(false);

    const identity = identityOf(SUB_A);
    expect(h.store.provisionCalls).toEqual([SUB_A]);
    const current = await me(`${SHARED_SESSION_COOKIE}=${session}`);
    expect(current.statusCode).toBe(200);
    expect(current.json()).toMatchObject({ data: { actor: { id: identity.user.id, displayName: 'Ada Example', kind: 'real' }, authMode: 'shared' } });
    expect(leaks(current.body, h.auth.issued)).toBe(false);
  });

  it('keys identities by issuer and subject: one owned workspace per subject, never merged by profile', async () => {
    const profile = { name: 'Ada Example', email: 'ada@example.test' };
    const first = await signIn(SUB_A, { claims: profile });
    const second = await signIn(SUB_A, { claims: profile, cookie: first.cookie });
    const other = await signIn(SUB_B, { claims: profile });

    const userA = identityOf(SUB_A).user.id;
    const userB = identityOf(SUB_B).user.id;
    expect(userA === userB).toBe(false);
    expect(h.store.identities.size).toBe(2);
    for (const userId of [userA, userB]) {
      expect(h.store.memberships.filter((m) => m.userId === userId && m.role === 'owner')).toHaveLength(1);
    }

    expect((await me(first.cookie)).statusCode).toBe(401);
    expect(meActorId(await me(second.cookie))).toBe(userA);
    expect(meActorId(await me(other.cookie))).toBe(userB);
  });

  it('keeps a workspace deep link only with a current active membership, otherwise /app', async () => {
    const fresh = await signIn(SUB_B, { returnTo: `/app/w/${FIXTURE_WORKSPACE_ID}/projects?view=table#row` });
    expect(fresh.response.json<{ data: { returnTo: string } }>().data.returnTo).toBe('/app');
    expect(h.store.memberships.filter((m) => m.workspaceId === FIXTURE_WORKSPACE_ID).map((m) => m.userId)).toEqual([FIXTURE_USER.id]);

    await signIn(SUB_A);
    const { user, workspaceId: own } = identityOf(SUB_A);
    const revoked = randomUUID();
    h.store.workspaces.set(revoked, { id: revoked, name: 'Former workspace', timezone: 'UTC', weekStart: 1 });
    h.store.memberships.push({ id: randomUUID(), workspaceId: revoked, userId: user.id, displayName: user.displayName, role: 'owner', state: 'revoked', revision: 2 });

    const cases: ReadonlyArray<readonly [string, string]> = [
      [`/app/w/${FIXTURE_WORKSPACE_ID}`, '/app'],
      [`/app/w/${FIXTURE_WORKSPACE_ID}/tasks?x=1`, '/app'],
      [`/app/w/${revoked}/tasks`, '/app'],
      [`/app/w/${randomUUID()}/tasks`, '/app'],
      ['/app/w/not-a-workspace/tasks', '/app'],
      [`/app/w/${own}/projects?view=table#row`, `/app/w/${own}/projects?view=table#row`],
      [`/app/w/${own}`, `/app/w/${own}`],
      ['/app/settings?tab=profile#security', '/app/settings?tab=profile#security'],
      ['/app/workspaces', '/app/workspaces'],
    ];
    for (const [returnTo, expected] of cases) {
      const { response } = await signIn(SUB_A, { returnTo });
      expect([returnTo, response.json<{ data: { returnTo: string } }>().data.returnTo]).toEqual([returnTo, expected]);
    }
  });
});

describe('shared Auth session refresh', () => {
  it('serializes concurrent refreshes into one rotation and keeps the absolute expiry', async () => {
    const { cookie, session } = await signIn(SUB_A);
    const hash = sha256(session);
    const before = record(hash);
    advance(ACCESS_TTL_SECONDS * 1000);

    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let started: () => void = () => undefined;
    const refreshStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    h.auth.onRefresh = async () => {
      started();
      await gate;
      return undefined;
    };

    const first = me(cookie);
    const second = me(cookie);
    await refreshStarted;
    await settle();
    expect(h.auth.refreshCalls).toHaveLength(2);
    expect(h.store.lockedReads.filter((read) => read.sessionHash === hash)).toHaveLength(1);
    release();
    const responses = await Promise.all([first, second]);

    expect(responses.map((response) => response.statusCode)).toEqual([200, 200]);
    expect(h.auth.refreshCalls).toHaveLength(2);
    const after = record(hash);
    expect(after.encryptedTokens === before.encryptedTokens).toBe(false);
    expect(after.accessExpiresAt).toBe(new Date(clockMs + ACCESS_TTL_SECONDS * 1000).toISOString());
    expect(after.expiresAt).toBe(before.expiresAt);
    expect(after.revision).toBe(before.revision + 1);
    expect(h.store.lockedReads.filter((read) => read.sessionHash === hash).map((read) => read.accessExpiresAt)).toEqual([
      before.accessExpiresAt,
      after.accessExpiresAt,
    ]);
    expect(leaks(persisted(), h.auth.issued)).toBe(false);
  });

  it('revokes the session on an unknown refresh outcome with a non-retryable 503 and never retries', async () => {
    const { cookie, session } = await signIn(SUB_A);
    advance(ACCESS_TTL_SECONDS * 1000);
    h.auth.onRefresh = async () => Promise.reject(new TypeError('network down'));

    const response = await me(cookie);
    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({ error: { code: 'AUTH_UNAVAILABLE', retryable: false } });
    expect(clears(response, SHARED_SESSION_COOKIE)).toBe(true);
    expect(record(sha256(session)).revokedAt).toBe(clock().toISOString());

    const again = await me(cookie);
    expect(again.statusCode).toBe(401);
    expect(h.auth.refreshCalls).toHaveLength(2);
  });

  it('revokes the session on a definitive refresh rejection', async () => {
    const { cookie, session } = await signIn(SUB_A);
    advance(ACCESS_TTL_SECONDS * 1000);
    h.auth.onRefresh = async () => jsonResponse(401, { success: false });

    const response = await me(cookie);
    expect(response.statusCode).toBe(401);
    expect(clears(response, SHARED_SESSION_COOKIE)).toBe(true);
    expect(record(sha256(session)).revokedAt).not.toBeNull();
    expect((await me(cookie)).statusCode).toBe(401);
    expect(h.auth.refreshCalls).toHaveLength(2);
  });

  it('binds ciphertexts to their own session and refreshes to their own subject', async () => {
    const a = await signIn(SUB_A, { claims: { name: 'Ada' } });
    const b = await signIn(SUB_B, { claims: { name: 'Bo' } });
    expect(meActorId(await me(a.cookie))).toBe(identityOf(SUB_A).user.id);
    expect(meActorId(await me(b.cookie))).toBe(identityOf(SUB_B).user.id);

    const hashA = sha256(a.session);
    const hashB = sha256(b.session);
    const recordA = record(hashA);
    const recordB = record(hashB);
    h.store.sessions.set(hashA, { ...recordA, encryptedTokens: recordB.encryptedTokens });
    h.store.sessions.set(hashB, { ...recordB, encryptedTokens: recordA.encryptedTokens });
    for (const cookie of [a.cookie, b.cookie]) {
      const response = await me(cookie);
      expect(response.statusCode).toBe(401);
      expect(clears(response, SHARED_SESSION_COOKIE)).toBe(true);
    }
    expect(record(hashA).revokedAt !== null && record(hashB).revokedAt !== null).toBe(true);

    const c = await signIn(SUB_A);
    advance(ACCESS_TTL_SECONDS * 1000);
    h.auth.onRefresh = async () => rotatedResponse(await mintAccess(SUB_B), `rt_${randomBytes(24).toString('base64url')}`);
    const crossed = await me(c.cookie);
    expect(crossed.statusCode).toBe(401);
    expect(record(sha256(c.session)).revokedAt).not.toBeNull();
    expect(h.auth.refreshCalls).toHaveLength(4);
  });
});

describe('POST /api/v1/auth/logout', () => {
  it('revokes locally before the remote logout, clears cookies and is idempotent for guests', async () => {
    const { cookie, session } = await signIn(SUB_A);
    const hash = sha256(session);
    let revokedFirst = false;
    h.auth.onLogout = async () => {
      revokedFirst = record(hash).revokedAt !== null;
      return jsonResponse(200, { success: true });
    };

    const response = await logout({ cookie });
    expect(response.statusCode).toBe(204);
    expect(clears(response, SHARED_SESSION_COOKIE) && clears(response, LOGIN_ATTEMPT_COOKIE)).toBe(true);
    expect(revokedFirst).toBe(true);
    expect(h.auth.logoutCalls).toHaveLength(1);
    expect((await me(cookie)).statusCode).toBe(401);

    expect((await logout({ cookie, payload: {} })).statusCode).toBe(204);
    const guest = await logout({ payload: {} });
    expect(guest.statusCode).toBe(204);
    expect(clears(guest, SHARED_SESSION_COOKIE)).toBe(true);
    expect(h.auth.logoutCalls).toHaveLength(1);
    expect((await logout({ cookie, payload: { everywhere: true } })).statusCode).toBe(400);
  });

  it('keeps the local revoke when the remote logout fails', async () => {
    const failures: ReadonlyArray<() => Promise<Response>> = [
      async () => Promise.reject(new TypeError('network down')),
      async () => jsonResponse(500, { success: false }),
    ];
    for (const failure of failures) {
      const { cookie, session } = await signIn(SUB_A);
      h.auth.onLogout = failure;
      expect((await logout({ cookie, payload: {} })).statusCode).toBe(204);
      expect(record(sha256(session)).revokedAt).not.toBeNull();
      expect((await me(cookie)).statusCode).toBe(401);
    }
  });

  it('requires the canonical origin and never reports 204 when the local revoke fails', async () => {
    const { cookie, session } = await signIn(SUB_A);
    for (const origin of [null, 'http://localhost:4310', 'http://evil.example']) {
      const response = await logout({ cookie, origin, payload: {} });
      expect([origin, response.statusCode, errorCode(response)]).toEqual([origin, 403, 'ORIGIN_NOT_ALLOWED']);
    }
    expect((await me(cookie)).statusCode).toBe(200);

    h.store.failCommits = true;
    const failed = await logout({ cookie, payload: {} });
    expect(failed.statusCode).toBe(500);
    expect(h.auth.logoutCalls).toHaveLength(0);
    expect(record(sha256(session)).revokedAt).toBeNull();
  });
});
