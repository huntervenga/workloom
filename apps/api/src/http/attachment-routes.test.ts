import type { Readable } from 'node:stream';
import Fastify from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { attachmentDto, notFoundError, unauthenticatedError, type Actor, type AttachmentRecord } from '@workloom/domain';
import type { AttachmentStore } from '@workloom/db';
import { loadAttachmentConfig } from '../attachments/config.js';
import type { AttachmentStorage } from '../attachments/storage.js';
import { registerAttachmentRoutes } from './attachment-routes.js';
import { mapError } from './errors.js';

const actor: Actor = { userId: '10000000-0000-4000-8000-000000000004', displayName: 'Test', kind: 'fixture' };
const row: AttachmentRecord = { id: '10000000-0000-4000-8000-000000000001', workspaceId: '10000000-0000-4000-8000-000000000002', taskId: '10000000-0000-4000-8000-000000000003',
  uploadedByUserId: actor.userId, fileName: 'test.txt', sizeBytes: 3, state: 'ready', revision: 3, createdAt: new Date().toISOString(), uploadExpiresAt: new Date(Date.now() + 60_000).toISOString(),
  storageId: 'a'.repeat(64), objectKey: 'attachments/test/random', slot: 1, checksum: 'b'.repeat(64), versionId: null };
const base = `/api/v1/workspaces/${row.workspaceId}/tasks/${row.taskId}/attachments`;
const apps: ReturnType<typeof Fastify>[] = [];
afterEach(async () => { await Promise.all(apps.splice(0).map(app => app.close())); });
function setup(enabled = true) {
  const app = Fastify({ logger: false }); apps.push(app);
  app.setErrorHandler((error, _request, reply) => { const mapped = mapError(error); void reply.code(mapped.statusCode).send(mapped.body); });
  const identity = { mode: 'dev' as const, resolveActor: vi.fn(async () => actor) };
  const application = {
    list: vi.fn(async () => ({ items: [attachmentDto(row)], remainingSlots: 4, canUpload: true, canDelete: true })),
    get: vi.fn(async () => attachmentDto(row)), reserve: vi.fn(async () => attachmentDto(row)),
    startUpload: vi.fn(async () => ({ ...row, state: 'uploading' as const, revision: 2 })),
    finishUpload: vi.fn(async () => attachmentDto(row)), remove: vi.fn(async () => ({ ...attachmentDto(row), state: 'deleted' as const })),
    download: vi.fn(async () => row),
  };
  const store: AttachmentStore = { application, recordStored: vi.fn(async () => undefined), failUpload: vi.fn(async () => undefined),
    claimCleanup: vi.fn(async () => []), completeCleanup: vi.fn(async () => undefined) };
  const signed = { url: 'https://objects.example.test/private?signature=test', expiresAt: new Date(Date.now() + 3600_000).toISOString() };
  const storage: AttachmentStorage = { copy: vi.fn(), storageId: row.storageId,
    upload: vi.fn(async (_record, source: Readable) => { for await (const chunk of source) void chunk; return { checksum: 'b'.repeat(64), versionId: null }; }),
    signPreview: vi.fn(async record => ({ ...signed, attachmentId: record.id, kind: 'image' as const, contentType: 'image/png' as const })),
    signDownload: vi.fn(async () => signed), invalidate: vi.fn(), remove: vi.fn(async () => undefined), close: vi.fn() };
  const config = loadAttachmentConfig(enabled ? { ATTACHMENTS_S3_BUCKET: 'test-bucket', ATTACHMENTS_S3_REGION: 'us-east-1', AWS_ACCESS_KEY_ID: 'test', AWS_SECRET_ACCESS_KEY: 'test' } : {}, false);
  registerAttachmentRoutes(app, { identity, store, storage, config });
  // Registering attachment plugins must not prematurely boot the containing application.
  app.get('/other-feature', async () => ({ ok: true }));
  const put = (headers: Record<string, string> = {}) => app.inject({ method: 'PUT', url: `${base}/${row.id}/content`, payload: Buffer.from('abc'),
    headers: { 'content-type': 'application/octet-stream', 'x-workloom-expected-actor': actor.userId, ...headers } });
  return { app, identity, application, store, storage, put };
}

