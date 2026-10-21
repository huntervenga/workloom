import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

import { safeProfilePhotoUrl } from '@workloom/contracts';
import type { AccessRepository, Actor, SharedAuthSessionRecord, SharedAuthSessionUpdate, SharedAuthStore } from '@workloom/domain';
import { createRemoteJWKSet, errors as joseErrors, jwtVerify, type JWTVerifyGetKey } from 'jose';

import type { SharedAuthConfig } from '../config.js';
import { HttpError } from '../http/errors.js';
import { readCookie } from './dev-sessions.js';
import type { IdentityAdapter } from './identity-adapter.js';

export const SHARED_SESSION_COOKIE = 'workloom_session';
export const LOGIN_ATTEMPT_COOKIE = 'workloom_auth_attempt';

const LOGIN_ATTEMPT_TTL_SECONDS = 600;
/** Absolute session lifetime; refreshes never extend it. */
const SESSION_TTL_SECONDS = 30 * 24 * 60 * 60;
const REFRESH_SKEW_MS = 30_000;
const AUTH_HTTP_TIMEOUT_MS = 5_000;
const AUTH_RESPONSE_LIMIT_BYTES = 64 * 1024;
const MAX_ACCESS_TOKEN_LENGTH = 8192;
const MAX_REFRESH_TOKEN_LENGTH = 4096;
const MAX_DISPLAY_NAME_LENGTH = 200;
const APP_HOME = '/app';
const WORKSPACE_RETURN_TO = /^\/app\/w\/([^/]*)(?:\/|$)/;
const WORKSPACE_SUFFIX = ' workspace';
const DEFAULT_DISPLAY_NAME = 'Member';
const ENCRYPTION_VERSION = 'v1';
const OPAQUE_TOKEN = /^[A-Za-z0-9_-]{43}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PRINTABLE_TOKEN = /^[\x21-\x7e]+$/;

/** Narrow fetch seam for Auth refresh/logout calls. JWKS retrieval and JWT verification never go through it. */
export type AuthFetch = (url: string, init: RequestInit) => Promise<Response>;

export interface SharedAuthServiceOptions {
  readonly config: SharedAuthConfig;
  readonly store: SharedAuthStore;
  readonly repository: AccessRepository;
  readonly fetch?: AuthFetch;
  /** Verification key resolver (e.g. jose createLocalJWKSet) for focused tests; default is the remote JWKS. */
  readonly jwtKey?: JWTVerifyGetKey;
  readonly now?: () => Date;
}

export interface CompleteLoginInput {
  /** Browser-bound attempt cookie value. */
  readonly attemptToken: string | undefined;
  readonly accessToken: string;
  readonly refreshToken: string;
  readonly state: string;
}

export interface SharedAuthService {
  readonly identity: IdentityAdapter;
  readonly appOrigin: string;
  /** Records a login attempt and returns the Auth redirect plus the attempt cookie. */
  startLogin(returnTo: string): Promise<{ readonly location: string; readonly setCookies: readonly string[] }>;
  /** Verifies, rotates once, provisions and creates a local session. Tokens are never returned. */
  completeLogin(input: CompleteLoginInput): Promise<{ readonly returnTo: string; readonly setCookies: readonly string[] }>;
  /** Revokes a replaced local session; no remote call. */
  revokeLocalSession(sessionToken: string): Promise<void>;
  /** Commits the local revoke first, then best-effort remote logout. Store failures propagate. */
  logout(sessionToken: string | undefined): Promise<void>;
  /** Set-Cookie values clearing the session and attempt cookies. */
  clearCookies(): readonly string[];
}

interface StoredTokens {
  readonly issuer: string;
  readonly subject: string;
  readonly accessToken: string;
  readonly refreshToken: string;
}

/** undefined = absent or unusable (preserve), null = explicitly cleared, string = safe normalized URL. */
type PictureClaim = string | null | undefined;

type VerifiedAccess =
  | { readonly ok: true; readonly subject: string; readonly name: unknown; readonly picture: PictureClaim; readonly verifiedEmail: string | null; readonly expiresAt: string }
  | { readonly ok: false; readonly reason: 'invalid' | 'unavailable' };

type RefreshOutcome =
  | { readonly kind: 'rotated'; readonly accessToken: string; readonly refreshToken: string }
  /** Definitive Auth rejection (4xx). */
  | { readonly kind: 'rejected' }
  /** Network, timeout, 5xx or malformed response: the refresh token may already be rotated. */
  | { readonly kind: 'unknown' };

