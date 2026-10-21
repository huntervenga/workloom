import { randomBytes, randomUUID } from 'node:crypto';
import type { Actor, TeamApplication } from '@workloom/domain';
import Fastify, { type LightMyRequestResponse } from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import { SessionKey, type SharedAuthConfig } from '../config.js';
import { createInvitationHandoff, INVITATION_HANDOFF_COOKIE } from '../identity/invitation-handoff.js';
import { LOGIN_ATTEMPT_COOKIE, SHARED_SESSION_COOKIE, type SharedAuthService } from '../identity/shared-auth.js';
import { registerSharedAuthRoutes } from './auth-routes.js';
import { mapError } from './errors.js';
const origin = 'https://workloom.test';
const token = () => randomBytes(32).toString('base64url');
const header = (response: LightMyRequestResponse) => response.cookies.map(c => `${c.name}=${c.value}`).join('; ');
const config: SharedAuthConfig = { baseUrl: 'https://auth.test', issuer: 'https://auth.test', audience: 'workloom', jwksUrl: 'https://auth.test/keys', appOrigin: origin, secureCookies: true, sessionKey: new SessionKey(Buffer.alloc(32, 7)) };
function setup() {
  const app = Fastify({ logger: false });
  app.setErrorHandler((error, request, reply) => { const mapped = mapError(error); void reply.code(mapped.statusCode).send({ ...mapped.body, meta: { requestId: request.id } }); });
  const attempt = token(), session = token();
  const actor: Actor = { userId: randomUUID(), displayName: 'Ada', kind: 'real', verifiedEmail: 'ada@company.test' };
  const result = { workspaceId: randomUUID(), membershipId: randomUUID() };
  const acceptInvitation = vi.fn<TeamApplication['acceptInvitation']>(async () => result);
  const service = {
    appOrigin: origin,
    startLogin: vi.fn(async () => ({ location: `https://auth.test/auth/login?redirect_uri=${encodeURIComponent(origin + '/app/auth/callback')}&state=opaque-state`, setCookies: [`${LOGIN_ATTEMPT_COOKIE}=${attempt}; HttpOnly`] })),
    completeLogin: vi.fn(async () => ({ returnTo: '/app/join', setCookies: [`${SHARED_SESSION_COOKIE}=${session}; HttpOnly`, `${LOGIN_ATTEMPT_COOKIE}=; Max-Age=0`] })),
    revokeLocalSession: vi.fn(async () => undefined),
    logout: vi.fn(async () => undefined), clearCookies: () => [`${SHARED_SESSION_COOKIE}=; Max-Age=0`],
    identity: { mode: 'shared', resolveActor: vi.fn(async () => actor) },
  } as unknown as SharedAuthService;
  registerSharedAuthRoutes(app, { service, invitationHandoff: createInvitationHandoff(config), team: { acceptInvitation } as unknown as TeamApplication });
  return { app, attempt, session, actor, result, acceptInvitation, service };
}

