import { idSchema, setProjectRulesInputSchema, projectRulesResponseSchema } from '@workloom/contracts';
import { toCommandContext, type ProjectRulesApplication } from '@workloom/domain';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { IdentityAdapter } from '../identity/identity-adapter.js';
import { parseInput, sendData } from './envelope.js';
import { readIdempotencyKey } from './task-routes.js';

const path = z.strictObject({ workspaceId: idSchema, projectId: idSchema });
const none = z.strictObject({});

export function registerProjectRulesRoutes(app: FastifyInstance, deps: { identity: IdentityAdapter; rules: ProjectRulesApplication }): void {
  const base = '/api/v1/workspaces/:workspaceId/projects/:projectId/rules';
  const context = async (request: FastifyRequest, workspaceId: string, key?: string) => toCommandContext({ actor: await deps.identity.resolveActor(request), source: 'web', requestId: request.id }, workspaceId, key);
  app.get(base, async (request, reply) => {
    const p = parseInput(path, request.params); parseInput(none, request.query);
    return sendData(request, reply, projectRulesResponseSchema, await deps.rules.getRules(await context(request, p.workspaceId), p.projectId));
  });
  app.put(base, async (request, reply) => {
    const p = parseInput(path, request.params); parseInput(none, request.query);
    const key = readIdempotencyKey(request), input = parseInput(setProjectRulesInputSchema, request.body);
    return sendData(request, reply, projectRulesResponseSchema, await deps.rules.setRules(await context(request, p.workspaceId, key), p.projectId, input));
  });
}
