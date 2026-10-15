import {
  errorResponseSchema,
  projectColumnsResponseSchema,
  projectColumnsSchema,
  taskFieldDefinitionListResponseSchema,
  taskFieldDefinitionResponseSchema,
  taskFieldDefinitionSchema,
  taskFieldValueHistoryListResponseSchema,
  taskFieldValueHistorySchema,
  taskFieldValueListResponseSchema,
  taskFieldValueResponseSchema,
  taskFieldValueSchema,
  type TaskFieldData,
  type TaskFieldValueDto,
} from '@workloom/contracts';
import { DEMO_USERS, FIXTURE_USER_IDS, FIXTURE_WORKSPACE_IDS, type ReadinessProbe } from '@workloom/db';
import {
  DomainError,
  NOT_FOUND_MESSAGE,
  notFoundError,
  type AccessRepository,
  type Actor,
  type CommandContext,
  type TaskApplication,
  type TaskFieldApplication,
} from '@workloom/domain';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { z } from 'zod';

import { createApp } from '../app.js';
import { loadConfig, type AppConfig } from '../config.js';

// HTTP-adapter unit tests only: a recording TaskFieldApplication transport double stands in for
// the domain service; no database is opened or simulated. They prove routing, parsing, trusted
// context, envelopes and error mapping. Capabilities, project scope, type/option rules, locks,
// revisions, idempotent replay, history recording and cursor binding belong to the domain and
// are proven by its own and the real-PostgreSQL suites.

const HOST = '127.0.0.1:4310';
const ORIGIN = `http://${HOST}`;
const KEY = 'field-draft-7c1f2a9e-4b51-4d8e-9e0a-3f2b6c8d1e47';
const SERVICE_CURSOR = 'v1.opaque+history/cursor==';
const TS = '2026-10-16T09:00:00.000Z';

const W = FIXTURE_WORKSPACE_IDS.team;
const IDS = {
  project: '5eed0000-0000-4000-8000-000000000401',
  task: '5eed0000-0000-4000-8000-000000000405',
  otherTask: '5eed0000-0000-4000-8000-000000000407',
  field: '5eed0000-0000-4000-8000-000000000501',
  option: '5eed0000-0000-4000-8000-000000000502',
  definitionVersion: '5eed0000-0000-4000-8000-000000000503',
  history: '5eed0000-0000-4000-8000-000000000504',
};
const PARAMS: Record<string, string> = {
  workspaceId: W,
  projectId: IDS.project,
  taskId: IDS.task,
  fieldId: IDS.field,
  optionId: IDS.option,
};
const OWNER: Actor = { userId: FIXTURE_USER_IDS.owner, displayName: 'Synthetic Owner', kind: 'fixture' };

// Fixtures are parsed with the real shared schemas so every success response is a valid DTO.
const field = taskFieldDefinitionSchema.parse({
  id: IDS.field,
  workspaceId: W,
  projectId: IDS.project,
  name: 'Stage',
  type: 'single_select',
  revision: 2,
  definitionVersionId: IDS.definitionVersion,
  historyEnabled: true,
  locked: false,
  archivedAt: null,
  options: [{ id: IDS.option, name: 'Draft', color: '#aabbcc', position: 0, revision: 1, archivedAt: null }],
  createdAt: TS,
  updatedAt: TS,
});
const columns = projectColumnsSchema.parse({
  workspaceId: W,
  projectId: IDS.project,
  revision: 3,
  columns: [{ fieldId: IDS.field, visible: true, width: 160, position: 0 }],
});
const value = taskFieldValueSchema.parse({
  workspaceId: W,
  projectId: IDS.project,
  taskId: IDS.task,
  fieldId: IDS.field,
  definitionVersionId: IDS.definitionVersion,
  revision: 1,
  value: { type: 'single_select', value: IDS.option },
  updatedAt: TS,
});
const historyEntry = taskFieldValueHistorySchema.parse({
  id: IDS.history,
  workspaceId: W,
  projectId: IDS.project,
  taskId: IDS.task,
  fieldId: IDS.field,
  valueRevision: 1,
  definition: field,
  before: null,
  after: { type: 'single_select', value: IDS.option },
  actor: { id: FIXTURE_USER_IDS.owner, displayName: 'Synthetic Owner' },
  source: 'web',
  recordedAt: TS,
  changeSeq: '9007199254740993',
  eventOrdinal: 1,
});

