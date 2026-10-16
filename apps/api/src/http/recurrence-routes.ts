import {
  addRecurrencePeriodsInputSchema,
  authorizeRecurrenceGenerationInputSchema,
  createRecurrenceSeriesInputSchema,
  editRecurrenceSeriesInputSchema,
  idSchema,
  materializePeriodInputSchema,
  recurrenceCalendarDateSchema,
  recurrenceCreatePreviewInputSchema,
  recurrenceCreatePreviewResponseSchema,
  recurrenceEditPreviewInputSchema,
  recurrenceEditPreviewResponseSchema,
  recurrenceExceptionPreviewInputSchema,
  recurrenceExceptionPreviewResponseSchema,
  recurrenceInstanceListQuerySchema,
  recurrenceInstanceListResponseSchema,
  recurrenceInstanceResponseSchema,
  recurrenceMaterializationResultResponseSchema,
  recurrencePeriodPreviewInputSchema,
  recurrencePeriodPreviewResponseSchema,
  recurrencePeriodsResultResponseSchema,
  recurrenceReadinessResponseSchema,
  recurrenceSeriesListQuerySchema,
  recurrenceSeriesListResponseSchema,
  recurrenceSeriesResponseSchema,
  setRecurrenceExceptionInputSchema,
  setRecurrenceSeriesStateInputSchema,
} from '@workloom/contracts';
import { toCommandContext, type CommandContext, type RecurrenceApplication } from '@workloom/domain';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';

import type { IdentityAdapter } from '../identity/identity-adapter.js';
import { parseInput, sendData } from './envelope.js';
import { readIdempotencyKey } from './task-routes.js';

export interface RecurrenceRouteDependencies {
  readonly identity: IdentityAdapter;
  readonly recurrence: RecurrenceApplication;
}

const BASE = '/api/v1/workspaces/:workspaceId';
const SERIES = `${BASE}/recurrence-series/:seriesId`;
const INSTANCE = `${SERIES}/instances/:occurrenceKey`;
const projectParamsSchema = z.object({ workspaceId: idSchema, projectId: idSchema });
const seriesParamsSchema = z.object({ workspaceId: idSchema, seriesId: idSchema });
// The occurrence key is the original nominal local date (bounded recurrence range), never an instance UUID.
const occurrenceParamsSchema = z.object({ workspaceId: idSchema, seriesId: idSchema, occurrenceKey: recurrenceCalendarDateSchema });
const periodParamsSchema = z.object({ workspaceId: idSchema, periodId: idSchema });
const noQuerySchema = z.strictObject({});
// Only template-bearing create/edit commands and their previews exceed the global16KiB cap
// (title500 + HTTP(S) link2048 + 100 attendees + 52 periods as escaped Unicode). No legacy route changes.
const RECURRENCE_TEMPLATE_BODY_LIMIT = 64 * 1024;

/**
 * P3b recurrence transport only (docs/16-p3b-contract.md §5). Domain commands own current ACL
 * before replay, source manifests/hashes, signed cursors, preview conflicts, period census,
 * prerequisite recovery and resolution. Previews are keyless reads that still need a trusted Origin.
 */
