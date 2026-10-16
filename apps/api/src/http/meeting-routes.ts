import {
  applyMeetingPlanInputSchema,
  attendanceHistoryListResponseSchema,
  attendancePostingResponseSchema,
  confirmAttendanceInputSchema,
  createMeetingInputSchema,
  idSchema,
  meetingAttendanceListResponseSchema,
  meetingCreationResponseSchema,
  meetingListQuerySchema,
  meetingListResponseSchema,
  meetingPlanPreviewInputSchema,
  meetingPlanPreviewResponseSchema,
  meetingPlanResultResponseSchema,
  meetingResponseSchema,
  planningPageQuerySchema,
  recordedWorkListQuerySchema,
  recordedWorkListResponseSchema,
  updateMeetingInputSchema,
} from '@workloom/contracts';
import { toCommandContext, type CommandContext, type MeetingApplication } from '@workloom/domain';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';

import type { IdentityAdapter } from '../identity/identity-adapter.js';
import { parseInput, sendData } from './envelope.js';
import { readIdempotencyKey } from './task-routes.js';

export interface MeetingRouteDependencies {
  readonly identity: IdentityAdapter;
  readonly meetings: MeetingApplication;
}

const BASE = '/api/v1/workspaces/:workspaceId';
const workspaceParamsSchema = z.object({ workspaceId: idSchema });
const projectParamsSchema = z.object({ workspaceId: idSchema, projectId: idSchema });
const taskParamsSchema = z.object({ workspaceId: idSchema, taskId: idSchema });
const attendanceParamsSchema = z.object({ workspaceId: idSchema, taskId: idSchema, attendanceId: idSchema });
const noQuerySchema = z.strictObject({});
// Only these strict new commands exceed the existing global16KiB cap. No legacy route changes.
const MEETING_CREATE_BODY_LIMIT = 64 * 1024;
const MEETING_DETAILS_BODY_LIMIT = 256 * 1024;
const ATTENDANCE_BATCH_BODY_LIMIT = 768 * 1024;

/**
 * Dated meeting transport only. Domain commands own current ACL before replay, period and
 * attendance/source guards, generic task/manual-write restrictions, atomic plan/attendance
 * batches and source-union reports. The existing work.set request shape/hash is unchanged.
 */
export function registerMeetingRoutes(app: FastifyInstance, deps: MeetingRouteDependencies): void {
  async function context(request: FastifyRequest, workspaceId: string, key?: string): Promise<CommandContext> {
    const actor = await deps.identity.resolveActor(request);
    return toCommandContext({ actor, source: 'web', requestId: request.id }, workspaceId, key);
  }

  async function read<P extends { workspaceId: string }, Q>(
    request: FastifyRequest,
    paramsSchema: z.ZodType<P>,
    querySchema: z.ZodType<Q>,
  ): Promise<{ params: P; query: Q; ctx: CommandContext }> {
    const params = parseInput(paramsSchema, request.params);
    const query = parseInput(querySchema, request.query);
    return { params, query, ctx: await context(request, params.workspaceId) };
  }

  async function command<P extends { workspaceId: string }, B>(
    request: FastifyRequest,
    paramsSchema: z.ZodType<P>,
    bodySchema: z.ZodType<B>,
    keyed = true,
  ): Promise<{ params: P; input: B; ctx: CommandContext }> {
    const params = parseInput(paramsSchema, request.params);
    parseInput(noQuerySchema, request.query);
    const key = keyed ? readIdempotencyKey(request) : undefined;
    const input = parseInput(bodySchema, request.body);
    return { params, input, ctx: await context(request, params.workspaceId, key) };
  }

  app.get(`${BASE}/projects/:projectId/meetings`, async (request, reply) => {
    const { params, query, ctx } = await read(request, projectParamsSchema, meetingListQuerySchema);
    const page = await deps.meetings.listMeetings(ctx, params.projectId, query);
    return sendData(request, reply, meetingListResponseSchema, page.items, { nextCursor: page.nextCursor });
  });

  app.post(`${BASE}/projects/:projectId/meetings`, { bodyLimit: MEETING_CREATE_BODY_LIMIT }, async (request, reply) => {
    const { params, input, ctx } = await command(request, projectParamsSchema, createMeetingInputSchema);
    return sendData(request, reply, meetingCreationResponseSchema, await deps.meetings.createMeeting(ctx, params.projectId, input), { statusCode: 201 });
  });

  app.get(`${BASE}/tasks/:taskId/meeting`, async (request, reply) => {
    const { params, ctx } = await read(request, taskParamsSchema, noQuerySchema);
    return sendData(request, reply, meetingResponseSchema, await deps.meetings.getMeeting(ctx, params.taskId));
  });

  app.patch(`${BASE}/tasks/:taskId/meeting`, { bodyLimit: MEETING_DETAILS_BODY_LIMIT }, async (request, reply) => {
    const { params, input, ctx } = await command(request, taskParamsSchema, updateMeetingInputSchema);
    return sendData(request, reply, meetingResponseSchema, await deps.meetings.updateMeeting(ctx, params.taskId, input));
  });

  app.get(`${BASE}/tasks/:taskId/attendance`, async (request, reply) => {
    const { params, query, ctx } = await read(request, taskParamsSchema, planningPageQuerySchema);
    const page = await deps.meetings.listAttendance(ctx, params.taskId, query);
    return sendData(request, reply, meetingAttendanceListResponseSchema, page.items, { nextCursor: page.nextCursor });
  });

  app.post(`${BASE}/tasks/:taskId/attendance/confirm`, { bodyLimit: ATTENDANCE_BATCH_BODY_LIMIT }, async (request, reply) => {
    const { params, input, ctx } = await command(request, taskParamsSchema, confirmAttendanceInputSchema);
    return sendData(request, reply, attendancePostingResponseSchema, await deps.meetings.confirmAttendance(ctx, params.taskId, input));
  });

  app.get(`${BASE}/recorded-work`, async (request, reply) => {
    const { query, ctx } = await read(request, workspaceParamsSchema, recordedWorkListQuerySchema);
    const page = await deps.meetings.listRecordedWork(ctx, query);
    return sendData(request, reply, recordedWorkListResponseSchema, page.items, { nextCursor: page.nextCursor });
  });

  app.get(`${BASE}/tasks/:taskId/attendance/:attendanceId/history`, async (request, reply) => {
    const { params, query, ctx } = await read(request, attendanceParamsSchema, planningPageQuerySchema);
    const page = await deps.meetings.listAttendanceHistory(ctx, params.taskId, params.attendanceId, query);
    return sendData(request, reply, attendanceHistoryListResponseSchema, page.items, { nextCursor: page.nextCursor });
  });

  app.post(`${BASE}/tasks/:taskId/meeting-plan-preview`, async (request, reply) => {
    const { params, input, ctx } = await command(request, taskParamsSchema, meetingPlanPreviewInputSchema, false);
    return sendData(request, reply, meetingPlanPreviewResponseSchema, await deps.meetings.previewMeetingPlan(ctx, params.taskId, input));
  });

  app.post(`${BASE}/tasks/:taskId/meeting-plan`, async (request, reply) => {
    const { params, input, ctx } = await command(request, taskParamsSchema, applyMeetingPlanInputSchema);
    return sendData(request, reply, meetingPlanResultResponseSchema, await deps.meetings.applyMeetingPlan(ctx, params.taskId, input));
  });
}
