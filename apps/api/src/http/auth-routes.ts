import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';

import { readCookie } from '../identity/dev-sessions.js';
import type { IdentityAdapter } from '../identity/identity-adapter.js';
import { LOGIN_ATTEMPT_COOKIE, SHARED_SESSION_COOKIE, type SharedAuthService } from '../identity/shared-auth.js';
import { parseInput } from './envelope.js';
import { HttpError } from './errors.js';

const JSON_TYPE = 'application/json; charset=utf-8';
const RETURN_TO_MAX_LENGTH = 2048;
const DEFAULT_RETURN_TO = '/app';

const sessionBodySchema = z
  .object({
    accessToken: z.string().min(1).max(8192),
    refreshToken: z.string().min(1).max(4096),
    state: z.string().min(1).max(512),
  })
  .strict();

const logoutBodySchema = z.object({}).strict().optional();

function invalidReturnTo(): HttpError {
  return new HttpError(400, 'VALIDATION_FAILED', 'returnTo must be a local /app path.');
}

/** True when any UTF-16 code unit is C0 (U+0000..U+001F), DEL or C1 (U+007F..U+009F). */
function hasControlChar(value: string): boolean {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code <= 0x1f || (code >= 0x7f && code <= 0x9f)) return true;
  }
  return false;
}

/**
 * Accepts only same-origin paths inside the /app boundary (query and fragment
 * allowed). Rejects protocol-relative, backslash, control and encoded-control
 * forms and anything that resolves outside /app. Returns the normalized path.
 */
export function normalizeReturnTo(value: string, appOrigin: string): string | null {
  if (value.length === 0 || value.length > RETURN_TO_MAX_LENGTH) return null;
  if (!/^\/app(?:[/?#]|$)/.test(value)) return null;
  if (
    value.includes('//') ||
    value.includes('\\') ||
    hasControlChar(value) ||
    /%(?:[01][0-9a-f]|7f|5c)/i.test(value)
  ) {
    return null;
  }
  let url: URL;
  try {
    url = new URL(value, appOrigin);
  } catch {
    return null;
  }
  if (url.origin !== appOrigin || url.username !== '' || url.password !== '') return null;
  if (url.pathname !== '/app' && !url.pathname.startsWith('/app/')) return null;
  const normalized = `${url.pathname}${url.search}${url.hash}`;
  return normalized.length <= RETURN_TO_MAX_LENGTH ? normalized : null;
}

/** Strict login query: only one optional returnTo; unknown or repeated keys are refused. */
function parseLoginQuery(url: string, appOrigin: string): string {
  const queryIndex = url.indexOf('?');
  const rawQuery = queryIndex === -1 ? '' : url.slice(queryIndex + 1);
  if (rawQuery === '') return DEFAULT_RETURN_TO;
  if (rawQuery.length > RETURN_TO_MAX_LENGTH * 3 + 16) throw invalidReturnTo();
  const params = new URLSearchParams(rawQuery);
  const keys = [...params.keys()];
  const returnTo = params.get('returnTo');
  if (keys.length !== 1 || keys[0] !== 'returnTo' || returnTo === null) throw invalidReturnTo();
  const normalized = normalizeReturnTo(returnTo, appOrigin);
  if (normalized === null) throw invalidReturnTo();
  return normalized;
}

/** In addition to the global Origin/Fetch-Metadata guard, Auth mutations must come from the canonical app origin. */
function assertCanonicalOrigin(request: FastifyRequest, appOrigin: string): void {
  if (request.headers.origin !== appOrigin) {
    throw new HttpError(403, 'ORIGIN_NOT_ALLOWED', 'Sign-in requests must come from the Workloom app origin.');
  }
}

/** Public, tokenless: tells the web app which identity mode is active. Registered in every mode. */
export function registerAuthConfigRoute(app: FastifyInstance, authMode: IdentityAdapter['mode']): void {
  app.get('/api/v1/auth/config', async (request, reply) =>
    reply.type(JSON_TYPE).send({ data: { authMode }, meta: { requestId: request.id } }),
  );
}

/** Shared Auth BFF endpoints. Registered only for AUTH_MODE=shared. Tokens are never returned or logged. */
export function registerSharedAuthRoutes(app: FastifyInstance, deps: { readonly service: SharedAuthService }): void {
  const { service } = deps;

  app.get('/api/v1/auth/login', async (request, reply) => {
    const returnTo = parseLoginQuery(request.url, service.appOrigin);
    const login = await service.startLogin(returnTo);
    return reply.code(302).header('set-cookie', [...login.setCookies]).header('location', login.location).send();
  });

  app.post('/api/v1/auth/session', async (request, reply) => {
    assertCanonicalOrigin(request, service.appOrigin);
    const body = parseInput(sessionBodySchema, request.body);
    const result = await service.completeLogin({
      attemptToken: readCookie(request.headers.cookie, LOGIN_ATTEMPT_COOKIE),
      accessToken: body.accessToken,
      refreshToken: body.refreshToken,
      state: body.state,
    });

    // Replace a prior local session only after the new one exists.
    const previous = readCookie(request.headers.cookie, SHARED_SESSION_COOKIE);
    if (previous !== undefined) {
      try {
        await service.revokeLocalSession(previous);
      } catch {
        request.log.warn({ event: 'shared_auth_previous_session_revoke_failed' }, 'previous local session could not be revoked');
      }
    }
    request.log.info({ event: 'shared_auth_session_created' }, 'shared Auth session created');
    return reply
      .code(200)
      .header('set-cookie', [...result.setCookies])
      .type(JSON_TYPE)
      .send({ data: { returnTo: result.returnTo }, meta: { requestId: request.id } });
  });

  app.post('/api/v1/auth/logout', async (request, reply) => {
    assertCanonicalOrigin(request, service.appOrigin);
    parseInput(logoutBodySchema, request.body);
    await service.logout(readCookie(request.headers.cookie, SHARED_SESSION_COOKIE));
    request.log.info({ event: 'shared_auth_logout' }, 'shared Auth logout');
    return reply.code(204).header('set-cookie', [...service.clearCookies()]).send();
  });
}
