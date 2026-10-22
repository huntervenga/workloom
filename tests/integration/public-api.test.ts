// Real PostgreSQL + real API process: personal access tokens, the public REST API and the remote MCP.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { API_TOKEN_PATTERN } from '@workloom/contracts';
import { rawRequest, type RawResponse } from './support/http.js';
import { planningHarness, TEAM, OUTSIDE, MEMBERS, type PlanningHarness } from './support/p2a-fixture.js';
import { requireTestDatabaseUrl } from './support/test-database-url.js';

requireTestDatabaseUrl();
let h: PlanningHarness;
let base: string;
const PREFIX = '/api/public/v1';

interface TaskV { id: string; title: string; revision: number; priority: string; dueDate: string | null; project: { id: string }; section: { name: string } | null; status: { group: string; name: string }; assignee: { membershipId: string } | null }
interface Envelope<T> { data: T; meta: { requestId: string; nextCursor?: string | null }; error?: { code: string; details?: Record<string, unknown> } }
interface ProjectDetail { sections: { name: string }[]; statuses: { name: string; group: string }[] }
interface ToolResult { isError?: boolean; structuredContent: { result: Record<string, unknown> & { id: string; status: { group: string }; tasks: { id: string }[] }; error: { code: string } } }
interface Rpc { result: { tools: { name: string }[] } & ToolResult }
function body(res: RawResponse): string {
  const text = res.text();
  // Legacy Streamable HTTP answers as one SSE event even for a single response.
  return text.startsWith('event:') || text.startsWith('data:') ? text.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trim()).join('') : text;
}
const json = <T = Envelope<unknown>>(res: RawResponse): T => JSON.parse(body(res)) as T;
const env = <T>(res: RawResponse): Envelope<T> => json<Envelope<T>>(res);
const need = <T>(value: T | undefined | null): T => { if (value === undefined || value === null) throw new Error('Expected a value.'); return value; };
async function call(path: string, options: { token?: string; method?: string; body?: unknown; headers?: Record<string, string> } = {}) {
  const headers: Record<string, string> = { ...(options.token ? { authorization: `Bearer ${options.token}` } : {}), ...options.headers };
  if (options.body !== undefined) headers['content-type'] = 'application/json';
  return rawRequest(base, path, { method: options.method ?? 'GET', headers, ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}) });
}
/** Session route as the signed-in person; token routes need the browser Origin like every other session write. */
async function issue(client: PlanningHarness['owner'], body: Record<string, unknown> = {}) {
  const res = await rawRequest(client.api.baseUrl, '/api/v1/me/api-tokens', { method: 'POST', headers: { origin: client.api.baseUrl, 'content-type': 'application/json' }, body: JSON.stringify({ name: 'CI', scopes: ['read', 'tasks:write'], ...body }) });
  expect(res.status, res.text()).toBe(201);
  return env<{ id: string; token: string; tokenPrefix: string }>(res).data;
}
async function revoke(client: PlanningHarness['owner'], id: string) {
  const res = await rawRequest(client.api.baseUrl, `/api/v1/me/api-tokens/${id}/revoke`, { method: 'POST', headers: { origin: client.api.baseUrl, 'content-type': 'application/json' }, body: '{}' });
  expect(res.status, res.text()).toBe(200);
}
const ws = (id: string = TEAM) => `${PREFIX}/workspaces/${id}`;
async function mcp(token: string | undefined, message: unknown) {
  return call('/mcp', { ...(token ? { token } : {}), method: 'POST', body: message, headers: { accept: 'application/json, text/event-stream' } });
}
const rpc = (method: string, params: unknown = {}, id = 1) => ({ jsonrpc: '2.0', id, method, params });

