import * as c from '@workloom/contracts';
import { DEMO_USERS, FIXTURE_USER_IDS, FIXTURE_WORKSPACE_IDS, type ReadinessProbe } from '@workloom/db';
import { DomainError, NOT_FOUND_MESSAGE, type AccessRepository, type CommandContext, type ProjectImportApplication } from '@workloom/domain';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../app.js';
import { loadConfig } from '../config.js';

// Recording application verifies transport only. Real PostgreSQL acceptance owns parser, imports.manage,
// UTF8 byte bound, owned revisions, stable mapping and all-or-nothing creation/history/provenance.
const HOST = '127.0.0.1:4310', ORIGIN = `http://${HOST}`, KEY = 'synthetic-import-key';
const W = FIXTURE_WORKSPACE_IDS.team, PROJECT = '5eed0000-0000-4000-8000-000000000401';
const IMPORT = '5eed0000-0000-4000-8000-000000000701', STATUS = '5eed0000-0000-4000-8000-000000000403';
const TASK = '5eed0000-0000-4000-8000-000000000405', FIELD = '5eed0000-0000-4000-8000-000000000702';
const BASE = `/api/v1/workspaces/${W}/projects/${PROJECT}/imports`, HASH = 'a'.repeat(64), TS = '2026-10-16T05:34:00.000Z';
const stageInput = { fileName: 'synthetic.csv', sourceNamespace: 'asana:synthetic-project', csvText: '\ufeffID,Name\r\n900719925474099312345,Task\r\n' };
const mapping = c.projectImportMappingSchema.parse({ externalIdColumn: 0, titleColumn: 1, defaultStatusId: STATUS, dateFormat: 'iso', shareableScopeConfirmed: true, people: [], statuses: [], sections: [], tags: [], customFields: [], preserveColumns: [] });
const previewInput = { expectedImportRevision: 1, mapping }, applyInput = { ...previewInput, previewHash: HASH };
const artifact = c.projectImportSchema.parse({ id: IMPORT, workspaceId: W, projectId: PROJECT, sourceNamespace: stageInput.sourceNamespace, fileName: stageInput.fileName, fileDigest: HASH, revision: 1, status: 'staged', headers: ['ID', 'Name'], sourceRows: [{ rowNumber: 1, cells: ['900719925474099312345', 'Task'] }], createdAt: TS, appliedAt: null });
const preview = c.projectImportPreviewSchema.parse({ importId: IMPORT, projectId: PROJECT, importRevision: 1, sourceDigest: HASH, previewHash: HASH, rows: [{ rowNumber: 1, externalId: '900719925474099312345', targetTaskId: null, action: 'create', title: 'Task', parentExternalId: null, customValues: [] }], issues: [], summary: { sourceRows: 1, createCount: 1, skipCount: 0, conflictCount: 0, blockedCount: 0, preservedColumnCount: 0 }, recoveryPeriodIds: [] });
const stagedReconciliation = c.projectImportReconciliationSchema.parse({ status: 'staged', importId: IMPORT, projectId: PROJECT, sourceRows: 1, createdCount: 0, skippedCount: 0, rows: [], appliedAt: null });
const reconciliation = c.projectImportReconciliationSchema.parse({ status: 'applied', importId: IMPORT, projectId: PROJECT, sourceRows: 1, createdCount: 1, skippedCount: 0, rows: [{ rowNumber: 1, externalId: '900719925474099312345', targetTaskId: TASK, state: 'created', ownedRevisions: { taskRevision: 1, participantsRevision: 1, workPackageRevision: 1, fields: [] } }], appliedAt: TS, sourceDigest: HASH, mappingHash: HASH, mapping });
const applied = c.projectImportAppliedSchema.parse({ import: { ...artifact, status: 'applied', revision: 2, appliedAt: TS }, reconciliation, tasks: [], asOfChangeSeq: '9007199254740993' });
type Method = keyof ProjectImportApplication;
const calls: { method: Method; ctx: CommandContext; args: unknown[] }[] = [];
const overrides = new Map<Method, () => unknown>();
function record<R>(method: Method, result: R) { return async (ctx: CommandContext, ...args: unknown[]): Promise<R> => { calls.push({ method, ctx, args }); return overrides.has(method) ? overrides.get(method)?.() as R : result; }; }
const application: ProjectImportApplication = { stageCsv: record('stageCsv', artifact), getImport: record('getImport', artifact), previewImport: record('previewImport', preview), applyImport: record('applyImport', applied), getReconciliation: record('getReconciliation', stagedReconciliation) };
const repository: AccessRepository = { findUser: async id => DEMO_USERS.find(user => user.id === id) ?? null, findUsers: async ids => DEMO_USERS.filter(user => ids.includes(user.id)), listAccessibleWorkspaces: async () => [], findWorkspaceAccess: async () => null, listActiveMemberships: async () => [] };
const readiness: ReadinessProbe = { check: async () => ({ ready: true, checks: { database: 'ok', schema: 'ok' } }) };
const config = loadConfig({ APP_ENV: 'local', AUTH_MODE: 'dev', DATABASE_URL: 'postgres://u:p@127.0.0.1:5432/unused' });
interface Route { method: 'GET' | 'POST'; path: string; service: Method; input?: object; args: unknown[]; result: unknown; keyed: boolean; status?: number }
const routes: Route[] = [
  { method: 'POST', path: '', service: 'stageCsv', input: stageInput, args: [PROJECT, stageInput], result: artifact, keyed: true, status: 201 },
  { method: 'GET', path: `/${IMPORT}`, service: 'getImport', args: [PROJECT, IMPORT], result: artifact, keyed: false },
  { method: 'POST', path: `/${IMPORT}/preview`, service: 'previewImport', input: previewInput, args: [PROJECT, IMPORT, previewInput], result: preview, keyed: false },
  { method: 'POST', path: `/${IMPORT}/apply`, service: 'applyImport', input: applyInput, args: [PROJECT, IMPORT, applyInput], result: applied, keyed: true },
  { method: 'GET', path: `/${IMPORT}/reconciliation`, service: 'getReconciliation', args: [PROJECT, IMPORT], result: stagedReconciliation, keyed: false },
];
const headers = () => ({ host: HOST, origin: ORIGIN, 'idempotency-key': KEY });
const uuid = (n: number) => `5eed0000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const escapedJson = (value: unknown) => JSON.stringify(value).replace(/"(?:[^"\\]|\\.)*"/g, token => '"' + [...JSON.parse(token) as string].map(char => '\\u' + char.charCodeAt(0).toString(16).padStart(4, '0')).join('') + '"');
let app: FastifyInstance;
beforeAll(async () => { app = await createApp(config, { accessRepository: repository, readiness, projectImportApplication: application, logger: false, webDistDir: null }); });
afterAll(async () => { await app.close(); });
beforeEach(() => { calls.length = 0; overrides.clear(); });

describe('P5a bounded CSV import HTTP adapter', () => {
  it('covers exactly five shared application methods', () => { expect(routes).toHaveLength(5); expect(new Set(routes.map(route => route.service))).toEqual(new Set(Object.keys(application))); });
  it.each(routes)('$method $path forwards exact normalized input and trusted actor/request context', async route => {
    const response = await app.inject({ method: route.method, url: BASE + route.path, headers: { ...headers(), 'x-actor-id': FIXTURE_USER_IDS.outsider, 'x-request-id': 'spoofed' }, ...(route.input ? { payload: route.input } : {}) });
    expect(response.statusCode).toBe(route.status ?? 200);
    expect(response.json()).toEqual({ data: route.result, meta: { requestId: response.headers['x-request-id'] } });
    expect(response.json().meta.requestId).not.toBe('spoofed');
    expect(calls).toEqual([{ method: route.service, args: route.args, ctx: { actor: { userId: FIXTURE_USER_IDS.owner, displayName: DEMO_USERS.find(user => user.id === FIXTURE_USER_IDS.owner)?.displayName, kind: 'fixture' }, workspaceId: W, source: 'web', requestId: response.json().meta.requestId, ...(route.keyed ? { idempotencyKey: KEY } : {}) } }]);
  });
  it.each(routes)('$method $path canonicalizes path UUIDs but preserves source string IDs and raw BOM/CRLF', async route => {
    const upperIds = (text: string) => text.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, id => id.toUpperCase());
    expect((await app.inject({ method: route.method, url: upperIds(BASE + route.path), headers: headers(), ...(route.input ? { payload: JSON.parse(upperIds(JSON.stringify(route.input))) } : {}) })).statusCode).toBe(route.status ?? 200);
    expect(calls[0]?.args).toEqual(route.args);
  });
  it.each(routes.filter(route => route.keyed))('$path requires a key without calling domain', async route => {
    for (const key of [undefined, '', 'has space', 'x'.repeat(129)]) expect((await app.inject({ method: 'POST', url: BASE + route.path, headers: { host: HOST, origin: ORIGIN, ...(key === undefined ? {} : { 'idempotency-key': key }) }, ...(route.input ? { payload: route.input } : {}) })).statusCode).toBe(400);
    expect(calls).toHaveLength(0);
  });
  it('keeps preview keyless and never forwards a supplied header as write authority', async () => {
    for (const key of [undefined, KEY]) expect((await app.inject({ method: 'POST', url: `${BASE}/${IMPORT}/preview`, headers: { host: HOST, origin: ORIGIN, ...(key ? { 'idempotency-key': key } : {}) }, payload: previewInput })).statusCode).toBe(200);
    expect(calls.every(call => call.ctx.idempotencyKey === undefined)).toBe(true);
  });
  it.each(routes)('$method $path rejects client scope/query injection', async route => {
    expect((await app.inject({ method: route.method, url: `${BASE}${route.path}?source=import&actorId=spoofed`, headers: headers(), ...(route.input ? { payload: route.input } : {}) })).statusCode).toBe(400);
    if (route.input) expect((await app.inject({ method: route.method, url: BASE + route.path, headers: headers(), payload: { ...route.input, source: 'import', actorId: FIXTURE_USER_IDS.outsider } })).statusCode).toBe(400);
    expect(calls).toHaveLength(0);
  });
  it.each(routes.filter(route => route.method === 'POST'))('$path retains Origin and Host guards', async route => {
    for (const origin of [undefined, 'https://untrusted.invalid']) expect((await app.inject({ method: 'POST', url: BASE + route.path, headers: { host: HOST, 'idempotency-key': KEY, ...(origin ? { origin } : {}) }, ...(route.input ? { payload: route.input } : {}) })).statusCode).toBe(403);
    expect((await app.inject({ method: 'POST', url: BASE + route.path, headers: { ...headers(), host: 'untrusted.invalid' }, ...(route.input ? { payload: route.input } : {}) })).statusCode).toBe(421);
    expect(calls).toHaveLength(0);
  });
  it.each(['fileName', 'sourceNamespace', 'csvText'] as const)('rejects unsafe raw %s without silent repair', async field => {
    for (const value of ['NUL\u0000value', '\ud800', '\udfff']) expect((await app.inject({ method: 'POST', url: BASE, headers: headers(), payload: { ...stageInput, [field]: value } })).statusCode).toBe(400);
    expect(calls).toHaveLength(0);
  });
  it('accepts a legal near1MiB CSV after worst JSON escaping under stage-only8MiB', async () => {
    const csvText = '\ufeffID,Name,Notes\r\n' + Array.from({ length: 50 }, (_, i) => `${90071992547409930000n + BigInt(i)},Task${i},${'x'.repeat(19000)}`).join('\r\n');
    const input = { ...stageInput, csvText }, wire = escapedJson(input);
    expect(Buffer.byteLength(csvText, 'utf8')).toBeLessThanOrEqual(c.IMPORT_LIMITS.maxCsvBytes);
    expect(Buffer.byteLength(wire)).toBeGreaterThan(256 * 1024);
    expect(Buffer.byteLength(wire)).toBeLessThan(8 * 1024 * 1024);
    expect((await app.inject({ method: 'POST', url: BASE, headers: { ...headers(), 'content-type': 'application/json' }, payload: wire })).statusCode).toBe(201);
    expect(calls[0]?.args).toEqual([PROJECT, input]);
    calls.length = 0;
    expect((await app.inject({ method: 'POST', url: BASE, headers: headers(), payload: { oversized: 'x'.repeat(8 * 1024 * 1024) } })).statusCode).toBe(413);
    expect(calls).toHaveLength(0);
  });
  it.each(['preview', 'apply'])('proves worst fully escaped legal100-reference/20-field mapping fits only scoped256KiB %s', async name => {
    const value = (i: number) => String(i).padStart(3, '0') + 'x'.repeat(251);
    const large = c.projectImportMappingSchema.parse({ ...mapping, descriptionColumn: 2, startDateColumn: 3, dueDateColumn: 4, parentExternalIdColumn: 5, responsibleColumn: 6, participantsColumn: 7, statusColumn: 8, sectionColumn: 9, tagsColumn: 10, privateColumn: 11, participantsDelimiter: ';', tagsDelimiter: '|', assigneeIsParticipant: true,
      // membershipId is the longest reference key: all100 entries here maximize escaped mapping size.
      people: Array.from({ length: 100 }, (_, i) => ({ sourceValue: value(i), membershipId: uuid(1000 + i) })), statuses: [], sections: [], tags: [],
      customFields: Array.from({ length: 20 }, (_, i) => ({ column: i + 12, fieldId: uuid(5000 + i), expectedDefinitionRevision: 2147483647, empty: 'missing', sourceMeaning: 'current_estimate', sourceUnit: 'minutes' })), preserveColumns: Array.from({ length: 68 }, (_, i) => i + 32) });
    const input = { expectedImportRevision: 2147483647, mapping: large, ...(name === 'apply' ? { previewHash: HASH } : {}) }, wire = escapedJson(input);
    expect(Buffer.byteLength(wire)).toBeGreaterThan(128 * 1024);
    expect(Buffer.byteLength(wire)).toBeLessThan(256 * 1024);
    expect((await app.inject({ method: 'POST', url: `${BASE}/${IMPORT}/${name}`, headers: { ...headers(), 'content-type': 'application/json' }, payload: wire })).statusCode).toBe(200);
    expect(calls[0]?.args).toEqual([PROJECT, IMPORT, input]);
    calls.length = 0;
    expect((await app.inject({ method: 'POST', url: `${BASE}/${IMPORT}/${name}`, headers: headers(), payload: { oversized: 'x'.repeat(257 * 1024) } })).statusCode).toBe(413);
    expect(calls).toHaveLength(0);
  });
  it('retains unrelated global16KiB while new caps stay local', async () => {
    expect(app.initialConfig.bodyLimit).toBe(16 * 1024);
    expect((await app.inject({ method: 'POST', url: '/api/v1/dev/session', headers: { ...headers(), 'x-workloom-dev-tool': '1' }, payload: { oversized: 'x'.repeat(17 * 1024) } })).statusCode).toBe(413);
  });
  it.each([
    { ...mapping, people: Array.from({ length: 101 }, (_, i) => ({ sourceValue: String(i), membershipId: uuid(1000 + i) })) },
    { ...mapping, people: [{ sourceValue: 'x'.repeat(255), membershipId: TASK }] },
    { ...mapping, people: [{ sourceValue: 'same', membershipId: TASK }, { sourceValue: 'same', membershipId: FIELD }] },
    { ...mapping, customFields: Array.from({ length: 21 }, (_, i) => ({ column: i, fieldId: uuid(5000 + i), expectedDefinitionRevision: 1, empty: 'null', sourceMeaning: 'ordinary' })) },
    { ...mapping, participantsColumn: 2 }, { ...mapping, tagsColumn: 2 }, { ...mapping, externalIdColumn: 100 },
    { ...mapping, preserveColumns: [1, 1] }, { ...mapping, jsonFormat: true },
  ])('rejects invalid strict mapping %# before the shared port', async bad => {
    expect((await app.inject({ method: 'POST', url: `${BASE}/${IMPORT}/preview`, headers: headers(), payload: { ...previewInput, mapping: bad } })).statusCode).toBe(400);
    expect(calls).toHaveLength(0);
  });
  it('returns both reconciliation branches and full stored mapping/source units without inventing accounting', async () => {
    const sourceMapping = c.projectImportMappingSchema.parse({ ...mapping, customFields: [{ column: 2, fieldId: FIELD, expectedDefinitionRevision: 1, empty: 'missing', sourceMeaning: 'current_actual', sourceUnit: 'hours' }] });
    overrides.set('getReconciliation', () => ({ ...reconciliation, mapping: sourceMapping }));
    const response = await app.inject({ url: `${BASE}/${IMPORT}/reconciliation`, headers: headers() });
    expect(response.statusCode).toBe(200);
    expect(response.json().data.mapping.customFields).toEqual(sourceMapping.customFields);
    expect(response.json().data.rows[0].ownedRevisions).toEqual(reconciliation.status === 'applied' ? reconciliation.rows[0]?.ownedRevisions : null);
  });
  it.each(routes)('$method $path forwards privilege/foreign denial without exposing source rows', async route => {
    overrides.set(route.service, () => { throw new DomainError('NOT_FOUND', NOT_FOUND_MESSAGE); });
    const response = await app.inject({ method: route.method, url: BASE + route.path, headers: headers(), ...(route.input ? { payload: route.input } : {}) });
    expect(response.statusCode).toBe(404); expect(response.json()).not.toHaveProperty('data'); expect(response.json().error.message).toBe(NOT_FOUND_MESSAGE);
  });
  it.each([['CAPABILITY_REQUIRED', 403], ['PREVIEW_STALE', 409], ['REVISION_CONFLICT', 409], ['IDEMPOTENCY_KEY_REUSED', 409], ['MATERIALIZATION_REQUIRED', 409], ['DOMAIN_VALIDATION_FAILED', 422]] as const)('maps %s and does not retry apply', async (code, status) => {
    overrides.set('applyImport', () => { throw new DomainError(code, 'Safe import rejection'); });
    const response = await app.inject({ method: 'POST', url: `${BASE}/${IMPORT}/apply`, headers: headers(), payload: applyInput });
    expect(response.statusCode).toBe(status); expect(response.json().error.code).toBe(code); expect(response.json()).not.toHaveProperty('data'); expect(calls).toHaveLength(1);
  });
  it('redacts unexpected parser/SQL failures and rejects malformed source responses', async () => {
    overrides.set('stageCsv', () => { throw new Error('synthetic-hidden-canary SQL/raw source'); });
    const response = await app.inject({ method: 'POST', url: BASE, headers: headers(), payload: stageInput });
    expect(response.statusCode).toBe(500); expect(response.body).not.toContain('canary');
    overrides.set('getImport', () => ({ rawSource: 'synthetic-hidden-canary' }));
    const malformed = await app.inject({ url: `${BASE}/${IMPORT}`, headers: headers() });
    expect(malformed.statusCode).toBe(500); expect(malformed.body).not.toContain('canary');
  });
  it('preserves original apply revision/mapping/hash/key on explicit retry', async () => {
    for (let i = 0; i < 2; i++) expect((await app.inject({ method: 'POST', url: `${BASE}/${IMPORT}/apply`, headers: headers(), payload: applyInput })).statusCode).toBe(200);
    expect(calls.map(call => ({ args: call.args, key: call.ctx.idempotencyKey }))).toEqual([{ args: [PROJECT, IMPORT, applyInput], key: KEY }, { args: [PROJECT, IMPORT, applyInput], key: KEY }]);
  });
});
