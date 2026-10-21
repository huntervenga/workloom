import { randomBytes } from 'node:crypto';

import type {
  AccessRepository,
  SharedAuthIdentityInput,
  SharedAuthLoginAttemptInput,
  SharedAuthSessionRecord,
  SharedAuthSessionUpdate,
  SharedAuthStore,
} from '@workloom/domain';
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT, type JWTPayload } from 'jose';
import { beforeAll, describe, expect, it } from 'vitest';

import { SessionKey, type SharedAuthConfig } from '../config.js';
import { HttpError } from '../http/errors.js';
import { createSharedAuthService, verifiedEmailFrom, type AuthFetch, type SharedAuthService } from './shared-auth.js';

const ISSUER = 'https://auth.test';
const AUDIENCE = 'workloom';
const SUBJECT = '6f1c2a34-5b6d-4e7f-8a9b-0c1d2e3f4a5b';
const OTHER_SUBJECT = '7a2d3b45-6c7e-4f80-9bac-1d2e3f4a5b6c';
const USER_ID = '0b9e8d7c-6a5f-4e3d-9c2b-1a0f9e8d7c6b';
const ACCESS_TTL_SECONDS = 900;
const KID = 'test-key';
const PHOTO = 'https://lh3.googleusercontent.com/a/ACg8oc-fresh=s96-c';
const STALE_PHOTO = 'https://lh3.googleusercontent.com/a/ACg8oc-stale=s96-c';
const NEXT_PHOTO = 'https://lh3.googleusercontent.com/a/ACg8oc-next=s96-c';

type ResolveRequest = Parameters<SharedAuthService['identity']['resolveActor']>[0];
type Key = Awaited<ReturnType<typeof generateKeyPair>>['privateKey'];

let privateKey: Key;
let attackerKey: Key;
let jwtKey: ReturnType<typeof createLocalJWKSet>;

beforeAll(async () => {
  const pair = await generateKeyPair('RS256');
  privateKey = pair.privateKey;
  attackerKey = (await generateKeyPair('RS256')).privateKey;
  const publicJwk = await exportJWK(pair.publicKey);
  jwtKey = createLocalJWKSet({ keys: [{ ...publicJwk, kid: KID, alg: 'RS256' }] });
});

function cookieValue(setCookies: readonly string[], name: string): string {
  const entry = setCookies.find((cookie) => cookie.startsWith(`${name}=`));
  if (entry === undefined) throw new Error(`missing ${name} cookie`);
  return entry.slice(name.length + 1).split(';')[0] ?? '';
}

/** In-memory store mirroring the DB photo semantics: identity keyed by (issuer, subject); undefined preserves, null clears. */
class MemoryStore implements SharedAuthStore {
  readonly sessions = new Map<string, SharedAuthSessionRecord>();
  readonly attempts = new Map<string, SharedAuthLoginAttemptInput>();
  readonly users = new Map<string, { displayName: string; avatarUrl: string | null }>();
  readonly identities = new Map<string, string>();
  readonly provisioned: SharedAuthIdentityInput[] = [];
  readonly updates: SharedAuthSessionUpdate[] = [];

