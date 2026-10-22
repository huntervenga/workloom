import { continueTaskInputSchema, continueTaskResponseSchema, idSchema } from '@workloom/contracts';
import { toCommandContext, type TaskContinuationApplication } from '@workloom/domain';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { IdentityAdapter } from '../identity/identity-adapter.js';
import { parseInput, sendData } from './envelope.js';
import { readIdempotencyKey } from './task-routes.js';

const path = z.strictObject({ workspaceId: idSchema, taskId: idSchema });
const none = z.strictObject({});

export function registerTaskContinuationRoutes(app: FastifyInstance, deps: { identity: IdentityAdapter; continuation: TaskContinuationApplication }): void {
  app.post('/api/v1/workspaces/:workspaceId/tasks/:taskId/continue', async (request, reply) => {
    const p = parseInput(path, request.params); parseInput(none, request.query);
    const key = readIdempotencyKey(request), input = parseInput(continueTaskInputSchema, request.body);
    const context = toCommandContext({ actor: await deps.identity.resolveActor(request), source: 'web', requestId: request.id }, p.workspaceId, key);
    return sendData(request, reply, continueTaskResponseSchema, await deps.continuation.continueTask(context, p.taskId, input), { statusCode: 201 });
  });
}
