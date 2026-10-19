import {
  errorResponseSchema,
  bulkTaskUpdateResponseSchema,
  projectListResponseSchema,
  projectResponseSchema,
  sectionListResponseSchema,
  sectionResponseSchema,
  tagListResponseSchema,
  tagResponseSchema,
  taskListResponseSchema,
  taskResponseSchema,
  taskStatusListResponseSchema,
  type ProjectDto,
  type SectionDto,
  type TagDto,
  type TaskDto,
  type TaskStatusDto,
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
} from '@workloom/domain';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { z } from 'zod';

import { createApp } from '../app.js';
import { loadConfig, type AppConfig } from '../config.js';

// HTTP-adapter tests only: a recording TaskApplication double stands in for the domain service.
// They prove routing, parsing, trusted context, envelopes and error mapping. Access rules,
// tenant scope, revisions, idempotent replay and persistence are proven by the real-PostgreSQL suites.

const HOST = '127.0.0.1:4310';
const ORIGIN = `http://${HOST}`;
const KEY = 'task-draft-1b9d6bcd-bbfd-4b2d-9b5d-ab8dfbbd4bed';
const SERVICE_CURSOR = 'v1.opaque+cursor/==';
const TS = '2026-10-16T09:00:00.000Z';

const W = FIXTURE_WORKSPACE_IDS.team;
const IDS = {
  project: '5eed0000-0000-4000-8000-000000000401',
  section: '5eed0000-0000-4000-8000-000000000402',
  status: '5eed0000-0000-4000-8000-000000000403',
  tag: '5eed0000-0000-4000-8000-000000000404',
  task: '5eed0000-0000-4000-8000-000000000405',
  workPackage: '5eed0000-0000-4000-8000-000000000406',
  /** Has a letter so upper-case input proves canonicalization. */
  anchor: '5eed0000-0000-4000-8000-00000000040a',
  membership: '5eed0000-0000-4000-8000-000000000301',
};
const PARAMS: Record<string, string> = {
  workspaceId: W,
  projectId: IDS.project,
  sectionId: IDS.section,
  tagId: IDS.tag,
  taskId: IDS.task,
};
const OWNER: Actor = { userId: FIXTURE_USER_IDS.owner, displayName: 'Synthetic Owner', kind: 'fixture' };

const project: ProjectDto = { id: IDS.project, workspaceId: W, name: 'Launch', revision: 1, archivedAt: null, createdAt: TS, updatedAt: TS };
const section: SectionDto = { id: IDS.section, workspaceId: W, projectId: IDS.project, name: 'Backlog', position: 0, revision: 1, archivedAt: null };
const status: TaskStatusDto = { id: IDS.status, workspaceId: W, projectId: IDS.project, name: 'To do', group: 'todo', position: 0, revision: 1 };
const tag: TagDto = { id: IDS.tag, workspaceId: W, name: 'ops', color: '#aabbcc', revision: 1, archivedAt: null };
const task: TaskDto = {
  id: IDS.task,
  workspaceId: W,
  projectId: IDS.project,
  sectionId: IDS.section,
  parentTaskId: null,
  workPackageId: IDS.workPackage,
  workPackageRevision: 2,
  title: 'Write spec',
  description: '',
  statusId: IDS.status,
  responsibleMembershipId: IDS.membership,
  participants: [{ membershipId: IDS.membership, role: 'assignee', active: true, revision: 1 }],
  participantsRevision: 1,
  dueDate: '2026-10-30',
  priority: 'medium',
  tags: [tag],
  estimateMinutes: 120,
  revision: 3,
  position: 0,
  visibility: 'workspace',
  archivedAt: null,
  createdAt: TS,
  updatedAt: TS,
};

type Method = keyof TaskApplication;
interface Call {
  readonly method: Method;
  readonly ctx: CommandContext;
  readonly args: unknown[];
}

