import {
  envelopeSchema, idSchema, publicMeSchema, publicMemberSchema, publicProjectDetailSchema, publicProjectSchema, publicTagSchema,
  publicTaskCreateSchema, publicTaskListQuerySchema, publicTaskUpdateSchema, publicWorkspaceSchema, taskViewSchema, API_TOKEN_LIMITS,
  publicFieldSchema, publicSetTaskFieldsResultSchema, publicSetTaskFieldsSchema, publicTimeSummarySchema, publicTaskAddToProjectSchema, publicTaskProjectSchema, publicProjectCopySchema, publicProjectFromTemplateSchema,
  publicSectionCreateSchema, publicSectionSchema, publicSectionUpdateSchema, publicTagCreateSchema,
} from '@workloom/contracts';
import type { AutomationApplication } from '@workloom/db';
import { DomainError, unauthenticatedError } from '@workloom/domain';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { parseInput, sendData } from './envelope.js';
import { PUBLIC_API_OPENAPI } from './public-api-openapi.js';

export const PUBLIC_API_PREFIX = '/api/public/v1';
const empty = z.strictObject({});
const ws = z.object({ ws: z.string().min(1).max(200) });
const wsProject = ws.extend({ project: z.string().min(1).max(200) });
const wsTask = ws.extend({ taskId: idSchema });
const wsSection = wsProject.extend({ section: z.string().min(1).max(200) });
const IDEMPOTENCY = /^[\x21-\x7e]{1,128}$/;
const taskQuery = z.strictObject({ includeFields: z.enum(['true', 'false']).transform(value => value === 'true').optional() });

export interface PublicApiDependencies { readonly automation: AutomationApplication }

/** `Authorization: Bearer wlm_pat_…` is the only credential; cookies and Origin headers are never consulted. */
export function bearerToken(request: Pick<FastifyRequest, 'headers'>): string {
  const value = request.headers.authorization;
  if (typeof value !== 'string' || !/^Bearer \S+$/.test(value) || value.length > 256) throw unauthenticatedError();
  return value.slice(7);
}

function idempotencyKey(request: FastifyRequest): string | undefined {
  const value = request.headers['idempotency-key'];
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !IDEMPOTENCY.test(value)) throw new DomainError('VALIDATION_FAILED', 'Idempotency-Key must be 1–128 printable ASCII characters.', { details: { fields: ['Idempotency-Key'] } });
  return value;
}

