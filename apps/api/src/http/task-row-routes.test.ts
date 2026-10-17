import { request as httpRequest } from 'node:http';
import type { AddressInfo } from 'node:net';

import { taskRowResponseSchema, type CreateTaskRowInput, type TaskDto, type TaskRowCreatedDto } from '@workloom/contracts';
import type { ReadinessProbe } from '@workloom/db';
import type { AccessRepository, Actor, CommandContext, TaskRowApplication } from '@workloom/domain';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';

import { createApp } from '../app.js';
import { loadConfig } from '../config.js';
import type { IdentityAdapter } from '../identity/identity-adapter.js';
import { TASK_ROW_BODY_LIMIT_BYTES } from './task-row-routes.js';

// Real createApp over a real loopback TCP listener; a recording TaskRowApplication stands in for the
// domain service and no database is opened. Proves the transport (route cap, guards, strict input,
// trusted context), not the domain's atomic claim.

const TS = '2026-10-16T09:00:00.000Z';
const id = (n: number) => `c0000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const W = id(1);
const IDS = { project: id(2), status: id(3), task: id(4), workPackage: id(5), anchor: id(6) };
const ROWS_PATH = `/api/v1/workspaces/${W}/tasks/rows`;

const task: TaskDto = {
  id: IDS.task,
  meetingId: null,
  workspaceId: W,
  projectId: IDS.project,
  sectionId: null,
  parentTaskId: null,
  workPackageId: IDS.workPackage,
  workPackageRevision: 1,
  title: 'Row task',
  description: '',
  statusId: IDS.status,
  responsibleMembershipId: null,
  participants: [],
  participantsRevision: 1,
  startDate: null,
  dueDate: null,
  priority: 'medium',
  tags: [],
  estimateMinutes: null,
  revision: 1,
  position: 0,
  visibility: 'workspace',
  archivedAt: null,
  createdAt: TS,
  updatedAt: TS,
};
const created: TaskRowCreatedDto = { task, fields: [] };

const fixtureActor: Actor = { userId: id(10), displayName: 'Fixture person', kind: 'fixture' };
const sharedActor: Actor = { userId: id(11), displayName: 'Verified person', kind: 'real' };

const repository: AccessRepository = {
  findUser: async () => null,
  findUsers: async () => [],
  listAccessibleWorkspaces: async () => [],
  findWorkspaceAccess: async () => null,
  listActiveMemberships: async () => [],
};
const readiness: ReadinessProbe = { check: async () => ({ ready: true, checks: { database: 'ok', schema: 'ok' } }) };

interface Harness {
  readonly app: FastifyInstance;
  readonly origin: string;
  readonly rowCalls: { ctx: CommandContext; input: CreateTaskRowInput }[];
  readonly identityCalls: { count: number };
}

const apps: FastifyInstance[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

async function start(mode: IdentityAdapter['mode'] = 'dev'): Promise<Harness> {
  const rowCalls: Harness['rowCalls'] = [];
  const identityCalls = { count: 0 };
  const identity: IdentityAdapter = {
    mode,
    resolveActor: async () => {
      identityCalls.count += 1;
      return mode === 'shared' ? sharedActor : fixtureActor;
    },
  };
  const rows: TaskRowApplication = {
    createRow: async (ctx, input) => {
      rowCalls.push({ ctx, input });
      return created;
    },
  };
  const config = loadConfig({ APP_ENV: 'local', AUTH_MODE: 'dev', PORT: '0', DATABASE_URL: 'postgres://u:p@127.0.0.1:5432/unused' });
  const app = await createApp(config, {
    accessRepository: repository,
    readiness,
    identityAdapter: identity,
    taskRowApplication: rows,
    logger: false,
    webDistDir: null,
  });
  apps.push(app);
  await app.listen({ host: '127.0.0.1', port: 0 });
  const { port } = app.server.address() as AddressInfo;
  return { app, origin: `http://127.0.0.1:${port}`, rowCalls, identityCalls };
}

