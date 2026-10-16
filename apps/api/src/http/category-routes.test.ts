import * as contracts from '@workloom/contracts';
import { DEMO_USERS, FIXTURE_USER_IDS, FIXTURE_WORKSPACE_IDS, type ReadinessProbe } from '@workloom/db';
import { DomainError, NOT_FOUND_MESSAGE, type AccessRepository, type CommandContext, type WorkCategoryApplication } from '@workloom/domain';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createApp } from '../app.js';
import { loadConfig } from '../config.js';

// Recording service ports verify HTTP contracts only. Real PostgreSQL acceptance proves
// current ACL, transaction/replay semantics, historical snapshots and report arithmetic.
const HOST = '127.0.0.1:4310';
const ORIGIN = `http://${HOST}`;
const KEY = 'category-synthetic-command-key';
const CURSOR = 'opaque+category/cursor==';
const TS = '2026-10-16T09:00:00.000Z';
const W = FIXTURE_WORKSPACE_IDS.team;
const BASE = `/api/v1/workspaces/${W}`;
const ids = {
  project: '5eed0000-0000-4000-8000-000000000401',
  task: '5eed0000-0000-4000-8000-000000000405',
  otherTask: '5eed0000-0000-4000-8000-000000000406',
  membership: '5eed0000-0000-4000-8000-000000000301',
  period: '5eed0000-0000-4000-8000-000000000601',
  package: '5eed0000-0000-4000-8000-000000000604',
  run: '5eed0000-0000-4000-8000-000000000608',
  log: '5eed0000-0000-4000-8000-000000000609',
  logRevision: '5eed0000-0000-4000-8000-000000000610',
  bindingVersion: '5eed0000-0000-4000-8000-000000000701',
  field: '5eed0000-0000-4000-8000-000000000702',
  definitionVersion: '5eed0000-0000-4000-8000-000000000703',
  option: '5eed0000-0000-4000-8000-000000000704',
};
const binding = contracts.projectWorkCategoryBindingSchema.parse({
  workspaceId: W, projectId: ids.project, revision: 2, versionId: ids.bindingVersion,
  fieldId: ids.field, availability: 'active',
});
const category = contracts.workCategorySnapshotSchema.parse({
  kind: 'categorized', bindingVersionId: ids.bindingVersion, bindingRevision: 2,
  fieldId: ids.field, fieldDefinitionVersionId: ids.definitionVersion, fieldLabel: 'Synthetic work type',
  optionId: ids.option, optionRevision: 4, optionLabel: 'Observed historical label', color: '#123456', optionArchivedAt: null,
});
const legacyWorkLog = contracts.manualPeriodWorkLogSchema.parse({
  id: ids.log, workspaceId: W, projectId: ids.project, taskId: ids.task, workPackageId: ids.package,
  membershipId: ids.membership, periodId: ids.period, sourceKind: 'manual_period',
  sourceKey: `${ids.task}:${ids.membership}:${ids.period}`, precision: 'period', revision: 1,
  revisionId: ids.logRevision, minutes: 0, state: 'active', reason: null,
  actorUserId: FIXTURE_USER_IDS.owner, recordedAt: TS, changeSeq: '9007199254740993',
});
const workLog = contracts.categorizedWorkLogSchema.parse({ ...legacyWorkLog, category });
const bucket = { key: `${ids.field}:${ids.option}`, fieldId: ids.field, optionId: ids.option, label: 'Observed historical label', color: '#123456', minutes: 0, sharePercent: null };
const reportRun = contracts.workTypeReportRunSchema.parse({
  id: ids.run, workspaceId: W, projectId: ids.project, periodId: ids.period,
  metricVersion: 'weekly_work_type_v1', createdAt: TS, actorUserId: FIXTURE_USER_IDS.owner,
  factCutoffAt: TS, factChangeSeq: '9007199254740993', membershipIds: [ids.membership],
  totalActualMinutes: 0, activeSourceCount: 1, categorizedMinutes: 0, uncategorizedMinutes: 0,
  byCategory: [bucket], byPerson: [{ membershipId: ids.membership, memberName: 'Synthetic Owner', totalActualMinutes: 0, activeSourceCount: 1, byCategory: [bucket] }],
  rowCount: 1, workLogRevisionIds: [ids.logRevision], labelPolicy: 'highest_option_revision_then_change_seq_then_id',
});
const reportRow = contracts.workTypeReportRowSchema.parse({ id: ids.logRevision, workLog, taskTitle: 'Synthetic task', memberName: 'Synthetic Owner', excluded: false });
const summary = contracts.taskTimeSummarySchema.parse({
  workspaceId: W, projectId: ids.project, periodId: ids.period, subjectMembershipId: ids.membership,
  asOfChangeSeq: '9007199254740993',
  tasks: [{ taskId: ids.task, workPackageId: ids.package, currentAllocationMinutes: null,
    ownManualWork: workLog, subjectActualMinutes: 0, taskActualMinutes: 0,
    subjectActiveSourceCount: 1, taskActiveSourceCount: 1, hasOtherSources: false }],
  packages: [{ workPackageId: ids.package, commitment: null, subjectActualMinutes: 0,
    totalActualMinutes: 0, subjectActiveSourceCount: 1, totalActiveSourceCount: 1 }],
});

