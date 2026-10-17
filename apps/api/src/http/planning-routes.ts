import {
  createPeriodCommitmentInputSchema,
  createPlanningPeriodInputSchema,
  createWeeklyPlanFactReportInputSchema,
  freezePlanInputSchema,
  freezePreviewInputSchema,
  freezePreviewResponseSchema,
  idSchema,
  manualPeriodWorkLogListResponseSchema,
  manualPeriodWorkLogResponseSchema,
  originalPackageEstimateResponseSchema,
  packageBaselineResponseSchema,
  periodCommitmentListQuerySchema,
  periodCommitmentListResponseSchema,
  periodCommitmentResponseSchema,
  planBaselineListResponseSchema,
  planBaselineResponseSchema,
  planningPackageListQuerySchema,
  planningPackageListResponseSchema,
  planningPageQuerySchema,
  planningPeriodListQuerySchema,
  planningPeriodListResponseSchema,
  planningPeriodResponseSchema,
  reportRunListQuerySchema,
  setManualPeriodWorkInputSchema,
  updatePeriodCommitmentInputSchema,
  updatePlanningPeriodInputSchema,
  weeklyPlanFactReportRunListResponseSchema,
  weeklyPlanFactReportRunResponseSchema,
  weeklyPlanFactRowListResponseSchema,
  workLogListQuerySchema,
} from '@workloom/contracts';
import { toCommandContext, type CommandContext, type PlanningApplication } from '@workloom/domain';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';

import type { IdentityAdapter } from '../identity/identity-adapter.js';
import { parseInput, sendData } from './envelope.js';
import { readIdempotencyKey } from './task-routes.js';

export interface PlanningRouteDependencies {
  readonly identity: IdentityAdapter;
  readonly planning: PlanningApplication;
}

const BASE = '/api/v1/workspaces/:workspaceId';
const workspaceParamsSchema = z.object({ workspaceId: idSchema });
const periodParamsSchema = z.object({ workspaceId: idSchema, periodId: idSchema });
const commitmentParamsSchema = z.object({ workspaceId: idSchema, periodId: idSchema, commitmentId: idSchema });
const baselineParamsSchema = z.object({ workspaceId: idSchema, baselineId: idSchema });
const packageParamsSchema = z.object({ workspaceId: idSchema, packageId: idSchema });
const reportParamsSchema = z.object({ workspaceId: idSchema, runId: idSchema });
const manualWorkParamsSchema = z.object({ workspaceId: idSchema, taskId: idSchema, periodId: idSchema, membershipId: idSchema });
const noQuerySchema = z.strictObject({});

/**
 * P2a transport only (docs/13-p2a-contract.md). Current access, self/others capabilities, source
 * identity, revision guards, freeze previews, cutoff transitions and pinned reports belong to
 * the shared PlanningApplication. A committed rejection reaches this adapter as a DomainError
 * only after its database transaction has committed; the normal error handler maps it to 409.
 */
