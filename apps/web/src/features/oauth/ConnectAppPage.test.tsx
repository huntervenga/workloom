import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { failure, installFakeApi, ok } from '../../test/fakeApi';
import { ConnectAppPage, consentNavigation } from './ConnectAppPage';

const query = 'response_type=code&client_id=wlm_client_AAAAAAAAAAAAAAAAAAAAAA&redirect_uri=https%3A%2F%2Fclaude.ai%2Fapi%2Fmcp%2Fauth_callback&code_challenge=x&code_challenge_method=S256&state=s';
const consent = { client: { id: 'wlm_client_AAAAAAAAAAAAAAAAAAAAAA', name: 'Claude', redirectUri: 'https://claude.ai/api/mcp/auth_callback', redirectHost: 'claude.ai' }, scopes: ['read', 'tasks:write'], user: { displayName: 'Anna' } };
function mount(search = `?${query}`) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(<QueryClientProvider client={client}><MemoryRouter initialEntries={[`/connect${search}`]}><ConnectAppPage /></MemoryRouter></QueryClientProvider>);
}
afterEach(() => { vi.restoreAllMocks(); });

describe('connect app consent', () => {
  it('shows who connects, what it may do and where it returns, then sends the browser back with the decision', async () => {
    const assign = vi.spyOn(consentNavigation, 'assign').mockImplementation(() => undefined);
    const { calls } = installFakeApi({
      'GET /api/v1/oauth/authorize': request => { expect(request.searchParams.get('client_id')).toBe(consent.client.id); return ok(consent); },
      'POST /api/v1/oauth/authorize': request => { expect(request.body).toEqual({ request: query, decision: 'approve' }); return ok({ redirectTo: 'https://claude.ai/api/mcp/auth_callback?code=c&state=s' }); },
    });
    const user = userEvent.setup();
    mount();
    expect(await screen.findByRole('heading', { name: 'Connect Claude to Workloom' })).toBeInTheDocument();
    expect(screen.getByText('Signed in as Anna.')).toBeInTheDocument();
    expect(screen.getByText(/Create and update tasks and their fields/)).toBeInTheDocument();
    expect(screen.getByText(/returns you to claude\.ai/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Allow access' }));
    await waitFor(() => expect(assign).toHaveBeenCalledWith('https://claude.ai/api/mcp/auth_callback?code=c&state=s'));
    expect(calls.filter(call => call.method === 'POST')).toHaveLength(1);
  });

  it('sends a denial back to the app', async () => {
    const assign = vi.spyOn(consentNavigation, 'assign').mockImplementation(() => undefined);
    installFakeApi({
      'GET /api/v1/oauth/authorize': () => ok(consent),
      'POST /api/v1/oauth/authorize': request => { expect(request.body).toMatchObject({ decision: 'deny' }); return ok({ redirectTo: 'https://claude.ai/api/mcp/auth_callback?error=access_denied' }); },
    });
    const user = userEvent.setup();
    mount();
    await user.click(await screen.findByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(assign).toHaveBeenCalledWith('https://claude.ai/api/mcp/auth_callback?error=access_denied'));
  });

  it('explains an invalid or missing request without offering to approve it', async () => {
    installFakeApi({ 'GET /api/v1/oauth/authorize': () => failure(400, 'VALIDATION_FAILED', 'Unknown client.') });
    mount();
    expect(await screen.findByText('This connection request is not valid')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Allow access' })).toBeNull();
  });

  it('reports a failed decision and lets the person try again', async () => {
    const assign = vi.spyOn(consentNavigation, 'assign').mockImplementation(() => undefined);
    installFakeApi({ 'GET /api/v1/oauth/authorize': () => ok(consent), 'POST /api/v1/oauth/authorize': () => failure(400, 'VALIDATION_FAILED', 'Expired.') });
    const user = userEvent.setup();
    mount();
    await user.click(await screen.findByRole('button', { name: 'Allow access' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('The connection could not be completed');
    expect(screen.getByRole('button', { name: 'Allow access' })).toBeEnabled();
    expect(assign).not.toHaveBeenCalled();
  });
});
