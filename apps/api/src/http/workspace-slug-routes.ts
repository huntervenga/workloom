import { z } from 'zod';
import { idSchema, updateWorkspaceSlugInputSchema, workspaceResponseSchema } from '@workloom/contracts';
import { DomainError, type WorkspaceSlugApplication } from '@workloom/domain';
import type { FastifyInstance } from 'fastify';
import type { IdentityAdapter } from '../identity/identity-adapter.js';
import { parseInput, sendData } from './envelope.js';
import { readIdempotencyKey } from './task-routes.js';

export function registerWorkspaceSlugRoutes(app: FastifyInstance, deps: { identity: IdentityAdapter; slugs: WorkspaceSlugApplication }): void {
  app.patch('/api/v1/workspaces/:workspaceId/slug', async (request, reply) => {
    const { workspaceId } = parseInput(z.object({ workspaceId: idSchema }).strict(), request.params);
    parseInput(z.object({}).strict(), request.query);
    const input = parseInput(updateWorkspaceSlugInputSchema, request.body);
    const idempotencyKey = readIdempotencyKey(request);
    const intendedActor = parseInput(idSchema, request.headers['x-workloom-actor-id']);
    const actor = await deps.identity.resolveActor(request);
    if (actor.userId.toLowerCase() !== intendedActor) throw new DomainError('REVISION_CONFLICT', 'The signed-in account changed. Reload and retry.');
    return sendData(request, reply, workspaceResponseSchema, await deps.slugs.updateSlug({ actor, workspaceId,
      source: 'web', requestId: request.id, idempotencyKey }, input));
  });
}
