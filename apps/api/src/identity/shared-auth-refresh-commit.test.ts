import { randomBytes } from 'node:crypto';

import type {
  AccessRepository,
  SharedAuthLoginAttemptInput,
  SharedAuthSessionRecord,
  SharedAuthSessionUpdate,
  SharedAuthStore,
} from '@workloom/domain';
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from 'jose';
import { beforeAll, describe, expect, it } from 'vitest';

import { SessionKey, type SharedAuthConfig } from '../config.js';
import { HttpError } from '../http/errors.js';
import { createSharedAuthService, type AuthFetch, type SharedAuthService } from './shared-auth.js';

const ISSUER = 'https://auth.test';
const AUDIENCE = 'workloom';
const SUBJECT = '6f1c2a34-5b6d-4e7f-8a9b-0c1d2e3f4a5b';
const USER_ID = '0b9e8d7c-6a5f-4e3d-9c2b-1a0f9e8d7c6b';
const ACCESS_TTL_SECONDS = 900;
const KID = 'test-key';

type ResolveRequest = Parameters<SharedAuthService['identity']['resolveActor']>[0];

let privateKey: Awaited<ReturnType<typeof generateKeyPair>>['privateKey'];
let jwtKey: ReturnType<typeof createLocalJWKSet>;

beforeAll(async () => {
  const pair = await generateKeyPair('RS256');
  privateKey = pair.privateKey;
  const publicJwk = await exportJWK(pair.publicKey);
  jwtKey = createLocalJWKSet({ keys: [{ ...publicJwk, kid: KID, alg: 'RS256' }] });
});

