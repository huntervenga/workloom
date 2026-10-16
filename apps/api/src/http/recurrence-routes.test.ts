import * as contracts from '@workloom/contracts';
import { DEMO_USERS, FIXTURE_USER_IDS, FIXTURE_WORKSPACE_IDS, type ReadinessProbe } from '@workloom/db';
import { DomainError, NOT_FOUND_MESSAGE, type AccessRepository, type CommandContext, type RecurrenceApplication } from '@workloom/domain';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createApp } from '../app.js';
import { loadConfig } from '../config.js';

// Recording ports prove transport only. Real PostgreSQL acceptance owns current ACL before replay,
// source manifests, signed cursors, census/freeze recovery, atomicity and worker behavior.
const HOST = '127.0.0.1:4310';
const ORIGIN = `http://${HOST}`;
const KEY = 'recurrence-synthetic-command-key';
const CURSOR = 'opaque+recurrence/cursor==';
const TS = '2026-10-16T09:00:00.000Z';
const W = FIXTURE_WORKSPACE_IDS.team;
const BASE = `/api/v1/workspaces/${W}`;
const ids = {
  project: '5eed0000-0000-4000-8000-000000000401', status: '5eed0000-0000-4000-8000-000000000403',
  membership: '5eed0000-0000-4000-8000-000000000301', period: '5eed0000-0000-4000-8000-000000000601',
  series: '5eed0000-0000-4000-8000-000000000901', version: '5eed0000-0000-4000-8000-000000000902',
  binding: '5eed0000-0000-4000-8000-000000000903', instance: '5eed0000-0000-4000-8000-000000000904',
  authorization: '5eed0000-0000-4000-8000-000000000905', meeting: '5eed0000-0000-4000-8000-000000000801',
};
const KEY_DATE = '2026-10-19';
const hash = 'a'.repeat(64);
const manifest = 'b'.repeat(64);
const policyVersion = contracts.RECURRENCE_RESOLUTION_POLICY;
const provenance = { timezone: 'Asia/Nicosia', implementation: 'synthetic', tzdataVersion: '2026b', icuVersion: '78.3' };
const resolution = contracts.recurrenceResolutionSchema.parse({
  policyVersion, intendedLocalDate: KEY_DATE, intendedLocalTime: '10:00', resolvedStartAt: '2026-10-19T07:00:00.000Z',
  resolvedEndAt: '2026-10-19T08:00:00.000Z', resolvedLocalDate: KEY_DATE, resolvedLocalTime: '10:00', resolvedOffset: '+03:00',
  plannedDurationMinutes: 60, warning: null, provenance,
});
const schedule = { startDate: KEY_DATE, localTime: '10:00', timezone: 'Asia/Nicosia', frequency: 'weekly', weekdays: [1, 3], plannedDurationMinutes: 60, end: { kind: 'after_count', count: 10 } };
const template = { title: 'Synthetic standup', statusId: ids.status, organizerMembershipId: ids.membership, attendeeMembershipIds: [ids.membership] };
const series = contracts.recurrenceSeriesSchema.parse({
  id: ids.series, workspaceId: W, projectId: ids.project, revision: 2, state: 'active',
  currentVersion: { id: ids.version, seriesId: ids.series, revision: 1, effectiveFromNominalDate: KEY_DATE, schedule, template, policyVersion, actorUserId: FIXTURE_USER_IDS.owner, createdAt: TS, changeSeq: '9007199254740993' },
  generation: { authorizationId: ids.authorization, authorizationRevision: 1, authorizerMembershipId: ids.membership, state: 'ready', blockedCode: null },
  boundPeriodIds: [ids.period], boundPeriodCount: 1, nominalCandidateCount: 10, createdAt: TS, updatedAt: TS,
});
const candidate = { occurrenceKey: KEY_DATE, nominalSequence: 1, resolution, periodId: ids.period, collidesWithOccurrenceKeys: [] };
const counts = { nominalCount: 10, consumedNominalCount: 0, remainingNominalCount: 10, skippedCount: 0, cancelledCount: 0 };
const ownership = { periodId: ids.period, periodRevision: 1, candidateCount: 2 };
const createPreview = contracts.recurrenceCreatePreviewSchema.parse({ projectId: ids.project, previewHash: hash, policyVersion, provenance, counts, candidates: [candidate], periods: [ownership], unboundCandidateCount: 8, warnings: [] });
const editPreview = contracts.recurrenceEditPreviewSchema.parse({
  seriesId: ids.series, seriesRevision: 2, effectiveFromNominalDate: '2026-10-21', previewHash: hash, counts,
  impacts: [{ occurrenceKey: '2026-10-21', instanceId: ids.instance, periodId: ids.period, action: 'update', before: resolution, after: resolution }], protectedTargets: [],
});
const periodPreview = contracts.recurrencePeriodPreviewSchema.parse({ seriesId: ids.series, seriesRevision: 2, previewHash: hash, periods: [ownership], candidates: [candidate] });
const binding = { id: ids.binding, workspaceId: W, projectId: ids.project, seriesId: ids.series, periodId: ids.period, revision: 1, sourceManifestHash: manifest, state: 'pending', blockedCode: null, headerCount: 2, materializedCount: 0, missingCount: 2, cancelledHeaderOnlyCount: 0, createdAt: TS };
const periodsResult = contracts.recurrencePeriodsResultSchema.parse({ series, bindings: [binding] });
// Reserved header before materialization: all real locators null.
const instance = contracts.recurrenceInstanceSchema.parse({
  id: ids.instance, workspaceId: W, projectId: ids.project, seriesId: ids.series, bindingId: ids.binding, plannedPeriodId: ids.period,
  occurrenceKey: KEY_DATE, nominalSequence: 1, sourceVersionId: ids.version, revision: 1, calendarState: 'scheduled',
  meetingId: null, taskId: null, workPackageId: null, meetingRevision: null, resolution, exception: null, createdAt: TS, updatedAt: TS,
});
const plannedCalendar = { timezone: schedule.timezone, plannedDurationMinutes: schedule.plannedDurationMinutes, organizerMembershipId: ids.membership, attendeeMembershipIds: [ids.membership] };
const exceptionPreview = contracts.recurrenceExceptionPreviewSchema.parse({ seriesId: ids.series, instanceId: ids.instance, occurrenceKey: KEY_DATE, previewHash: hash, kind: 'skip', before: resolution, after: null, beforePlannedCalendar: plannedCalendar, afterPlannedCalendar: plannedCalendar, calendarStateAfter: 'cancelled', protectedReasons: [] });
const progress = { bindingId: ids.binding, seriesId: ids.series, sourceManifestHash: manifest, state: 'pending', createdCount: 1, remainingCount: 1, blockedCode: null };
const materialization = contracts.recurrenceMaterializationResultSchema.parse({ periodId: ids.period, status: 'pending', createdCount: 1, remainingCount: 1, nextCursor: 'signed.server-token', bindings: [progress], truncated: false, frozenBaselineIds: [] });
const readinessDto = contracts.recurrenceReadinessSchema.parse({ periodId: ids.period, periodRevision: 3, state: 'pending', missingCount: 1, blockedCount: 0, bindings: [progress], truncated: false });

