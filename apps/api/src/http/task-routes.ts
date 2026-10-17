import {
  archiveTaskInputSchema,
  bulkUpdateTasksInputSchema,
  bulkTaskUpdateResponseSchema,
  createProjectInputSchema,
  createSectionInputSchema,
  createTagInputSchema,
  createTaskInputSchema,
  idSchema,
  moveTaskInputSchema,
  projectListResponseSchema,
  projectResponseSchema,
  restoreTaskInputSchema,
  sectionListResponseSchema,
  sectionResponseSchema,
  tagListResponseSchema,
  tagResponseSchema,
  taskListQuerySchema,
  taskListResponseSchema,
  taskResponseSchema,
  taskStatusListResponseSchema,
  updateProjectInputSchema,
  updateSectionInputSchema,
  updateTagInputSchema,
  updateTaskInputSchema,
} from '@workloom/contracts';
import { DomainError, toCommandContext, type CommandContext, type TaskApplication } from '@workloom/domain';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';

import type { IdentityAdapter } from '../identity/identity-adapter.js';
import { parseInput, sendData } from './envelope.js';

export interface TaskRouteDependencies {
  readonly identity: IdentityAdapter;
  readonly tasks: TaskApplication;
}

/** Visible ASCII only (no spaces or control characters); clients send a random UUID and reuse it on retry. */
const IDEMPOTENCY_KEY_PATTERN = /^[\x21-\x7e]{1,128}$/;
const IDEMPOTENCY_KEY_MESSAGE = 'A valid Idempotency-Key header is required.';

const workspaceParamsSchema = z.object({ workspaceId: idSchema });
const projectParamsSchema = z.object({ workspaceId: idSchema, projectId: idSchema });
const sectionParamsSchema = z.object({ workspaceId: idSchema, sectionId: idSchema });
const tagParamsSchema = z.object({ workspaceId: idSchema, tagId: idSchema });
const taskParamsSchema = z.object({ workspaceId: idSchema, taskId: idSchema });

const BASE = '/api/v1/workspaces/:workspaceId';

/**
 * Reads the Idempotency-Key header. The key is only passed on: replay, payload hashing and
 * IDEMPOTENCY_KEY_REUSED are decided by the domain service, not cached here.
 */
export function readIdempotencyKey(request: FastifyRequest): string {
  const value = request.headers['idempotency-key'];
  if (typeof value !== 'string' || !IDEMPOTENCY_KEY_PATTERN.test(value)) {
    throw new DomainError('VALIDATION_FAILED', IDEMPOTENCY_KEY_MESSAGE, { details: { fields: ['Idempotency-Key'] } });
  }
  return value;
}

/**
 * P1a projects, sections, statuses, tags and tasks (catalog in @workloom/contracts tasks.ts).
 * The adapter only parses input, builds the trusted context and validates the response;
 * access, tenant scope, revisions and idempotency belong to the TaskApplication.
 */
