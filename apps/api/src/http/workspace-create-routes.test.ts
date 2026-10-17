import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { workspaceResponseSchema } from '@workloom/contracts';
import { DomainError, notFoundError, unauthenticatedError, type Actor, type WorkspaceCreateApplication } from '@workloom/domain';

import type { IdentityAdapter } from '../identity/identity-adapter.js';
import { mapError } from './errors.js';
import { registerWorkspaceCreateRoutes } from './workspace-create-routes.js';

const id = (n: number) => `b0000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const realActor: Actor = { userId: id(1), displayName: 'Verified person', kind: 'real' };
const created = { id: id(9), name: 'Launch team', role: 'owner' as const, timezone: 'Asia/Nicosia' };
const apps: FastifyInstance[] = [];
afterEach(async () => { await Promise.all(apps.splice(0).map(app => app.close())); });

async function harness(options: { mode?: IdentityAdapter['mode']; actor?: Actor } = {}) {
  const app = Fastify(); apps.push(app);
  app.setErrorHandler((error, _request, reply) => { const mapped = mapError(error); return reply.code(mapped.statusCode).send(mapped.body); });
  const resolveActor = vi.fn<IdentityAdapter['resolveActor']>(async () => options.actor ?? realActor);
  const createWorkspace = vi.fn<WorkspaceCreateApplication['createWorkspace']>(async () => created);
  registerWorkspaceCreateRoutes(app, { identity: { mode: options.mode ?? 'shared', resolveActor }, workspaces: { createWorkspace } });
  await app.ready();
  const post = (payload: unknown, headers: Record<string, string> = {}) => app.inject({
    method: 'POST', url: '/api/v1/workspaces',
    headers: { 'idempotency-key': 'create-1', 'x-workloom-actor-id': realActor.userId, ...headers },
    payload: payload as Record<string, unknown>,
  });
  return { app, post, resolveActor, createWorkspace };
}

describe('POST /api/v1/workspaces', () => {
  it('creates with the trusted shared actor, request ID and trimmed body and answers 201', async () => {
    const h = await harness();
    const response = await h.post({ name: '  Launch team  ', timezone: 'Asia/Nicosia' }, { 'x-workloom-actor-id': realActor.userId.toUpperCase() });
    expect(response.statusCode).toBe(201);
    const body = workspaceResponseSchema.parse(response.json());
    expect(body.data).toEqual(created);
    expect(h.createWorkspace).toHaveBeenCalledTimes(1);
    expect(h.createWorkspace).toHaveBeenCalledWith(
      { actor: realActor, source: 'web', requestId: body.meta.requestId, idempotencyKey: 'create-1' },
      { name: 'Launch team', timezone: 'Asia/Nicosia' },
    );
  });

  it('answers 201 with the same workspace for an identical replay', async () => {
    const h = await harness();
    const first = await h.post({ name: 'Launch team', timezone: 'Asia/Nicosia' });
    const second = await h.post({ name: 'Launch team', timezone: 'Asia/Nicosia' });
    expect([first.statusCode, second.statusCode]).toEqual([201, 201]);
    expect(workspaceResponseSchema.parse(second.json()).data).toEqual(workspaceResponseSchema.parse(first.json()).data);
  });

  it('rejects body extras, selectors and invalid names or time zones before resolving identity', async () => {
    const h = await harness();
    const bodies: unknown[] = [
      {}, { name: 'Only name' }, { timezone: 'UTC' },
      { name: 'Team', timezone: 'UTC', ownerUserId: id(2) },
      { name: 'Team', timezone: 'UTC', actorUserId: id(2) },
      { name: 'Team', timezone: 'UTC', role: 'owner' },
      { name: 'Team', timezone: 'UTC', id: id(3) },
      { name: 'Team', timezone: 'UTC', weekStart: 7 },
      { name: 'Team', timezone: 'UTC', permissionEpoch: 4 },
      { name: '', timezone: 'UTC' }, { name: '   ', timezone: 'UTC' }, { name: 'x'.repeat(201), timezone: 'UTC' },
      { name: 'Nul\0name', timezone: 'UTC' }, { name: 7, timezone: 'UTC' },
      { name: 'Team', timezone: 'Mars/Olympus_Mons' }, { name: 'Team', timezone: 'UTC; drop' },
      { name: 'Team', timezone: '' }, { name: 'Team', timezone: `Europe/${'A'.repeat(64)}` }, { name: 'Team', timezone: 3 },
    ];
    for (const body of bodies) {
      const response = await h.post(body);
      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({ error: { code: 'VALIDATION_FAILED' } });
    }
    expect(h.resolveActor).not.toHaveBeenCalled();
    expect(h.createWorkspace).not.toHaveBeenCalled();
  });

  it('requires a visible ASCII Idempotency-Key and a UUID actor binding header', async () => {
    const h = await harness();
    const body = { name: 'Team', timezone: 'UTC' };
    for (const headers of [{ 'idempotency-key': '' }, { 'idempotency-key': 'has space' }, { 'idempotency-key': 'k'.repeat(129) },
      { 'x-workloom-actor-id': '' }, { 'x-workloom-actor-id': 'not-a-uuid' }]) {
      const response = await h.post(body, headers);
      expect(response.statusCode).toBe(400);
    }
    const withoutActor = await h.app.inject({ method: 'POST', url: '/api/v1/workspaces', headers: { 'idempotency-key': 'k' }, payload: body });
    expect(withoutActor.statusCode).toBe(400);
    const withoutKey = await h.app.inject({ method: 'POST', url: '/api/v1/workspaces', headers: { 'x-workloom-actor-id': realActor.userId }, payload: body });
    expect(withoutKey.statusCode).toBe(400);
    expect(h.resolveActor).not.toHaveBeenCalled();
    expect(h.createWorkspace).not.toHaveBeenCalled();
  });

  it('never lets the binding header select another actor: a mismatch is a 409 without a write', async () => {
    const h = await harness();
    const response = await h.post({ name: 'Team', timezone: 'UTC' }, { 'x-workloom-actor-id': id(2) });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ error: { code: 'REVISION_CONFLICT' } });
    expect(h.resolveActor).toHaveBeenCalledTimes(1);
    expect(h.createWorkspace).not.toHaveBeenCalled();
  });

  it('denies development identity mode and fixture actors safely', async () => {
    const dev = await harness({ mode: 'dev' });
    const devResponse = await dev.post({ name: 'Team', timezone: 'UTC' });
    expect(devResponse.statusCode).toBe(403);
    expect(dev.resolveActor).not.toHaveBeenCalled();
    expect(dev.createWorkspace).not.toHaveBeenCalled();

    const fixture = await harness({ actor: { userId: id(1), displayName: 'Synthetic', kind: 'fixture' } });
    const fixtureResponse = await fixture.post({ name: 'Team', timezone: 'UTC' });
    expect(fixtureResponse.statusCode).toBe(403);
    expect(fixture.createWorkspace).not.toHaveBeenCalled();
  });

  it('maps identity and domain failures to their neutral transport codes', async () => {
    const h = await harness();
    h.resolveActor.mockRejectedValueOnce(unauthenticatedError());
    expect((await h.post({ name: 'Team', timezone: 'UTC' })).statusCode).toBe(401);
    expect(h.createWorkspace).not.toHaveBeenCalled();

    h.createWorkspace.mockRejectedValueOnce(new DomainError('IDEMPOTENCY_KEY_REUSED', 'This Idempotency-Key was already used for a different request.'));
    const reused = await h.post({ name: 'Other', timezone: 'UTC' });
    expect(reused.statusCode).toBe(409);
    expect(reused.json()).toMatchObject({ error: { code: 'IDEMPOTENCY_KEY_REUSED' } });

    h.createWorkspace.mockRejectedValueOnce(notFoundError());
    const revoked = await h.post({ name: 'Team', timezone: 'UTC' });
    expect(revoked.statusCode).toBe(404);
    expect(revoked.json()).not.toHaveProperty('data');
  });

  it('treats a response that breaks the workspace contract as a server error', async () => {
    const h = await harness();
    h.createWorkspace.mockResolvedValueOnce({ ...created, role: 'superuser' } as unknown as typeof created);
    const response = await h.post({ name: 'Team', timezone: 'UTC' });
    expect(response.statusCode).toBe(500);
    expect(response.body).not.toContain('superuser');
  });
});