describe('invitation handoff BFF routes', () => {
  it('resumes explicit join intent after OAuth with no secret in returnTo/provider and supports exact retry before acknowledgement', async () => {
    const { app, attempt, session, actor, acceptInvitation, result, service } = setup();
    try {
      const input = { invitationId: randomUUID(), secret: token() };
      const staged = await app.inject({ method: 'POST', url: '/api/v1/auth/invitation-handoff', headers: { origin }, payload: input });
      expect(staged.statusCode).toBe(204); expect(staged.body).toBe('');
      const login = await app.inject({ method: 'GET', url: '/api/v1/auth/login?returnTo=%2Fapp%2Fjoin', headers: { cookie: header(staged) } });
      expect(login.statusCode).toBe(302);
      expect(login.headers.location).not.toContain(input.secret);
      expect(login.headers.location).not.toContain(input.invitationId);
      expect(service.startLogin).toHaveBeenCalledWith('/app/join');
      const completed = await app.inject({ method: 'POST', url: '/api/v1/auth/session', headers: { origin, cookie: header(login) }, payload: { accessToken: 'synthetic-access-token', refreshToken: 'synthetic-refresh-token', state: 'state' } });
      expect(completed.statusCode).toBe(200);
      expect(completed.json().data.returnTo).toBe('/app/join?resume=1');
      const cookie = header(completed);
      expect(cookie).toContain(`${SHARED_SESSION_COOKIE}=${session}`);
      expect(cookie).not.toContain(input.secret);
      expect(cookie).not.toContain(attempt);
      const key = randomUUID();
      const request = { method: 'POST' as const, url: '/api/v1/auth/invitation-handoff/accept', headers: { origin, cookie, 'x-workloom-actor-id': actor.userId, 'idempotency-key': key }, payload: {} };
      const accepted = await app.inject(request);
      expect(accepted.statusCode).toBe(200); expect(accepted.json().data).toEqual(result);
      expect(accepted.cookies).toHaveLength(0);
      expect(acceptInvitation).toHaveBeenCalledWith(expect.objectContaining({ actor, idempotencyKey: key }), input);
      // A lost body may leave browser cookies processed; retry still sends the same credential/key.
      expect((await app.inject(request)).statusCode).toBe(200);
      expect(acceptInvitation.mock.calls[1]?.[0]).toMatchObject({ actor, idempotencyKey: key });
      expect(acceptInvitation.mock.calls[1]?.[1]).toEqual(input);
      const acknowledged = await app.inject({ method: 'POST', url: '/api/v1/auth/invitation-handoff/clear', headers: { origin, cookie }, payload: {} });
      expect(acknowledged.statusCode).toBe(204); expect(String(acknowledged.headers['set-cookie'])).toContain(`${INVITATION_HANDOFF_COOKIE}=;`);
    } finally { await app.close(); }
  });
  it('requires canonical Origin, current session binding, actor intent and idempotency key', async () => {
    const { app, actor } = setup();
    try {
      const input = { invitationId: randomUUID(), secret: token() };
      expect((await app.inject({ method: 'POST', url: '/api/v1/auth/invitation-handoff', payload: input })).statusCode).toBe(403);
      const stage = await app.inject({ method: 'POST', url: '/api/v1/auth/invitation-handoff', headers: { origin }, payload: input });
      const headers = { origin, cookie: header(stage), 'x-workloom-actor-id': actor.userId, 'idempotency-key': randomUUID() };
      const request = { method: 'POST' as const, url: '/api/v1/auth/invitation-handoff/accept', headers, payload: {} };
      expect((await app.inject(request)).statusCode).toBe(404); // stage cannot act as ready
      expect((await app.inject({ ...request, headers: { ...headers, 'x-workloom-actor-id': randomUUID() } })).statusCode).toBe(409);
      expect((await app.inject({ ...request, headers: { ...headers, 'idempotency-key': '' } })).statusCode).toBe(400);
      expect((await app.inject({ ...request, headers: { ...headers, origin: 'https://evil.test' } })).statusCode).toBe(403);
    } finally { await app.close(); }
  });
  it('never upgrades an unbound cookie and clears the capability on logout', async () => {
    const { app } = setup();
    try {
      const completed = await app.inject({ method: 'POST', url: '/api/v1/auth/session', headers: { origin }, payload: { accessToken: 'access', refreshToken: 'refresh', state: 'state' } });
      expect(completed.json().data.returnTo).toBe('/app/join');
      expect(String(completed.headers['set-cookie'])).toContain(`${INVITATION_HANDOFF_COOKIE}=;`);
      const logout = await app.inject({ method: 'POST', url: '/api/v1/auth/logout', headers: { origin }, payload: {} });
      expect(logout.statusCode).toBe(204); expect(String(logout.headers['set-cookie'])).toContain(`${INVITATION_HANDOFF_COOKIE}=;`);
    } finally { await app.close(); }
  });
});
