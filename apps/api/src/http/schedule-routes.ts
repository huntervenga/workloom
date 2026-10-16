import {
  idSchema,
  taskScheduleApplyInputSchema,
  taskScheduleApplyResponseSchema,
  taskScheduleBatchInputSchema,
  taskScheduleContextQuerySchema,
  taskScheduleContextResponseSchema,
  taskSchedulePreviewResponseSchema,
} from '@workloom/contracts';
import { toCommandContext, type TaskScheduleApplication } from '@workloom/domain';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';

import type { IdentityAdapter } from '../identity/identity-adapter.js';
import { parseInput, sendData } from './envelope.js';
import { readIdempotencyKey } from './task-routes.js';

export interface ScheduleRouteDependencies {
  readonly identity: IdentityAdapter;
  readonly schedule: TaskScheduleApplication;
}

const BASE = '/api/v1/workspaces/:workspaceId/projects/:projectId';
const paramsSchema = z.object({ workspaceId: idSchema, projectId: idSchema });
const noQuerySchema = z.strictObject({});
// At most100 full date rows, including valid escaped JSON; other routes keep their established limits.
const SCHEDULE_BODY_LIMIT = 128 * 1024;

/** HTTP transport only: consistent sources, current access, date/meeting guards and atomicity belong to domain. */
export function registerScheduleRoutes(app: FastifyInstance, deps: ScheduleRouteDependencies): void {
  async function context(request: FastifyRequest, workspaceId: string, key?: string) {
    const actor = await deps.identity.resolveActor(request);
    return toCommandContext({ actor, source: 'web', requestId: request.id }, workspaceId, key);
  }

  app.get(`${BASE}/schedule-context`, async (request, reply) => {
    const params = parseInput(paramsSchema, request.params);
    // Wire CSV is parsed exactly once; the application receives normalized sorted UUID[].
    const query = parseInput(taskScheduleContextQuerySchema, request.query);
    const ctx = await context(request, params.workspaceId);
    return sendData(request, reply, taskScheduleContextResponseSchema, await deps.schedule.getScheduleContext(ctx, params.projectId, query));
  });

  app.post(`${BASE}/schedule-preview`, { bodyLimit: SCHEDULE_BODY_LIMIT }, async (request, reply) => {
    const params = parseInput(paramsSchema, request.params);
    parseInput(noQuerySchema, request.query);
    const input = parseInput(taskScheduleBatchInputSchema, request.body);
    // Keyless read; the shared onRequest Origin/Host guards still apply to this POST.
    const ctx = await context(request, params.workspaceId);
    return sendData(request, reply, taskSchedulePreviewResponseSchema, await deps.schedule.previewSchedule(ctx, params.projectId, input));
  });

  app.post(`${BASE}/schedule-apply`, { bodyLimit: SCHEDULE_BODY_LIMIT }, async (request, reply) => {
    const params = parseInput(paramsSchema, request.params);
    parseInput(noQuerySchema, request.query);
    const key = readIdempotencyKey(request);
    const input = parseInput(taskScheduleApplyInputSchema, request.body);
    const ctx = await context(request, params.workspaceId, key);
    return sendData(request, reply, taskScheduleApplyResponseSchema, await deps.schedule.applySchedule(ctx, params.projectId, input));
  });
}