describe('personal access tokens, public API and MCP', () => {
  let owner: Awaited<ReturnType<typeof issue>>;
  let projectId: string;
  beforeAll(async () => {
    h = await planningHarness('public_api');
    base = h.owner.api.baseUrl;
    await h.db.sql`update workspaces set slug = 'synthetic-team' where id = ${TEAM}`;
    owner = await issue(h.owner, { name: 'Owner CLI' });
    const project = await h.owner.tasks.createProject(`API ${Date.now()}`);
    projectId = project.id;
    await h.owner.tasks.createSection(projectId, { name: 'Backlog' });
  }, 90_000);
  afterAll(async () => { if (h) await h.close(); }, 30_000);

  it('issues a secret once, stores only its hash and never lists it', async () => {
    expect(owner.token).toMatch(API_TOKEN_PATTERN);
    const rows = await h.db.sql`select token_hash, token_prefix from api_tokens where id = ${owner.id}`;
    expect(rows[0]?.token_hash).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(rows)).not.toContain(owner.token);
    const list = await rawRequest(base, '/api/v1/me/api-tokens', { headers: { origin: base } });
    expect(list.text()).not.toContain(owner.token);
    expect(env<{ tokenPrefix: string }[]>(list).data[0]?.tokenPrefix).toBe(owner.token.slice(0, 12));
    const tables = await h.db.sql`select count(*)::int as n from audit_events where entity_type = 'api_token'`;
    expect(tables[0]?.n).toBe(0);
  });

  it('answers /me and addresses a workspace by slug or UUID', async () => {
    const me = env<{ workspaces: { id: string }[]; token: { scopes: string[] } }>(await call(`${PREFIX}/me`, { token: owner.token })).data;
    expect(me.workspaces.map(w => w.id)).toEqual([TEAM]);
    expect(me.token.scopes).toEqual(['read', 'tasks:write']);
    for (const ref of ['synthetic-team', TEAM]) {
      const res = await call(`${ws(ref)}/projects`, { token: owner.token });
      expect(res.status).toBe(200);
      expect(env<{ id: string }[]>(res).data.some(p => p.id === projectId)).toBe(true);
    }
    const detail = env<ProjectDetail>(await call(`${ws('synthetic-team')}/projects/${encodeURIComponent(need((await h.owner.tasks.listProjects()).find(p => p.id === projectId)).name)}`, { token: owner.token })).data;
    expect(detail.sections.map(s => s.name)).toContain('Backlog');
    expect(detail.statuses.map(s => s.group)).toEqual(expect.arrayContaining(['todo', 'done']));
  });

  it('creates a task from names, defaults the status and returns a flat view', async () => {
    const name = need((await h.owner.tasks.listProjects()).find(p => p.id === projectId)).name;
    const res = await call(`${ws('synthetic-team')}/tasks`, { token: owner.token, method: 'POST', body: { project: name.toUpperCase(), title: 'Rotate the keys', section: 'backlog', assignee: 'me', dueDate: '2030-01-15', priority: 'high' } });
    expect(res.status, res.text()).toBe(201);
    const task = env<TaskV>(res).data;
    expect(task).toMatchObject({ title: 'Rotate the keys', project: { id: projectId }, section: { name: 'Backlog' }, status: { group: 'todo' }, assignee: { membershipId: MEMBERS.teamOwner }, dueDate: '2030-01-15', priority: 'high', revision: 1 });
    const audit = await h.db.sql`select api_token_id, source from audit_events where entity_id = ${task.id} order by event_ordinal limit 1`;
    expect(audit[0]).toMatchObject({ api_token_id: owner.id, source: 'api' });
  });

  it('turns an unknown or ambiguous reference into a precise validation error', async () => {
    const miss = await call(`${ws()}/tasks`, { token: owner.token, method: 'POST', body: { project: projectId, title: 'x', status: 'Nonexistent' } });
    expect(miss.status).toBe(400);
    expect(json(miss).error?.details).toMatchObject({ field: 'status', reason: 'not_found' });
    const nameless = await call(`${ws()}/tasks`, { token: owner.token, method: 'POST', body: { project: 'no such project', title: 'x' } });
    expect(json(nameless).error?.details).toMatchObject({ field: 'project', reason: 'not_found' });
    const typo = await call(`${ws()}/tasks`, { token: owner.token, method: 'POST', body: { project: projectId, title: 'x', dueDat: '2030-01-01' } });
    expect(typo.status).toBe(400);
  });

  it('is idempotent for a repeated key and never duplicates the task', async () => {
    const send = () => call(`${ws()}/tasks`, { token: owner.token, method: 'POST', headers: { 'idempotency-key': 'deploy-42' }, body: { project: projectId, title: 'Deploy #42' } });
    const first = env<TaskV>(await send()).data, second = env<TaskV>(await send()).data;
    expect(second.id).toBe(first.id);
    const count = await h.db.sql`select count(*)::int as n from tasks where title = 'Deploy #42'`;
    expect(count[0]?.n).toBe(1);
  });

  it('changes status and section by name, treats an identical PATCH as a no-op and honors ifRevision', async () => {
    const created = env<TaskV>(await call(`${ws()}/tasks`, { token: owner.token, method: 'POST', body: { project: projectId, title: 'Patch me' } })).data;
    const doneName = need(env<ProjectDetail>(await call(`${ws()}/projects/${projectId}`, { token: owner.token })).data.statuses.find(s => s.group === 'done')).name;
    const moved = await call(`${ws()}/tasks/${created.id}`, { token: owner.token, method: 'PATCH', body: { status: doneName.toLowerCase(), section: 'Backlog', assignee: 'me' } });
    expect(moved.status, moved.text()).toBe(200);
    const view = env<TaskV>(moved).data;
    expect(view.status.group).toBe('done');
    expect(view.section?.name).toBe('Backlog');
    expect(view.revision).toBeGreaterThan(created.revision);
    const again = env<TaskV>(await call(`${ws()}/tasks/${created.id}`, { token: owner.token, method: 'PATCH', body: { status: doneName } })).data;
    expect(again.revision).toBe(view.revision);
    const stale = await call(`${ws()}/tasks/${created.id}`, { token: owner.token, method: 'PATCH', body: { title: 'Stale', ifRevision: created.revision } });
    expect(stale.status).toBe(409);
    const cleared = env<TaskV>(await call(`${ws()}/tasks/${created.id}`, { token: owner.token, method: 'PATCH', body: { section: null, assignee: null } })).data;
    expect(cleared).toMatchObject({ section: null, assignee: null });
  });

  it('lists with combinable filters and pages with a cursor', async () => {
    const project = await h.owner.tasks.createProject(`List ${Date.now()}`);
    const name = project.name;
    for (const [title, assignee] of [['A one', 'me'], ['A two', 'none'], ['B three', 'me']] as const) {
      const res = await call(`${ws()}/tasks`, { token: owner.token, method: 'POST', body: { project: name, title, assignee } });
      expect(res.status, res.text()).toBe(201);
    }
    const mine = env<TaskV[]>(await call(`${ws()}/tasks?project=${encodeURIComponent(name)}&assignee=me&open=true`, { token: owner.token })).data;
    expect(mine.map(t => t.title).sort()).toEqual(['A one', 'B three']);
    const none = env<TaskV[]>(await call(`${ws()}/tasks?project=${encodeURIComponent(name)}&assignee=none`, { token: owner.token })).data;
    expect(none.map(t => t.title)).toEqual(['A two']);
    const q = env<TaskV[]>(await call(`${ws()}/tasks?project=${encodeURIComponent(name)}&q=${encodeURIComponent('a_')}`, { token: owner.token })).data;
    expect(q).toEqual([]);
    const seen: string[] = [];
    let cursor = '';
    for (let page = 0; page < 5; page += 1) {
      const res = env<TaskV[]>(await call(`${ws()}/tasks?project=${encodeURIComponent(name)}&limit=2&sort=created${cursor ? `&cursor=${cursor}` : ''}`, { token: owner.token }));
      seen.push(...res.data.map(t => t.title));
      if (!res.meta.nextCursor) break;
      cursor = encodeURIComponent(res.meta.nextCursor);
    }
    expect(seen.sort()).toEqual(['A one', 'A two', 'B three']);
    const bad = await call(`${ws()}/tasks?project=${encodeURIComponent(name)}&cursor=garbage`, { token: owner.token });
    expect(bad.status).toBe(400);
  });

  it('answers a tampered cursor with a validation error, never a 500', async () => {
    for (const [sort, value] of [['updated', '0000000000'], ['due', '99999999999'], ['created', 'Z:::::::::Z']] as const) {
      const cursor = Buffer.from(JSON.stringify({ s: sort, v: value, i: '00000000-0000-4000-8000-000000000001' })).toString('base64url');
      const res = await call(`${ws()}/tasks?sort=${sort}&cursor=${cursor}`, { token: owner.token });
      expect(res.status, res.text()).toBe(400);
    }
  });

  it('lets a tasks:write token see the task it just wrote instead of failing after the commit', async () => {
    const writer = await issue(h.owner, { name: 'writer only', scopes: ['tasks:write'] });
    const name = need((await h.owner.tasks.listProjects()).find(p => p.id === projectId)).name;
    const res = await call(`${ws()}/tasks`, { token: writer.token, method: 'POST', body: { project: name, title: 'Written by a write-only token' } });
    expect(res.status, res.text()).toBe(201);
  });

  it('rejects missing, malformed, unknown and revoked tokens with 401', async () => {
    for (const token of [undefined, 'nope', 'wlm_pat_short', `wlm_pat_${'A'.repeat(43)}`]) {
      expect((await call(`${PREFIX}/me`, token ? { token } : {})).status).toBe(401);
    }
    const temp = await issue(h.owner, { name: 'temp' });
    expect((await call(`${PREFIX}/me`, { token: temp.token })).status).toBe(200);
    await revoke(h.owner, temp.id);
    expect((await call(`${PREFIX}/me`, { token: temp.token })).status).toBe(401);
    expect((await call(`${ws()}/tasks`, { token: temp.token, method: 'POST', body: { project: projectId, title: 'late' } })).status).toBe(401);
  });

  it('treats an expired token as revoked', async () => {
    const temp = await issue(h.owner, { name: 'short', expiresInDays: 1 });
    await h.db.sql`update api_tokens set created_at = now() - interval '3 days', expires_at = now() - interval '1 day' where id = ${temp.id}`;
    expect((await call(`${PREFIX}/me`, { token: temp.token })).status).toBe(401);
  });

  it('never exceeds the owner: read-only scope, viewer role, workspace restriction and foreign workspaces', async () => {
    const readOnly = await issue(h.owner, { name: 'ro', scopes: ['read'] });
    expect((await call(`${ws()}/projects`, { token: readOnly.token })).status).toBe(200);
    expect((await call(`${ws()}/tasks`, { token: readOnly.token, method: 'POST', body: { project: projectId, title: 'x' } })).status).toBe(403);

    const viewer = await issue(h.viewer, { name: 'viewer rw' });
    expect((await call(`${ws()}/projects`, { token: viewer.token })).status).toBe(200);
    expect((await call(`${ws()}/tasks`, { token: viewer.token, method: 'POST', body: { project: projectId, title: 'viewer write' } })).status).toBe(403);
    const before = await h.db.sql`select count(*)::int as n from tasks where title = 'viewer write'`;
    expect(before[0]?.n).toBe(0);

    const restricted = await issue(h.owner, { name: 'restricted', workspaceIds: [OUTSIDE] });
    expect((await call(`${ws()}/projects`, { token: restricted.token })).status).toBe(404);

    const outsider = await issue(h.outsider, { name: 'outsider' });
    expect((await call(`${ws()}/projects`, { token: outsider.token })).status).toBe(404);
    const task = need(env<TaskV[]>(await call(`${ws()}/tasks?limit=1`, { token: owner.token })).data[0]);
    expect((await call(`${ws()}/tasks/${task.id}`, { token: outsider.token })).status).toBe(404);
    expect((await call(`${ws(OUTSIDE)}/tasks/${task.id}`, { token: outsider.token })).status).toBe(404);
  });

  it('lets a revoke committed before the write barrier win over an in-flight create', async () => {
    const racing = await issue(h.owner, { name: 'race' });
    let pending: Promise<RawResponse> | undefined;
    await h.db.sql.begin(async tx => {
      await tx`select id from workspaces where id = ${TEAM} for update`;
      pending = call(`${ws()}/tasks`, { token: racing.token, method: 'POST', body: { project: projectId, title: 'Race loser' } });
      await new Promise(resolve => setTimeout(resolve, 700));
      await revoke(h.owner, racing.id);
    });
    const res = await need(pending);
    expect(res.status, res.text()).toBe(401);
    const rows = await h.db.sql`select count(*)::int as n from tasks where title = 'Race loser'`;
    expect(rows[0]?.n).toBe(0);
  }, 30_000);

  it('serves MCP over Streamable HTTP with the same permissions', async () => {
    expect((await mcp(undefined, rpc('initialize'))).status).toBe(401);
    const init = await mcp(owner.token, rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } }));
    expect(init.status, init.text()).toBe(200);
    expect(init.text()).toContain('workloom');

    const list = json<Rpc>(await mcp(owner.token, rpc('tools/list', {}, 2))).result.tools.map(t => t.name);
    expect(list).toEqual(expect.arrayContaining(['whoami', 'list_tasks', 'create_task', 'update_task', 'set_task_status']));
    const readOnly = await issue(h.owner, { name: 'ro-mcp', scopes: ['read'] });
    const roList = json<Rpc>(await mcp(readOnly.token, rpc('tools/list', {}, 3))).result.tools.map(t => t.name);
    expect(roList).toContain('list_tasks');
    expect(roList).not.toContain('create_task');

    const name = need((await h.owner.tasks.listProjects()).find(p => p.id === projectId)).name;
    const created = json<Rpc>(await mcp(owner.token, rpc('tools/call', { name: 'create_task', arguments: { project: name, title: 'From an agent', assignee: 'me', operationKey: 'agent-1' } }, 4))).result;
    expect(created.isError).toBeFalsy();
    const taskId = created.structuredContent.result.id;
    const status = json<Rpc>(await mcp(owner.token, rpc('tools/call', { name: 'set_task_status', arguments: { taskId, status: 'in progress' } }, 5))).result;
    expect(status.isError, JSON.stringify(status)).toBeFalsy();
    expect(status.structuredContent.result.status.group).toBe('in_progress');
    const mine = json<Rpc>(await mcp(owner.token, rpc('tools/call', { name: 'list_tasks', arguments: { project: [name], assignee: ['me'], open: true } }, 6))).result;
    expect(mine.structuredContent.result.tasks.map(t => t.id)).toContain(taskId);

    const viewer = await issue(h.viewer, { name: 'viewer mcp' });
    const denied = json<Rpc>(await mcp(viewer.token, rpc('tools/call', { name: 'create_task', arguments: { project: name, title: 'nope' } }, 7))).result;
    expect(denied.isError).toBe(true);
    expect(denied.structuredContent.error.code).toBe('CAPABILITY_REQUIRED');
    expect((await call('/mcp', { token: owner.token, method: 'GET' })).status).toBe(405);
  });
});
