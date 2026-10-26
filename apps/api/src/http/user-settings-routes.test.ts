import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { unauthenticatedError, type UserSettingsApplication } from '@workloom/domain';
import { registerUserSettingsRoutes } from './user-settings-routes.js';
import { mapError } from './errors.js';
const actor = { userId: 'aa000000-0000-4000-8000-000000000001', displayName: 'Person', kind: 'real' as const };
const initial = { userId: actor.userId, revision: 0, settings: { version: 1 as const, theme: 'default' as const }, updatedAt: null };
const apps: FastifyInstance[] = [];
afterEach(async () => { await Promise.all(apps.splice(0).map(app => app.close())); });
async function harness() {
  const app = Fastify(); apps.push(app);
  app.setErrorHandler((error, _request, reply) => { const mapped = mapError(error); return reply.code(mapped.statusCode).send(mapped.body); });
  const settings = { get: vi.fn<UserSettingsApplication['get']>(async () => initial), update: vi.fn<UserSettingsApplication['update']>(async () => initial) };
  const identity = { mode: 'shared' as const, resolveActor: vi.fn(async () => actor) };
  registerUserSettingsRoutes(app, { identity, settings }); await app.ready(); return { app, settings, identity };
}
describe('self-only user settings routes', () => {
  it('uses the session actor for reads and versioned changes', async () => {
    const { app, settings } = await harness();
    expect((await app.inject('/api/v1/me/settings')).json().data).toEqual(initial);
    const body = { expectedUserId: actor.userId, expectedRevision: 0, settings: { theme: 'dark' } };
    expect((await app.inject({ method: 'PATCH', url: '/api/v1/me/settings', payload: body })).statusCode).toBe(200);
    expect(settings.update).toHaveBeenCalledWith(expect.objectContaining({ actor, source: 'web' }), body);
  });
  it('does not accept other identities, arbitrary JSON, themes or revisionless updates', async () => {
    const { app, settings } = await harness();
    expect((await app.inject('/api/v1/me/settings?userId=other')).statusCode).toBe(400);
    for (const payload of [{ theme: 'dark' }, { expectedUserId: actor.userId, expectedRevision: 0, settings: { theme: 'blue' } }, { expectedUserId: actor.userId, expectedRevision: 0, settings: { theme: 'dark' }, userId: actor.userId }]) {
      expect((await app.inject({ method: 'PATCH', url: '/api/v1/me/settings', payload })).statusCode).toBe(400);
    }
    expect(settings.update).not.toHaveBeenCalled(); expect(settings.get).not.toHaveBeenCalled();
    expect((await app.inject(`/api/v1/users/${actor.userId}/settings`)).statusCode).toBe(404);
  });
  it('rejects unauthenticated reads and writes before calling the service', async () => {
    const { app, settings, identity } = await harness(); identity.resolveActor.mockRejectedValue(unauthenticatedError());
    expect((await app.inject('/api/v1/me/settings')).statusCode).toBe(401);
    expect((await app.inject({ method: 'PATCH', url: '/api/v1/me/settings', payload: {} })).statusCode).toBe(401);
    expect(settings.get).not.toHaveBeenCalled(); expect(settings.update).not.toHaveBeenCalled();
  });
});
