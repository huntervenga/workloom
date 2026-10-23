import { z } from 'zod';
import { idSchema } from './common/ids.js';
import { sqlCalendarDateSchema } from './common/sql-date.js';
import { minutesSchema, taskPrioritySchema, taskStatusGroupSchema, utcTimestampSchema } from './tasks.js';
import { workspaceRoleSchema } from './workspaces.js';

/**
 * Public API and remote MCP contracts. Every reference to a workspace, project, section, status,
 * tag or person accepts either its UUID or its exact (case-insensitive) name; the server resolves it
 * under the caller's current permissions. Tokens never carry more authority than their owner has.
 */
export const API_TOKEN_PREFIX = 'wlm_pat_';
export const API_TOKEN_PATTERN = /^wlm_pat_[A-Za-z0-9_-]{43}$/;
export const API_TOKEN_LIMITS = { tokensPerUser: 50, maxDays: 365, defaultDays: 90, pageSize: 200, bodyBytes: 256 * 1024 } as const;

export const apiTokenScopeSchema = z.enum(['read', 'tasks:write']);
export type ApiTokenScope = z.infer<typeof apiTokenScopeSchema>;
const tokenName = z.string().trim().min(1).max(100).refine(value => !/\p{Cc}/u.test(value), 'Use a plain-text name.');
const scopes = z.array(apiTokenScopeSchema).min(1).max(2).refine(list => new Set(list).size === list.length, 'Scopes must be unique.')
  .transform(list => [...list].sort());

export const createApiTokenInputSchema = z.strictObject({
  name: tokenName,
  scopes,
  /** Restricts the token to these workspaces; omitted means every workspace the user belongs to. */
  workspaceIds: z.array(idSchema).min(1).max(100).optional(),
  expiresInDays: z.number().int().min(1).max(API_TOKEN_LIMITS.maxDays).default(API_TOKEN_LIMITS.defaultDays),
});
export const apiTokenSchema = z.object({
  id: idSchema,
  name: tokenName,
  tokenPrefix: z.string().min(8).max(16),
  scopes,
  workspaceIds: z.array(idSchema).nullable(),
  createdAt: utcTimestampSchema,
  expiresAt: utcTimestampSchema,
  revokedAt: utcTimestampSchema.nullable(),
  lastUsedAt: utcTimestampSchema.nullable(),
});
/** Returned exactly once, on creation; the server keeps only a hash. */
export const createdApiTokenSchema = apiTokenSchema.extend({ token: z.string().regex(API_TOKEN_PATTERN) });
export type CreateApiTokenInput = z.input<typeof createApiTokenInputSchema>;
export type ApiTokenDto = z.infer<typeof apiTokenSchema>;
export type CreatedApiTokenDto = z.infer<typeof createdApiTokenSchema>;

const ref = z.string().trim().min(1).max(200);
const refList = (max: number) => z.array(ref).max(max);
const title = z.string().trim().min(1).max(500);
const description = z.string().max(20_000);
const date = sqlCalendarDateSchema;

export const publicTaskCreateSchema = z.strictObject({
  project: ref,
  title,
  description: description.optional(),
  section: ref.nullable().optional(),
  status: ref.optional(),
  assignee: ref.nullable().optional(),
  participants: refList(50).optional(),
  startDate: date.nullable().optional(),
  dueDate: date.nullable().optional(),
  priority: taskPrioritySchema.optional(),
  tags: refList(20).optional(),
  estimateMinutes: minutesSchema.nullable().optional(),
  parentTask: idSchema.nullable().optional(),
});
export const publicTaskUpdateSchema = z.strictObject({
  title: title.optional(),
  description: description.optional(),
  status: ref.optional(),
  section: ref.nullable().optional(),
  assignee: ref.nullable().optional(),
  participants: refList(50).optional(),
  startDate: date.nullable().optional(),
  dueDate: date.nullable().optional(),
  priority: taskPrioritySchema.optional(),
  tags: refList(20).optional(),
  estimateMinutes: minutesSchema.nullable().optional(),
  /** Optional optimistic-concurrency guard; without it the supplied fields are applied to the current task. */
  ifRevision: z.number().int().positive().optional(),
}).refine(input => Object.keys(input).some(key => key !== 'ifRevision' && (input as Record<string, unknown>)[key] !== undefined), 'Send at least one field to change.');
export type PublicTaskCreate = z.infer<typeof publicTaskCreateSchema>;
export type PublicTaskUpdate = z.infer<typeof publicTaskUpdateSchema>;

const csv = (max: number) => z.union([z.string(), z.array(z.string())]).transform(value => (Array.isArray(value) ? value : value.split(',')).map(item => item.trim()).filter(Boolean)).pipe(z.array(ref).max(max));
const bool = z.union([z.boolean(), z.enum(['true', 'false']).transform(value => value === 'true')]);
export const publicTaskListQuerySchema = z.strictObject({
  project: csv(20).optional(),
  section: csv(20).optional(),
  status: csv(20).optional(),
  statusGroup: csv(4).pipe(z.array(taskStatusGroupSchema)).optional(),
  assignee: csv(20).optional(),
  tag: csv(20).optional(),
  q: z.string().trim().min(1).max(200).optional(),
  dueBefore: date.optional(),
  dueAfter: date.optional(),
  open: bool.optional(),
  includeArchived: bool.optional(),
  sort: z.enum(['updated', 'due', 'created']).default('updated'),
  limit: z.coerce.number().int().min(1).max(API_TOKEN_LIMITS.pageSize).default(50),
  cursor: z.string().min(1).max(2048).optional(),
});
export type PublicTaskListQuery = z.infer<typeof publicTaskListQuerySchema>;

