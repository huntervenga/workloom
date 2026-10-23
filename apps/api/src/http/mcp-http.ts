import {
  MCP_TOOL_INPUTS, MCP_TOOL_NAMES, MCP_TOOL_SCOPE, type McpToolName, type PublicTaskListQuery,
} from '@workloom/contracts';
import type { AutomationApplication } from '@workloom/db';
import { isDomainError } from '@workloom/domain';
import { createMcpHandler, McpServer } from '@modelcontextprotocol/server';
import type { CallToolResult } from '@modelcontextprotocol/server';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { z } from 'zod';
import { mapError } from './errors.js';
import { bearerToken } from './public-api-routes.js';

export const MCP_PATH = '/mcp';

const DESCRIPTIONS: Readonly<Record<McpToolName, string>> = {
  whoami: 'Show the Workloom user, the token scopes and the workspaces this token can reach.',
  list_workspaces: 'List workspaces (id, slug, name, your role).',
  list_projects: 'List active projects of a workspace. Omit workspace if the token reaches only one.',
  get_project: 'Show a project with its sections and statuses. project is a UUID or exact name.',
  list_members: 'List members that tasks can be assigned to.',
  list_tags: 'List tags.',
  list_tasks: 'List tasks, newest first. Filters combine with AND. Use assignee ["me"] for the caller\'s own tasks; names or UUIDs work for project, section, status, tag and assignee. Use nextCursor from the result as cursor for the next page.',
  get_task: 'Read one task by id.',
  create_task: 'Create a task in a project. Only project and title are required; section, status, assignee, dates, tags and priority accept names or UUIDs. Pass the same operationKey when retrying after an unknown outcome.',
  update_task: 'Change fields of a task (status, section, assignee, dates, priority, tags, title, description). Only the given fields change; null clears section, assignee and dates.',
  set_task_status: 'Move a task to another status by name or UUID, for example "In progress" or "Done".',
};
const READ_ONLY: ReadonlySet<McpToolName> = new Set(MCP_TOOL_NAMES.filter(name => MCP_TOOL_SCOPE[name] === 'read'));

type Args<T extends McpToolName> = z.infer<(typeof MCP_TOOL_INPUTS)[T]>;

async function run(automation: AutomationApplication, token: string, name: McpToolName, input: Record<string, unknown>, requestId: string): Promise<unknown> {
  const a = input as Args<McpToolName> & Record<string, unknown>;
  const workspace = (a as { workspace?: string }).workspace;
  const key = (a as { operationKey?: string }).operationKey;
  switch (name) {
    case 'whoami': return automation.me(token);
    case 'list_workspaces': return automation.listWorkspaces(token);
    case 'list_projects': return automation.listProjects(token, workspace);
    case 'get_project': return automation.getProject(token, workspace, (a as Args<'get_project'>).project);
    case 'list_members': return automation.listMembers(token, workspace);
    case 'list_tags': return automation.listTags(token, workspace);
    case 'list_tasks': {
      const { workspace: _w, ...filters } = a as Args<'list_tasks'>;
      void _w;
      const page = await automation.listTasks(token, workspace, { sort: 'updated', limit: 50, ...filters } as PublicTaskListQuery);
      return { tasks: page.items, nextCursor: page.nextCursor };
    }
    case 'get_task': return automation.getTask(token, workspace, (a as Args<'get_task'>).taskId);
    case 'create_task': {
      const { workspace: _w, operationKey: _k, ...task } = a as Args<'create_task'>;
      void _w; void _k;
      return automation.createTask(token, workspace, task, { requestId, idempotencyKey: key });
    }
    case 'update_task': {
      const { taskId, changes } = a as Args<'update_task'>;
      return automation.updateTask(token, workspace, taskId, changes, { requestId, idempotencyKey: key });
    }
    case 'set_task_status': {
      const { taskId, status } = a as Args<'set_task_status'>;
      return automation.updateTask(token, workspace, taskId, { status }, { requestId, idempotencyKey: key });
    }
  }
}

export const MCP_MAX_BATCH = 10;