interface RawResponse {
  readonly status: number;
  readonly json: unknown;
}

/** Real TCP request with an explicit Content-Length; resolves once the full response is read. */
function post(h: Harness, path: string, body: string, headers: Record<string, string> = {}): Promise<RawResponse> {
  const url = new URL(path, h.origin);
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      url,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'content-length': String(Buffer.byteLength(body)),
          origin: h.origin,
          'idempotency-key': 'row-key-1',
          ...headers,
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          resolve({ status: res.statusCode ?? 0, json: text === '' ? null : JSON.parse(text) });
        });
        res.on('error', reject);
      },
    );
    req.on('error', reject);
    req.end(body);
  });
}

function textFields(count: number, length: number): NonNullable<CreateTaskRowInput['fields']> {
  return Array.from({ length: count }, (_, index) => ({
    fieldId: id(1000 + index),
    expectedDefinitionRevision: 1,
    value: { type: 'text' as const, value: 'x'.repeat(length) },
  }));
}

const baseTask = { projectId: IDS.project, title: 'Row task', statusId: IDS.status };

describe('POST /api/v1/workspaces/:workspaceId/tasks/rows', () => {
  it('forwards the strict body and trusted context exactly once and answers 201 in the normal envelope', async () => {
    const h = await start();
    const input = { task: { ...baseTask, insertion: { anchorTaskId: IDS.anchor, placement: 'after' } } };
    const response = await post(h, ROWS_PATH, JSON.stringify(input));

    expect(response.status).toBe(201);
    const body = taskRowResponseSchema.parse(response.json);
    expect(body.data).toEqual(created);
    expect(h.identityCalls.count).toBe(1);
    expect(h.rowCalls).toHaveLength(1);
    expect(h.rowCalls[0]?.input).toEqual(input);
    expect(h.rowCalls[0]?.ctx).toMatchObject({
      actor: fixtureActor,
      source: 'web',
      requestId: body.meta.requestId,
      workspaceId: W,
      idempotencyKey: 'row-key-1',
    });
  });

  it('accepts a body above the global 16 KiB limit and below the 1 MiB route cap', async () => {
    const h = await start();
    for (const count of [2, 3]) {
      const payload = JSON.stringify({ task: baseTask, fields: textFields(count, 10_000) });
      expect(Buffer.byteLength(payload)).toBeGreaterThan(16 * 1024);
      expect(Buffer.byteLength(payload)).toBeLessThan(TASK_ROW_BODY_LIMIT_BYTES);
      const response = await post(h, ROWS_PATH, payload, { 'idempotency-key': `row-key-${count}` });
      expect(response.status).toBe(201);
    }
    expect(h.rowCalls.map((call) => call.input.fields?.length)).toEqual([2, 3]);
  });

  it('rejects a body above 1 MiB with a structured 413 before identity or the domain is reached', async () => {
    const h = await start();
    expect(TASK_ROW_BODY_LIMIT_BYTES).toBe(1024 * 1024);
    const payload = JSON.stringify({ task: baseTask, fields: textFields(200, 10_000) });
    expect(Buffer.byteLength(payload)).toBeGreaterThan(TASK_ROW_BODY_LIMIT_BYTES);

    const response = await post(h, ROWS_PATH, payload);
    expect(response.status).toBe(413);
    expect(response.json).toMatchObject({ error: { code: 'PAYLOAD_TOO_LARGE', retryable: false }, meta: { requestId: expect.any(String) } });
    expect(response.json).not.toHaveProperty('data');
    expect(h.identityCalls.count).toBe(0);
    expect(h.rowCalls).toHaveLength(0);
  });

  it('keeps the global 16 KiB parser limit for other routes', async () => {
    const h = await start();
    const payload = JSON.stringify({ actorId: 'x'.repeat(20 * 1024) });
    const response = await post(h, '/api/v1/dev/session', payload);
    expect(response.status).toBe(413);
    expect(response.json).toMatchObject({ error: { code: 'PAYLOAD_TOO_LARGE' } });
    expect(h.identityCalls.count).toBe(0);
    expect(h.rowCalls).toHaveLength(0);
  });

  it('requires a valid Idempotency-Key and never calls the domain without one', async () => {
    const h = await start();
    const payload = JSON.stringify({ task: baseTask });
    const missing = await new Promise<RawResponse>((resolve, reject) => {
      const req = httpRequest(
        new URL(ROWS_PATH, h.origin),
        { method: 'POST', headers: { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(payload)), origin: h.origin } },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (chunk: Buffer) => chunks.push(chunk));
          res.on('end', () => resolve({ status: res.statusCode ?? 0, json: JSON.parse(Buffer.concat(chunks).toString('utf8')) }));
        },
      );
      req.on('error', reject);
      req.end(payload);
    });
    expect(missing.status).toBe(400);
    expect(missing.json).toMatchObject({ error: { code: 'VALIDATION_FAILED' } });

    for (const key of ['has space', 'k'.repeat(129)]) {
      const response = await post(h, ROWS_PATH, payload, { 'idempotency-key': key });
      expect(response.status).toBe(400);
    }
    expect(h.rowCalls).toHaveLength(0);
  });

  it('rejects an untrusted Origin with 403 before any call', async () => {
    const h = await start();
    const response = await post(h, ROWS_PATH, JSON.stringify({ task: baseTask }), { origin: 'http://evil.example' });
    expect(response.status).toBe(403);
    expect(response.json).toMatchObject({ error: { code: 'ORIGIN_NOT_ALLOWED' } });
    expect(h.identityCalls.count).toBe(0);
    expect(h.rowCalls).toHaveLength(0);
  });

  it('rejects unknown body fields, invalid parts and a non-UUID workspace without calling the domain', async () => {
    const h = await start();
    const bodies: unknown[] = [
      {},
      { task: baseTask, extra: true },
      { task: { ...baseTask, workspaceId: W } },
      { task: baseTask, fields: [{ fieldId: id(1000), expectedDefinitionRevision: 1, value: { type: 'text', value: 'a' }, extra: 1 }] },
      { task: baseTask, fields: [...textFields(1, 1), ...textFields(1, 1)] },
      { task: baseTask, fields: textFields(201, 1) },
      { task: baseTask, fields: textFields(1, 10_001) },
      { task: baseTask, plan: { periodId: id(20), membershipId: id(21), expectedRevision: null, plannedMinutes: 30, actorId: id(22) } },
      { task: baseTask, actual: { periodId: id(20), membershipId: id(21), minutes: 15, recordedBy: id(22) } },
      { task: { ...baseTask, position: 0, insertion: { anchorTaskId: IDS.anchor, placement: 'before' } } },
    ];
    for (const [index, body] of bodies.entries()) {
      const response = await post(h, ROWS_PATH, JSON.stringify(body), { 'idempotency-key': `bad-${index}` });
      expect(response.status).toBe(400);
      expect(response.json).toMatchObject({ error: { code: 'VALIDATION_FAILED' } });
    }

    const badWorkspace = await post(h, '/api/v1/workspaces/not-a-uuid/tasks/rows', JSON.stringify({ task: baseTask }));
    expect(badWorkspace.status).toBe(400);
    expect(h.identityCalls.count).toBe(0);
    expect(h.rowCalls).toHaveLength(0);
  });

  it('is registered for shared identity too and binds the resolved shared actor', async () => {
    const h = await start('shared');
    const response = await post(h, ROWS_PATH, JSON.stringify({ task: baseTask }));
    expect(response.status).toBe(201);
    expect(h.identityCalls.count).toBe(1);
    expect(h.rowCalls).toHaveLength(1);
    expect(h.rowCalls[0]?.ctx.actor).toEqual(sharedActor);
  });
});
