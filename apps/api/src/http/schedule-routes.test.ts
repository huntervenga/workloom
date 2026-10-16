import * as contracts from '@workloom/contracts';
import { DEMO_USERS, FIXTURE_USER_IDS, FIXTURE_WORKSPACE_IDS, type ReadinessProbe } from '@workloom/db';
import { DomainError, NOT_FOUND_MESSAGE, type AccessRepository, type CommandContext, type TaskScheduleApplication } from '@workloom/domain';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createApp } from '../app.js';
import { loadConfig } from '../config.js';

// Recording ports verify transport boundaries. Real PostgreSQL/domain acceptance owns ACL,
// source manifests, cutoff commits, baseline provenance and all-or-nothing date writes.
const HOST = '127.0.0.1:4310';
const ORIGIN = `http://${HOST}`;
const W = FIXTURE_WORKSPACE_IDS.team;
const PROJECT = '5eed0000-0000-4000-8000-000000000401';
const TASK = '5eed0000-0000-4000-8000-000000000405';
const SECOND = '5eed0000-0000-4000-8000-000000000407';
const BASELINE = '5eed0000-0000-4000-8000-000000000501';
const BASE = `/api/v1/workspaces/${W}/projects/${PROJECT}`;
const KEY = 'synthetic-schedule-command';
const HASH = 'a'.repeat(64);
const row = { taskId: TASK, expectedRevision: 3, startDate: '2026-10-16', dueDate: '2026-10-17' };
const batch = { rows: [row] };
const applyInput = { ...batch, previewHash: HASH };
const contextResult = contracts.taskScheduleContextSchema.parse({ projectId: PROJECT, asOfChangeSeq: '9007199254740993', baseline: null, rows: [{ taskId: TASK, taskRevision: 3, current: { startDate: null, dueDate: null }, meetingId: null, editableDates: true, blocking: { taskId: TASK, policy: { projectId: PROJECT, mode: 'warn', revision: 0 }, isBlocked: false, unresolvedCount: 0, canStart: true, canComplete: true, violatesCurrentStatus: false }, baselineDates: { state: 'not_selected' } }], comparisons: [] });
const previewResult = contracts.taskSchedulePreviewSchema.parse({ projectId: PROJECT, previewHash: HASH, asOfChangeSeq: '9007199254740993', rows: [{ taskId: TASK, expectedRevision: 3, before: { startDate: null, dueDate: null }, after: { startDate: row.startDate, dueDate: row.dueDate }, changed: true }], comparisons: [], protectedTargets: [], recoveryPeriodIds: [] });
const applyResult = contracts.taskScheduleApplySchema.parse({ projectId: PROJECT, tasks: [], asOfChangeSeq: '9007199254740994' });
type Method = keyof TaskScheduleApplication;
const calls: { method: Method; ctx: CommandContext; args: unknown[] }[] = [];
const overrides = new Map<Method, () => unknown>();
function record<R>(method: Method, result: R) {
  return async (ctx: CommandContext, ...args: unknown[]): Promise<R> => {
    calls.push({ method, ctx, args });
    return overrides.has(method) ? overrides.get(method)?.() as R : result;
  };
}
const application: TaskScheduleApplication = {
  getScheduleContext: record('getScheduleContext', contextResult),
  previewSchedule: record('previewSchedule', previewResult),
  applySchedule: record('applySchedule', applyResult),
};
const repository: AccessRepository = {
  findUser: async id => DEMO_USERS.find(user => user.id === id) ?? null,
  findUsers: async ids => DEMO_USERS.filter(user => ids.includes(user.id)),
  listAccessibleWorkspaces: async () => [], findWorkspaceAccess: async () => null, listActiveMemberships: async () => [],
};
const readiness: ReadinessProbe = { check: async () => ({ ready: true, checks: { database: 'ok', schema: 'ok' } }) };
const config = loadConfig({ APP_ENV: 'local', AUTH_MODE: 'dev', DATABASE_URL: 'postgres://u:p@127.0.0.1:5432/unused' });
const headers = () => ({ host: HOST, origin: ORIGIN, 'idempotency-key': KEY });
interface Route { method: 'GET' | 'POST'; path: string; input?: typeof batch | typeof applyInput; service: Method; args: unknown[]; result: unknown; keyed: boolean }
const routes: Route[] = [
  { method: 'GET', path: `/schedule-context?taskIds=${TASK}`, service: 'getScheduleContext', args: [PROJECT, { taskIds: [TASK] }], result: contextResult, keyed: false },
  { method: 'POST', path: '/schedule-preview', input: batch, service: 'previewSchedule', args: [PROJECT, batch], result: previewResult, keyed: false },
  { method: 'POST', path: '/schedule-apply', input: applyInput, service: 'applySchedule', args: [PROJECT, applyInput], result: applyResult, keyed: true },
];
const uuid = (n: number) => `5eed0000-0000-4000-8000-${String(n).padStart(12, '0')}`;
let app: FastifyInstance;
beforeAll(async () => { app = await createApp(config, { accessRepository: repository, readiness, taskScheduleApplication: application, logger: false, webDistDir: null }); });
afterAll(async () => { await app.close(); });
beforeEach(() => { calls.length = 0; overrides.clear(); });

