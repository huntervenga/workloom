import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { notFoundError, type PersonalTablePreferenceApplication } from '@workloom/domain';
import { registerPersonalTablePreferenceRoutes } from './table-preferences-routes.js';
import { mapError } from './errors.js';
const id = (n: number) => `af000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const actor = { userId: id(2), displayName: 'Trusted viewer', kind: 'fixture' as const };
const initial = { workspaceId: id(1), projectId: id(4), membershipId: id(3), revision: 0, columns: null };
const path = `/api/v1/workspaces/${id(1)}/projects/${id(4)}/table-preferences/me`;
const apps: FastifyInstance[] = [];
afterEach(async () => { await Promise.all(apps.splice(0).map(app => app.close())); });
async function harness() {
  const app = Fastify(); apps.push(app);
  app.setErrorHandler((error, _request, reply) => { const mapped = mapError(error); return reply.code(mapped.statusCode).send(mapped.body); });
  const preferences = { getPreference: vi.fn<PersonalTablePreferenceApplication['getPreference']>(async () => initial), setPreference: vi.fn<PersonalTablePreferenceApplication['setPreference']>(async () => ({ ...initial, revision: 1 })) };
  registerPersonalTablePreferenceRoutes(app, { identity: { mode: 'dev', resolveActor: async () => actor }, preferences }); await app.ready(); return { app, preferences };
}
describe('personal table preference HTTP contract', () => {
  it('uses trusted identity and canonical path for absent GET without a write', async () => {
    const { app, preferences } = await harness();
    const reply = await app.inject(path.replace(id(1), id(1).toUpperCase()).replace(id(4), id(4).toUpperCase()));
    expect(reply.statusCode).toBe(200); expect(reply.json()).toMatchObject({ data: initial });
    expect(preferences.getPreference).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: id(1), actor, source: 'web' }), id(4)); expect(preferences.setPreference).not.toHaveBeenCalled();
  });
  it('passes an explicit versioned reset and operation key without selecting another actor', async () => {
    const { app, preferences } = await harness();
    const reply = await app.inject({ method: 'PUT', url: path, headers: { 'idempotency-key': 'exact-reset' }, payload: { expectedRevision: 0, columns: null } });
    expect(reply.statusCode).toBe(200); expect(reply.json()).toMatchObject({ data: { ...initial, revision: 1 } });
    expect(preferences.setPreference).toHaveBeenCalledWith(expect.objectContaining({ actor, idempotencyKey: 'exact-reset' }), id(4), { expectedRevision: 0, columns: null });
  });
  it('rejects client identity, arbitrary query/body fields and missing operation keys', async () => {
    const { app, preferences } = await harness();
    for (const query of ['membershipId=x', 'actorId=x', 'view=all']) expect((await app.inject(`${path}?${query}`)).statusCode).toBe(400);
    for (const payload of [{ expectedRevision: 0, columns: null, membershipId: id(9) }, { expectedRevision: 0, columns: [] }, { expectedRevision: -1, columns: null }]) expect((await app.inject({ method: 'PUT', url: path, headers: { 'idempotency-key': 'key' }, payload })).statusCode).toBe(400);
    expect((await app.inject({ method: 'PUT', url: path, payload: { expectedRevision: 0, columns: null } })).statusCode).toBe(400);
    expect(preferences.getPreference).not.toHaveBeenCalled(); expect(preferences.setPreference).not.toHaveBeenCalled();
  });
  it('preserves missing/current-denied project semantics and has no arbitrary membership endpoint', async () => {
    const { app, preferences } = await harness(); preferences.getPreference.mockRejectedValue(notFoundError());
    expect((await app.inject(path)).statusCode).toBe(404);
    expect((await app.inject(path.replace('/me', `/${id(9)}`))).statusCode).toBe(404);
  });
});
