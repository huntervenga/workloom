import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { and, asc, eq, gt, isNotNull, isNull, lt, sql } from 'drizzle-orm';
import { API_TOKEN_LIMITS, OAUTH_ACCESS_TOKEN_PREFIX, OAUTH_REFRESH_TOKEN_PATTERN, OAUTH_REFRESH_TOKEN_PREFIX, apiTokenScopeSchema, type ApiTokenScope, type OAuthConsentDto } from '@workloom/contracts';
import { isDatabase, type Database, type WorkloomExecutor } from '../client.js';
import { apiTokens, oauthAuthorizationCodes, oauthClients, oauthTokens, users } from '../schema.js';
import { databaseNow, hashApiToken } from './tokens.js';

/**
 * A small OAuth 2.1 authorization server for connected apps (Claude, Codex and other MCP clients).
 * Public clients only: dynamic registration (RFC 7591), authorization code with PKCE S256, rotating
 * refresh tokens. A grant is an api_tokens row, so scopes, role checks, revocation and audit work
 * exactly as for personal access tokens.
 */
export const OAUTH_LIMITS = { codeSeconds: 300, accessSeconds: 3600, refreshDays: 60, grantDays: API_TOKEN_LIMITS.maxDays, redirectUris: 5 } as const;

/** Hosted callback URLs accepted for registration; loopback http callbacks (any port) are accepted too. */
export const OAUTH_HOSTED_REDIRECT_URIS: readonly string[] = [
  'https://claude.ai/api/mcp/auth_callback',
  'https://claude.com/api/mcp/auth_callback',
];
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);
const SCOPES: readonly ApiTokenScope[] = apiTokenScopeSchema.options;

export class OAuthError extends Error {
  override readonly name = 'OAuthError';
  constructor(
    readonly error: 'invalid_request' | 'invalid_client' | 'invalid_grant' | 'unauthorized_client' | 'unsupported_grant_type' | 'invalid_scope' | 'invalid_target' | 'access_denied' | 'invalid_redirect_uri' | 'invalid_client_metadata' | 'unsupported_response_type' | 'server_error',
    readonly description: string,
    /** True when the error may be sent back to the client's redirect URI (client and redirect URI were valid). */
    readonly redirectable = false,
    /** For a redirectable error: the validated redirect URI and the state to return with it. */
    readonly redirect?: { readonly uri: string; readonly state: string | null },
  ) { super(description); }
  get status(): number { return this.error === 'invalid_client' ? 401 : 400; }
}

function parseUrl(value: string): URL | null {
  try { return new URL(value); } catch { return null; }
}

/** Exact hosted callback, or an http loopback callback without credentials or fragment. */
export function isAllowedRedirectUri(value: string): boolean {
  if (value.length > 2048 || /\s/.test(value)) return false;
  if (OAUTH_HOSTED_REDIRECT_URIS.includes(value)) return true;
  const url = parseUrl(value);
  return url !== null && url.protocol === 'http:' && LOOPBACK_HOSTS.has(url.hostname) && url.username === '' && url.password === '' && url.hash === '' && !value.includes('#');
}

/** Exact match; loopback callbacks match on any port (RFC 8252 section 7.3). */
export function redirectUriMatches(registered: string, presented: string): boolean {
  if (registered === presented) return true;
  const a = parseUrl(registered), b = parseUrl(presented);
  if (!a || !b || a.protocol !== 'http:' || b.protocol !== 'http:' || !LOOPBACK_HOSTS.has(a.hostname)) return false;
  return a.hostname === b.hostname && a.pathname === b.pathname && a.search === b.search && b.username === '' && b.password === '' && b.hash === '';
}

const secret = (prefix: string) => `${prefix}${randomBytes(32).toString('base64url')}`;
const pkce = (verifier: string) => createHash('sha256').update(verifier, 'ascii').digest('base64url');
const plainText = (value: string) => !/\p{Cc}/u.test(value);

