import * as contracts from '@workloom/contracts';
import { DEMO_USERS, FIXTURE_USER_IDS, FIXTURE_WORKSPACE_IDS, type ReadinessProbe } from '@workloom/db';
import { DomainError, NOT_FOUND_MESSAGE, type AccessRepository, type CommandContext, type PlanningApplication } from '@workloom/domain';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createApp } from '../app.js';
import { loadConfig } from '../config.js';

// HTTP transport tests with a recording service port; no database is opened or simulated.
// The real PostgreSQL suite owns proof of cutoff commits, rollback, source uniqueness and replay.
const HOST = '127.0.0.1:4310';
const ORIGIN = `http://${HOST}`;
const KEY = 'planning-synthetic-command-key';
const CURSOR = 'opaque+planning/cursor==';
const TS = '2026-10-16T09:00:00.000Z';
const W = FIXTURE_WORKSPACE_IDS.team;
const BASE = `/api/v1/workspaces/${W}`;
const ids = {
  project: '5eed0000-0000-4000-8000-000000000401',
  task: '5eed0000-0000-4000-8000-000000000405',
  membership: '5eed0000-0000-4000-8000-000000000301',
  period: '5eed0000-0000-4000-8000-000000000601',
  package: '5eed0000-0000-4000-8000-000000000604',
  commitment: '5eed0000-0000-4000-8000-000000000605',
  baseline: '5eed0000-0000-4000-8000-000000000606',
  packageBaseline: '5eed0000-0000-4000-8000-000000000607',
  run: '5eed0000-0000-4000-8000-000000000608',
  log: '5eed0000-0000-4000-8000-000000000609',
  logRevision: '5eed0000-0000-4000-8000-000000000610',
};
const hash = 'a'.repeat(64);
const period = contracts.planningPeriodSchema.parse({
  id: ids.period, workspaceId: W, projectId: ids.project, name: 'Synthetic week',
  localStart: '2026-10-19', localEndExclusive: '2026-10-26', timezone: 'Asia/Nicosia', cutoffAt: TS,
  state: 'planning', revision: 1, protectedFieldIds: [], protectEstimate: true, projectBaselineId: null,
  createdAt: TS, updatedAt: TS,
});
const commitment = contracts.periodCommitmentSchema.parse({
  id: ids.commitment, workspaceId: W, projectId: ids.project, periodId: ids.period,
  workPackageId: ids.package, membershipId: ids.membership, plannedMinutes: 360,
  allocations: [{ taskId: ids.task, minutes: 360 }], unallocatedMinutes: 0, state: 'active',
  revision: 1, classification: 'planned', baselineIds: [], createdAt: TS, updatedAt: TS,
});
const workPackage = contracts.planningPackageSchema.parse({
  id: ids.package, projectId: ids.project, revision: 1, estimateMinutes: 1200, createdAt: TS,
  packageBaselineId: null, title: 'Synthetic package',
});
const snapshot = contracts.planningSnapshotSchema.parse({
  schemaVersion: 1, period, commitments: [commitment], packages: [workPackage], projectPackageIds: [ids.package],
  tasks: [], memberships: [], fieldDefinitions: [], fieldValues: [], sourcePersonalBaselineIds: [],
});
const baseline = contracts.planBaselineSchema.parse({
  id: ids.baseline, workspaceId: W, projectId: ids.project, periodId: ids.period, scope: 'project', membershipId: null,
  mode: 'manual', requestedCutoffAt: TS, frozenAt: TS, actorUserId: FIXTURE_USER_IDS.owner,
  source: 'web', changeSeq: '9007199254740993', snapshot,
});
const packageBaseline = contracts.packageBaselineSchema.parse({
  id: ids.packageBaseline, workspaceId: W, projectId: ids.project, workPackageId: ids.package,
  estimateMinutes: 1200, sourcePackageRevision: 1, acceptedAt: TS, sourceBaselineId: ids.baseline,
  provenance: 'first_known_plan_freeze',
});
const origin = { planBaselineId: ids.baseline, periodId: ids.period, periodLocalStart: '2026-10-19', scope: 'project', mode: 'manual', frozenAt: TS, packageRevision: 1 } as const;
const originalTarget = { workspaceId: W, projectId: ids.project, workPackageId: ids.package };
const originalCaptured = contracts.originalPackageEstimateSchema.parse({
  state: 'captured', ...originalTarget, estimateMinutes: 0, packageBaselineId: ids.packageBaseline, acceptedAt: TS,
  provenance: 'first_known_plan_freeze', origin,
});
const originalUnknown = contracts.originalPackageEstimateSchema.parse({ state: 'original_unknown', ...originalTarget, estimateMinutes: null, packageBaselineId: null, origin });
const originalPending = contracts.originalPackageEstimateSchema.parse({ state: 'not_captured_yet', ...originalTarget });
const preview = contracts.freezePreviewSchema.parse({
  periodId: ids.period, scope: 'project', membershipId: null, previewHash: hash, snapshot, existingBaselineId: null,
});
const workLog = contracts.manualPeriodWorkLogSchema.parse({
  id: ids.log, workspaceId: W, projectId: ids.project, taskId: ids.task, workPackageId: ids.package,
  membershipId: ids.membership, periodId: ids.period, sourceKind: 'manual_period',
  sourceKey: `${ids.task}:${ids.membership}:${ids.period}`, precision: 'period', revision: 1,
  revisionId: ids.logRevision, minutes: 300, state: 'active', reason: null,
  actorUserId: FIXTURE_USER_IDS.owner, recordedAt: TS, changeSeq: '9007199254740993',
});
const summary = contracts.weeklyPlanFactSummarySchema.parse({
  knownPlannedMinutes: 360, actualMinutes: 300, missingEstimateCount: 0,
  baselineCompleteness: { knownItemCount: 1, totalItemCount: 1, ratio: 1, complete: true },
  factCoverage: { recordedItemCount: 1, totalItemCount: 1, ratio: 1, complete: true },
  totalVarianceMinutes: -60, totalVariancePercent: -100 / 6,
  addedActualMinutes: 0, unplannedActualMinutes: 0, totalActualMinutes: 300,
});
const reportRun = contracts.weeklyPlanFactReportRunSchema.parse({
  id: ids.run, workspaceId: W, projectId: ids.project, periodId: ids.period, baselineId: ids.baseline,
  metricVersion: 'weekly_plan_fact_v1', createdAt: TS, actorUserId: FIXTURE_USER_IDS.owner,
  factCutoffAt: TS, factChangeSeq: '9007199254740993', membershipIds: [], knownEstimatesOnly: false,
  cohort: { selectedItemCount: 1, originalItemCount: 1 }, summary, rowCount: 1, workLogRevisionIds: [ids.logRevision],
  byPerson: [{ membershipId: ids.membership, memberName: 'Synthetic Owner', summary }],
});
const reportRow = contracts.weeklyPlanFactRowSchema.parse({
  id: ids.commitment, scope: 'original', commitmentId: ids.commitment, workPackageId: ids.package,
  membershipId: ids.membership, title: 'Synthetic package', memberName: 'Synthetic Owner',
  plannedMinutes: 360, actualMinutes: 300, factRecorded: true, varianceMinutes: -60,
  packageEstimateMinutes: 1200, packageBaselineId: ids.packageBaseline, taskIds: [ids.task], workLogs: [workLog],
});