type Method = keyof TaskFieldApplication;
interface Call {
  readonly method: Method;
  readonly ctx: CommandContext;
  readonly args: unknown[];
}

const calls: Call[] = [];
/** Per-method replacement result; may throw to simulate a domain error. */
const overrides = new Map<Method, (...args: unknown[]) => unknown>();

function recorder<R>(method: Method, result: () => R) {
  return async (ctx: CommandContext, ...args: unknown[]): Promise<R> => {
    calls.push({ method, ctx, args });
    const override = overrides.get(method);
    return override === undefined ? result() : (override(...args) as R);
  };
}

const fields: TaskFieldApplication = {
  listFields: recorder('listFields', () => [field]),
  createField: recorder('createField', () => field),
  updateField: recorder('updateField', () => field),
  createOption: recorder('createOption', () => field),
  updateOption: recorder('updateOption', () => field),
  getProjectColumns: recorder('getProjectColumns', () => columns),
  updateProjectColumns: recorder('updateProjectColumns', () => columns),
  listTaskValues: recorder('listTaskValues', () => [value]),
  listProjectValues: recorder('listProjectValues', () => [value]),
  setTaskValue: recorder('setTaskValue', () => value),
  listValueHistory: recorder('listValueHistory', () => ({ items: [historyEntry], nextCursor: SERVICE_CURSOR })),
};

// Only identity lookups are needed: the real dev identity adapter resolves the actor.
const repository: AccessRepository = {
  findUser: async (id) => DEMO_USERS.find((user) => user.id === id) ?? null,
  findUsers: async (ids) => DEMO_USERS.filter((user) => ids.includes(user.id)),
  listAccessibleWorkspaces: async () => [],
  findWorkspaceAccess: async () => null,
  listActiveMemberships: async () => [],
};
const readiness: ReadinessProbe = { check: async () => ({ ready: true, checks: { database: 'ok', schema: 'ok' } }) };

function config(): AppConfig {
  return loadConfig({ APP_ENV: 'local', AUTH_MODE: 'dev', DATABASE_URL: 'postgres://u:p@127.0.0.1:5432/unused' });
}

interface RouteCase {
  readonly method: 'GET' | 'POST' | 'PATCH' | 'PUT';
  readonly path: string;
  readonly query?: string;
  readonly body?: Record<string, unknown>;
  readonly call: Method;
  readonly args: unknown[];
  readonly status: number;
  readonly schema: z.ZodType;
  readonly nextCursor?: string | null;
}