/** A fresh server per HTTP request, exposing only the tools this token's scopes allow. */
function createServer(automation: AutomationApplication, token: string, scopes: readonly string[], requestId: string): McpServer {
  const server = new McpServer({ name: 'workloom', version: '1.0.0' }, { capabilities: { tools: { listChanged: false } } });
  for (const name of MCP_TOOL_NAMES) {
    if (!scopes.includes(MCP_TOOL_SCOPE[name])) continue;
    const readOnly = READ_ONLY.has(name);
    server.registerTool(name, {
      description: DESCRIPTIONS[name],
      inputSchema: MCP_TOOL_INPUTS[name] as z.ZodObject<z.ZodRawShape>,
      annotations: { readOnlyHint: readOnly, destructiveHint: false, idempotentHint: readOnly || name === 'set_task_status', openWorldHint: false },
    }, async (input: Record<string, unknown>): Promise<CallToolResult> => {
      try {
        const result = await run(automation, token, name, input, requestId);
        return { structuredContent: { result }, content: [{ type: 'text', text: JSON.stringify(result) }] };
      } catch (error) {
        const mapped = mapError(error);
        // Domain and validation errors are the model's to read and fix; anything unexpected stays generic.
        const failure = isDomainError(error) || !mapped.unexpected ? mapped.body.error : { code: 'INTERNAL', message: 'The request failed.', retryable: false };
        return { isError: true, structuredContent: { error: failure }, content: [{ type: 'text', text: JSON.stringify({ error: failure }) }] };
      }
    });
  }
  return server;
}

function toWebRequest(request: FastifyRequest): Request {
  const headers = new Headers();
  for (const [key, value] of Object.entries(request.headers)) if (typeof value === 'string') headers.set(key, value);
  const url = `http://${request.headers.host ?? 'localhost'}${request.url}`;
  const hasBody = request.method !== 'GET' && request.method !== 'HEAD';
  return new Request(url, { method: request.method, headers, ...(hasBody ? { body: JSON.stringify(request.body ?? null) } : {}) });
}

async function sendWebResponse(reply: FastifyReply, response: Response): Promise<FastifyReply> {
  response.headers.forEach((value, key) => { if (key !== 'content-length' && key !== 'transfer-encoding') reply.header(key, value); });
  // The SDK supplies no-cache for SSE, which still permits sensitive responses to be stored.
  // Apply the stricter policy after copying its headers; retain no-transform for event framing.
  reply.header('cache-control', 'no-store, no-transform');
  reply.code(response.status);
  return reply.send(Buffer.from(await response.arrayBuffer()));
}

/**
 * Streamable-HTTP MCP at /mcp. Stateless: every request carries `Authorization: Bearer wlm_pat_…` and is
 * authorized again, so revoking a token or lowering a role takes effect on the next call.
 */
export function registerMcpHttp(app: FastifyInstance, deps: { automation: AutomationApplication }): void {
  app.route({
    method: ['GET', 'DELETE'], url: MCP_PATH,
    handler: async (_request, reply) => reply.code(405).header('allow', 'POST').type('application/json').send({ jsonrpc: '2.0', error: { code: -32000, message: 'Use POST with a JSON-RPC message.' }, id: null }),
  });
  app.post(MCP_PATH, { bodyLimit: 1024 * 1024 }, async (request, reply) => {
    let token: string, scopes: readonly string[];
    try {
      token = bearerToken(request);
      scopes = (await deps.automation.describeToken(token)).scopes;
    } catch (error) {
      const mapped = mapError(error);
      return reply.code(mapped.statusCode).header('www-authenticate', 'Bearer realm="workloom", error="invalid_token"').type('application/json')
        .send({ jsonrpc: '2.0', error: { code: -32001, message: mapped.body.error.message }, id: null });
    }
    // One request may not fan out into an unbounded number of tool calls.
    if (Array.isArray(request.body) && request.body.length > MCP_MAX_BATCH) {
      return reply.code(400).type('application/json').send({ jsonrpc: '2.0', error: { code: -32600, message: `At most ${MCP_MAX_BATCH} messages per request.` }, id: null });
    }
    const handler = createMcpHandler(() => createServer(deps.automation, token, scopes, request.id), { responseMode: 'json' });
    const response = await handler.fetch(toWebRequest(request), { parsedBody: request.body });
    return sendWebResponse(reply, response);
  });
}