const calls: Call[] = [];
/** Per-method replacement result; may throw to simulate a domain error. */
const overrides = new Map<Method, () => unknown>();

function recorder<R>(method: Method, result: () => R) {
  return async (ctx: CommandContext, ...args: unknown[]): Promise<R> => {
    calls.push({ method, ctx, args });
    const override = overrides.get(method);
    return override === undefined ? result() : (override() as R);
  };
}

const tasks: TaskApplication = {
  listProjects: recorder('listProjects', () => [project]),
  getProject: recorder('getProject', () => project),
  createProject: recorder('createProject', () => project),
  updateProject: recorder('updateProject', () => project),
  listSections: recorder('listSections', () => [section]),
  createSection: recorder('createSection', () => section),
  updateSection: recorder('updateSection', () => section),
  listStatuses: recorder('listStatuses', () => [status]),
  listTags: recorder('listTags', () => [tag]),
  createTag: recorder('createTag', () => tag),
  updateTag: recorder('updateTag', () => tag),
  listTasks: recorder('listTasks', () => ({ items: [task], nextCursor: SERVICE_CURSOR })),
  getTask: recorder('getTask', () => task),
  createTask: recorder('createTask', () => task),
  updateTask: recorder('updateTask', () => task),
  archiveTask: recorder('archiveTask', () => task),
  restoreTask: recorder('restoreTask', () => task),
  moveTask: recorder('moveTask', () => task),
  bulkUpdateTasks: recorder('bulkUpdateTasks', () => [task]),
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
  readonly method: 'GET' | 'POST' | 'PATCH';
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
  { method: 'GET', path: '/projects', call: 'listProjects', args: [], status: 200, schema: projectListResponseSchema, nextCursor: null },
  { method: 'POST', path: '/projects', body: { name: 'Launch' }, call: 'createProject', args: [{ name: 'Launch' }], status: 201, schema: projectResponseSchema },
  { method: 'GET', path: '/projects/:projectId', call: 'getProject', args: [IDS.project], status: 200, schema: projectResponseSchema },
  {
    method: 'PATCH',
    path: '/projects/:projectId',
    body: { expectedRevision: 1, name: 'Renamed' },
    call: 'updateProject',
    args: [IDS.project, { expectedRevision: 1, name: 'Renamed' }],
    status: 200,
    schema: projectResponseSchema,
  },
  { method: 'GET', path: '/projects/:projectId/sections', call: 'listSections', args: [IDS.project], status: 200, schema: sectionListResponseSchema, nextCursor: null },
  {
    method: 'POST',
    path: '/projects/:projectId/sections',
    body: { name: 'Backlog' },
    call: 'createSection',
    args: [IDS.project, { name: 'Backlog' }],
    status: 201,
    schema: sectionResponseSchema,
  },
  {
    method: 'PATCH',
    path: '/sections/:sectionId',
    body: { expectedRevision: 1, position: 2 },
    call: 'updateSection',
    args: [IDS.section, { expectedRevision: 1, position: 2 }],
    status: 200,
    schema: sectionResponseSchema,
  },
  { method: 'GET', path: '/projects/:projectId/statuses', call: 'listStatuses', args: [IDS.project], status: 200, schema: taskStatusListResponseSchema, nextCursor: null },
  { method: 'GET', path: '/tags', call: 'listTags', args: [], status: 200, schema: tagListResponseSchema, nextCursor: null },
  { method: 'POST', path: '/tags', body: { name: 'ops', color: '#aabbcc' }, call: 'createTag', args: [{ name: 'ops', color: '#aabbcc' }], status: 201, schema: tagResponseSchema },
  {
    method: 'PATCH',
    path: '/tags/:tagId',
    body: { expectedRevision: 1, archived: true },
    call: 'updateTag',
    args: [IDS.tag, { expectedRevision: 1, archived: true }],
    status: 200,
    schema: tagResponseSchema,
  },
  {
    method: 'GET',
    path: '/tasks',
    query: `projectId=${IDS.project}&limit=20&includeArchived=false`,
    call: 'listTasks',
    args: [{ projectId: IDS.project, limit: 20, includeArchived: false }],
    status: 200,
    schema: taskListResponseSchema,
    nextCursor: SERVICE_CURSOR,
  },
  {
    method: 'POST',
    path: '/tasks',
    body: { projectId: IDS.project, title: '  Write spec  ', statusId: IDS.status },
    // The parsed (trimmed) input is passed, not the raw body.
    call: 'createTask',
    args: [{ projectId: IDS.project, title: 'Write spec', statusId: IDS.status }],
    status: 201,
    schema: taskResponseSchema,
  },
  { method: 'POST', path: '/tasks/bulk-update', body: { projectId: IDS.project, tasks: [{ taskId: IDS.task, expectedRevision: 3 }], changes: { responsibleMembershipId: null, dueDate: null } }, call: 'bulkUpdateTasks', args: [{ projectId: IDS.project, tasks: [{ taskId: IDS.task, expectedRevision: 3 }], changes: { responsibleMembershipId: null, dueDate: null } }], status: 200, schema: bulkTaskUpdateResponseSchema },
  { method: 'GET', path: '/tasks/:taskId', call: 'getTask', args: [IDS.task], status: 200, schema: taskResponseSchema },
  {
    method: 'PATCH',
    path: '/tasks/:taskId',
    body: { expectedRevision: 3, estimateMinutes: 90, expectedWorkPackageRevision: 2 },
    call: 'updateTask',
    args: [IDS.task, { expectedRevision: 3, estimateMinutes: 90, expectedWorkPackageRevision: 2 }],
    status: 200,
    schema: taskResponseSchema,
  },
  {
    method: 'POST',
    path: '/tasks/:taskId/archive',
    body: { expectedRevision: 3 },
    call: 'archiveTask',
    args: [IDS.task, { expectedRevision: 3 }],
    status: 200,
    schema: taskResponseSchema,
  },
  {
    method: 'POST',
    path: '/tasks/:taskId/restore',
    body: { expectedRevision: 4 },
    call: 'restoreTask',
    args: [IDS.task, { expectedRevision: 4 }],
    status: 200,
    schema: taskResponseSchema,
  },
  {
    method: 'POST',
    path: '/tasks/:taskId/move',
    body: { expectedRevision: 3, anchorTaskId: IDS.anchor, placement: 'after' },
    call: 'moveTask',
    args: [IDS.task, { expectedRevision: 3, anchorTaskId: IDS.anchor, placement: 'after' }],
    status: 200,
    schema: taskResponseSchema,
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

describe('P1a task routes (HTTP adapter)', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await createApp(config(), { accessRepository: repository, readiness, taskApplication: tasks, logger: false, webDistDir: null });
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
      { capabilities: ['task.update'] },
      { actualMinutes: 30 },
    ];
    for (const spoof of spoofs) {
      expectRejected(await send(app, route, { body: { ...route.body, ...spoof } }), 400, 'VALIDATION_FAILED');
    }
    expectRejected(await send(app, route, { body: [] }), 400, 'VALIDATION_FAILED');
    expect(calls).toHaveLength(0);
  });

  it('rejects mutations from foreign origins or hosts before the service is called', async () => {
    const create = routeFor('createTask');
    expectRejected(await send(app, create, { headers: { origin: 'http://evil.example' } }), 403, 'ORIGIN_NOT_ALLOWED');
    expectRejected(await send(app, create, { headers: { 'sec-fetch-site': 'cross-site' } }), 403, 'ORIGIN_NOT_ALLOWED');
    expectRejected(await send(app, create, { headers: { host: 'evil.example:4310' } }), 421, 'HOST_NOT_ALLOWED');
    expectRejected(await send(app, routeFor('listTasks'), { headers: { host: 'evil.example:4310' } }), 421, 'HOST_NOT_ALLOWED');
    expect(calls).toHaveLength(0);
  });

  it('rejects invalid task list queries with 400', async () => {
    const list = routeFor('listTasks');
    const p = `projectId=${IDS.project}`;
    const invalid = [
      '',
      'projectId=nope',
      `${p}&projectId=${IDS.project}`,
      `${p}&limit=0`,
      `${p}&limit=201`,
      `${p}&limit=1.5`,
      `${p}&limit=ten`,
      `${p}&includeArchived=1`,
      `${p}&includeArchived=yes`,
      `${p}&statusId=nope`,
      `${p}&tagId=nope`,
      `${p}&tagId=${IDS.tag}&tagId=${IDS.tag}`,
      `${p}&tagIds=${IDS.tag}`,
      `${p}&sort=title`,
      `${p}&completion=all`,
      `${p}&completion=done`,
      `${p}&completion=OPEN`,
      `${p}&completion=`,
      `${p}&completion=open&completion=open`,
      `${p}&completed=open`,
      `${p}&cursor=`,
      `${p}&search=${'s'.repeat(201)}`,
      `${p}&actor=${FIXTURE_USER_IDS.outsider}`,
      `${p}&workspaceId=${FIXTURE_WORKSPACE_IDS.outside}`,
    ];
    for (const query of invalid) {
      expectRejected(await send(app, list, { query }), 400, 'VALIDATION_FAILED');
    }
    expect(calls).toHaveLength(0);
  });

  it('passes the client cursor and filters through and returns the service cursor', async () => {
    const cursor = 'eyJ2IjoxfQ.sig+/=';
    const query = `projectId=${IDS.project}&statusId=${IDS.status}&participantMembershipId=${IDS.membership}&search=spec&includeArchived=true&cursor=${encodeURIComponent(cursor)}`;
    const response = await send(app, routeFor('listTasks'), { query });
    expect(response.statusCode).toBe(200);
    const body = taskListResponseSchema.parse(response.json());
    expect(body.data).toEqual([task]);
    expect(body.meta.nextCursor).toBe(SERVICE_CURSOR);
    expect(calls[0]?.args).toEqual([
      { projectId: IDS.project, statusId: IDS.status, participantMembershipId: IDS.membership, search: 'spec', includeArchived: true, cursor, limit: 50 },
    ]);

    overrides.set('listTasks', () => ({ items: [], nextCursor: null }));
    const last = taskListResponseSchema.parse((await send(app, routeFor('listTasks'))).json());
    expect(last).toMatchObject({ data: [], meta: { nextCursor: null } });
  });

  it('forwards the bounded scalar due sort and rejects unsupported or repeated modes', async () => {
    const response = await send(app, routeFor('listTasks'), { query: `projectId=${IDS.project}&sort=due_asc&limit=2&cursor=due-token` });
    expect(response.statusCode).toBe(200);
    expect(calls[0]?.args).toEqual([{ projectId: IDS.project, sort: 'due_asc', limit: 2, cursor: 'due-token' }]);
    for (const suffix of ['sort=due_desc', 'sort=due_asc&sort=manual', 'sort=']) {
      expect((await send(app, routeFor('listTasks'), { query: `projectId=${IDS.project}&${suffix}` })).statusCode).toBe(400);
    }
  });

  it('forwards a canonical scalar tag filter without changing other filters', async () => {
    const query = `projectId=${IDS.project}&tagId=${IDS.tag.toUpperCase()}&sectionId=${IDS.section}&statusId=${IDS.status}&participantMembershipId=${IDS.membership}&search=spec&limit=2`;
    const response = await send(app, routeFor('listTasks'), { query });
    expect(response.statusCode).toBe(200);
    expect(calls[0]?.args).toEqual([{
      projectId: IDS.project, tagId: IDS.tag, sectionId: IDS.section,
      statusId: IDS.status, participantMembershipId: IDS.membership, search: 'spec', limit: 2,
    }]);
  });

  it('forwards the scalar open completion filter and keeps omitted queries in their prior shape', async () => {
    const query = `projectId=${IDS.project}&completion=open&statusId=${IDS.status}&tagId=${IDS.tag}&sort=due_asc&limit=2&cursor=open-token`;
    expect((await send(app, routeFor('listTasks'), { query })).statusCode).toBe(200);
    expect(calls[0]?.args).toStrictEqual([{
      projectId: IDS.project, completion: 'open', statusId: IDS.status, tagId: IDS.tag, sort: 'due_asc', limit: 2, cursor: 'open-token',
    }]);
    expect((await send(app, routeFor('listTasks'), { query: `projectId=${IDS.project}&limit=2` })).statusCode).toBe(200);
    expect(calls[1]?.args).toStrictEqual([{ projectId: IDS.project, limit: 2 }]);
    expect(Object.hasOwn(calls[1]?.args[0] as object, 'completion')).toBe(false);
  });

  it.each([
    { call: 'updateTask', error: new DomainError('REVISION_CONFLICT', 'The task was changed.', { details: { currentRevision: 4 } }), status: 409 },
    { call: 'createTask', error: new DomainError('IDEMPOTENCY_KEY_REUSED', 'The key was used with another request.'), status: 409 },
    { call: 'updateTask', error: new DomainError('DEPENDENCY_CYCLE', 'The parent would create a cycle.'), status: 409 },
    { call: 'getTask', error: notFoundError(), status: 404 },
    { call: 'updateTag', error: new DomainError('CAPABILITY_REQUIRED', 'Not permitted.'), status: 403 },
    { call: 'listTasks', error: new DomainError('VALIDATION_FAILED', 'The cursor is no longer valid. Reload the list.'), status: 400 },
    { call: 'createTask', error: new DomainError('DOMAIN_VALIDATION_FAILED', 'The status belongs to another project.'), status: 422 },
    { call: 'moveTask', error: new DomainError('REVISION_CONFLICT', 'The task was changed.', { details: { currentRevision: 4 } }), status: 409 },
    { call: 'moveTask', error: new DomainError('IDEMPOTENCY_KEY_REUSED', 'The key was used with another request.'), status: 409 },
    { call: 'moveTask', error: new DomainError('DOMAIN_VALIDATION_FAILED', 'The anchor has another parent.'), status: 422 },
    { call: 'moveTask', error: notFoundError(), status: 404 },
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

  it('preserves canonical meeting identity in current task reads without filling old stored responses', async () => {
    const meetingId = '5eed0000-0000-4000-8000-000000000801';
    overrides.set('getTask', () => ({ ...task, meetingId }));
    expect((await send(app, routeFor('getTask'))).json().data.meetingId).toBe(meetingId);
    overrides.delete('getTask');
    expect((await send(app, routeFor('getTask'))).json().data).not.toHaveProperty('meetingId');
  });

  it('rejects client-written meeting markers through generic task create and update', async () => {
    for (const call of ['createTask', 'updateTask'] as const) {
      const route = routeFor(call);
      const response = await send(app, { ...route, body: { ...route.body, meetingId: '5eed0000-0000-4000-8000-000000000801' } });
      expectRejected(response, 400, 'VALIDATION_FAILED');
    }
    expect(calls).toHaveLength(0);
  });

  it('keeps the old create body without an insertion and forwards a parsed insertion exactly', async () => {
    const create = routeFor('createTask');
    expect((await send(app, create)).statusCode).toBe(201);
    expect(Object.hasOwn(calls[0]?.args[0] as object, 'insertion')).toBe(false);

    const insertion = { anchorTaskId: IDS.anchor.toUpperCase(), placement: 'before' };
    expect((await send(app, create, { body: { ...create.body, insertion } })).statusCode).toBe(201);
    expect(calls[1]?.args).toStrictEqual([
      { projectId: IDS.project, title: 'Write spec', statusId: IDS.status, insertion: { anchorTaskId: IDS.anchor, placement: 'before' } },
    ]);
    expect(calls[1]?.ctx.idempotencyKey).toBe(KEY);
  });

  it('rejects malformed create insertions and position with insertion before the service', async () => {
    const create = routeFor('createTask');
    const valid = { anchorTaskId: IDS.anchor, placement: 'after' };
    for (const extra of [
      { insertion: valid, position: 0 },
      { insertion: null },
      { insertion: IDS.anchor },
      { insertion: { anchorTaskId: IDS.anchor } },
      { insertion: { ...valid, placement: 'inside' } },
      { insertion: { ...valid, anchorTaskId: 'nope' } },
      { insertion: { ...valid, sectionId: IDS.section } },
    ]) {
      expectRejected(await send(app, create, { body: { ...create.body, ...extra } }), 400, 'VALIDATION_FAILED');
    }
    expect(calls).toHaveLength(0);
  });

  it('forwards a canonical move and rejects open-ended move bodies, keys and origins before the service', async () => {
    const move = routeFor('moveTask');
    const response = await send(app, move, { body: { expectedRevision: 3, anchorTaskId: IDS.anchor.toUpperCase(), placement: 'before' } });
    expect(response.statusCode).toBe(200);
    expect(taskResponseSchema.parse(response.json()).data).toEqual(task);
    expect(calls.map((call) => [call.method, call.args])).toStrictEqual([
      ['moveTask', [IDS.task, { expectedRevision: 3, anchorTaskId: IDS.anchor, placement: 'before' }]],
    ]);

    const valid = { expectedRevision: 3, anchorTaskId: IDS.anchor, placement: 'after' };
    for (const body of [
      {},
      { anchorTaskId: IDS.anchor, placement: 'after' },
      { expectedRevision: 3, placement: 'after' },
      { expectedRevision: 3, anchorTaskId: IDS.anchor },
      { ...valid, expectedRevision: 0 },
      { ...valid, expectedRevision: '3' },
      { ...valid, placement: 'inside' },
      { ...valid, placement: null },
      { ...valid, anchorTaskId: 'nope' },
      { ...valid, position: 0 },
      { ...valid, sectionId: IDS.section },
      { ...valid, parentTaskId: IDS.task },
      { ...valid, insertion: { anchorTaskId: IDS.anchor, placement: 'after' } },
    ]) {
      expectRejected(await send(app, move, { body }), 400, 'VALIDATION_FAILED');
    }
    expectRejected(await send(app, move, { idempotencyKey: null }), 400, 'VALIDATION_FAILED');
    expectRejected(await send(app, move, { headers: { origin: 'http://evil.example' } }), 403, 'ORIGIN_NOT_ALLOWED');
    expectRejected(await send(app, move, { headers: { host: 'evil.example:4310' } }), 421, 'HOST_NOT_ALLOWED');
    expect(calls).toHaveLength(1);
  });

  it('forwards atomic Board lane placement through the existing move route and rejects mixed modes', async () => {
    const route = routeFor('moveTask');
    for (const anchorTaskId of [IDS.anchor, null]) {
      const body = { expectedRevision: 3, statusId: IDS.status.toUpperCase(), anchorTaskId, placement: 'after' };
      const response = await send(app, route, { body });
      expect(response.statusCode).toBe(200);
      expect(taskResponseSchema.parse(response.json()).data).toEqual(task);
      expect(calls.at(-1)?.args).toEqual([IDS.task, { ...body, statusId: IDS.status }]);
    }
    for (const extra of [{ responsibleMembershipId: null }, { statusId: null }, { anchorTaskId: null, placement: 'before' }, { position: 12 }]) {
      expectRejected(await send(app, route, { body: { expectedRevision: 3, statusId: IDS.status, anchorTaskId: IDS.anchor, placement: 'after', ...extra } }), 400, 'VALIDATION_FAILED');
    }
    expect(calls).toHaveLength(2);
  });

  it('refuses to send a service result that breaks the response contract', async () => {
    overrides.set('getTask', () => ({ ...task, visibility: 'private' }));
    expectRejected(await send(app, routeFor('getTask')), 500, 'INTERNAL_ERROR');
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

    expect((await send(app, routeFor('createTag'), { headers: { cookie } })).statusCode).toBe(201);
    expect(calls[0]?.ctx.actor.userId).toBe(FIXTURE_USER_IDS.memberA);
  });

  it('does not register task routes without a task service or database', async () => {
    const p0 = await createApp(config(), { accessRepository: repository, readiness, logger: false, webDistDir: null });
    try {
      expectRejected(await send(p0, routeFor('listProjects')), 404, 'NOT_FOUND');
    } finally {
      await p0.close();
    }
  });
  it('forwards explicit assignee moves including group-end without coalescing null to omission', async () => {
    const route = routeFor('moveTask');
    const body = { expectedRevision: 3, anchorTaskId: null, placement: 'after', responsibleMembershipId: null };
    const result = await send(app, route, { body });
    expect(result.statusCode).toBe(200);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.args).toEqual([IDS.task, body]);
    expectRejected(await send(app, route, { body: { ...body, placement: 'before' } }), 400, 'VALIDATION_FAILED');
    expectRejected(await send(app, route, { body: { expectedRevision: 3, anchorTaskId: null, placement: 'after' } }), 400, 'VALIDATION_FAILED');
    expect(calls).toHaveLength(1);
  });

  it('delegates an opt-in heterogeneous inverse without changing its guarded parsed body', async () => {
    const route = routeFor('bulkUpdateTasks');
    const body = { projectId: IDS.project, includeFieldValueAck: true, tasks: [{ taskId: IDS.task, expectedRevision: 3, expectedParticipantsRevision: 2 }], changes: { restore: [{ taskId: IDS.task, changes: { participantMembershipIds: [], dueDate: null } }] } };
    const response = await send(app, route, { body }); expect(response.statusCode).toBe(200);
    expect(calls[0]?.args).toEqual([body]);
    calls.length = 0;
    expectRejected(await send(app, route, { body: { ...body, changes: { restore: [], dueDate: null } } }), 400, 'VALIDATION_FAILED');
    expect(calls).toHaveLength(0);
  });

  it('rejects invalid entire bulk selections and missing identity protection before one domain call', async () => {
    const route = routeFor('bulkUpdateTasks');
    const body = route.body as { projectId: string; tasks: { taskId: string; expectedRevision: number }[]; changes: object };
    for (const invalid of [
      { ...body, tasks: [] }, { ...body, tasks: [...body.tasks, ...body.tasks] },
      { ...body, tasks: [{ taskId: IDS.task, expectedRevision: 0 }] },
      { ...body, changes: {} }, { ...body, changes: { participantMembershipIds: [] } },
      { ...body, changes: { dueDate: '2026-02-30' } }, { ...body, workspaceId: W },
    ]) expectRejected(await send(app, route, { body: invalid }), 400, 'VALIDATION_FAILED');
    expectRejected(await send(app, route, { idempotencyKey: null }), 400, 'VALIDATION_FAILED');
    expectRejected(await send(app, route, { headers: { origin: 'http://evil.example' } }), 403, 'ORIGIN_NOT_ALLOWED');
    expect(calls).toHaveLength(0);
    overrides.set('bulkUpdateTasks', () => { throw new DomainError('REVISION_CONFLICT', 'Synthetic later-row conflict'); });
    expectRejected(await send(app, route), 409, 'REVISION_CONFLICT');
    expect(calls).toHaveLength(1);
  });

});