/** Requested scopes as a sorted known subset; unknown scopes are ignored and an empty request means all scopes. */
export function parseScopes(value: string | undefined): ApiTokenScope[] {
  const requested = (value ?? '').split(' ').filter(Boolean);
  const known = SCOPES.filter(scope => requested.includes(scope));
  return [...(known.length > 0 ? known : SCOPES)].sort();
}

export interface OAuthClient { readonly id: string; readonly name: string; readonly redirectUris: readonly string[]; readonly createdAt: Date }

export interface AuthorizationRequest {
  readonly client: OAuthClient;
  readonly redirectUri: string;
  readonly codeChallenge: string;
  readonly scopes: ApiTokenScope[];
  readonly state: string | null;
}

export interface TokenResponse {
  readonly access_token: string;
  readonly token_type: 'Bearer';
  readonly expires_in: number;
  readonly refresh_token: string;
  readonly scope: string;
}

export interface OAuthApplication {
  registerClient(metadata: unknown): Promise<Record<string, unknown>>;
  /** Validates an authorization query; `resource` is this server's MCP URL. Throws OAuthError. */
  validateAuthorization(query: URLSearchParams, resource: string): Promise<AuthorizationRequest>;
  /** The redirect URL a validated request ends at, with either a fresh code or an error. */
  decide(request: AuthorizationRequest, userId: string, decision: 'approve' | 'deny', issuer: string): Promise<string>;
  consent(request: AuthorizationRequest, userId: string): Promise<OAuthConsentDto>;
  token(form: Readonly<Record<string, string | undefined>>): Promise<TokenResponse>;
  /** RFC 7009: revokes the grant behind an access or refresh token; unknown tokens are ignored. */
  revoke(token: string): Promise<void>;
}

