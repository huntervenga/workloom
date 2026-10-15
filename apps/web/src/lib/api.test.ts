import {
  createProjectInputSchema,
  meResponseSchema,
  projectResponseSchema,
  updateProjectInputSchema,
  workspaceResponseSchema,
} from '@workloom/contracts';
import { describe, expect, it, vi } from 'vitest';
import { alpha, failure, installFakeApi, json, ok, project } from '../test/fakeApi';
import { ApiError, apiGet, apiMutate, prepareMutation } from './api';
import { describeError } from './errors';
import { IdempotencyKeyTracker } from './idempotency';

const leakyMessage = "duplicate key: select * from users where password = 'hunter2' -- postgres://admin:s3cret@db";

function stubFetch(response: Response | (() => Promise<Response>)) {
  const fetchMock = vi.fn(async () => (typeof response === 'function' ? response() : response));
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

async function captureError(promise: Promise<unknown>): Promise<ApiError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof ApiError) return error;
    throw error;
  }
  throw new Error('Expected the request to fail');
}

describe('apiGet', () => {
  it('returns contract-validated data and sends same-origin credentials only', async () => {
    const fetchMock = stubFetch(ok(alpha));

    const result = await apiGet(`/api/v1/workspaces/${alpha.id}`, workspaceResponseSchema);

    expect(result.data).toEqual(alpha);
    expect(fetchMock).toHaveBeenCalledWith(
      `/api/v1/workspaces/${alpha.id}`,
      expect.objectContaining({ method: 'GET', credentials: 'same-origin' }),
    );
  });

  it('keeps only status, code and request ID from an error body', async () => {
    stubFetch(failure(500, 'INTERNAL_ERROR', leakyMessage));

    const error = await captureError(apiGet('/api/v1/workspaces', workspaceResponseSchema));

    expect(error).toMatchObject({ kind: 'server', status: 500, code: 'INTERNAL_ERROR', requestId: 'req_test_err' });
    expect(JSON.stringify({ ...error, message: error.message })).not.toMatch(/hunter2|s3cret|select \*/);

    const described = describeError(error, 'workspaces');
    expect(`${described.title} ${described.description}`).not.toMatch(/hunter2|s3cret|select|duplicate/);
    expect(described.retryable).toBe(true);
  });

  it('drops codes and request IDs that do not look like tokens', async () => {
    stubFetch(
      json(500, {
        error: { code: '<img src=x onerror=alert(1)>', message: leakyMessage, retryable: false },
        meta: { requestId: 'req 1; DROP TABLE users' },
      }),
    );

    const error = await captureError(apiGet('/api/v1/workspaces', workspaceResponseSchema));

    expect(error.code).toBeNull();
    expect(error.requestId).toBeNull();
  });

  it('reports a network failure without details', async () => {
    stubFetch(() => Promise.reject(new TypeError('connect ECONNREFUSED 127.0.0.1:4310')));

    const error = await captureError(apiGet('/api/v1/me', meResponseSchema));

    expect(error.kind).toBe('network');
    expect(error.message).not.toContain('ECONNREFUSED');
  });

  it('rejects a successful response that does not match the contract', async () => {
    stubFetch(new Response('<!doctype html><title>SPA</title>', { status: 200, headers: { 'content-type': 'text/html' } }));

    const error = await captureError(apiGet('/api/v1/workspaces', workspaceResponseSchema));

    expect(error.kind).toBe('invalid_response');
  });
});

describe('apiMutate', () => {
  const projectId = 'e0000000-0000-4000-8000-000000000001';
  const path = `/api/v1/workspaces/${alpha.id}/projects/${projectId}`;
  const key = '0b6a3c1e-5d2f-4a7b-9c8d-1e2f3a4b5c6d';
  const renamed = project(alpha.id, projectId, 'Запуск', 2);
  const update = (input: unknown) => ({
    method: 'PATCH' as const,
    path,
    input,
    inputSchema: updateProjectInputSchema,
    responseSchema: projectResponseSchema,
  });

  it('sends one PATCH with the given Idempotency-Key, the schema-parsed body and no identity headers', async () => {
    const { calls } = installFakeApi({ [`PATCH ${path}`]: () => ok(renamed) });

    const result = await apiMutate(update({ expectedRevision: 1, name: '  Запуск ' }), { idempotencyKey: key });

    expect(result.data).toEqual(renamed);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ method: 'PATCH', credentials: 'same-origin', body: { expectedRevision: 1, name: 'Запуск' } });
    expect(calls[0]?.headers.get('idempotency-key')).toBe(key);
    expect([...(calls[0]?.headers.keys() ?? [])].filter((name) => /actor|x-workloom/i.test(name))).toEqual([]);
  });

  it('never sends input the strict contract schema rejects, nor a write without a UUID key', async () => {
    const { calls } = installFakeApi({ [`PATCH ${path}`]: () => ok(renamed) });

    const error = await captureError(apiMutate(update({ expectedRevision: 1, name: 'Запуск', actor: alpha.id }), { idempotencyKey: key }));
    await expect(apiMutate(update({ expectedRevision: 1, name: 'Запуск' }), { idempotencyKey: 'retry-1' })).rejects.toThrow(
      TypeError,
    );

    expect(error.kind).toBe('invalid_input');
    expect(calls).toHaveLength(0);
  });

  it('reports a failed write once, keeping no server text, and does not offer to resend a conflict', async () => {
    const { calls } = installFakeApi({ [`PATCH ${path}`]: () => failure(409, 'REVISION_CONFLICT', leakyMessage) });

    const error = await captureError(apiMutate(update({ expectedRevision: 1, name: 'Запуск' }), { idempotencyKey: key }));

    expect(calls).toHaveLength(1);
    expect(error).toMatchObject({ kind: 'conflict', status: 409, code: 'REVISION_CONFLICT', requestId: 'req_test_err' });
    expect(JSON.stringify({ ...error, message: error.message })).not.toMatch(/hunter2|s3cret|select \*/);
    const described = describeError(error, 'projectSave');
    expect(described.retryable).toBe(false);
    expect(`${described.title} ${described.description}`).not.toMatch(/hunter2|s3cret|select|duplicate/);
  });
});

describe('IdempotencyKeyTracker', () => {
  it('reuses a key only while the identical request is resubmitted and not yet confirmed', () => {
    const create = (input: unknown) =>
      prepareMutation({
        method: 'POST',
        path: `/api/v1/workspaces/${alpha.id}/projects`,
        input,
        inputSchema: createProjectInputSchema,
        responseSchema: projectResponseSchema,
      }).fingerprint;
    const tracker = new IdempotencyKeyTracker();

    const first = tracker.keyFor(create({ name: 'Запуск' }));
    // The same request after schema normalization is a retry of the same operation.
    expect(tracker.keyFor(create({ name: '  Запуск ' }))).toBe(first);

    const changed = tracker.keyFor(create({ name: 'Запуск сайта' }));
    expect(changed).not.toBe(first);

    tracker.complete(create({ name: 'Запуск сайта' }));
    expect(tracker.keyFor(create({ name: 'Запуск сайта' }))).not.toBe(changed);
  });
});

describe('describeError', () => {
  it('describes a hidden or missing workspace the same way and without retry', () => {
    const notFound = describeError(new ApiError({ kind: 'not_found', status: 404 }), 'workspace');
    const forbidden = describeError(new ApiError({ kind: 'forbidden', status: 403 }), 'workspace');

    expect(notFound).toEqual(forbidden);
    expect(notFound).toMatchObject({ title: 'Пространство недоступно', unavailable: true, retryable: false });
  });
});