export function registerRecurrenceRoutes(app: FastifyInstance, deps: RecurrenceRouteDependencies): void {
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

  app.get(`${BASE}/projects/:projectId/recurrence-series`, async (request, reply) => {
    const { params, query, ctx } = await read(request, projectParamsSchema, recurrenceSeriesListQuerySchema);
    const page = await deps.recurrence.listSeries(ctx, params.projectId, query);
    return sendData(request, reply, recurrenceSeriesListResponseSchema, page.items, { nextCursor: page.nextCursor });
  });

  app.post(`${BASE}/projects/:projectId/recurrence-preview`, { bodyLimit: RECURRENCE_TEMPLATE_BODY_LIMIT }, async (request, reply) => {
    const { params, input, ctx } = await command(request, projectParamsSchema, recurrenceCreatePreviewInputSchema, false);
    return sendData(request, reply, recurrenceCreatePreviewResponseSchema, await deps.recurrence.previewCreate(ctx, params.projectId, input));
  });

  app.post(`${BASE}/projects/:projectId/recurrence-series`, { bodyLimit: RECURRENCE_TEMPLATE_BODY_LIMIT }, async (request, reply) => {
    const { params, input, ctx } = await command(request, projectParamsSchema, createRecurrenceSeriesInputSchema);
    return sendData(request, reply, recurrenceSeriesResponseSchema, await deps.recurrence.createSeries(ctx, params.projectId, input), { statusCode: 201 });
  });

  app.get(SERIES, async (request, reply) => {
    const { params, ctx } = await read(request, seriesParamsSchema, noQuerySchema);
    return sendData(request, reply, recurrenceSeriesResponseSchema, await deps.recurrence.getSeries(ctx, params.seriesId));
  });

  app.post(`${SERIES}/edit-preview`, { bodyLimit: RECURRENCE_TEMPLATE_BODY_LIMIT }, async (request, reply) => {
    const { params, input, ctx } = await command(request, seriesParamsSchema, recurrenceEditPreviewInputSchema, false);
    return sendData(request, reply, recurrenceEditPreviewResponseSchema, await deps.recurrence.previewEdit(ctx, params.seriesId, input));
  });

  app.post(`${SERIES}/edit`, { bodyLimit: RECURRENCE_TEMPLATE_BODY_LIMIT }, async (request, reply) => {
    const { params, input, ctx } = await command(request, seriesParamsSchema, editRecurrenceSeriesInputSchema);
    return sendData(request, reply, recurrenceSeriesResponseSchema, await deps.recurrence.editSeries(ctx, params.seriesId, input));
  });

  app.patch(`${SERIES}/state`, async (request, reply) => {
    const { params, input, ctx } = await command(request, seriesParamsSchema, setRecurrenceSeriesStateInputSchema);
    return sendData(request, reply, recurrenceSeriesResponseSchema, await deps.recurrence.setState(ctx, params.seriesId, input));
  });

  app.post(`${SERIES}/period-preview`, async (request, reply) => {
    const { params, input, ctx } = await command(request, seriesParamsSchema, recurrencePeriodPreviewInputSchema, false);
    return sendData(request, reply, recurrencePeriodPreviewResponseSchema, await deps.recurrence.previewPeriods(ctx, params.seriesId, input));
  });

  app.post(`${SERIES}/periods`, async (request, reply) => {
    const { params, input, ctx } = await command(request, seriesParamsSchema, addRecurrencePeriodsInputSchema);
    return sendData(request, reply, recurrencePeriodsResultResponseSchema, await deps.recurrence.addPeriods(ctx, params.seriesId, input));
  });

  app.post(`${SERIES}/generation-authorization`, async (request, reply) => {
    const { params, input, ctx } = await command(request, seriesParamsSchema, authorizeRecurrenceGenerationInputSchema);
    return sendData(request, reply, recurrenceSeriesResponseSchema, await deps.recurrence.authorizeGeneration(ctx, params.seriesId, input));
  });

  app.get(`${SERIES}/instances`, async (request, reply) => {
    const { params, query, ctx } = await read(request, seriesParamsSchema, recurrenceInstanceListQuerySchema);
    const page = await deps.recurrence.listInstances(ctx, params.seriesId, query);
    return sendData(request, reply, recurrenceInstanceListResponseSchema, page.items, { nextCursor: page.nextCursor });
  });

  app.post(`${INSTANCE}/exception-preview`, async (request, reply) => {
    const { params, input, ctx } = await command(request, occurrenceParamsSchema, recurrenceExceptionPreviewInputSchema, false);
    const preview = await deps.recurrence.previewException(ctx, params.seriesId, params.occurrenceKey, input);
    return sendData(request, reply, recurrenceExceptionPreviewResponseSchema, preview);
  });

  app.post(`${INSTANCE}/exception`, async (request, reply) => {
    const { params, input, ctx } = await command(request, occurrenceParamsSchema, setRecurrenceExceptionInputSchema);
    const instance = await deps.recurrence.setException(ctx, params.seriesId, params.occurrenceKey, input);
    return sendData(request, reply, recurrenceInstanceResponseSchema, instance);
  });

  app.post(`${BASE}/periods/:periodId/materialize-meetings`, async (request, reply) => {
    const { params, input, ctx } = await command(request, periodParamsSchema, materializePeriodInputSchema);
    return sendData(request, reply, recurrenceMaterializationResultResponseSchema, await deps.recurrence.materializePeriod(ctx, params.periodId, input));
  });

  app.get(`${BASE}/periods/:periodId/recurrence-readiness`, async (request, reply) => {
    const { params, ctx } = await read(request, periodParamsSchema, noQuerySchema);
    return sendData(request, reply, recurrenceReadinessResponseSchema, await deps.recurrence.getReadiness(ctx, params.periodId));
  });
}
