import { Readable } from 'node:stream';
import {
  MAX_ATTACHMENT_BYTES, MAX_AVATAR_BYTES, attachmentDownloadResponseSchema, attachmentPreviewResponseSchema, deleteAttachmentInputSchema, idSchema,
  reserveAttachmentInputSchema, serverFeaturesResponseSchema, taskAttachmentResponseSchema, taskAttachmentsResponseSchema,
} from '@workloom/contracts';
import { toCommandContext, temporarilyUnavailableError, unauthenticatedError, type AttachmentRecord, type CommandContext } from '@workloom/domain';
import type { AttachmentStore } from '@workloom/db';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { attachmentFeature, type AttachmentConfig } from '../attachments/config.js';
import type { AttachmentStorage } from '../attachments/storage.js';
import type { IdentityAdapter } from '../identity/identity-adapter.js';
import { parseInput, sendData } from './envelope.js';
import { HttpError } from './errors.js';
import { createRateLimiter } from './rate-limit.js';
import { readIdempotencyKey } from './task-routes.js';

const base = '/api/v1/workspaces/:workspaceId/tasks/:taskId/attachments';
const paramsSchema = z.strictObject({ workspaceId: idSchema, taskId: idSchema, attachmentId: idSchema.optional() });
interface Dependencies { avatarAvailable?: boolean; identity: IdentityAdapter; config?: AttachmentConfig | undefined; store?: AttachmentStore | undefined; storage?: AttachmentStorage | undefined }