type Method = keyof RecurrenceApplication;
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
const recurrence: RecurrenceApplication = {
  listSeries: record('listSeries', page(series)), previewCreate: record('previewCreate', createPreview),
  createSeries: record('createSeries', series), getSeries: record('getSeries', series),
  previewEdit: record('previewEdit', editPreview), editSeries: record('editSeries', series), setState: record('setState', series),
  previewPeriods: record('previewPeriods', periodPreview), addPeriods: record('addPeriods', periodsResult),
  authorizeGeneration: record('authorizeGeneration', series), listInstances: record('listInstances', page(instance)),
  previewException: record('previewException', exceptionPreview), setException: record('setException', instance),
  materializePeriod: record('materializePeriod', materialization), getReadiness: record('getReadiness', readinessDto),
};
const repository: AccessRepository = {
  findUser: async id => DEMO_USERS.find(user => user.id === id) ?? null,
  findUsers: async userIds => DEMO_USERS.filter(user => userIds.includes(user.id)),
  listAccessibleWorkspaces: async () => [], findWorkspaceAccess: async () => null, listActiveMemberships: async () => [],
};
const readiness: ReadinessProbe = { check: async () => ({ ready: true, checks: { database: 'ok', schema: 'ok' } }) };
const config = loadConfig({ APP_ENV: 'local', AUTH_MODE: 'dev', DATABASE_URL: 'postgres://u:p@127.0.0.1:5432/unused' });

