import { idSchema, setTaskDefaultsInputSchema, taskDefaultsResponseSchema } from '@workloom/contracts';
import { toCommandContext, type TaskDefaultsApplication } from '@workloom/domain';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { IdentityAdapter } from '../identity/identity-adapter.js';
import { parseInput, sendData } from './envelope.js';
import { readIdempotencyKey } from './task-routes.js';

const path = z.strictObject({ workspaceId: idSchema, projectId: idSchema });
const none = z.strictObject({});

export function registerTaskDefaultsRoutes(app: FastifyInstance, deps: { identity: IdentityAdapter; defaults: TaskDefaultsApplication }): void {
  const base = '/api/v1/workspaces/:workspaceId/projects/:projectId/task-defaults';
  const context = async (request: FastifyRequest, workspaceId: string, key?: string) => toCommandContext({ actor: await deps.identity.resolveActor(request), source: 'web', requestId: request.id }, workspaceId, key);
  app.get(base, async (request, reply) => {
    const p = parseInput(path, request.params); parseInput(none, request.query);
    return sendData(request, reply, taskDefaultsResponseSchema, await deps.defaults.getDefaults(await context(request, p.workspaceId), p.projectId));
  });
  app.put(base, async (request, reply) => {
    const p = parseInput(path, request.params); parseInput(none, request.query);
    const key = readIdempotencyKey(request), input = parseInput(setTaskDefaultsInputSchema, request.body);
    return sendData(request, reply, taskDefaultsResponseSchema, await deps.defaults.setDefaults(await context(request, p.workspaceId, key), p.projectId, input));
  });
}
