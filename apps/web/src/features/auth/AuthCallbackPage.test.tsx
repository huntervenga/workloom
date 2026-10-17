import { StrictMode } from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { t } from '../../i18n';
import { AuthCallbackPage } from './AuthCallbackPage';
import { startCallbackExchange } from './callbackExchange';

const TOKENS = { accessToken: 'access-fixture', refreshToken: 'refresh-fixture', state: 'state-fixture' };

interface SentRequest {
  url: string;
  method: string | undefined;
}

function stubFetch(...responses: Array<() => Response | Promise<Response>>): SentRequest[] {
  const sent: SentRequest[] = [];
  vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) => {
    sent.push({ url: typeof input === 'string' ? input : input instanceof URL ? input.href : input.url, method: init?.method });
    const next = responses.shift();
    return next ? Promise.resolve(next()) : Promise.reject(new TypeError('unexpected request'));
  });
  return sent;
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function renderPage(tokens: typeof TOKENS | null) {
  const navigate = vi.fn();
  // Started once, outside React, exactly as mountAuthCallback does.
  const exchange = startCallbackExchange(tokens);
  render(
    <StrictMode>
      <AuthCallbackPage exchange={exchange} navigate={navigate} />
    </StrictMode>,
  );
  return navigate;
}

function expectNoSecretsExposed(): void {
  const stored: string[] = [];
  for (const storage of [localStorage, sessionStorage]) {
    for (let index = 0; index < storage.length; index += 1) {
      const key = storage.key(index);
      if (key !== null) stored.push(key, storage.getItem(key) ?? '');
    }
  }
  expect(document.documentElement.outerHTML).not.toContain('fixture');
  expect(stored.join(' ')).not.toContain('fixture');
  expect(window.location.href).not.toContain('fixture');
  expect(JSON.stringify(window.history.state)).not.toContain('fixture');
}

describe('AuthCallbackPage', () => {
  it('sends one exchange under StrictMode and leaves for the bounded server path', async () => {
    const sent = stubFetch(() => json(200, { data: { returnTo: '/app/w/team?d=1#top' } }));

    const navigate = renderPage(TOKENS);

    expect(screen.getByRole('status')).toHaveTextContent(t('auth.callbackSigningIn'));
    await waitFor(() => {
      expect(navigate).toHaveBeenCalledTimes(1);
    });
    expect(navigate).toHaveBeenCalledWith('/app/w/team?d=1#top');
    expect(sent).toEqual([{ url: '/api/v1/auth/session', method: 'POST' }]);
    expectNoSecretsExposed();
  });

  it('never follows a server path off /app', async () => {
    stubFetch(() => json(200, { data: { returnTo: 'https://evil.example/app' } }));

    const navigate = renderPage(TOKENS);

    await waitFor(() => {
      expect(navigate).toHaveBeenCalledWith('/app');
    });
  });

  it('offers a sign-in check after a lost answer and never resends the tokens', async () => {
    const sent = stubFetch(
      () => Promise.reject(new TypeError('connection reset')),
      () => json(401, { error: { code: 'UNAUTHENTICATED', message: 'no session' } }),
    );

    const navigate = renderPage(TOKENS);

    expect(await screen.findByText(t('auth.callbackFailed'))).toHaveAttribute('role', 'alert');
    expect(screen.getByRole('link', { name: t('auth.restartSignIn') })).toHaveAttribute(
      'href',
      '/api/v1/auth/login?returnTo=%2Fapp',
    );
    expect(screen.getByRole('link', { name: t('auth.backToSite') })).toHaveAttribute('href', '/');

    fireEvent.click(screen.getByRole('button', { name: t('auth.checkSession') }));

    expect(await screen.findByText(t('auth.checkSessionFailed'))).toHaveAttribute('role', 'alert');
    expect(sent).toEqual([
      { url: '/api/v1/auth/session', method: 'POST' },
      { url: '/api/v1/me', method: 'GET' },
    ]);
    expect(navigate).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: t('auth.checkSession') })).toBeEnabled();
    expectNoSecretsExposed();
  });

  it('enters the app once a sign-in check after a lost answer succeeds', async () => {
    const sent = stubFetch(
      () => Promise.reject(new TypeError('connection reset')),
      () =>
        json(200, {
          meta: { requestId: 'req_shared_test' },
          data: {
            actor: { id: '11111111-1111-4111-8111-111111111111', displayName: 'Shared member', kind: 'real' },
            authMode: 'shared',
          },
        }),
    );

    const navigate = renderPage(TOKENS);

    expect(await screen.findByText(t('auth.callbackFailed'))).toHaveAttribute('role', 'alert');
    expect(navigate).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: t('auth.checkSession') }));

    await waitFor(() => {
      expect(navigate).toHaveBeenCalledTimes(1);
    });
    expect(navigate).toHaveBeenCalledWith('/app');
    expect(sent).toEqual([
      { url: '/api/v1/auth/session', method: 'POST' },
      { url: '/api/v1/me', method: 'GET' },
    ]);
    expectNoSecretsExposed();
  });

  it('shows a refused exchange without retrying it', async () => {
    const sent = stubFetch(() => json(400, { error: { code: 'INVALID_STATE', message: 'state-fixture rejected' } }));

    const navigate = renderPage(TOKENS);

    expect(await screen.findByText(t('auth.callbackFailed'))).toBeInTheDocument();
    expect(sent).toHaveLength(1);
    expect(navigate).not.toHaveBeenCalled();
    expectNoSecretsExposed();
  });

  it('sends nothing for a callback without usable tokens', async () => {
    const sent = stubFetch();

    const navigate = renderPage(null);

    expect(await screen.findByText(t('auth.callbackInvalid'))).toHaveAttribute('role', 'alert');
    expect(screen.getByRole('button', { name: t('auth.checkSession') })).toBeInTheDocument();
    expect(sent).toHaveLength(0);
    expect(navigate).not.toHaveBeenCalled();
  });
});
