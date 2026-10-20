import * as C from '@workloom/contracts';
import { toCommandContext, type SharedActivityApplication } from '@workloom/domain';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { IdentityAdapter } from '../identity/identity-adapter.js';
import { parseInput, sendData } from './envelope.js';
import { readIdempotencyKey } from './task-routes.js';
const base = '/api/v1/workspaces/:workspaceId';
const taskParams = z.strictObject({ workspaceId: C.idSchema, taskId: C.idSchema });
const projectParams = z.strictObject({ workspaceId: C.idSchema, projectId: C.idSchema });
const historyParams = taskParams.extend({ contributionId: C.idSchema });
const none = z.strictObject({});
export function registerSharedActivityRoutes(app: FastifyInstance, deps: { identity: IdentityAdapter; activities: SharedActivityApplication }): void {
  async function context(request: FastifyRequest, workspaceId: string, write = false) { const key=write?readIdempotencyKey(request):undefined;return toCommandContext({ actor: await deps.identity.resolveActor(request), source: 'web', requestId: request.id }, workspaceId, key); }
  app.get(`${base}/tasks/:taskId/shared-activity`, async (request, reply) => { const p = parseInput(taskParams, request.params); parseInput(none, request.query); return sendData(request, reply, C.sharedActivityResponseSchema, await deps.activities.get(await context(request, p.workspaceId), p.taskId)); });
  app.put(`${base}/tasks/:taskId/shared-activity`, async (request, reply) => { const p = parseInput(taskParams, request.params); parseInput(none, request.query); const input = parseInput(C.configureSharedActivityInputSchema, request.body); return sendData(request, reply, C.sharedActivityResponseSchema, await deps.activities.configure(await context(request, p.workspaceId, true), p.taskId, input)); });
  app.post(`${base}/projects/:projectId/shared-activities`, async (request, reply) => { const p = parseInput(projectParams, request.params); parseInput(none, request.query); const input = parseInput(C.createSharedActivityInputSchema, request.body); return sendData(request, reply, C.createSharedActivityResponseSchema, await deps.activities.create(await context(request, p.workspaceId, true), p.projectId, input), { statusCode: 201 }); });
  app.post(`${base}/tasks/:taskId/shared-activity/attendance`, async (request, reply) => { const p = parseInput(taskParams, request.params); parseInput(none, request.query); const input = parseInput(C.confirmSharedActivityAttendanceInputSchema, request.body); return sendData(request, reply, C.sharedActivityResponseSchema, await deps.activities.confirm(await context(request, p.workspaceId, true), p.taskId, input)); });
  app.get(`${base}/tasks/:taskId/shared-activity/contributions/:contributionId/history`, async (request, reply) => { const p = parseInput(historyParams, request.params); parseInput(none, request.query); return sendData(request, reply, C.sharedActivityHistoryResponseSchema, await deps.activities.history(await context(request, p.workspaceId), p.taskId, p.contributionId), { list: true }); });
}