/** Yields to the event loop until `condition` holds; no timers. */
async function until(condition: () => boolean): Promise<void> {
  for (let i = 0; i < 1000; i += 1) {
    if (condition()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error('condition not reached');
}

function cookieValue(setCookies: readonly string[], name: string): string {
  const entry = setCookies.find((cookie) => cookie.startsWith(`${name}=`));
  if (entry === undefined) throw new Error(`missing ${name} cookie`);
  return entry.slice(name.length + 1).split(';')[0] ?? '';
}

function clearsSession(error: HttpError): boolean {
  return (error.setCookies ?? []).some((cookie) => cookie.startsWith('workloom_session=;') && cookie.includes('Max-Age=0'));
}

/** In-memory SharedAuthStore with a per-hash row lock and switchable commit/revoke failures. */
class MemoryStore implements SharedAuthStore {
  readonly sessions = new Map<string, SharedAuthSessionRecord>();
  readonly attempts = new Map<string, SharedAuthLoginAttemptInput>();
  readonly locks = new Map<string, Promise<void>>();
  failCommit = false;
  failRevoke = false;
  lockedCalls = 0;
  revokeCalls = 0;

  async provisionIdentity() {
    return {
      user: { id: USER_ID, displayName: 'Ada', kind: 'real' as const },
      workspaceId: 'c3b2a190-8f7e-4d6c-9b5a-493827161504',
      membershipId: 'd4c3b2a1-908f-4e7d-8c6b-5a4938271605',
    };
  }

  async createSession(input: Omit<SharedAuthSessionRecord, 'revision' | 'revokedAt'>) {
    this.sessions.set(input.sessionHash, { ...input, revision: 1, revokedAt: null });
  }

  async withLockedSession<T>(
    sessionHash: string,
    callback: (record: SharedAuthSessionRecord | null) => Promise<{ readonly result: T; readonly update?: SharedAuthSessionUpdate }>,
  ): Promise<T> {
    this.lockedCalls += 1;
    const previous = this.locks.get(sessionHash) ?? Promise.resolve();
    let release = (): void => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.locks.set(sessionHash, previous.then(() => held));
    await previous;
    try {
      const record = this.sessions.get(sessionHash) ?? null;
      const { result, update } = await callback(record === null ? null : { ...record });
      if (update !== undefined && record !== null) {
        // Simulated UPDATE/COMMIT failure: the transaction rolls back and the old row stays.
        if (this.failCommit) throw new Error(`commit failed for ${sessionHash}`);
        this.sessions.set(sessionHash, { ...record, ...update, revision: record.revision + 1 });
      }
      return result;
    } finally {
      release();
    }
  }

  async revokeSession(sessionHash: string) {
    this.revokeCalls += 1;
    if (this.failRevoke) throw new Error(`revoke failed for ${sessionHash}`);
    const record = this.sessions.get(sessionHash);
    if (record !== undefined && record.revokedAt === null) {
      this.sessions.set(sessionHash, { ...record, revokedAt: new Date().toISOString() });
    }
  }

  async createLoginAttempt(input: SharedAuthLoginAttemptInput) {
    this.attempts.set(input.stateHash, input);
  }

  async consumeLoginAttempt(input: { readonly stateHash: string; readonly browserHash: string; readonly now: string }) {
    const attempt = this.attempts.get(input.stateHash);
    this.attempts.delete(input.stateHash);
    if (attempt === undefined || attempt.browserHash !== input.browserHash || attempt.expiresAt <= input.now) return null;
    return { returnTo: attempt.returnTo };
  }
}

function setup() {
  let clock = Date.parse('2026-10-17T10:00:00.000Z');
  const store = new MemoryStore();
  const auth = {
    refreshCalls: 0,
    refreshTokensSent: [] as string[],
    issued: [] as string[],
    networkFails: false,
    gate: null as Promise<void> | null,
  };

  async function signAccess(): Promise<string> {
    const issuedAt = Math.floor(clock / 1000);
    return new SignJWT({ name: 'Ada' })
      .setProtectedHeader({ alg: 'RS256', kid: KID })
      .setIssuer(ISSUER)
      .setAudience(AUDIENCE)
      .setSubject(SUBJECT)
      .setIssuedAt(issuedAt)
      .setExpirationTime(issuedAt + ACCESS_TTL_SECONDS)
      .sign(privateKey);
  }

  const fetch: AuthFetch = async (url, init) => {
    if (!url.endsWith('/auth/refresh')) return new Response(null, { status: 204 });
    auth.refreshCalls += 1;
    const body: unknown = JSON.parse(String(init.body));
    auth.refreshTokensSent.push((body as { refresh_token: string }).refresh_token);
    if (auth.gate !== null) await auth.gate;
    if (auth.networkFails) throw new TypeError('network down');
    const refreshToken = `rt-${auth.refreshCalls}-${randomBytes(16).toString('base64url')}`;
    const accessToken = await signAccess();
    auth.issued.push(accessToken, refreshToken);
    return new Response(
      JSON.stringify({ success: true, data: { access_token: accessToken, refresh_token: refreshToken, expires_in: ACCESS_TTL_SECONDS } }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  };

  const repository = {
    async findUser(userId: string) {
      return userId === USER_ID ? { id: USER_ID, displayName: 'Ada', kind: 'real' as const } : null;
    },
  } as unknown as AccessRepository;

  const config: SharedAuthConfig = {
    baseUrl: ISSUER,
    issuer: ISSUER,
    audience: AUDIENCE,
    jwksUrl: `${ISSUER}/.well-known/jwks.json`,
    appOrigin: 'https://app.test',
    secureCookies: true,
    sessionKey: new SessionKey(randomBytes(32)),
  };

  const service = createSharedAuthService({ config, store, repository, fetch, jwtKey, now: () => new Date(clock) });

  async function login(): Promise<{ readonly sessionToken: string; readonly sessionHash: string }> {
    const started = await service.startLogin('/app');
    const state = new URL(started.location).searchParams.get('state') ?? '';
    const initialRefresh = `rt-0-${randomBytes(16).toString('base64url')}`;
    auth.issued.push(initialRefresh);
    const completed = await service.completeLogin({
      attemptToken: cookieValue(started.setCookies, 'workloom_auth_attempt'),
      accessToken: await signAccess(),
      refreshToken: initialRefresh,
      state,
    });
    const sessionToken = cookieValue(completed.setCookies, 'workloom_session');
    const sessionHash = [...store.sessions.keys()][0] ?? '';
    return { sessionToken, sessionHash };
  }

  function resolve(sessionToken: string) {
    return service.identity.resolveActor({ headers: { cookie: `workloom_session=${sessionToken}` } } as unknown as ResolveRequest);
  }

  /** Moves the clock inside the refresh skew of the stored access token. */
  function nearAccessExpiry(sessionHash: string): void {
    const record = store.sessions.get(sessionHash);
    if (record === undefined) throw new Error('missing session');
    clock = Date.parse(record.accessExpiresAt) - 10_000;
  }

  function hold(): () => void {
    let release = (): void => undefined;
    auth.gate = new Promise<void>((resolveGate) => {
      release = resolveGate;
    });
    return () => {
      auth.gate = null;
      release();
    };
  }

  return { store, auth, login, resolve, nearAccessExpiry, hold };
}

function expectHttpError(outcome: PromiseSettledResult<unknown> | undefined, statusCode: number, code: string): HttpError {
  expect(outcome?.status).toBe('rejected');
  const error = (outcome as PromiseRejectedResult).reason as unknown;
  expect(error).toBeInstanceOf(HttpError);
  const httpError = error as HttpError;
  expect(httpError.statusCode).toBe(statusCode);
  expect(httpError.code).toBe(code);
  expect(httpError.retryable).toBe(false);
  expect(clearsSession(httpError)).toBe(true);
  return httpError;
}

function leaksSecrets(error: HttpError, secrets: readonly string[]): boolean {
  const text = [error.message, String(error.stack), JSON.stringify(error), JSON.stringify(error.details ?? null)].join('\n');
  return error.cause !== undefined || text.includes('commit failed') || text.includes('revoke failed') || secrets.some((secret) => text.includes(secret));
}

describe('shared Auth refresh when the rotated tokens fail to commit', () => {
  it('quarantines the session in-process when both the commit and the durable revoke fail', async () => {
    const { store, auth, login, resolve, nearAccessExpiry, hold } = setup();
    const { sessionToken, sessionHash } = await login();
    expect(auth.refreshCalls).toBe(1);
    const storedBefore = store.sessions.get(sessionHash);

    nearAccessExpiry(sessionHash);
    store.failCommit = true;
    store.failRevoke = true;
    const release = hold();
    const pending = [resolve(sessionToken), resolve(sessionToken), resolve(sessionToken)];
    await until(() => auth.refreshCalls === 2);
    release();
    const [first, ...followers] = await Promise.allSettled(pending);

    expect(auth.refreshCalls).toBe(2);
    const error = expectHttpError(first, 503, 'AUTH_UNAVAILABLE');
    expect(leaksSecrets(error, [sessionToken, sessionHash, ...auth.issued])).toBe(false);
    for (const follower of followers) expectHttpError(follower, 401, 'UNAUTHENTICATED');
    expect(store.revokeCalls).toBe(1);

    // The rollback kept the old ciphertext (with the spent refresh token) and no revoke landed.
    const storedAfter = store.sessions.get(sessionHash);
    expect(storedAfter?.encryptedTokens === storedBefore?.encryptedTokens).toBe(true);
    expect(storedAfter?.revokedAt).toBeNull();

    // Even with the DB healthy again, the old cookie is denied without touching the DB or Auth.
    store.failCommit = false;
    store.failRevoke = false;
    const lockedCalls = store.lockedCalls;
    const [later] = await Promise.allSettled([resolve(sessionToken)]);
    expectHttpError(later, 401, 'UNAUTHENTICATED');
    expect(auth.refreshCalls).toBe(2);
    expect(store.lockedCalls).toBe(lockedCalls);
    expect(auth.refreshTokensSent.filter((token) => token === auth.refreshTokensSent[1]).length).toBe(1);
  });

  it('durably revokes the session after the failed commit', async () => {
    const { store, auth, login, resolve, nearAccessExpiry } = setup();
    const { sessionToken, sessionHash } = await login();
    const storedBefore = store.sessions.get(sessionHash);

    nearAccessExpiry(sessionHash);
    store.failCommit = true;
    const [first] = await Promise.allSettled([resolve(sessionToken)]);
    const error = expectHttpError(first, 503, 'AUTH_UNAVAILABLE');
    expect(leaksSecrets(error, [sessionToken, sessionHash, ...auth.issued])).toBe(false);

    expect(store.revokeCalls).toBe(1);
    const storedAfter = store.sessions.get(sessionHash);
    expect(storedAfter?.revokedAt).not.toBeNull();
    expect(storedAfter?.encryptedTokens === storedBefore?.encryptedTokens).toBe(true);

    store.failCommit = false;
    const [later] = await Promise.allSettled([resolve(sessionToken)]);
    expectHttpError(later, 401, 'UNAUTHENTICATED');
    expect(auth.refreshCalls).toBe(2);
  });

  it('blocks the session when an unknown Auth outcome cannot commit its revoke', async () => {
    const { store, auth, login, resolve, nearAccessExpiry } = setup();
    const { sessionToken, sessionHash } = await login();

    nearAccessExpiry(sessionHash);
    auth.networkFails = true;
    store.failCommit = true;
    store.failRevoke = true;
    const [first, second] = await Promise.allSettled([resolve(sessionToken), resolve(sessionToken)]);
    expectHttpError(first, 503, 'AUTH_UNAVAILABLE');
    expectHttpError(second, 401, 'UNAUTHENTICATED');
    expect(auth.refreshCalls).toBe(2);
    expect(store.sessions.get(sessionHash)?.revokedAt).toBeNull();
  });

  it('does not quarantine a healthy commit and still rotates once for concurrent requests', async () => {
    const { store, auth, login, resolve, nearAccessExpiry, hold } = setup();
    const { sessionToken, sessionHash } = await login();
    const storedBefore = store.sessions.get(sessionHash);

    nearAccessExpiry(sessionHash);
    const release = hold();
    const pending = [resolve(sessionToken), resolve(sessionToken), resolve(sessionToken)];
    await until(() => auth.refreshCalls === 2);
    release();
    const actors = await Promise.all(pending);

    expect(actors.every((actor) => actor.userId === USER_ID && actor.kind === 'real')).toBe(true);
    expect(auth.refreshCalls).toBe(2);
    expect(store.revokeCalls).toBe(0);
    const storedAfter = store.sessions.get(sessionHash);
    expect(storedAfter?.encryptedTokens === storedBefore?.encryptedTokens).toBe(false);
    expect(storedAfter?.revokedAt).toBeNull();

    await expect(resolve(sessionToken)).resolves.toMatchObject({ userId: USER_ID });
    expect(auth.refreshCalls).toBe(2);
  });
});
