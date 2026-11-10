import { z } from 'zod';
import { idSchema } from './common/ids.js';
import { sqlCalendarDateSchema } from './common/sql-date.js';
import { taskFieldTypeSchema } from './fields.js';
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

/** Connected apps (OAuth) get short-lived access tokens and rotating refresh tokens of their own shape. */
export const OAUTH_ACCESS_TOKEN_PREFIX = 'wlm_oat_';
export const OAUTH_REFRESH_TOKEN_PREFIX = 'wlm_ort_';
export const OAUTH_ACCESS_TOKEN_PATTERN = /^wlm_oat_[A-Za-z0-9_-]{43}$/;
export const OAUTH_REFRESH_TOKEN_PATTERN = /^wlm_ort_[A-Za-z0-9_-]{43}$/;
/** A bearer credential accepted by the public API and MCP: a personal access token or a connected-app access token. */
export const isBearerCredential = (value: string): boolean => API_TOKEN_PATTERN.test(value) || OAUTH_ACCESS_TOKEN_PATTERN.test(value);

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

/**
 * Adds an existing task to another project, for example a task from a backlog to the week project.
 * The task keeps its home project, hours and field values; the target project only shows it too.
 * A task already in the project is left as it is, and a placement removed earlier is restored.
 */
export const publicTaskAddToProjectSchema = z.strictObject({
  project: ref,
  /** Section in the target project; used only when the task is added or restored. */
  section: ref.nullable().optional(),
});
export type PublicTaskAddToProject = z.infer<typeof publicTaskAddToProjectSchema>;
export const publicTaskProjectSchema = z.object({
  taskId: idSchema,
  project: z.object({ id: idSchema, name: z.string() }),
  section: z.object({ id: idSchema, name: z.string() }).nullable(),
  /** The project is the task's home project, where its hours and fields belong. */
  home: z.boolean(),
  outcome: z.enum(['added', 'restored', 'unchanged']),
});
export type PublicTaskProjectDto = z.infer<typeof publicTaskProjectSchema>;

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
  /** Adds the custom field values of each task's home project (for example Estimation and Fact). */
  includeFields: bool.optional(),
});
export type PublicTaskListQuery = z.infer<typeof publicTaskListQuerySchema>;

/** A custom field as automation sees it: options by name, so callers never need option ids. */
export const publicFieldSchema = z.object({
  id: idSchema,
  name: z.string(),
  type: taskFieldTypeSchema,
  locked: z.boolean(),
  options: z.array(z.object({ id: idSchema, name: z.string() })),
});
export type PublicFieldDto = z.infer<typeof publicFieldSchema>;

/**
 * A field value in a friendly form: duration in minutes (plus `hours`), select values and people
 * by name. `value: null` is an explicit clear; a field that was never filled is `set: false`.
 */
export const publicFieldValueSchema = z.object({
  fieldId: idSchema,
  name: z.string(),
  type: taskFieldTypeSchema,
  set: z.boolean(),
  value: z.union([z.string(), z.number(), z.boolean(), z.array(z.string()), z.null()]),
  hours: z.number().nullable().optional(),
});
export type PublicFieldValueDto = z.infer<typeof publicFieldValueSchema>;

/**
 * Durations accept minutes as a number, or text such as `90m`, `1.5h`, `1h 30m` or `1:30`.
 * Select options and people are names (or ids); a multi-select takes a list; `null` clears.
 */
export const publicFieldValueInputSchema = z.union([z.string().max(10_000), z.number(), z.boolean(), z.array(z.string().max(200)).max(100), z.null()]);
export type PublicFieldValueInput = z.infer<typeof publicFieldValueInputSchema>;

const MAX_DURATION_MINUTES = 2_147_483_647;
/** Parses the friendly duration forms into whole minutes; `null` when the text is not a duration. */
export function parseDurationMinutes(input: number | string): number | null {
  if (typeof input === 'number') return Number.isInteger(input) && input >= 0 && input <= MAX_DURATION_MINUTES ? input : null;
  const text = input.trim().toLowerCase().replace(/,/g, '.');
  if (text === '') return null;
  let minutes: number;
  const clock = /^(\d{1,6}):([0-5]\d)$/.exec(text);
  if (clock) minutes = Number(clock[1]) * 60 + Number(clock[2]);
  else if (/^\d+$/.test(text)) minutes = Number(text);
  else {
    const units = /^(?:(\d+(?:\.\d+)?)\s*(?:h|hr|hrs|hour|hours|ч|час|часа|часов))?\s*(?:(\d+(?:\.\d+)?)\s*(?:m|min|mins|minute|minutes|м|мин|минут|минуты))?$/.exec(text);
    if (!units || (units[1] === undefined && units[2] === undefined)) return null;
    minutes = Number(units[1] ?? 0) * 60 + Number(units[2] ?? 0);
  }
  if (!Number.isFinite(minutes) || minutes < 0 || minutes > MAX_DURATION_MINUTES) return null;
  const rounded = Math.round(minutes);
  return Math.abs(rounded - minutes) < 1e-9 ? rounded : null;
}

