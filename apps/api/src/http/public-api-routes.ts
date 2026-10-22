import {
  envelopeSchema, idSchema, publicMeSchema, publicMemberSchema, publicProjectDetailSchema, publicProjectSchema, publicTagSchema,
  publicTaskCreateSchema, publicTaskListQuerySchema, publicTaskUpdateSchema, publicWorkspaceSchema, taskViewSchema, API_TOKEN_LIMITS,
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
const IDEMPOTENCY = /^[\x21-\x7e]{1,128}$/;

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
    parseInput(empty, request.query);
    const p = parseInput(wsTask, request.params);
    return sendData(request, reply, envelopeSchema(taskViewSchema), await automation.getTask(bearerToken(request), p.ws, p.taskId));
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
}
