import { z } from 'zod';
import { configureCutoffInputSchema, cutoffCommandResponseSchema, cutoffReadinessResponseSchema, idSchema, retryCutoffInputSchema } from '@workloom/contracts';
import { toCommandContext, type CutoffApplication } from '@workloom/domain';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { IdentityAdapter } from '../identity/identity-adapter.js';
import { parseInput, sendData } from './envelope.js';
import { readIdempotencyKey } from './task-routes.js';
const paramsSchema = z.object({ workspaceId: idSchema, periodId: idSchema });
const noQuery = z.strictObject({});
export function registerCutoffRoutes(app: FastifyInstance, deps: { identity: IdentityAdapter; cutoff: CutoffApplication }): void {
  const base = '/api/v1/workspaces/:workspaceId/periods/:periodId';
  async function context(request: FastifyRequest, workspaceId: string, keyed = false) {
    const actor = await deps.identity.resolveActor(request);
    return toCommandContext({ actor, source: 'web', requestId: request.id }, workspaceId, keyed ? readIdempotencyKey(request) : undefined);
  }
  app.get(`${base}/cutoff-readiness`, async (request, reply) => {
    const params = parseInput(paramsSchema, request.params); parseInput(noQuery, request.query);
    return sendData(request, reply, cutoffReadinessResponseSchema, await deps.cutoff.getReadiness(await context(request, params.workspaceId), params.periodId));
  });
  app.put(`${base}/cutoff-automation`, async (request, reply) => {
    const params = parseInput(paramsSchema, request.params); parseInput(noQuery, request.query);
    const ctx = await context(request, params.workspaceId, true), input = parseInput(configureCutoffInputSchema, request.body);
    return sendData(request, reply, cutoffCommandResponseSchema, await deps.cutoff.configure(ctx, params.periodId, input));
  });
  app.post(`${base}/cutoff-retry`, async (request, reply) => {
    const params = parseInput(paramsSchema, request.params); parseInput(noQuery, request.query);
    const ctx = await context(request, params.workspaceId, true), input = parseInput(retryCutoffInputSchema, request.body);
    return sendData(request, reply, cutoffCommandResponseSchema, await deps.cutoff.retry(ctx, params.periodId, input));
  });
}
