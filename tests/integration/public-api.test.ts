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

  it('rejects oversized MCP batches without exhausting the same address or token budget', async () => {
    const denied = await mcp(owner.token, Array.from({ length: 601 }, (_, index) => rpc('ping', {}, index + 1)));
    expect(denied.status, denied.text()).toBe(400);
    expect(json<{ error: { code: number } }>(denied).error.code).toBe(-32600);
    const next = await call(`${PREFIX}/me`, { token: owner.token });
    expect(next.status, next.text()).toBe(200);
  });

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

  it('keeps older active tokens visible and revocable behind more than 200 newer inactive tokens', async () => {
    const active = await issue(h.owner, { name: 'Old still-active token' });
    const [source] = await h.db.sql`select user_id from api_tokens where id=${active.id}`;
    if (!source) throw new Error('Expected synthetic token owner.');
    await h.db.sql`update api_tokens set created_at=now()-interval '3 days' where id=${active.id}`;
    const prefix = `inactive-list-${active.id}-`;
    try {
      await h.db.sql`insert into api_tokens(id,user_id,name,token_hash,token_prefix,scopes,created_at,expires_at,revoked_at)
        select gen_random_uuid(),${source.user_id},${prefix}||n::text,repeat(md5(${active.id}||n::text),2),'wlm_pat_test','["read"]'::jsonb,now()-interval '2 days',
          case when n%2=0 then now()-interval '1 day' else now()+interval '1 day' end,
          case when n%2=1 then now()-interval '1 day' else null end
        from generate_series(1,205) n`;
      const response=await rawRequest(base,'/api/v1/me/api-tokens',{headers:{origin:base}});
      expect(response.status,response.text()).toBe(200);
      const rows=env<{id:string}[]>(response).data;
      expect(rows).toHaveLength(200);expect(rows.some(row=>row.id===active.id)).toBe(true);
      await revoke(h.owner,active.id);
      expect((await call(`${PREFIX}/me`,{token:active.token})).status).toBe(401);
    } finally {
      await h.db.sql`delete from api_tokens where name like ${prefix+'%'}`;
    }
  });

  it('rejects an explicitly empty workspace restriction instead of turning it into an unrestricted token', async () => {
    const name = `empty-scope-${Date.now()}`;
    const response = await rawRequest(base, '/api/v1/me/api-tokens', {
      method: 'POST',
      headers: { origin: base, 'content-type': 'application/json' },
      body: JSON.stringify({ name, scopes: ['read'], workspaceIds: [] }),
    });
    expect(response.status, response.text()).toBe(400);
    const rows = await h.db.sql`select count(*)::int as n from api_tokens where name = ${name}`;
    expect(rows[0]?.n).toBe(0);
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
    for (const [sort, value, id] of [
      ['updated', '0000000000', '00000000-0000-4000-8000-000000000001'],
      ['due', '99999999999', '00000000-0000-4000-8000-000000000001'],
      ['created', 'Z:::::::::Z', '00000000-0000-4000-8000-000000000001'],
      ['due', '2026-02-31', '00000000-0000-4000-8000-000000000001'],
      ['updated', '2026-02-31T00:00:00.000Z', '00000000-0000-4000-8000-000000000001'],
      ['updated', '2026-02-28T00:00:00.000Z', '------------------------------------'],
    ] as const) {
      const cursor = Buffer.from(JSON.stringify({ s: sort, v: value, i: id })).toString('base64url');
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
    const anonymous = await mcp(undefined, rpc('initialize'));
    expect(anonymous.status).toBe(401);
    expect(anonymous.headers['cache-control']).toBe('no-store');
    const init = await mcp(owner.token, rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } }));
    expect(init.status, init.text()).toBe(200);
    expect(init.headers['cache-control']).toBe('no-store, no-transform');
    expect(init.text()).toContain('workloom');

    const list = json<Rpc>(await mcp(owner.token, rpc('tools/list', {}, 2))).result.tools.map(t => t.name);
    expect(list).toEqual(expect.arrayContaining(['whoami', 'list_tasks', 'create_task', 'update_task', 'set_task_status', 'list_fields', 'set_task_fields', 'time_summary']));
    expect(init.text()).toContain('Estimation');
    const readOnly = await issue(h.owner, { name: 'ro-mcp', scopes: ['read'] });
    const roList = json<Rpc>(await mcp(readOnly.token, rpc('tools/list', {}, 3))).result.tools.map(t => t.name);
    expect(roList).toContain('list_tasks');
    expect(roList).not.toContain('create_task');
    expect(roList).toEqual(expect.arrayContaining(['list_fields', 'time_summary']));
    expect(roList).not.toContain('set_task_fields');

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
    const deniedResponse = await mcp(viewer.token, rpc('tools/call', { name: 'create_task', arguments: { project: name, title: 'nope' } }, 7));
    expect(deniedResponse.headers['cache-control']).toBe('no-store, no-transform');
    const denied = json<Rpc>(deniedResponse).result;
    expect(denied.isError).toBe(true);
    expect(denied.structuredContent.error.code).toBe('CAPABILITY_REQUIRED');
    expect((await call('/mcp', { token: owner.token, method: 'GET' })).status).toBe(405);
  });

  it('adds an existing task to another project over REST and MCP without moving its home', async () => {
    interface Placement { taskId: string; project: { id: string; name: string }; section: { name: string } | null; home: boolean; outcome: string }
    const week = await h.owner.tasks.createProject(`Week ${Date.now()}`);
    await h.owner.tasks.createSection(week.id, { name: 'Michael' });
    const created = await call(`${ws()}/tasks`, { token: owner.token, method: 'POST', body: { project: projectId, title: 'Backlog item to plan' } });
    expect(created.status, created.text()).toBe(201);
    const task = env<TaskV>(created).data;
    const path = `${ws()}/tasks/${task.id}/projects`;
    const placed = async (body: unknown, key?: string) => call(path, { token: owner.token, method: 'POST', body, ...(key ? { headers: { 'idempotency-key': key } } : {}) });

    const added = await placed({ project: week.name, section: 'michael' }, 'place-1');
    expect(added.status, added.text()).toBe(201);
    // Neither project tracks time, so the home stays where it is.
    expect(env<Placement>(added).data).toEqual({ taskId: task.id, project: { id: week.id, name: week.name }, section: expect.objectContaining({ name: 'Michael' }), home: false, homeProject: { id: projectId, name: expect.any(String) }, outcome: 'added', homeChanged: false, homeReason: 'kept', copiedValues: 0 });
    // Repeating is safe, and the task keeps its home project and revision.
    const again = await placed({ project: week.id }, 'place-2');
    expect(again.status, again.text()).toBe(200);
    expect(env<Placement>(again).data).toMatchObject({ outcome: 'unchanged', section: { name: 'Michael' } });
    expect(env<Placement>(await placed({ project: projectId })).data).toMatchObject({ outcome: 'unchanged', home: true });
    const after = env<TaskV>(await call(`${ws()}/tasks/${task.id}`, { token: owner.token })).data;
    expect(after.project.id).toBe(projectId);
    expect(after.revision).toBe(task.revision);
    const rows = await h.db.sql<{ id: string; revision: number }[]>`select id, revision from task_project_placements where task_id = ${task.id} and project_id = ${week.id}`;
    expect(rows).toHaveLength(1);

    // Removed from the week in the app, then put back by the tool.
    const row = need(rows[0]);
    const detached = await h.owner.tasks.post(`/task-project-placements/${row.id}/detach`, { expectedRevision: row.revision });
    expect(detached.status, detached.text()).toBe(200);
    const restored = await placed({ project: week.name });
    expect(restored.status, restored.text()).toBe(200);
    expect(env<Placement>(restored).data).toMatchObject({ outcome: 'restored', section: { name: 'Michael' } });

    const unknown = await placed({ project: week.name, section: 'Nobody here' });
    expect(unknown.status, unknown.text()).toBe(400);
    expect(env(unknown).error?.details).toMatchObject({ field: 'section', reason: 'not_found' });
    const viewer = await issue(h.viewer, { name: 'viewer placement' });
    const refused = await call(path, { token: viewer.token, method: 'POST', body: { project: week.name } });
    expect(refused.status, refused.text()).toBe(403);

    const other = await h.owner.tasks.createProject(`Other ${Date.now()}`);
    const tools = json<Rpc>(await mcp(owner.token, rpc('tools/list', {}, 20))).result.tools.map(t => t.name);
    expect(tools).toContain('add_task_to_project');
    const readOnly = await issue(h.owner, { name: 'ro placement', scopes: ['read'] });
    expect(json<Rpc>(await mcp(readOnly.token, rpc('tools/list', {}, 21))).result.tools.map(t => t.name)).not.toContain('add_task_to_project');
    const viaMcp = json<Rpc>(await mcp(owner.token, rpc('tools/call', { name: 'add_task_to_project', arguments: { taskId: task.id, project: other.name, operationKey: 'mcp-place-1' } }, 22))).result;
    expect(viaMcp.isError, JSON.stringify(viaMcp)).toBeFalsy();
    expect(viaMcp.structuredContent.result).toMatchObject({ taskId: task.id, project: { id: other.id }, section: null, home: false, outcome: 'added' });
  });

  it('makes a project that tracks time the home, keeps the former home listed, and asks for a choice when both track time', async () => {
    interface Placement { project: { id: string }; home: boolean; homeProject: { id: string }; outcome: string; homeChanged: boolean; homeReason: string; copiedValues: number }
    // A week tracks time: it has dates (every project has time fields, so they no longer decide). Its hours field is for values.
    const duration = async (id: string, from: string) => {
      const res = await h.owner.tasks.post('/fields', { projectId: id, name: 'Hours Est', type: 'duration', historyEnabled: true, locked: false, options: [] }); expect(res.status, res.text()).toBeLessThan(300);
      const project = await h.owner.tasks.getProject(id);
      await h.owner.tasks.updateProject(id, { expectedRevision: project.revision, dateRange: { from, to: from } });
    };
    const backlog = await h.owner.tasks.createProject(`Backlog ${Date.now()}`);
    const week = await h.owner.tasks.createProject(`Week time ${Date.now()}`);
    await duration(week.id, '2026-11-09');
    const created = env<TaskV>(await call(`${ws()}/tasks`, { token: owner.token, method: 'POST', body: { project: backlog.id, title: 'Plan me this week' } })).data;
    const path = `${ws()}/tasks/${created.id}/projects`;
    const placed = (body: unknown) => call(path, { token: owner.token, method: 'POST', body });
    const homeOf = async () => env<TaskV>(await call(`${ws()}/tasks/${created.id}`, { token: owner.token })).data.project.id;

    // The backlog has no dates and the week has: the week becomes the home, the backlog stays among its projects.
    const moved = await placed({ project: week.name });
    expect(moved.status, moved.text()).toBe(201);
    expect(env<Placement>(moved).data).toMatchObject({ project: { id: week.id }, home: true, homeProject: { id: week.id }, outcome: 'added', homeChanged: true, homeReason: 'time_fields' });
    expect(await homeOf()).toBe(week.id);
    const listed = await h.db.sql<{ project_id: string; archived: boolean }[]>`select project_id::text, archived_at is not null as archived from task_project_placements where task_id = ${created.id}`;
    expect(listed.map(row => `${row.project_id}:${row.archived}`).sort()).toEqual([`${backlog.id}:false`, `${week.id}:false`].sort());
    expect(env<Placement>(await placed({ project: week.name })).data).toMatchObject({ outcome: 'unchanged', home: true, homeChanged: false, homeReason: 'already_home' });

    // Hours are planned in the week; then the next week tracks time too, so the call asks which one counts the hours.
    const fields = await call(`${ws()}/task-fields`, { token: owner.token, method: 'POST', body: { items: [{ taskId: created.id, project: week.id, values: [{ field: 'Hours Est', value: '2h' }] }] } });
    expect(fields.status, fields.text()).toBe(200);
    const next = await h.owner.tasks.createProject(`Next week ${Date.now()}`);
    await duration(next.id, '2026-11-16');
    const ask = await placed({ project: next.name });
    expect(ask.status, ask.text()).toBe(400);
    expect(env(ask).error?.details).toMatchObject({ field: 'home', reason: 'choice_required', homeProject: { id: week.id }, project: { id: next.id } });
    expect(env<Placement>(await placed({ project: next.name, home: false })).data).toMatchObject({ outcome: 'added', home: false, homeProject: { id: week.id }, homeChanged: false, homeReason: 'kept' });
    // Choosing it turns the existing placement into the home row and copies the matching value.
    const chosen = await placed({ project: next.id, home: true });
    expect(chosen.status, chosen.text()).toBe(200);
    expect(env<Placement>(chosen).data).toMatchObject({ outcome: 'unchanged', home: true, homeChanged: true, homeReason: 'requested', copiedValues: 1 });
    expect(await homeOf()).toBe(next.id);

    // Over MCP the same choice is a tool argument.
    const viaMcp = json<Rpc>(await mcp(owner.token, rpc('tools/call', { name: 'add_task_to_project', arguments: { taskId: created.id, project: backlog.name, home: true } }, 30))).result;
    expect(viaMcp.isError, JSON.stringify(viaMcp)).toBeFalsy();
    expect(viaMcp.structuredContent.result).toMatchObject({ project: { id: backlog.id }, home: true, homeChanged: true, outcome: 'unchanged' });
    expect(await homeOf()).toBe(backlog.id);
  });

  it('creates a project from a template with its tasks, and leaves template tasks out of workspace-wide lists', async () => {
    const stamp = Date.now();
    const created = await h.owner.tasks.createProject(`Week template ${stamp}`);
    const dated = await h.owner.tasks.updateProject(created.id, { expectedRevision: created.revision, dateRange: { from: '2026-11-09', to: '2026-11-15' } });
    const plain = await h.owner.tasks.createProject(`Plain project ${stamp}`);
    const section = await h.owner.tasks.createSection(created.id, { name: 'Michael' });
    const todo = need((await h.owner.tasks.listStatuses(created.id)).find(x => x.group === 'todo'));
    const title = `Standard QA ${stamp}`;
    await h.owner.tasks.createTask({ projectId: created.id, sectionId: section.id, title, statusId: todo.id, dueDate: '2026-11-13' });

    // Not a template yet: refused, nothing created.
    const refused = await call(`${ws()}/projects`, { token: owner.token, method: 'POST', body: { template: created.id, name: `Week copy ${stamp}` } });
    expect(refused.status, refused.text()).toBe(400);
    expect(env(refused).error?.details).toMatchObject({ field: 'template' });

    await h.owner.tasks.updateProject(created.id, { expectedRevision: dated.revision, isTemplate: true });
    const projects = env<{ id: string; template?: boolean }[]>(await call(`${ws()}/projects`, { token: owner.token })).data;
    expect(need(projects.find(p => p.id === created.id)).template).toBe(true);
    expect(need(projects.find(p => p.id === plain.id)).template).toBeUndefined();

    // A template without dates cannot be moved to a start date.
    const undated = await h.owner.tasks.createProject(`Undated template ${stamp}`);
    await h.owner.tasks.updateProject(undated.id, { expectedRevision: undated.revision, isTemplate: true });
    const noRange = await call(`${ws()}/projects`, { token: owner.token, method: 'POST', body: { template: undated.id, name: `Undated copy ${stamp}`, startDate: '2026-11-16' } });
    expect(noRange.status, noRange.text()).toBe(400);
    expect(env(noRange).error?.details).toMatchObject({ field: 'startDate' });

    const key = `from-template-${stamp}`;
    const made = await call(`${ws()}/projects`, { token: owner.token, method: 'POST', headers: { 'idempotency-key': key }, body: { template: `Week template ${stamp}`, name: `46 week ${stamp}`, startDate: '2026-11-16' } });
    expect(made.status, made.text()).toBe(201);
    const copy = env<{ project: { id: string; name: string; dateRange: { from: string; to: string } | null }; template: { id: string }; copied: { sections: number; tasks: number }; warnings: unknown[] }>(made).data;
    expect(copy).toMatchObject({ project: { name: `46 week ${stamp}`, dateRange: { from: '2026-11-16', to: '2026-11-22' } }, template: { id: created.id }, copied: { sections: 1, tasks: 1 }, warnings: [] });
    const again = await call(`${ws()}/projects`, { token: owner.token, method: 'POST', headers: { 'idempotency-key': key }, body: { template: `Week template ${stamp}`, name: `46 week ${stamp}`, startDate: '2026-11-16' } });
    expect(env<{ project: { id: string } }>(again).data.project.id).toBe(copy.project.id);

    // Workspace-wide: only the copy is work. With the template as the project filter its task is listed.
    const everywhere = env<TaskV[]>(await call(`${ws()}/tasks?q=${encodeURIComponent(title)}`, { token: owner.token })).data;
    expect(everywhere.map(t => t.project.id)).toEqual([copy.project.id]);
    expect(need(everywhere[0])).toMatchObject({ dueDate: '2026-11-20', section: { name: 'Michael' } });
    const inTemplate = env<TaskV[]>(await call(`${ws()}/tasks?project=${created.id}&q=${encodeURIComponent(title)}`, { token: owner.token })).data;
    expect(inTemplate.map(t => t.project.id)).toEqual([created.id]);

    // The same through MCP.
    const tools = json<Rpc>(await mcp(owner.token, rpc('tools/list', {}, 40))).result.tools.map(t => t.name);
    expect(tools).toContain('create_project_from_template');
    const viaMcp = json<Rpc>(await mcp(owner.token, rpc('tools/call', { name: 'create_project_from_template', arguments: { workspace: TEAM, template: created.id, name: `47 week ${stamp}`, startDate: '2026-11-23' } }, 41)));
    expect(viaMcp.result.isError ?? false).toBe(false);
    expect(viaMcp.result.structuredContent.result).toMatchObject({ project: { name: `47 week ${stamp}`, dateRange: { from: '2026-11-23', to: '2026-11-29' } }, copied: { tasks: 1 } });
  });

  it('lists tasks shown in a project from another home, and moves a task already in a project to the given section', async () => {
    interface Shown extends TaskV { projects?: { id: string; name: string; home: boolean; section: { name: string } | null }[] }
    interface Placement { section: { name: string } | null; home: boolean; outcome: string; homeReason: string }
    const backlog = await h.owner.tasks.createProject(`Shown backlog ${Date.now()}`);
    const doing = await h.owner.tasks.createSection(backlog.id, { name: 'Doing' });
    const week = await h.owner.tasks.createProject(`Shown week ${Date.now()}`);
    await h.owner.tasks.createSection(week.id, { name: 'Michael' });
    await h.owner.tasks.createSection(week.id, { name: 'Anna' });
    const created = env<TaskV>(await call(`${ws()}/tasks`, { token: owner.token, method: 'POST', body: { project: backlog.id, title: 'Shown in the week' } })).data;
    const placed = (body: unknown) => call(`${ws()}/tasks/${created.id}/projects`, { token: owner.token, method: 'POST', body });
    const listed = async (query: string) => {
      const res = await call(`${ws()}/tasks?${query}`, { token: owner.token });
      expect(res.status, res.text()).toBe(200);
      return env<Shown[]>(res).data.find(task => task.id === created.id);
    };

    expect(env<Placement>(await placed({ project: week.name, section: 'Michael', home: false })).data).toMatchObject({ outcome: 'added', home: false, section: { name: 'Michael' } });
    // The week lists the task although its home is the backlog, with its section in each project.
    const inWeek = need(await listed(`project=${encodeURIComponent(week.name)}`));
    expect(inWeek.project.id).toBe(backlog.id);
    expect(inWeek.projects).toEqual([
      { id: backlog.id, name: backlog.name, home: true, section: null },
      { id: week.id, name: week.name, home: false, section: expect.objectContaining({ name: 'Michael' }) },
    ]);
    expect(await listed(`project=${week.id}&section=Michael`)).toBeDefined();
    expect(await listed(`project=${week.id}&section=Anna`)).toBeUndefined();
    expect(await listed(`project=${backlog.id}`)).toBeDefined();

    // Given another section, the call moves the shown task there instead of answering unchanged.
    const moved = await placed({ project: week.id, section: 'Anna', home: false });
    expect(moved.status, moved.text()).toBe(200);
    expect(env<Placement>(moved).data).toMatchObject({ outcome: 'section_changed', home: false, section: { name: 'Anna' } });
    expect(await listed(`project=${week.id}&section=Anna`)).toBeDefined();
    expect(await listed(`project=${week.id}&section=Michael`)).toBeUndefined();
    expect(env<Placement>(await placed({ project: week.id, section: 'Anna', home: false })).data).toMatchObject({ outcome: 'unchanged' });

    // At home the given section moves the task itself.
    const home = await placed({ project: backlog.name, section: 'Doing' });
    expect(env<Placement>(home).data).toMatchObject({ outcome: 'section_changed', home: true, homeReason: 'already_home', section: { name: 'Doing' } });
    const read = env<Shown>(await call(`${ws()}/tasks/${created.id}`, { token: owner.token })).data;
    expect(read.section?.name).toBe('Doing');
    expect(read.projects?.[0]).toMatchObject({ id: backlog.id, home: true, section: { name: 'Doing' } });
    expect(await listed(`project=${backlog.id}&section=${doing.id}`)).toBeDefined();

    // Over MCP the week's list includes it too; once removed from the week it is gone from that list.
    const viaMcp = json<Rpc>(await mcp(owner.token, rpc('tools/call', { name: 'list_tasks', arguments: { project: [week.name] } }, 40))).result;
    expect(viaMcp.isError, JSON.stringify(viaMcp)).toBeFalsy();
    expect(viaMcp.structuredContent.result.tasks.map(task => task.id)).toContain(created.id);
    const [row] = await h.db.sql<{ id: string; revision: number }[]>`select id, revision from task_project_placements where task_id = ${created.id} and project_id = ${week.id}`;
    const detached = await h.owner.tasks.post(`/task-project-placements/${need(row).id}/detach`, { expectedRevision: need(row).revision });
    expect(detached.status, detached.text()).toBe(200);
    expect(await listed(`project=${week.id}`)).toBeUndefined();
  });

  it('finds time by role: list_fields marks the time fields and time_summary uses them by default', async () => {
    const res = await h.owner.tasks.post('/projects', { name: `Timed week ${Date.now()}`, timeFields: true });
    expect(res.status, res.text()).toBe(201);
    const project = JSON.parse(res.text()).data as { id: string; revision: number };
    await h.owner.tasks.updateProject(project.id, { expectedRevision: project.revision, dateRange: { from: '2026-11-09', to: '2026-11-15' } });
    const fields = env<{ name: string; timeRole?: string }[]>(await call(`${ws()}/projects/${project.id}/fields`, { token: owner.token })).data;
    expect(fields.map(field => [field.name, field.timeRole])).toEqual([['Hours Est', 'estimate'], ['Hours Fact', 'fact']]);
    const task = env<TaskV>(await call(`${ws()}/tasks`, { token: owner.token, method: 'POST', body: { project: project.id, title: 'Timed task', assignee: 'me' } })).data;
    const written = await call(`${ws()}/task-fields`, { token: owner.token, method: 'POST', body: { items: [{ taskId: task.id, values: [{ field: 'Hours Est', value: '2h' }, { field: 'Hours Fact', value: '90m' }] }] } });
    expect(written.status, written.text()).toBe(200);
    const summary = env<{ planField: { name: string }; factField: { name: string }; people: { planMinutes: number; factMinutes: number }[] }>(await call(`${ws()}/projects/${project.id}/time-summary`, { token: owner.token })).data;
    expect(summary).toMatchObject({ planField: { name: 'Hours Est' }, factField: { name: 'Hours Fact' } });
    expect(summary.people.some(person => person.planMinutes === 120 && person.factMinutes === 90)).toBe(true);
  });
});
