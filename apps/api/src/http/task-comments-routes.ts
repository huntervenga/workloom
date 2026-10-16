import { createTaskCommentInputSchema, idSchema, taskActivityQuerySchema, taskActivityResponseSchema, taskCommentResponseSchema, taskCommentsQuerySchema, taskCommentsResponseSchema } from '@workloom/contracts';
import { toCommandContext, type TaskCommentsApplication } from '@workloom/domain';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { IdentityAdapter } from '../identity/identity-adapter.js';
import { parseInput, sendData } from './envelope.js';
import { readIdempotencyKey } from './task-routes.js';
const paramsSchema = z.strictObject({ workspaceId: idSchema, taskId: idSchema });
const base = '/api/v1/workspaces/:workspaceId/tasks/:taskId';
export function registerTaskCommentsRoutes(app: FastifyInstance, deps: { identity: IdentityAdapter; comments: TaskCommentsApplication }): void {
  app.get(`${base}/comments`, async (request, reply) => {
    const { workspaceId, taskId } = parseInput(paramsSchema, request.params), query = parseInput(taskCommentsQuerySchema, request.query);
    const actor = await deps.identity.resolveActor(request), context = toCommandContext({ actor, source: 'web', requestId: request.id }, workspaceId);
    const page = await deps.comments.listComments(context, taskId, query);
    return sendData(request, reply, taskCommentsResponseSchema, page.items, { nextCursor: page.nextCursor });
  });
  app.get(`${base}/activity`, async (request, reply) => {
    const { workspaceId, taskId } = parseInput(paramsSchema, request.params), query = parseInput(taskActivityQuerySchema, request.query);
    const actor = await deps.identity.resolveActor(request), context = toCommandContext({ actor, source: 'web', requestId: request.id }, workspaceId);
    const page = await deps.comments.listActivity(context, taskId, query);
    return sendData(request, reply, taskActivityResponseSchema, page.items, { nextCursor: page.nextCursor });
  });
  app.post(`${base}/comments`, async (request, reply) => {
    const { workspaceId, taskId } = parseInput(paramsSchema, request.params), input = parseInput(createTaskCommentInputSchema, request.body), key = readIdempotencyKey(request);
    const actor = await deps.identity.resolveActor(request), context = toCommandContext({ actor, source: 'web', requestId: request.id }, workspaceId, key);
    return sendData(request, reply, taskCommentResponseSchema, await deps.comments.createComment(context, taskId, input), { statusCode: 201 });
  });
}
