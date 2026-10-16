import * as contracts from '@workloom/contracts';
import { DEMO_USERS, FIXTURE_USER_IDS, FIXTURE_WORKSPACE_IDS, type ReadinessProbe } from '@workloom/db';
import { DomainError, NOT_FOUND_MESSAGE, type AccessRepository, type CommandContext, type DependencyApplication } from '@workloom/domain';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createApp } from '../app.js';
import { loadConfig } from '../config.js';

// Recording application ports prove HTTP parsing/context/envelopes only. Real domain/PostgreSQL
// acceptance owns endpoint ACL, global cycles, policy enforcement, idempotency and layout isolation.
const HOST = '127.0.0.1:4310';
const ORIGIN = `http://${HOST}`;
const KEY = 'synthetic-dependency-command';
const CURSOR = 'v1.opaque+dependency/cursor==';
const TS = '2026-10-16T09:00:00.000Z';
const W = FIXTURE_WORKSPACE_IDS.team;
const BASE = `/api/v1/workspaces/${W}`;
const ids = {
  project: '5eed0000-0000-4000-8000-000000000401', status: '5eed0000-0000-4000-8000-000000000403',
  task: '5eed0000-0000-4000-8000-000000000405', otherTask: '5eed0000-0000-4000-8000-000000000407',
  package: '5eed0000-0000-4000-8000-000000000406', dependency: '5eed0000-0000-4000-8000-000000000501',
  membership: '5eed0000-0000-4000-8000-000000000301',
};
const task = contracts.taskSchema.parse({
  id: ids.task, workspaceId: W, projectId: ids.project, sectionId: null, parentTaskId: null, meetingId: null,
  workPackageId: ids.package, workPackageRevision: 2, title: 'Synthetic predecessor', description: '', statusId: ids.status,
  responsibleMembershipId: null, participants: [], participantsRevision: 1, dueDate: null, priority: 'none', tags: [],
  estimateMinutes: null, revision: 3, position: 0, visibility: 'workspace', archivedAt: null, createdAt: TS, updatedAt: TS,
});
const dependency = contracts.taskDependencySchema.parse({ id: ids.dependency, workspaceId: W, predecessorTaskId: ids.task, successorTaskId: ids.otherTask, type: 'finish_to_start', state: 'active', revision: 2, createdAt: TS, updatedAt: TS });
const policy = contracts.projectDependencyPolicySchema.parse({ projectId: ids.project, mode: 'warn', revision: 0, updatedAt: null });
const context = contracts.dependencyTaskContextSchema.parse({ project: { id: ids.project, name: 'Synthetic project', archivedAt: null }, status: { id: ids.status, name: 'To do', group: 'todo' } });
const summary = contracts.taskBlockingSummarySchema.parse({ taskId: ids.otherTask, policy: { projectId: ids.project, mode: 'warn', revision: 0 }, isBlocked: true, unresolvedCount: 1, canStart: true, canComplete: true, violatesCurrentStatus: false });
const blocking = contracts.taskBlockingSchema.parse({ summary, blockers: [{ dependency, predecessor: task, predecessorContext: context }], asOfChangeSeq: '9007199254740993' });
const graph = contracts.dependencyGraphSchema.parse({ projectId: ids.project, rootTaskIds: [ids.task], neighborDepth: 1, asOfChangeSeq: '9007199254740993', nodes: [{ task, context, blocking: { ...summary, taskId: ids.task }, hasOutsideDependencies: true, outsideUnresolvedPredecessorCount: 1 }], edges: [] });
const layout = contracts.graphLayoutSchema.parse({ workspaceId: W, projectId: ids.project, membershipId: ids.membership, viewKey: 'default', revision: 0, positions: [], updatedAt: null });
type Method = keyof DependencyApplication;
interface Call { method: Method; ctx: CommandContext; args: unknown[] }
const calls: Call[] = [];
const overrides = new Map<Method, () => unknown>();
function record<R>(method: Method, result: R) {
  return async (ctx: CommandContext, ...args: unknown[]): Promise<R> => {
    calls.push({ method, ctx, args });
    return overrides.has(method) ? overrides.get(method)?.() as R : result;
  };
}
const application: DependencyApplication = {
  listDependencies: record('listDependencies', { items: [dependency], nextCursor: CURSOR }),
  createDependency: record('createDependency', dependency), updateDependency: record('updateDependency', dependency),
  getTaskBlocking: record('getTaskBlocking', { data: blocking, nextCursor: CURSOR }),
  getProjectPolicy: record('getProjectPolicy', policy), updateProjectPolicy: record('updateProjectPolicy', policy),
  getGraph: record('getGraph', graph), getGraphLayout: record('getGraphLayout', layout), setGraphLayout: record('setGraphLayout', layout),
};
const repository: AccessRepository = {
  findUser: async id => DEMO_USERS.find(user => user.id === id) ?? null,
  findUsers: async userIds => DEMO_USERS.filter(user => userIds.includes(user.id)),
  listAccessibleWorkspaces: async () => [], findWorkspaceAccess: async () => null, listActiveMemberships: async () => [],
};
const readiness: ReadinessProbe = { check: async () => ({ ready: true, checks: { database: 'ok', schema: 'ok' } }) };
const config = loadConfig({ APP_ENV: 'local', AUTH_MODE: 'dev', DATABASE_URL: 'postgres://u:p@127.0.0.1:5432/unused' });
const P = `/projects/${ids.project}`;
const createInput = { predecessorTaskId: ids.task, successorTaskId: ids.otherTask, type: 'finish_to_start', expectedAbsent: true };
const updateInput = { expectedRevision: 2, state: 'removed' };
const policyInput = { expectedRevision: 0, mode: 'enforce' };
const layoutInput = { expectedRevision: 0, positions: [{ taskId: ids.task, x: 12.5, y: -10 }] };
interface Route { method: 'GET' | 'POST' | 'PATCH' | 'PUT'; path: string; query?: string; input?: Record<string, unknown>; service: Method; args: unknown[]; result: unknown; paged?: boolean; status?: number }
const routes: Route[] = [
  { method: 'GET', path: '/dependencies', query: `taskId=${ids.task}`, service: 'listDependencies', args: [{ taskId: ids.task, direction: 'both', state: 'active', limit: 50 }], result: [dependency], paged: true },
  { method: 'POST', path: '/dependencies', input: createInput, service: 'createDependency', args: [createInput], result: dependency, status: 201 },
  { method: 'PATCH', path: `/dependencies/${ids.dependency}`, input: updateInput, service: 'updateDependency', args: [ids.dependency, updateInput], result: dependency },
  { method: 'GET', path: `/tasks/${ids.otherTask}/blocking`, service: 'getTaskBlocking', args: [ids.otherTask, { limit: 50 }], result: blocking, paged: true },
  { method: 'GET', path: `${P}/dependency-policy`, service: 'getProjectPolicy', args: [ids.project], result: policy },
  { method: 'PATCH', path: `${P}/dependency-policy`, input: policyInput, service: 'updateProjectPolicy', args: [ids.project, policyInput], result: policy },
  { method: 'GET', path: `${P}/graph`, query: `rootTaskIds=${ids.task}`, service: 'getGraph', args: [ids.project, { rootTaskIds: [ids.task], neighborDepth: 1 }], result: graph },
  { method: 'GET', path: `${P}/graph-layout`, service: 'getGraphLayout', args: [ids.project], result: layout },
  { method: 'PUT', path: `${P}/graph-layout`, input: layoutInput, service: 'setGraphLayout', args: [ids.project, layoutInput], result: layout },
];
const writes = routes.filter(route => route.method !== 'GET');
const headers = () => ({ host: HOST, origin: ORIGIN, 'idempotency-key': KEY });
const url = (route: Route) => `${BASE}${route.path}${route.query ? `?${route.query}` : ''}`;
const uuid = (n: number) => `5eed0000-0000-4000-8000-${String(n).padStart(12, '0')}`;
let app: FastifyInstance;
beforeAll(async () => { app = await createApp(config, { accessRepository: repository, readiness, dependencyApplication: application, logger: false, webDistDir: null }); });
afterAll(async () => { await app.close(); });
beforeEach(() => { calls.length = 0; overrides.clear(); });