export function registerPlanningRoutes(app: FastifyInstance, deps: PlanningRouteDependencies): void {
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

  app.get(`${BASE}/periods`, async (request, reply) => {
    const { query, ctx } = await read(request, workspaceParamsSchema, planningPeriodListQuerySchema);
    const page = await deps.planning.listPeriods(ctx, query);
    return sendData(request, reply, planningPeriodListResponseSchema, page.items, { nextCursor: page.nextCursor });
  });

  app.post(`${BASE}/periods`, async (request, reply) => {
    const { input, ctx } = await command(request, workspaceParamsSchema, createPlanningPeriodInputSchema);
    return sendData(request, reply, planningPeriodResponseSchema, await deps.planning.createPeriod(ctx, input), { statusCode: 201 });
  });

  app.get(`${BASE}/periods/:periodId`, async (request, reply) => {
    const { params, ctx } = await read(request, periodParamsSchema, noQuerySchema);
    return sendData(request, reply, planningPeriodResponseSchema, await deps.planning.getPeriod(ctx, params.periodId));
  });

  app.patch(`${BASE}/periods/:periodId`, async (request, reply) => {
    const { params, input, ctx } = await command(request, periodParamsSchema, updatePlanningPeriodInputSchema);
    return sendData(request, reply, planningPeriodResponseSchema, await deps.planning.updatePeriod(ctx, params.periodId, input));
  });

  app.get(`${BASE}/planning-packages`, async (request, reply) => {
    const { query, ctx } = await read(request, workspaceParamsSchema, planningPackageListQuerySchema);
    const page = await deps.planning.listPackages(ctx, query);
    return sendData(request, reply, planningPackageListResponseSchema, page.items, { nextCursor: page.nextCursor });
  });

  // Read-only first-freeze projection for one package; separate from PlanningPackageDto and snapshots.
  app.get(`${BASE}/planning-packages/:packageId/original-estimate`, async (request, reply) => {
    const { params, ctx } = await read(request, packageParamsSchema, noQuerySchema);
    return sendData(request, reply, originalPackageEstimateResponseSchema, await deps.planning.getOriginalPackageEstimate(ctx, params.packageId));
  });

  app.get(`${BASE}/periods/:periodId/commitments`, async (request, reply) => {
    const { params, query, ctx } = await read(request, periodParamsSchema, periodCommitmentListQuerySchema);
    const page = await deps.planning.listCommitments(ctx, params.periodId, query);
    return sendData(request, reply, periodCommitmentListResponseSchema, page.items, { nextCursor: page.nextCursor });
  });

  app.post(`${BASE}/periods/:periodId/commitments`, async (request, reply) => {
    const { params, input, ctx } = await command(request, periodParamsSchema, createPeriodCommitmentInputSchema);
    return sendData(request, reply, periodCommitmentResponseSchema, await deps.planning.createCommitment(ctx, params.periodId, input), {
      statusCode: 201,
    });
  });

  app.put(`${BASE}/periods/:periodId/commitments/:commitmentId`, async (request, reply) => {
    const { params, input, ctx } = await command(request, commitmentParamsSchema, updatePeriodCommitmentInputSchema);
    return sendData(
      request,
      reply,
      periodCommitmentResponseSchema,
      await deps.planning.updateCommitment(ctx, params.periodId, params.commitmentId, input),
    );
  });

  app.post(`${BASE}/periods/:periodId/freeze-preview`, async (request, reply) => {
    // A consistent read, despite POST: no key and no cutoff transition. Origin guarding still applies.
    const { params, input, ctx } = await command(request, periodParamsSchema, freezePreviewInputSchema, false);
    return sendData(request, reply, freezePreviewResponseSchema, await deps.planning.previewFreeze(ctx, params.periodId, input));
  });

  app.post(`${BASE}/periods/:periodId/freeze`, async (request, reply) => {
    const { params, input, ctx } = await command(request, periodParamsSchema, freezePlanInputSchema);
    return sendData(request, reply, planBaselineResponseSchema, await deps.planning.freezePlan(ctx, params.periodId, input));
  });

  app.get(`${BASE}/periods/:periodId/baselines`, async (request, reply) => {
    const { params, query, ctx } = await read(request, periodParamsSchema, planningPageQuerySchema);
    const page = await deps.planning.listBaselines(ctx, params.periodId, query);
    return sendData(request, reply, planBaselineListResponseSchema, page.items, { nextCursor: page.nextCursor });
  });

  app.get(`${BASE}/baselines/:baselineId`, async (request, reply) => {
    const { params, ctx } = await read(request, baselineParamsSchema, noQuerySchema);
    return sendData(request, reply, planBaselineResponseSchema, await deps.planning.getBaseline(ctx, params.baselineId));
  });

  app.get(`${BASE}/package-baselines/:baselineId`, async (request, reply) => {
    const { params, ctx } = await read(request, baselineParamsSchema, noQuerySchema);
    return sendData(request, reply, packageBaselineResponseSchema, await deps.planning.getPackageBaseline(ctx, params.baselineId));
  });

  app.get(`${BASE}/worklogs`, async (request, reply) => {
    const { query, ctx } = await read(request, workspaceParamsSchema, workLogListQuerySchema);
    const page = await deps.planning.listWorkLogs(ctx, query);
    return sendData(request, reply, manualPeriodWorkLogListResponseSchema, page.items, { nextCursor: page.nextCursor });
  });

  app.put(`${BASE}/tasks/:taskId/manual-period-work/:periodId/:membershipId`, async (request, reply) => {
    const { params, input, ctx } = await command(request, manualWorkParamsSchema, setManualPeriodWorkInputSchema);
    return sendData(
      request,
      reply,
      manualPeriodWorkLogResponseSchema,
      await deps.planning.setManualPeriodWork(ctx, params.taskId, params.periodId, params.membershipId, input),
    );
  });

  app.get(`${BASE}/report-runs`, async (request, reply) => {
    const { query, ctx } = await read(request, workspaceParamsSchema, reportRunListQuerySchema);
    const page = await deps.planning.listReportRuns(ctx, query);
    return sendData(request, reply, weeklyPlanFactReportRunListResponseSchema, page.items, { nextCursor: page.nextCursor });
  });

  app.post(`${BASE}/report-runs`, async (request, reply) => {
    const { input, ctx } = await command(request, workspaceParamsSchema, createWeeklyPlanFactReportInputSchema);
    return sendData(request, reply, weeklyPlanFactReportRunResponseSchema, await deps.planning.createReportRun(ctx, input), {
      statusCode: 201,
    });
  });

  app.get(`${BASE}/report-runs/:runId`, async (request, reply) => {
    const { params, ctx } = await read(request, reportParamsSchema, noQuerySchema);
    return sendData(request, reply, weeklyPlanFactReportRunResponseSchema, await deps.planning.getReportRun(ctx, params.runId));
  });

  app.get(`${BASE}/report-runs/:runId/rows`, async (request, reply) => {
    const { params, query, ctx } = await read(request, reportParamsSchema, planningPageQuerySchema);
    const page = await deps.planning.listReportRows(ctx, params.runId, query);
    return sendData(request, reply, weeklyPlanFactRowListResponseSchema, page.items, { nextCursor: page.nextCursor });
  });
}
