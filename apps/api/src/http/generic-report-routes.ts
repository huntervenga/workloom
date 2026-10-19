import * as C from '@workloom/contracts';
import { toCommandContext, type CommandContext, type GenericReportApplication } from '@workloom/domain';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { IdentityAdapter } from '../identity/identity-adapter.js';
import { parseInput, sendData } from './envelope.js';
import { readIdempotencyKey } from './task-routes.js';
const base = '/api/v1/workspaces/:workspaceId';
const workspace = z.strictObject({ workspaceId: C.idSchema });
const project = workspace.extend({ projectId: C.idSchema });
const report = workspace.extend({ reportId: C.idSchema });
const snapshot = report.extend({ snapshotId: C.idSchema });
const none = z.strictObject({});
export function registerGenericReportRoutes(app: FastifyInstance, deps: { identity: IdentityAdapter; reports: GenericReportApplication }): void {
  async function context(request: FastifyRequest, workspaceId: string, key?: string): Promise<CommandContext> {
    return toCommandContext({ actor: await deps.identity.resolveActor(request), source: 'web', requestId: request.id }, workspaceId, key);
  }
  async function read<P extends { workspaceId: string }, Q>(request: FastifyRequest, params: z.ZodType<P>, query: z.ZodType<Q>) {
    const p = parseInput(params, request.params), q = parseInput(query, request.query);
    return { p, q, ctx: await context(request, p.workspaceId) };
  }
  async function body<P extends { workspaceId: string }, I>(request: FastifyRequest, params: z.ZodType<P>, input: z.ZodType<I>, write: boolean) {
    const p = parseInput(params, request.params); parseInput(none, request.query);
    const key = write ? readIdempotencyKey(request) : undefined;
    const value = parseInput(input, request.body);
    return { p, input: value, ctx: await context(request, p.workspaceId, key) };
  }
  app.get(`${base}/workspace-reports/sources`, async(request,reply)=>{
    const {ctx}=await read(request,workspace,none);
    return sendData(request,reply,C.workspaceReportSourcesResponseSchema,await deps.reports.workspaceSources(ctx));
  });
  app.post(`${base}/workspace-reports/query`,async(request,reply)=>{
    const {input,ctx}=await body(request,workspace,C.workspaceReportQueryInputSchema,false);
    return sendData(request,reply,C.workspaceReportResultResponseSchema,await deps.reports.workspaceQuery(ctx,input));
  });
  app.get(`${base}/generic-reports`, async (request, reply) => {
    const { q, ctx } = await read(request, workspace, C.genericReportListQuerySchema);
    return sendData(request, reply, C.genericReportDefinitionListResponseSchema, await deps.reports.list(ctx, q.projectId), { list: true });
  });
  app.post(`${base}/generic-reports`, async (request, reply) => {
    const { input, ctx } = await body(request, workspace, C.createGenericReportInputSchema, true);
    return sendData(request, reply, C.genericReportDefinitionResponseSchema, await deps.reports.create(ctx, input), { statusCode: 201 });
  });
  app.get(`${base}/generic-reports/:reportId`, async (request, reply) => {
    const { p, ctx } = await read(request, report, none);
    return sendData(request, reply, C.genericReportDefinitionResponseSchema, await deps.reports.get(ctx, p.reportId));
  });
  app.patch(`${base}/generic-reports/:reportId`, async (request, reply) => {
    const { p, input, ctx } = await body(request, report, C.updateGenericReportInputSchema, true);
    return sendData(request, reply, C.genericReportDefinitionResponseSchema, await deps.reports.update(ctx, p.reportId, input));
  });
  app.post(`${base}/generic-reports/:reportId/query`, async (request, reply) => {
    const { p, input, ctx } = await body(request, report, C.queryGenericReportInputSchema, false);
    return sendData(request, reply, C.genericReportResultResponseSchema, await deps.reports.query(ctx, p.reportId, input));
  });
  app.get(`${base}/generic-reports/:reportId/initial-snapshots`, async (request, reply) => {
    const { p, ctx } = await read(request, report, none);
    return sendData(request, reply, C.genericInitialSnapshotListResponseSchema, await deps.reports.listSnapshots(ctx, p.reportId), { list: true });
  });
  app.post(`${base}/generic-reports/:reportId/initial-snapshots`, async (request, reply) => {
    const { p, input, ctx } = await body(request, report, C.captureGenericInitialInputSchema, true);
    return sendData(request, reply, C.genericInitialSnapshotResponseSchema, await deps.reports.capture(ctx, p.reportId, input), { statusCode: 201 });
  });
  app.get(`${base}/generic-reports/:reportId/initial-snapshots/:snapshotId`, async (request, reply) => {
    const { p, ctx } = await read(request, snapshot, none);
    return sendData(request, reply, C.genericInitialSnapshotResponseSchema, await deps.reports.getSnapshot(ctx, p.reportId, p.snapshotId));
  });
  app.get(`${base}/projects/:projectId/field-aggregate-settings`, async (request, reply) => {
    const { p, ctx } = await read(request, project, none);
    return sendData(request, reply, C.genericAggregateSettingsResponseSchema, await deps.reports.getSettings(ctx, p.projectId));
  });
  app.put(`${base}/projects/:projectId/field-aggregate-settings`, async (request, reply) => {
    const { p, input, ctx } = await body(request, project, C.setGenericAggregateSettingsInputSchema, true);
    return sendData(request, reply, C.genericAggregateSettingsResponseSchema, await deps.reports.setSettings(ctx, p.projectId, input));
  });
  app.post(`${base}/projects/:projectId/field-aggregates`, async (request, reply) => {
    const { p, input, ctx } = await body(request, project, C.queryGenericAggregatesInputSchema, false);
    return sendData(request, reply, C.genericReportResultResponseSchema, await deps.reports.aggregates(ctx, p.projectId, input));
  });
  app.post(`${base}/projects/:projectId/plan-fact-template`, async (request, reply) => {
    const { p, input, ctx } = await body(request, project, C.planFactTemplateInputSchema, true);
    return sendData(request, reply, C.planFactTemplateResultResponseSchema, await deps.reports.template(ctx, p.projectId, input), { statusCode: 201 });
  });
}