type Method = keyof PlanningApplication;
interface Call { method: Method; ctx: CommandContext; args: unknown[] }
const calls: Call[] = [];
const overrides = new Map<Method, () => unknown>();
function record<R>(method: Method, result: R) {
  return async (ctx: CommandContext, ...args: unknown[]): Promise<R> => {
    calls.push({ method, ctx, args });
    const override = overrides.get(method);
    return override ? override() as R : result;
  };
}
const page = <T>(item: T) => ({ items: [item], nextCursor: CURSOR });
const planning: PlanningApplication = {
  listPeriods: record('listPeriods', page(period)), getPeriod: record('getPeriod', period),
  createPeriod: record('createPeriod', period), updatePeriod: record('updatePeriod', period),
  listPackages: record('listPackages', page(workPackage)),
  listCommitments: record('listCommitments', page(commitment)),
  createCommitment: record('createCommitment', commitment), updateCommitment: record('updateCommitment', commitment),
  previewFreeze: record('previewFreeze', preview), freezePlan: record('freezePlan', baseline),
  listBaselines: record('listBaselines', page(baseline)), getBaseline: record('getBaseline', baseline),
  getPackageBaseline: record('getPackageBaseline', packageBaseline),
  getOriginalPackageEstimate: record('getOriginalPackageEstimate', originalCaptured),
  listWorkLogs: record('listWorkLogs', page(workLog)), setManualPeriodWork: record('setManualPeriodWork', workLog),
  listReportRuns: record('listReportRuns', page(reportRun)), createReportRun: record('createReportRun', reportRun),
  getReportRun: record('getReportRun', reportRun), listReportRows: record('listReportRows', page(reportRow)),
};
const repository: AccessRepository = {
  findUser: async (id) => DEMO_USERS.find((user) => user.id === id) ?? null,
  findUsers: async (userIds) => DEMO_USERS.filter((user) => userIds.includes(user.id)),
  listAccessibleWorkspaces: async () => [], findWorkspaceAccess: async () => null, listActiveMemberships: async () => [],
};
const readiness: ReadinessProbe = { check: async () => ({ ready: true, checks: { database: 'ok', schema: 'ok' } }) };
const config = loadConfig({ APP_ENV: 'local', AUTH_MODE: 'dev', DATABASE_URL: 'postgres://u:p@127.0.0.1:5432/unused' });
const createPeriodInput = { projectId: ids.project, name: 'Week', localStart: '2026-10-19', timezone: 'Asia/Nicosia', cutoffAt: TS };
const createCommitmentInput = { workPackageId: ids.package, membershipId: ids.membership, expectedAbsent: true, plannedMinutes: null };
const updateCommitmentInput = { expectedRevision: 7, plannedMinutes: 0, allocations: [], state: 'active' };
const manualPath = `/tasks/${ids.task}/manual-period-work/${ids.period}/${ids.membership}`;
interface Route {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH'; path: string; query?: string; input?: Record<string, unknown>;
  service: Method; args: unknown[]; result: unknown; status?: number; paged?: boolean; readOnly?: boolean;
}
const routes: Route[] = [
  { method: 'GET', path: '/periods', query: `projectId=${ids.project}`, service: 'listPeriods', args: [{ projectId: ids.project, limit: 50 }], result: [period], paged: true },
  { method: 'POST', path: '/periods', input: createPeriodInput, service: 'createPeriod', args: [{ ...createPeriodInput, protectedFieldIds: [], protectEstimate: true }], result: period, status: 201 },
  { method: 'GET', path: `/periods/${ids.period}`, service: 'getPeriod', args: [ids.period], result: period },
  { method: 'PATCH', path: `/periods/${ids.period}`, input: { expectedRevision: 2, name: 'Renamed' }, service: 'updatePeriod', args: [ids.period, { expectedRevision: 2, name: 'Renamed' }], result: period },
  { method: 'GET', path: '/planning-packages', query: `projectId=${ids.project}`, service: 'listPackages', args: [{ projectId: ids.project, limit: 50 }], result: [workPackage], paged: true },
  { method: 'GET', path: `/planning-packages/${ids.package}/original-estimate`, service: 'getOriginalPackageEstimate', args: [ids.package], result: originalCaptured },
  { method: 'GET', path: `/periods/${ids.period}/commitments`, service: 'listCommitments', args: [ids.period, { limit: 50 }], result: [commitment], paged: true },
  { method: 'POST', path: `/periods/${ids.period}/commitments`, input: createCommitmentInput, service: 'createCommitment', args: [ids.period, { ...createCommitmentInput, allocations: [] }], result: commitment, status: 201 },
  { method: 'PUT', path: `/periods/${ids.period}/commitments/${ids.commitment}`, input: updateCommitmentInput, service: 'updateCommitment', args: [ids.period, ids.commitment, updateCommitmentInput], result: commitment },
  { method: 'POST', path: `/periods/${ids.period}/freeze-preview`, input: { scope: 'project' }, service: 'previewFreeze', args: [ids.period, { scope: 'project' }], result: preview, readOnly: true },
  { method: 'POST', path: `/periods/${ids.period}/freeze`, input: { scope: 'project', previewHash: hash }, service: 'freezePlan', args: [ids.period, { scope: 'project', previewHash: hash }], result: baseline },
  { method: 'GET', path: `/periods/${ids.period}/baselines`, service: 'listBaselines', args: [ids.period, { limit: 50 }], result: [baseline], paged: true },
  { method: 'GET', path: `/baselines/${ids.baseline}`, service: 'getBaseline', args: [ids.baseline], result: baseline },
  { method: 'GET', path: `/package-baselines/${ids.packageBaseline}`, service: 'getPackageBaseline', args: [ids.packageBaseline], result: packageBaseline },
  { method: 'GET', path: '/worklogs', query: `periodId=${ids.period}`, service: 'listWorkLogs', args: [{ periodId: ids.period, limit: 50 }], result: [workLog], paged: true },
  { method: 'PUT', path: manualPath, input: { expectedRevision: null, minutes: 0 }, service: 'setManualPeriodWork', args: [ids.task, ids.period, ids.membership, { expectedRevision: null, minutes: 0, state: 'active', reason: null }], result: workLog },
  { method: 'GET', path: '/report-runs', query: `periodId=${ids.period}`, service: 'listReportRuns', args: [{ periodId: ids.period, limit: 50 }], result: [reportRun], paged: true },
  { method: 'POST', path: '/report-runs', input: { baselineId: ids.baseline }, service: 'createReportRun', args: [{ baselineId: ids.baseline, membershipIds: [], knownEstimatesOnly: false }], result: reportRun, status: 201 },
  { method: 'GET', path: `/report-runs/${ids.run}`, service: 'getReportRun', args: [ids.run], result: reportRun },
  { method: 'GET', path: `/report-runs/${ids.run}/rows`, service: 'listReportRows', args: [ids.run, { limit: 50 }], result: [reportRow], paged: true },
];
const mutations = routes.filter((route) => route.method !== 'GET' && !route.readOnly);
let app: FastifyInstance;
function url(route: Route) { return `${BASE}${route.path}${route.query ? `?${route.query}` : ''}`; }
function headers(key: string | undefined = KEY) {
  return { host: HOST, origin: ORIGIN, ...(key === undefined ? {} : { 'idempotency-key': key }) };
}