  async provisionIdentity(input: SharedAuthIdentityInput) {
    this.provisioned.push(input);
    const key = JSON.stringify([input.issuer, input.subject]);
    const userId = this.identities.get(key) ?? USER_ID;
    const existing = this.users.get(userId);
    const avatarUrl = input.avatarUrl === undefined ? (existing?.avatarUrl ?? null) : input.avatarUrl;
    this.identities.set(key, userId);
    this.users.set(userId, { displayName: input.displayName, avatarUrl });
    return {
      user: { id: userId, displayName: input.displayName, kind: 'real' as const, avatarUrl },
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
    const record = this.sessions.get(sessionHash) ?? null;
    const { result, update } = await callback(record === null ? null : { ...record });
    if (update !== undefined && record !== null) {
      this.updates.push(update);
      const { profileAvatarUrl, ...patch } = update;
      // One commit: the session patch and the session owner's photo land together.
      this.sessions.set(sessionHash, { ...record, ...patch, revision: record.revision + 1 });
      const user = this.users.get(record.userId);
      if (profileAvatarUrl !== undefined && user !== undefined) this.users.set(record.userId, { ...user, avatarUrl: profileAvatarUrl });
    }
    return result;
  }

  async revokeSession(sessionHash: string) {
    const record = this.sessions.get(sessionHash);
    if (record !== undefined && record.revokedAt === null) this.sessions.set(sessionHash, { ...record, revokedAt: new Date().toISOString() });
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
  /** Claims and signing key of the next token issued by the fake Auth refresh endpoint. */
  const auth = {
    claims: { name: 'Ada', picture: PHOTO } as JWTPayload,
    subject: SUBJECT,
    issuer: ISSUER,
    audience: AUDIENCE,
    signWith: null as Key | null,
    refreshCalls: 0,
  };

  async function sign(claims: JWTPayload, options: { subject?: string; key?: Key; issuer?: string; audience?: string } = {}): Promise<string> {
    const issuedAt = Math.floor(clock / 1000);
    return new SignJWT(claims)
      .setProtectedHeader({ alg: 'RS256', kid: KID })
      .setIssuer(options.issuer ?? ISSUER)
      .setAudience(options.audience ?? AUDIENCE)
      .setSubject(options.subject ?? SUBJECT)
      .setIssuedAt(issuedAt)
      .setExpirationTime(issuedAt + ACCESS_TTL_SECONDS)
      .sign(options.key ?? privateKey);
  }

  const fetch: AuthFetch = async (url) => {
    if (!url.endsWith('/auth/refresh')) return new Response(null, { status: 204 });
    auth.refreshCalls += 1;
    const accessToken = await sign(auth.claims, { subject: auth.subject, key: auth.signWith ?? privateKey, issuer: auth.issuer, audience: auth.audience });
    const refreshToken = `rt-${auth.refreshCalls}-${randomBytes(16).toString('base64url')}`;
    return new Response(
      JSON.stringify({ success: true, data: { access_token: accessToken, refresh_token: refreshToken, expires_in: ACCESS_TTL_SECONDS } }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  };

  const repository = {
    async findUser(userId: string) {
      const user = store.users.get(userId);
      return user === undefined ? null : { id: userId, displayName: user.displayName, kind: 'real' as const, avatarUrl: user.avatarUrl };
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

  async function login(initialAccessToken?: string): Promise<{ readonly sessionToken: string; readonly sessionHash: string }> {
    const started = await service.startLogin('/app');
    const state = new URL(started.location).searchParams.get('state') ?? '';
    const before = new Set(store.sessions.keys());
    const completed = await service.completeLogin({
      attemptToken: cookieValue(started.setCookies, 'workloom_auth_attempt'),
      accessToken: initialAccessToken ?? (await sign({ name: 'Ada', picture: STALE_PHOTO })),
      refreshToken: `rt-0-${randomBytes(16).toString('base64url')}`,
      state,
    });
    const sessionHash = [...store.sessions.keys()].find((hash) => !before.has(hash)) ?? '';
    return { sessionToken: cookieValue(completed.setCookies, 'workloom_session'), sessionHash };
  }

  function resolve(sessionToken: string) {
    return service.identity.resolveActor({ headers: { cookie: `workloom_session=${sessionToken}` } } as unknown as ResolveRequest);
  }

  function nearAccessExpiry(sessionHash: string): void {
    const record = store.sessions.get(sessionHash);
    if (record === undefined) throw new Error('missing session');
    clock = Date.parse(record.accessExpiresAt) - 10_000;
  }

  return { store, auth, sign, login, resolve, nearAccessExpiry };
}

describe('shared Auth verified profile photo on login', () => {
  it('persists the fresh verified picture, not the initial callback picture, and resolves it on the actor', async () => {
    const { store, login, resolve } = setup();
    const { sessionToken } = await login();

    expect(store.provisioned).toHaveLength(1);
    expect(store.provisioned[0]?.avatarUrl).toBe(PHOTO);
    expect(store.users.get(USER_ID)?.avatarUrl).toBe(PHOTO);
    await expect(resolve(sessionToken)).resolves.toEqual({ userId: USER_ID, displayName: 'Ada', kind: 'real', avatarUrl: PHOTO, verifiedEmail: null });
  });

  it('never provisions or syncs a photo from a token with an invalid signature', async () => {
    const { store, auth, sign, login } = setup();
    const forged = await sign({ name: 'Mallory', picture: 'https://evil.example.com/a.png' }, { key: attackerKey });
    await expect(login(forged)).rejects.toMatchObject({ statusCode: 401, code: 'UNAUTHENTICATED' });
    expect(store.provisioned).toHaveLength(0);
    expect(auth.refreshCalls).toBe(0);

    auth.signWith = attackerKey;
    await expect(login()).rejects.toBeInstanceOf(HttpError);
    expect(store.provisioned).toHaveLength(0);
    expect(store.users.size).toBe(0);
  });

  it.each(['issuer', 'audience'] as const)('does not provision a picture from a valid signature with the wrong %s', async (claim) => {
    const { store, auth, sign, login } = setup();
    const token = await sign({ name: 'Untrusted profile', picture: PHOTO }, { [claim]: 'https://other.example.com' });
    await expect(login(token)).rejects.toMatchObject({ statusCode: 401, code: 'UNAUTHENTICATED' });
    expect(auth.refreshCalls).toBe(0);
    expect(store.provisioned).toHaveLength(0);
    expect(store.users.size).toBe(0);
    expect(store.sessions.size).toBe(0);
  });

  it.each(['issuer', 'audience'] as const)('revokes without writing a picture when the refreshed token has the wrong %s', async (claim) => {
    const { store, auth, login, resolve, nearAccessExpiry } = setup();
    const { sessionToken, sessionHash } = await login();
    nearAccessExpiry(sessionHash);
    auth[claim] = 'https://other.example.com';
    auth.claims = { name: 'Untrusted profile', picture: NEXT_PHOTO };
    await expect(resolve(sessionToken)).rejects.toMatchObject({ statusCode: 401, code: 'UNAUTHENTICATED' });
    expect(store.provisioned).toHaveLength(1);
    const update = store.updates.at(-1);
    expect(update?.revokedAt).toBeDefined();
    expect(update !== undefined && 'profileAvatarUrl' in update).toBe(false);
    expect(store.users.get(USER_ID)?.avatarUrl).toBe(PHOTO);
  });

  it('omits an absent or invalid picture (preserving the stored photo) and passes an explicit null to clear it', async () => {
    const { store, auth, login } = setup();
    await login();
    expect(store.users.get(USER_ID)?.avatarUrl).toBe(PHOTO);

    for (const picture of [undefined, 'javascript:alert(1)', 'https://127.0.0.1/a.png', 'https://photos.example.com/a.png?token=x', 42]) {
      auth.claims = picture === undefined ? { name: 'Ada' } : { name: 'Ada', picture };
      await login();
      const input = store.provisioned.at(-1);
      expect(input !== undefined && 'avatarUrl' in input).toBe(false);
      expect(store.users.get(USER_ID)?.avatarUrl).toBe(PHOTO);
    }

    auth.claims = { name: 'Ada', picture: null };
    await login();
    expect(store.provisioned.at(-1)?.avatarUrl).toBeNull();
    expect(store.users.get(USER_ID)?.avatarUrl).toBeNull();
  });

  it('provisions by verified issuer and subject only; profile claims such as email never select the user', async () => {
    const { store, auth, login } = setup();
    auth.claims = { name: 'Ada', picture: PHOTO, email: 'someone-else@example.com', email_verified: true };
    await login();
    const input = store.provisioned[0];
    expect(Object.keys(input ?? {}).sort()).toEqual(['avatarUrl', 'displayName', 'issuer', 'subject', 'timezone', 'workspaceName']);
    expect(input).toMatchObject({ issuer: ISSUER, subject: SUBJECT });
  });
});

describe('shared Auth verified profile photo on refresh', () => {
  it('commits a changed picture in the same session patch as the rotated tokens, without provisioning', async () => {
    const { store, auth, login, resolve, nearAccessExpiry } = setup();
    const { sessionToken, sessionHash } = await login();
    const before = store.sessions.get(sessionHash);

    nearAccessExpiry(sessionHash);
    auth.claims = { name: 'Ada', picture: NEXT_PHOTO };
    await expect(resolve(sessionToken)).resolves.toMatchObject({ userId: USER_ID, avatarUrl: NEXT_PHOTO });

    expect(store.provisioned).toHaveLength(1);
    const update = store.updates.at(-1);
    expect(update?.profileAvatarUrl).toBe(NEXT_PHOTO);
    expect(update?.encryptedTokens).toBeDefined();
    expect(update?.encryptedTokens === before?.encryptedTokens).toBe(false);
    expect(update?.revokedAt).toBeUndefined();
    expect(store.users.get(USER_ID)?.avatarUrl).toBe(NEXT_PHOTO);
  });

  it('preserves the photo when the refreshed token omits or carries an invalid picture, and clears it on explicit null', async () => {
    const { store, auth, login, resolve, nearAccessExpiry } = setup();
    const { sessionToken, sessionHash } = await login();

    for (const claims of [{ name: 'Ada' }, { name: 'Ada', picture: 'data:image/png;base64,AAAA' }] as JWTPayload[]) {
      nearAccessExpiry(sessionHash);
      auth.claims = claims;
      await expect(resolve(sessionToken)).resolves.toMatchObject({ avatarUrl: PHOTO });
      const update = store.updates.at(-1);
      expect(update !== undefined && 'profileAvatarUrl' in update).toBe(false);
      expect(update?.encryptedTokens).toBeDefined();
    }

    nearAccessExpiry(sessionHash);
    auth.claims = { name: 'Ada', picture: null };
    await expect(resolve(sessionToken)).resolves.toMatchObject({ avatarUrl: null });
    expect(store.updates.at(-1)?.profileAvatarUrl).toBeNull();
    expect(store.users.get(USER_ID)?.avatarUrl).toBeNull();
    expect(store.provisioned).toHaveLength(1);
  });

  it('never writes a photo from a refreshed token with an invalid signature or another subject', async () => {
    const { store, auth, login, resolve, nearAccessExpiry } = setup();

    for (const tamper of [() => (auth.signWith = attackerKey), () => (auth.subject = OTHER_SUBJECT)]) {
      auth.signWith = null;
      auth.subject = SUBJECT;
      auth.claims = { name: 'Ada', picture: PHOTO };
      const { sessionToken, sessionHash } = await login();

      nearAccessExpiry(sessionHash);
      tamper();
      auth.claims = { name: 'Mallory', picture: 'https://evil.example.com/a.png' };
      await expect(resolve(sessionToken)).rejects.toMatchObject({ statusCode: 401, code: 'UNAUTHENTICATED' });

      const update = store.updates.at(-1);
      expect(update?.revokedAt).toBeDefined();
      expect(update !== undefined && 'profileAvatarUrl' in update).toBe(false);
      expect(store.users.get(USER_ID)?.avatarUrl).toBe(PHOTO);
    }
  });
});


const verifiedClaims = (email = 'ada@company.test'): JWTPayload => ({
  name: 'Ada', email, email_verified: true, email_verification_assertion: 'google_workspace',
  email_verification_observed_at: '2026-10-01T00:00:00.000Z', google_hosted_domain: 'company.test',
});
describe('authoritative email from the exact shared Auth session', () => {
  it('uses fresh rotated claims and carries them on the exact current-session actor', async () => {
    const { auth, sign, login, store, resolve } = setup();
    auth.claims = verifiedClaims('Ada@Company.Test');
    const original = await sign(verifiedClaims('stale@company.test'));
    const { sessionToken } = await login(original);
    expect(Object.keys(store.provisioned.at(-1) ?? {})).not.toContain('verifiedEmail');
    expect((await resolve(sessionToken)).verifiedEmail).toBe('ada@company.test');
    // A second session cannot replace the first token's mailbox proof; no global email cache exists.
    auth.claims = verifiedClaims('other@company.test');
    const second = await login();
    expect((await resolve(second.sessionToken)).verifiedEmail).toBe('other@company.test');
    expect((await resolve(sessionToken)).verifiedEmail).toBe('ada@company.test');
  });
  it('clears eligibility on a refreshed legacy/non-authoritative token without blocking ordinary login', async () => {
    const { auth, login, store, resolve, nearAccessExpiry } = setup();
    auth.claims = verifiedClaims();
    const { sessionToken, sessionHash } = await login();
    nearAccessExpiry(sessionHash);
    auth.claims = { name: 'Ada', email: 'ada@company.test', email_verified: true };
    expect((await resolve(sessionToken)).verifiedEmail).toBeNull();
    expect(Object.keys(store.updates.at(-1) ?? {})).not.toContain('profileVerifiedEmail');
    expect(store.updates.at(-1)?.revokedAt).toBeUndefined();
    auth.claims = verifiedClaims();
    const next = await login();
    expect((await resolve(next.sessionToken)).verifiedEmail).toBe('ada@company.test');
  });
  it.each([
    { email_verified: false }, { email_verified: 'true' }, { email_verification_assertion: 'google_non_authoritative' },
    { google_hosted_domain: 'another.test' }, { google_hosted_domain: '' }, { email_verification_observed_at: null },
    { email_verification_observed_at: 'not-a-date' }, { email: 'ada@company.test\u0000' },
    { email_verification_assertion: 'google_gmail', email: 'ada@googlemail.com' },
  ])('does not accept malformed/non-authoritative mailbox evidence %j', patch => {
    expect(verifiedEmailFrom({ ...verifiedClaims(), ...patch })).toBeNull();
  });
  it('accepts Gmail only with its authoritative assertion and exact gmail.com domain', () => {
    expect(verifiedEmailFrom({ ...verifiedClaims('ADA@gmail.com'), email_verification_assertion: 'google_gmail', google_hosted_domain: undefined })).toBe('ada@gmail.com');
    expect(verifiedEmailFrom({ ...verifiedClaims('ada@gmail.com'), google_hosted_domain: 'gmail.com.evil.test' })).toBeNull();
  });
  it('does not authenticate forged or wrong-audience signed mailbox claims', async () => {
    const { auth, sign, login, store } = setup();
    auth.claims = verifiedClaims();
    await expect(login(await sign(verifiedClaims(), { key: attackerKey }))).rejects.toMatchObject({ statusCode: 401 });
    await expect(login(await sign(verifiedClaims(), { audience: 'wrong-app' }))).rejects.toMatchObject({ statusCode: 401 });
    expect(store.provisioned).toHaveLength(0);
  });
});
