import { updateUserSettingsInputSchema, userSettingsResponseSchema } from '@workloom/contracts';
import type { UserSettingsApplication } from '@workloom/domain';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { IdentityAdapter } from '../identity/identity-adapter.js';
import { parseInput, sendData } from './envelope.js';

export function registerUserSettingsRoutes(app: FastifyInstance, deps: { identity: IdentityAdapter; settings: UserSettingsApplication }): void {
  const context = async (request: FastifyRequest) => ({ actor: await deps.identity.resolveActor(request), source: 'web' as const, requestId: request.id });
  const noQuery = z.strictObject({});
  app.get('/api/v1/me/settings', async (request, reply) => {
    const actor = await context(request);
    parseInput(noQuery, request.query);
    return sendData(request, reply, userSettingsResponseSchema, await deps.settings.get(actor));
  });
  app.patch('/api/v1/me/settings', async (request, reply) => {
    const actor = await context(request);
    parseInput(noQuery, request.query);
    const input = parseInput(updateUserSettingsInputSchema, request.body);
    return sendData(request, reply, userSettingsResponseSchema, await deps.settings.update(actor, input));
  });
}
