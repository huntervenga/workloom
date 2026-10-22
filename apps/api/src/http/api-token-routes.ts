import { apiTokenSchema, createApiTokenInputSchema, createdApiTokenSchema, envelopeSchema, idSchema } from '@workloom/contracts';
import type { AutomationApplication } from '@workloom/db';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { IdentityAdapter } from '../identity/identity-adapter.js';
import { parseInput, sendData } from './envelope.js';

const empty = z.strictObject({});
const tokenParams = z.object({ tokenId: idSchema });
export interface ApiTokenRouteDependencies { readonly identity: IdentityAdapter; readonly automation: AutomationApplication }

/** Token management belongs to the signed-in person: browser session only, never another token. */
export function registerApiTokenRoutes(app: FastifyInstance, deps: ApiTokenRouteDependencies): void {
  const base = '/api/v1/me/api-tokens';
  app.get(base, async (request, reply) => {
    parseInput(empty, request.query);
    const actor = await deps.identity.resolveActor(request);
    return sendData(request, reply, envelopeSchema(apiTokenSchema.array()), await deps.automation.listTokens(actor.userId), { list: true });
  });
  app.post(base, async (request, reply) => {
    parseInput(empty, request.query);
    const actor = await deps.identity.resolveActor(request);
    const input = parseInput(createApiTokenInputSchema, request.body);
    return sendData(request, reply, envelopeSchema(createdApiTokenSchema), await deps.automation.issueToken(actor.userId, input), { statusCode: 201 });
  });
  app.post(`${base}/:tokenId/revoke`, async (request, reply) => {
    parseInput(empty, request.query);
    const params = parseInput(tokenParams, request.params);
    const actor = await deps.identity.resolveActor(request);
    return sendData(request, reply, envelopeSchema(apiTokenSchema), await deps.automation.revokeToken(actor.userId, params.tokenId));
  });
}
