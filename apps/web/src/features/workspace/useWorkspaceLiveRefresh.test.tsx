import { QueryClientProvider, QueryObserver } from '@tanstack/react-query';
import { act, renderHook } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkspaceChangeHeadDto } from '@workloom/contracts';
import { createQueryClient } from '../../lib/queryClient';
import { protectedCommandsFor } from '../../lib/protectedCommands';
import { protectedDraftsFor } from '../../lib/protectedDrafts';
import { queryKeys } from '../../lib/queryKeys';
import { useWorkspaceLiveRefresh } from './useWorkspaceLiveRefresh';
import { workspaceChangeHeadKey } from './workspaceChangeHead';

const ACTOR = '11111111-1111-4111-8111-111111111111';
const WORKSPACE = '22222222-2222-4222-8222-222222222222';
const MEMBERSHIP = '33333333-3333-4333-8333-333333333333';
const OTHER = '44444444-4444-4444-8444-444444444444';
const workspace = { id: WORKSPACE, name: 'Synthetic workspace', role: 'member' as const, timezone: 'UTC' };
const membership = { id: MEMBERSHIP, workspaceId: WORKSPACE, userId: ACTOR, displayName: 'Synthetic member', role: 'member' as const };
function head(overrides: Partial<WorkspaceChangeHeadDto> = {}): WorkspaceChangeHeadDto {
  return { workspaceId: WORKSPACE, actorUserId: ACTOR, membershipId: MEMBERSHIP, membershipRevision: 1,
    role: 'member', changeSeq: '0', permissionEpoch: '0', ...overrides };
}
function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(status === 200 ? { data, meta: { requestId: 'synthetic' } } :
    { error: { code: 'NOT_FOUND', message: 'Unavailable', retryable: false }, meta: { requestId: 'synthetic' } }),
  { status, headers: { 'Content-Type': 'application/json' } });
}
async function settle() { await act(async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); }); }
const cleanups: (() => void)[] = [];
function setup() {
  const client = createQueryClient({ retry: false });
  client.setQueryData(queryKeys.workspace(ACTOR, WORKSPACE), workspace);
  client.setQueryData(queryKeys.memberships(ACTOR, WORKSPACE), [membership]);
  client.setQueryData(queryKeys.me, { actor: { id: ACTOR } });
  const key = [...queryKeys.tasks(ACTOR, WORKSPACE), 'list'];
  client.setQueryData(key, 'retained');
  const content = vi.fn().mockResolvedValue('refreshed');
  const observer = new QueryObserver(client, { queryKey: key, queryFn: content, staleTime: Infinity });
  const unsubscribe = observer.subscribe(() => undefined);
  const state = { head: head(), headStatus: 200 };
  const fetch = vi.fn(async (path: string | URL | Request) => {
    const url = String(path);
    if (url.endsWith('/change-head')) return json(state.head, state.headStatus);
    if (url.endsWith('/memberships')) return json([membership]);
    if (url.endsWith('/me')) return json({ actor: { id: ACTOR } });
    return json(workspace);
  });
  vi.stubGlobal('fetch', fetch);
  const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  cleanups.push(() => { unsubscribe(); client.clear(); });
  return { client, content, fetch, state, key, wrapper };
}
beforeEach(() => { vi.useFakeTimers(); Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' }); });
afterEach(() => { cleanups.splice(0).forEach(cleanup => cleanup()); document.body.replaceChildren(); vi.useRealTimers(); });

describe('workspace live refresh hook integration', () => {
  it('suspends all automatic reads while dirty/collapsed drafts and unknown commands protect exact owner state', async () => {
    const s = setup(); const draft = protectedDraftsFor(s.client).register(); const command = protectedCommandsFor(s.client).register();
    draft.set(true); command.set(true);
    const held = { method: 'PATCH', body: { expectedRevision: 1, title: 'held exact draft' }, key: 'unchanged-key' };
    const mutation = s.client.getMutationCache().build(s.client, { mutationKey: ['held'], mutationFn: async () => held });
    mutation.state = { ...mutation.state, variables: held, status: 'error' };
    const view = renderHook(() => useWorkspaceLiveRefresh(ACTOR, WORKSPACE, true), { wrapper: s.wrapper });
    await settle(); await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
    expect(s.fetch.mock.calls.filter(call => String(call[0]).endsWith('/change-head'))).toHaveLength(0);
    expect(s.content).not.toHaveBeenCalled(); expect(mutation.state.variables).toBe(held);
    draft.set(false); await settle(); expect(s.content).not.toHaveBeenCalled();
    command.set(false); await settle(); expect(s.content).toHaveBeenCalledTimes(1);
    expect(mutation.state.variables).toBe(held); expect(s.client.getMutationCache().getAll()).toContain(mutation);
    for (const call of s.fetch.mock.calls) expect((call as unknown as [unknown, RequestInit])[1]?.method ?? 'GET').toBe('GET');
    view.unmount();
  });

  it('defers pristine focused editors, dialog/picker and composition, preserving selection and URL', async () => {
    const s = setup(); const input = document.createElement('input'); input.value = 'untouched'; document.body.append(input);
    input.focus(); input.setSelectionRange(2, 6); document.documentElement.scrollTop = 81;
    const originalUrl = window.location.href;
    const view = renderHook(() => useWorkspaceLiveRefresh(ACTOR, WORKSPACE, true), { wrapper: s.wrapper });
    await settle(); expect(s.content).not.toHaveBeenCalled();
    expect([input.value, input.selectionStart, input.selectionEnd, document.activeElement]).toEqual(['untouched', 2, 6, input]);
    const dialog = document.createElement('div'); dialog.setAttribute('role', 'dialog'); document.body.append(dialog); input.blur();
    await settle(); expect(s.content).not.toHaveBeenCalled();
    document.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true })); dialog.remove(); await settle();
    expect(s.content).not.toHaveBeenCalled();
    document.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true })); await settle();
    expect(s.content).toHaveBeenCalledTimes(1); expect(document.documentElement.scrollTop).toBe(81);
    expect(window.location.href).toBe(originalUrl); input.remove(); view.unmount();
  });

  it('reauthorizes after a picker closes with focus still on its stable noneditable trigger', async () => {
    const s = setup(); const trigger = document.createElement('button');
    trigger.setAttribute('role', 'combobox'); trigger.setAttribute('aria-haspopup', 'listbox'); trigger.setAttribute('aria-expanded', 'true');
    document.body.append(trigger); trigger.focus();
    const view = renderHook(() => useWorkspaceLiveRefresh(ACTOR, WORKSPACE, true), { wrapper: s.wrapper }); await settle();
    expect(s.fetch).not.toHaveBeenCalled(); expect(s.content).not.toHaveBeenCalled();
    trigger.setAttribute('aria-expanded', 'false'); await settle();
    expect(s.fetch.mock.calls.filter(call => String(call[0]).endsWith('/change-head'))).toHaveLength(1);
    expect(s.content).toHaveBeenCalledTimes(1); expect(trigger).toHaveFocus();
    trigger.remove(); view.unmount();
  });

  it('does not overwrite an editor opened while the fresh content request is already in flight', async () => {
    const s = setup(); let resolve!: (value: string) => void;
    s.content.mockImplementation(() => new Promise<string>(yes => { resolve = yes; }));
    const view = renderHook(() => useWorkspaceLiveRefresh(ACTOR, WORKSPACE, true), { wrapper: s.wrapper }); await settle();
    const input = document.createElement('input'); input.value = 'new local draft'; document.body.append(input); input.focus(); input.setSelectionRange(3, 7);
    const draft = protectedDraftsFor(s.client).register(); draft.set(true);
    resolve('fresh server data'); await settle();
    expect(s.client.getQueryData(s.key)).toBe('retained');
    expect([input.value, input.selectionStart, input.selectionEnd, document.activeElement]).toEqual(['new local draft', 3, 7, input]);
    input.remove(); view.unmount();
  });

  it.each(['actor', 'workspace', 'membership'] as const)('rejects a wrong %s binding before publishing its sentinel', async binding => {
    const s = setup();
    s.state.head = head(binding === 'actor' ? { actorUserId: OTHER } : binding === 'workspace' ? { workspaceId: OTHER } : { membershipId: OTHER });
    const view = renderHook(() => useWorkspaceLiveRefresh(ACTOR, WORKSPACE, true), { wrapper: s.wrapper }); await settle();
    expect(s.client.getQueryData(workspaceChangeHeadKey(ACTOR, WORKSPACE))).toBeUndefined(); expect(s.content).not.toHaveBeenCalled();
    if (binding === 'actor') expect(s.fetch.mock.calls.some(call => String(call[0]).endsWith('/me'))).toBe(true);
    if (binding === 'membership') expect(s.fetch.mock.calls.some(call => String(call[0]).endsWith('/memberships'))).toBe(true);
    view.unmount();
  });

  it('aborts delayed responses on scope departure and does not store them under a new workspace', async () => {
    const s = setup(); let reply!: (response: Response) => void;
    s.fetch.mockImplementationOnce(() => new Promise<Response>(yes => { reply = yes; }));
    const view = renderHook(({ id }) => useWorkspaceLiveRefresh(ACTOR, id, true), { wrapper: s.wrapper, initialProps: { id: WORKSPACE } });
    await settle(); view.rerender({ id: OTHER }); reply(json(head({ changeSeq: '9' }))); await settle();
    expect(s.client.getQueryData(workspaceChangeHeadKey(ACTOR, WORKSPACE))).toBeUndefined();
    expect(s.content).not.toHaveBeenCalled(); view.unmount();
  });
});
