import { idSchema, inboxQuerySchema, inboxResponseSchema } from '@workloom/contracts';
import { toCommandContext, type InboxApplication } from '@workloom/domain';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { IdentityAdapter } from '../identity/identity-adapter.js';
import { parseInput, sendData } from './envelope.js';

export function registerInboxRoutes(app: FastifyInstance, dependencies: { identity: IdentityAdapter; inbox: InboxApplication }): void {
  app.get('/api/v1/workspaces/:workspaceId/inbox', async (request, reply) => {
    const { workspaceId } = parseInput(z.strictObject({ workspaceId: idSchema }), request.params);
    const query = parseInput(inboxQuerySchema, request.query);
    const actor = await dependencies.identity.resolveActor(request);
    const context = toCommandContext({ actor, source: 'web', requestId: request.id }, workspaceId);
    return sendData(request, reply, inboxResponseSchema, await dependencies.inbox.list(context, query));
  });
}
