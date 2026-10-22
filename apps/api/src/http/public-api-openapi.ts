import { publicTaskCreateSchema, publicTaskListQuerySchema, publicTaskUpdateSchema, taskViewSchema, createApiTokenInputSchema } from '@workloom/contracts';
import { z } from 'zod';

const json = (schema: z.ZodType, io: 'input' | 'output' = 'output') => {
  const { $schema, ...rest } = z.toJSONSchema(schema, { io, unrepresentable: 'any' }) as Record<string, unknown>;
  void $schema;
  return rest;
};
const envelope = (data: unknown, list = false) => ({
  type: 'object', required: ['data', 'meta'],
  properties: { data, meta: { type: 'object', required: ['requestId'], properties: { requestId: { type: 'string' }, ...(list ? { nextCursor: { type: ['string', 'null'] } } : {}) } } },
});
const ok = (description: string, schema: unknown) => ({ description, content: { 'application/json': { schema } } });
const errors = {
  '401': { description: 'Missing, malformed, expired or revoked token.' },
  '403': { description: 'The token scope or your role in the workspace does not allow this.' },
  '404': { description: 'Unknown workspace or object, or no access to it.' },
  '400': { description: 'Invalid input or an unknown/ambiguous reference. See error.details.' },
  '409': { description: 'Revision conflict (ifRevision) or Idempotency-Key reuse.' },
};
const wsParam = { name: 'ws', in: 'path', required: true, description: 'Workspace slug or UUID.', schema: { type: 'string' } };
const taskParam = { name: 'taskId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } };
const idemHeader = { name: 'Idempotency-Key', in: 'header', required: false, description: 'Makes a retry safe: the same key with the same body returns the first result.', schema: { type: 'string', maxLength: 128 } };
const queryParams = Object.entries((json(publicTaskListQuerySchema, 'input').properties ?? {}) as Record<string, unknown>).map(([name, schema]) => ({ name, in: 'query', required: false, schema }));

export const PUBLIC_API_OPENAPI = {
  openapi: '3.1.0',
  info: { title: 'Workloom public API', version: '1', description: 'Create, read and update tasks with a personal access token. Permissions are those of the token owner; scopes can only narrow them. Names and UUIDs are accepted for projects, sections, statuses, tags and people.' },
  servers: [{ url: '/api/public/v1' }],
  security: [{ bearer: [] }],
  components: { securitySchemes: { bearer: { type: 'http', scheme: 'bearer', bearerFormat: 'wlm_pat_…' } }, schemas: { Task: json(taskViewSchema), TaskCreate: json(publicTaskCreateSchema, 'input'), TaskUpdate: json(publicTaskUpdateSchema, 'input'), TokenCreate: json(createApiTokenInputSchema, 'input') } },
  paths: {
    '/me': { get: { summary: 'Who am I, token scopes and reachable workspaces', responses: { '200': ok('OK', envelope({ type: 'object' })), '401': errors['401'] } } },
    '/workspaces': { get: { summary: 'Workspaces reachable with this token', responses: { '200': ok('OK', envelope({ type: 'array', items: { type: 'object' } }, true)), '401': errors['401'] } } },
    '/workspaces/{ws}/projects': { get: { summary: 'Active projects', parameters: [wsParam], responses: { '200': ok('OK', envelope({ type: 'array', items: { type: 'object' } }, true)), ...errors } } },
    '/workspaces/{ws}/projects/{project}': { get: { summary: 'One project with its sections and statuses', parameters: [wsParam, { name: 'project', in: 'path', required: true, description: 'Project UUID or exact name.', schema: { type: 'string' } }], responses: { '200': ok('OK', envelope({ type: 'object' })), ...errors } } },
    '/workspaces/{ws}/members': { get: { summary: 'Members you can assign', parameters: [wsParam], responses: { '200': ok('OK', envelope({ type: 'array', items: { type: 'object' } }, true)), ...errors } } },
    '/workspaces/{ws}/tags': { get: { summary: 'Tags', parameters: [wsParam], responses: { '200': ok('OK', envelope({ type: 'array', items: { type: 'object' } }, true)), ...errors } } },
    '/workspaces/{ws}/tasks': {
      get: { summary: 'List tasks. Repeat a parameter or comma-separate values; assignee=me means yours.', parameters: [wsParam, ...queryParams], responses: { '200': ok('OK', envelope({ type: 'array', items: { $ref: '#/components/schemas/Task' } }, true)), ...errors } },
      post: { summary: 'Create a task', parameters: [wsParam, idemHeader], requestBody: { required: true, content: { 'application/json': { schema: { $ref: '#/components/schemas/TaskCreate' } } } }, responses: { '201': ok('Created', envelope({ $ref: '#/components/schemas/Task' })), ...errors } },
    },
    '/workspaces/{ws}/tasks/{taskId}': {
      get: { summary: 'Get a task', parameters: [wsParam, taskParam], responses: { '200': ok('OK', envelope({ $ref: '#/components/schemas/Task' })), ...errors } },
      patch: { summary: 'Change a task: status, section, assignee, dates, tags, …', parameters: [wsParam, taskParam, idemHeader], requestBody: { required: true, content: { 'application/json': { schema: { $ref: '#/components/schemas/TaskUpdate' } } } }, responses: { '200': ok('OK', envelope({ $ref: '#/components/schemas/Task' })), ...errors } },
    },
  },
} as const;
