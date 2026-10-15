import { z } from 'zod';

import { envelopeSchema } from './common/envelope.js';
import { idSchema } from './common/ids.js';

/**
 * P1a projects, sections, statuses, tags and tasks.
 *
 * HTTP catalog, every path under `/api/v1/workspaces/:workspaceId`:
 * - `GET /projects` → `projectListResponseSchema`
 * - `POST /projects` (`createProjectInputSchema`) → `projectResponseSchema`
 * - `GET /projects/:projectId` → `projectResponseSchema`
 * - `PATCH /projects/:projectId` (`updateProjectInputSchema`) → `projectResponseSchema`
 * - `GET /projects/:projectId/sections` → `sectionListResponseSchema`
 * - `POST /projects/:projectId/sections` (`createSectionInputSchema`) → `sectionResponseSchema`
 * - `PATCH /sections/:sectionId` (`updateSectionInputSchema`) → `sectionResponseSchema`
 * - `GET /projects/:projectId/statuses` → `taskStatusListResponseSchema`
 * - `GET /tags` → `tagListResponseSchema`
 * - `POST /tags` (`createTagInputSchema`) → `tagResponseSchema`
 * - `PATCH /tags/:tagId` (`updateTagInputSchema`) → `tagResponseSchema`
 * - `GET /tasks` (`taskListQuerySchema`) → `taskListResponseSchema`
 * - `POST /tasks` (`createTaskInputSchema`) → `taskResponseSchema`
 * - `GET /tasks/:taskId` → `taskResponseSchema`
 * - `PATCH /tasks/:taskId` (`updateTaskInputSchema`) → `taskResponseSchema`
 * - `POST /tasks/:taskId/archive` (`archiveTaskInputSchema`) → `taskResponseSchema`
 * - `POST /tasks/:taskId/restore` (`restoreTaskInputSchema`) → `taskResponseSchema`
 *
 * Every mutation requires an `Idempotency-Key` header. The actor is resolved by the server and
 * never read from a body; the workspace comes from the path. Write bodies are strict: unknown
 * fields such as `actor`, `capabilities` or `actualMinutes` are rejected.
 *
 * These schemas check shape only. Domain commands must still enforce, inside the P0 command
 * runner with audit and outbox written in the same transaction:
 * - parent task, section, status and tags belong to the same workspace, and parent, section and
 *   status to the same project; assigned tags are not archived;
 * - participants and the responsible person are active memberships;
 * - a parent change cannot create a cycle (checked under the workspace barrier).
 *
 * Not implemented in P1a and not implied here: private ACLs, actual time, history UI, custom
 * fields, bulk edits and saved views. Task visibility is `workspace` only.
 */

const MAX_INT32 = 2_147_483_647;

/** Optimistic-concurrency revision, starting at 1. */
export const revisionSchema = z.number().int().min(1);

/** Ordering key within its list. */
export const positionSchema = z.number().int().min(0).max(MAX_INT32);

/** Whole minutes. `null` (not estimated) and `0` (estimated as zero) are different values. */
export const minutesSchema = z.number().int().min(0).max(MAX_INT32);

/** `YYYY-MM-DD` with real month lengths: `2026-02-30` is rejected. */
export const calendarDateSchema = z.iso.date();

/** ISO 8601 UTC timestamp ending in `Z`; offsets are rejected. */
export const utcTimestampSchema = z.iso.datetime();

/** P1a bootstrap priority. P1b migrates it to a typed select field, keeping history. */
export const taskPrioritySchema = z.enum(['none', 'low', 'medium', 'high', 'urgent']);

export const taskStatusGroupSchema = z.enum(['todo', 'in_progress', 'done', 'cancelled']);

/**
 * How a new subtask relates to work packages. `detail` (the default) breaks down the parent's
 * existing package; `added_scope` is new work with its own package and estimate. Root tasks
 * always get a new package, whatever the scope.
 */
export const taskWorkScopeSchema = z.enum(['detail', 'added_scope']);

