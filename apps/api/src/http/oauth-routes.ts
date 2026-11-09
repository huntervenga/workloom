import { apiTokenScopeSchema, envelopeSchema, oauthConsentSchema, oauthDecisionInputSchema, oauthDecisionSchema } from '@workloom/contracts';
import { OAuthError, type OAuthApplication } from '@workloom/db';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { IdentityAdapter } from '../identity/identity-adapter.js';
import { parseInput, sendData } from './envelope.js';
import { HttpError } from './errors.js';
import { createRateLimiter } from './rate-limit.js';

export interface OAuthRouteDependencies {
  readonly oauth: OAuthApplication;
  readonly identity: IdentityAdapter;
  /** Public origin of this server, e.g. https://workloom.example.com; the issuer and the base of every endpoint. */
  readonly issuer: () => string;
}

export const OAUTH_RESOURCE_PATH = '/mcp';
export const protectedResourceMetadataUrl = (issuer: string) => `${issuer}/.well-known/oauth-protected-resource${OAUTH_RESOURCE_PATH}`;
const SCOPES = apiTokenScopeSchema.options;

function sendOAuthError(reply: FastifyReply, error: OAuthError): FastifyReply {
  return reply.code(error.status).header('cache-control', 'no-store').type('application/json').send({ error: error.error, error_description: error.description });
}

function queryOf(request: FastifyRequest): URLSearchParams {
  const index = request.url.indexOf('?');
  return new URLSearchParams(index === -1 ? '' : request.url.slice(index + 1));
}

/** Flat form fields; a repeated field is refused rather than guessed. */
function formFields(body: unknown): Record<string, string | undefined> {
  if (typeof body !== 'object' || body === null) return {};
  const out: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(body as Record<string, unknown>)) {
    if (typeof value !== 'string') throw new OAuthError('invalid_request', `Send ${key} once.`);
    out[key] = value;
  }
  return out;
}

/** Public clients may still send their id as HTTP Basic credentials with an empty secret. */
function basicClientId(request: FastifyRequest): string | undefined {
  const header = request.headers.authorization;
  if (typeof header !== 'string' || !header.startsWith('Basic ')) return undefined;
  try {
    const decoded = Buffer.from(header.slice(6), 'base64').toString('utf8');
    const id = decodeURIComponent(decoded.split(':', 1)[0] ?? '');
    return id === '' ? undefined : id;
  } catch { return undefined; }
}

function redirectWithError(redirectUri: string, error: OAuthError, state: string | null, issuer: string): string {
  const target = new URL(redirectUri);
  target.searchParams.set('error', error.error);
  target.searchParams.set('error_description', error.description);
  if (state !== null) target.searchParams.set('state', state);
  target.searchParams.set('iss', issuer);
  return target.toString();
}

/**
 * OAuth 2.1 for connected apps: discovery metadata, dynamic client registration, the authorization redirect,
 * the token and revocation endpoints (all server-to-server, no cookies), plus two session endpoints the
 * in-app consent page uses. The consent decision is a normal same-origin POST protected by the Origin guard.
 */
