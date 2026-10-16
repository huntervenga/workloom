import { idSchema, personalTablePreferenceResponseSchema, updatePersonalTablePreferenceInputSchema } from '@workloom/contracts';
import { toCommandContext, type PersonalTablePreferenceApplication } from '@workloom/domain';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { IdentityAdapter } from '../identity/identity-adapter.js';
import { parseInput, sendData } from './envelope.js';
import { readIdempotencyKey } from './task-routes.js';
const params = z.strictObject({ workspaceId: idSchema, projectId: idSchema });
const noQuery = z.strictObject({});
const path = '/api/v1/workspaces/:workspaceId/projects/:projectId/table-preferences/me';
export function registerPersonalTablePreferenceRoutes(app: FastifyInstance, deps: { identity: IdentityAdapter; preferences: PersonalTablePreferenceApplication }): void {
  app.get(path, async (request, reply) => {
    const { workspaceId, projectId } = parseInput(params, request.params); parseInput(noQuery, request.query);
    const actor = await deps.identity.resolveActor(request), context = toCommandContext({ actor, source: 'web', requestId: request.id }, workspaceId);
    return sendData(request, reply, personalTablePreferenceResponseSchema, await deps.preferences.getPreference(context, projectId));
  });
  app.put(path, async (request, reply) => {
    const { workspaceId, projectId } = parseInput(params, request.params), input = parseInput(updatePersonalTablePreferenceInputSchema, request.body); parseInput(noQuery, request.query);
    const key = readIdempotencyKey(request), actor = await deps.identity.resolveActor(request), context = toCommandContext({ actor, source: 'web', requestId: request.id }, workspaceId, key);
    return sendData(request, reply, personalTablePreferenceResponseSchema, await deps.preferences.setPreference(context, projectId, input));
  });
}