describe('attachment HTTP boundary', () => {
  it('serves other features and attachment metadata with storage disabled', async () => {
    const { app, storage, put } = setup(false);
    expect((await app.inject('/other-feature')).statusCode).toBe(200);
    expect((await app.inject('/api/v1/features')).json().data.features.taskAttachments.enabled).toBe(false);
    const list = await app.inject(base);
    expect(list.json().data.canUpload).toBe(false);
    expect(JSON.stringify(list.json())).not.toContain('objectKey');
    expect((await put()).statusCode).toBe(503);
    expect(storage.upload).not.toHaveBeenCalled();
  }, 15_000);

  it('requires authentication for feature discovery', async () => {
    const { app, identity } = setup(false);
    identity.resolveActor.mockRejectedValue(unauthenticatedError());
    expect((await app.inject('/api/v1/features')).statusCode).toBe(401);
  });

  it('reauthorizes each download before any cached URL can be returned', async () => {
    const { app, application, storage, identity } = setup();
    const request = () => app.inject({ method: 'POST', url: `${base}/${row.id}/download-url` });
    const first = await request();
    expect(first.statusCode).toBe(200);
    expect(first.headers['cache-control']).toBe('private, no-store');
    application.download.mockRejectedValueOnce(notFoundError());
    const revoked = await request();
    expect(revoked.statusCode).toBe(404);
    expect(revoked.body).not.toContain('signature');
    expect(storage.signDownload).toHaveBeenCalledTimes(1);
    identity.resolveActor.mockRejectedValueOnce(unauthenticatedError());
    expect((await request()).statusCode).toBe(401);
    expect(storage.signDownload).toHaveBeenCalledTimes(1);
  });

  it('reauthorizes previews before signing or cache access and binds the response to the attachment', async () => {
    const { app, application, storage, identity } = setup();
    const request = () => app.inject({ method: 'POST', url: `${base}/${row.id}/preview-url` });
    application.download.mockResolvedValue({ ...row, fileName: 'photo.png' });
    const first = await request();
    expect(first.statusCode).toBe(200);
    expect(first.headers['cache-control']).toBe('private, no-store');
    expect(first.json().data).toMatchObject({ attachmentId: row.id, kind: 'image', contentType: 'image/png' });
    expect(storage.signPreview).toHaveBeenCalledWith(expect.objectContaining({ fileName: 'photo.png' }));
    expect(storage.signDownload).not.toHaveBeenCalled();
    application.download.mockRejectedValueOnce(notFoundError());
    expect((await request()).statusCode).toBe(404);
    identity.resolveActor.mockRejectedValueOnce(unauthenticatedError());
    expect((await request()).statusCode).toBe(401);
    expect(storage.signPreview).toHaveBeenCalledTimes(1);
  });

  it('keeps previews unavailable when the optional storage is disabled', async () => {
    const { app, storage } = setup(false);
    const response = await app.inject({ method: 'POST', url: `${base}/${row.id}/preview-url` });
    expect(response.statusCode).toBe(503);
    expect(storage.signPreview).not.toHaveBeenCalled();
  });

  it('streams upload through the API, then rechecks identity before making it ready', async () => {
    const { put, store, application, identity, storage } = setup();
    expect((await put()).statusCode).toBe(200);
    expect(storage.upload).toHaveBeenCalledTimes(1);
    expect(store.recordStored).toHaveBeenCalledTimes(1);
    expect(identity.resolveActor).toHaveBeenCalledTimes(2);
    expect(application.finishUpload).toHaveBeenCalledTimes(1);
  });

  it('retains cleanup after authentication expires during an upload', async () => {
    const { put, store, application, identity } = setup();
    identity.resolveActor.mockResolvedValueOnce(actor).mockRejectedValueOnce(unauthenticatedError());
    expect((await put()).statusCode).toBe(401);
    expect(store.recordStored).toHaveBeenCalledTimes(1);
    expect(store.failUpload).toHaveBeenCalledTimes(1);
    expect(application.finishUpload).not.toHaveBeenCalled();
  });

  it('rejects account changes, oversized headers and encoded bodies before storage writes', async () => {
    const { put, storage, application } = setup();
    expect((await put({ 'x-workloom-expected-actor': row.id })).statusCode).toBe(401);
    expect((await put({ 'content-length': '50000001' })).statusCode).toBe(413);
    expect((await put({ 'content-encoding': 'gzip' })).statusCode).toBe(415);
    expect(storage.upload).not.toHaveBeenCalled();
    expect(application.startUpload).not.toHaveBeenCalled();
  });
});
