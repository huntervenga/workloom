import { QueryClientProvider } from '@tanstack/react-query';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ActorDto, WorkspaceDto } from '@workloom/contracts';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, describe, expect, it } from 'vitest';
import { AppRoutes } from '../../app/AppRoutes';
import { ProtectedNavigationGuard } from '../../app/ProtectedNavigationGuard';
import { SessionProvider } from '../../app/session';
import { protectedDraftsFor } from '../../lib/protectedDrafts';
import { createQueryClient } from '../../lib/queryClient';
import { queryKeys } from '../../lib/queryKeys';
import { deferred, failure, installFakeApi, ok, singleActorRoutes } from '../../test/fakeApi';

const actor: ActorDto = { id: '55555555-5555-4555-8555-555555555555', displayName: 'Owner', kind: 'real' };
const workspace: WorkspaceDto = { id: 'e25f76fe-efdc-4062-9326-2ad44733dd04', name: 'Balancy', role: 'owner', timezone: 'UTC', slug: 'balancy', slugRevision: 2, slugAliases: ['old-balancy'] };
const cleanups: (() => void)[] = [];
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); });
function app(url: string, cachedList?: WorkspaceDto[]) {
  const client = createQueryClient({ retry: false });
  if (cachedList) client.setQueryData(queryKeys.workspaces(actor.id), cachedList);
  const router = createMemoryRouter([{ path: '*', element: <SessionProvider><ProtectedNavigationGuard /><AppRoutes /></SessionProvider> }], { initialEntries: [url] });
  const view = render(<QueryClientProvider client={client}><RouterProvider router={router} /></QueryClientProvider>);
  cleanups.push(() => { view.unmount(); router.dispose(); client.clear(); });
  return { client, router, user: userEvent.setup() };
}
function server(ws = workspace) {
  return installFakeApi({ ...singleActorRoutes(actor, [ws]), 'GET /api/v1/me': () => ok({ actor, authMode: 'shared' }), 'GET /api/v1/auth/config': () => ok({ authMode: 'shared' }) });
}