const fieldChange = z.strictObject({ field: ref, value: publicFieldValueInputSchema });
export const publicSetTaskFieldsSchema = z.strictObject({
  items: z.array(z.strictObject({
    taskId: idSchema,
    /** Whose fields to write; defaults to the task's home project. Use it for a task shown in another project. */
    project: ref.optional(),
    values: z.array(fieldChange).min(1).max(20),
  })).min(1).max(100),
  /** Resolve and report every change without writing anything. */
  dryRun: z.boolean().optional(),
}).superRefine((input, ctx) => {
  const seen = new Set<string>();
  for (const [index, item] of input.items.entries()) {
    const key = `${item.taskId}\0${(item.project ?? '').toLowerCase()}`;
    if (seen.has(key)) ctx.addIssue({ code: 'custom', path: ['items', index, 'taskId'], message: 'List each task (and project) once.' });
    seen.add(key);
    const fields = item.values.map(change => change.field.toLowerCase());
    if (new Set(fields).size !== fields.length) ctx.addIssue({ code: 'custom', path: ['items', index, 'values'], message: 'Set each field once per task.' });
  }
});
export type PublicSetTaskFields = z.infer<typeof publicSetTaskFieldsSchema>;

export const publicFieldChangeResultSchema = z.object({
  field: z.string(),
  fieldId: idSchema.nullable(),
  type: taskFieldTypeSchema.nullable(),
  before: publicFieldValueSchema.shape.value.nullable(),
  after: publicFieldValueSchema.shape.value.nullable(),
  /** `changed` was written (or would be, in a dry run); `failed` carries the reason and wrote nothing. */
  status: z.enum(['changed', 'unchanged', 'failed']),
  error: z.object({ code: z.string(), message: z.string() }).optional(),
});
export const publicSetTaskFieldsResultSchema = z.object({
  dryRun: z.boolean(),
  items: z.array(z.object({
    taskId: idSchema,
    title: z.string().nullable(),
    project: z.object({ id: idSchema, name: z.string() }).nullable(),
    changes: z.array(publicFieldChangeResultSchema),
  })),
  summary: z.object({ changed: z.number().int(), unchanged: z.number().int(), failed: z.number().int() }),
});
export type PublicSetTaskFieldsResult = z.infer<typeof publicSetTaskFieldsResultSchema>;

export const publicTimeSummaryQuerySchema = z.strictObject({
  project: ref,
  /** Inclusive range for the expected hours; defaults to the project's date range. */
  from: date.optional(),
  to: date.optional(),
  /** People to report; defaults to everyone who has a task in the project, plus the caller. */
  people: csv(100).optional(),
  planField: ref.default('Estimation'),
  factField: ref.default('Fact'),
  includeTasks: bool.default(true),
}).refine(input => (input.from === undefined) === (input.to === undefined), 'Pass both from and to, or neither.')
  .refine(input => input.from === undefined || input.to === undefined || input.from <= input.to, 'from must not be after to.');
export type PublicTimeSummaryQuery = z.infer<typeof publicTimeSummaryQuerySchema>;