const P = `/projects/${ids.project}`;
const S = `/recurrence-series/${ids.series}`;
const I = `${S}/instances/${KEY_DATE}`;
const R = `/periods/${ids.period}`;
const createPreviewInput = { schedule, template, targetPeriodIds: [ids.period] };
const createInput = { ...createPreviewInput, previewHash: hash };
const editPreviewInput = { expectedRevision: 2, effectiveFromNominalDate: '2026-10-21', schedule, template };
const editInput = { ...editPreviewInput, previewHash: hash };
const stateInput = { expectedRevision: 2, state: 'paused' };
const periodPreviewInput = { expectedRevision: 2, periodIds: [ids.period] };
const periodsInput = { ...periodPreviewInput, previewHash: hash };
const authorizeInput = { expectedRevision: 2, expectedAuthorizationRevision: null };
const exceptionPreviewInput = { expectedSeriesRevision: 2, expectedInstanceRevision: 1, kind: 'skip', reason: 'Holiday' };
const exceptionInput = { ...exceptionPreviewInput, previewHash: hash };
interface Route {
  method: 'GET' | 'POST' | 'PATCH'; path: string; query?: string; input?: Record<string, unknown>;
  service: Method; args: unknown[]; result: unknown; status?: number; paged?: boolean; readOnly?: boolean;
}
const routes: Route[] = [
  { method: 'GET', path: `${P}/recurrence-series`, service: 'listSeries', args: [ids.project, { state: 'all', limit: 50 }], result: [series], paged: true },
  { method: 'POST', path: `${P}/recurrence-preview`, input: createPreviewInput, service: 'previewCreate', args: [ids.project, createPreviewInput], result: createPreview, readOnly: true },
  { method: 'POST', path: `${P}/recurrence-series`, input: createInput, service: 'createSeries', args: [ids.project, createInput], result: series, status: 201 },
  { method: 'GET', path: S, service: 'getSeries', args: [ids.series], result: series },
  { method: 'POST', path: `${S}/edit-preview`, input: editPreviewInput, service: 'previewEdit', args: [ids.series, editPreviewInput], result: editPreview, readOnly: true },
  { method: 'POST', path: `${S}/edit`, input: editInput, service: 'editSeries', args: [ids.series, editInput], result: series },
  { method: 'PATCH', path: `${S}/state`, input: stateInput, service: 'setState', args: [ids.series, stateInput], result: series },
  { method: 'POST', path: `${S}/period-preview`, input: periodPreviewInput, service: 'previewPeriods', args: [ids.series, periodPreviewInput], result: periodPreview, readOnly: true },
  { method: 'POST', path: `${S}/periods`, input: periodsInput, service: 'addPeriods', args: [ids.series, periodsInput], result: periodsResult },
  { method: 'POST', path: `${S}/generation-authorization`, input: authorizeInput, service: 'authorizeGeneration', args: [ids.series, authorizeInput], result: series },
  { method: 'GET', path: `${S}/instances`, query: `periodId=${ids.period}`, service: 'listInstances', args: [ids.series, { periodId: ids.period, limit: 50 }], result: [instance], paged: true },
  { method: 'POST', path: `${I}/exception-preview`, input: exceptionPreviewInput, service: 'previewException', args: [ids.series, KEY_DATE, exceptionPreviewInput], result: exceptionPreview, readOnly: true },
  { method: 'POST', path: `${I}/exception`, input: exceptionInput, service: 'setException', args: [ids.series, KEY_DATE, exceptionInput], result: instance },
  { method: 'POST', path: `${R}/materialize-meetings`, input: {}, service: 'materializePeriod', args: [ids.period, { limit: 100 }], result: materialization },
  { method: 'GET', path: `${R}/recurrence-readiness`, service: 'getReadiness', args: [ids.period], result: readinessDto },
];
const commands = routes.filter(route => route.method !== 'GET');
const mutations = commands.filter(route => !route.readOnly);
const templateRoutes = commands.filter(route => ['previewCreate', 'createSeries', 'previewEdit', 'editSeries'].includes(route.service));
const smallCommands = commands.filter(route => !templateRoutes.includes(route));
let app: FastifyInstance;
function url(route: Route) { return `${BASE}${route.path}${route.query ? `?${route.query}` : ''}`; }
function headers() { return { host: HOST, origin: ORIGIN, 'idempotency-key': KEY }; }
function escapeUnicode(json: string) { return json.replace(/[^ -~]/g, char => String.fromCharCode(92) + 'u' + char.charCodeAt(0).toString(16).padStart(4, '0')); }
const uuid = (i: number) => `5eed0000-0000-4000-8000-${String(i).padStart(12, '0')}`;
beforeAll(async () => { app = await createApp(config, { accessRepository: repository, readiness, recurrenceApplication: recurrence, logger: false, webDistDir: null }); });
afterAll(async () => { await app.close(); });
beforeEach(() => { calls.length = 0; overrides.clear(); });