export const taskViewSchema = z.object({
  id: idSchema,
  workspaceId: idSchema,
  title: z.string(),
  description: z.string(),
  project: z.object({ id: idSchema, name: z.string() }),
  section: z.object({ id: idSchema, name: z.string() }).nullable(),
  status: z.object({ id: idSchema, name: z.string(), group: taskStatusGroupSchema }),
  assignee: z.object({ membershipId: idSchema, displayName: z.string() }).nullable(),
  participants: z.array(z.object({ membershipId: idSchema, displayName: z.string() })),
  priority: taskPrioritySchema,
  startDate: z.string().nullable(),
  dueDate: z.string().nullable(),
  estimateMinutes: z.number().int().nullable(),
  tags: z.array(z.object({ id: idSchema, name: z.string() })),
  parentTaskId: idSchema.nullable(),
  revision: z.number().int().positive(),
  archived: z.boolean(),
  createdAt: utcTimestampSchema,
  updatedAt: utcTimestampSchema,
});
export type TaskView = z.infer<typeof taskViewSchema>;

export const publicWorkspaceSchema = z.object({ id: idSchema, slug: z.string().nullable(), name: z.string(), role: workspaceRoleSchema, timezone: z.string() });
export type PublicWorkspaceDto = z.infer<typeof publicWorkspaceSchema>;
export const publicProjectSchema = z.object({ id: idSchema, name: z.string(), archived: z.boolean() });
export const publicProjectDetailSchema = publicProjectSchema.extend({
  sections: z.array(z.object({ id: idSchema, name: z.string() })),
  statuses: z.array(z.object({ id: idSchema, name: z.string(), group: taskStatusGroupSchema })),
});
export const publicMemberSchema = z.object({ membershipId: idSchema, displayName: z.string(), role: workspaceRoleSchema });
export const publicTagSchema = z.object({ id: idSchema, name: z.string() });
export const publicMeSchema = z.object({
  user: z.object({ id: idSchema, displayName: z.string() }),
  token: z.object({ id: idSchema, name: z.string(), scopes: z.array(apiTokenScopeSchema), expiresAt: utcTimestampSchema }),
  workspaces: z.array(publicWorkspaceSchema),
});
export type PublicProjectDto = z.infer<typeof publicProjectSchema>;
export type PublicProjectDetailDto = z.infer<typeof publicProjectDetailSchema>;
export type PublicMemberDto = z.infer<typeof publicMemberSchema>;
export type PublicTagDto = z.infer<typeof publicTagSchema>;
export type PublicMeDto = z.infer<typeof publicMeSchema>;

/** Shared by the remote MCP tools: `workspace` may be omitted when the user has exactly one workspace. */
const workspaceRef = ref.optional();
export const MCP_TOOL_NAMES = ['whoami', 'list_workspaces', 'list_projects', 'get_project', 'list_members', 'list_tags', 'list_tasks', 'get_task', 'create_task', 'update_task', 'set_task_status'] as const;
export type McpToolName = (typeof MCP_TOOL_NAMES)[number];
const operationKey = z.string().regex(/^[\x21-\x7e]{1,128}$/).optional();
export const MCP_TOOL_INPUTS = {
  whoami: z.strictObject({}),
  list_workspaces: z.strictObject({}),
  list_projects: z.strictObject({ workspace: workspaceRef }),
  get_project: z.strictObject({ workspace: workspaceRef, project: ref }),
  list_members: z.strictObject({ workspace: workspaceRef }),
  list_tags: z.strictObject({ workspace: workspaceRef }),
  list_tasks: z.strictObject({
    workspace: workspaceRef,
    project: z.array(ref).max(20).optional(), section: z.array(ref).max(20).optional(), status: z.array(ref).max(20).optional(),
    statusGroup: z.array(taskStatusGroupSchema).max(4).optional(),
    assignee: z.array(ref).max(20).optional().describe('Use "me" for the caller, "none" for unassigned, or a name/membership id.'),
    tag: z.array(ref).max(20).optional(), q: z.string().trim().min(1).max(200).optional(),
    dueBefore: date.optional(), dueAfter: date.optional(), open: z.boolean().optional(), includeArchived: z.boolean().optional(),
    sort: z.enum(['updated', 'due', 'created']).optional(), limit: z.number().int().min(1).max(50).optional(), cursor: z.string().max(2048).optional(),
  }),
  get_task: z.strictObject({ workspace: workspaceRef, taskId: idSchema }),
  create_task: publicTaskCreateSchema.extend({ workspace: workspaceRef, operationKey }),
  update_task: z.strictObject({ workspace: workspaceRef, taskId: idSchema, changes: publicTaskUpdateSchema, operationKey }),
  set_task_status: z.strictObject({ workspace: workspaceRef, taskId: idSchema, status: ref, operationKey }),
} as const;
export const MCP_TOOL_SCOPE: Readonly<Record<McpToolName, ApiTokenScope>> = {
  whoami: 'read', list_workspaces: 'read', list_projects: 'read', get_project: 'read', list_members: 'read', list_tags: 'read',
  list_tasks: 'read', get_task: 'read', create_task: 'tasks:write', update_task: 'tasks:write', set_task_status: 'tasks:write',
};