const minutesOrNull = z.number().int().nullable();
export const publicTimeSummaryTaskSchema = z.object({
  taskId: idSchema, title: z.string(), status: z.string(), statusGroup: taskStatusGroupSchema,
  parentTaskId: idSchema.nullable(), planMinutes: minutesOrNull, factMinutes: minutesOrNull,
});
export const publicTimeSummaryPersonSchema = z.object({
  membershipId: idSchema,
  displayName: z.string(),
  /** False when the person has no work schedule; then the expected values are null. */
  scheduleKnown: z.boolean(),
  scheduledMinutes: minutesOrNull,
  holidayMinutes: minutesOrNull,
  absenceMinutes: minutesOrNull,
  /** Working time minus holidays and time off in the range: the hours this person is expected to report. */
  expectedMinutes: minutesOrNull,
  planMinutes: z.number().int(),
  factMinutes: z.number().int(),
  /** expected − fact; positive means fact still has to grow to reach the norm. */
  factGapMinutes: minutesOrNull,
  tasks: z.array(publicTimeSummaryTaskSchema).optional(),
});
export const publicTimeSummarySchema = z.object({
  project: z.object({ id: idSchema, name: z.string() }),
  from: z.string(), to: z.string(), rangeSource: z.enum(['project', 'input']),
  planField: z.object({ id: idSchema, name: z.string() }),
  factField: z.object({ id: idSchema, name: z.string() }),
  people: z.array(publicTimeSummaryPersonSchema),
  unassigned: z.object({ planMinutes: z.number().int(), factMinutes: z.number().int(), tasks: z.array(publicTimeSummaryTaskSchema).optional() }),
  totals: z.object({ expectedMinutes: z.number().int(), planMinutes: z.number().int(), factMinutes: z.number().int() }),
  notes: z.array(z.string()),
});
export type PublicTimeSummaryDto = z.infer<typeof publicTimeSummarySchema>;

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
  /** Present only when fields were requested: values of the task's home project fields. */
  fields: z.array(publicFieldValueSchema).optional(),
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
export const MCP_TOOL_NAMES = ['whoami', 'list_workspaces', 'list_projects', 'get_project', 'list_members', 'list_tags', 'list_tasks', 'get_task', 'create_task', 'update_task', 'set_task_status', 'add_task_to_project', 'list_fields', 'set_task_fields', 'time_summary'] as const;
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
    includeFields: z.boolean().optional().describe('Add custom field values such as Estimation and Fact to every task.'),
  }),
  get_task: z.strictObject({ workspace: workspaceRef, taskId: idSchema }),
  list_fields: z.strictObject({ workspace: workspaceRef, project: ref }),
  set_task_fields: z.strictObject({
    workspace: workspaceRef,
    items: publicSetTaskFieldsSchema.shape.items,
    dryRun: z.boolean().optional().describe('Report what would change without writing. Use it to show the user a plan first.'),
    operationKey,
  }),
  time_summary: z.strictObject({
    workspace: workspaceRef,
    project: ref.describe('Project name or UUID, usually the week project.'),
    from: date.optional(), to: date.optional(),
    people: z.array(ref).max(100).optional().describe('Names, membership ids or "me". Default: everyone with a task in the project plus you.'),
    planField: ref.optional().describe('Plan field name; default "Estimation".'),
    factField: ref.optional().describe('Fact field name; default "Fact".'),
    includeTasks: z.boolean().optional(),
  }),
  create_task: publicTaskCreateSchema.extend({ workspace: workspaceRef, operationKey }),
  update_task: z.strictObject({ workspace: workspaceRef, taskId: idSchema, changes: publicTaskUpdateSchema, operationKey }),
  set_task_status: z.strictObject({ workspace: workspaceRef, taskId: idSchema, status: ref, operationKey }),
  add_task_to_project: z.strictObject({
    workspace: workspaceRef, taskId: idSchema,
    project: ref.describe('Project name or UUID to add the task to, usually the week project.'),
    section: ref.nullable().optional().describe('Section name or UUID in that project, for example the person\'s section.'),
    operationKey,
  }),
} as const;
export const MCP_TOOL_SCOPE: Readonly<Record<McpToolName, ApiTokenScope>> = {
  whoami: 'read', list_workspaces: 'read', list_projects: 'read', get_project: 'read', list_members: 'read', list_tags: 'read',
  list_tasks: 'read', get_task: 'read', create_task: 'tasks:write', update_task: 'tasks:write', set_task_status: 'tasks:write', add_task_to_project: 'tasks:write',
  list_fields: 'read', set_task_fields: 'tasks:write', time_summary: 'read',
};

/** What the consent page shows about a pending connected-app authorization. */
export const oauthConsentSchema = z.object({
  client: z.object({ id: z.string(), name: z.string(), redirectUri: z.string(), redirectHost: z.string() }),
  scopes: z.array(apiTokenScopeSchema),
  user: z.object({ displayName: z.string() }),
});
export type OAuthConsentDto = z.infer<typeof oauthConsentSchema>;
export const oauthDecisionInputSchema = z.strictObject({
  /** The original authorization query string, without the leading "?". */
  request: z.string().min(1).max(4096),
  decision: z.enum(['approve', 'deny']),
});
export type OAuthDecisionInput = z.infer<typeof oauthDecisionInputSchema>;
export const oauthDecisionSchema = z.object({ redirectTo: z.string() });
export type OAuthDecisionDto = z.infer<typeof oauthDecisionSchema>;