const CATALOG: RouteCase[] = [
  {
    method: 'GET',
    path: '/fields',
    query: `projectId=${IDS.project}`,
    call: 'listFields',
    args: [IDS.project],
    status: 200,
    schema: taskFieldDefinitionListResponseSchema,
    nextCursor: null,
  },
  {
    method: 'POST',
    path: '/fields',
    body: { projectId: IDS.project, name: '  Stage  ', type: 'single_select', options: [{ name: 'Draft' }] },
    // The parsed input (trimmed, with schema defaults) is passed, not the raw body.
    call: 'createField',
    args: [{ projectId: IDS.project, name: 'Stage', type: 'single_select', historyEnabled: true, locked: false, options: [{ name: 'Draft', color: null }] }],
    status: 201,
    schema: taskFieldDefinitionResponseSchema,
  },
  {
    method: 'PATCH',
    path: '/fields/:fieldId',
    body: { expectedRevision: 2, name: 'Phase', locked: true },
    call: 'updateField',
    args: [IDS.field, { expectedRevision: 2, name: 'Phase', locked: true }],
    status: 200,
    schema: taskFieldDefinitionResponseSchema,
  },
  {
    method: 'POST',
    path: '/fields/:fieldId/options',
    body: { expectedRevision: 2, name: 'Review', color: '#AABBCC' },
    call: 'createOption',
    args: [IDS.field, { expectedRevision: 2, name: 'Review', color: '#aabbcc' }],
    status: 201,
    schema: taskFieldDefinitionResponseSchema,
  },
  {
    method: 'PATCH',
    path: '/fields/:fieldId/options/:optionId',
    body: { expectedRevision: 3, color: null, archived: true },
    call: 'updateOption',
    args: [IDS.field, IDS.option, { expectedRevision: 3, color: null, archived: true }],
    status: 200,
    schema: taskFieldDefinitionResponseSchema,
  },
  {
    method: 'GET',
    path: '/projects/:projectId/columns',
    call: 'getProjectColumns',
    args: [IDS.project],
    status: 200,
    schema: projectColumnsResponseSchema,
  },
  {
    method: 'PATCH',
    path: '/projects/:projectId/columns',
    body: { expectedRevision: 3, columns: [{ fieldId: IDS.field, visible: false, width: 80, position: 0 }] },
    call: 'updateProjectColumns',
    args: [IDS.project, { expectedRevision: 3, columns: [{ fieldId: IDS.field, visible: false, width: 80, position: 0 }] }],
    status: 200,
    schema: projectColumnsResponseSchema,
  },
  {
    method: 'GET',
    path: '/tasks/:taskId/field-values',
    call: 'listTaskValues',
    args: [IDS.task],
    status: 200,
    schema: taskFieldValueListResponseSchema,
    nextCursor: null,
  },
  {
    method: 'GET',
    path: '/projects/:projectId/field-values',
    query: `taskIds=${IDS.otherTask},${IDS.task}`,
    call: 'listProjectValues',
    args: [IDS.project, { taskIds: [IDS.task, IDS.otherTask] }],
    status: 200,
    schema: taskFieldValueListResponseSchema,
    nextCursor: null,
  },
  {
    method: 'PUT',
    path: '/tasks/:taskId/field-values/:fieldId',
    body: { expectedRevision: 1, expectedDefinitionRevision: 2, value: { type: 'single_select', value: IDS.option } },
    call: 'setTaskValue',
    args: [IDS.task, IDS.field, { expectedRevision: 1, expectedDefinitionRevision: 2, value: { type: 'single_select', value: IDS.option } }],
    status: 200,
    schema: taskFieldValueResponseSchema,
  },
  {
    method: 'GET',
    path: '/tasks/:taskId/field-values/:fieldId/history',
    call: 'listValueHistory',
    args: [IDS.task, IDS.field, { limit: 50 }],
    status: 200,
    schema: taskFieldValueHistoryListResponseSchema,
    nextCursor: SERVICE_CURSOR,
  },
];
const MUTATIONS = CATALOG.filter((route) => route.method !== 'GET');
const routeFor = (call: Method): RouteCase => CATALOG.find((candidate) => candidate.call === call) as RouteCase;

function url(route: RouteCase, params: Record<string, string> = {}, query = route.query): string {
  const path = `/api/v1/workspaces/:workspaceId${route.path}`.replace(/:(\w+)/g, (_match, name: string) => params[name] ?? PARAMS[name] ?? name);
  return query === undefined ? path : `${path}?${query}`;
}

interface SendOptions {
  /** null omits the header. */
  readonly idempotencyKey?: string | null;
  readonly body?: unknown;
  readonly params?: Record<string, string>;
  readonly query?: string;
  readonly headers?: Record<string, string>;
}

function send(app: FastifyInstance, route: RouteCase, options: SendOptions = {}) {
  const mutation = route.method !== 'GET';
  const key = options.idempotencyKey === undefined ? KEY : options.idempotencyKey;
  const headers: Record<string, string> = {
    host: HOST,
    ...(mutation ? { origin: ORIGIN, 'content-type': 'application/json' } : {}),
    ...(mutation && key !== null ? { 'idempotency-key': key } : {}),
    ...options.headers,
  };
  return app.inject({
    method: route.method,
    url: url(route, options.params, options.query ?? route.query),
    headers,
    ...(mutation ? { payload: JSON.stringify(options.body ?? route.body) } : {}),
  });
}

