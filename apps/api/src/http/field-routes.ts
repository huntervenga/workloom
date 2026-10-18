import {
  setTaskFieldPolicyInputSchema, setTaskFieldValueExceptionInputSchema, taskFieldPolicyResponseSchema, taskFieldPolicyStateResponseSchema,
  createTaskFieldInputSchema,
  createTaskFieldOptionInputSchema,
  idSchema,
  projectColumnsResponseSchema,
  setTaskFieldValueInputSchema,
  taskFieldBatchQuerySchema,
  taskFieldDefinitionListResponseSchema,
  taskFieldDefinitionResponseSchema,
  taskFieldHistoryQuerySchema,
  taskFieldListQuerySchema,
  taskFieldValueHistoryListResponseSchema,
  taskFieldValueListResponseSchema,
  taskFieldValueResponseSchema,
  updateProjectColumnsInputSchema,
  updateTaskFieldInputSchema,
  updateTaskFieldOptionInputSchema,
} from '@workloom/contracts';
import { toCommandContext, type CommandContext, type TaskFieldApplication } from '@workloom/domain';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';

import type { IdentityAdapter } from '../identity/identity-adapter.js';
import { parseInput, sendData } from './envelope.js';
import { readIdempotencyKey } from './task-routes.js';

export interface FieldRouteDependencies {
  readonly identity: IdentityAdapter;
  readonly fields: TaskFieldApplication;
}

const workspaceParamsSchema = z.object({ workspaceId: idSchema });
const fieldParamsSchema = z.object({ workspaceId: idSchema, fieldId: idSchema });
const optionParamsSchema = z.object({ workspaceId: idSchema, fieldId: idSchema, optionId: idSchema });
const projectParamsSchema = z.object({ workspaceId: idSchema, projectId: idSchema });
const taskParamsSchema = z.object({ workspaceId: idSchema, taskId: idSchema });
const taskValueParamsSchema = z.object({ workspaceId: idSchema, taskId: idSchema, fieldId: idSchema });

/** Reads without published query parameters reject any query key. */
const noQuerySchema = z.strictObject({});

const BASE = '/api/v1/workspaces/:workspaceId';

/**
 * P1b custom fields, project column settings, typed values and value history (catalog in
 * @workloom/contracts fields.ts). The adapter only parses input, builds the trusted context and
 * validates the response; access, project scope, locks, revisions, idempotency and history
 * belong to the TaskFieldApplication.
 */