type SessionOutcome =
  | { readonly kind: 'active'; readonly userId: string; readonly verifiedEmail: string | null }
  | { readonly kind: 'unauthenticated' }
  | { readonly kind: 'unavailable' };

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function randomToken(): string {
  return randomBytes(32).toString('base64url');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isBoundedToken(value: unknown, maxLength: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= maxLength && PRINTABLE_TOKEN.test(value);
}

function serializeCookie(name: string, value: string, maxAgeSeconds: number, secure: boolean): string {
  return `${name}=${value}; Path=/; Max-Age=${maxAgeSeconds}; HttpOnly; SameSite=Lax${secure ? '; Secure' : ''}`;
}

function truncate(value: string, maxLength: number): string {
  const chars = Array.from(value);
  return chars.length <= maxLength ? value : chars.slice(0, maxLength).join('').trimEnd();
}

/** First usable signed `name` claim, control characters removed, bounded; otherwise 'Member'. */
function displayNameFrom(...claims: readonly unknown[]): string {
  for (const claim of claims) {
    if (typeof claim !== 'string') continue;
    const cleaned = truncate(claim.replace(/\p{Cc}/gu, ' ').replace(/\s+/g, ' ').trim(), MAX_DISPLAY_NAME_LENGTH);
    if (cleaned !== '') return cleaned;
  }
  return DEFAULT_DISPLAY_NAME;
}

/** Reads the signed `picture` claim; invalid values are ignored rather than clearing the stored photo. */
function pictureFrom(payload: Readonly<Record<string, unknown>>): PictureClaim {
  if (!('picture' in payload)) return undefined;
  if (payload.picture === null) return null;
  return safeProfilePhotoUrl(payload.picture) ?? undefined;
}

/** Auth VERIFIED_EMAIL v1.1. Only claims from the same verified token may establish a mailbox. */
export function verifiedEmailFrom(payload: Readonly<Record<string, unknown>>): string | null {
  if (payload.email_verified !== true || typeof payload.email !== 'string') return null;
  const email = payload.email.trim().toLowerCase();
  if (email.length > 254 || /\p{Cc}/u.test(email) || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return null;
  const observed = payload.email_verification_observed_at;
  if (typeof observed !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(observed) || !Number.isFinite(Date.parse(observed))) return null;
  const domain = email.slice(email.lastIndexOf('@') + 1);
  if (payload.email_verification_assertion === 'google_gmail') return domain === 'gmail.com' ? email : null;
  if (payload.email_verification_assertion !== 'google_workspace' || typeof payload.google_hosted_domain !== 'string') return null;
  const hosted = payload.google_hosted_domain.trim().toLowerCase();
  return hosted !== '' && hosted === domain ? email : null;
}

function workspaceNameFor(displayName: string): string {
  return `${truncate(displayName, MAX_DISPLAY_NAME_LENGTH - WORKSPACE_SUFFIX.length)}${WORKSPACE_SUFFIX}`;
}

/** AES-256-GCM; the session hash is bound as AAD so ciphertexts cannot be swapped between rows. */
function encryptTokens(key: Buffer, sessionHash: string, tokens: StoredTokens): string {
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, nonce, { authTagLength: 16 });
  cipher.setAAD(Buffer.from(sessionHash, 'utf8'));
  const plaintext = Buffer.from(
    JSON.stringify({ iss: tokens.issuer, sub: tokens.subject, at: tokens.accessToken, rt: tokens.refreshToken }),
    'utf8',
  );
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return [ENCRYPTION_VERSION, nonce.toString('base64url'), cipher.getAuthTag().toString('base64url'), ciphertext.toString('base64url')].join('.');
}

function decryptTokens(key: Buffer, sessionHash: string, encoded: string): StoredTokens | null {
  const [version, nonceText, tagText, cipherText, ...rest] = encoded.split('.');
  if (version !== ENCRYPTION_VERSION || nonceText === undefined || tagText === undefined || cipherText === undefined || rest.length > 0) {
    return null;
  }
  try {
    const nonce = Buffer.from(nonceText, 'base64url');
    const tag = Buffer.from(tagText, 'base64url');
    const ciphertext = Buffer.from(cipherText, 'base64url');
    if (nonce.length !== 12 || tag.length !== 16 || ciphertext.length === 0) return null;
    const decipher = createDecipheriv('aes-256-gcm', key, nonce, { authTagLength: 16 });
    decipher.setAAD(Buffer.from(sessionHash, 'utf8'));
    decipher.setAuthTag(tag);
    const parsed: unknown = JSON.parse(Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8'));
    if (
      !isRecord(parsed) ||
      typeof parsed.iss !== 'string' ||
      typeof parsed.sub !== 'string' ||
      !isBoundedToken(parsed.at, MAX_ACCESS_TOKEN_LENGTH) ||
      !isBoundedToken(parsed.rt, MAX_REFRESH_TOKEN_LENGTH)
    ) {
      return null;
    }
    return { issuer: parsed.iss, subject: parsed.sub, accessToken: parsed.at, refreshToken: parsed.rt };
  } catch {
    return null;
  }
}

async function discardBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // Nothing to release.
  }
}