describe('P4a dependency HTTP adapter', () => {
  it('covers the exact nine application methods', () => {
    expect(routes).toHaveLength(9);
    expect(new Set(routes.map(route => route.service))).toEqual(new Set(Object.keys(application)));
  });
  it.each(routes)('$method $path forwards normalized input, trusted context and exact envelope', async route => {
    const response = await app.inject({ method: route.method, url: url(route), headers: { ...headers(), 'x-actor-id': FIXTURE_USER_IDS.outsider, 'x-request-id': 'spoofed' }, ...(route.input ? { payload: route.input } : {}) });
    expect(response.statusCode).toBe(route.status ?? 200);
    const body = response.json();
    expect(body.data).toEqual(route.result);
    expect(body.meta.requestId).toBe(response.headers['x-request-id']);
    expect(body.meta.requestId).not.toBe('spoofed');
    if (route.paged) expect(body.meta.nextCursor).toBe(CURSOR);
    else expect(body.meta).not.toHaveProperty('nextCursor');
    expect(calls).toEqual([{ method: route.service, args: route.args, ctx: {
      actor: { userId: FIXTURE_USER_IDS.owner, displayName: DEMO_USERS.find(user => user.id === FIXTURE_USER_IDS.owner)?.displayName, kind: 'fixture' },
      workspaceId: W, source: 'web', requestId: body.meta.requestId, ...(route.method === 'GET' ? {} : { idempotencyKey: KEY }),
    } }]);
  });
  it.each(routes)('$method $path canonicalizes path, body and query UUIDs', async route => {
    const upper = (text: string) => text.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, id => id.toUpperCase());
    const response = await app.inject({ method: route.method, url: upper(url(route)), headers: headers(), ...(route.input ? { payload: JSON.parse(upper(JSON.stringify(route.input))) } : {}) });
    expect(response.statusCode).toBe(route.status ?? 200);
    expect(calls[0]?.args).toEqual(route.args);
  });
  it.each(writes)('$method $path requires a valid key before calling the application', async route => {
    for (const key of [undefined, '', 'has space', 'x'.repeat(129)]) {
      const response = await app.inject({ method: route.method, url: url(route), headers: { host: HOST, origin: ORIGIN, ...(key === undefined ? {} : { 'idempotency-key': key }) }, ...(route.input ? { payload: route.input } : {}) });
      expect(response.statusCode).toBe(400);
    }
    expect(calls).toHaveLength(0);
  });
  it.each(writes)('$method $path retains Origin guards and rejects query/actor injection', async route => {
    for (const origin of [undefined, 'https://untrusted.invalid']) {
      expect((await app.inject({ method: route.method, url: url(route), headers: { host: HOST, 'idempotency-key': KEY, ...(origin ? { origin } : {}) }, ...(route.input ? { payload: route.input } : {}) })).statusCode).toBe(403);
    }
    expect((await app.inject({ method: route.method, url: `${url(route)}?actorId=${FIXTURE_USER_IDS.outsider}`, headers: headers(), ...(route.input ? { payload: route.input } : {}) })).statusCode).toBe(400);
    expect((await app.inject({ method: route.method, url: url(route), headers: headers(), payload: { ...route.input, actorId: FIXTURE_USER_IDS.outsider } })).statusCode).toBe(400);
    expect(calls).toHaveLength(0);
  });
  it('requires exactly one dependency list scope and accepts the project branch without task direction', async () => {
    const good = `projectId=${ids.project}&state=all&limit=7&cursor=${encodeURIComponent(CURSOR)}`;
    expect((await app.inject({ url: `${BASE}/dependencies?${good}`, headers: headers() })).statusCode).toBe(200);
    expect(calls[0]?.args).toEqual([{ projectId: ids.project, state: 'all', limit: 7, cursor: CURSOR }]);
    calls.length = 0;
    for (const query of ['', `taskId=${ids.task}&projectId=${ids.project}`, `projectId=${ids.project}&direction=incoming`, `taskId=${ids.task}&taskId=${ids.otherTask}`, `taskId=${ids.task}&limit=101`, `taskId=${ids.task}&state=hidden`]) {
      expect((await app.inject({ url: `${BASE}/dependencies?${query}`, headers: headers() })).statusCode, query).toBe(400);
    }
    expect(calls).toHaveLength(0);
  });
  it('passes blocking cursor separately from its full authoritative summary data', async () => {
    const response = await app.inject({ url: `${BASE}/tasks/${ids.otherTask}/blocking?limit=1&cursor=${encodeURIComponent(CURSOR)}`, headers: headers() });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ data: blocking, meta: { nextCursor: CURSOR } });
    expect(calls[0]?.args).toEqual([ids.otherTask, { limit: 1, cursor: CURSOR }]);
  });
  it('parses graph CSV once into sorted canonical UUID arrays and numeric depth', async () => {
    expect((await app.inject({ url: `${BASE}${P}/graph?rootTaskIds=${ids.otherTask.toUpperCase()},${ids.task.toUpperCase()}&neighborDepth=2`, headers: headers() })).statusCode).toBe(200);
    expect(calls[0]?.args).toEqual([ids.project, { rootTaskIds: [ids.task, ids.otherTask], neighborDepth: 2 }]);
  });
  it.each([
    '', `rootTaskIds=`, `rootTaskIds=${ids.task},`, `rootTaskIds=${ids.task},${ids.task}`, `rootTaskIds=${ids.task}&rootTaskIds=${ids.otherTask}`,
    `rootTaskIds[]=${ids.task}`, `rootTaskIds=${ids.task}&neighborDepth=3`, `rootTaskIds=${ids.task}&neighborDepth=1.0`, `rootTaskIds=${ids.task}&neighborDepth=`,
    `rootTaskIds=${Array.from({ length: 101 }, (_, i) => uuid(1000 + i)).join(',')}`,
  ])('rejects malformed or unbounded graph query %s', async query => {
    expect((await app.inject({ url: `${BASE}${P}/graph?${query}`, headers: headers() })).statusCode).toBe(400);
    expect(calls).toHaveLength(0);
  });
  it('accepts500 fully escaped layout positions above16KiB only on PUT layout', async () => {
    const positions = Array.from({ length: 500 }, (_, i) => ({ taskId: uuid(1000 + i), x: 100000 - i / 2, y: -100000 + i / 2 }));
    const input = { expectedRevision: 0, positions };
    // Escape every JSON string, including ASCII UUIDs/property names, without changing numeric tokens.
    const escaped = JSON.stringify(input).replace(/"(?:[^"\\]|\\.)*"/g, token => '"' + [...JSON.parse(token) as string].map(char => '\\u' + char.charCodeAt(0).toString(16).padStart(4, '0')).join('') + '"');
    expect(Buffer.byteLength(escaped)).toBeGreaterThan(16 * 1024);
    expect(Buffer.byteLength(escaped)).toBeLessThan(256 * 1024);
    const response = await app.inject({ method: 'PUT', url: `${BASE}${P}/graph-layout`, headers: { ...headers(), 'content-type': 'application/json' }, payload: escaped });
    expect(response.statusCode).toBe(200);
    expect(calls[0]?.args).toEqual([ids.project, input]);
    expect(app.initialConfig.bodyLimit).toBe(16 * 1024);
  });
  it('enforces layout256KiB and all other route16KiB body caps', async () => {
    expect((await app.inject({ method: 'PUT', url: `${BASE}${P}/graph-layout`, headers: headers(), payload: { oversized: 'x'.repeat(257 * 1024) } })).statusCode).toBe(413);
    for (const route of writes.filter(route => route.method !== 'PUT')) {
      expect((await app.inject({ method: route.method, url: url(route), headers: headers(), payload: { oversized: 'x'.repeat(17 * 1024) } })).statusCode).toBe(413);
    }
    expect((await app.inject({ method: 'POST', url: '/api/v1/dev/session', headers: { ...headers(), 'x-workloom-dev-tool': '1' }, payload: { oversized: 'x'.repeat(17 * 1024) } })).statusCode).toBe(413);
    expect(calls).toHaveLength(0);
  });
  it('still rejects501 positions, duplicates, nonfinite/out-of-range coordinates and client scope at the larger cap', async () => {
    const bad = [
      { expectedRevision: 0, positions: Array.from({ length: 501 }, (_, i) => ({ taskId: uuid(1000 + i), x: 0, y: 0 })) },
      { expectedRevision: 0, positions: [{ taskId: ids.task, x: 0, y: 0 }, { taskId: ids.task, x: 1, y: 1 }] },
      { expectedRevision: 0, positions: [{ taskId: ids.task, x: 100001, y: 0 }] },
      { expectedRevision: 0, positions: [{ taskId: ids.task, x: null, y: 0 }] },
      { ...layoutInput, membershipId: ids.membership },
      { ...layoutInput, workspaceId: W },
    ];
    for (const input of bad) expect((await app.inject({ method: 'PUT', url: `${BASE}${P}/graph-layout`, headers: headers(), payload: input })).statusCode).toBe(400);
    expect(calls).toHaveLength(0);
  });
  it.each(routes)('$method $path forwards denied/foreign access without data or hidden graph context', async route => {
    overrides.set(route.service, () => { throw new DomainError('NOT_FOUND', NOT_FOUND_MESSAGE); });
    const response = await app.inject({ method: route.method, url: url(route), headers: headers(), ...(route.input ? { payload: route.input } : {}) });
    expect(response.statusCode).toBe(404);
    expect(response.json()).not.toHaveProperty('data');
    expect(response.json().error.message).toBe(NOT_FOUND_MESSAGE);
    expect(calls).toHaveLength(1);
  });
  it.each([
    ['DEPENDENCY_CYCLE', 409], ['REVISION_CONFLICT', 409], ['IDEMPOTENCY_KEY_REUSED', 409], ['FIELD_LOCKED', 409],
    ['MATERIALIZATION_REQUIRED', 409], ['CAPABILITY_REQUIRED', 403], ['DOMAIN_VALIDATION_FAILED', 422],
  ] as const)('forwards controlled %s without retrying the application', async (code, status) => {
    overrides.set('createDependency', () => { throw new DomainError(code, 'Safe dependency rejection'); });
    const response = await app.inject({ method: 'POST', url: `${BASE}/dependencies`, headers: headers(), payload: createInput });
    expect(response.statusCode).toBe(status);
    expect(response.json().error.code).toBe(code);
    expect(response.json()).not.toHaveProperty('data');
    expect(calls).toHaveLength(1);
  });
  it('preserves exact cursor-validation errors and rejects malformed application output safely', async () => {
    overrides.set('getTaskBlocking', () => { throw new DomainError('VALIDATION_FAILED', 'Restart this list.'); });
    expect((await app.inject({ url: `${BASE}/tasks/${ids.otherTask}/blocking?cursor=expired`, headers: headers() })).statusCode).toBe(400);
    overrides.set('getGraph', () => ({ privateTitle: 'synthetic-canary-hidden-data' }));
    const response = await app.inject({ url: `${BASE}${P}/graph?rootTaskIds=${ids.task}`, headers: headers() });
    expect(response.statusCode).toBe(500);
    expect(response.body).not.toContain('canary');
    expect(response.json()).not.toHaveProperty('data');
  });
  it('passes the original key/body unchanged on an explicit repeat; domain owns replay semantics', async () => {
    for (let attempt = 0; attempt < 2; attempt += 1) expect((await app.inject({ method: 'POST', url: `${BASE}/dependencies`, headers: headers(), payload: createInput })).statusCode).toBe(201);
    expect(calls.map(call => ({ args: call.args, key: call.ctx.idempotencyKey }))).toEqual([{ args: [createInput], key: KEY }, { args: [createInput], key: KEY }]);
  });
});
