import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { alpha, anna, created, installFakeApi, ok } from '../../test/fakeApi';
import { ApiTokensPanel } from './ApiTokensPanel';

const secret = `wlm_pat_${'A'.repeat(43)}`;
const meta = (overrides: object = {}) => ({
  id: 'a0000000-0000-4000-8000-000000000001', name: 'CI', tokenPrefix: secret.slice(0, 12), scopes: ['read', 'tasks:write'], workspaceIds: null,
  createdAt: '2026-10-22T10:00:00.000Z', expiresAt: '2099-01-01T00:00:00.000Z', revokedAt: null, lastUsedAt: null, ...overrides,
});
function mount() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(<QueryClientProvider client={client}><ApiTokensPanel actorId={anna.id} workspaceId={alpha.id} workspaceName={alpha.name}/></QueryClientProvider>);
}

describe('API tokens panel', () => {
  it('shows a new token once, with ready-to-use commands, and never lists the secret', async () => {
    let tokens = [meta({ id: 'a0000000-0000-4000-8000-000000000009', name: 'Old', lastUsedAt: '2026-10-21T09:00:00.000Z' })];
    const { calls } = installFakeApi({
      'GET /api/v1/me/api-tokens': () => ok(tokens),
      'POST /api/v1/me/api-tokens': request => { tokens = [meta(), ...tokens]; expect(request.body).toMatchObject({ name: 'CI', scopes: ['read', 'tasks:write'], expiresInDays: 90 }); return created({ ...meta(), token: secret }); },
    });
    const user = userEvent.setup();
    mount();
    expect(await screen.findByText('Old')).toBeInTheDocument();
    await user.type(screen.getByLabelText('Name'), 'CI');
    await user.click(screen.getByRole('button', { name: 'Create token' }));
    const box = await screen.findByRole('region', { name: 'Copy your token now' });
    expect(within(box).getByLabelText('Personal access token')).toHaveValue(secret);
    expect(within(box).getByText(/claude mcp add --transport http workloom/)).toBeInTheDocument();
    expect(within(box).getByText(/bearer_token_env_var/)).toBeInTheDocument();
    await user.click(within(box).getByRole('button', { name: 'I saved the token · close' }));
    expect(screen.queryByDisplayValue(secret)).not.toBeInTheDocument();
    await waitFor(() => expect(screen.getAllByText('CI').length).toBeGreaterThan(0));
    expect(document.body.textContent).not.toContain(secret);
    expect(calls.filter(call => call.method === 'POST')).toHaveLength(1);
  });

  it('revokes an active token and offers no action for a revoked one', async () => {
    let tokens = [meta()];
    installFakeApi({
      'GET /api/v1/me/api-tokens': () => ok(tokens),
      'POST /api/v1/me/api-tokens/a0000000-0000-4000-8000-000000000001/revoke': () => { tokens = [meta({ revokedAt: '2026-10-22T11:00:00.000Z' })]; return ok(tokens[0]); },
    });
    const user = userEvent.setup();
    mount();
    await user.click(await screen.findByRole('button', { name: 'Revoke token CI' }));
    expect(await screen.findByText('Revoked')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Revoke token/ })).not.toBeInTheDocument();
  });
});