/** Reads at most AUTH_RESPONSE_LIMIT_BYTES of UTF-8; null when larger, unreadable or not UTF-8. */
async function readBoundedText(response: Response): Promise<string | null> {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > AUTH_RESPONSE_LIMIT_BYTES) {
    await discardBody(response);
    return null;
  }
  if (response.body === null) return '';
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > AUTH_RESPONSE_LIMIT_BYTES) {
        await reader.cancel();
        return null;
      }
      chunks.push(value);
    }
    return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
  } catch {
    return null;
  }
}

function authPostInit(payload: Readonly<Record<string, string>>): RequestInit {
  return {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify(payload),
    redirect: 'error',
    signal: AbortSignal.timeout(AUTH_HTTP_TIMEOUT_MS),
  };
}

/** JWKS retrieval problems are availability failures; every other JOSE failure is an invalid token. */
function isVerificationUnavailable(error: unknown): boolean {
  if (error instanceof joseErrors.JWKSTimeout || error instanceof joseErrors.JWKSInvalid) return true;
  return !(error instanceof joseErrors.JOSEError);
}

/**
 * Shared Auth BFF: the browser only ever holds an opaque session cookie; Auth
 * tokens are verified (RS256, issuer, audience, exp, UUID sub), rotated once and
 * stored AES-256-GCM encrypted. Tokens and raw causes never leave this module.
 */
