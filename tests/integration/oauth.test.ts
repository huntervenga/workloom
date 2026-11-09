// Real PostgreSQL + real API process: the connected-app OAuth flow in front of the remote MCP.
import { createHash, randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { rawRequest, type RawResponse } from './support/http.js';
import { planningHarness, type PlanningHarness } from './support/p2a-fixture.js';
import { requireTestDatabaseUrl } from './support/test-database-url.js';

requireTestDatabaseUrl();
let h: PlanningHarness;
let base: string;
const CALLBACK = 'http://127.0.0.1:9999/callback';

const json = <T>(res: RawResponse): T => {
  const text = res.text();
  return JSON.parse(text.startsWith('event:') || text.startsWith('data:') ? text.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trim()).join('') : text) as T;
};
const header = (res: RawResponse, name: string) => { const value = res.headers[name]; return Array.isArray(value) ? value.join(', ') : value ?? ''; };
const form = (fields: Record<string, string>) => new URLSearchParams(fields).toString();
const post = (path: string, body: string, headers: Record<string, string>) => rawRequest(base, path, { method: 'POST', headers, body });
const tokenCall = (fields: Record<string, string>) => post('/oauth/token', form(fields), { 'content-type': 'application/x-www-form-urlencoded' });
const mcp = (token: string | undefined, message: unknown) => post('/mcp', JSON.stringify(message), { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...(token ? { authorization: `Bearer ${token}` } : {}) });
const rpc = (method: string, params: unknown = {}) => ({ jsonrpc: '2.0', id: 1, method, params });
interface Tokens { access_token: string; refresh_token: string; expires_in: number; token_type: string; scope: string }

