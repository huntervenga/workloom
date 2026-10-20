import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type * as C from '@workloom/contracts';
import type { AccessRepository, CommandContext, DuplicationApplication } from '@workloom/domain';
import { createApp } from '../app.js';
import { loadConfig } from '../config.js';
const id = (n: number) => `d0000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const copy = { description: true, assignee: true, dates: true, tags: true, priority: true, participants: true, subtasks: true, customFieldIds: [] };
const actor = { userId: id(9), displayName: 'Authenticated synthetic actor', kind: 'fixture' as const };
const preview: C.DuplicationPreviewDto = { kind: 'task', sourceId: id(2), projectId: id(3), sourceVersion: 'a'.repeat(64), name: 'Copy', taskCount: 1, customValueCount: 0, copyableFields: [], settings: null };
const result: C.DuplicationResultDto = { kind: 'task', projectId: id(3), rootTaskId: id(4), section: null, taskIds: [id(4)] };
const opened: FastifyInstance[] = [];
afterEach(async () => { await Promise.all(opened.splice(0).map(app => app.close())); });
async function setup() {
  const calls: { kind: string; ctx: CommandContext; sourceId: string; input: unknown }[] = [];
  const call = (kind: string, ctx: CommandContext, sourceId: string, input: unknown) => { calls.push({ kind, ctx, sourceId, input }); };
  const duplication: DuplicationApplication = {
    previewTask: async (ctx, sourceId, input) => { call('task.preview', ctx, sourceId, input); return preview; },
    duplicateTask: async (ctx, sourceId, input) => { call('task.copy', ctx, sourceId, input); return result; },
    previewSection: async (ctx, sourceId, input) => { call('section.preview', ctx, sourceId, input); return { ...preview, kind: 'section' }; },
    duplicateSection: async (ctx, sourceId, input) => { call('section.copy', ctx, sourceId, input); return { ...result, kind: 'section', rootTaskId: null }; },
  };
  const identity = { mode: 'dev' as const, resolveActor: vi.fn(async () => actor) };
  const repository: AccessRepository = { findUser: async () => null, findUsers: async () => [], listAccessibleWorkspaces: async () => [], findWorkspaceAccess: async () => null, listActiveMemberships: async () => [] };
  const config = loadConfig({ APP_ENV: 'local', AUTH_MODE: 'dev', PORT: '4310', DATABASE_URL: 'postgres://unused:unused@127.0.0.1:5432/unused' });
  const app = await createApp(config, { accessRepository: repository, identityAdapter: identity, readiness: { check: async () => ({ ready: true, checks: { database: 'ok', schema: 'ok' } }) }, duplicationApplication: duplication, logger: false, webDistDir: null });
  opened.push(app);
  const post = (path: string, payload: unknown, extra: Record<string, string> = {}) => app.inject({ method: 'POST', url: `/api/v1/workspaces/${id(1)}/${path}`, headers: { host: '127.0.0.1:4310', origin: 'http://127.0.0.1:4310', 'content-type': 'application/json', ...extra }, payload: JSON.stringify(payload) });
  return { post, calls, identity };
}
describe('strict duplication HTTP adapters through actual application guards', () => {
  it('previews without a write key and writes only with one trusted actor/workspace and the source digest', async () => {
    const h = await setup(), input = { projectId: id(3), title: 'Copy', copy };
    expect((await h.post(`tasks/${id(2)}/duplicate-preview`, input)).statusCode).toBe(200);
    expect(h.calls[0]).toMatchObject({ kind: 'task.preview', ctx: { workspaceId: id(1), actor, source: 'web' }, sourceId: id(2), input });
    expect(h.calls[0]?.ctx.idempotencyKey).toBeUndefined();
    const response = await h.post(`tasks/${id(2)}/duplicate`, { ...input, expectedSourceVersion: preview.sourceVersion }, { 'idempotency-key': 'one-copy' });
    expect(response.statusCode).toBe(201); expect(response.json().data).toEqual(result);
    expect(h.calls[1]?.ctx.idempotencyKey).toBe('one-copy');
    expect(h.calls[1]?.input).toEqual({ ...input, expectedSourceVersion: preview.sourceVersion });
  });
  it('rejects missing write keys, stale-format/injected inputs and untrusted origins before a domain call', async () => {
    const h = await setup(), input = { projectId: id(3), title: 'Copy', copy, expectedSourceVersion: preview.sourceVersion };
    expect((await h.post(`tasks/${id(2)}/duplicate`, input)).statusCode).toBe(400);
    expect((await h.post(`tasks/${id(2)}/duplicate-preview`, { ...input, actorUserId: id(99) })).statusCode).toBe(400);
    expect((await h.post(`tasks/${id(2)}/duplicate-preview`, { projectId: id(3), title: 'Copy', copy }, { origin: 'https://untrusted.example' })).statusCode).toBe(403);
    expect(h.calls).toHaveLength(0);
  });
  it('uses separate strict section methods and never accepts task arrays or server-selected source data', async () => {
    const h = await setup(), input = { name: 'Copy section', includeTasks: true, includeSettings: true, copy };
    expect((await h.post(`sections/${id(2)}/duplicate-preview`, input)).statusCode).toBe(200);
    expect((await h.post(`sections/${id(2)}/duplicate`, { ...input, expectedSourceVersion: preview.sourceVersion }, { 'idempotency-key': 'section-copy' })).statusCode).toBe(201);
    expect(h.calls.map(call => call.kind)).toEqual(['section.preview', 'section.copy']);
    expect((await h.post(`sections/${id(2)}/duplicate-preview`, { ...input, tasks: [] })).statusCode).toBe(400);
    expect(h.calls).toHaveLength(2);
  });
});
