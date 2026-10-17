import { describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../lib/api';
import {
  boundedReturnTo,
  checkSession,
  fetchAuthMode,
  finishAuthSession,
  loginHref,
  logoutSession,
  MAX_RETURN_TO_LENGTH,
} from './authApi';

const ORIGIN = 'https://workloom.test';
const TOKENS = { accessToken: 'access-fixture', refreshToken: 'refresh-fixture', state: 'state-fixture' };
const SHARED_ME = {
  meta: { requestId: 'req_shared_test' },
  data: {
    actor: { id: '11111111-1111-4111-8111-111111111111', displayName: 'Shared member', kind: 'real' },
    authMode: 'shared',
  },
};

interface SentRequest {
  url: string;
  init: RequestInit | undefined;
}

// Stubs only the network boundary; each request takes the next response, extra requests fail.
function stubFetch(...responses: Array<() => Response | Promise<Response>>): SentRequest[] {
  const sent: SentRequest[] = [];
  vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) => {
    sent.push({ url: typeof input === 'string' ? input : input instanceof URL ? input.href : input.url, init });
    const next = responses.shift();
    return next ? Promise.resolve(next()) : Promise.reject(new TypeError('unexpected request'));
  });
  return sent;
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function sentBody(request: SentRequest | undefined): unknown {
  const body = request?.init?.body;
  return typeof body === 'string' ? JSON.parse(body) : body;
}

describe('boundedReturnTo', () => {
  it.each([
    '/app',
    '/app/',
    '/app/w/team',
    '/app?tab=open',
    '/app#top',
    '/app/w/team/daily?d=2026-10-17&view=graph#entry-3',
    '/app/w/caf%C3%A9/notes?q=a%20b%26c#sec%20one',
  ])('keeps %s', (value) => {
    expect(boundedReturnTo(value)).toBe(value);
  });

  it.each([
    ['/app/./w/../team', '/app/team'],
    ['/app/w/%7Euser', '/app/w/%7Euser'],
  ])('normalizes %s to %s', (value, expected) => {
    expect(boundedReturnTo(value)).toBe(expected);
  });

  it.each([
    '',
    '/',
    'app',
    '/apple',
    '/application/w',
    '/app@evil.example',
    '//evil.example/app',
    '///evil.example/app',
    '/\\evil.example',
    '/app\\..\\evil',
    'https://evil.example/app',
    `${ORIGIN}/app`,
    'javascript:alert(1)',
    ' /app',
    '/app/w\nteam',
    '/app/w\tteam',
    '/app/w\u0000',
    '/app/w\u0085',
    '/app/w team',
    '/app/../evil',
    '/app/%2e%2e/evil',
    '/app/../..//evil.example',
    '/app/auth/callback',
    '/app/auth/callback/',
    '/app/auth/callback?next=1',
    '/app/auth/callback#state=x',
    '/app/auth/CALLBACK',
    '/app//auth/callback',
    '/app/auth/%63allback',
    '/app/%E0%A4%A',
    '/app/w#access_token=x',
    '/app/w?refresh_token=x',
    `/app/${'a'.repeat(MAX_RETURN_TO_LENGTH)}`,
  ])('falls back to /app for %j', (value) => {
    expect(boundedReturnTo(value)).toBe('/app');
  });

  it('always stays under /app on this origin', () => {
    for (const value of ['//evil.example', '/app/../../x', '/app/%2F%2Fevil.example', '/app?next=//evil.example#//evil']) {
      const target = new URL(boundedReturnTo(value), ORIGIN);
      expect(target.origin).toBe(ORIGIN);
      expect(target.pathname === '/app' || target.pathname.startsWith('/app/')).toBe(true);
    }
  });
});

describe('loginHref', () => {
  it('points at the same-origin login endpoint with an encoded return path', () => {
    expect(loginHref('/app/w/team?d=1&v=2#top')).toBe(
      `/api/v1/auth/login?returnTo=${encodeURIComponent('/app/w/team?d=1&v=2#top')}`,
    );
  });

  it.each(['https://evil.example/app', '/app/auth/callback', '/pricing'])('sends %s back to /app', (value) => {
    expect(loginHref(value)).toBe('/api/v1/auth/login?returnTo=%2Fapp');
  });
});

describe('fetchAuthMode', () => {
  it.each(['dev', 'shared'] as const)('reads %s mode from the config envelope', async (authMode) => {
    const sent = stubFetch(() => json(200, { data: { authMode } }));

    await expect(fetchAuthMode()).resolves.toBe(authMode);

    expect(sent).toHaveLength(1);
    expect(sent[0]?.url).toBe('/api/v1/auth/config');
    expect(sent[0]?.init?.method).toBe('GET');
  });

  it.each([{ data: { authMode: 'other' } }, { authMode: 'shared' }, { data: null }])(
    'rejects the unexpected config %j',
    async (body) => {
      stubFetch(() => json(200, body));

      await expect(fetchAuthMode()).rejects.toMatchObject({ kind: 'invalid_response' });
    },
  );

  it('keeps no server detail from a failure', async () => {
    stubFetch(() => json(500, { error: { code: 'INTERNAL', message: 'secret detail' } }));

    const error: unknown = await fetchAuthMode().catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ kind: 'server', status: 500 });
    if (!(error instanceof ApiError)) return;
    expect(`${error.message} ${JSON.stringify(error)}`).not.toContain('secret detail');
  });
});

