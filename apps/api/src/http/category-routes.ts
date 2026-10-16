import {
  categorizedWorkLogResponseSchema,
  createWorkTypeReportRunInputSchema,
  idSchema,
  planningPageQuerySchema,
  projectWorkCategoryBindingResponseSchema,
  recategorizeWorkLogInputSchema,
  taskTimeSummaryQuerySchema,
  taskTimeSummaryResponseSchema,
  updateProjectWorkCategoryBindingInputSchema,
  workTypeReportRowListResponseSchema,
  workTypeReportRunListQuerySchema,
  workTypeReportRunListResponseSchema,
  workTypeReportRunResponseSchema,
} from '@workloom/contracts';
import { toCommandContext, type CommandContext, type WorkCategoryApplication } from '@workloom/domain';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';

import type { IdentityAdapter } from '../identity/identity-adapter.js';
import { parseInput, sendData } from './envelope.js';
import { readIdempotencyKey } from './task-routes.js';

export interface CategoryRouteDependencies {
  readonly identity: IdentityAdapter;
  readonly categories: WorkCategoryApplication;
}

const BASE = '/api/v1/workspaces/:workspaceId';
const workspaceParamsSchema = z.object({ workspaceId: idSchema });
const projectParamsSchema = z.object({ workspaceId: idSchema, projectId: idSchema });
const workLogParamsSchema = z.object({ workspaceId: idSchema, workLogId: idSchema });
const reportParamsSchema = z.object({ workspaceId: idSchema, runId: idSchema });
const summaryParamsSchema = z.object({ workspaceId: idSchema, projectId: idSchema, periodId: idSchema });
const noQuerySchema = z.strictObject({});

/**
 * P2b HTTP adapter only (docs/14-p2b-contract.md). Current access, binding/value ownership,
 * category snapshots, reasoned revisions and complete pinned denominators belong to the
 * shared application. This adapter never changes the existing work.set input or response.
 */
export function registerCategoryRoutes(app: FastifyInstance, deps: CategoryRouteDependencies): void {
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
  ): Promise<{ params: P; input: B; ctx: CommandContext }> {
    const params = parseInput(paramsSchema, request.params);
    parseInput(noQuerySchema, request.query);
    const key = readIdempotencyKey(request);
    const input = parseInput(bodySchema, request.body);
    return { params, input, ctx: await context(request, params.workspaceId, key) };
  }

  app.get(`${BASE}/projects/:projectId/work-category-binding`, async (request, reply) => {
    const { params, ctx } = await read(request, projectParamsSchema, noQuerySchema);
    return sendData(request, reply, projectWorkCategoryBindingResponseSchema, await deps.categories.getBinding(ctx, params.projectId));
  });

  app.patch(`${BASE}/projects/:projectId/work-category-binding`, async (request, reply) => {
    const { params, input, ctx } = await command(request, projectParamsSchema, updateProjectWorkCategoryBindingInputSchema);
    return sendData(request, reply, projectWorkCategoryBindingResponseSchema, await deps.categories.updateBinding(ctx, params.projectId, input));
  });

  app.post(`${BASE}/worklogs/:workLogId/recategorize`, async (request, reply) => {
    const { params, input, ctx } = await command(request, workLogParamsSchema, recategorizeWorkLogInputSchema);
    return sendData(request, reply, categorizedWorkLogResponseSchema, await deps.categories.recategorizeWorkLog(ctx, params.workLogId, input));
  });

  app.get(`${BASE}/work-type-report-runs`, async (request, reply) => {
    const { query, ctx } = await read(request, workspaceParamsSchema, workTypeReportRunListQuerySchema);
    const page = await deps.categories.listReportRuns(ctx, query);
    return sendData(request, reply, workTypeReportRunListResponseSchema, page.items, { nextCursor: page.nextCursor });
  });

  app.post(`${BASE}/work-type-report-runs`, async (request, reply) => {
    const { input, ctx } = await command(request, workspaceParamsSchema, createWorkTypeReportRunInputSchema);
    return sendData(request, reply, workTypeReportRunResponseSchema, await deps.categories.createReportRun(ctx, input), { statusCode: 201 });
  });

  app.get(`${BASE}/work-type-report-runs/:runId`, async (request, reply) => {
    const { params, ctx } = await read(request, reportParamsSchema, noQuerySchema);
    return sendData(request, reply, workTypeReportRunResponseSchema, await deps.categories.getReportRun(ctx, params.runId));
  });

  app.get(`${BASE}/work-type-report-runs/:runId/rows`, async (request, reply) => {
    const { params, query, ctx } = await read(request, reportParamsSchema, planningPageQuerySchema);
    const page = await deps.categories.listReportRows(ctx, params.runId, query);
    return sendData(request, reply, workTypeReportRowListResponseSchema, page.items, { nextCursor: page.nextCursor });
  });

  app.get(`${BASE}/projects/:projectId/periods/:periodId/task-time-summary`, async (request, reply) => {
    const { params, query, ctx } = await read(request, summaryParamsSchema, taskTimeSummaryQuerySchema);
    return sendData(request, reply, taskTimeSummaryResponseSchema, await deps.categories.getTaskTimeSummary(ctx, params.projectId, params.periodId, query));
  });
}
