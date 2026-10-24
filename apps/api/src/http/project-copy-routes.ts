import { applyProjectSettingsInputSchema, applyProjectSettingsResponseSchema, duplicateProjectInputSchema, duplicateProjectResponseSchema, idSchema } from '@workloom/contracts';
import { toCommandContext, type ProjectCopyApplication } from '@workloom/domain';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { IdentityAdapter } from '../identity/identity-adapter.js';
import { parseInput, sendData } from './envelope.js';
import { readIdempotencyKey } from './task-routes.js';

const path = z.strictObject({ workspaceId: idSchema, projectId: idSchema });
const none = z.strictObject({});

export function registerProjectCopyRoutes(app: FastifyInstance, deps: { identity: IdentityAdapter; copies: ProjectCopyApplication }): void {
  app.post('/api/v1/workspaces/:workspaceId/projects/:projectId/duplicate', async (request, reply) => {
    const p = parseInput(path, request.params); parseInput(none, request.query);
    const key = readIdempotencyKey(request), input = parseInput(duplicateProjectInputSchema, request.body);
    const context = toCommandContext({ actor: await deps.identity.resolveActor(request), source: 'web', requestId: request.id }, p.workspaceId, key);
    return sendData(request, reply, duplicateProjectResponseSchema, await deps.copies.duplicateProject(context, p.projectId, input), { statusCode: 201 });
  });
  app.post('/api/v1/workspaces/:workspaceId/projects/:projectId/apply-settings', async (request, reply) => {
    const p = parseInput(path, request.params); parseInput(none, request.query);
    const key = readIdempotencyKey(request), input = parseInput(applyProjectSettingsInputSchema, request.body);
    const context = toCommandContext({ actor: await deps.identity.resolveActor(request), source: 'web', requestId: request.id }, p.workspaceId, key);
    return sendData(request, reply, applyProjectSettingsResponseSchema, await deps.copies.applySettings(context, p.projectId, input));
  });
}
