import { QueryClientProvider } from '@tanstack/react-query';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { StrictMode } from 'react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AppRoutes } from '../../app/AppRoutes';
import { ProtectedNavigationGuard } from '../../app/ProtectedNavigationGuard';
import { SessionProvider } from '../../app/session';
import { createQueryClient } from '../../lib/queryClient';
import { alpha, failure, installFakeApi, json, ok, singleActorRoutes } from '../../test/fakeApi';
import { invitationHandoff } from './invitationHandoff';
const actor = { id: '55555555-5555-4555-8555-555555555555', kind: 'real' as const, displayName: 'Test invitation guest' };
const invitationId = '33333333-3333-4333-8333-333333333333', secret = 'A'.repeat(43);
const cleanups: (() => void)[] = [];
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); invitationHandoff.clear(); window.history.replaceState(null, '', '/'); });
function app({ authenticated = true, loseFirst = false, path = '/app/join', withCredential = true, stageFail = false, reason = '', strict = false } = {}) {
  window.history.replaceState(null, '', `${path}${withCredential ? `#${invitationId}.${secret}` : ''}`);
  invitationHandoff.capture(window.location, window.history);
  const state = { authenticated, attempts: 0, stages: 0 };
  const workspace = { ...alpha, role: 'member' as const };
  const accept = () => {
    state.attempts++;
    if (reason) return json(422,{error:{code:'DOMAIN_VALIDATION_FAILED',message:'private text',retryable:false,details:{invitationReason:reason}},meta:{requestId:'invitation'}});
    return state.attempts === 1 && loseFirst ? failure(503, 'UNAVAILABLE', 'private message') : ok({ workspaceId: alpha.id, membershipId: '88888888-8888-4888-8888-888888888888' });
  };
  const api = installFakeApi({
    ...singleActorRoutes(actor, [workspace]),
    'GET /api/v1/me': () => state.authenticated ? ok({ actor, authMode: 'shared' }) : failure(401, 'UNAUTHENTICATED', 'raw text'),
    [`GET /api/v1/workspaces/${alpha.id}`]: () => ok(workspace),
    [`GET /api/v1/workspaces/${alpha.id}/projects`]: () => ok([]),
    'POST /api/v1/invitations/accept': accept,
    'POST /api/v1/auth/invitation-handoff/accept': accept,
    'POST /api/v1/auth/invitation-handoff/clear': () => new Response(null,{status:204}),
    'POST /api/v1/auth/invitation-handoff': () => ++state.stages === 1 && stageFail ? failure(503,'UNAVAILABLE','raw text') : new Response(null,{status:204}),
  });
  const client = createQueryClient({ retry: false }), assignDocument = vi.fn();
  const router = createMemoryRouter([{ path: '*', element: <SessionProvider assignDocument={assignDocument}><ProtectedNavigationGuard /><AppRoutes /></SessionProvider> }], { initialEntries: [path.slice(4)] });
  const contents=<QueryClientProvider client={client}><RouterProvider router={router} /></QueryClientProvider>;
  const view = render(strict ? <StrictMode>{contents}</StrictMode> : contents);
  cleanups.push(() => { view.unmount(); router.dispose(); client.clear(); });
  return { client, router, assignDocument, state, api, user: userEvent.setup({ pointerEventsCheck: 0 }) };
}
const accepts = (api: ReturnType<typeof installFakeApi>) => api.calls.filter(call => call.method === 'POST' && call.path.endsWith('/accept'));
describe('invitation acceptance UX', () => {
  it('stages only on explicit sign-in-and-join, then leaves for Auth without a secret in its URL or caches', async () => {
    const ui = app({ authenticated: false });
    const signIn = await screen.findByRole('button', { name: 'Sign in and join' });
    expect(ui.api.calls.filter(call=>call.method==='POST')).toHaveLength(0);
    expect(window.location.hash).toBe(''); expect(document.documentElement.outerHTML.includes(secret)).toBe(false);
    await ui.user.click(signIn); expect(ui.assignDocument).toHaveBeenCalledOnce();
    expect(String(ui.assignDocument.mock.calls[0]?.[0]).includes(secret)).toBe(false);
    expect(ui.api.calls.filter(call=>call.path==='/api/v1/auth/invitation-handoff')).toHaveLength(1);
    expect(ui.api.calls.find(call=>call.path==='/api/v1/auth/invitation-handoff')?.body).toEqual({invitationId,secret});
    expect(JSON.stringify(ui.client.getQueryCache().getAll().map(q=>q.state.data))).not.toContain(secret);
    expect(ui.client.getMutationCache().getAll()).toHaveLength(0);
    expect(accepts(ui.api)).toHaveLength(0);
    expect(invitationHandoff.forSignIn()).toBeNull();
  });
  it('keeps the anonymous link in memory after a staging failure and retries before leaving',async()=>{
    const ui=app({authenticated:false,stageFail:true});
    await ui.user.click(await screen.findByRole('button',{name:'Sign in and join'}));
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not prepare this invitation');
    expect(ui.assignDocument).not.toHaveBeenCalled();expect(invitationHandoff.forSignIn()?.invitationId).toBe(invitationId);
    await ui.user.click(screen.getByRole('button',{name:'Sign in and join'}));
    expect(ui.assignDocument).toHaveBeenCalledOnce();expect(ui.state.stages).toBe(2);
  });
  it.each(['/app/join/', '/app/JOIN', '/app/Join///', '/app/%6aoin'])('strips credentials before explicit sign-in on router-accepted path %s', async path => {
    const ui = app({ authenticated: false, path });
    const signIn = await screen.findByRole('button', { name: 'Sign in and join' });
    expect(window.location.hash).toBe('');
    await ui.user.click(signIn);
    expect(ui.assignDocument).toHaveBeenCalledOnce();
    expect(String(ui.assignDocument.mock.calls[0]?.[0]).includes(secret)).toBe(false);
    expect(invitationHandoff.forActor(actor.id)).toBeNull();
  });
  it('waits for explicit signed-in acceptance and retries the exact unknown command before clearing its cookie', async () => {
    const ui = app({ loseFirst: true });
    const accept = await screen.findByRole('button', { name: 'Accept invitation' });
    expect(accepts(ui.api)).toHaveLength(0);
    await ui.user.click(accept);
    await screen.findByRole('button',{name:'Retry same action'});
    expect(ui.api.calls.some(call=>call.path.endsWith('/clear'))).toBe(false);
    await ui.user.click(screen.getByRole('button', { name: 'Retry same action' }));
    await waitFor(() => expect(ui.router.state.location.pathname).toBe(`/w/${alpha.id}/projects`));
    const sent = accepts(ui.api); expect(sent).toHaveLength(2);
    expect(sent[0]?.headers.get('Idempotency-Key')).toBe(sent[1]?.headers.get('Idempotency-Key'));
    expect(sent.map(call => call.headers.get('X-Workloom-Actor-ID'))).toEqual([actor.id, actor.id]);
    expect(sent[0]?.body).toEqual(sent[1]?.body);
    expect(ui.api.calls.filter(call=>call.path.endsWith('/clear'))).toHaveLength(1);
    expect(invitationHandoff.forActor(actor.id)).toBeNull();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
  it('resumes once after sign-in even under StrictMode, and keeps the same empty command for a lost response retry',async()=>{
    const ui=app({withCredential:false,path:'/app/join?resume=1',loseFirst:true,strict:true});
    await screen.findByRole('button',{name:'Retry same action'});
    expect(accepts(ui.api)).toHaveLength(1);
    expect(accepts(ui.api)[0]?.path).toBe('/api/v1/auth/invitation-handoff/accept');
    expect(accepts(ui.api)[0]?.body).toEqual({});
    expect(ui.api.calls.some(call=>call.path.endsWith('/clear'))).toBe(false);
    await ui.user.click(screen.getByRole('button',{name:'Retry same action'}));
    await waitFor(()=>expect(ui.router.state.location.pathname).toBe(`/w/${alpha.id}/projects`));
    expect(accepts(ui.api)).toHaveLength(2);
    expect(accepts(ui.api)[0]?.headers.get('Idempotency-Key')).toBe(accepts(ui.api)[1]?.headers.get('Idempotency-Key'));
    expect(ui.api.calls.filter(call=>call.path.endsWith('/clear'))).toHaveLength(1);
  });
  it('does not let a resume marker override a newly captured invitation fragment',async()=>{
    const ui=app({path:'/app/join?resume=1'});
    await screen.findByRole('button',{name:'Accept invitation'});
    expect(accepts(ui.api)).toHaveLength(0);
  });
  it('does not attempt automatic acceptance from an ordinary join URL without a fragment or resume flag',async()=>{
    const ui=app({withCredential:false});
    await screen.findByText('Open your invitation link again while signed in to accept it.');
    expect(accepts(ui.api)).toHaveLength(0);
  });
  it.each([['email_mismatch','This invitation is for a different email.'],['email_unverified','Your account needs a confirmed email'],['member_conflict','This account already has a different membership']] as const)('explains %s without exposing server messages',async(reason,message)=>{
    const ui=app({reason});await ui.user.click(await screen.findByRole('button',{name:'Accept invitation'}));
    expect(await screen.findByRole('alert')).toHaveTextContent(message);
    expect(screen.getByRole('button',{name:'Sign in with another account'})).toBeEnabled();
    expect(ui.api.calls.some(call=>call.path.endsWith('/clear'))).toBe(false);
    expect(document.body.textContent).not.toContain('private text');
  });
  it('drops a captured invitation after leaving the join route, so returning cannot accept stale credentials', async () => {
    const ui = app(); await screen.findByRole('button', { name: 'Accept invitation' });
    await ui.user.click(screen.getByRole('link', { name: 'Back to workspaces' }));
    await waitFor(() => expect(ui.router.state.location.pathname).toBe(`/w/${alpha.id}`));
    await act(async () => { await ui.router.navigate('/join'); });
    expect(await screen.findByText('Open your invitation link again while signed in to accept it.')).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Accept invitation' })).not.toBeInTheDocument();
    expect(accepts(ui.api)).toHaveLength(0);
  });
});