export function registerTaskRoutes(app: FastifyInstance, deps: TaskRouteDependencies): void {
  async function context(request: FastifyRequest, workspaceId: string, idempotencyKey?: string): Promise<CommandContext> {
    const actor = await deps.identity.resolveActor(request);
    return toCommandContext({ actor, source: 'web', requestId: request.id }, workspaceId, idempotencyKey);
  }

  async function read<P extends { workspaceId: string }>(
    request: FastifyRequest,
    paramsSchema: z.ZodType<P>,
  ): Promise<{ params: P; ctx: CommandContext }> {
    const params = parseInput(paramsSchema, request.params);
    return { params, ctx: await context(request, params.workspaceId) };
  }

  async function write<P extends { workspaceId: string }, B>(
    request: FastifyRequest,
    paramsSchema: z.ZodType<P>,
    bodySchema: z.ZodType<B>,
  ): Promise<{ params: P; input: B; ctx: CommandContext }> {
    const params = parseInput(paramsSchema, request.params);
    const idempotencyKey = readIdempotencyKey(request);
    const input = parseInput(bodySchema, request.body);
    return { params, input, ctx: await context(request, params.workspaceId, idempotencyKey) };
  }

  // Projects
  app.get(`${BASE}/projects`, async (request, reply) => {
    const { ctx } = await read(request, workspaceParamsSchema);
    return sendData(request, reply, projectListResponseSchema, await deps.tasks.listProjects(ctx), { list: true });
  });

  app.post(`${BASE}/projects`, async (request, reply) => {
    const { input, ctx } = await write(request, workspaceParamsSchema, createProjectInputSchema);
    return sendData(request, reply, projectResponseSchema, await deps.tasks.createProject(ctx, input), { statusCode: 201 });
  });

  app.get(`${BASE}/projects/:projectId`, async (request, reply) => {
    const { params, ctx } = await read(request, projectParamsSchema);
    return sendData(request, reply, projectResponseSchema, await deps.tasks.getProject(ctx, params.projectId));
  });

  app.patch(`${BASE}/projects/:projectId`, async (request, reply) => {
    const { params, input, ctx } = await write(request, projectParamsSchema, updateProjectInputSchema);
    return sendData(request, reply, projectResponseSchema, await deps.tasks.updateProject(ctx, params.projectId, input));
  });

  // Sections and statuses
  app.get(`${BASE}/projects/:projectId/sections`, async (request, reply) => {
    const { params, ctx } = await read(request, projectParamsSchema);
    return sendData(request, reply, sectionListResponseSchema, await deps.tasks.listSections(ctx, params.projectId), { list: true });
  });

  app.post(`${BASE}/projects/:projectId/sections`, async (request, reply) => {
    const { params, input, ctx } = await write(request, projectParamsSchema, createSectionInputSchema);
    return sendData(request, reply, sectionResponseSchema, await deps.tasks.createSection(ctx, params.projectId, input), {
      statusCode: 201,
    });
  });

  app.patch(`${BASE}/sections/:sectionId`, async (request, reply) => {
    const { params, input, ctx } = await write(request, sectionParamsSchema, updateSectionInputSchema);
    return sendData(request, reply, sectionResponseSchema, await deps.tasks.updateSection(ctx, params.sectionId, input));
  });

  app.get(`${BASE}/projects/:projectId/statuses`, async (request, reply) => {
    const { params, ctx } = await read(request, projectParamsSchema);
    return sendData(request, reply, taskStatusListResponseSchema, await deps.tasks.listStatuses(ctx, params.projectId), { list: true });
  });

  // Tags
  app.get(`${BASE}/tags`, async (request, reply) => {
    const { ctx } = await read(request, workspaceParamsSchema);
    return sendData(request, reply, tagListResponseSchema, await deps.tasks.listTags(ctx), { list: true });
  });

  app.post(`${BASE}/tags`, async (request, reply) => {
    const { input, ctx } = await write(request, workspaceParamsSchema, createTagInputSchema);
    return sendData(request, reply, tagResponseSchema, await deps.tasks.createTag(ctx, input), { statusCode: 201 });
  });

  app.patch(`${BASE}/tags/:tagId`, async (request, reply) => {
    const { params, input, ctx } = await write(request, tagParamsSchema, updateTagInputSchema);
    return sendData(request, reply, tagResponseSchema, await deps.tasks.updateTag(ctx, params.tagId, input));
  });

  // Tasks
  app.get(`${BASE}/tasks`, async (request, reply) => {
    const { workspaceId } = parseInput(workspaceParamsSchema, request.params);
    const query = parseInput(taskListQuerySchema, request.query);
    const page = await deps.tasks.listTasks(await context(request, workspaceId), query);
    // The cursor is opaque and bound by the service; it is passed through unmodified.
    return sendData(request, reply, taskListResponseSchema, page.items, { nextCursor: page.nextCursor });
  });

  app.post(`${BASE}/tasks`, async (request, reply) => {
    const { input, ctx } = await write(request, workspaceParamsSchema, createTaskInputSchema);
    return sendData(request, reply, taskResponseSchema, await deps.tasks.createTask(ctx, input), { statusCode: 201 });
  });

  app.get(`${BASE}/tasks/:taskId`, async (request, reply) => {
    const { params, ctx } = await read(request, taskParamsSchema);
    return sendData(request, reply, taskResponseSchema, await deps.tasks.getTask(ctx, params.taskId));
  });

  app.patch(`${BASE}/tasks/:taskId`, async (request, reply) => {
    const { params, input, ctx } = await write(request, taskParamsSchema, updateTaskInputSchema);
    return sendData(request, reply, taskResponseSchema, await deps.tasks.updateTask(ctx, params.taskId, input));
  });

  app.post(`${BASE}/tasks/:taskId/archive`, async (request, reply) => {
    const { params, input, ctx } = await write(request, taskParamsSchema, archiveTaskInputSchema);
    return sendData(request, reply, taskResponseSchema, await deps.tasks.archiveTask(ctx, params.taskId, input));
  });

  app.post(`${BASE}/tasks/:taskId/restore`, async (request, reply) => {
    const { params, input, ctx } = await write(request, taskParamsSchema, restoreTaskInputSchema);
    return sendData(request, reply, taskResponseSchema, await deps.tasks.restoreTask(ctx, params.taskId, input));
  });

  app.post(`${BASE}/tasks/bulk-update`, async (request, reply) => {
    const { input, ctx } = await write(request, workspaceParamsSchema, bulkUpdateTasksInputSchema);
    return sendData(request, reply, bulkTaskUpdateResponseSchema, await deps.tasks.bulkUpdateTasks(ctx, input));
  });

  app.post(`${BASE}/tasks/:taskId/move`, async (request, reply) => {
    const { params, input, ctx } = await write(request, taskParamsSchema, moveTaskInputSchema);
    return sendData(request, reply, taskResponseSchema, await deps.tasks.moveTask(ctx, params.taskId, input));
  });
}
