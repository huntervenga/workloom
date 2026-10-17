import { afterEach, describe, expect, it, vi } from 'vitest';
import { createQueryClient } from './queryClient';
import { ApiError } from './api';
import { protectedDraftsFor } from './protectedDrafts';
import { queryKeys } from './queryKeys';
import { setWorkspaceRefreshComposing } from './workspaceRefreshProtection';

const ACTOR = '11111111-1111-4111-8111-111111111111';
const WORKSPACE = '22222222-2222-4222-8222-222222222222';
const workspace = { id: WORKSPACE, name: 'Synthetic workspace', role: 'member', timezone: 'UTC' };
const clients: ReturnType<typeof createQueryClient>[] = [];
function setup() {
  const client = createQueryClient({ retry: false }); clients.push(client);
  client.setQueryData(queryKeys.me, { actor: { id: ACTOR } });
  client.setQueryData(queryKeys.workspace(ACTOR, WORKSPACE), workspace);
  client.setQueryData(queryKeys.workspaces(ACTOR), [workspace]);
  client.setQueryData(queryKeys.tasks(ACTOR, WORKSPACE), ['cached sensitive rows']);
  const fetch = vi.fn(async () => new Response(JSON.stringify({ data: workspace, meta: { requestId: 'synthetic' } }),
    { status: 200, headers: { 'Content-Type': 'application/json' } }));
  vi.stubGlobal('fetch', fetch);
  const deny = (kind: 'unauthenticated' | 'forbidden' | 'not_found' | 'unavailable' | 'invalid_response') => client.fetchQuery({
    queryKey: queryKeys.workspaceChangeHead(ACTOR, WORKSPACE), retry: false, staleTime: 0,
    queryFn: async () => { throw new ApiError({ kind, status: kind === 'unauthenticated' ? 401 : kind === 'forbidden' ? 403 : kind === 'not_found' ? 404 : 503 }); },
  });
  return { client, fetch, deny };
}
afterEach(() => { clients.splice(0).forEach(client => client.clear()); document.body.replaceChildren(); });

it.each(['unauthenticated', 'forbidden', 'not_found'] as const)('makes idle %s override cached success without clearing historical mutation entries', async kind => {
  const s = setup(); const mutation = s.client.getMutationCache().build(s.client, { mutationKey: ['historical-recovery'], mutationFn: async () => 'unused' });
  const identity = mutation.state;
  await expect(s.deny(kind)).rejects.toBeInstanceOf(ApiError);
  expect(s.client.getQueryData(queryKeys.tasks(ACTOR, WORKSPACE))).toBeUndefined();
  expect(s.client.getQueryData(queryKeys.workspace(ACTOR, WORKSPACE))).toBeUndefined();
  expect(s.client.getQueryState(queryKeys.workspace(ACTOR, WORKSPACE))?.status).toBe('error');
  expect(s.client.getQueryState(queryKeys.workspaceChangeHead(ACTOR, WORKSPACE))?.status).toBe('error');
  expect(s.client.getQueryState(queryKeys.workspaces(ACTOR))?.isInvalidated).toBe(true);
  expect(s.client.getMutationCache().getAll()).toContain(mutation); expect(mutation.state).toBe(identity);
  // A successful automatic root recheck is advisory and must not unlock a denial loop.
  await Promise.resolve(); expect(s.fetch).toHaveBeenCalledTimes(1);
  expect(s.client.getQueryState(queryKeys.workspace(ACTOR, WORKSPACE))?.status).toBe('error');
  if (kind === 'unauthenticated') expect(s.client.getQueryState(queryKeys.me)?.isInvalidated).toBe(true);
});

describe('head error policy protection checked at error delivery time', () => {
  it.each(['draft', 'pristine editor', 'composition'] as const)('does not evict a %s owner when a head begun earlier denies', async protection => {
    const s = setup();
    if (protection === 'draft') { const slot = protectedDraftsFor(s.client).register(); slot.set(true); }
    if (protection === 'pristine editor') { const input = document.createElement('input'); document.body.append(input); input.focus(); }
    if (protection === 'composition') setWorkspaceRefreshComposing(s.client, true);
    await expect(s.deny('forbidden')).rejects.toBeInstanceOf(ApiError);
    expect(s.client.getQueryData(queryKeys.tasks(ACTOR, WORKSPACE))).toEqual(['cached sensitive rows']);
    expect(s.client.getQueryState(queryKeys.workspace(ACTOR, WORKSPACE))?.status).toBe('success');
    expect(s.fetch).not.toHaveBeenCalled();
  });

  it.each(['unavailable', 'invalid_response'] as const)('keeps cached context through %s and performs no access eviction', async kind => {
    const s = setup(); await expect(s.deny(kind)).rejects.toBeInstanceOf(ApiError);
    expect(s.client.getQueryData(queryKeys.tasks(ACTOR, WORKSPACE))).toEqual(['cached sensitive rows']);
    expect(s.client.getQueryState(queryKeys.workspace(ACTOR, WORKSPACE))?.status).toBe('success'); expect(s.fetch).not.toHaveBeenCalled();
  });
});