describe('workspace slug routes and owner address editor', () => {
  it.each([workspace.id, 'old-balancy', 'BALANCY'])('opens %s with UUID reads and replaces only the alias, preserving query/hash', async reference => {
    const api = server(); const ui = app(`/w/${reference}?task=keep&view=gantt#details`);
    await screen.findByRole('heading', { name: 'Balancy', level: 1 });
    await waitFor(() => expect(ui.router.state.location.pathname).toBe('/w/balancy'));
    expect(ui.router.state.location.search).toBe('?task=keep&view=gantt');
    expect(ui.router.state.location.hash).toBe('#details');
    expect(screen.getAllByRole('link', { name: /^Projects$/ }).every(link => link.getAttribute('href') === '/w/balancy/projects')).toBe(true);
    expect(api.calls.some(call => call.path.includes('/workspaces/balancy') || call.path.includes('/workspaces/old-balancy'))).toBe(false);
    expect(ui.client.getQueryData(queryKeys.workspace(actor.id, workspace.id))).toEqual(workspace);
    expect(ui.client.getQueryData(queryKeys.workspace(actor.id, 'balancy'))).toBeUndefined();
  });
  it('keeps the same draft through address rename, but still asks before leaving the page', async () => {
    const api = server(); const ui = app(`/w/balancy?task=keep#same`);
    await screen.findByRole('heading', { name: 'Balancy', level: 1 });
    const entry = protectedDraftsFor(ui.client).register(); entry.set(true); cleanups.push(entry.dispose);
    const next = { ...workspace, slug: 'balancy-team', slugRevision: 3, slugAliases: ['old-balancy', 'balancy'] };
    act(() => { ui.client.setQueryData(queryKeys.workspace(actor.id, workspace.id), next); });
    await waitFor(() => expect(ui.router.state.location.pathname).toBe('/w/balancy-team'));
    expect(ui.router.state.location.search).toBe('?task=keep');
    expect(ui.router.state.location.hash).toBe('#same');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(protectedDraftsFor(ui.client).protecting).toBe(true);
    expect(ui.client.getQueryData(queryKeys.workspace(actor.id, workspace.id))).toEqual(next);
    await act(async () => { void ui.router.navigate('/w/balancy-team/projects'); });
    await screen.findByRole('dialog', { name: 'Leave this page?' });
    expect(api.calls.some(call => call.path.includes('/workspaces/balancy-team'))).toBe(false);
  });
  it('blocks departure to an unknown slug while a draft is protected', async () => {
    server(); const ui = app('/w/balancy');
    await screen.findByRole('heading', { name: 'Balancy', level: 1 });
    const entry = protectedDraftsFor(ui.client).register(); entry.set(true); cleanups.push(entry.dispose);
    await act(async () => { void ui.router.navigate('/w/unknown-company'); });
    await screen.findByRole('dialog', { name: 'Leave this page?' });
    expect(ui.router.state.location.pathname).toBe('/w/balancy');
  });
  it('waits for authorized list resolution and does not probe an unknown slug', async () => {
    const answer = deferred<Response>();
    const api = installFakeApi({ 'GET /api/v1/me': () => ok({ actor, authMode: 'shared' }), 'GET /api/v1/auth/config': () => ok({ authMode: 'shared' }), 'GET /api/v1/workspaces': () => answer.promise });
    app('/w/unknown-company/projects');
    await screen.findByText('Loading workspace');
    expect(screen.queryByRole('heading', { name: 'Workspace unavailable' })).not.toBeInTheDocument();
    answer.resolve(ok([]));
    await screen.findByRole('heading', { name: 'Workspace unavailable' });
    expect(api.calls.every(call => !call.path.includes('/workspaces/unknown-company'))).toBe(true);
  });
  it('rechecks a cached old list before rejecting a new company address', async () => {
    const next = { ...workspace, slug: 'balancy-team', slugRevision: 3, slugAliases: ['old-balancy', 'balancy'] };
    const api = server(next); const ui = app('/w/balancy-team', [workspace]);
    await screen.findByRole('heading', { name: 'Balancy', level: 1 });
    expect(ui.router.state.location.pathname).toBe('/w/balancy-team');
    expect(api.calls.filter(call => call.path === '/api/v1/workspaces').length).toBeGreaterThan(0);
    expect(api.calls.every(call => !call.path.includes('/workspaces/balancy-team'))).toBe(true);
  });
  it('shows no owner editor for a member and retains UUID URL compatibility', async () => {
    server({ ...workspace, role: 'member', slug: null, slugAliases: [] });
    const ui = app(`/w/${workspace.id}`);
    await screen.findByRole('heading', { name: 'Balancy', level: 1 });
    expect(screen.queryByRole('textbox', { name: 'Company short name' })).not.toBeInTheDocument();
    expect(ui.router.state.location.pathname).toBe(`/w/${workspace.id}`);
  });
  it('previews and saves a normalized owner address without discarding other drafts', async () => {
    const next = { ...workspace, slug: 'balancy-team', slugRevision: 3, slugAliases: ['old-balancy', 'balancy'] };
    const api = installFakeApi({ ...singleActorRoutes(actor, [workspace]), 'GET /api/v1/me': () => ok({ actor, authMode: 'shared' }), 'GET /api/v1/auth/config': () => ok({ authMode: 'shared' }), [`PATCH /api/v1/workspaces/${workspace.id}/slug`]: () => ok(next) });
    const ui = app('/w/balancy');
    const input = await screen.findByRole('textbox', { name: 'Company short name' });
    await ui.user.clear(input); await ui.user.type(input, 'BALANCY-Team');
    expect(screen.getByText(`${window.location.origin}/app/w/balancy-team`)).toBeInTheDocument();
    await ui.user.click(screen.getByRole('button', { name: 'Save address' }));
    await waitFor(() => expect(ui.router.state.location.pathname).toBe('/w/balancy-team'));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(api.calls.find(call => call.method === 'PATCH')?.body).toEqual({ slug: 'balancy-team', expectedSlugRevision: 2 });
  });
  it('renders friendly unavailable feedback and keeps entered text after rejection', async () => {
    installFakeApi({ ...singleActorRoutes(actor, [workspace]), 'GET /api/v1/me': () => ok({ actor, authMode: 'shared' }), 'GET /api/v1/auth/config': () => ok({ authMode: 'shared' }), [`PATCH /api/v1/workspaces/${workspace.id}/slug`]: () => failure(422, 'DOMAIN_VALIDATION_FAILED', 'private server details') });
    const ui = app('/w/balancy'); const input = await screen.findByRole('textbox', { name: 'Company short name' });
    await ui.user.clear(input); await ui.user.type(input, 'some-company'); await ui.user.click(screen.getByRole('button', { name: 'Save address' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('This address is unavailable or reserved.');
    expect(input).toHaveValue('some-company');
    expect(screen.queryByText('private server details')).not.toBeInTheDocument();
  });
});