export function registerOAuthRoutes(app: FastifyInstance, deps: OAuthRouteDependencies): void {
  const { oauth } = deps;
  const resource = () => `${deps.issuer()}${OAUTH_RESOURCE_PATH}`;
  const registrations = createRateLimiter({ limit: 20, windowMs: 60_000 });

  const protectedResource = async (_request: FastifyRequest, reply: FastifyReply) => reply.header('cache-control', 'public, max-age=300').send({
    resource: resource(), authorization_servers: [deps.issuer()], scopes_supported: SCOPES, bearer_methods_supported: ['header'],
    resource_name: 'Workloom', resource_documentation: `${deps.issuer()}/docs#mcp`,
  });
  app.get('/.well-known/oauth-protected-resource', protectedResource);
  app.get(`/.well-known/oauth-protected-resource${OAUTH_RESOURCE_PATH}`, protectedResource);
  app.get('/.well-known/oauth-authorization-server', async (_request, reply) => {
    const issuer = deps.issuer();
    return reply.header('cache-control', 'public, max-age=300').send({
      issuer, authorization_endpoint: `${issuer}/oauth/authorize`, token_endpoint: `${issuer}/oauth/token`,
      registration_endpoint: `${issuer}/oauth/register`, revocation_endpoint: `${issuer}/oauth/revoke`,
      response_types_supported: ['code'], grant_types_supported: ['authorization_code', 'refresh_token'],
      code_challenge_methods_supported: ['S256'], token_endpoint_auth_methods_supported: ['none'],
      revocation_endpoint_auth_methods_supported: ['none'], scopes_supported: SCOPES, service_documentation: `${issuer}/docs#mcp`,
    });
  });

  app.post('/oauth/register', { bodyLimit: 16 * 1024 }, async (request, reply) => {
    const decision = registrations.check(request.ip);
    if (!decision.allowed) return reply.code(429).header('retry-after', String(decision.retryAfterSeconds)).send({ error: 'invalid_request', error_description: 'Too many registrations. Wait a moment.' });
    try {
      return reply.code(201).header('cache-control', 'no-store').send(await oauth.registerClient(request.body));
    } catch (error) {
      if (error instanceof OAuthError) return sendOAuthError(reply, error);
      throw error;
    }
  });

  app.get('/oauth/authorize', async (request, reply) => {
    const query = queryOf(request);
    try {
      await oauth.validateAuthorization(query, resource());
    } catch (error) {
      if (!(error instanceof OAuthError)) throw error;
      // Without a validated client and redirect URI the error is shown here, never sent to an unverified address.
      if (!error.redirectable || !error.redirect) return reply.code(400).type('text/plain; charset=utf-8').send(`This connection request cannot be completed: ${error.description}`);
      return reply.redirect(redirectWithError(error.redirect.uri, error, error.redirect.state, deps.issuer()), 302);
    }
    // The consent page runs inside the app, so an unsigned visitor signs in first and returns here.
    return reply.redirect(`/app/connect?${query.toString()}`, 302);
  });

  // The token and revocation endpoints take application/x-www-form-urlencoded bodies (RFC 6749); the parser stays local to them.
  void app.register(async scope => {
    scope.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string', bodyLimit: 16 * 1024 }, (_request, body, done) => {
      const params = new URLSearchParams(typeof body === 'string' ? body : body.toString('utf8'));
      const out: Record<string, string | string[]> = {};
      for (const key of new Set(params.keys())) { const all = params.getAll(key); out[key] = all.length === 1 ? all[0] ?? '' : all; }
      done(null, out);
    });
    scope.post('/oauth/token', async (request, reply) => {
      try {
        const form = formFields(request.body);
        const clientId = form['client_id'] ?? basicClientId(request);
        const result = await oauth.token({ ...form, client_id: clientId });
        return reply.header('cache-control', 'no-store').header('pragma', 'no-cache').send(result);
      } catch (error) {
        if (error instanceof OAuthError) return sendOAuthError(reply, error);
        throw error;
      }
    });
    scope.post('/oauth/revoke', async (request, reply) => {
      try {
        await oauth.revoke(formFields(request.body)['token'] ?? '');
        return reply.code(200).header('cache-control', 'no-store').send({});
      } catch (error) {
        if (error instanceof OAuthError) return sendOAuthError(reply, error);
        throw error;
      }
    });
  });

  const pending = async (raw: string) => {
    try {
      return await oauth.validateAuthorization(new URLSearchParams(raw), resource());
    } catch (error) {
      if (error instanceof OAuthError) throw new HttpError(400, 'VALIDATION_FAILED', error.description, { reason: error.error });
      throw error;
    }
  };
  app.get('/api/v1/oauth/authorize', async (request, reply) => {
    const actor = await deps.identity.resolveActor(request);
    const authorization = await pending(queryOf(request).toString());
    return sendData(request, reply, envelopeSchema(oauthConsentSchema), await oauth.consent(authorization, actor.userId));
  });
  app.post('/api/v1/oauth/authorize', async (request, reply) => {
    const actor = await deps.identity.resolveActor(request);
    const input = parseInput(oauthDecisionInputSchema, request.body);
    const authorization = await pending(input.request);
    const redirectTo = await oauth.decide(authorization, actor.userId, input.decision, deps.issuer());
    return sendData(request, reply, envelopeSchema(oauthDecisionSchema), { redirectTo });
  });
}

export const isOAuthServerPath = (path: string) => path.startsWith('/oauth/') || path.startsWith('/.well-known/');