const nameSchema = z.string().trim().min(1).max(160);
const titleSchema = z.string().trim().min(1).max(500);
const descriptionSchema = z.string().max(20_000);
const tagNameSchema = z.string().trim().min(1).max(80);
const tagColorSchema = z.string().regex(/^#[0-9a-f]{6}$/i, { error: 'Expected a #rrggbb color.' });

function hasUniqueIds(ids: readonly string[]): boolean {
  return new Set(ids.map((id) => id.toLowerCase())).size === ids.length;
}

const membershipIdListSchema = z
  .array(idSchema)
  .max(100)
  .refine(hasUniqueIds, { error: 'Membership IDs must be unique.' });

const tagIdListSchema = z
  .array(idSchema)
  .max(50)
  .refine(hasUniqueIds, { error: 'Tag IDs must be unique.' });

function hasAnyField<T extends object>(value: T, keys: readonly (keyof T)[]): boolean {
  return keys.some((key) => value[key] !== undefined);
}

function isSet<T>(value: T | null | undefined): value is T {
  return value !== undefined && value !== null;
}

const noChangeError = { error: 'Provide at least one field to change.' } as const;

export const projectSchema = z.object({
  id: idSchema,
  workspaceId: idSchema,
  name: nameSchema,
  revision: revisionSchema,
  archivedAt: utcTimestampSchema.nullable(),
  createdAt: utcTimestampSchema,
  updatedAt: utcTimestampSchema,
});

export const sectionSchema = z.object({
  id: idSchema,
  workspaceId: idSchema,
  projectId: idSchema,
  name: nameSchema,
  position: positionSchema,
  revision: revisionSchema,
  archivedAt: utcTimestampSchema.nullable(),
});

export const taskStatusSchema = z.object({
  id: idSchema,
  workspaceId: idSchema,
  projectId: idSchema,
  name: nameSchema,
  group: taskStatusGroupSchema,
  position: positionSchema,
  revision: revisionSchema,
});

/**
 * Workspace tag. Tasks reference tags by `id`, never by name: renaming keeps the ID, and
 * archived tags stay on tasks and in history but cannot be newly assigned.
 */
export const tagSchema = z.object({
  id: idSchema,
  workspaceId: idSchema,
  name: tagNameSchema,
  color: tagColorSchema.nullable(),
  revision: revisionSchema,
  archivedAt: utcTimestampSchema.nullable(),
});

/**
 * A participant row. Its `revision` is the row's own; removed participants are kept with
 * `active: false` rather than deleted.
 */
export const taskParticipantSchema = z.object({
  membershipId: idSchema,
  role: z.literal('assignee'),
  active: z.boolean(),
  revision: revisionSchema,
});

export const taskSchema = z.object({
  id: idSchema,
  workspaceId: idSchema,
  projectId: idSchema,
  sectionId: idSchema.nullable(),
  parentTaskId: idSchema.nullable(),
  /** Work package whose estimate this task shows. Detail subtasks share their parent's package. */
  workPackageId: idSchema,
  workPackageRevision: revisionSchema,
  title: titleSchema,
  description: descriptionSchema,
  statusId: idSchema,
  responsibleMembershipId: idSchema.nullable(),
  /** Includes inactive (removed) rows. */
  participants: z.array(taskParticipantSchema),
  /** Revision of the participant set, independent of the task `revision`. */
  participantsRevision: revisionSchema,
  dueDate: calendarDateSchema.nullable(),
  priority: taskPrioritySchema,
  tags: z.array(tagSchema),
  /**
   * Current estimate of the shared work package: the whole team's budget, shown in the UI as
   * «Оценка задачи». Totals must count each `workPackageId` once. Not a baseline and not a
   * personal allocation (allocations arrive in P2).
   */
  estimateMinutes: minutesSchema.nullable(),
  revision: revisionSchema,
  position: positionSchema,
  visibility: z.literal('workspace'),
  archivedAt: utcTimestampSchema.nullable(),
  createdAt: utcTimestampSchema,
  updatedAt: utcTimestampSchema,
});

export const createProjectInputSchema = z.strictObject({
  name: nameSchema,
});

export const updateProjectInputSchema = z
  .strictObject({
    expectedRevision: revisionSchema,
    name: nameSchema.optional(),
    archived: z.boolean().optional(),
  })
  .refine((input) => hasAnyField(input, ['name', 'archived']), noChangeError);

export const createSectionInputSchema = z.strictObject({
  name: nameSchema,
  position: positionSchema.optional(),
});

export const updateSectionInputSchema = z
  .strictObject({
    expectedRevision: revisionSchema,
    name: nameSchema.optional(),
    position: positionSchema.optional(),
    archived: z.boolean().optional(),
  })
  .refine((input) => hasAnyField(input, ['name', 'position', 'archived']), noChangeError);

export const createTagInputSchema = z.strictObject({
  name: tagNameSchema,
  color: tagColorSchema.nullable().optional(),
});

export const updateTagInputSchema = z
  .strictObject({
    expectedRevision: revisionSchema,
    name: tagNameSchema.optional(),
    color: tagColorSchema.nullable().optional(),
    archived: z.boolean().optional(),
  })
  .refine((input) => hasAnyField(input, ['name', 'color', 'archived']), noChangeError);

/**
 * A subtask (`parentTaskId` set) with the default `detail` scope joins the parent's work package,
 * so it cannot bring its own estimate: copying the parent budget would double-count it.
 * `added_scope` subtasks create a new package and may set one.
 */
export const createTaskInputSchema = z
  .strictObject({
    projectId: idSchema,
    sectionId: idSchema.nullable().optional(),
    parentTaskId: idSchema.nullable().optional(),
    title: titleSchema,
    description: descriptionSchema.optional(),
    statusId: idSchema,
    responsibleMembershipId: idSchema.nullable().optional(),
    participantMembershipIds: membershipIdListSchema.optional(),
    dueDate: calendarDateSchema.nullable().optional(),
    priority: taskPrioritySchema.optional(),
    tagIds: tagIdListSchema.optional(),
    estimateMinutes: minutesSchema.nullable().optional(),
    position: positionSchema.optional(),
    workScope: taskWorkScopeSchema.optional(),
  })
  .superRefine((input, ctx) => {
    const scope = input.workScope ?? 'detail';
    if (isSet(input.parentTaskId) && scope === 'detail' && isSet(input.estimateMinutes)) {
      ctx.addIssue({
        code: 'custom',
        path: ['estimateMinutes'],
        message: 'A detail subtask uses its parent work package estimate; use workScope "added_scope" for new work.',
      });
    }
  });

const taskMutationKeys = [
  'title',
  'description',
  'statusId',
  'sectionId',
  'parentTaskId',
  'responsibleMembershipId',
  'participantMembershipIds',
  'dueDate',
  'priority',
  'tagIds',
  'estimateMinutes',
  'position',
] as const;

function revisionGuardIssues(
  field: string,
  fieldSent: boolean,
  guard: string,
  guardSent: boolean,
): { path: string[]; message: string }[] {
  if (fieldSent && !guardSent) return [{ path: [guard], message: `${guard} is required when ${field} is sent.` }];
  if (guardSent && !fieldSent) return [{ path: [guard], message: `${guard} is only allowed together with ${field}.` }];
  return [];
}

/**
 * Partial task update. Changing `estimateMinutes` (including to `null`) edits the shared work
 * package and requires `expectedWorkPackageRevision`; replacing `participantMembershipIds` requires
 * `expectedParticipantsRevision`. A guard without its field is rejected.
 *
 * Reparenting a subtask keeps its own work package, even under a parent with a different
 * package; the new parent must be in the same project.
 */
export const updateTaskInputSchema = z
  .strictObject({
    expectedRevision: revisionSchema,
    title: titleSchema.optional(),
    description: descriptionSchema.optional(),
    statusId: idSchema.optional(),
    sectionId: idSchema.nullable().optional(),
    parentTaskId: idSchema.nullable().optional(),
    responsibleMembershipId: idSchema.nullable().optional(),
    participantMembershipIds: membershipIdListSchema.optional(),
    expectedParticipantsRevision: revisionSchema.optional(),
    dueDate: calendarDateSchema.nullable().optional(),
    priority: taskPrioritySchema.optional(),
    tagIds: tagIdListSchema.optional(),
    estimateMinutes: minutesSchema.nullable().optional(),
    expectedWorkPackageRevision: revisionSchema.optional(),
    position: positionSchema.optional(),
  })
  .superRefine((input, ctx) => {
    if (!hasAnyField(input, taskMutationKeys)) {
      ctx.addIssue({ code: 'custom', path: [], message: noChangeError.error });
    }
    const issues = [
      ...revisionGuardIssues(
        'estimateMinutes',
        input.estimateMinutes !== undefined,
        'expectedWorkPackageRevision',
        input.expectedWorkPackageRevision !== undefined,
      ),
      ...revisionGuardIssues(
        'participantMembershipIds',
        input.participantMembershipIds !== undefined,
        'expectedParticipantsRevision',
        input.expectedParticipantsRevision !== undefined,
      ),
    ];
    for (const issue of issues) ctx.addIssue({ code: 'custom', ...issue });
  });

export const archiveTaskInputSchema = z.strictObject({
  expectedRevision: revisionSchema,
});

export const restoreTaskInputSchema = z.strictObject({
  expectedRevision: revisionSchema,
});

/** Query strings carry booleans as text; only `true`/`false` are accepted (never truthy coercion). */
const queryBooleanSchema = z.union([
  z.boolean(),
  z.enum(['true', 'false']).transform((value) => value === 'true'),
]);

export const taskListQuerySchema = z.strictObject({
  projectId: idSchema,
  sectionId: idSchema.optional(),
  statusId: idSchema.optional(),
  participantMembershipId: idSchema.optional(),
  search: z.string().max(200).optional(),
  includeArchived: queryBooleanSchema.optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z.string().min(1).max(2048).optional(),
});

export const projectResponseSchema = envelopeSchema(projectSchema);
export const projectListResponseSchema = envelopeSchema(z.array(projectSchema));
export const sectionResponseSchema = envelopeSchema(sectionSchema);
export const sectionListResponseSchema = envelopeSchema(z.array(sectionSchema));
export const taskStatusListResponseSchema = envelopeSchema(z.array(taskStatusSchema));
export const tagResponseSchema = envelopeSchema(tagSchema);
export const tagListResponseSchema = envelopeSchema(z.array(tagSchema));
export const taskResponseSchema = envelopeSchema(taskSchema);
export const taskListResponseSchema = envelopeSchema(z.array(taskSchema));
/** Participant rows of one task, inactive ones included. No dedicated P1a route is listed above. */
export const taskParticipantListResponseSchema = envelopeSchema(z.array(taskParticipantSchema));

export type TaskPriority = z.infer<typeof taskPrioritySchema>;
export type TaskStatusGroup = z.infer<typeof taskStatusGroupSchema>;
export type TaskWorkScope = z.infer<typeof taskWorkScopeSchema>;

export type ProjectDto = z.infer<typeof projectSchema>;
export type SectionDto = z.infer<typeof sectionSchema>;
export type TaskStatusDto = z.infer<typeof taskStatusSchema>;
export type TagDto = z.infer<typeof tagSchema>;
export type TaskParticipantDto = z.infer<typeof taskParticipantSchema>;
export type TaskDto = z.infer<typeof taskSchema>;

export type CreateProjectInput = z.infer<typeof createProjectInputSchema>;
export type UpdateProjectInput = z.infer<typeof updateProjectInputSchema>;
export type CreateSectionInput = z.infer<typeof createSectionInputSchema>;
export type UpdateSectionInput = z.infer<typeof updateSectionInputSchema>;
export type CreateTagInput = z.infer<typeof createTagInputSchema>;
export type UpdateTagInput = z.infer<typeof updateTagInputSchema>;
export type CreateTaskInput = z.infer<typeof createTaskInputSchema>;
export type UpdateTaskInput = z.infer<typeof updateTaskInputSchema>;
export type ArchiveTaskInput = z.infer<typeof archiveTaskInputSchema>;
export type RestoreTaskInput = z.infer<typeof restoreTaskInputSchema>;
export type TaskListQuery = z.infer<typeof taskListQuerySchema>;

export type ProjectResponse = z.infer<typeof projectResponseSchema>;
export type ProjectListResponse = z.infer<typeof projectListResponseSchema>;
export type SectionResponse = z.infer<typeof sectionResponseSchema>;
export type SectionListResponse = z.infer<typeof sectionListResponseSchema>;
export type TaskStatusListResponse = z.infer<typeof taskStatusListResponseSchema>;
export type TagResponse = z.infer<typeof tagResponseSchema>;
export type TagListResponse = z.infer<typeof tagListResponseSchema>;
export type TaskResponse = z.infer<typeof taskResponseSchema>;
export type TaskListResponse = z.infer<typeof taskListResponseSchema>;
export type TaskParticipantListResponse = z.infer<typeof taskParticipantListResponseSchema>;