function expectRejected(response: { statusCode: number; json: () => unknown }, statusCode: number, code: string) {
  expect(response.statusCode).toBe(statusCode);
  expect(errorResponseSchema.parse(response.json()).error.code).toBe(code);
}

function taskIdAt(index: number): string {
  return `5eed0000-0000-4000-8000-${String(1000 + index).padStart(12, '0')}`;
}

describe('P1b field routes (HTTP adapter)', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await createApp(config(), { accessRepository: repository, readiness, taskFieldApplication: fields, logger: false, webDistDir: null });
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    calls.length = 0;
    overrides.clear();
  });

  it.each(CATALOG)('$method $path delegates parsed input with the trusted context', async (route) => {
    // Client identity headers are ignored; the actor comes from the identity adapter.
    const response = await send(app, route, { headers: { 'x-actor-id': FIXTURE_USER_IDS.outsider, 'x-user-id': FIXTURE_USER_IDS.outsider } });
    expect(response.statusCode).toBe(route.status);
    const body = route.schema.parse(response.json()) as { meta: { requestId: string; nextCursor?: string | null } };
    expect(body.meta.requestId).toBe(response.headers['x-request-id']);
    expect(body.meta.nextCursor).toBe(route.nextCursor);

    expect(calls).toHaveLength(1);
    const [call] = calls;
    expect(call?.method).toBe(route.call);
    expect(call?.args).toEqual(route.args);
    const expectedContext: CommandContext = {
      actor: OWNER,
      source: 'web',
      requestId: body.meta.requestId,
      workspaceId: W,
      ...(route.method === 'GET' ? {} : { idempotencyKey: KEY }),
    };
    expect(call?.ctx).toStrictEqual(expectedContext);
  });

  it.each(CATALOG)('$method $path canonicalizes uppercase path IDs to lowercase', async (route) => {
    const upper = Object.fromEntries(Object.entries(PARAMS).map(([name, id]) => [name, id.toUpperCase()]));
    expect((await send(app, route, { params: upper })).statusCode).toBe(route.status);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.ctx.workspaceId).toBe(W);
    expect(calls[0]?.args).toEqual(route.args);
  });

  it.each(CATALOG)('$method $path rejects malformed path IDs before calling the service', async (route) => {
    const names = [...`/:workspaceId${route.path}`.matchAll(/:(\w+)/g)].map((match) => match[1] as string);
    for (const name of names) {
      const response = await send(app, route, { params: { [name]: 'not-a-uuid' } });
      expectRejected(response, 400, 'VALIDATION_FAILED');
      expect(errorResponseSchema.parse(response.json()).error.details).toEqual({ fields: [name] });
    }
    expect(calls).toHaveLength(0);
  });

  it.each(MUTATIONS)('$method $path requires a bounded printable Idempotency-Key', async (route) => {
    for (const idempotencyKey of [null, '', ' ', 'two words', 'k'.repeat(129)]) {
      const response = await send(app, route, { idempotencyKey });
      expectRejected(response, 400, 'VALIDATION_FAILED');
      expect(errorResponseSchema.parse(response.json()).error).toEqual({
        code: 'VALIDATION_FAILED',
        message: 'A valid Idempotency-Key header is required.',
        details: { fields: ['Idempotency-Key'] },
        retryable: false,
      });
    }
    expect(calls).toHaveLength(0);

    const longest = 'k'.repeat(128);
    expect((await send(app, route, { idempotencyKey: longest })).statusCode).toBe(route.status);
    expect(calls.map((call) => call.ctx.idempotencyKey)).toEqual([longest]);
  });

  it.each(MUTATIONS)('$method $path rejects actor, context or unknown fields in the body', async (route) => {
    const spoofs: Record<string, unknown>[] = [
      { actor: { userId: FIXTURE_USER_IDS.outsider, kind: 'fixture' } },
      { source: 'job' },
      { workspaceId: FIXTURE_WORKSPACE_IDS.outside },
      { idempotencyKey: 'other' },
      { capabilities: ['fields.manage'] },
      { taskId: IDS.otherTask },
      { fieldId: IDS.field },
      { revision: 9 },
      { definitionVersionId: IDS.definitionVersion },
    ];
    for (const spoof of spoofs) {
      expectRejected(await send(app, route, { body: { ...route.body, ...spoof } }), 400, 'VALIDATION_FAILED');
    }
    expectRejected(await send(app, route, { body: [] }), 400, 'VALIDATION_FAILED');
    expect(calls).toHaveLength(0);
  });

  it.each([
    { call: 'createField', body: { projectId: IDS.project, name: 'Stage' } },
    { call: 'createField', body: { projectId: 'nope', name: 'Stage', type: 'text' } },
    { call: 'createField', body: { projectId: IDS.project, name: '   ', type: 'text' } },
    { call: 'createField', body: { projectId: IDS.project, name: 'Stage', type: 'formula' } },
    { call: 'updateField', body: { expectedRevision: 2 } },
    { call: 'updateField', body: { name: 'Phase' } },
    { call: 'updateField', body: { expectedRevision: 0, name: 'Phase' } },
    { call: 'createOption', body: { name: 'Review' } },
    { call: 'createOption', body: { expectedRevision: 2, name: 'Review', color: 'red' } },
    { call: 'updateOption', body: { expectedRevision: 3 } },
    { call: 'updateProjectColumns', body: { columns: [] } },
    { call: 'updateProjectColumns', body: { expectedRevision: 3, columns: [{ fieldId: IDS.field, visible: true, width: 79, position: 0 }] } },
    {
      call: 'updateProjectColumns',
      body: {
        expectedRevision: 3,
        columns: [
          { fieldId: IDS.field, visible: true, width: 120, position: 0 },
          { fieldId: IDS.field.toUpperCase(), visible: true, width: 120, position: 1 },
        ],
      },
    },
    { call: 'setTaskValue', body: { expectedRevision: 0, value: { type: 'text', value: 'x' } } },
    { call: 'setTaskValue', body: { expectedDefinitionRevision: 2, value: { type: 'text', value: 'x' } } },
    { call: 'setTaskValue', body: { expectedRevision: -1, expectedDefinitionRevision: 2, value: { type: 'text', value: 'x' } } },
    { call: 'setTaskValue', body: { expectedRevision: 0, expectedDefinitionRevision: 2 } },
    { call: 'setTaskValue', body: { expectedRevision: 0, expectedDefinitionRevision: 2, value: null } },
    { call: 'setTaskValue', body: { expectedRevision: 0, expectedDefinitionRevision: 2, value: { type: 'text' } } },
    { call: 'setTaskValue', body: { expectedRevision: 0, expectedDefinitionRevision: 2, value: { type: 'boolean', value: 'false' } } },
    { call: 'setTaskValue', body: { expectedRevision: 0, expectedDefinitionRevision: 2, value: { type: 'number', value: '0' } } },
    { call: 'setTaskValue', body: { expectedRevision: 0, expectedDefinitionRevision: 2, value: { type: 'duration', value: 1.5 } } },
    { call: 'setTaskValue', body: { expectedRevision: 0, expectedDefinitionRevision: 2, value: { type: 'date', value: '2026-10-16T00:00:00Z' } } },
    { call: 'setTaskValue', body: { expectedRevision: 0, expectedDefinitionRevision: 2, value: { type: 'url', value: 'javascript:alert(1)' } } },
    { call: 'setTaskValue', body: { expectedRevision: 0, expectedDefinitionRevision: 2, value: { type: 'single_select', value: 'Draft' } } },
    { call: 'setTaskValue', body: { expectedRevision: 0, expectedDefinitionRevision: 2, value: { type: 'person', value: [IDS.task, IDS.task] } } },
    { call: 'setTaskValue', body: { expectedRevision: 0, expectedDefinitionRevision: 2, value: { type: 'text', value: 'x', label: 'x' } } },
  ] as const)('rejects an invalid $call body before calling the service (%#)', async ({ call, body }) => {
    expectRejected(await send(app, routeFor(call), { body }), 400, 'VALIDATION_FAILED');
    expect(calls).toHaveLength(0);
  });

  it.each<{ data: TaskFieldData; expectedRevision: number }>([
    { data: { type: 'boolean', value: false }, expectedRevision: 0 },
    { data: { type: 'number', value: 0 }, expectedRevision: 0 },
    { data: { type: 'duration', value: 0 }, expectedRevision: 1 },
    { data: { type: 'text', value: '' }, expectedRevision: 1 },
    { data: { type: 'text', value: '  verbatim  ' }, expectedRevision: 1 },
    { data: { type: 'text', value: null }, expectedRevision: 0 },
    { data: { type: 'multi_select', value: [] }, expectedRevision: 2 },
    { data: { type: 'person', value: null }, expectedRevision: 2 },
  ])('PUT preserves typed $data.type value $data.value and revision guards', async ({ data, expectedRevision }) => {
    overrides.set('setTaskValue', (_taskId, _fieldId, input) => ({
      ...value,
      revision: expectedRevision + 1,
      value: (input as { value: TaskFieldData }).value,
    }));
    const route = routeFor('setTaskValue');
    const response = await send(app, route, { body: { expectedRevision, expectedDefinitionRevision: 2, value: data } });
    expect(response.statusCode).toBe(200);
    expect(calls[0]?.args).toStrictEqual([IDS.task, IDS.field, { expectedRevision, expectedDefinitionRevision: 2, value: data }]);
    const body = taskFieldValueResponseSchema.parse(response.json());
    expect(body.data.value).toStrictEqual(data);
    expect(body.data.revision).toBe(expectedRevision + 1);
  });

  it('PUT canonicalizes reference IDs in the value to a lowercase sorted set', async () => {
    const route = routeFor('setTaskValue');
    const body = {
      expectedRevision: 1,
      expectedDefinitionRevision: 2,
      value: { type: 'person', value: [IDS.task.toUpperCase(), IDS.field.toUpperCase(), IDS.otherTask] },
    };
    expect((await send(app, route, { body })).statusCode).toBe(200);
    expect(calls[0]?.args[2]).toStrictEqual({
      expectedRevision: 1,
      expectedDefinitionRevision: 2,
      value: { type: 'person', value: [IDS.task, IDS.otherTask, IDS.field] },
    });
  });

  it('rejects invalid field list queries', async () => {
    const list = routeFor('listFields');
    const p = `projectId=${IDS.project}`;
    for (const query of ['', 'projectId=nope', `${p}&projectId=${IDS.project}`, `${p}&includeArchived=true`, `${p}&workspaceId=${W}`]) {
      expectRejected(await send(app, list, { query }), 400, 'VALIDATION_FAILED');
    }
    expect(calls).toHaveLength(0);

    expect((await send(app, list, { query: `projectId=${IDS.project.toUpperCase()}` })).statusCode).toBe(200);
    expect(calls[0]?.args).toEqual([IDS.project]);
  });

  it.each(['getProjectColumns', 'listTaskValues'] as const)('%s rejects unexpected query keys', async (call) => {
    for (const query of ['limit=10', `workspaceId=${W}`, 'cursor=x']) {
      expectRejected(await send(app, routeFor(call), { query }), 400, 'VALIDATION_FAILED');
    }
    expect(calls).toHaveLength(0);
  });

  it('normalizes batch task IDs from CSV or repeated parameters', async () => {
    const batch = routeFor('listProjectValues');
    const queries = [
      `taskIds=${IDS.otherTask.toUpperCase()},${IDS.task}`,
      `taskIds=${IDS.otherTask}&taskIds=${IDS.task.toUpperCase()}`,
    ];
    for (const query of queries) {
      expect((await send(app, batch, { query })).statusCode).toBe(200);
    }
    expect(calls.map((call) => call.args)).toEqual([
      [IDS.project, { taskIds: [IDS.task, IDS.otherTask] }],
      [IDS.project, { taskIds: [IDS.task, IDS.otherTask] }],
    ]);

    calls.length = 0;
    const max = Array.from({ length: 200 }, (_unused, index) => taskIdAt(199 - index));
    expect((await send(app, batch, { query: `taskIds=${max.join(',')}` })).statusCode).toBe(200);
    expect(calls[0]?.args).toEqual([IDS.project, { taskIds: [...max].sort() }]);
  });

  it('rejects batch queries outside the published bounds', async () => {
    const batch = routeFor('listProjectValues');
    const tooMany = Array.from({ length: 201 }, (_unused, index) => taskIdAt(index)).join(',');
    const invalid = [
      '',
      'taskIds=',
      'taskIds=nope',
      `taskIds=${IDS.task},`,
      `taskIds=${IDS.task},${IDS.task.toUpperCase()}`,
      `taskIds=${tooMany}`,
      `taskIds=${IDS.task}&projectId=${IDS.project}`,
      `taskIds=${IDS.task}&limit=10`,
    ];
    for (const query of invalid) {
      expectRejected(await send(app, batch, { query }), 400, 'VALIDATION_FAILED');
    }
    expect(calls).toHaveLength(0);
  });

  it('passes the history limit and client cursor through and returns the service cursor', async () => {
    const history = routeFor('listValueHistory');
    const cursor = 'eyJ2IjoxfQ.sig+/=';
    const response = await send(app, history, { query: `limit=10&cursor=${encodeURIComponent(cursor)}` });
    expect(response.statusCode).toBe(200);
    const body = taskFieldValueHistoryListResponseSchema.parse(response.json());
    expect(body.data).toEqual([historyEntry]);
    expect(body.data[0]?.changeSeq).toBe('9007199254740993');
    expect(body.meta.nextCursor).toBe(SERVICE_CURSOR);
    expect(calls[0]?.args).toEqual([IDS.task, IDS.field, { limit: 10, cursor }]);

    overrides.set('listValueHistory', () => ({ items: [], nextCursor: null }));
    const last = taskFieldValueHistoryListResponseSchema.parse((await send(app, history, { query: 'limit=100' })).json());
    expect(last).toMatchObject({ data: [], meta: { nextCursor: null } });
    expect(calls[1]?.args).toEqual([IDS.task, IDS.field, { limit: 100 }]);
  });

  it('rejects invalid history queries', async () => {
    const history = routeFor('listValueHistory');
    for (const query of ['limit=0', 'limit=101', 'limit=1.5', 'limit=ten', 'cursor=', `cursor=${'c'.repeat(2049)}`, 'limit=10&limit=20', `fieldId=${IDS.field}`]) {
      expectRejected(await send(app, history, { query }), 400, 'VALIDATION_FAILED');
    }
    expect(calls).toHaveLength(0);
  });

  it('rejects field mutations, including PUT, from foreign origins or hosts before the service is called', async () => {
    for (const call of ['createField', 'setTaskValue', 'updateProjectColumns'] as const) {
      const route = routeFor(call);
      expectRejected(await send(app, route, { headers: { origin: 'http://evil.example' } }), 403, 'ORIGIN_NOT_ALLOWED');
      expectRejected(await send(app, route, { headers: { 'sec-fetch-site': 'cross-site' } }), 403, 'ORIGIN_NOT_ALLOWED');
      expectRejected(await send(app, route, { headers: { host: 'evil.example:4310' } }), 421, 'HOST_NOT_ALLOWED');
    }
    expectRejected(await send(app, routeFor('listTaskValues'), { headers: { host: 'evil.example:4310' } }), 421, 'HOST_NOT_ALLOWED');
    expect(calls).toHaveLength(0);
  });

  it.each([
    { call: 'updateField', error: new DomainError('REVISION_CONFLICT', 'The field was changed.', { details: { currentRevision: 3 } }), status: 409 },
    { call: 'setTaskValue', error: new DomainError('REVISION_CONFLICT', 'The value was changed.', { details: { currentRevision: 2 } }), status: 409 },
    { call: 'updateProjectColumns', error: new DomainError('REVISION_CONFLICT', 'The columns were changed.'), status: 409 },
    { call: 'setTaskValue', error: new DomainError('FIELD_LOCKED', 'The field is locked.'), status: 409 },
    { call: 'createField', error: new DomainError('IDEMPOTENCY_KEY_REUSED', 'The key was used with another request.'), status: 409 },
    { call: 'setTaskValue', error: notFoundError(), status: 404 },
    { call: 'listProjectValues', error: notFoundError(), status: 404 },
    { call: 'updateProjectColumns', error: new DomainError('CAPABILITY_REQUIRED', 'Not permitted.'), status: 403 },
    { call: 'createOption', error: new DomainError('DOMAIN_VALIDATION_FAILED', 'Only select fields have options.'), status: 422 },
    { call: 'updateField', error: new DomainError('DOMAIN_VALIDATION_FAILED', 'The field type cannot change.'), status: 422 },
    { call: 'listValueHistory', error: new DomainError('VALIDATION_FAILED', 'The cursor is no longer valid. Reload the list.'), status: 400 },
  ] as const)('maps $error.code from $call to $status', async ({ call, error, status }) => {
    overrides.set(call, () => {
      throw error;
    });
    const response = await send(app, routeFor(call));
    expect(response.statusCode).toBe(status);
    const body = errorResponseSchema.parse(response.json());
    expect(body.error.code).toBe(error.code);
    expect(body.error.message).toBe(error.message);
    if (error.details !== undefined) expect(body.error.details).toEqual(error.details);
    if (error.code === 'NOT_FOUND') expect(body.error.message).toBe(NOT_FOUND_MESSAGE);
    expect(body.meta.requestId).toBe(response.headers['x-request-id']);
  });

  it('redacts unexpected service failures', async () => {
    overrides.set('setTaskValue', () => {
      throw new Error('insert into task_field_values failed: secret-value');
    });
    const response = await send(app, routeFor('setTaskValue'));
    expectRejected(response, 500, 'INTERNAL_ERROR');
    expect(response.body).not.toContain('task_field_values');
    expect(response.body).not.toContain('secret-value');
  });

  it('refuses to send a service result that breaks the response contract', async () => {
    overrides.set('createOption', () => ({ ...field, type: 'text' }));
    expectRejected(await send(app, routeFor('createOption')), 500, 'INTERNAL_ERROR');
    overrides.set('setTaskValue', (): TaskFieldValueDto => ({ ...value, revision: 0 }));
    expectRejected(await send(app, routeFor('setTaskValue')), 500, 'INTERNAL_ERROR');
  });

  it('uses the actor selected by the server-side dev session', async () => {
    const switched = await app.inject({
      method: 'POST',
      url: '/api/v1/dev/session',
      headers: { host: HOST, origin: ORIGIN, 'x-workloom-dev-tool': '1', 'content-type': 'application/json' },
      payload: JSON.stringify({ actorId: FIXTURE_USER_IDS.memberA }),
    });
    expect(switched.statusCode).toBe(200);
    const cookie = String(switched.headers['set-cookie']).split(';')[0] ?? '';

    expect((await send(app, routeFor('setTaskValue'), { headers: { cookie } })).statusCode).toBe(200);
    expect(calls[0]?.ctx.actor.userId).toBe(FIXTURE_USER_IDS.memberA);
  });

  it('does not register field routes without a field service or database', async () => {
    const tasks = {} as TaskApplication;
    for (const dependencies of [{}, { taskApplication: tasks }]) {
      const older = await createApp(config(), { accessRepository: repository, readiness, logger: false, webDistDir: null, ...dependencies });
      try {
        for (const route of CATALOG) {
          expectRejected(await send(older, route), 404, 'NOT_FOUND');
        }
      } finally {
        await older.close();
      }
    }
    expect(calls).toHaveLength(0);
  });
});