async function register(name = 'Claude Code (synthetic)', redirect = CALLBACK): Promise<string> {
  const res = await post('/oauth/register', JSON.stringify({ redirect_uris: [redirect], client_name: name, token_endpoint_auth_method: 'none', grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'] }), { 'content-type': 'application/json' });
  expect(res.status, res.text()).toBe(201);
  return json<{ client_id: string }>(res).client_id;
}
function pkce() {
  const verifier = randomBytes(48).toString('base64url');
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') };
}
const authorizeQuery = (clientId: string, challenge: string, extra: Record<string, string> = {}) =>
  new URLSearchParams({ response_type: 'code', client_id: clientId, redirect_uri: CALLBACK, code_challenge: challenge, code_challenge_method: 'S256', state: 'synthetic-state', scope: 'read tasks:write', resource: `${base}/mcp`, ...extra }).toString();
async function decide(query: string, decision: 'approve' | 'deny'): Promise<URL> {
  const res = await post('/api/v1/oauth/authorize', JSON.stringify({ request: query, decision }), { 'content-type': 'application/json', origin: base });
  expect(res.status, res.text()).toBe(200);
  return new URL(json<{ data: { redirectTo: string } }>(res).data.redirectTo);
}
/** The whole browser part: authorize, sign-in (dev session), consent and approve; returns the token response. */
async function connect(clientId: string): Promise<Tokens> {
  const { verifier, challenge } = pkce();
  const query = authorizeQuery(clientId, challenge);
  const redirected = await decide(query, 'approve');
  const res = await tokenCall({ grant_type: 'authorization_code', client_id: clientId, code: redirected.searchParams.get('code') ?? '', redirect_uri: CALLBACK, code_verifier: verifier });
  expect(res.status, res.text()).toBe(200);
  return json<Tokens>(res);
}

describe('connected apps (OAuth) for the remote MCP', () => {
  beforeAll(async () => { h = await planningHarness('oauth'); base = h.owner.api.baseUrl; }, 90_000);
  afterAll(async () => { if (h) await h.close(); }, 30_000);

  it('advertises discovery metadata and points unauthenticated MCP calls at it', async () => {
    const unauthenticated = await mcp(undefined, rpc('tools/list'));
    expect(unauthenticated.status).toBe(401);
    const challenge = header(unauthenticated, 'www-authenticate');
    expect(challenge).toContain(`resource_metadata="${base}/.well-known/oauth-protected-resource/mcp"`);
    const resource = json<{ resource: string; authorization_servers: string[]; scopes_supported: string[] }>(await rawRequest(base, '/.well-known/oauth-protected-resource/mcp', {}));
    expect(resource).toMatchObject({ resource: `${base}/mcp`, authorization_servers: [base], scopes_supported: ['read', 'tasks:write'] });
    const server = json<Record<string, unknown>>(await rawRequest(base, '/.well-known/oauth-authorization-server', {}));
    expect(server).toMatchObject({ issuer: base, authorization_endpoint: `${base}/oauth/authorize`, token_endpoint: `${base}/oauth/token`, registration_endpoint: `${base}/oauth/register`, code_challenge_methods_supported: ['S256'], token_endpoint_auth_methods_supported: ['none'] });
  });

  it('registers only allowed callbacks and validates the authorization request', async () => {
    const evil = await post('/oauth/register', JSON.stringify({ redirect_uris: ['https://evil.example/callback'] }), { 'content-type': 'application/json' });
    expect(evil.status).toBe(400);
    expect(json<{ error: string }>(evil).error).toBe('invalid_redirect_uri');
    const confidential = await post('/oauth/register', JSON.stringify({ redirect_uris: [CALLBACK], token_endpoint_auth_method: 'client_secret_basic' }), { 'content-type': 'application/json' });
    expect(json<{ error: string }>(confidential).error).toBe('invalid_client_metadata');
    const hosted = await register('Claude', 'https://claude.ai/api/mcp/auth_callback');
    expect(hosted).toMatch(/^wlm_client_/);

    const clientId = await register();
    const { challenge } = pkce();
    const unknown = await rawRequest(base, `/oauth/authorize?${authorizeQuery('wlm_client_AAAAAAAAAAAAAAAAAAAAAA', challenge)}`, {});
    expect(unknown.status).toBe(400);
    const plain = await rawRequest(base, `/oauth/authorize?${authorizeQuery(clientId, challenge, { code_challenge_method: 'plain' })}`, {});
    expect(plain.status).toBe(302);
    const back = new URL(header(plain, 'location'));
    expect(`${back.origin}${back.pathname}`).toBe(CALLBACK);
    expect(back.searchParams.get('error')).toBe('invalid_request');
    expect(back.searchParams.get('state')).toBe('synthetic-state');
    const foreign = await rawRequest(base, `/oauth/authorize?${authorizeQuery(clientId, challenge, { resource: 'https://other.example/mcp' })}`, {});
    expect(new URL(header(foreign, 'location')).searchParams.get('error')).toBe('invalid_target');
    // Loopback callbacks match on any port.
    const otherPort = await rawRequest(base, `/oauth/authorize?${authorizeQuery(clientId, challenge, { redirect_uri: 'http://127.0.0.1:41234/callback' })}`, {});
    expect(header(otherPort, 'location')).toMatch(/^\/app\/connect\?/);
    const ok = await rawRequest(base, `/oauth/authorize?${authorizeQuery(clientId, challenge)}`, {});
    expect(ok.status).toBe(302);
    expect(header(ok, 'location')).toBe(`/app/connect?${authorizeQuery(clientId, challenge)}`);
  });

  it('shows consent, refuses a cross-site decision and returns a denial to the app', async () => {
    const clientId = await register();
    const query = authorizeQuery(clientId, pkce().challenge);
    const consent = await rawRequest(base, `/api/v1/oauth/authorize?${query}`, {});
    expect(consent.status, consent.text()).toBe(200);
    expect(json<{ data: unknown }>(consent).data).toMatchObject({ client: { id: clientId, name: 'Claude Code (synthetic)', redirectHost: '127.0.0.1:9999' }, scopes: ['read', 'tasks:write'] });
    const crossSite = await post('/api/v1/oauth/authorize', JSON.stringify({ request: query, decision: 'approve' }), { 'content-type': 'application/json' });
    expect(crossSite.status).toBe(403);
    const denied = await decide(query, 'deny');
    expect(denied.searchParams.get('error')).toBe('access_denied');
    expect(denied.searchParams.get('code')).toBeNull();
    expect(denied.searchParams.get('iss')).toBe(base);
  });

  it('exchanges a code with PKCE, serves MCP with the access token and rotates refresh tokens', async () => {
    const clientId = await register();
    const { verifier, challenge } = pkce();
    const query = authorizeQuery(clientId, challenge);
    const redirected = await decide(query, 'approve');
    expect(redirected.searchParams.get('state')).toBe('synthetic-state');
    const code = redirected.searchParams.get('code') ?? '';
    const wrong = await tokenCall({ grant_type: 'authorization_code', client_id: clientId, code, redirect_uri: CALLBACK, code_verifier: pkce().verifier });
    expect(wrong.status).toBe(400);
    expect(json<{ error: string }>(wrong).error).toBe('invalid_grant');
    const exchanged = await tokenCall({ grant_type: 'authorization_code', client_id: clientId, code, redirect_uri: CALLBACK, code_verifier: verifier });
    expect(exchanged.status, exchanged.text()).toBe(200);
    expect(header(exchanged, 'cache-control')).toContain('no-store');
    const tokens = json<Tokens>(exchanged);
    expect(tokens).toMatchObject({ token_type: 'Bearer', expires_in: 3600, scope: 'read tasks:write' });
    expect(tokens.access_token).toMatch(/^wlm_oat_/);
    expect(tokens.refresh_token).toMatch(/^wlm_ort_/);

    const tools = json<{ result: { tools: { name: string }[] } }>(await mcp(tokens.access_token, rpc('tools/list'))).result.tools.map(tool => tool.name);
    expect(tools).toEqual(expect.arrayContaining(['time_summary', 'set_task_fields', 'create_task']));
    const whoami = json<{ result: { structuredContent: { result: { token: { name: string } } } } }>(await mcp(tokens.access_token, rpc('tools/call', { name: 'whoami', arguments: {} })));
    expect(whoami.result.structuredContent.result.token.name).toBe('Claude Code (synthetic)');
    const rest = await rawRequest(base, '/api/public/v1/me', { headers: { authorization: `Bearer ${tokens.access_token}` } });
    expect(rest.status).toBe(200);

    const refreshed = await tokenCall({ grant_type: 'refresh_token', client_id: clientId, refresh_token: tokens.refresh_token });
    expect(refreshed.status, refreshed.text()).toBe(200);
    const next = json<Tokens>(refreshed);
    expect(next.refresh_token).not.toBe(tokens.refresh_token);
    expect(json<{ error: string }>(await tokenCall({ grant_type: 'refresh_token', client_id: clientId, refresh_token: tokens.refresh_token })).error).toBe('invalid_grant');
    expect((await mcp(next.access_token, rpc('tools/list'))).status).toBe(200);
    const otherClient = await register();
    expect(json<{ error: string }>(await tokenCall({ grant_type: 'refresh_token', client_id: otherClient, refresh_token: next.refresh_token })).error).toBe('invalid_grant');

    // A replayed authorization code withdraws everything issued from it.
    const replay = await tokenCall({ grant_type: 'authorization_code', client_id: clientId, code, redirect_uri: CALLBACK, code_verifier: verifier });
    expect(json<{ error: string }>(replay).error).toBe('invalid_grant');
    expect((await mcp(next.access_token, rpc('tools/list'))).status).toBe(401);
    expect(json<{ error: string }>(await tokenCall({ grant_type: 'refresh_token', client_id: clientId, refresh_token: next.refresh_token })).error).toBe('invalid_grant');
  });

  it('lists the connection on the Integrations page, and revoking it there or at /oauth/revoke stops it', async () => {
    const clientId = await register('Codex (synthetic)');
    const first = await connect(clientId);
    const list = json<{ data: { id: string; name: string; tokenPrefix: string; revokedAt: string | null }[] }>(await rawRequest(base, '/api/v1/me/api-tokens', {})).data;
    const grant = list.find(row => row.name === 'Codex (synthetic)' && row.revokedAt === null);
    expect(grant?.tokenPrefix).toBe('wlm_oauth');
    // Connecting the same client again replaces its earlier grant.
    const second = await connect(clientId);
    expect((await mcp(first.access_token, rpc('tools/list'))).status).toBe(401);
    expect((await mcp(second.access_token, rpc('tools/list'))).status).toBe(200);
    const current = json<{ data: { id: string; name: string; revokedAt: string | null }[] }>(await rawRequest(base, '/api/v1/me/api-tokens', {})).data.find(row => row.name === 'Codex (synthetic)' && row.revokedAt === null);
    const revoked = await post(`/api/v1/me/api-tokens/${current?.id ?? ''}/revoke`, '{}', { 'content-type': 'application/json', origin: base });
    expect(revoked.status).toBe(200);
    expect((await mcp(second.access_token, rpc('tools/list'))).status).toBe(401);

    const third = await connect(clientId);
    const revokeCall = await post('/oauth/revoke', form({ token: third.refresh_token }), { 'content-type': 'application/x-www-form-urlencoded' });
    expect(revokeCall.status).toBe(200);
    expect((await mcp(third.access_token, rpc('tools/list'))).status).toBe(401);
  });
});