export function registerPublicApiRoutes(app: FastifyInstance, deps: PublicApiDependencies): void {
  const { automation } = deps;
  const base = PUBLIC_API_PREFIX;
  const write = { bodyLimit: API_TOKEN_LIMITS.bodyBytes };

  app.get(`${base}/openapi.json`, async (_request, reply) => reply.type('application/json; charset=utf-8').header('cache-control', 'public, max-age=300').send(PUBLIC_API_OPENAPI));

  app.get(`${base}/me`, async (request, reply) => {
    parseInput(empty, request.query);
    return sendData(request, reply, envelopeSchema(publicMeSchema), await automation.me(bearerToken(request)));
  });
  app.get(`${base}/workspaces`, async (request, reply) => {
    parseInput(empty, request.query);
    return sendData(request, reply, envelopeSchema(publicWorkspaceSchema.array()), await automation.listWorkspaces(bearerToken(request)), { list: true });
  });
  app.get(`${base}/workspaces/:ws/projects`, async (request, reply) => {
    parseInput(empty, request.query);
    const p = parseInput(ws, request.params);
    return sendData(request, reply, envelopeSchema(publicProjectSchema.array()), await automation.listProjects(bearerToken(request), p.ws), { list: true });
  });
  app.get(`${base}/workspaces/:ws/projects/:project`, async (request, reply) => {
    parseInput(empty, request.query);
    const p = parseInput(wsProject, request.params);
    return sendData(request, reply, envelopeSchema(publicProjectDetailSchema), await automation.getProject(bearerToken(request), p.ws, p.project));
  });
  app.get(`${base}/workspaces/:ws/members`, async (request, reply) => {
    parseInput(empty, request.query);
    const p = parseInput(ws, request.params);
    return sendData(request, reply, envelopeSchema(publicMemberSchema.array()), await automation.listMembers(bearerToken(request), p.ws), { list: true });
  });
  app.get(`${base}/workspaces/:ws/tags`, async (request, reply) => {
    parseInput(empty, request.query);
    const p = parseInput(ws, request.params);
    return sendData(request, reply, envelopeSchema(publicTagSchema.array()), await automation.listTags(bearerToken(request), p.ws), { list: true });
  });
  app.get(`${base}/workspaces/:ws/tasks`, async (request, reply) => {
    const p = parseInput(ws, request.params);
    const query = parseInput(publicTaskListQuerySchema, request.query);
    const page = await automation.listTasks(bearerToken(request), p.ws, query);
    return sendData(request, reply, envelopeSchema(taskViewSchema.array()), page.items, { nextCursor: page.nextCursor });
  });
  app.get(`${base}/workspaces/:ws/tasks/:taskId`, async (request, reply) => {
    const query = parseInput(taskQuery, request.query);
    const p = parseInput(wsTask, request.params);
    return sendData(request, reply, envelopeSchema(taskViewSchema), await automation.getTask(bearerToken(request), p.ws, p.taskId, { includeFields: query.includeFields === true }));
  });
  app.get(`${base}/workspaces/:ws/projects/:project/fields`, async (request, reply) => {
    parseInput(empty, request.query);
    const p = parseInput(wsProject, request.params);
    return sendData(request, reply, envelopeSchema(publicFieldSchema.array()), await automation.listFields(bearerToken(request), p.ws, p.project), { list: true });
  });
  app.get(`${base}/workspaces/:ws/projects/:project/time-summary`, async (request, reply) => {
    const p = parseInput(wsProject, request.params);
    const query = typeof request.query === 'object' && request.query !== null ? request.query : {};
    return sendData(request, reply, envelopeSchema(publicTimeSummarySchema), await automation.timeSummary(bearerToken(request), p.ws, { ...query, project: p.project }));
  });
  app.post(`${base}/workspaces/:ws/task-fields`, write, async (request, reply) => {
    parseInput(empty, request.query);
    const p = parseInput(ws, request.params);
    const input = parseInput(publicSetTaskFieldsSchema, request.body);
    const result = await automation.setTaskFields(bearerToken(request), p.ws, input, { requestId: request.id, idempotencyKey: idempotencyKey(request) });
    return sendData(request, reply, envelopeSchema(publicSetTaskFieldsResultSchema), result);
  });
  app.post(`${base}/workspaces/:ws/tasks`, write, async (request, reply) => {
    parseInput(empty, request.query);
    const p = parseInput(ws, request.params);
    const input = parseInput(publicTaskCreateSchema, request.body);
    const task = await automation.createTask(bearerToken(request), p.ws, input, { requestId: request.id, idempotencyKey: idempotencyKey(request) });
    return sendData(request, reply, envelopeSchema(taskViewSchema), task, { statusCode: 201 });
  });
  app.patch(`${base}/workspaces/:ws/tasks/:taskId`, write, async (request, reply) => {
    parseInput(empty, request.query);
    const p = parseInput(wsTask, request.params);
    const input = parseInput(publicTaskUpdateSchema, request.body);
    const task = await automation.updateTask(bearerToken(request), p.ws, p.taskId, input, { requestId: request.id, idempotencyKey: idempotencyKey(request) });
    return sendData(request, reply, envelopeSchema(taskViewSchema), task);
  });
  app.post(`${base}/workspaces/:ws/projects`, write, async (request, reply) => {
    parseInput(empty, request.query);
    const p = parseInput(ws, request.params);
    const input = parseInput(publicProjectFromTemplateSchema, request.body);
    const result = await automation.createProjectFromTemplate(bearerToken(request), p.ws, input, { requestId: request.id, idempotencyKey: idempotencyKey(request) });
    return sendData(request, reply, envelopeSchema(publicProjectCopySchema), result, { statusCode: 201 });
  });
  app.post(`${base}/workspaces/:ws/projects/:project/sections`, write, async (request, reply) => {
    parseInput(empty, request.query);
    const p = parseInput(wsProject, request.params);
    const input = parseInput(publicSectionCreateSchema, request.body);
    const result = await automation.createSection(bearerToken(request), p.ws, p.project, input, { requestId: request.id, idempotencyKey: idempotencyKey(request) });
    return sendData(request, reply, envelopeSchema(publicSectionSchema), result, { statusCode: 201 });
  });
  app.patch(`${base}/workspaces/:ws/projects/:project/sections/:section`, write, async (request, reply) => {
    parseInput(empty, request.query);
    const p = parseInput(wsSection, request.params);
    const input = parseInput(publicSectionUpdateSchema, request.body);
    const result = await automation.renameSection(bearerToken(request), p.ws, p.project, p.section, input, { requestId: request.id, idempotencyKey: idempotencyKey(request) });
    return sendData(request, reply, envelopeSchema(publicSectionSchema), result);
  });
  app.post(`${base}/workspaces/:ws/tags`, write, async (request, reply) => {
    parseInput(empty, request.query);
    const p = parseInput(ws, request.params);
    const input = parseInput(publicTagCreateSchema, request.body);
    const result = await automation.createTag(bearerToken(request), p.ws, input, { requestId: request.id, idempotencyKey: idempotencyKey(request) });
    return sendData(request, reply, envelopeSchema(publicTagSchema), result, { statusCode: 201 });
  });
  app.post(`${base}/workspaces/:ws/tasks/:taskId/projects`, write, async (request, reply) => {
    parseInput(empty, request.query);
    const p = parseInput(wsTask, request.params);
    const input = parseInput(publicTaskAddToProjectSchema, request.body);
    const result = await automation.addTaskToProject(bearerToken(request), p.ws, p.taskId, input, { requestId: request.id, idempotencyKey: idempotencyKey(request) });
    return sendData(request, reply, envelopeSchema(publicTaskProjectSchema), result, { statusCode: result.outcome === 'added' ? 201 : 200 });
  });
}
