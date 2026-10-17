import { afterEach, describe, expect, it, vi } from 'vitest';
import { createQueryClient } from './queryClient';
import { queryKeys } from './queryKeys';
import { WorkspaceHeadRechecks } from './workspaceHeadRechecks';

const ACTOR = '11111111-1111-4111-8111-111111111111';
const WORKSPACE = '22222222-2222-4222-8222-222222222222';
const OTHER = '33333333-3333-4333-8333-333333333333';
const workspace = { id: WORKSPACE, name: 'Synthetic workspace', timezone: 'UTC', role: 'member' };
const actor = { id: ACTOR, displayName: 'Synthetic actor', kind: 'fixture' };
const clients: ReturnType<typeof createQueryClient>[] = [];
function json(data: unknown, status = 200) { return new Response(JSON.stringify(status === 200 ? { data, meta: { requestId: 'synthetic' } } :
  { error: { code: 'NOT_FOUND', message: 'Unavailable', retryable: false }, meta: { requestId: 'synthetic' } }),
{ status, headers: { 'Content-Type': 'application/json' } }); }
function held<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(yes => { resolve = yes; }); return { promise, resolve }; }
async function settle() { for (let i = 0; i < 30; i++) await Promise.resolve(); }
function setup() {
  const client = createQueryClient({ retry: false }); clients.push(client);
  client.setQueryData(queryKeys.me, { actor, authMode: 'dev' });
  client.setQueryData(queryKeys.workspace(ACTOR, WORKSPACE), workspace);
  client.setQueryData(queryKeys.tasks(ACTOR, WORKSPACE), 'retained');
  const response = held<Response>(); let safe = true;
  const fetch = vi.fn(() => response.promise); vi.stubGlobal('fetch', fetch);
  const owner = new WorkspaceHeadRechecks(client, ACTOR, WORKSPACE, () => safe);
  return { client, response, fetch, owner, unsafe: () => { safe = false; } };
}
afterEach(() => { clients.splice(0).forEach(client => client.clear()); });

describe('owned workspace-head metadata/identity reads', () => {
  it.each(['hidden', 'scope departure'] as const)('aborts all owned metadata requests on %s and ignores transport that still returns a denial', async cause => {
    const s = setup(); s.owner.access(); await settle(); expect(s.fetch).toHaveBeenCalledTimes(2);
    const calls = s.fetch.mock.calls as unknown as [string, RequestInit][];
    if (cause === 'hidden') { s.unsafe(); s.owner.cancel(); } else s.owner.stop();
    for (const call of calls) expect(call[1].signal?.aborted).toBe(true);
    s.response.resolve(json(null, 403)); await settle();
    expect(s.client.getQueryData(queryKeys.tasks(ACTOR, WORKSPACE))).toBe('retained');
    expect(s.client.getQueryState(queryKeys.workspace(ACTOR, WORKSPACE))?.status).toBe('success');
  });

  it('checks current safety inside the queryFn catch even before the cancellation observer runs', async () => {
    const s = setup(); s.owner.access(); await settle(); s.unsafe();
    s.response.resolve(json(null, 403)); await settle();
    expect(s.client.getQueryData(queryKeys.tasks(ACTOR, WORKSPACE))).toBe('retained');
    expect(s.client.getQueryState(queryKeys.workspace(ACTOR, WORKSPACE))?.status).toBe('success'); s.owner.stop();
  });

  it('rejects successful metadata and identity answers after safety ended, without publishing their data', async () => {
    const s = setup(); s.owner.identity(); await settle(); s.unsafe();
    s.response.resolve(json({ actor: { ...actor, id: OTHER }, authMode: 'dev' })); await settle();
    expect(s.client.getQueryData<{ actor: { id: string } }>(queryKeys.me)?.actor.id).toBe(ACTOR); s.owner.stop();
  });

  it('keeps the existing actor-reset path available for a fresh identity answer while safe', async () => {
    const s = setup(); s.owner.identity(); await settle();
    s.response.resolve(json({ actor: { ...actor, id: OTHER }, authMode: 'dev' })); await settle();
    expect(s.client.getQueryData<{ actor: { id: string } }>(queryKeys.me)?.actor.id).toBe(OTHER); s.owner.stop();
  });

  it('retains the prior successful identity and recovery context when an owned identity check fails', async () => {
    const s = setup(); s.owner.identity(); await settle();
    s.response.resolve(json(null, 503)); await settle();
    expect(s.client.getQueryState(queryKeys.me)?.status).toBe('success');
    expect(s.client.getQueryData<{ actor: { id: string } }>(queryKeys.me)?.actor.id).toBe(ACTOR);
    expect(s.client.getQueryData(queryKeys.tasks(ACTOR, WORKSPACE))).toBe('retained'); s.owner.stop();
  });

});