export function createOAuthApplication(source: Database | WorkloomExecutor): OAuthApplication {
  const db = isDatabase(source) ? source.db : source;

  async function findClient(tx: WorkloomExecutor, id: string): Promise<OAuthClient | null> {
    if (!/^wlm_client_[A-Za-z0-9_-]{22}$/.test(id)) return null;
    const [row] = await tx.select().from(oauthClients).where(eq(oauthClients.id, id)).limit(1);
    return row ? { id: row.id, name: row.clientName, redirectUris: row.redirectUris, createdAt: row.createdAt } : null;
  }

  async function issueTokens(tx: WorkloomExecutor, grantId: string, grantExpiresAt: Date, scopes: readonly string[], now: Date): Promise<TokenResponse> {
    const access = secret(OAUTH_ACCESS_TOKEN_PREFIX), refresh = secret(OAUTH_REFRESH_TOKEN_PREFIX);
    const accessExpires = new Date(Math.min(now.getTime() + OAUTH_LIMITS.accessSeconds * 1000, grantExpiresAt.getTime()));
    const refreshExpires = new Date(Math.min(now.getTime() + OAUTH_LIMITS.refreshDays * 86_400_000, grantExpiresAt.getTime()));
    await tx.insert(oauthTokens).values([
      { tokenHash: hashApiToken(access), apiTokenId: grantId, kind: 'access', createdAt: now, expiresAt: accessExpires },
      { tokenHash: hashApiToken(refresh), apiTokenId: grantId, kind: 'refresh', createdAt: now, expiresAt: refreshExpires },
    ]);
    return { access_token: access, token_type: 'Bearer', expires_in: Math.max(1, Math.floor((accessExpires.getTime() - now.getTime()) / 1000)), refresh_token: refresh, scope: [...scopes].sort().join(' ') };
  }

  /** Creates the grant row; re-authorizing the same client replaces its earlier grant, and the oldest app grant yields at the limit. */
  async function createGrant(tx: WorkloomExecutor, client: OAuthClient, userId: string, scopes: readonly string[], now: Date): Promise<{ id: string; expiresAt: Date }> {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${'api-token-issue:' + userId}))`);
    await tx.update(apiTokens).set({ revokedAt: now }).where(and(eq(apiTokens.userId, userId), eq(apiTokens.oauthClientId, client.id), isNull(apiTokens.revokedAt)));
    const active = await tx.select({ id: apiTokens.id, oauth: apiTokens.oauthClientId }).from(apiTokens)
      .where(and(eq(apiTokens.userId, userId), isNull(apiTokens.revokedAt), gt(apiTokens.expiresAt, now))).orderBy(asc(apiTokens.createdAt));
    if (active.length >= API_TOKEN_LIMITS.tokensPerUser) {
      const oldest = active.find(row => row.oauth !== null);
      if (!oldest) throw new OAuthError('access_denied', `You already have ${API_TOKEN_LIMITS.tokensPerUser} active tokens. Revoke one on the Integrations page first.`, true);
      await tx.update(apiTokens).set({ revokedAt: now }).where(eq(apiTokens.id, oldest.id));
    }
    const id = randomUUID(), expiresAt = new Date(now.getTime() + OAUTH_LIMITS.grantDays * 86_400_000);
    // The row's own token hash belongs to a secret that is never shown, so the grant itself is never a usable bearer.
    await tx.insert(apiTokens).values({
      id, userId, name: client.name.slice(0, 100), tokenHash: hashApiToken(secret('wlm_grant_')), tokenPrefix: 'wlm_oauth',
      scopes: [...scopes], workspaceIds: null, createdAt: now, expiresAt, oauthClientId: client.id,
    });
    return { id, expiresAt };
  }

  return {
    async registerClient(metadata) {
      if (typeof metadata !== 'object' || metadata === null || Array.isArray(metadata)) throw new OAuthError('invalid_client_metadata', 'Send the client metadata as a JSON object.');
      const m = metadata as Record<string, unknown>;
      const uris = m['redirect_uris'];
      if (!Array.isArray(uris) || uris.length === 0 || uris.length > OAUTH_LIMITS.redirectUris || !uris.every((uri): uri is string => typeof uri === 'string')) throw new OAuthError('invalid_redirect_uri', `Send 1 to ${OAUTH_LIMITS.redirectUris} redirect_uris.`);
      const rejected = uris.filter(uri => !isAllowedRedirectUri(uri));
      if (rejected.length > 0) throw new OAuthError('invalid_redirect_uri', `Redirect URI not allowed: ${rejected[0]?.slice(0, 200)}. Allowed: ${OAUTH_HOSTED_REDIRECT_URIS.join(', ')} or an http loopback address.`);
      const method = m['token_endpoint_auth_method'];
      if (method !== undefined && method !== 'none') throw new OAuthError('invalid_client_metadata', 'Only public clients are supported: token_endpoint_auth_method must be "none".');
      const grants = m['grant_types'], responses = m['response_types'];
      if (grants !== undefined && (!Array.isArray(grants) || !grants.every(grant => grant === 'authorization_code' || grant === 'refresh_token'))) throw new OAuthError('invalid_client_metadata', 'Supported grant_types: authorization_code, refresh_token.');
      if (responses !== undefined && (!Array.isArray(responses) || !responses.every(response => response === 'code'))) throw new OAuthError('invalid_client_metadata', 'Supported response_types: code.');
      const rawName = typeof m['client_name'] === 'string' ? m['client_name'].trim() : '';
      const name = rawName !== '' && rawName.length <= 200 && plainText(rawName) ? rawName : 'MCP client';
      const id = `wlm_client_${randomBytes(16).toString('base64url')}`;
      const createdAt = await databaseNow(db);
      const redirectUris = [...new Set(uris)];
      await db.insert(oauthClients).values({ id, clientName: name, redirectUris, createdAt });
      return {
        client_id: id, client_id_issued_at: Math.floor(createdAt.getTime() / 1000), client_name: name, redirect_uris: redirectUris,
        grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: 'none',
      };
    },

    async validateAuthorization(query, resource) {
      const one = (key: string) => { const values = query.getAll(key); if (values.length > 1) throw new OAuthError('invalid_request', `Send ${key} once.`); return values[0]; };
      const client = await findClient(db, one('client_id') ?? '');
      if (!client) throw new OAuthError('invalid_client', 'Unknown client. Register the client again.');
      const presented = one('redirect_uri');
      const redirectUri = presented === undefined ? (client.redirectUris.length === 1 ? client.redirectUris[0] : undefined) : client.redirectUris.find(uri => redirectUriMatches(uri, presented)) && presented;
      if (!redirectUri) throw new OAuthError('invalid_request', 'The redirect_uri is not registered for this client.');
      const state = one('state') ?? null;
      if (state !== null && (state.length > 1024 || !plainText(state))) throw new OAuthError('invalid_request', 'The state parameter is too long.');
      const fail = (error: OAuthError['error'], description: string) => new OAuthError(error, description, true, { uri: redirectUri, state });
      if (one('response_type') !== 'code') throw fail('unsupported_response_type', 'Only response_type=code is supported.');
      const challenge = one('code_challenge') ?? '';
      if (one('code_challenge_method') !== 'S256' || !/^[A-Za-z0-9_-]{43}$/.test(challenge)) throw fail('invalid_request', 'PKCE with code_challenge_method=S256 is required.');
      const requestedResource = one('resource');
      if (requestedResource !== undefined && requestedResource.replace(/\/$/, '') !== resource) throw fail('invalid_target', `This server issues tokens for ${resource} only.`);
      return { client, redirectUri, codeChallenge: challenge, scopes: parseScopes(one('scope')), state };
    },

    async consent(request, userId) {
      const [user] = await db.select({ displayName: users.displayName }).from(users).where(eq(users.id, userId)).limit(1);
      const url = parseUrl(request.redirectUri);
      return { client: { id: request.client.id, name: request.client.name, redirectUri: request.redirectUri, redirectHost: url?.host ?? request.redirectUri }, scopes: request.scopes, user: { displayName: user?.displayName ?? '' } };
    },

    async decide(request, userId, decision, issuer) {
      const target = new URL(request.redirectUri);
      if (request.state !== null) target.searchParams.set('state', request.state);
      target.searchParams.set('iss', issuer);
      if (decision === 'deny') {
        target.searchParams.set('error', 'access_denied');
        target.searchParams.set('error_description', 'The user declined the connection.');
        return target.toString();
      }
      const code = randomBytes(32).toString('base64url');
      const now = await databaseNow(db);
      await db.insert(oauthAuthorizationCodes).values({
        codeHash: hashApiToken(code), clientId: request.client.id, userId, redirectUri: request.redirectUri, codeChallenge: request.codeChallenge,
        scopes: request.scopes, createdAt: now, expiresAt: new Date(now.getTime() + OAUTH_LIMITS.codeSeconds * 1000),
      });
      target.searchParams.set('code', code);
      return target.toString();
    },

    async token(form) {
      const grantType = form['grant_type'];
      const clientId = form['client_id'] ?? '';
      if (grantType !== 'authorization_code' && grantType !== 'refresh_token') throw new OAuthError('unsupported_grant_type', 'Supported grant types: authorization_code, refresh_token.');
      // A known rejection that must keep its side effect (revoking a replayed code's grant) is returned, committed, then thrown.
      const outcome = await db.transaction(async (tx): Promise<TokenResponse | OAuthError> => {
        const client = await findClient(tx, clientId);
        if (!client) throw new OAuthError('invalid_client', 'Unknown client_id.');
        const now = await databaseNow(tx);
        await tx.update(oauthClients).set({ lastUsedAt: now }).where(eq(oauthClients.id, client.id));
        if (grantType === 'authorization_code') {
          const code = form['code'] ?? '', verifier = form['code_verifier'] ?? '', redirectUri = form['redirect_uri'];
          if (!/^[A-Za-z0-9._~-]{43,128}$/.test(verifier)) throw new OAuthError('invalid_request', 'A PKCE code_verifier is required.');
          const [row] = await tx.select().from(oauthAuthorizationCodes).where(eq(oauthAuthorizationCodes.codeHash, hashApiToken(code))).for('update').limit(1);
          if (!row || row.clientId !== client.id) throw new OAuthError('invalid_grant', 'The authorization code is not valid.');
          if (row.usedAt !== null) {
            // A replayed code may be stolen: withdraw everything issued from it.
            if (row.apiTokenId) await tx.update(apiTokens).set({ revokedAt: now }).where(and(eq(apiTokens.id, row.apiTokenId), isNull(apiTokens.revokedAt)));
            return new OAuthError('invalid_grant', 'The authorization code was already used.');
          }
          if (row.expiresAt.getTime() <= now.getTime()) throw new OAuthError('invalid_grant', 'The authorization code expired. Start the connection again.');
          if (redirectUri !== undefined && redirectUri !== row.redirectUri) throw new OAuthError('invalid_grant', 'redirect_uri does not match the authorization request.');
          if (pkce(verifier) !== row.codeChallenge) throw new OAuthError('invalid_grant', 'The code_verifier does not match.');
          const grant = await createGrant(tx, client, row.userId, row.scopes, now);
          await tx.update(oauthAuthorizationCodes).set({ usedAt: now, apiTokenId: grant.id }).where(eq(oauthAuthorizationCodes.codeHash, row.codeHash));
          await tx.delete(oauthAuthorizationCodes).where(lt(oauthAuthorizationCodes.expiresAt, new Date(now.getTime() - 86_400_000)));
          return issueTokens(tx, grant.id, grant.expiresAt, row.scopes, now);
        }
        const refresh = form['refresh_token'] ?? '';
        if (!OAUTH_REFRESH_TOKEN_PATTERN.test(refresh)) throw new OAuthError('invalid_grant', 'The refresh token is not valid.');
        const [row] = await tx.select({ token: oauthTokens, grant: apiTokens }).from(oauthTokens).innerJoin(apiTokens, eq(apiTokens.id, oauthTokens.apiTokenId))
          .where(and(eq(oauthTokens.tokenHash, hashApiToken(refresh)), eq(oauthTokens.kind, 'refresh'))).for('update', { of: oauthTokens }).limit(1);
        if (!row || row.grant.oauthClientId !== client.id || row.token.usedAt !== null || row.token.expiresAt.getTime() <= now.getTime()
          || row.grant.revokedAt !== null || row.grant.expiresAt.getTime() <= now.getTime()) throw new OAuthError('invalid_grant', 'The refresh token is not valid. Connect the app again.');
        await tx.update(oauthTokens).set({ usedAt: now }).where(eq(oauthTokens.tokenHash, row.token.tokenHash));
        await tx.delete(oauthTokens).where(and(eq(oauthTokens.apiTokenId, row.grant.id), lt(oauthTokens.expiresAt, now)));
        await tx.delete(oauthTokens).where(and(eq(oauthTokens.apiTokenId, row.grant.id), eq(oauthTokens.kind, 'refresh'), isNotNull(oauthTokens.usedAt), lt(oauthTokens.usedAt, new Date(now.getTime() - 86_400_000))));
        return issueTokens(tx, row.grant.id, row.grant.expiresAt, row.grant.scopes, now);
      });
      if (outcome instanceof OAuthError) throw outcome;
      return outcome;
    },

    async revoke(token) {
      if (token.length === 0 || token.length > 256) return;
      await db.transaction(async tx => {
        const [row] = await tx.select({ grantId: oauthTokens.apiTokenId }).from(oauthTokens).where(eq(oauthTokens.tokenHash, hashApiToken(token))).limit(1);
        if (row) await tx.update(apiTokens).set({ revokedAt: await databaseNow(tx) }).where(and(eq(apiTokens.id, row.grantId), isNull(apiTokens.revokedAt)));
      });
    },
  };
}