type Method = keyof WorkCategoryApplication;
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
const categories: WorkCategoryApplication = {
  getBinding: record('getBinding', binding), updateBinding: record('updateBinding', binding),
  recategorizeWorkLog: record('recategorizeWorkLog', workLog),
  listReportRuns: record('listReportRuns', page(reportRun)), createReportRun: record('createReportRun', reportRun),
  getReportRun: record('getReportRun', reportRun), listReportRows: record('listReportRows', page(reportRow)),
  getTaskTimeSummary: record('getTaskTimeSummary', summary),
};
const repository: AccessRepository = {
  findUser: async (id) => DEMO_USERS.find((user) => user.id === id) ?? null,
  findUsers: async (userIds) => DEMO_USERS.filter((user) => userIds.includes(user.id)),
  listAccessibleWorkspaces: async () => [], findWorkspaceAccess: async () => null, listActiveMemberships: async () => [],
};
const readiness: ReadinessProbe = { check: async () => ({ ready: true, checks: { database: 'ok', schema: 'ok' } }) };
const config = loadConfig({ APP_ENV: 'local', AUTH_MODE: 'dev', DATABASE_URL: 'postgres://u:p@127.0.0.1:5432/unused' });
const bindingPath = `/projects/${ids.project}/work-category-binding`;
const recategorizePath = `/worklogs/${ids.log}/recategorize`;
const summaryPath = `/projects/${ids.project}/periods/${ids.period}/task-time-summary`;
const recategorizeInput = { expectedWorkLogRevision: 7, expectedBindingRevision: 2, optionId: ids.option, reason: '  Explicit historical correction  ' };
interface Route {
  method: 'GET' | 'POST' | 'PATCH'; path: string; query?: string; input?: Record<string, unknown>;
  service: Method; args: unknown[]; result: unknown; status?: number; paged?: boolean;
}
const routes: Route[] = [
  { method: 'GET', path: bindingPath, service: 'getBinding', args: [ids.project], result: binding },
  { method: 'PATCH', path: bindingPath, input: { expectedRevision: 1, fieldId: ids.field }, service: 'updateBinding', args: [ids.project, { expectedRevision: 1, fieldId: ids.field }], result: binding },
  { method: 'POST', path: recategorizePath, input: recategorizeInput, service: 'recategorizeWorkLog', args: [ids.log, { ...recategorizeInput, reason: recategorizeInput.reason.trim() }], result: workLog },
  { method: 'GET', path: '/work-type-report-runs', query: `periodId=${ids.period}`, service: 'listReportRuns', args: [{ periodId: ids.period, limit: 50 }], result: [reportRun], paged: true },
  { method: 'POST', path: '/work-type-report-runs', input: { periodId: ids.period }, service: 'createReportRun', args: [{ periodId: ids.period, membershipIds: [] }], result: reportRun, status: 201 },
  { method: 'GET', path: `/work-type-report-runs/${ids.run}`, service: 'getReportRun', args: [ids.run], result: reportRun },
  { method: 'GET', path: `/work-type-report-runs/${ids.run}/rows`, service: 'listReportRows', args: [ids.run, { limit: 50 }], result: [reportRow], paged: true },
  { method: 'GET', path: summaryPath, query: `taskIds=${ids.otherTask},${ids.task}`, service: 'getTaskTimeSummary', args: [ids.project, ids.period, { taskIds: [ids.task, ids.otherTask] }], result: summary },
];
const mutations = routes.filter(route => route.method !== 'GET');
let app: FastifyInstance;
function url(route: Route) { return `${BASE}${route.path}${route.query ? `?${route.query}` : ''}`; }
function headers(key: string | undefined = KEY) { return { host: HOST, origin: ORIGIN, ...(key === undefined ? {} : { 'idempotency-key': key }) }; }