describe('P4b schedule HTTP adapter', () => {
  it('covers exactly the three application methods', () => {
    expect(routes).toHaveLength(3);
    expect(new Set(routes.map(route => route.service))).toEqual(new Set(Object.keys(application)));
  });
  it.each(routes)('$method $path forwards trusted context and validated envelopes', async route => {
    const response = await app.inject({ method: route.method, url: BASE + route.path, headers: { ...headers(), 'x-actor-id': FIXTURE_USER_IDS.outsider, 'x-request-id': 'spoofed' }, ...(route.input ? { payload: route.input } : {}) });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body).toEqual({ data: route.result, meta: { requestId: response.headers['x-request-id'] } });
    expect(body.meta.requestId).not.toBe('spoofed');
    expect(calls).toEqual([{ method: route.service, args: route.args, ctx: { actor: { userId: FIXTURE_USER_IDS.owner, displayName: DEMO_USERS.find(user => user.id === FIXTURE_USER_IDS.owner)?.displayName, kind: 'fixture' }, workspaceId: W, source: 'web', requestId: body.meta.requestId, ...(route.keyed ? { idempotencyKey: KEY } : {}) } }]);
  });
  it('parses context CSV exactly once into sorted canonical IDs with optional baseline', async () => {
    const response = await app.inject({ url: `${BASE.toUpperCase().replace('/API/V1/WORKSPACES/', '/api/v1/workspaces/').replace('/PROJECTS/', '/projects/')}/schedule-context?taskIds=${SECOND.toUpperCase()},${TASK.toUpperCase()}&baselineId=${BASELINE.toUpperCase()}`, headers: headers() });
    expect(response.statusCode).toBe(200);
    expect(calls[0]?.args).toEqual([PROJECT, { taskIds: [TASK, SECOND], baselineId: BASELINE }]);
  });
  it.each(['', 'taskIds=', `taskIds=${TASK},`, `taskIds=${TASK},${TASK}`, `taskIds=${TASK}&taskIds=${SECOND}`, `taskIds[]=${TASK}`, `taskIds=${TASK}&baselineId=bad`, `taskIds=${TASK}&cursor=bad`, `taskIds=${TASK}&actorId=${FIXTURE_USER_IDS.outsider}`, `taskIds=${Array.from({ length: 101 }, (_, i) => uuid(1000 + i)).join(',')}`])('rejects malformed or unbounded context query %s', async query => {
    expect((await app.inject({ url: `${BASE}/schedule-context?${query}`, headers: headers() })).statusCode).toBe(400);
    expect(calls).toHaveLength(0);
  });
  it('accepts a keyless preview and never forwards a supplied key as write authority', async () => {
    for (const supplied of [undefined, KEY]) {
      const response = await app.inject({ method: 'POST', url: `${BASE}/schedule-preview`, headers: { host: HOST, origin: ORIGIN, ...(supplied ? { 'idempotency-key': supplied } : {}) }, payload: batch });
      expect(response.statusCode).toBe(200);
    }
    expect(calls.every(call => call.ctx.idempotencyKey === undefined)).toBe(true);
  });
  it.each([undefined, '', 'has space', 'x'.repeat(129)])('requires a valid apply key %s', async key => {
    expect((await app.inject({ method: 'POST', url: `${BASE}/schedule-apply`, headers: { host: HOST, origin: ORIGIN, ...(key === undefined ? {} : { 'idempotency-key': key }) }, payload: applyInput })).statusCode).toBe(400);
    expect(calls).toHaveLength(0);
  });
  it.each(routes.filter(route => route.method === 'POST'))('$path preserves Origin/Host guards and rejects query scope injection', async route => {
    if (route.input === undefined) throw new Error('Expected a POST payload.');
    for (const origin of [undefined, 'https://untrusted.invalid']) expect((await app.inject({ method: 'POST', url: BASE + route.path, headers: { host: HOST, 'idempotency-key': KEY, ...(origin ? { origin } : {}) }, payload: route.input })).statusCode).toBe(403);
    expect((await app.inject({ method: 'POST', url: BASE + route.path, headers: { ...headers(), host: 'foreign.invalid' }, payload: route.input })).statusCode).toBe(421);
    expect((await app.inject({ method: 'POST', url: BASE + route.path + '?actorId=spoofed', headers: headers(), payload: route.input })).statusCode).toBe(400);
    expect(calls).toHaveLength(0);
  });
  it.each([
    { rows: [] }, { rows: Array.from({ length: 101 }, (_, i) => ({ ...row, taskId: uuid(1000 + i) })) },
    { rows: [row, row] }, { rows: [{ ...row, startDate: '0000-01-01' }] }, { rows: [{ ...row, dueDate: '10000-01-01' }] },
    { rows: [{ ...row, startDate: '2025-02-29' }] }, { rows: [{ ...row, startDate: '2026-10-18' }] },
    { rows: [{ ...row, expectedRevision: 0 }] }, { rows: [{ ...row, startDate: undefined }] },
    { rows: [{ ...row, actorId: FIXTURE_USER_IDS.outsider }] }, { ...batch, baselineId: BASELINE },
  ])('rejects invalid strict preview/apply rows %# before the port', async input => {
    for (const name of ['preview', 'apply']) {
      expect((await app.inject({ method: 'POST', url: `${BASE}/schedule-${name}`, headers: headers(), payload: { ...input, ...(name === 'apply' ? { previewHash: HASH } : {}) } })).statusCode).toBe(400);
    }
    expect(calls).toHaveLength(0);
  });
  it('requires the exact full lowercase preview hash on apply and rejects it on preview', async () => {
    for (const hash of [undefined, 'a'.repeat(63), 'A'.repeat(64)]) expect((await app.inject({ method: 'POST', url: `${BASE}/schedule-apply`, headers: headers(), payload: { ...batch, ...(hash ? { previewHash: hash } : {}) } })).statusCode).toBe(400);
    expect((await app.inject({ method: 'POST', url: `${BASE}/schedule-preview`, headers: headers(), payload: applyInput })).statusCode).toBe(400);
    expect(calls).toHaveLength(0);
  });
  it('forwards null/zero-century/leap-boundary dates without timezone or year remapping', async () => {
    const rows = [{ ...row, startDate: '0001-01-01', dueDate: '0099-12-31' }, { ...row, taskId: SECOND, startDate: '2000-02-29', dueDate: null }];
    expect((await app.inject({ method: 'POST', url: `${BASE}/schedule-preview`, headers: headers(), payload: { rows: rows.toReversed() } })).statusCode).toBe(200);
    expect(calls[0]?.args).toEqual([PROJECT, { rows }]);
  });
  it.each(['preview', 'apply'])('accepts100 escaped full date rows above16KiB only within the scoped128KiB %s cap', async name => {
    const input = { rows: Array.from({ length: 100 }, (_, i) => ({ ...row, taskId: uuid(1000 + i) })), ...(name === 'apply' ? { previewHash: HASH } : {}) };
    const escaped = JSON.stringify(input).replace(/"(?:[^"\\]|\\.)*"/g, token => '"' + [...JSON.parse(token) as string].map(char => '\\u' + char.charCodeAt(0).toString(16).padStart(4, '0')).join('') + '"');
    expect(Buffer.byteLength(escaped)).toBeGreaterThan(16 * 1024);
    expect(Buffer.byteLength(escaped)).toBeLessThan(128 * 1024);
    expect((await app.inject({ method: 'POST', url: `${BASE}/schedule-${name}`, headers: { ...headers(), 'content-type': 'application/json' }, payload: escaped })).statusCode).toBe(200);
    expect(calls[0]?.args).toEqual([PROJECT, input]);
    expect(app.initialConfig.bodyLimit).toBe(16 * 1024);
    calls.length = 0;
    expect((await app.inject({ method: 'POST', url: `${BASE}/schedule-${name}`, headers: headers(), payload: { oversized: 'x'.repeat(129 * 1024) } })).statusCode).toBe(413);
    expect(calls).toHaveLength(0);
  });
  it('retains the default16KiB limit for unrelated writes', async () => {
    expect((await app.inject({ method: 'POST', url: '/api/v1/dev/session', headers: { ...headers(), 'x-workloom-dev-tool': '1' }, payload: { oversized: 'x'.repeat(17 * 1024) } })).statusCode).toBe(413);
    expect(calls).toHaveLength(0);
  });
  it.each(routes)('$path forwards current foreign/denied errors without returned source data', async route => {
    overrides.set(route.service, () => { throw new DomainError('NOT_FOUND', NOT_FOUND_MESSAGE); });
    const response = await app.inject({ method: route.method, url: BASE + route.path, headers: headers(), ...(route.input ? { payload: route.input } : {}) });
    expect(response.statusCode).toBe(404);
    expect(response.json()).not.toHaveProperty('data');
    expect(response.json().error.message).toBe(NOT_FOUND_MESSAGE);
  });
  it.each([['PREVIEW_STALE', 409], ['REVISION_CONFLICT', 409], ['FIELD_LOCKED', 409], ['MATERIALIZATION_REQUIRED', 409], ['IDEMPOTENCY_KEY_REUSED', 409], ['CAPABILITY_REQUIRED', 403], ['DOMAIN_VALIDATION_FAILED', 422]] as const)('maps controlled %s and never retries proposed writes', async (code, status) => {
    overrides.set('applySchedule', () => { throw new DomainError(code, 'Safe schedule rejection', { details: { committed: true, baselineIds: [BASELINE] } }); });
    const response = await app.inject({ method: 'POST', url: `${BASE}/schedule-apply`, headers: headers(), payload: applyInput });
    expect(response.statusCode).toBe(status);
    expect(response.json().error.code).toBe(code);
    expect(response.json().error.details).toEqual({ committed: true, baselineIds: [BASELINE] });
    expect(response.json()).not.toHaveProperty('data');
    expect(calls).toHaveLength(1);
  });
  it('rejects malformed application responses safely instead of exposing source data', async () => {
    overrides.set('getScheduleContext', () => ({ privateSource: 'synthetic-hidden-canary' }));
    const response = await app.inject({ url: `${BASE}/schedule-context?taskIds=${TASK}`, headers: headers() });
    expect(response.statusCode).toBe(500);
    expect(response.body).not.toContain('canary');
    expect(response.json()).not.toHaveProperty('data');
  });
  it('forwards an explicit repeat with the exact same key and normalized batch', async () => {
    for (let n = 0; n < 2; n++) expect((await app.inject({ method: 'POST', url: `${BASE}/schedule-apply`, headers: headers(), payload: applyInput })).statusCode).toBe(200);
    expect(calls.map(call => ({ key: call.ctx.idempotencyKey, args: call.args }))).toEqual([{ key: KEY, args: [PROJECT, applyInput] }, { key: KEY, args: [PROJECT, applyInput] }]);
  });
});