/** Features are available even when storage is absent; no S3 operation is performed at startup. */
export function registerAttachmentRoutes(app: FastifyInstance, deps: Dependencies): void {
  const feature = attachmentFeature(deps.config);
  app.get('/api/v1/features', async (request, reply) => {
    await deps.identity.resolveActor(request);
    reply.header('cache-control', 'private, no-store');
    return sendData(request, reply, serverFeaturesResponseSchema, { features: { taskAttachments: feature,
      userAvatars: { enabled: feature.enabled && deps.avatarAvailable === true, reason: feature.enabled && deps.avatarAvailable ? null : feature.reason ?? 'storage_not_configured',
        maxFileSizeBytes: MAX_AVATAR_BYTES, acceptedTypes: ['image/jpeg', 'image/png', 'image/webp'] } } });
  });
  const store = deps.store;
  if (!store) return;
  const service = store.application;
  const storage = () => { if (!feature.enabled || !deps.storage) throw temporarilyUnavailableError(); return deps.storage; };
  const limiter = createRateLimiter({ limit: 30, windowMs: 60_000, maxKeys: 1000 });
  const uploads = new Map<string, number>();
  let uploadCount = 0;
  const acquire = (actorId: string) => {
    const count = uploads.get(actorId) ?? 0;
    if (count >= 2 || uploadCount >= 8) throw new HttpError(429, 'RATE_LIMITED', 'Too many uploads. Retry shortly.', undefined, { retryable: true });
    uploads.set(actorId, count + 1); uploadCount++;
    let released = false;
    return () => { if (released) return; released = true; uploadCount--; const next = (uploads.get(actorId) ?? 1) - 1; if (next) uploads.set(actorId, next); else uploads.delete(actorId); };
  };
  async function context(request: FastifyRequest, key?: string) {
    const params = parseInput(paramsSchema, request.params);
    const actor = await deps.identity.resolveActor(request);
    return { ...params, ctx: toCommandContext({ actor, source: 'web', requestId: request.id }, params.workspaceId, key) };
  }
  void app.register(async routes => {
    routes.addHook('onRequest', async (_request, reply) => { reply.header('cache-control', 'private, no-store'); });
    routes.get(base, async (request, reply) => {
      const { ctx, taskId } = await context(request);
      const data = await service.list(ctx, taskId);
      return sendData(request, reply, taskAttachmentsResponseSchema, { ...data, canUpload: data.canUpload && feature.enabled });
    });
    routes.get(`${base}/:attachmentId`, async (request, reply) => {
      const { ctx, taskId, attachmentId } = await context(request);
      return sendData(request, reply, taskAttachmentResponseSchema, await service.get(ctx, taskId, attachmentId ?? ''));
    });
    routes.post(base, async (request, reply) => {
      const { ctx, taskId } = await context(request, readIdempotencyKey(request));
      const input = parseInput(reserveAttachmentInputSchema, request.body);
      if (!limiter.check(ctx.actor.userId).allowed) throw new HttpError(429, 'RATE_LIMITED', 'Too many upload attempts. Retry shortly.');
      return sendData(request, reply, taskAttachmentResponseSchema, await service.reserve(ctx, taskId, input, storage().storageId), { statusCode: 201 });
    });
    routes.post(`${base}/:attachmentId/download-url`, async (request, reply) => {
      const { ctx, taskId, attachmentId } = await context(request);
      // Never consult the URL cache before current session + membership + task + ready checks.
      const row = await service.download(ctx, taskId, attachmentId ?? '');
      return sendData(request, reply, attachmentDownloadResponseSchema, await storage().signDownload(row));
    });
    routes.post(`${base}/:attachmentId/preview-url`, async (request, reply) => {
      const { ctx, taskId, attachmentId } = await context(request);
      // Preview has exactly the same current read authorization as a download, including on cache hits.
      const row = await service.download(ctx, taskId, attachmentId ?? '');
      return sendData(request, reply, attachmentPreviewResponseSchema, await storage().signPreview(row));
    });
    routes.delete(`${base}/:attachmentId`, async (request, reply) => {
      const { ctx, taskId, attachmentId } = await context(request, readIdempotencyKey(request));
      const input = parseInput(deleteAttachmentInputSchema, request.body);
      const result = await service.remove(ctx, taskId, attachmentId ?? '', input);
      deps.storage?.invalidate(result.id);
      return sendData(request, reply, taskAttachmentResponseSchema, result);
    });

    await routes.register(async binary => {
      // Scoped parser returns a stream without buffering; the storage adapter counts actual bytes.
      binary.addContentTypeParser('application/octet-stream', (_request, payload, done) => { done(null, payload); });
      const state = new WeakMap<FastifyRequest, { row: AttachmentRecord; ctx: CommandContext; controller: AbortController; release(): void; timer: ReturnType<typeof setTimeout> }>();
      const release = (request: FastifyRequest) => { const item = state.get(request); if (!item) return; clearTimeout(item.timer); item.controller.abort(); item.release(); state.delete(request); };
      binary.addHook('onResponse', async request => { release(request); });
      binary.addHook('onError', async request => { release(request); });
      binary.put(`${base}/:attachmentId/content`, {
        bodyLimit: MAX_ATTACHMENT_BYTES,
        onRequest: async request => {
          storage();
          const { ctx, taskId, attachmentId } = await context(request);
          const expected = request.headers['x-workloom-expected-actor'];
          if (typeof expected !== 'string' || expected.toLowerCase() !== ctx.actor.userId) throw unauthenticatedError();
          if (request.headers['content-type']?.split(';')[0]?.trim() !== 'application/octet-stream' ||
              (request.headers['content-encoding'] && request.headers['content-encoding'] !== 'identity')) {
            throw new HttpError(415, 'UNSUPPORTED_MEDIA_TYPE', 'Send an unencoded binary file.');
          }
          const length = request.headers['content-length'];
          if (length !== undefined && (!/^\d+$/.test(length) || Number(length) > MAX_ATTACHMENT_BYTES)) throw new HttpError(413, 'PAYLOAD_TOO_LARGE', 'The file is too large.');
          const free = acquire(ctx.actor.userId);
          try {
            const row = await service.startUpload(ctx, taskId, attachmentId ?? '');
            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), Math.max(1, Date.parse(row.uploadExpiresAt) - Date.now()));
            timer.unref();
            state.set(request, { row, ctx, controller, timer, release: free });
            request.raw.once('aborted', () => controller.abort());
          } catch (error) { free(); throw error; }
        },
      }, async (request, reply) => {
        const item = state.get(request);
        if (!item || !(request.body instanceof Readable)) throw new HttpError(400, 'BAD_REQUEST', 'A binary file is required.');
        try {
          const result = await storage().upload(item.row, request.body, item.controller.signal);
          await store.recordStored(item.row, result.versionId);
          const actor = await deps.identity.resolveActor(request);
          if (actor.userId !== item.ctx.actor.userId) throw unauthenticatedError();
          const updated = await service.finishUpload({ ...item.ctx, actor }, item.row, result);
          return sendData(request, reply, taskAttachmentResponseSchema, updated);
        } catch (error) {
          await store.failUpload(item.row).catch(() => undefined); // pre-recorded cleanup still survives a DB outage
          throw error;
        } finally { release(request); }
      });
    });
  });
}

/** Durable cleanup runs in the API process only when the optional storage is configured. */
export function registerAttachmentMaintenance(app: FastifyInstance, store: AttachmentStore, storage: AttachmentStorage): void {
  let running: Promise<void> | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;
  let closed = false;
  const tick = () => {
    if (closed || running) return;
    running = (async () => {
      const jobs = await store.claimCleanup(storage.storageId);
      await Promise.all(jobs.map(async job => {
        let success = false;
        try { await storage.remove(job.objectKey, job.versionId); success = true; } catch { /* retry is persisted below */ }
        await store.completeCleanup(job, success);
      }));
    })().catch(() => { app.log.warn({ code: 'ATTACHMENT_CLEANUP_RETRY' }, 'Attachment cleanup will retry.'); }).finally(() => { running = undefined; });
  };
  app.addHook('onReady', async () => { timer = setInterval(tick, 60_000); timer.unref(); tick(); });
  app.addHook('onClose', async () => { closed = true; clearInterval(timer); await running; storage.close(); });
}