describe('finishAuthSession', () => {
  it('posts the tokens once as JSON and returns the bounded server path', async () => {
    const sent = stubFetch(() => json(200, { data: { returnTo: '/app/w/team?d=1#top' } }));

    await expect(finishAuthSession(TOKENS)).resolves.toBe('/app/w/team?d=1#top');

    expect(sent).toHaveLength(1);
    expect(sent[0]?.url).toBe('/api/v1/auth/session');
    expect(sent[0]?.init?.method).toBe('POST');
    expect(sent[0]?.init?.credentials).toBe('same-origin');
    expect(sent[0]?.init?.headers).toEqual({ Accept: 'application/json', 'Content-Type': 'application/json' });
    expect(sentBody(sent[0])).toEqual(TOKENS);
  });

  it('sends only the three expected fields', async () => {
    const sent = stubFetch(() => json(200, { data: { returnTo: '/app' } }));

    const withExtra = { ...TOKENS, extra: 'extra-fixture' };
    await finishAuthSession(withExtra);

    expect(sentBody(sent[0])).toEqual(TOKENS);
  });

  it.each(['https://evil.example/app', '//evil.example', '/app/auth/callback', '/pricing'])(
    'replaces the server path %s with /app',
    async (returnTo) => {
      stubFetch(() => json(200, { data: { returnTo } }));

      await expect(finishAuthSession(TOKENS)).resolves.toBe('/app');
    },
  );

  it.each([
    { data: {} },
    { data: { returnTo: 7 } },
    { returnTo: '/app' },
    { data: { returnTo: '/app', accessToken: 'access-fixture' } },
    { data: { returnTo: '/app', session: { refresh_token: 'refresh-fixture' } } },
  ])('rejects the unexpected session response %j', async (body) => {
    stubFetch(() => json(200, body));

    await expect(finishAuthSession(TOKENS)).rejects.toMatchObject({ kind: 'invalid_response', status: 200 });
  });

  it('reports a lost answer as a network failure without retrying', async () => {
    const sent = stubFetch(() => Promise.reject(new TypeError('connection reset')));

    await expect(finishAuthSession(TOKENS)).rejects.toMatchObject({ kind: 'network', status: null });

    expect(sent).toHaveLength(1);
  });

  it('keeps a refusal sanitized and free of the tokens', async () => {
    const sent = stubFetch(() =>
      json(401, { error: { code: 'INVALID_STATE', message: 'state state-fixture mismatched' } }),
    );

    const error: unknown = await finishAuthSession(TOKENS).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ kind: 'unauthenticated', status: 401 });
    if (!(error instanceof ApiError)) return;
    expect(`${error.message} ${JSON.stringify(error)}`).not.toMatch(/fixture|mismatched/);
    expect(sent).toHaveLength(1);
  });

  it.each([
    { ...TOKENS, accessToken: '' },
    { ...TOKENS, state: 'x'.repeat(16_385) },
  ])('sends nothing for unusable tokens', async (tokens) => {
    const sent = stubFetch();

    await expect(finishAuthSession(tokens)).rejects.toMatchObject({ kind: 'invalid_input' });

    expect(sent).toHaveLength(0);
  });
});

describe('logoutSession', () => {
  it('posts once without a body and accepts 204', async () => {
    const sent = stubFetch(() => new Response(null, { status: 204 }));

    await expect(logoutSession()).resolves.toBeUndefined();

    expect(sent).toHaveLength(1);
    expect(sent[0]?.url).toBe('/api/v1/auth/logout');
    expect(sent[0]?.init?.method).toBe('POST');
    expect(sent[0]?.init?.body).toBeUndefined();
  });

  it('treats any other success as unconfirmed', async () => {
    stubFetch(() => json(200, { data: {} }));

    await expect(logoutSession()).rejects.toMatchObject({ kind: 'invalid_response', status: 200 });
  });

  it('reports a refusal', async () => {
    stubFetch(() => json(403, { error: { code: 'ORIGIN_REJECTED', message: 'no' } }));

    await expect(logoutSession()).rejects.toMatchObject({ kind: 'forbidden', status: 403 });
  });
});

describe('checkSession', () => {
  it('reads /api/v1/me and rejects a response that is not an identity', async () => {
    const sent = stubFetch(() => json(200, { data: {} }));

    await expect(checkSession()).rejects.toMatchObject({ kind: 'invalid_response' });

    expect(sent).toHaveLength(1);
    expect(sent[0]?.url).toBe('/api/v1/me');
    expect(sent[0]?.init?.method).toBe('GET');
    expect(sent[0]?.init?.body).toBeUndefined();
  });

  it('accepts a shared identity with one GET', async () => {
    const sent = stubFetch(() => json(200, SHARED_ME));

    await checkSession();

    expect(sent).toHaveLength(1);
    expect(sent[0]?.url).toBe('/api/v1/me');
    expect(sent[0]?.init?.method).toBe('GET');
    expect(sent[0]?.init?.body).toBeUndefined();
  });

  it('reports a missing session', async () => {
    stubFetch(() => json(401, { error: { code: 'UNAUTHENTICATED', message: 'no session' } }));

    await expect(checkSession()).rejects.toMatchObject({ kind: 'unauthenticated', status: 401 });
  });
});