beforeAll(async () => { app = await createApp(config, { accessRepository: repository, readiness, workCategoryApplication: categories, logger: false, webDistDir: null }); });
afterAll(async () => { await app.close(); });
beforeEach(() => { calls.length = 0; overrides.clear(); });

describe('P2b category HTTP adapter', () => {
  it.each(routes)('$method $path delegates parsed data with trusted actor and exact envelope', async route => {
    const response = await app.inject({ method: route.method, url: url(route), headers: { ...headers(), 'x-actor-id': FIXTURE_USER_IDS.outsider, 'x-request-id': 'spoofed' }, ...(route.input ? { ...(route.input ? { payload: route.input } : {}) } : {}) });
    expect(response.statusCode).toBe(route.status ?? 200);
    const body = response.json();
    expect(body.data).toEqual(route.result);
    expect(body.meta.requestId).toBe(response.headers['x-request-id']);
    expect(body.meta.requestId).not.toBe('spoofed');
    if (route.paged) expect(body.meta.nextCursor).toBe(CURSOR);
    else expect(body.meta).not.toHaveProperty('nextCursor');
    expect(calls).toEqual([{ method: route.service, args: route.args, ctx: {
      actor: { userId: FIXTURE_USER_IDS.owner, displayName: DEMO_USERS.find(user => user.id === FIXTURE_USER_IDS.owner)?.displayName, kind: 'fixture' },
      workspaceId: W, source: 'web', requestId: body.meta.requestId,
      ...(route.method === 'GET' ? {} : { idempotencyKey: KEY }),
    } }]);
  });

  it.each(routes)('$method $path canonicalizes IDs including body/query IDs', async route => {
    const upper = (text: string) => text.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, id => id.toUpperCase());
    const response = await app.inject({ method: route.method, url: upper(url(route)), headers: headers(), ...(route.input ? { payload: JSON.parse(upper(JSON.stringify(route.input))) } : {}) });
    expect(response.statusCode).toBe(route.status ?? 200);
    expect(calls[0]?.args).toEqual(route.args);
    expect(calls[0]?.ctx.workspaceId).toBe(W);
  });

  it.each(mutations)('$method $path requires a visible ASCII command key', async route => {
    for (const key of [undefined, '', 'has space', 'x'.repeat(129)]) {
      const response = await app.inject({ method: route.method, url: url(route), headers: { host: HOST, origin: ORIGIN, ...(key === undefined ? {} : { 'idempotency-key': key }) }, ...(route.input ? { payload: route.input } : {}) });
      expect(response.statusCode).toBe(400);
    }
    expect(calls).toHaveLength(0);
  });

  it.each(mutations)('$method $path rejects client identity, snapshots and unknown query properties', async route => {
    for (const property of ['actor', 'workspaceId', 'category', 'source', 'factCutoffAt', 'label']) {
      expect((await app.inject({ method: route.method, url: url(route), headers: headers(), payload: { ...route.input, [property]: 'spoofed' } })).statusCode).toBe(400);
    }
    expect((await app.inject({ method: route.method, url: `${url(route)}?actorId=${ids.membership}`, headers: headers(), ...(route.input ? { payload: route.input } : {}) })).statusCode).toBe(400);
    expect(calls).toHaveLength(0);
  });

  it.each(mutations)('$method $path keeps Origin mandatory for writes', async route => {
    for (const origin of [undefined, 'https://foreign.example']) {
      expect((await app.inject({ method: route.method, url: url(route), headers: { host: HOST, 'idempotency-key': KEY, ...(origin ? { origin } : {}) }, ...(route.input ? { payload: route.input } : {}) })).statusCode).toBe(403);
    }
    expect(calls).toHaveLength(0);
  });

  it.each(routes.filter(route => route.paged))('$path forwards opaque cursors and terminal pages', async route => {
    const response = await app.inject({ url: `${url(route)}${route.query ? '&' : '?'}limit=100&cursor=${encodeURIComponent(CURSOR)}`, headers: headers() });
    expect(response.statusCode).toBe(200);
    expect(calls[0]?.args.at(-1)).toEqual({ ...(route.args.at(-1) as object), limit: 100, cursor: CURSOR });
    overrides.set(route.service, () => ({ items: [], nextCursor: null }));
    const terminal = await app.inject({ url: url(route), headers: headers() });
    expect(terminal.json()).toMatchObject({ data: [], meta: { nextCursor: null } });
  });

  it('keeps worker filters as data and canonicalizes the bounded task-ID batch', async () => {
    const response = await app.inject({ url: `${BASE}${summaryPath}?taskIds=${ids.otherTask.toUpperCase()},${ids.task}&membershipId=${ids.membership.toUpperCase()}`, headers: headers() });
    expect(response.statusCode).toBe(200);
    expect(calls[0]?.args).toEqual([ids.project, ids.period, { taskIds: [ids.task, ids.otherTask], membershipId: ids.membership }]);
    expect(calls[0]?.ctx.actor.userId).toBe(FIXTURE_USER_IDS.owner);
  });

  it('rejects missing, repeated, malformed and oversized summary batches before invoking the service', async () => {
    const queries = ['', 'taskIds=', 'taskIds=invalid', `taskIds=${ids.task},`, `taskIds=${ids.task},${ids.task.toUpperCase()}`, `taskIds=${ids.task}&taskIds=${ids.otherTask}`, `taskIds=${Array.from({ length: 101 }, (_, i) => `5eed0000-0000-4000-8000-${String(i).padStart(12, '0')}`).join(',')}`, `taskIds=${ids.task}&membershipId=invalid`, `taskIds=${ids.task}&actorId=${ids.membership}`];
    for (const query of queries) expect((await app.inject({ url: `${BASE}${summaryPath}${query ? `?${query}` : ''}`, headers: headers() })).statusCode, query).toBe(400);
    expect(calls).toHaveLength(0);
  });

  it('rejects unsupported read filters and malformed path IDs', async () => {
    const paths = [bindingPath + '?fieldId=' + ids.field, '/work-type-report-runs', `/work-type-report-runs?periodId=${ids.period}&limit=0`, `/work-type-report-runs?periodId=${ids.period}&limit=101`, `/work-type-report-runs?periodId=${ids.period}&limit=1.5`, `/work-type-report-runs?periodId=${ids.period}&periodId=${ids.period}`, `/work-type-report-runs?periodId=${ids.period}&cursor=`, `/work-type-report-runs?periodId=${ids.period}&knownEstimatesOnly=true`, `/work-type-report-runs/${ids.run}/rows?categoryId=${ids.option}`, '/projects/invalid/work-category-binding', '/work-type-report-runs/invalid', `/projects/${ids.project}/periods/invalid/task-time-summary?taskIds=${ids.task}`];
    for (const path of paths) expect((await app.inject({ url: BASE + path, headers: headers() })).statusCode, path).toBe(400);
    expect(calls).toHaveLength(0);
  });

  it('rejects invalid binding/recategorization/report command bodies', async () => {
    const cases: [string, string, Record<string, unknown>][] = [
      ['PATCH', bindingPath, { fieldId: ids.field }], ['PATCH', bindingPath, { expectedRevision: 0, fieldId: null }],
      ['POST', recategorizePath, { ...recategorizeInput, expectedWorkLogRevision: 0 }],
      ['POST', recategorizePath, { ...recategorizeInput, expectedBindingRevision: 0 }],
      ['POST', recategorizePath, { ...recategorizeInput, reason: '   ' }],
      ['POST', recategorizePath, { ...recategorizeInput, reason: 'x'.repeat(1001) }],
      ['POST', recategorizePath, { ...recategorizeInput, minutes: 0 }],
      ['POST', '/work-type-report-runs', { baselineId: ids.run }],
      ['POST', '/work-type-report-runs', { periodId: ids.period, membershipIds: [ids.membership, ids.membership.toUpperCase()] }],
      ['POST', '/work-type-report-runs', { periodId: ids.period, membershipIds: Array.from({ length: 101 }, (_, i) => `5eed0000-0000-4000-8000-${String(i).padStart(12, '0')}`) }],
    ];
    for (const [method, path, payload] of cases) expect((await app.inject({ method: method as 'PATCH' | 'POST', url: BASE + path, headers: headers(), payload })).statusCode, path).toBe(400);
    expect(calls).toHaveLength(0);
  });

  it('preserves explicit clear, independent expected revisions and explicit report members', async () => {
    const clear = { expectedWorkLogRevision: 8, expectedBindingRevision: 3, optionId: null, reason: 'Clear by explicit choice' };
    expect((await app.inject({ method: 'POST', url: BASE + recategorizePath, headers: headers(), payload: clear })).statusCode).toBe(200);
    expect(calls.at(-1)?.args).toEqual([ids.log, clear]);
    expect((await app.inject({ method: 'PATCH', url: BASE + bindingPath, headers: headers(), payload: { expectedRevision: 3, fieldId: null } })).statusCode).toBe(200);
    expect(calls.at(-1)?.args).toEqual([ids.project, { expectedRevision: 3, fieldId: null }]);
    expect((await app.inject({ method: 'POST', url: BASE + '/work-type-report-runs', headers: headers(), payload: { periodId: ids.period, membershipIds: [ids.membership] } })).statusCode).toBe(201);
    expect(calls.at(-1)?.args).toEqual([{ periodId: ids.period, membershipIds: [ids.membership] }]);
  });

  it.each(routes.filter(route => route.method === 'GET'))('$path preserves current access rejections without cached data', async route => {
    overrides.set(route.service, () => { throw new DomainError('NOT_FOUND', NOT_FOUND_MESSAGE); });
    const response = await app.inject({ url: url(route), headers: headers() });
    expect(response.statusCode).toBe(404);
    expect(response.json().error.code).toBe('NOT_FOUND');
    expect(response.json()).not.toHaveProperty('data');
    expect(calls).toHaveLength(1);
  });

  it.each([['REVISION_CONFLICT', 409], ['IDEMPOTENCY_KEY_REUSED', 409], ['FIELD_LOCKED', 409], ['CAPABILITY_REQUIRED', 403], ['DOMAIN_VALIDATION_FAILED', 422], ['TEMPORARILY_UNAVAILABLE', 503]] as const)('maps %s from the command service without HTTP retries', async (code, status) => {
    overrides.set('recategorizeWorkLog', () => { throw new DomainError(code, 'Safe rejection'); });
    const response = await app.inject({ method: 'POST', url: BASE + recategorizePath, headers: headers(), payload: recategorizeInput });
    expect(response.statusCode).toBe(status);
    expect(response.json().error.code).toBe(code);
    expect(contracts.errorResponseSchema.safeParse(response.json()).success).toBe(true);
    expect(calls).toHaveLength(1);
  });

  it('forwards the same key and original submitted payload on an explicit retry', async () => {
    for (let i = 0; i < 2; i++) {
      const response = await app.inject({ method: 'POST', url: BASE + recategorizePath, headers: headers(), payload: recategorizeInput });
      expect(response.statusCode).toBe(200);
      expect(response.json().data).toEqual(workLog);
    }
    expect(calls).toHaveLength(2);
    expect(calls[0]?.args).toEqual(calls[1]?.args);
    expect(calls.map(call => call.ctx.idempotencyKey)).toEqual([KEY, KEY]);
  });

  it('delegates a reused key with a different target to the domain conflict guard', async () => {
    const input = { expectedRevision: 2, fieldId: ids.field };
    expect((await app.inject({ method: 'PATCH', url: BASE + bindingPath, headers: headers(), payload: input })).statusCode).toBe(200);
    overrides.set('updateBinding', () => { throw new DomainError('IDEMPOTENCY_KEY_REUSED', 'Different target under the same key.'); });
    const otherProject = '5eed0000-0000-4000-8000-000000000499';
    const response = await app.inject({ method: 'PATCH', url: `${BASE}/projects/${otherProject}/work-category-binding`, headers: headers(), payload: input });
    expect(response.statusCode).toBe(409);
    expect(response.json()).not.toHaveProperty('data');
    expect(calls.map(call => call.args[0])).toEqual([ids.project, otherProject]);
    expect(calls.map(call => call.ctx.idempotencyKey)).toEqual([KEY, KEY]);
  });

  it('sends server-pinned labels/counts/zero shares without filling missing coverage or aggregating pages', async () => {
    const response = await app.inject({ url: `${BASE}/work-type-report-runs/${ids.run}`, headers: headers() });
    expect(response.json().data).toEqual(reportRun);
    expect(response.json().data.byCategory[0].sharePercent).toBeNull();
    expect(response.json().data).not.toHaveProperty('complete');
    const rows = await app.inject({ url: `${BASE}/work-type-report-runs/${ids.run}/rows`, headers: headers() });
    expect(rows.json().data[0].workLog.category.optionLabel).toBe('Observed historical label');
  });

  it('accepts attendance-source recategorization and pinned category rows without changing request shape', async () => {
    const attendance = contracts.categorizedWorkLogSchema.parse({ ...workLog, sourceKind: 'meeting_attendance', precision: 'occurrence', sourceKey: '5eed0000-0000-4000-8000-000000000802',
      meetingId: '5eed0000-0000-4000-8000-000000000801', attendanceId: '5eed0000-0000-4000-8000-000000000802', confirmedMeetingRevision: 3,
      attribution: { basis: 'planned_absence', plannedStartAt: TS, actualStartAt: null } });
    overrides.set('recategorizeWorkLog', () => attendance);
    const changed = await app.inject({ method: 'POST', url: BASE + recategorizePath, headers: headers(), payload: recategorizeInput });
    expect(changed.statusCode).toBe(200);
    expect(changed.json().data).toEqual(attendance);
    expect(calls[0]?.args).toEqual([ids.log, { ...recategorizeInput, reason: recategorizeInput.reason.trim() }]);
    overrides.set('listReportRows', () => ({ items: [{ ...reportRow, workLog: attendance }], nextCursor: null }));
    const rows = await app.inject({ url: `${BASE}/work-type-report-runs/${ids.run}/rows`, headers: headers() });
    expect(rows.statusCode).toBe(200);
    expect(rows.json().data[0].workLog).toEqual(attendance);
  });

  it('keeps old work.set input defaults and legacy DTOs without an implicit category', () => {
    expect(contracts.setManualPeriodWorkInputSchema.parse({ expectedRevision: null, minutes: 0 })).toEqual({ expectedRevision: null, minutes: 0, state: 'active', reason: null });
    expect(contracts.manualPeriodWorkLogSchema.parse(legacyWorkLog)).not.toHaveProperty('category');
    expect(contracts.setManualPeriodWorkInputSchema.safeParse({ expectedRevision: null, minutes: 0, category }).success).toBe(false);
  });

  it('redacts unexpected service errors and rejects noncanonical response snapshots', async () => {
    overrides.set('getBinding', () => { throw new Error('select password=never-return'); });
    const failed = await app.inject({ url: BASE + bindingPath, headers: headers() });
    expect(failed.statusCode).toBe(500);
    expect(failed.body).not.toContain('never-return');
    overrides.set('getTaskTimeSummary', () => ({ ...summary, tasks: [{ ...summary.tasks[0], ownManualWork: legacyWorkLog }] }));
    expect((await app.inject({ url: `${BASE}${summaryPath}?taskIds=${ids.task}`, headers: headers() })).statusCode).toBe(500);
  });

  it('does not register P2b routes in older injected apps without the category port', async () => {
    const older = await createApp(config, { accessRepository: repository, readiness, logger: false, webDistDir: null });
    try { expect((await older.inject({ url: BASE + bindingPath, headers: headers() })).statusCode).toBe(404); }
    finally { await older.close(); }
  });
});
