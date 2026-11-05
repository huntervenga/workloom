import { idSchema, projectViewsResponseSchema, setProjectViewsInputSchema } from '@workloom/contracts';
import { toCommandContext, type ProjectViewsApplication } from '@workloom/domain';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { IdentityAdapter } from '../identity/identity-adapter.js';
import { parseInput, sendData } from './envelope.js';
import { readIdempotencyKey } from './task-routes.js';

const path = '/api/v1/workspaces/:workspaceId/projects/:projectId/saved-views';
const params = z.strictObject({ workspaceId: idSchema, projectId: idSchema });
const noQuery = z.strictObject({});
export function registerProjectViewsRoutes(app: FastifyInstance, deps: { identity: IdentityAdapter; views: ProjectViewsApplication }) {
  const context = async (request: FastifyRequest, key?: string) => {
    parseInput(noQuery, request.query);
    const { workspaceId, projectId } = parseInput(params, request.params);
    const actor = await deps.identity.resolveActor(request);
    return { projectId, ctx: toCommandContext({ actor, source: 'web', requestId: request.id }, workspaceId, key) };
  };
  app.get(path, async (request, reply) => {
    const { projectId, ctx } = await context(request);
    return sendData(request, reply, projectViewsResponseSchema, await deps.views.get(ctx, projectId));
  });
  app.put(path, async (request, reply) => {
    const input = parseInput(setProjectViewsInputSchema, request.body);
    const { projectId, ctx } = await context(request, readIdempotencyKey(request));
    return sendData(request, reply, projectViewsResponseSchema, await deps.views.set(ctx, projectId, input));
  });
}