describe('P3b recurrence HTTP adapter', () => {
  it('covers each of the fifteen RecurrenceApplication methods with exactly one route', () => {
    expect(new Set(routes.map(route => route.service))).toEqual(new Set(Object.keys(recurrence)));
    expect(routes).toHaveLength(15);
  });

  it.each(routes)('$method $path uses parsed input, trusted actor and exact response', async route => {
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
      workspaceId: W, source: 'web', requestId: body.meta.requestId,
      ...(route.method === 'GET' || route.readOnly ? {} : { idempotencyKey: KEY }),
    } }]);
  });

  it('forwards coherent before/after planned calendar context on reset without adding it to the command input', async () => {
    const member = '5eed0000-0000-4000-8000-000000000302';
    const afterPlannedCalendar = { timezone: 'UTC', plannedDurationMinutes: 90, organizerMembershipId: member, attendeeMembershipIds: [ids.membership, member] };
    const after = { ...resolution, plannedDurationMinutes: 90, resolvedStartAt: '2026-10-19T10:00:00.000Z', resolvedEndAt: '2026-10-19T11:30:00.000Z', resolvedOffset: '+00:00', provenance: { ...provenance, timezone: 'UTC' } };
    const result = { ...exceptionPreview, kind: 'reset', after, calendarStateAfter: 'scheduled', beforePlannedCalendar: plannedCalendar, afterPlannedCalendar };
    overrides.set('previewException', () => result);
    const input = { expectedSeriesRevision: 2, expectedInstanceRevision: 1, kind: 'reset', reason: 'Restore effective planned calendar' };
    const response = await app.inject({ method: 'POST', url: `${BASE}${I}/exception-preview`, headers: { host: HOST, origin: ORIGIN }, payload: input });
    expect(response.statusCode).toBe(200);
    const body = contracts.recurrenceExceptionPreviewResponseSchema.parse(response.json());
    expect(body.data.beforePlannedCalendar).toEqual(plannedCalendar);
    expect(body.data.afterPlannedCalendar).toEqual(afterPlannedCalendar);
    expect(calls[0]?.args).toEqual([ids.series, KEY_DATE, input]);
    expect(calls[0]?.ctx).not.toHaveProperty('idempotencyKey');
  });

  it.each(routes)('$method $path canonicalizes target and body/query UUIDs', async route => {
    const upper = (s: string) => s.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, id => id.toUpperCase());
    const response = await app.inject({ method: route.method, url: upper(url(route)), headers: headers(), ...(route.input ? { payload: JSON.parse(upper(JSON.stringify(route.input))) } : {}) });
    expect(response.statusCode).toBe(route.status ?? 200);
    expect(calls[0]?.args).toEqual(route.args);
    expect(calls[0]?.ctx.workspaceId).toBe(W);
  });

  it.each(mutations)('$method $path requires a valid command key', async route => {
    for (const key of [undefined, '', 'has space', 'x'.repeat(129)]) {
      const response = await app.inject({ method: route.method, url: url(route), headers: { host: HOST, origin: ORIGIN, ...(key === undefined ? {} : { 'idempotency-key': key }) }, ...(route.input ? { payload: route.input } : {}) });
      expect(response.statusCode).toBe(400);
    }
    expect(calls).toHaveLength(0);
  });

  it.each(commands.filter(route => route.readOnly))('$path is a keyless read that still sends no key to the domain', async route => {
    const response = await app.inject({ method: route.method, url: url(route), headers: { host: HOST, origin: ORIGIN }, ...(route.input ? { payload: route.input } : {}) });
    expect(response.statusCode).toBe(200);
    expect(response.json().data.previewHash).toBe(hash);
    expect(calls[0]?.ctx).not.toHaveProperty('idempotencyKey');
  });

  it.each(commands)('$method $path rejects spoofed/server-owned body fields and write query parameters', async route => {
    for (const property of ['actor', 'actorUserId', 'workspaceId', 'source', 'requestId', 'idempotencyKey', 'authorizerMembershipId', 'jobCapability']) {
      expect((await app.inject({ method: route.method, url: url(route), headers: headers(), payload: { ...route.input, [property]: 'spoofed' } })).statusCode).toBe(400);
    }
    expect((await app.inject({ method: route.method, url: `${url(route)}?actorId=${ids.membership}`, headers: headers(), ...(route.input ? { payload: route.input } : {}) })).statusCode).toBe(400);
    expect(calls).toHaveLength(0);
  });

  it.each(commands)('$method $path requires a trusted Origin including keyless previews', async route => {
    for (const origin of [undefined, 'https://foreign.example']) {
      expect((await app.inject({ method: route.method, url: url(route), headers: { host: HOST, 'idempotency-key': KEY, ...(origin ? { origin } : {}) }, ...(route.input ? { payload: route.input } : {}) })).statusCode).toBe(403);
    }
    expect(calls).toHaveLength(0);
  });

  it('keeps preview and apply bodies separate and rejects raw continuation keys', async () => {
    const cases: [string, Record<string, unknown>][] = [
      [`${P}/recurrence-preview`, createInput], [`${S}/edit-preview`, editInput], [`${S}/period-preview`, periodsInput], [`${I}/exception-preview`, exceptionInput],
      [`${P}/recurrence-series`, createPreviewInput], [`${S}/edit`, editPreviewInput], [`${S}/periods`, periodPreviewInput], [`${I}/exception`, exceptionPreviewInput],
      [`${S}/periods`, { ...periodsInput, periodIds: [ids.period, ids.period.toUpperCase()] }],
      [`${I}/exception`, { ...exceptionInput, kind: 'move' }],
      [`${R}/materialize-meetings`, { afterKey: KEY_DATE }], [`${R}/materialize-meetings`, { limit: 0 }], [`${R}/materialize-meetings`, { limit: 101 }], [`${R}/materialize-meetings`, { cursor: '' }],
    ];
    for (const [path, payload] of cases) expect((await app.inject({ method: 'POST', url: BASE + path, headers: headers(), payload })).statusCode, path).toBe(400);
    expect((await app.inject({ method: 'POST', url: `${BASE}${R}/materialize-meetings`, headers: headers() })).statusCode).toBe(400);
    expect(calls).toHaveLength(0);
  });

  it('forwards an opaque signed materialization cursor and bounded limit unchanged', async () => {
    const input = { limit: 25, cursor: 'signed.server-token+/=' };
    expect((await app.inject({ method: 'POST', url: `${BASE}${R}/materialize-meetings`, headers: headers(), payload: input })).statusCode).toBe(200);
    expect(calls[0]?.args).toEqual([ids.period, input]);
  });

  it('uses a calendar-date occurrence key and canonical UUIDs for every other path ID', async () => {
    const paths = [`${S}/instances/${ids.instance}/exception-preview`, `${S}/instances/2026-13-01/exception-preview`, `${S}/instances/20261019/exception-preview`, `/recurrence-series/${KEY_DATE}/instances/${KEY_DATE}/exception-preview`, `/recurrence-series/invalid/period-preview`, `/projects/invalid/recurrence-preview`];
    for (const path of paths) expect((await app.inject({ method: 'POST', url: BASE + path, headers: headers(), payload: exceptionPreviewInput })).statusCode, path).toBe(400);
    for (const path of ['/recurrence-series/invalid', `/periods/${KEY_DATE}/recurrence-readiness`, `/projects/invalid/recurrence-series`]) expect((await app.inject({ url: BASE + path, headers: headers() })).statusCode, path).toBe(400);
    expect(calls).toHaveLength(0);
  });

  it('bounds recurrence dates to valid 2000-01-01..2100-12-31 in path and body before the service', async () => {
    for (const key of ['2000-01-01', '2100-12-31']) {
      expect((await app.inject({ method: 'POST', url: `${BASE}${S}/instances/${key}/exception-preview`, headers: headers(), payload: exceptionPreviewInput })).statusCode, key).toBe(200);
      expect(calls.at(-1)?.args).toEqual([ids.series, key, exceptionPreviewInput]);
    }
    calls.length = 0;
    for (const key of ['1999-12-31', '2101-01-01', '2026-02-29', '2100-02-29', '2026-04-31', '2026-1-01']) {
      for (const path of [`${S}/instances/${key}/exception-preview`, `${S}/instances/${key}/exception`]) {
        expect((await app.inject({ method: 'POST', url: BASE + path, headers: headers(), payload: path.endsWith('preview') ? exceptionPreviewInput : exceptionInput })).statusCode, path).toBe(400);
      }
    }
    const bodies: [string, Record<string, unknown>][] = [
      [`${S}/edit-preview`, { ...editPreviewInput, effectiveFromNominalDate: '1999-12-31' }],
      [`${S}/edit`, { ...editInput, effectiveFromNominalDate: '2101-01-01' }],
      [`${P}/recurrence-preview`, { ...createPreviewInput, schedule: { ...schedule, startDate: '2026-02-29' } }],
      [`${I}/exception`, { ...exceptionInput, kind: 'move', localDate: '2101-01-01', localTime: '10:00' }],
    ];
    for (const [path, payload] of bodies) expect((await app.inject({ method: 'POST', url: BASE + path, headers: headers(), payload })).statusCode, path).toBe(400);
    expect((await app.inject({ url: `${BASE}${S}/instances?periodId=${ids.period}&periodId=${ids.period}&includeCancelled=false`, headers: headers() })).statusCode).toBe(400);
    expect(calls).toHaveLength(0);
  });

  it('parses includeCancelled as strict true/false and keeps explicit false', async () => {
    for (const [value, parsed] of [['true', true], ['false', false]] as const) {
      expect((await app.inject({ url: `${BASE}${S}/instances?periodId=${ids.period}&includeCancelled=${value}`, headers: headers() })).statusCode).toBe(200);
      expect(calls.at(-1)?.args).toEqual([ids.series, { periodId: ids.period, includeCancelled: parsed, limit: 50 }]);
    }
    expect((await app.inject({ url: `${BASE}${P}/recurrence-series?state=paused`, headers: headers() })).statusCode).toBe(200);
    expect(calls.at(-1)?.args).toEqual([ids.project, { state: 'paused', limit: 50 }]);
  });

  it('rejects missing, repeated, malformed and unknown read query parameters', async () => {
    const instances = `${S}/instances`;
    const paths = [
      instances, `${instances}?periodId=${ids.period}&periodId=${ids.period}`, `${instances}?periodId=invalid`,
      ...['1', '0', 'yes', 'TRUE', ''].map(v => `${instances}?periodId=${ids.period}&includeCancelled=${v}`),
      `${instances}?periodId=${ids.period}&includeCancelled=true&includeCancelled=true`,
      `${instances}?periodId=${ids.period}&limit=0`, `${instances}?periodId=${ids.period}&limit=101`, `${instances}?periodId=${ids.period}&limit=5&limit=6`,
      `${instances}?periodId=${ids.period}&cursor=`, `${instances}?periodId=${ids.period}&cursor=${'x'.repeat(4097)}`, `${instances}?periodId=${ids.period}&actorId=${ids.membership}`,
      `${P}/recurrence-series?state=other`, `${P}/recurrence-series?state=active&state=active`, `${S}?periodId=${ids.period}`, `${R}/recurrence-readiness?limit=10`,
    ];
    for (const path of paths) expect((await app.inject({ url: BASE + path, headers: headers() })).statusCode, path).toBe(400);
    expect(calls).toHaveLength(0);
  });

  it.each(routes.filter(route => route.paged))('$path preserves cursors and terminal pages', async route => {
    expect((await app.inject({ url: `${url(route)}${route.query ? '&' : '?'}limit=100&cursor=${encodeURIComponent(CURSOR)}`, headers: headers() })).statusCode).toBe(200);
    expect(calls[0]?.args.at(-1)).toEqual({ ...(route.args.at(-1) as object), limit: 100, cursor: CURSOR });
    overrides.set(route.service, () => ({ items: [], nextCursor: null }));
    expect((await app.inject({ url: url(route), headers: headers() })).json()).toMatchObject({ data: [], meta: { nextCursor: null } });
  });

  it.each(templateRoutes)('$path accepts a valid escaped-Unicode template beyond the global16KiB cap', async route => {
    const big = { ...template, title: '界'.repeat(500), joinUrl: 'https://example.test/' + '界'.repeat(2000), attendeeMembershipIds: Array.from({ length: 100 }, (_, i) => uuid(i)) };
    const input = { ...route.input, template: big, ...('targetPeriodIds' in (route.input ?? {}) ? { targetPeriodIds: Array.from({ length: 52 }, (_, i) => uuid(1000 + i)) } : {}) };
    const escaped = escapeUnicode(JSON.stringify(input));
    expect(Buffer.byteLength(escaped)).toBeGreaterThan(16 * 1024);
    expect(Buffer.byteLength(escaped)).toBeLessThan(64 * 1024);
    const response = await app.inject({ method: route.method, url: url(route), headers: { ...headers(), 'content-type': 'application/json' }, payload: escaped });
    expect(response.statusCode).toBe(route.status ?? 200);
    expect(calls[0]?.args.at(-1)).toEqual(input);
  });

  it('keeps 64KiB template caps, the global16KiB cap for small commands and unchanged older routes', async () => {
    for (const route of templateRoutes) {
      const response = await app.inject({ method: route.method, url: url(route), headers: headers(), payload: { oversized: 'x'.repeat(65 * 1024) } });
      expect(response.statusCode, route.path).toBe(413);
      expect(response.json().error.code).toBe('PAYLOAD_TOO_LARGE');
    }
    for (const route of smallCommands) expect((await app.inject({ method: route.method, url: url(route), headers: headers(), payload: { oversized: 'x'.repeat(17 * 1024) } })).statusCode, route.path).toBe(413);
    expect(app.initialConfig.bodyLimit).toBe(16 * 1024);
    expect((await app.inject({ method: 'POST', url: '/api/v1/dev/session', headers: { ...headers(), 'x-workloom-dev-tool': '1' }, payload: { oversized: 'x'.repeat(17 * 1024) } })).statusCode).toBe(413);
    expect(calls).toHaveLength(0);
  });

  it.each(routes.filter(route => route.method === 'GET' || route.readOnly))('$method $path forwards foreign/invisible not-found without data', async route => {
    overrides.set(route.service, () => { throw new DomainError('NOT_FOUND', NOT_FOUND_MESSAGE); });
    const response = await app.inject({ method: route.method, url: url(route), headers: headers(), ...(route.input ? { payload: route.input } : {}) });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ error: { code: 'NOT_FOUND', message: NOT_FOUND_MESSAGE } });
    expect(response.json()).not.toHaveProperty('data');
    expect(calls).toHaveLength(1);
  });

  it.each([
    ['REVISION_CONFLICT', 409], ['PREVIEW_STALE', 409], ['IDEMPOTENCY_KEY_REUSED', 409], ['OPERATION_IN_PROGRESS', 409],
    ['CAPABILITY_REQUIRED', 403], ['NOT_FOUND', 404], ['DOMAIN_VALIDATION_FAILED', 422],
  ] as const)('forwards %s from a keyed mutation once without data', async (code, status) => {
    overrides.set('addPeriods', () => { throw new DomainError(code, 'Safe recurrence rejection'); });
    const response = await app.inject({ method: 'POST', url: `${BASE}${S}/periods`, headers: headers(), payload: periodsInput });
    expect(response.statusCode).toBe(status);
    expect(response.json().error.code).toBe(code);
    expect(response.json()).not.toHaveProperty('data');
    expect(calls).toHaveLength(1);
  });

  it('maps MATERIALIZATION_REQUIRED to a controlled 409 with only domain-provided details', async () => {
    const details = { periodIds: [ids.period], action: 'materialize' };
    const error = new DomainError(contracts.MATERIALIZATION_REQUIRED,'Materialize the period census first.', { details, cause: new Error('select secret') });
    overrides.set('setState', () => { throw error; });
    const response = await app.inject({ method: 'PATCH', url: `${BASE}${S}/state`, headers: headers(), payload: stateInput });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({ error: { code: contracts.MATERIALIZATION_REQUIRED, message: 'Materialize the period census first.', details, retryable: error.retryable }, meta: { requestId: response.headers['x-request-id'] } });
    expect(response.body).not.toContain('secret');
    expect(calls).toHaveLength(1);
  });

  it('passes the same key on replay so current access is rechecked by the domain, never cached by HTTP', async () => {
    expect((await app.inject({ method: 'POST', url: `${BASE}${P}/recurrence-series`, headers: headers(), payload: createInput })).statusCode).toBe(201);
    overrides.set('createSeries', () => { throw new DomainError('CAPABILITY_REQUIRED', 'This operation is not permitted for the current member.'); });
    const replay = await app.inject({ method: 'POST', url: `${BASE}${P}/recurrence-series`, headers: headers(), payload: createInput });
    expect(replay.statusCode).toBe(403);
    expect(replay.json()).not.toHaveProperty('data');
    expect(calls.map(call => [call.args, call.ctx.idempotencyKey])).toEqual([[[ids.project, createInput], KEY], [[ids.project, createInput], KEY]]);
    expect(calls[0]?.ctx.requestId).not.toBe(calls[1]?.ctx.requestId);
  });

  it('rejects contract-violating service output and redacts unexpected errors', async () => {
    overrides.set('addPeriods', () => series);
    expect((await app.inject({ method: 'POST', url: `${BASE}${S}/periods`, headers: headers(), payload: periodsInput })).statusCode).toBe(500);
    overrides.set('setException', () => ({ ...instance, meetingId: ids.meeting }));
    expect((await app.inject({ method: 'POST', url: `${BASE}${I}/exception`, headers: headers(), payload: exceptionInput })).statusCode).toBe(500);
    overrides.set('getSeries', () => { throw new Error('SQL password=never-return'); });
    const failed = await app.inject({ url: `${BASE}${S}`, headers: headers() });
    expect(failed.statusCode).toBe(500);
    expect(failed.body).not.toContain('never-return');
  });

  it('does not register recurrence routes in apps without the service and keeps JSON not-found', async () => {
    const older = await createApp(config, { accessRepository: repository, readiness, logger: false, webDistDir: null });
    try {
      const response = await older.inject({ url: `${BASE}${S}`, headers: headers() });
      expect(response.statusCode).toBe(404);
      expect(response.headers['content-type']).toContain('application/json');
      expect(response.json().error.code).toBe('NOT_FOUND');
    } finally { await older.close(); }
  });
});
