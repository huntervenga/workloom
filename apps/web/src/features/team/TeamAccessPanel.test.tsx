import type { TeamViewDto } from '@workloom/contracts';
import { QueryClientProvider } from '@tanstack/react-query';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AppRoutes } from '../../app/AppRoutes';
import { ProtectedNavigationGuard } from '../../app/ProtectedNavigationGuard';
import { SessionProvider } from '../../app/session';
import { t } from '../../i18n';
import { createQueryClient } from '../../lib/queryClient';
import { queryKeys } from '../../lib/queryKeys';
import { alpha, anna, beta, created, failure, installFakeApi, ok, singleActorRoutes } from '../../test/fakeApi';
const actor = { id: '55555555-5555-4555-8555-555555555555', displayName: 'Test real owner', kind: 'real' as const };
const cleanups: (() => void)[] = [];
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); vi.unstubAllGlobals(); });
function setup(authMode: 'shared' | 'dev' = 'shared', issueAck = false) {
  const identity = authMode === 'shared' ? actor : anna;
  const workspaces = [{ ...alpha, role: 'owner' as const }, { ...beta, role: 'owner' as const }];
  const team: TeamViewDto = { members: [], invitations: [], allowedInviteRoles: ['admin','member','viewer'] };
  const api = installFakeApi({
    ...singleActorRoutes(identity, workspaces),
    'GET /api/v1/me': () => ok({ actor: identity, authMode }),
    ...Object.fromEntries(workspaces.flatMap(workspace => [
      [`GET /api/v1/workspaces/${workspace.id}`, () => ok(workspace)],
      [`GET /api/v1/workspaces/${workspace.id}/memberships`, () => ok([{ id: '88888888-8888-4888-8888-888888888888', workspaceId: workspace.id, userId: identity.id, displayName: identity.displayName, role: 'owner' }])],
      [`GET /api/v1/workspaces/${workspace.id}/team`, () => ok(team)],
      [`POST /api/v1/workspaces/${workspace.id}/invitations`, request => {
        if (!issueAck) return failure(503, 'UNAVAILABLE', 'private failure');
        const input = request.body as {id:string;recipient?:{firstName:string;lastName:string;email:string}};
        const invitation={id:input.id,workspaceId:workspace.id,role:'member' as const,hashVersion:1 as const,createdByUserId:identity.id,createdByMembershipId:'88888888-8888-4888-8888-888888888888',createdAt:'2026-10-18T15:00:00Z',expiresAt:'2026-10-25T15:00:00Z',revision:1,revokedAt:null,acceptedAt:null,acceptedByUserId:null,acceptedMembershipId:null,...(input.recipient?{recipient:input.recipient,pendingMembershipId:'77777777-7777-4777-8777-777777777777'}:{})};
        if(input.recipient){
          team.members=[{id:'77777777-7777-4777-8777-777777777777',workspaceId:workspace.id,userId:'66666666-6666-4666-8666-666666666666',displayName:[input.recipient.firstName,input.recipient.lastName].filter(Boolean).join(' '),role:'member',state:'active',revision:1,revokedAt:null,pending:true,email:input.recipient.email}];
          team.invitations=team.invitations.map(invite=>({...invite,revokedAt:'2026-10-18T16:00:00Z'}));
        }
        team.invitations=[...team.invitations,invitation];
        return created(invitation);
      }],
    ])),
  });
  const client = createQueryClient({ retry: false });
  // Both routes were visited earlier: the second route can render immediately from its own cache.
  for (const workspace of workspaces) client.setQueryData(queryKeys.workspace(identity.id, workspace.id), workspace);
  const router = createMemoryRouter([{ path: '*', element: <SessionProvider><ProtectedNavigationGuard /><AppRoutes /></SessionProvider> }], { initialEntries: [`/w/${alpha.id}/members`] });
  const view = render(<QueryClientProvider client={client}><RouterProvider router={router} /></QueryClientProvider>);
  cleanups.push(() => { view.unmount(); router.dispose(); client.clear(); });
  return { client, router, api, user: userEvent.setup({ pointerEventsCheck: 0 }) };
}
describe('Team UI scope and backwards compatibility', () => {
  it('creates a named pending teammate on Enter, clears the saved draft, and regenerates their link without asking for their details again',async()=>{
    let next=0;
    vi.stubGlobal('crypto',{randomUUID:()=>`${String(++next).padStart(8,'0')}-3333-4333-8333-333333333333`,getRandomValues:(bytes:Uint8Array)=>bytes.fill(7),subtle:{digest:async()=>new Uint8Array(32).fill(9).buffer}});
    const {api,user,client,router}=setup('shared',true);
    const first=await screen.findByRole('textbox',{name:'First name'});
    await waitFor(()=>expect(first).toBeEnabled());
    await user.type(first,'Maya');await user.type(screen.getByRole('textbox',{name:'Last name (optional)'}),'Chen');
    await user.type(screen.getByRole('textbox',{name:'Work email'}),'MAYA@Example.com');await user.keyboard('{Enter}');
    await screen.findByText('Not joined yet');
    expect(screen.getAllByText('Maya Chen').length).toBeGreaterThan(0);expect(screen.getAllByText('maya@example.com').length).toBeGreaterThan(0);
    expect(first).toHaveValue('');
    const sent=api.calls.filter(call=>call.method==='POST');expect(sent).toHaveLength(1);
    expect(sent[0]?.body).toMatchObject({recipient:{firstName:'Maya',lastName:'Chen',email:'maya@example.com'}});
    await user.click(screen.getByRole('button',{name:'Copy invitation link'}));const original=await navigator.clipboard.readText();
    expect(JSON.stringify(client.getQueryCache().getAll().map(q=>q.state.data))).not.toContain(new URL(original).hash.split('.')[1]);
    await waitFor(()=>expect(screen.getByRole('button',{name:'Create replacement link'})).toBeEnabled());
    await user.click(screen.getByRole('button',{name:'Create replacement link'}));
    await waitFor(()=>expect(api.calls.filter(call=>call.method==='POST')).toHaveLength(2));
    expect(api.calls.filter(call=>call.method==='POST')[1]?.body).toMatchObject({recipient:{firstName:'Maya',lastName:'Chen',email:'maya@example.com'}});
    await waitFor(()=>expect(screen.getByRole('button',{name:'Copy invitation link'})).toBeEnabled());
    await user.click(screen.getByRole('button',{name:'Copy invitation link'}));expect(await navigator.clipboard.readText()).not.toBe(original);
    expect(screen.getAllByText('Not joined yet')).toHaveLength(1);
    await act(async()=>{await router.navigate(`/w/${beta.id}/members`);});
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('retains the existing fixture roster in dev mode and never requests the shared-only Team endpoint', async () => {
    const { api } = setup('dev');
    await screen.findByRole('heading', { name: 'Members' });
    expect(await screen.findByRole('table')).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Create invitation' })).not.toBeInTheDocument();
    expect(api.calls.some(call => call.path.endsWith('/team'))).toBe(false);
  });
  it('creates a hash-only invitation and copies its credential without rendering it or putting it in a query cache', async () => {
    vi.stubGlobal('crypto', { randomUUID: () => '33333333-3333-4333-8333-333333333333', getRandomValues: (bytes: Uint8Array) => bytes.fill(7), subtle: { digest: async () => new Uint8Array(32).fill(9).buffer } });
    const { api, user, client } = setup('shared', true);
    const create = await screen.findByRole('button', { name: 'Create invitation' });
    await waitFor(() => expect(create).toBeEnabled()); await user.click(screen.getByRole('checkbox', { name: 'Create a general invitation link instead' })); await user.click(create);
    await user.click(await screen.findByRole('button', { name: 'Copy invitation link' }));
    const raw = await navigator.clipboard.readText(), credential = new URL(raw).hash.slice(1).split('.')[1] as string;
    expect(raw).toContain('/app/join#33333333-3333-4333-8333-333333333333.');
    expect(credential).toHaveLength(43);
    expect(document.documentElement.outerHTML.includes(credential)).toBe(false);
    expect(JSON.stringify(client.getQueryCache().getAll().map(query => query.state.data)).includes(credential)).toBe(false);
    const sent = api.calls.filter(call => call.method === 'POST'); expect(sent).toHaveLength(1);
    expect(Object.keys(sent[0]?.body as object).sort()).toEqual(['expiresInSeconds', 'hashVersion', 'id', 'role', 'secretHash']);
    expect(JSON.stringify(sent[0]?.body).includes(credential)).toBe(false);
  });
  it('discards workspace A unknown invite ownership when leaving for cached workspace B after confirmation', async () => {
    vi.stubGlobal('crypto', { randomUUID: () => '33333333-3333-4333-8333-333333333333', getRandomValues: (bytes: Uint8Array) => bytes.fill(7), subtle: { digest: async () => new Uint8Array(32).fill(9).buffer } });
    const { api, router, user } = setup();
    const create = await screen.findByRole('button', { name: 'Create invitation' });
    await waitFor(() => expect(create).toBeEnabled()); await user.click(screen.getByRole('checkbox', { name: 'Create a general invitation link instead' })); await user.click(create);
    const retry = await screen.findByRole('button', { name: 'Retry same action' }); expect(retry).toBeEnabled();
    expect(api.calls.filter(call => call.method === 'POST')).toHaveLength(1);
    act(() => { void router.navigate(`/w/${beta.id}/members`); });
    await user.click(await screen.findByRole('button', { name: t('shell.leaveUnconfirmed') }));
    await waitFor(() => expect(router.state.location.pathname).toBe(`/w/${beta.id}/members`));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Create invitation' })).toBeEnabled());
    expect(screen.queryByRole('button', { name: 'Retry same action' })).not.toBeInTheDocument();
    expect(screen.queryByText(t('team.command.uncertain'))).not.toBeInTheDocument();
    expect(api.calls.filter(call => call.method === 'POST')).toHaveLength(1);
    expect(api.calls.filter(call => call.method === 'POST')[0]?.path).toBe(`/api/v1/workspaces/${alpha.id}/invitations`);
    expect(screen.queryByRole('button', { name: 'Copy invitation link' })).not.toBeInTheDocument();
  });
});
