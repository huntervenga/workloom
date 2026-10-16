import { idSchema, myTasksQuerySchema, myTasksResponseSchema } from '@workloom/contracts';
import { toCommandContext, type MyTasksApplication } from '@workloom/domain';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { IdentityAdapter } from '../identity/identity-adapter.js';
import { parseInput, sendData } from './envelope.js';

export function registerMyTasksRoutes(app: FastifyInstance, dependencies: { identity: IdentityAdapter; myTasks: MyTasksApplication }): void {
  app.get('/api/v1/workspaces/:workspaceId/my-tasks', async (request, reply) => {
    const { workspaceId } = parseInput(z.strictObject({ workspaceId: idSchema }), request.params);
    const query = parseInput(myTasksQuerySchema, request.query);
    const actor = await dependencies.identity.resolveActor(request);
    const context = toCommandContext({ actor, source: 'web', requestId: request.id }, workspaceId);
    const page = await dependencies.myTasks.list(context, query);
    return sendData(request, reply, myTasksResponseSchema, page.items, { nextCursor: page.nextCursor });
  });
}
