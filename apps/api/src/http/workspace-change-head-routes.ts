import { idSchema, workspaceChangeHeadQuerySchema, workspaceChangeHeadResponseSchema } from '@workloom/contracts';
import { toCommandContext, type WorkspaceChangeHeadApplication } from '@workloom/domain';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { IdentityAdapter } from '../identity/identity-adapter.js';
import { parseInput, sendData } from './envelope.js';

export function registerWorkspaceChangeHeadRoutes(app: FastifyInstance, dependencies: { identity: IdentityAdapter; workspaceChangeHead: WorkspaceChangeHeadApplication }): void {
  app.get('/api/v1/workspaces/:workspaceId/change-head', async (request, reply) => {
    reply.header('cache-control', 'no-store');
    const { workspaceId } = parseInput(z.strictObject({ workspaceId: idSchema }), request.params);
    parseInput(workspaceChangeHeadQuerySchema, request.query);
    const actor = await dependencies.identity.resolveActor(request);
    const context = toCommandContext({ actor, source: 'web', requestId: request.id }, workspaceId);
    return sendData(request, reply, workspaceChangeHeadResponseSchema, await dependencies.workspaceChangeHead.getHead(context));
  });
}
