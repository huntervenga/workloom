import { afterEach, describe, expect, it, vi } from 'vitest';
import { capabilityRequiredError, notFoundError, temporarilyUnavailableError, unauthenticatedError, type AccessRepository, type WorkspaceChangeHeadApplication } from '@workloom/domain';
import type { FastifyInstance } from 'fastify';
import { workspaceChangeHeadResponseSchema } from '@workloom/contracts';
import { createApp } from '../app.js';
import { loadConfig } from '../config.js';

const workspaceId = 'aa000000-0000-4000-8000-000000000001';
const actor = { userId: 'aa000000-0000-4000-8000-000000000002', displayName: 'Trusted viewer', kind: 'fixture' as const };
const head = { workspaceId, actorUserId: actor.userId, membershipId: 'aa000000-0000-4000-8000-000000000003', membershipRevision: 3, role: 'viewer' as const, changeSeq: '9007199254740993', permissionEpoch: '9223372036854775807' };
const apps: FastifyInstance[] = [];
afterEach(async () => { await Promise.all(apps.splice(0).map(app => app.close())); });
async function harness() {
  const getHead = vi.fn<WorkspaceChangeHeadApplication['getHead']>(async () => head);
  const resolveActor = vi.fn(async () => actor);
  const accessRepository: AccessRepository = { findUser: async () => null, findUsers: async () => [], listAccessibleWorkspaces: async () => [], findWorkspaceAccess: async () => null, listActiveMemberships: async () => [] };
  const config = loadConfig({ APP_ENV: 'local', AUTH_MODE: 'dev', DATABASE_URL: 'postgres://synthetic:unused@127.0.0.1:5432/unused' });
  const app = await createApp(config, { accessRepository, readiness: { check: async () => ({ ready: true, checks: { database: 'ok', schema: 'ok' } }) }, identityAdapter: { mode: 'dev', resolveActor }, workspaceChangeHeadApplication: { getHead }, logger: false, webDistDir: null });
  apps.push(app); await app.ready();
  const get = (suffix = '', headers: Record<string, string> = {}) => app.inject({ method: 'GET', url: `/api/v1/workspaces/${workspaceId.toUpperCase()}/change-head${suffix}`, headers: { host: '127.0.0.1:4310', ...headers } });
  return { app, get, getHead, resolveActor };
}

describe('workspace change head HTTP read', () => {
  it('wires the injectable application through the normal app, trusted actor, strict envelope and request ID', async () => {
    const h = await harness();
    const response = await h.get('', { 'x-actor-id': 'foreign', 'x-user-id': 'foreign', 'x-request-id': 'client-selected' });
    expect(response.statusCode).toBe(200);
    const body = workspaceChangeHeadResponseSchema.parse(response.json());
    expect(body.data).toEqual(head); expect(body.meta.requestId).toBe(response.headers['x-request-id']);
    expect(body.meta.requestId).not.toBe('client-selected'); expect(response.headers['cache-control']).toBe('no-store');
    expect(h.getHead).toHaveBeenCalledWith({ workspaceId, actor, source: 'web', requestId: body.meta.requestId });
    expect(h.resolveActor).toHaveBeenCalledTimes(1);
  });
  it('rejects all client query selectors before resolving identity or invoking the read', async () => {
    const h = await harness();
    for (const query of ['actorUserId=foreign', 'actorId=foreign', 'membershipId=foreign', 'role=owner', 'workspaceId=foreign', 'projectId=foreign', 'cursor=x', 'since=0']) {
      const response = await h.get(`?${query}`);
      expect(response.statusCode).toBe(400); expect(response.json()).toMatchObject({ error: { code: 'VALIDATION_FAILED' } });
    }
    expect(h.getHead).not.toHaveBeenCalled(); expect(h.resolveActor).not.toHaveBeenCalled();
    expect((await h.app.inject({ method: 'GET', url: '/api/v1/workspaces/invalid/change-head', headers: { host: '127.0.0.1:4310' } })).statusCode).toBe(400);
  });
  it('preserves 401/403/404/503 transport contracts and neutral revocation without exposing metadata', async () => {
    const h = await harness();
    for (const [error, statusCode, code] of [[unauthenticatedError(), 401, 'UNAUTHENTICATED'], [capabilityRequiredError(), 403, 'CAPABILITY_REQUIRED'], [notFoundError(), 404, 'NOT_FOUND'], [temporarilyUnavailableError(), 503, 'TEMPORARILY_UNAVAILABLE']] as const) {
      h.getHead.mockRejectedValueOnce(error); const response = await h.get();
      expect(response.statusCode).toBe(statusCode); expect(response.json()).toMatchObject({ error: { code }, meta: { requestId: response.headers['x-request-id'] } });
      expect(response.json()).not.toHaveProperty('data'); expect(response.headers['cache-control']).toBe('no-store');
    }
    h.resolveActor.mockRejectedValueOnce(unauthenticatedError());
    expect((await h.get()).statusCode).toBe(401); expect(h.getHead).toHaveBeenCalledTimes(4);
  });
  it('rejects malformed or extra response fields as sanitized server errors', async () => {
    const h = await harness();
    for (const invalid of [{ ...head, extra: 'private metadata' }, { ...head, changeSeq: '9223372036854775808' }, { ...head, permissionEpoch: '-1' }]) {
      h.getHead.mockResolvedValueOnce(invalid); const response = await h.get();
      expect(response.statusCode).toBe(500); expect(response.json()).toMatchObject({ error: { code: 'INTERNAL_ERROR' } });
      expect(response.body).not.toContain('private metadata'); expect(response.body).not.toContain('9223372036854775808');
    }
  });
  it('offers no command transport or write replay', async () => {
    const h = await harness();
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE'] as const) {
      const response = await h.app.inject({ method, url: `/api/v1/workspaces/${workspaceId}/change-head`, headers: { host: '127.0.0.1:4310', origin: 'http://127.0.0.1:4310' } });
      expect(response.statusCode).toBe(404);
    }
    expect(h.getHead).not.toHaveBeenCalled();
  });
});
