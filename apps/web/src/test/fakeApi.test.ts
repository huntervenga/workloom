import { describe, expect, it } from 'vitest';
import { alpha, alphaMembers, anna, beta, betaMembers, boris, installFakeApi, ok, singleActorRoutes } from './fakeApi';
const projectId = 'ad000000-0000-4000-8000-000000000001';
const preference = (workspaceId: string) => `/api/v1/workspaces/${workspaceId}/projects/${projectId}/table-preferences/me`;
async function read(path: string) { const response = await fetch(path); return { status: response.status, body: await response.json() as { data?: unknown } }; }
describe('own preference compatibility fixtures', () => {
  it('derives revision-zero/default state from the resolved actor membership and never fabricates a write', async () => {
    const { calls } = installFakeApi(singleActorRoutes(anna, [alpha], { [alpha.id]: alphaMembers }));
    await read('/api/v1/me'); await read(`/api/v1/workspaces/${alpha.id}/memberships`);
    expect(await read(preference(alpha.id))).toMatchObject({ status: 200, body: { data: { workspaceId: alpha.id, projectId, membershipId: alphaMembers[0]?.id, revision: 0, columns: null } } });
    expect(calls.every(call => call.method === 'GET')).toBe(true);
    expect((await fetch(preference(alpha.id), { method: 'PUT', body: '{}' })).status).toBe(404);
  });
  it('tracks actor changes and refuses to borrow another actor membership', async () => {
    let current = anna;
    installFakeApi({ ...singleActorRoutes(anna, [alpha, beta], { [alpha.id]: alphaMembers, [beta.id]: betaMembers }), 'GET /api/v1/me': () => ok({ actor: current, authMode: 'dev' }) });
    await read('/api/v1/me'); await read(`/api/v1/workspaces/${alpha.id}/memberships`); await read(`/api/v1/workspaces/${beta.id}/memberships`);
    expect((await read(preference(beta.id))).status).toBe(404);
    current = boris; await read('/api/v1/me');
    expect((await read(preference(alpha.id))).status).toBe(404);
    expect(await read(preference(beta.id))).toMatchObject({ status: 200, body: { data: { membershipId: betaMembers[0]?.id } } });
  });
  it('passes malformed success responses unchanged to the application API parser', async () => {
    installFakeApi({ 'GET /api/v1/me': () => new Response('invalid-json', { status: 200 }) });
    const response = await fetch('/api/v1/me');
    expect(response.status).toBe(200); expect(await response.text()).toBe('invalid-json');
  });
  it('preserves explicitly registered response handlers', async () => {
    installFakeApi({ ...singleActorRoutes(anna, [alpha]), [`GET ${preference(alpha.id)}`]: () => ok({ explicit: true }) });
    expect(await read(preference(alpha.id))).toMatchObject({ status: 200, body: { data: { explicit: true } } });
  });
});
