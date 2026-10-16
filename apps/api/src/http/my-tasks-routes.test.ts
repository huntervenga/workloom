import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { notFoundError, type MyTasksApplication } from '@workloom/domain';
import { registerMyTasksRoutes } from './my-tasks-routes.js';
import { mapError } from './errors.js';

const workspace = 'aa000000-0000-4000-8000-000000000001';
const actor = { userId: 'aa000000-0000-4000-8000-000000000002', displayName: 'Current viewer', kind: 'fixture' as const };
const apps: FastifyInstance[] = [];
afterEach(async () => { await Promise.all(apps.splice(0).map(app => app.close())); });
async function harness() {
  const app = Fastify(); apps.push(app);
  app.setErrorHandler((error, _request, reply) => { const mapped = mapError(error); return reply.code(mapped.statusCode).send(mapped.body); });
  const list = vi.fn<MyTasksApplication['list']>(async () => ({ items: [], nextCursor: 'opaque-current-cursor' }));
  registerMyTasksRoutes(app, { identity: { mode: 'dev', resolveActor: async () => actor }, myTasks: { list } });
  await app.ready();
  return { app, list };
}

describe('personal task read HTTP adapter', () => {
  it('uses trusted identity, canonical workspace, bounded parsed filters and an opaque cursor envelope', async () => {
    const { app, list } = await harness();
    const reply = await app.inject({ method: 'GET', url: `/api/v1/workspaces/${workspace.toUpperCase()}/my-tasks?relation=participating&completion=all&includeArchived=false&limit=2&cursor=opaque%2Bprevious` });
    expect(reply.statusCode).toBe(200);
    expect(reply.json()).toMatchObject({ data: [], meta: { nextCursor: 'opaque-current-cursor' } });
    expect(list).toHaveBeenCalledWith(expect.objectContaining({ actor, workspaceId: workspace, source: 'web' }), { relation: 'participating', completion: 'all', includeArchived: false, limit: 2, cursor: 'opaque+previous' });
  });
  it('rejects arbitrary membership/actor/sort parameters before calling the read service', async () => {
    const { app, list } = await harness();
    for (const query of ['membershipId=x', 'actorId=x', 'sort=title', 'limit=201', 'includeArchived=yes']) {
      const reply = await app.inject(`/api/v1/workspaces/${workspace}/my-tasks?${query}`);
      expect(reply.statusCode).toBe(400);
      expect(reply.json()).toMatchObject({ error: { code: 'VALIDATION_FAILED' } });
    }
    expect(list).not.toHaveBeenCalled();
  });
  it('preserves absent/revoked scope denial and has no write endpoint', async () => {
    const { app, list } = await harness();
    list.mockRejectedValue(notFoundError());
    const reply = await app.inject(`/api/v1/workspaces/${workspace}/my-tasks?cursor=previous`);
    expect(reply.statusCode).toBe(404);
    expect(reply.json()).toMatchObject({ error: { code: 'NOT_FOUND', message: 'The requested resource was not found.' } });
    expect((await app.inject({ method: 'POST', url: `/api/v1/workspaces/${workspace}/my-tasks`, payload: {} })).statusCode).toBe(404);
  });
});
