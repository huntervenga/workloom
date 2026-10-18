import { QueryClientProvider } from '@tanstack/react-query';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AppRoutes } from '../../app/AppRoutes';
import { ProtectedNavigationGuard } from '../../app/ProtectedNavigationGuard';
import { SessionProvider } from '../../app/session';
import { createQueryClient } from '../../lib/queryClient';
import { queryKeys } from '../../lib/queryKeys';
import { alpha, failure, installFakeApi, ok, singleActorRoutes } from '../../test/fakeApi';
import { invitationHandoff } from './invitationHandoff';
const actor = { id: '55555555-5555-4555-8555-555555555555', kind: 'real' as const, displayName: 'Test invitation guest' };
const invitationId = '33333333-3333-4333-8333-333333333333', secret = 'A'.repeat(43);
const cleanups: (() => void)[] = [];
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); invitationHandoff.clear(); window.history.replaceState(null, '', '/'); });
function app({ authenticated = true, loseFirst = false, path = '/app/join' } = {}) {
  window.history.replaceState(null, '', `${path}#${invitationId}.${secret}`);
  invitationHandoff.capture(window.location, window.history);
  const state = { authenticated, attempts: 0 };
  const workspace = { ...alpha, role: 'member' as const };
  const api = installFakeApi({
    ...singleActorRoutes(actor, [workspace]),
    'GET /api/v1/me': () => state.authenticated ? ok({ actor, authMode: 'shared' }) : failure(401, 'UNAUTHENTICATED', 'raw text'),
    [`GET /api/v1/workspaces/${alpha.id}`]: () => ok(workspace),
    [`GET /api/v1/workspaces/${alpha.id}/projects`]: () => ok([]),
    'POST /api/v1/invitations/accept': () => ++state.attempts === 1 && loseFirst ? failure(503, 'UNAVAILABLE', 'private message') : ok({ workspaceId: alpha.id, membershipId: '88888888-8888-4888-8888-888888888888' }),
  });
  const client = createQueryClient({ retry: false }), assignDocument = vi.fn();
  const router = createMemoryRouter([{ path: '*', element: <SessionProvider assignDocument={assignDocument}><ProtectedNavigationGuard /><AppRoutes /></SessionProvider> }], { initialEntries: [path.slice(4)] });
  const view = render(<QueryClientProvider client={client}><RouterProvider router={router} /></QueryClientProvider>);
  cleanups.push(() => { view.unmount(); router.dispose(); client.clear(); });
  return { client, router, assignDocument, state, api, user: userEvent.setup({ pointerEventsCheck: 0 }) };
}
describe('invitation acceptance UX', () => {
  it('shows an anonymous reopen notice and keeps the invitation out of both Auth return URL and subsequent sign-in state', async () => {
    const ui = app({ authenticated: false });
    const signIn = await screen.findByRole('link', { name: 'Sign in' });
    expect(screen.getByText(/Sign in first, then reopen/)).toBeVisible();
    expect(window.location.hash).toBe(''); expect(document.documentElement.outerHTML.includes(secret)).toBe(false);
    expect((signIn.getAttribute('href') ?? '').includes(secret)).toBe(false);
    await ui.user.click(signIn); expect(ui.assignDocument).toHaveBeenCalledOnce();
    expect(String(ui.assignDocument.mock.calls[0]?.[0]).includes(secret)).toBe(false);
    ui.state.authenticated = true;
    await act(async () => { await ui.client.invalidateQueries({ queryKey: queryKeys.me }); });
    expect(await screen.findByText('Open your invitation link again while signed in to accept it.')).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Accept invitation' })).not.toBeInTheDocument();
    expect(ui.api.calls.filter(call => call.method === 'POST')).toHaveLength(0);
  });
  it.each(['/app/join/', '/app/JOIN', '/app/Join///', '/app/%6aoin'])('strips invitation credentials and sanitizes Auth returnTo on router-accepted path %s', async path => {
    const ui = app({ authenticated: false, path });
    const signIn = await screen.findByRole('link', { name: 'Sign in' });
    expect(window.location.hash).toBe('');
    expect((signIn.getAttribute('href') ?? '').includes(secret)).toBe(false);
    await ui.user.click(signIn);
    expect(ui.assignDocument).toHaveBeenCalledOnce();
    expect(String(ui.assignDocument.mock.calls[0]?.[0]).includes(secret)).toBe(false);
    expect(invitationHandoff.forActor(actor.id)).toBeNull();
  });
  it('waits for explicit acceptance and keeps a stable retry until one confirmed ACK opens the joined workspace', async () => {
    const ui = app({ loseFirst: true });
    const accept = await screen.findByRole('button', { name: 'Accept invitation' });
    expect(ui.api.calls.filter(call => call.method === 'POST')).toHaveLength(0);
    await ui.user.click(accept);
    await ui.user.click(await screen.findByRole('button', { name: 'Retry same action' }));
    await waitFor(() => expect(ui.router.state.location.pathname).toBe(`/w/${alpha.id}/projects`));
    const sent = ui.api.calls.filter(call => call.method === 'POST'); expect(sent).toHaveLength(2);
    expect(sent[0]?.headers.get('Idempotency-Key')).toBe(sent[1]?.headers.get('Idempotency-Key'));
    expect(sent.map(call => call.headers.get('X-Workloom-Actor-ID'))).toEqual([actor.id, actor.id]);
    expect(sent[0]?.body).toEqual(sent[1]?.body);
    expect(invitationHandoff.forActor(actor.id)).toBeNull();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
  it('drops a captured invitation after leaving the join route, so returning cannot accept stale credentials', async () => {
    const ui = app(); await screen.findByRole('button', { name: 'Accept invitation' });
    await ui.user.click(screen.getByRole('link', { name: 'Back to workspaces' }));
    await waitFor(() => expect(ui.router.state.location.pathname).toBe(`/w/${alpha.id}`));
    await act(async () => { await ui.router.navigate('/join'); });
    expect(await screen.findByText('Open your invitation link again while signed in to accept it.')).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Accept invitation' })).not.toBeInTheDocument();
    expect(ui.api.calls.filter(call => call.method === 'POST')).toHaveLength(0);
  });
});
