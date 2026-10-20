import * as C from '@workloom/contracts';
import { toCommandContext, type DuplicationApplication } from '@workloom/domain';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { IdentityAdapter } from '../identity/identity-adapter.js';
import { parseInput, sendData } from './envelope.js';
import { readIdempotencyKey } from './task-routes.js';
const paramsSchema = z.strictObject({ workspaceId: C.idSchema, sourceId: C.idSchema });
/** Sources and values are read server-side; clients choose fields, never supply copied contents or identities. */
export function registerDuplicationRoutes(app: FastifyInstance, deps: { identity: IdentityAdapter; duplication: DuplicationApplication }): void {
  for (const kind of ['tasks', 'sections'] as const) {
    app.post(`/api/v1/workspaces/:workspaceId/${kind}/:sourceId/duplicate-preview`, async (request, reply) => {
      const params = parseInput(paramsSchema, request.params), actor = await deps.identity.resolveActor(request);
      const ctx = toCommandContext({ actor, source: 'web', requestId: request.id }, params.workspaceId);
      const preview = kind === 'tasks'
        ? await deps.duplication.previewTask(ctx, params.sourceId, parseInput(C.duplicateTaskPreviewInputSchema, request.body))
        : await deps.duplication.previewSection(ctx, params.sourceId, parseInput(C.duplicateSectionPreviewInputSchema, request.body));
      return sendData(request, reply, C.duplicationPreviewResponseSchema, preview);
    });
    app.post(`/api/v1/workspaces/:workspaceId/${kind}/:sourceId/duplicate`, async (request, reply) => {
      const params = parseInput(paramsSchema, request.params), key = readIdempotencyKey(request), actor = await deps.identity.resolveActor(request);
      const ctx = toCommandContext({ actor, source: 'web', requestId: request.id }, params.workspaceId, key);
      const result = kind === 'tasks'
        ? await deps.duplication.duplicateTask(ctx, params.sourceId, parseInput(C.duplicateTaskInputSchema, request.body))
        : await deps.duplication.duplicateSection(ctx, params.sourceId, parseInput(C.duplicateSectionInputSchema, request.body));
      return sendData(request, reply, C.duplicationResultResponseSchema, result, { statusCode: 201 });
    });
  }
}