beforeAll(async () => { app = await createApp(config, { accessRepository: repository, readiness, planningApplication: planning, logger: false, webDistDir: null }); });
afterAll(async () => { await app.close(); });
beforeEach(() => { calls.length = 0; overrides.clear(); });

describe('P2a planning HTTP adapter', () => {
  it.each(routes)('$method $path delegates parsed input, server identity and response', async (route) => {
    const response = await app.inject({ method: route.method, url: url(route), headers: { ...headers(), 'x-actor-id': FIXTURE_USER_IDS.outsider, 'x-request-id': 'spoofed' }, ...(route.input ? { payload: route.input } : {}) });
    expect(response.statusCode).toBe(route.status ?? 200);
    const body = response.json();
    expect(body.data).toEqual(route.result);
    expect(body.meta.requestId).toBe(response.headers['x-request-id']);
    expect(body.meta.requestId).not.toBe('spoofed');
    if (route.paged) expect(body.meta.nextCursor).toBe(CURSOR);
    else expect(body.meta).not.toHaveProperty('nextCursor');
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({ method: route.service, args: route.args, ctx: { actor: { userId: FIXTURE_USER_IDS.owner, displayName: DEMO_USERS.find((user) => user.id === FIXTURE_USER_IDS.owner)?.displayName, kind: 'fixture' }, workspaceId: W, source: 'web', requestId: body.meta.requestId, ...(route.method === 'GET' || route.readOnly ? {} : { idempotencyKey: KEY }) } });
  });

  it.each(routes)('$method $path canonicalizes uppercase path IDs', async (route) => {
    const upperUrl = url(route).replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, (id) => id.toUpperCase());
    const response = await app.inject({ method: route.method, url: upperUrl, headers: headers(), ...(route.input ? { payload: route.input } : {}) });
    expect(response.statusCode).toBe(route.status ?? 200);
    expect(calls[0]?.args).toEqual(route.args);
    expect(calls[0]?.ctx.workspaceId).toBe(W);
  });

  it.each(mutations)('$method $path requires a valid key before calling the service', async (route) => {
    for (const key of [undefined, '', 'has space', 'x'.repeat(129)]) {
      const response = await app.inject({ method: route.method, url: url(route), headers: { host: HOST, origin: ORIGIN, ...(key === undefined ? {} : { 'idempotency-key': key }) }, ...(route.input ? { payload: route.input } : {}) });
      expect(response.statusCode).toBe(400);
      expect(response.json().error.code).toBe('VALIDATION_FAILED');
    }
    expect(calls).toHaveLength(0);
  });

  it.each(mutations)('$method $path rejects spoofed or server-derived body properties', async (route) => {
    for (const property of ['actor', 'workspaceId', 'source', 'classification', 'frozenAt']) {
      const response = await app.inject({ method: route.method, url: url(route), headers: headers(), payload: { ...route.input, [property]: 'spoofed' } });
      expect(response.statusCode).toBe(400);
    }
    expect(calls).toHaveLength(0);
  });

  it('freeze preview is a read without a key, still strictly parsed and origin protected', async () => {
    const path = `${BASE}/periods/${ids.period}/freeze-preview`;
    const good = await app.inject({ method: 'POST', url: path, headers: { host: HOST, origin: ORIGIN }, payload: { scope: 'project' } });
    expect(good.statusCode).toBe(200);
    expect(calls[0]?.ctx).not.toHaveProperty('idempotencyKey');
    calls.length = 0;
    for (const input of [{ scope: 'other' }, { scope: 'self', membershipId: ids.membership }, { scope: 'self', previewHash: hash }]) {
      expect((await app.inject({ method: 'POST', url: path, headers: headers(), payload: input })).statusCode).toBe(400);
    }
    expect((await app.inject({ method: 'POST', url: path, headers: { host: HOST }, payload: { scope: 'self' } })).statusCode).toBe(403);
    expect(calls).toHaveLength(0);
  });

  it.each(routes.filter((route) => route.paged))('$path preserves explicit limit/cursor and terminal pages', async (route) => {
    const response = await app.inject({ method: 'GET', url: `${url(route)}${route.query ? '&' : '?'}limit=100&cursor=${encodeURIComponent(CURSOR)}`, headers: headers() });
    expect(response.statusCode).toBe(200);
    const lastArg = calls[0]?.args.at(-1);
    expect(lastArg).toEqual({ ...(route.args.at(-1) as object), limit: 100, cursor: CURSOR });
    overrides.set(route.service, () => ({ items: route.result, nextCursor: null }));
    const terminal = await app.inject({ method: 'GET', url: url(route), headers: headers() });
    expect(terminal.json().meta.nextCursor).toBeNull();
  });

  it('preserves explicit membership/task filters as data, never as the acting identity', async () => {
    const response = await app.inject({ url: `${BASE}/worklogs?periodId=${ids.period}&taskId=${ids.task}&membershipId=${ids.membership}`, headers: headers() });
    expect(response.statusCode).toBe(200);
    expect(calls[0]?.args).toEqual([{ periodId: ids.period, taskId: ids.task, membershipId: ids.membership, limit: 50 }]);
    expect(calls[0]?.ctx.actor.userId).toBe(FIXTURE_USER_IDS.owner);
  });

  it('rejects unknown, malformed, duplicated or out-of-range query parameters without a service call', async () => {
    const queries = [
      '/periods', '/planning-packages', '/worklogs', '/report-runs',
      `/periods?projectId=${ids.project}&actorId=${ids.membership}`,
      `/periods?projectId=${ids.project}&projectId=${ids.project}`,
      `/periods?projectId=invalid`, `/periods?projectId=${ids.project}&limit=0`,
      `/periods?projectId=${ids.project}&limit=101`, `/periods?projectId=${ids.project}&limit=1.5`,
      `/periods?projectId=${ids.project}&cursor=`, `/periods/${ids.period}?limit=50`,
      `/periods/${ids.period}/commitments?membershipId=invalid`,
      `/report-runs/${ids.run}/rows?source=web`,
    ];
    for (const path of queries) {
      const response = await app.inject({ url: BASE + path, headers: headers() });
      expect(response.statusCode, path).toBe(400);
    }
    expect(calls).toHaveLength(0);
  });

  it('rejects invalid period, commitment, preview, fact and report bodies', async () => {
    const invalid: [string, string, Record<string, unknown>][] = [
      ['POST', '/periods', { ...createPeriodInput, localStart: '2026-02-30' }],
      ['POST', '/periods', { ...createPeriodInput, timezone: 'Not/AZone' }],
      ['PATCH', `/periods/${ids.period}`, { name: 'No expected revision' }],
      ['PATCH', `/periods/${ids.period}`, { expectedRevision: 1 }],
      ['POST', `/periods/${ids.period}/commitments`, { ...createCommitmentInput, expectedAbsent: false }],
      ['POST', `/periods/${ids.period}/commitments`, { ...createCommitmentInput, plannedMinutes: -1 }],
      ['PUT', `/periods/${ids.period}/commitments/${ids.commitment}`, { ...updateCommitmentInput, allocations: [{ taskId: ids.task, minutes: 1.5 }] }],
      ['POST', `/periods/${ids.period}/freeze`, { scope: 'project' }],
      ['POST', `/periods/${ids.period}/freeze`, { scope: 'project', previewHash: 'client snapshot' }],
      ['PUT', manualPath, { minutes: 0 }],
      ['PUT', manualPath, { expectedRevision: null, minutes: null }],
      ['PUT', manualPath, { expectedRevision: 0, minutes: 0 }],
      ['POST', '/report-runs', { baselineId: ids.baseline, membershipIds: [ids.membership, ids.membership] }],
    ];
    for (const [method, path, payload] of invalid) {
      const response = await app.inject({ method: method as 'POST' | 'PUT' | 'PATCH', url: BASE + path, headers: headers(), payload });
      expect(response.statusCode, `${method} ${path}`).toBe(400);
    }
    expect(calls).toHaveLength(0);
  });

  it('passes null/zero plans, allocations and independent revisions through unchanged', async () => {
    for (const plannedMinutes of [null, 0, 360]) {
      const input = { expectedRevision: 11, plannedMinutes, allocations: [{ taskId: ids.task, minutes: 0 }], state: 'removed' };
      const response = await app.inject({ method: 'PUT', url: `${BASE}/periods/${ids.period}/commitments/${ids.commitment}`, headers: headers(), payload: input });
      expect(response.statusCode).toBe(200);
      expect(calls.at(-1)?.args).toEqual([ids.period, ids.commitment, input]);
    }
  });

  it('keeps absent versus existing worklog guards and period-only correction/void inputs', async () => {
    for (const expectedRevision of [null, 5]) {
      const input = { expectedRevision, minutes: 0, state: 'void', reason: 'Synthetic correction' };
      const response = await app.inject({ method: 'PUT', url: BASE + manualPath, headers: headers(), payload: input });
      expect(response.statusCode).toBe(200);
      expect(calls.at(-1)?.args).toEqual([ids.task, ids.period, ids.membership, input]);
    }
  });

  it('rejects malformed target IDs and foreign origins before the service', async () => {
    for (const path of [`/periods/not-a-uuid`, `/baselines/not-a-uuid`, `/package-baselines/not-a-uuid`, `/planning-packages/not-a-uuid/original-estimate`, `/report-runs/not-a-uuid`]) {
      expect((await app.inject({ url: BASE + path, headers: headers() })).statusCode).toBe(400);
    }
    for (const method of ['POST', 'PUT'] as const) {
      const target = method === 'POST' ? `/periods/${ids.period}/freeze` : manualPath;
      const input = method === 'POST' ? { scope: 'self', previewHash: hash } : { expectedRevision: null, minutes: 0 };
      expect((await app.inject({ method, url: BASE + target, headers: { ...headers(), origin: 'https://foreign.example' }, payload: input })).statusCode).toBe(403);
    }
    expect(calls).toHaveLength(0);
  });

  it.each([
    ['PREVIEW_STALE', 409], ['REVISION_CONFLICT', 409], ['FIELD_LOCKED', 409],
    ['IDEMPOTENCY_KEY_REUSED', 409], ['CAPABILITY_REQUIRED', 403], ['NOT_FOUND', 404],
    ['DOMAIN_VALIDATION_FAILED', 422], ['PLAN_VALUE_UNRESOLVED', 422], ['TEMPORARILY_UNAVAILABLE', 503],
  ] as const)('maps %s through the established domain error envelope', async (code, status) => {
    overrides.set('freezePlan', () => { throw new DomainError(code, code === 'NOT_FOUND' ? NOT_FOUND_MESSAGE : 'Safe rejection'); });
    const response = await app.inject({ method: 'POST', url: `${BASE}/periods/${ids.period}/freeze`, headers: headers(), payload: { scope: 'self', previewHash: hash } });
    expect(response.statusCode).toBe(status);
    expect(response.json().error.code).toBe(code);
    expect(contracts.errorResponseSchema.safeParse(response.json()).success).toBe(true);
    expect(calls).toHaveLength(1);
  });

  it('preserves committed-rejection details without treating a rejection as success or retrying', async () => {
    overrides.set('updateCommitment', () => {
      throw new DomainError('FIELD_LOCKED', 'The original plan is frozen.', { details: { committed: true, baselineIds: [ids.baseline] } });
    });
    const response = await app.inject({ method: 'PUT', url: `${BASE}/periods/${ids.period}/commitments/${ids.commitment}`, headers: headers(), payload: updateCommitmentInput });
    expect(response.statusCode).toBe(409);
    expect(response.json().error).toMatchObject({ code: 'FIELD_LOCKED', retryable: false, details: { committed: true, baselineIds: [ids.baseline] } });
    expect(response.json()).not.toHaveProperty('data');
    expect(calls).toHaveLength(1);
  });

  it('returns the server pinned run, by-person summaries and drilldown revisions without recomputation', async () => {
    const run = await app.inject({ url: `${BASE}/report-runs/${ids.run}`, headers: headers() });
    expect(run.json().data).toEqual(reportRun);
    expect(run.json().data.summary.totalVarianceMinutes).toBe(-60);
    expect(run.json().data.byPerson).toEqual(reportRun.byPerson);
    const rows = await app.inject({ url: `${BASE}/report-runs/${ids.run}/rows`, headers: headers() });
    expect(rows.json().data[0].workLogs[0].revisionId).toBe(ids.logRevision);
    expect(rows.json().data[0].workLogs[0].precision).toBe('period');
  });

  it('accepts attendance-source weekly report rows while legacy manual reads stay manual', async () => {
    const attendance = contracts.attendanceWorkLogSchema.parse({ ...workLog, sourceKind: 'meeting_attendance', precision: 'occurrence', sourceKey: '5eed0000-0000-4000-8000-000000000802',
      meetingId: '5eed0000-0000-4000-8000-000000000801', attendanceId: '5eed0000-0000-4000-8000-000000000802', confirmedMeetingRevision: 3,
      attribution: { basis: 'actual_meeting', plannedStartAt: TS, actualStartAt: TS } });
    overrides.set('listReportRows', () => ({ items: [{ ...reportRow, workLogs: [attendance] }], nextCursor: null }));
    const rows = await app.inject({ url: `${BASE}/report-runs/${ids.run}/rows`, headers: headers() });
    expect(rows.statusCode).toBe(200);
    expect(rows.json().data[0].workLogs[0]).toEqual(attendance);
    const manual = await app.inject({ url: `${BASE}/worklogs?periodId=${ids.period}`, headers: headers() });
    expect(manual.statusCode).toBe(200);
    expect(manual.json().data).toEqual([workLog]);
  });

  it('propagates the shared meeting manual-write guard without redirecting or changing old inputs', async () => {
    overrides.set('setManualPeriodWork', () => { throw new DomainError('DOMAIN_VALIDATION_FAILED', 'Use the attendance source for this meeting.'); });
    const response = await app.inject({ method: 'PUT', url: BASE + manualPath, headers: headers(), payload: { expectedRevision: null, minutes: 0 } });
    expect(response.statusCode).toBe(422);
    expect(response.json()).not.toHaveProperty('data');
    expect(calls).toHaveLength(1);
    expect(calls[0]?.args).toEqual([ids.task, ids.period, ids.membership, { expectedRevision: null, minutes: 0, state: 'active', reason: null }]);
    expect(calls[0]?.ctx.idempotencyKey).toBe(KEY);
  });

  it('returns each original-estimate state unchanged, rejects queries and never accepts a current estimate in the projection', async () => {
    const path = `${BASE}/planning-packages/${ids.package}/original-estimate`;
    for (const value of [originalCaptured, originalUnknown, originalPending]) {
      overrides.set('getOriginalPackageEstimate', () => value);
      const response = await app.inject({ url: path, headers: headers() });
      expect(response.statusCode).toBe(200);
      expect(response.json().data).toEqual(value);
      expect(response.json().data).not.toHaveProperty('currentEstimateMinutes');
    }
    for (const query of ['?limit=1', '?estimateMinutes=0', '?projectId=' + ids.project]) {
      expect((await app.inject({ url: path + query, headers: headers() })).statusCode).toBe(400);
    }
    // Invalid service output: an unknown original may not carry a guessed estimate or baseline.
    overrides.set('getOriginalPackageEstimate', () => ({ ...originalUnknown, estimateMinutes: 120 }));
    expect((await app.inject({ url: path, headers: headers() })).statusCode).toBe(500);
    overrides.set('getOriginalPackageEstimate', () => ({ ...originalPending, estimateMinutes: 120, origin }));
    const pending = await app.inject({ url: path, headers: headers() });
    expect(pending.statusCode).toBe(200);
    expect(pending.json().data).toEqual(originalPending);
    for (const code of ['NOT_FOUND', 'TEMPORARILY_UNAVAILABLE'] as const) {
      overrides.set('getOriginalPackageEstimate', () => { throw new DomainError(code, code === 'NOT_FOUND' ? NOT_FOUND_MESSAGE : 'Safe rejection'); });
      expect((await app.inject({ url: path, headers: headers() })).statusCode).toBe(code === 'NOT_FOUND' ? 404 : 503);
    }
  });

  it('keeps old package, package-baseline and snapshot DTOs free of original-estimate observations', async () => {
    expect(Object.keys(contracts.planningPackageSchema.shape).sort()).toEqual(['createdAt', 'estimateMinutes', 'id', 'packageBaselineId', 'projectId', 'revision', 'title']);
    expect(Object.keys(contracts.packageBaselineSchema.shape).sort()).toEqual(['acceptedAt', 'estimateMinutes', 'id', 'projectId', 'provenance', 'sourceBaselineId', 'sourcePackageRevision', 'workPackageId', 'workspaceId']);
    expect(contracts.planBaselineSchema.parse(JSON.parse(JSON.stringify(baseline)))).toEqual(baseline);
    const response = await app.inject({ url: `${BASE}/baselines/${ids.baseline}`, headers: headers() });
    expect(JSON.stringify(response.json().data)).not.toMatch(/original_unknown|not_captured_yet|"origin"/);
  });

  it('redacts unexpected failures and rejects invalid service output', async () => {
    overrides.set('getPeriod', () => { throw new Error('select secret sql password=never-return'); });
    const failed = await app.inject({ url: `${BASE}/periods/${ids.period}`, headers: headers() });
    expect(failed.statusCode).toBe(500);
    expect(failed.body).not.toContain('never-return');
    overrides.set('getPeriod', () => ({ id: ids.period }));
    expect((await app.inject({ url: `${BASE}/periods/${ids.period}`, headers: headers() })).statusCode).toBe(500);
  });

  it('keeps P0/P1 injected apps without a planning service free of planning routes', async () => {
    const older = await createApp(config, { accessRepository: repository, readiness, logger: false, webDistDir: null });
    try { expect((await older.inject({ url: `${BASE}/periods?projectId=${ids.project}`, headers: headers() })).statusCode).toBe(404); }
    finally { await older.close(); }
  });
});
