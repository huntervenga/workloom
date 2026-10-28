import { MAX_AVATAR_BYTES, changeUserAvatarInputSchema, idSchema, userAvatarResponseSchema } from '@workloom/contracts';
import { temporarilyUnavailableError, unauthenticatedError, type ActorContext } from '@workloom/domain';
import type { UserAvatarStore } from '@workloom/db';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { IdentityAdapter } from '../identity/identity-adapter.js';
import type { AvatarStorage } from '../avatars/storage.js';
import { normalizeAvatar } from '../avatars/image.js';
import { parseInput, sendData } from './envelope.js';
import { HttpError } from './errors.js';
import { createRateLimiter } from './rate-limit.js';

export function registerUserAvatarRoutes(app: FastifyInstance, deps: { identity: IdentityAdapter; store: UserAvatarStore; storage?: AvatarStorage | undefined }): void {
  const noQuery = z.strictObject({}), path = z.strictObject({ userId: idSchema, avatarId: idSchema });
  const context = async (request: FastifyRequest): Promise<ActorContext> => ({ actor: await deps.identity.resolveActor(request), source: 'web', requestId: request.id });
  const storage = () => { if (!deps.storage) throw temporarilyUnavailableError(); return deps.storage; };
  const service = deps.store.application, limiter = createRateLimiter({ limit: 10, windowMs: 60_000, maxKeys: 1000 });
  const active = new Set<string>();
  const pending = new WeakMap<FastifyRequest, { context: ActorContext; expectedRevision: number; processing?: boolean; timer: ReturnType<typeof setTimeout> }>();
  const release = (request: FastifyRequest) => { const state = pending.get(request); if (state) { clearTimeout(state.timer); active.delete(state.context.actor.userId); pending.delete(request); } };
  void app.register(async routes => {
    routes.addHook('onRequest', async (_request, reply) => { reply.header('cache-control', 'private, no-store'); });
    routes.get('/api/v1/me/avatar', async (request, reply) => {
      parseInput(noQuery, request.query);
      return sendData(request, reply, userAvatarResponseSchema, await service.get(await context(request)));
    });
    routes.delete('/api/v1/me/avatar', async (request, reply) => {
      parseInput(noQuery, request.query);
      return sendData(request, reply, userAvatarResponseSchema, await service.remove(await context(request), parseInput(changeUserAvatarInputSchema, request.body)));
    });
    routes.get('/api/v1/users/:userId/avatars/:avatarId', async (request, reply) => {
      const params = parseInput(path, request.params); parseInput(noQuery, request.query);
      // Re-check current access and current avatar before every cache lookup or redirect.
      const row = await service.download(await context(request), params.userId, params.avatarId);
      return reply.redirect(await storage().url(row), 302);
    });
    void routes.register(async uploads => {
      uploads.addContentTypeParser('application/octet-stream', { parseAs: 'buffer', bodyLimit: MAX_AVATAR_BYTES }, (_request, body, done) => done(null, body));
      uploads.addHook('onRequestAbort', async request => { if (!pending.get(request)?.processing) release(request); });
      uploads.addHook('onResponse', async request => release(request));
      uploads.addHook('onError', async request => release(request));
      uploads.put('/api/v1/me/avatar', { bodyLimit: MAX_AVATAR_BYTES, onRequest: async request => {
        const ctx = await context(request); storage(); parseInput(noQuery, request.query);
        const expectedUserId = request.headers['x-workloom-expected-actor'], revision = request.headers['x-workloom-avatar-revision'];
        if (expectedUserId !== ctx.actor.userId) throw unauthenticatedError();
        if (typeof revision !== 'string' || !/^(0|[1-9][0-9]{0,9})$/.test(revision)) throw new HttpError(400, 'VALIDATION_FAILED', 'An avatar revision is required.');
        const input = parseInput(changeUserAvatarInputSchema, { expectedUserId, expectedRevision: Number(revision) });
        if (request.headers['content-type'] !== 'application/octet-stream' || request.headers['content-encoding']) throw new HttpError(415, 'AVATAR_INVALID_IMAGE', 'Send an unencoded binary image.');
        if (active.has(ctx.actor.userId) || active.size >= 4 || !limiter.check(ctx.actor.userId).allowed) throw new HttpError(429, 'RATE_LIMITED', 'Retry the avatar upload shortly.');
        const timer = setTimeout(() => { if (!pending.get(request)?.processing) { release(request); request.raw.destroy(); } }, 60_000);
        timer.unref();
        active.add(ctx.actor.userId); pending.set(request, { context: ctx, expectedRevision: input.expectedRevision, timer });
      } }, async (request, reply) => {
        const state = pending.get(request);
        if (!state || !Buffer.isBuffer(request.body)) throw new HttpError(400, 'VALIDATION_FAILED', 'An image is required.');
        state.processing = true; clearTimeout(state.timer);
        try {
          const bytes = await normalizeAvatar(request.body);
          const row = await service.prepare(state.context, { expectedUserId: state.context.actor.userId, expectedRevision: state.expectedRevision }, storage().storageId);
          const versionId = await storage().upload(row, bytes);
          await deps.store.recordStored(row, versionId);
          const current = await context(request);
          if (current.actor.userId !== state.context.actor.userId) throw unauthenticatedError();
          return sendData(request, reply, userAvatarResponseSchema, await service.finish(current, row, versionId));
        } finally { release(request); }
      });
    });
  });
}

export function registerAvatarMaintenance(app: FastifyInstance, store: UserAvatarStore, storage: AvatarStorage): void {
  let running: Promise<void> | undefined, timer: ReturnType<typeof setInterval> | undefined;
  let closed = false;
  const tick = () => {
    if (closed || running) return;
    running = (async () => {
      const jobs = await store.claimCleanup(storage.storageId);
      await Promise.all(jobs.map(async job => {
        let success = false;
        try { await storage.remove(job.objectKey, job.versionId); success = true; } catch { /* retry below */ }
        await store.completeCleanup(job, success);
      }));
    })().catch(() => { app.log.warn({ code: 'AVATAR_CLEANUP_RETRY' }, 'Avatar cleanup will retry.'); }).finally(() => { running = undefined; });
  };
  app.addHook('onReady', async () => { timer = setInterval(tick, 60_000); timer.unref(); tick(); });
  app.addHook('onClose', async () => { closed = true; clearInterval(timer); await running; storage.close(); });
}
