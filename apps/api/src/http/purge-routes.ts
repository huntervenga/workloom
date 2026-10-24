import { idSchema, purgeProjectInputSchema, purgeResponseSchema, purgeTaskInputSchema } from '@workloom/contracts';
import { toCommandContext } from '@workloom/domain';
import type { PurgeApplication } from '@workloom/db';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { IdentityAdapter } from '../identity/identity-adapter.js';
import { parseInput, sendData } from './envelope.js';

const projectPath = z.strictObject({ workspaceId: idSchema, projectId: idSchema });
const taskPath = z.strictObject({ workspaceId: idSchema, taskId: idSchema });
const none = z.strictObject({});

/** Permanent delete, owner/admin only, with the exact name or title typed back. Archive stays the everyday action. */
export function registerPurgeRoutes(app: FastifyInstance, deps: { identity: IdentityAdapter; purge: PurgeApplication }): void {
  const context = async (request: FastifyRequest, workspaceId: string) => toCommandContext({ actor: await deps.identity.resolveActor(request), source: 'web', requestId: request.id }, workspaceId);
  app.post('/api/v1/workspaces/:workspaceId/projects/:projectId/purge', async (request, reply) => {
    const p = parseInput(projectPath, request.params); parseInput(none, request.query);
    const input = parseInput(purgeProjectInputSchema, request.body);
    return sendData(request, reply, purgeResponseSchema, await deps.purge.purgeProject(await context(request, p.workspaceId), p.projectId, input));
  });
  app.post('/api/v1/workspaces/:workspaceId/tasks/:taskId/purge', async (request, reply) => {
    const p = parseInput(taskPath, request.params); parseInput(none, request.query);
    const input = parseInput(purgeTaskInputSchema, request.body);
    return sendData(request, reply, purgeResponseSchema, await deps.purge.purgeTask(await context(request, p.workspaceId), p.taskId, input));
  });
}
