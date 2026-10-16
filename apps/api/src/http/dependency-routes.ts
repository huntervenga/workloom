import {
  createTaskDependencyInputSchema,
  dependencyGraphQuerySchema,
  dependencyGraphResponseSchema,
  graphLayoutResponseSchema,
  idSchema,
  projectDependencyPolicyResponseSchema,
  setGraphLayoutInputSchema,
  taskBlockingQuerySchema,
  taskBlockingResponseSchema,
  taskDependencyListQuerySchema,
  taskDependencyListResponseSchema,
  taskDependencyResponseSchema,
  updateDependencyPolicyInputSchema,
  updateTaskDependencyInputSchema,
} from '@workloom/contracts';
import { toCommandContext, type CommandContext, type DependencyApplication } from '@workloom/domain';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';

import type { IdentityAdapter } from '../identity/identity-adapter.js';
import { parseInput, sendData } from './envelope.js';
import { readIdempotencyKey } from './task-routes.js';

export interface DependencyRouteDependencies {
  readonly identity: IdentityAdapter;
  readonly dependencies: DependencyApplication;
}

const BASE = '/api/v1/workspaces/:workspaceId';
const workspaceParamsSchema = z.object({ workspaceId: idSchema });
const projectParamsSchema = z.object({ workspaceId: idSchema, projectId: idSchema });
const taskParamsSchema = z.object({ workspaceId: idSchema, taskId: idSchema });
const dependencyParamsSchema = z.object({ workspaceId: idSchema, dependencyId: idSchema });
const noQuerySchema = z.strictObject({});
// Full personal layouts accept at most500 bounded positions; escaped UUID JSON can exceed16KiB.
const LAYOUT_BODY_LIMIT = 256 * 1024;

/** Transport only. Shared commands own current endpoint ACL, cycles, status policy and personal layout scope. */
export function registerDependencyRoutes(app: FastifyInstance, deps: DependencyRouteDependencies): void {
  async function context(request: FastifyRequest, workspaceId: string, key?: string): Promise<CommandContext> {
    const actor = await deps.identity.resolveActor(request);
    return toCommandContext({ actor, source: 'web', requestId: request.id }, workspaceId, key);
  }

  async function read<P extends { workspaceId: string }, Q>(request: FastifyRequest, paramsSchema: z.ZodType<P>, querySchema: z.ZodType<Q>) {
    const params = parseInput(paramsSchema, request.params);
    const query = parseInput(querySchema, request.query);
    return { params, query, ctx: await context(request, params.workspaceId) };
  }

  async function command<P extends { workspaceId: string }, B>(request: FastifyRequest, paramsSchema: z.ZodType<P>, inputSchema: z.ZodType<B>) {
    const params = parseInput(paramsSchema, request.params);
    parseInput(noQuerySchema, request.query);
    const key = readIdempotencyKey(request);
    const input = parseInput(inputSchema, request.body);
    return { params, input, ctx: await context(request, params.workspaceId, key) };
  }

  app.get(`${BASE}/dependencies`, async (request, reply) => {
    const { query, ctx } = await read(request, workspaceParamsSchema, taskDependencyListQuerySchema);
    const page = await deps.dependencies.listDependencies(ctx, query);
    return sendData(request, reply, taskDependencyListResponseSchema, page.items, { nextCursor: page.nextCursor });
  });
  app.post(`${BASE}/dependencies`, async (request, reply) => {
    const { input, ctx } = await command(request, workspaceParamsSchema, createTaskDependencyInputSchema);
    return sendData(request, reply, taskDependencyResponseSchema, await deps.dependencies.createDependency(ctx, input), { statusCode: 201 });
  });
  app.patch(`${BASE}/dependencies/:dependencyId`, async (request, reply) => {
    const { params, input, ctx } = await command(request, dependencyParamsSchema, updateTaskDependencyInputSchema);
    return sendData(request, reply, taskDependencyResponseSchema, await deps.dependencies.updateDependency(ctx, params.dependencyId, input));
  });
  app.get(`${BASE}/tasks/:taskId/blocking`, async (request, reply) => {
    const { params, query, ctx } = await read(request, taskParamsSchema, taskBlockingQuerySchema);
    const page = await deps.dependencies.getTaskBlocking(ctx, params.taskId, query);
    return sendData(request, reply, taskBlockingResponseSchema, page.data, { nextCursor: page.nextCursor });
  });
  app.get(`${BASE}/projects/:projectId/dependency-policy`, async (request, reply) => {
    const { params, ctx } = await read(request, projectParamsSchema, noQuerySchema);
    return sendData(request, reply, projectDependencyPolicyResponseSchema, await deps.dependencies.getProjectPolicy(ctx, params.projectId));
  });
  app.patch(`${BASE}/projects/:projectId/dependency-policy`, async (request, reply) => {
    const { params, input, ctx } = await command(request, projectParamsSchema, updateDependencyPolicyInputSchema);
    return sendData(request, reply, projectDependencyPolicyResponseSchema, await deps.dependencies.updateProjectPolicy(ctx, params.projectId, input));
  });
  app.get(`${BASE}/projects/:projectId/graph`, async (request, reply) => {
    // The HTTP schema parses CSV exactly once; the port receives normalized UUID[] and numeric depth.
    const { params, query, ctx } = await read(request, projectParamsSchema, dependencyGraphQuerySchema);
    return sendData(request, reply, dependencyGraphResponseSchema, await deps.dependencies.getGraph(ctx, params.projectId, query));
  });
  app.get(`${BASE}/projects/:projectId/graph-layout`, async (request, reply) => {
    const { params, ctx } = await read(request, projectParamsSchema, noQuerySchema);
    return sendData(request, reply, graphLayoutResponseSchema, await deps.dependencies.getGraphLayout(ctx, params.projectId));
  });
  app.put(`${BASE}/projects/:projectId/graph-layout`, { bodyLimit: LAYOUT_BODY_LIMIT }, async (request, reply) => {
    const { params, input, ctx } = await command(request, projectParamsSchema, setGraphLayoutInputSchema);
    return sendData(request, reply, graphLayoutResponseSchema, await deps.dependencies.setGraphLayout(ctx, params.projectId, input));
  });
}