export function createSharedAuthService(options: SharedAuthServiceOptions): SharedAuthService {
  const { config, store, repository } = options;
  const key = config.sessionKey.bytes();
  const now = options.now ?? (() => new Date());
  const authFetch: AuthFetch = options.fetch ?? ((url, init) => fetch(url, init));
  const jwtKey: JWTVerifyGetKey =
    options.jwtKey ?? createRemoteJWKSet(new URL(config.jwksUrl), { timeoutDuration: AUTH_HTTP_TIMEOUT_MS });
  const secure = config.secureCookies;

  const clearSession = serializeCookie(SHARED_SESSION_COOKIE, '', 0, secure);
  const clearAttempt = serializeCookie(LOGIN_ATTEMPT_COOKIE, '', 0, secure);

  function unauthenticated(setCookies?: readonly string[]): HttpError {
    return new HttpError(401, 'UNAUTHENTICATED', 'Sign in to continue.', undefined, setCookies === undefined ? {} : { setCookies });
  }

  function unavailable(setCookies: readonly string[]): HttpError {
    // Not retryable: the Auth outcome is unknown, so only a fresh sign-in is safe.
    return new HttpError(503, 'AUTH_UNAVAILABLE', 'The sign-in service could not be reached. Sign in again.', undefined, {
      retryable: false,
      setCookies,
    });
  }

  async function verifyAccessToken(token: string): Promise<VerifiedAccess> {
    try {
      const { payload } = await jwtVerify(token, jwtKey, {
        algorithms: ['RS256'],
        issuer: config.issuer,
        audience: config.audience,
        requiredClaims: ['exp', 'sub'],
        currentDate: now(),
      });
      if (typeof payload.sub !== 'string' || !UUID.test(payload.sub) || typeof payload.exp !== 'number') {
        return { ok: false, reason: 'invalid' };
      }
      const expiresAt = new Date(payload.exp * 1000);
      if (Number.isNaN(expiresAt.getTime())) return { ok: false, reason: 'invalid' };
      return {
        ok: true,
        subject: payload.sub.toLowerCase(),
        name: payload.name,
        picture: pictureFrom(payload),
        verifiedEmail: verifiedEmailFrom(payload),
        expiresAt: expiresAt.toISOString(),
      };
    } catch (error) {
      return { ok: false, reason: isVerificationUnavailable(error) ? 'unavailable' : 'invalid' };
    }
  }

  /** Exactly one rotation attempt; callers must never retry with the same refresh token. */
  async function rotateRefreshToken(refreshToken: string): Promise<RefreshOutcome> {
    let response: Response;
    try {
      response = await authFetch(`${config.baseUrl}/auth/refresh`, authPostInit({ refresh_token: refreshToken }));
    } catch {
      return { kind: 'unknown' };
    }
    if (response.status >= 400 && response.status < 500 && response.status !== 408 && response.status !== 429) {
      await discardBody(response);
      return { kind: 'rejected' };
    }
    if (response.status < 200 || response.status >= 300) {
      await discardBody(response);
      return { kind: 'unknown' };
    }
    const text = await readBoundedText(response);
    if (text === null) return { kind: 'unknown' };
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return { kind: 'unknown' };
    }
    if (!isRecord(parsed) || parsed.success !== true || !isRecord(parsed.data)) return { kind: 'unknown' };
    const { access_token: accessToken, refresh_token: rotated, expires_in: expiresIn } = parsed.data;
    if (
      !isBoundedToken(accessToken, MAX_ACCESS_TOKEN_LENGTH) ||
      !isBoundedToken(rotated, MAX_REFRESH_TOKEN_LENGTH) ||
      typeof expiresIn !== 'number' ||
      !Number.isFinite(expiresIn) ||
      expiresIn <= 0
    ) {
      return { kind: 'unknown' };
    }
    return { kind: 'rotated', accessToken, refreshToken: rotated };
  }

  async function remoteLogout(refreshToken: string): Promise<void> {
    try {
      const response = await authFetch(`${config.baseUrl}/auth/logout`, authPostInit({ refresh_token: refreshToken }));
      await discardBody(response);
    } catch {
      // Best effort: the local session is already revoked.
    }
  }

  /**
   * Runs under the row lock; failures return a revoke patch so it commits before the caller throws.
   * `onRotationAttempt` fires before the refresh token is sent, with the absolute session expiry.
   */
  async function refreshLocked(
    sessionHash: string,
    record: SharedAuthSessionRecord | null,
    onRotationAttempt: (sessionExpiresAtMs: number) => void,
  ): Promise<{ readonly result: SessionOutcome; readonly update?: SharedAuthSessionUpdate }> {
    const at = now();
    if (record === null || record.revokedAt !== null || !(Date.parse(record.expiresAt) > at.getTime())) {
      return { result: { kind: 'unauthenticated' } };
    }
    const revoke: SharedAuthSessionUpdate = { revokedAt: at.toISOString() };
    const tokens = decryptTokens(key, sessionHash, record.encryptedTokens);
    if (tokens === null || tokens.issuer !== config.issuer || !UUID.test(tokens.subject)) {
      return { result: { kind: 'unauthenticated' }, update: revoke };
    }
    if (Date.parse(record.accessExpiresAt) - at.getTime() > REFRESH_SKEW_MS) {
      const current = await verifyAccessToken(tokens.accessToken);
      if (!current.ok) return current.reason === 'unavailable'
        ? { result: { kind: 'unavailable' } }
        : { result: { kind: 'unauthenticated' }, update: revoke };
      if (current.subject !== tokens.subject) return { result: { kind: 'unauthenticated' }, update: revoke };
      return { result: { kind: 'active', userId: record.userId, verifiedEmail: current.verifiedEmail } };
    }

    onRotationAttempt(Date.parse(record.expiresAt));
    const rotation = await rotateRefreshToken(tokens.refreshToken);
    if (rotation.kind === 'rejected') return { result: { kind: 'unauthenticated' }, update: revoke };
    if (rotation.kind === 'unknown') return { result: { kind: 'unavailable' }, update: revoke };

    const fresh = await verifyAccessToken(rotation.accessToken);
    if (!fresh.ok) {
      return { result: { kind: fresh.reason === 'unavailable' ? 'unavailable' : 'unauthenticated' }, update: revoke };
    }
    if (fresh.subject !== tokens.subject) return { result: { kind: 'unauthenticated' }, update: revoke };

    return {
      result: { kind: 'active', userId: record.userId, verifiedEmail: fresh.verifiedEmail },
      update: {
        encryptedTokens: encryptTokens(key, sessionHash, {
          issuer: config.issuer,
          subject: tokens.subject,
          accessToken: rotation.accessToken,
          refreshToken: rotation.refreshToken,
        }),
        accessExpiresAt: fresh.expiresAt,
        // Same locked transaction as the rotated tokens; scoped to record.userId by the store.
        ...(fresh.picture === undefined ? {} : { profileAvatarUrl: fresh.picture }),
      },
    };
  }

  /**
   * A saved /app/w/<workspace> deep link may predate this user (e.g. a fixture
   * workspace); it survives only with a current active membership, otherwise
   * '/app'. Lookup failures fall back too: the redirect never grants access.
   */
  async function authorizedReturnTo(returnTo: string, userId: string): Promise<string> {
    let pathname: string;
    try {
      pathname = new URL(returnTo, config.appOrigin).pathname;
    } catch {
      return APP_HOME;
    }
    const match = WORKSPACE_RETURN_TO.exec(pathname);
    if (match === null) return returnTo;
    const workspaceId = match[1] ?? '';
    if (!UUID.test(workspaceId)) return APP_HOME;
    try {
      const access = await repository.findWorkspaceAccess(workspaceId.toLowerCase(), userId);
      return access !== null && access.membership.userId === userId && access.membership.state === 'active' ? returnTo : APP_HOME;
    } catch {
      return APP_HOME;
    }
  }

  /**
   * Session hashes whose refresh token may be spent at Auth but whose rotated replacement never
   * committed. Value is the absolute session expiry (ms); entries are denied without DB or Auth
   * access. Process-local only: lost on restart if the durable revoke also failed.
   */
  const quarantined = new Map<string, number>();
  /** Per-hash tail of the in-process resolve chain; only lives while an operation is pending. */
  const pendingResolves = new Map<string, Promise<void>>();

  function isQuarantined(sessionHash: string): boolean {
    const until = quarantined.get(sessionHash);
    if (until === undefined) return false;
    if (until > now().getTime()) return true;
    quarantined.delete(sessionHash);
    return false;
  }

  function quarantine(sessionHash: string, untilMs: number): void {
    const at = now().getTime();
    for (const [hash, until] of quarantined) {
      if (until <= at) quarantined.delete(hash);
    }
    quarantined.set(sessionHash, Number.isFinite(untilMs) ? untilMs : at + SESSION_TTL_SECONDS * 1000);
  }

  /** Serializes same-session work in this process so a follower never runs before a failed commit is quarantined. */
  async function serializeSession<T>(sessionHash: string, task: () => Promise<T>): Promise<T> {
    const previous = pendingResolves.get(sessionHash) ?? Promise.resolve();
    const run = previous.then(task);
    const tail = run.then(
      () => undefined,
      () => undefined,
    );
    pendingResolves.set(sessionHash, tail);
    try {
      return await run;
    } finally {
      if (pendingResolves.get(sessionHash) === tail) pendingResolves.delete(sessionHash);
    }
  }

  async function resolveSession(sessionHash: string): Promise<SessionOutcome> {
    if (isQuarantined(sessionHash)) return { kind: 'unauthenticated' };
    let rotationExpiresAtMs: number | undefined;
    try {
      return await store.withLockedSession(sessionHash, (record) =>
        refreshLocked(sessionHash, record, (expiresAtMs) => {
          rotationExpiresAtMs = expiresAtMs;
        }),
      );
    } catch (error) {
      // Before any rotation attempt the stored refresh token is untouched; keep existing failure handling.
      if (rotationExpiresAtMs === undefined) throw error;
      // Auth may have rotated while the patch rolled back: the stored refresh token may be spent.
      // Deny locally first, then try a separate durable revoke; never retry Auth with the old token.
      quarantine(sessionHash, rotationExpiresAtMs);
      try {
        await store.revokeSession(sessionHash);
      } catch {
        // The in-process quarantine still denies this session.
      }
      return { kind: 'unavailable' };
    }
  }

  const identity: IdentityAdapter = {
    mode: 'shared',
    async resolveActor(request): Promise<Actor> {
      const token = readCookie(request.headers.cookie, SHARED_SESSION_COOKIE);
      if (token === undefined) throw unauthenticated();
      if (!OPAQUE_TOKEN.test(token)) throw unauthenticated([clearSession]);

      const sessionHash = sha256(token);
      const outcome = await serializeSession(sessionHash, () => resolveSession(sessionHash));
      if (outcome.kind === 'unauthenticated') throw unauthenticated([clearSession]);
      if (outcome.kind === 'unavailable') throw unavailable([clearSession]);

      const user = await repository.findUser(outcome.userId);
      if (user === null || user.kind !== 'real') throw unauthenticated([clearSession]);
      return { userId: user.id, displayName: user.displayName, kind: user.kind, avatarUrl: user.avatarUrl ?? null, verifiedEmail: outcome.verifiedEmail };
    },
  };

  return {
    identity,
    appOrigin: config.appOrigin,

    async startLogin(returnTo) {
      const state = randomToken();
      const browserToken = randomToken();
      await store.createLoginAttempt({
        stateHash: sha256(state),
        browserHash: sha256(browserToken),
        returnTo,
        expiresAt: new Date(now().getTime() + LOGIN_ATTEMPT_TTL_SECONDS * 1000).toISOString(),
      });
      const location = new URL(`${config.baseUrl}/auth/login`);
      location.searchParams.set('redirect_uri', `${config.appOrigin}/app/auth/callback`);
      location.searchParams.set('state', state);
      location.searchParams.set('mode', 'redirect');
      return {
        location: location.href,
        setCookies: [serializeCookie(LOGIN_ATTEMPT_COOKIE, browserToken, LOGIN_ATTEMPT_TTL_SECONDS, secure)],
      };
    },

    async completeLogin(input) {
      // Every failure clears the attempt cookie; a consumed or unknown attempt requires a fresh sign-in.
      if (input.attemptToken === undefined || !OPAQUE_TOKEN.test(input.attemptToken)) throw unauthenticated([clearAttempt]);
      const attempt = await store.consumeLoginAttempt({
        stateHash: sha256(input.state),
        browserHash: sha256(input.attemptToken),
        now: now().toISOString(),
      });
      if (attempt === null) throw unauthenticated([clearAttempt]);

      // Signature and claims are verified before any profile field is read.
      const initial = await verifyAccessToken(input.accessToken);
      if (!initial.ok) throw initial.reason === 'unavailable' ? unavailable([clearAttempt]) : unauthenticated([clearAttempt]);

      const rotation = await rotateRefreshToken(input.refreshToken);
      if (rotation.kind === 'rejected') throw unauthenticated([clearAttempt]);
      if (rotation.kind === 'unknown') throw unavailable([clearAttempt]);

      const fresh = await verifyAccessToken(rotation.accessToken);
      if (!fresh.ok) throw fresh.reason === 'unavailable' ? unavailable([clearAttempt]) : unauthenticated([clearAttempt]);
      if (fresh.subject !== initial.subject) throw unauthenticated([clearAttempt]);

      const displayName = displayNameFrom(fresh.name, initial.name);
      const provisioned = await store.provisionIdentity({
        issuer: config.issuer,
        subject: fresh.subject,
        displayName,
        workspaceName: workspaceNameFor(displayName),
        timezone: 'UTC',
        // Only the rotated (fresh) token's verified picture; the callback token may be stale.
        ...(fresh.picture === undefined ? {} : { avatarUrl: fresh.picture }),
      });
      const returnTo = await authorizedReturnTo(attempt.returnTo, provisioned.user.id);

      const sessionToken = randomToken();
      const sessionHash = sha256(sessionToken);
      await store.createSession({
        sessionHash,
        userId: provisioned.user.id,
        encryptedTokens: encryptTokens(key, sessionHash, {
          issuer: config.issuer,
          subject: fresh.subject,
          accessToken: rotation.accessToken,
          refreshToken: rotation.refreshToken,
        }),
        accessExpiresAt: fresh.expiresAt,
        expiresAt: new Date(now().getTime() + SESSION_TTL_SECONDS * 1000).toISOString(),
      });

      return {
        returnTo,
        setCookies: [serializeCookie(SHARED_SESSION_COOKIE, sessionToken, SESSION_TTL_SECONDS, secure), clearAttempt],
      };
    },

    async revokeLocalSession(sessionToken) {
      if (!OPAQUE_TOKEN.test(sessionToken)) return;
      await store.revokeSession(sha256(sessionToken));
    },

    async logout(sessionToken) {
      if (sessionToken === undefined || !OPAQUE_TOKEN.test(sessionToken)) return;
      const sessionHash = sha256(sessionToken);
      const refreshToken = await store.withLockedSession<string | null>(sessionHash, async (record) => {
        if (record === null || record.revokedAt !== null) return { result: null };
        const tokens = decryptTokens(key, sessionHash, record.encryptedTokens);
        return { result: tokens?.refreshToken ?? null, update: { revokedAt: now().toISOString() } };
      });
      // The revoke above has committed; the remote call can never roll it back.
      if (refreshToken !== null) await remoteLogout(refreshToken);
    },

    clearCookies() {
      return [clearSession, clearAttempt];
    },
  };
}