export function registerFieldRoutes(app: FastifyInstance, deps: FieldRouteDependencies): void {
  async function context(request: FastifyRequest, workspaceId: string, idempotencyKey?: string): Promise<CommandContext> {
    const actor = await deps.identity.resolveActor(request);
    return toCommandContext({ actor, source: 'web', requestId: request.id }, workspaceId, idempotencyKey);
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

  app.get(`${BASE}/fields/:fieldId/policy`,async(request,reply)=>{
    const {params,ctx}=await read(request,fieldParamsSchema,noQuerySchema);
    return sendData(request,reply,taskFieldPolicyResponseSchema,await deps.fields.getPolicy(ctx,params.fieldId));
  });
  app.put(`${BASE}/fields/:fieldId/policy`,async(request,reply)=>{
    const {params,input,ctx}=await write(request,fieldParamsSchema,setTaskFieldPolicyInputSchema);
    return sendData(request,reply,taskFieldPolicyResponseSchema,await deps.fields.setPolicy(ctx,params.fieldId,input));
  });
  app.get(`${BASE}/tasks/:taskId/field-values/:fieldId/policy-state`,async(request,reply)=>{
    const {params,ctx}=await read(request,taskValueParamsSchema,noQuerySchema);
    return sendData(request,reply,taskFieldPolicyStateResponseSchema,await deps.fields.getPolicyState(ctx,params.taskId,params.fieldId));
  });
  app.post(`${BASE}/tasks/:taskId/field-values/:fieldId/exception`,async(request,reply)=>{
    const {params,input,ctx}=await write(request,taskValueParamsSchema,setTaskFieldValueExceptionInputSchema);
    return sendData(request,reply,taskFieldValueResponseSchema,await deps.fields.setTaskValueException(ctx,params.taskId,params.fieldId,input));
  });

  // Field definitions and options
  app.get(`${BASE}/fields`, async (request, reply) => {
    const { query, ctx } = await read(request, workspaceParamsSchema, taskFieldListQuerySchema);
    return sendData(request, reply, taskFieldDefinitionListResponseSchema, await deps.fields.listFields(ctx, query.projectId), {
      list: true,
    });
  });

  app.post(`${BASE}/fields`, async (request, reply) => {
    const { input, ctx } = await write(request, workspaceParamsSchema, createTaskFieldInputSchema);
    return sendData(request, reply, taskFieldDefinitionResponseSchema, await deps.fields.createField(ctx, input), { statusCode: 201 });
  });

  app.patch(`${BASE}/fields/:fieldId`, async (request, reply) => {
    const { params, input, ctx } = await write(request, fieldParamsSchema, updateTaskFieldInputSchema);
    return sendData(request, reply, taskFieldDefinitionResponseSchema, await deps.fields.updateField(ctx, params.fieldId, input));
  });

  app.post(`${BASE}/fields/:fieldId/options`, async (request, reply) => {
    const { params, input, ctx } = await write(request, fieldParamsSchema, createTaskFieldOptionInputSchema);
    return sendData(request, reply, taskFieldDefinitionResponseSchema, await deps.fields.createOption(ctx, params.fieldId, input), {
      statusCode: 201,
    });
  });

  app.patch(`${BASE}/fields/:fieldId/options/:optionId`, async (request, reply) => {
    const { params, input, ctx } = await write(request, optionParamsSchema, updateTaskFieldOptionInputSchema);
    return sendData(
      request,
      reply,
      taskFieldDefinitionResponseSchema,
      await deps.fields.updateOption(ctx, params.fieldId, params.optionId, input),
    );
  });

  // Shared project column settings
  app.get(`${BASE}/projects/:projectId/columns`, async (request, reply) => {
    const { params, ctx } = await read(request, projectParamsSchema, noQuerySchema);
    return sendData(request, reply, projectColumnsResponseSchema, await deps.fields.getProjectColumns(ctx, params.projectId));
  });

  app.patch(`${BASE}/projects/:projectId/columns`, async (request, reply) => {
    const { params, input, ctx } = await write(request, projectParamsSchema, updateProjectColumnsInputSchema);
    return sendData(request, reply, projectColumnsResponseSchema, await deps.fields.updateProjectColumns(ctx, params.projectId, input));
  });

  // Typed values and history
  app.get(`${BASE}/tasks/:taskId/field-values`, async (request, reply) => {
    const { params, ctx } = await read(request, taskParamsSchema, noQuerySchema);
    return sendData(request, reply, taskFieldValueListResponseSchema, await deps.fields.listTaskValues(ctx, params.taskId), { list: true });
  });

  app.get(`${BASE}/projects/:projectId/field-values`, async (request, reply) => {
    const { params, query, ctx } = await read(request, projectParamsSchema, taskFieldBatchQuerySchema);
    return sendData(request, reply, taskFieldValueListResponseSchema, await deps.fields.listProjectValues(ctx, params.projectId, query), {
      list: true,
    });
  });

  app.put(`${BASE}/tasks/:taskId/field-values/:fieldId`, async (request, reply) => {
    const { params, input, ctx } = await write(request, taskValueParamsSchema, setTaskFieldValueInputSchema);
    return sendData(request, reply, taskFieldValueResponseSchema, await deps.fields.setTaskValue(ctx, params.taskId, params.fieldId, input));
  });

  app.get(`${BASE}/tasks/:taskId/field-values/:fieldId/history`, async (request, reply) => {
    const { params, query, ctx } = await read(request, taskValueParamsSchema, taskFieldHistoryQuerySchema);
    const page = await deps.fields.listValueHistory(ctx, params.taskId, params.fieldId, query);
    // The cursor is opaque and bound by the service; it is passed through unmodified.
    return sendData(request, reply, taskFieldValueHistoryListResponseSchema, page.items, { nextCursor: page.nextCursor });
  });
}
