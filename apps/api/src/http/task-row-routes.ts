import { createTaskRowInputSchema, idSchema, taskRowResponseSchema } from '@workloom/contracts';
import { toCommandContext, type TaskRowApplication } from '@workloom/domain';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import type { IdentityAdapter } from '../identity/identity-adapter.js';
import { parseInput, sendData } from './envelope.js';
import { readIdempotencyKey } from './task-routes.js';

export interface TaskRowRouteDependencies {
  readonly identity: IdentityAdapter;
  readonly rows: TaskRowApplication;
}

/**
 * Explicit transport cap for this route only: 1 MiB (1 * 1024 * 1024 bytes). The global 16 KiB
 * limit stays in force for every other route. The cap is an approved root transport bound, not the
 * theoretical maximum of the schema: up to 200 text values of 10 000 characters each can exceed
 * it, and not every schema-valid row is accepted. An oversize body is rejected with 413
 * PAYLOAD_TOO_LARGE by the body parser, before identity resolution or any domain call, so nothing
 * is written; keeping the unsent draft for the user to shorten is the client's responsibility.
 */
export const TASK_ROW_BODY_LIMIT_BYTES = 1 * 1024 * 1024;

const workspaceParamsSchema = z.object({ workspaceId: idSchema });

/**
 * Atomic table-row creation (contract in @workloom/contracts task-row.ts). Thin adapter: it parses
 * input, builds the trusted context and validates the response; access, tenant scope, revisions,
 * idempotency and atomicity belong to the TaskRowApplication. Exactly one domain call per request.
 */
export function registerTaskRowRoutes(app: FastifyInstance, deps: TaskRowRouteDependencies): void {
  app.post('/api/v1/workspaces/:workspaceId/tasks/rows', { bodyLimit: TASK_ROW_BODY_LIMIT_BYTES }, async (request, reply) => {
    const params = parseInput(workspaceParamsSchema, request.params);
    const idempotencyKey = readIdempotencyKey(request);
    const input = parseInput(createTaskRowInputSchema, request.body);
    const actor = await deps.identity.resolveActor(request);
    const ctx = toCommandContext({ actor, source: 'web', requestId: request.id }, params.workspaceId, idempotencyKey);
    return sendData(request, reply, taskRowResponseSchema, await deps.rows.createRow(ctx, input), { statusCode: 201 });
  });
}
