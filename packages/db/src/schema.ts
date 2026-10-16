/**
 * Drizzle description of the P0, P1a and P1b schema. The executable source of truth is the
 * reviewed SQL in ../migrations; keep both in sync (drizzle-kit generate must
 * produce no diff). Immutability triggers live only in SQL.
 */
import type { RecurrenceResolutionDto, RecurrenceScheduleInput, RecurrenceTemplateInput } from '@workloom/contracts';
import type { MeetingDto, AttendanceDto, AttendanceHistoryDto, AttendanceAttribution, TaskFieldData, TaskFieldDefinitionDto, PlanningSnapshotDto, PeriodCommitmentDto, WeeklyPlanFactReportRunDto, WeeklyPlanFactRowDto, WorkCategorySnapshot, WorkTypeReportRunDto, WorkTypeReportRowDto } from '@workloom/contracts';
import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  check,
  date,
  doublePrecision,
  foreignKey,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  smallint,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

export const userKindEnum = pgEnum('user_kind', ['fixture']);
export const workspaceRoleEnum = pgEnum('workspace_role', ['owner', 'admin', 'member', 'viewer']);
export const membershipStateEnum = pgEnum('membership_state', ['active', 'revoked']);
export const commandSourceEnum = pgEnum('command_source', ['web', 'api', 'mcp', 'job', 'import']);

/** Internal identities. P0 holds synthetic fixture users only (kind = 'fixture'). */
export const users = pgTable(
  'users',
  {
    id: uuid('id').primaryKey(),
    displayName: text('display_name').notNull(),
    kind: userKindEnum('kind').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  () => [check('users_display_name_length', sql`char_length(btrim(display_name)) between 1 and 200`)],
);

/** The workspace row doubles as the write barrier (SELECT … FOR UPDATE). */
export const workspaces = pgTable(
  'workspaces',
  {
    id: uuid('id').primaryKey(),
    name: text('name').notNull(),
    timezone: text('timezone').notNull(),
    weekStart: smallint('week_start').notNull().default(1),
    changeSeq: bigint('change_seq', { mode: 'bigint' }).notNull().default(sql`0`),
    permissionEpoch: bigint('permission_epoch', { mode: 'bigint' }).notNull().default(sql`0`),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  () => [
    check('workspaces_name_length', sql`char_length(btrim(name)) between 1 and 200`),
    check(
      'workspaces_timezone_format',
      sql`char_length(timezone) <= 64 and timezone ~ '^[A-Za-z][A-Za-z0-9_+-]*(/[A-Za-z0-9_+-]+)*$'`,
    ),
    check('workspaces_week_start_iso_weekday', sql`week_start between 1 and 7`),
    check('workspaces_change_seq_nonnegative', sql`change_seq >= 0`),
    check('workspaces_permission_epoch_nonnegative', sql`permission_epoch >= 0`),
  ],
);

/** One stable membership per (workspace, user); revocation is a state, never a delete. */
export const memberships = pgTable(
  'memberships',
  {
    id: uuid('id').primaryKey(),
    workspaceId: uuid('workspace_id').notNull(),
    userId: uuid('user_id').notNull(),
    role: workspaceRoleEnum('role').notNull(),
    state: membershipStateEnum('state').notNull().default('active'),
    revision: integer('revision').notNull().default(1),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    foreignKey({ name: 'memberships_workspace_fk', columns: [table.workspaceId], foreignColumns: [workspaces.id] }),
    foreignKey({ name: 'memberships_user_fk', columns: [table.userId], foreignColumns: [users.id] }),
    unique('memberships_workspace_user_unique').on(table.workspaceId, table.userId),
    unique('memberships_workspace_id_id_unique').on(table.workspaceId, table.id),
    index('memberships_user_active_idx').on(table.userId).where(sql`state = 'active'`),
    check('memberships_revision_positive', sql`revision >= 1`),
    check('memberships_revoked_at_matches_state', sql`(state = 'revoked') = (revoked_at is not null)`),
  ],
);

/** Immutable audit trail of committed changes (UPDATE/DELETE/TRUNCATE rejected by trigger). */
export const auditEvents = pgTable(
  'audit_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id').notNull(),
    changeSeq: bigint('change_seq', { mode: 'bigint' }).notNull(),
    eventOrdinal: integer('event_ordinal').notNull(),
    schemaVersion: integer('schema_version').notNull().default(1),
    actorUserId: uuid('actor_user_id').notNull(),
    actorMembershipId: uuid('actor_membership_id').notNull(),
    source: commandSourceEnum('source').notNull(),
    requestId: text('request_id').notNull(),
    entityType: text('entity_type').notNull(),
    entityId: uuid('entity_id').notNull(),
    entityRevision: integer('entity_revision'),
    action: text('action').notNull(),
    diff: jsonb('diff').$type<Record<string, unknown>>(),
    reason: text('reason'),
    recordedAt: timestamp('recorded_at', { withTimezone: true }).notNull(),
  },
  (table) => [
    foreignKey({ name: 'audit_events_workspace_fk', columns: [table.workspaceId], foreignColumns: [workspaces.id] }),
    foreignKey({ name: 'audit_events_actor_user_fk', columns: [table.actorUserId], foreignColumns: [users.id] }),
    foreignKey({
      name: 'audit_events_actor_membership_fk',
      columns: [table.workspaceId, table.actorMembershipId],
      foreignColumns: [memberships.workspaceId, memberships.id],
    }),
    unique('audit_events_workspace_seq_ordinal_unique').on(table.workspaceId, table.changeSeq, table.eventOrdinal),
    index('audit_events_entity_idx').on(table.workspaceId, table.entityType, table.entityId, table.changeSeq),
    check('audit_events_change_seq_positive', sql`change_seq >= 1`),
    check('audit_events_event_ordinal_positive', sql`event_ordinal >= 1`),
    check('audit_events_schema_version_positive', sql`schema_version >= 1`),
    check('audit_events_entity_revision_positive', sql`entity_revision is null or entity_revision >= 1`),
    check(
      'audit_events_labels_length',
      sql`char_length(entity_type) between 1 and 64 and char_length(action) between 1 and 64 and char_length(request_id) between 1 and 128`,
    ),
  ],
);

/** Transactional outbox: committed with the domain change, relayed after commit (P3 worker). */
export const outboxEvents = pgTable(
  'outbox_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id').notNull(),
    changeSeq: bigint('change_seq', { mode: 'bigint' }).notNull(),
    eventOrdinal: integer('event_ordinal').notNull(),
    type: text('type').notNull(),
    schemaVersion: integer('schema_version').notNull().default(1),
    aggregateType: text('aggregate_type').notNull(),
    aggregateId: uuid('aggregate_id').notNull(),
    aggregateRevision: integer('aggregate_revision'),
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull(),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull(),
    dispatchedAt: timestamp('dispatched_at', { withTimezone: true }),
  },
  (table) => [
    foreignKey({ name: 'outbox_events_workspace_fk', columns: [table.workspaceId], foreignColumns: [workspaces.id] }),
    unique('outbox_events_workspace_seq_ordinal_unique').on(table.workspaceId, table.changeSeq, table.eventOrdinal),
    index('outbox_events_pending_idx').on(table.occurredAt, table.id).where(sql`dispatched_at is null`),
    check('outbox_events_change_seq_positive', sql`change_seq >= 1`),
    check('outbox_events_event_ordinal_positive', sql`event_ordinal >= 1`),
    check('outbox_events_schema_version_positive', sql`schema_version >= 1`),
    check('outbox_events_aggregate_revision_positive', sql`aggregate_revision is null or aggregate_revision >= 1`),
    check(
      'outbox_events_labels_length',
      sql`char_length(type) between 1 and 128 and char_length(aggregate_type) between 1 and 64`,
    ),
  ],
);

// P1a: projects, sections, statuses, tags, work packages and tasks.

export const taskStatusGroupEnum = pgEnum('task_status_group', ['todo', 'in_progress', 'done', 'cancelled']);
export const taskPriorityEnum = pgEnum('task_priority', ['none', 'low', 'medium', 'high', 'urgent']);
export const taskVisibilityEnum = pgEnum('task_visibility', ['workspace']);
export const taskParticipantRoleEnum = pgEnum('task_participant_role', ['assignee']);
export const workPackageOriginEnum = pgEnum('work_package_origin', ['new_task', 'added_scope']);

export const projects = pgTable(
  'projects',
  {
    id: uuid('id').primaryKey(),
    workspaceId: uuid('workspace_id').notNull(),
    name: text('name').notNull(),
    revision: integer('revision').notNull().default(1),
    archivedAt: timestamp('archived_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    foreignKey({ name: 'projects_workspace_fk', columns: [table.workspaceId], foreignColumns: [workspaces.id] }),
    unique('projects_workspace_id_id_unique').on(table.workspaceId, table.id),
    check('projects_name_length', sql`char_length(btrim(name)) between 1 and 160`),
    check('projects_revision_positive', sql`revision >= 1`),
  ],
);

export const sections = pgTable(
  'sections',
  {
    id: uuid('id').primaryKey(),
    workspaceId: uuid('workspace_id').notNull(),
    projectId: uuid('project_id').notNull(),
    name: text('name').notNull(),
    position: integer('position').notNull(),
    revision: integer('revision').notNull().default(1),
    archivedAt: timestamp('archived_at', { withTimezone: true }),
  },
  (table) => [
    foreignKey({
      name: 'sections_project_fk',
      columns: [table.workspaceId, table.projectId],
      foreignColumns: [projects.workspaceId, projects.id],
    }),
    unique('sections_workspace_project_id_unique').on(table.workspaceId, table.projectId, table.id),
    check('sections_name_length', sql`char_length(btrim(name)) between 1 and 160`),
    check('sections_position_nonnegative', sql`position >= 0`),
    check('sections_revision_positive', sql`revision >= 1`),
  ],
);

export const taskStatuses = pgTable(
  'task_statuses',
  {
    id: uuid('id').primaryKey(),
    workspaceId: uuid('workspace_id').notNull(),
    projectId: uuid('project_id').notNull(),
    name: text('name').notNull(),
    group: taskStatusGroupEnum('group').notNull(),
    position: integer('position').notNull(),
    revision: integer('revision').notNull().default(1),
  },
  (table) => [
    foreignKey({
      name: 'task_statuses_project_fk',
      columns: [table.workspaceId, table.projectId],
      foreignColumns: [projects.workspaceId, projects.id],
    }),
    unique('task_statuses_workspace_project_id_unique').on(table.workspaceId, table.projectId, table.id),
    check('task_statuses_name_length', sql`char_length(btrim(name)) between 1 and 160`),
    check('task_statuses_position_nonnegative', sql`position >= 0`),
    check('task_statuses_revision_positive', sql`revision >= 1`),
  ],
);

/** Tasks reference tags by ID. Archived tags keep their name reserved (case-insensitive). */
export const workspaceTags = pgTable(
  'workspace_tags',
  {
    id: uuid('id').primaryKey(),
    workspaceId: uuid('workspace_id').notNull(),
    name: text('name').notNull(),
    color: text('color'),
    revision: integer('revision').notNull().default(1),
    archivedAt: timestamp('archived_at', { withTimezone: true }),
  },
  (table) => [
    foreignKey({ name: 'workspace_tags_workspace_fk', columns: [table.workspaceId], foreignColumns: [workspaces.id] }),
    unique('workspace_tags_workspace_id_id_unique').on(table.workspaceId, table.id),
    uniqueIndex('workspace_tags_workspace_name_unique_idx').on(table.workspaceId, sql`lower(name)`),
    check('workspace_tags_name_length', sql`char_length(btrim(name)) between 1 and 80`),
    check('workspace_tags_color_hex', sql`color is null or color ~ '^#[0-9A-Fa-f]{6}$'`),
    check('workspace_tags_revision_positive', sql`revision >= 1`),
  ],
);

/**
 * Shared work package: the single home of the current task estimate ("Оценка задачи"), shared by
 * a task and its detail subtasks. A current budget, not an immutable baseline. The links to the
 * initial task and to the added-scope source task are recorded in the creation audit event, not
 * as a foreign key, to avoid a circular dependency with tasks.
 */
export const workPackages = pgTable(
  'work_packages',
  {
    id: uuid('id').primaryKey(),
    workspaceId: uuid('workspace_id').notNull(),
    projectId: uuid('project_id').notNull(),
    origin: workPackageOriginEnum('origin').notNull(),
    sourcePackageId: uuid('source_package_id'),
    estimateMinutes: integer('estimate_minutes'),
    revision: integer('revision').notNull().default(1),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    foreignKey({
      name: 'work_packages_project_fk',
      columns: [table.workspaceId, table.projectId],
      foreignColumns: [projects.workspaceId, projects.id],
    }),
    foreignKey({
      name: 'work_packages_source_package_fk',
      columns: [table.workspaceId, table.projectId, table.sourcePackageId],
      foreignColumns: [table.workspaceId, table.projectId, table.id],
    }),
    unique('work_packages_workspace_project_id_unique').on(table.workspaceId, table.projectId, table.id),
    check('work_packages_source_matches_origin', sql`(origin = 'new_task') = (source_package_id is null)`),
    check('work_packages_source_not_self', sql`source_package_id is null or source_package_id <> id`),
    check('work_packages_estimate_nonnegative', sql`estimate_minutes is null or estimate_minutes >= 0`),
    check('work_packages_revision_positive', sql`revision >= 1`),
  ],
);

/**
 * Tasks never store an estimate; it is read from the work package. Indirect parent cycles are
 * rejected by the domain under the workspace barrier.
 */
export const tasks = pgTable(
  'tasks',
  {
    id: uuid('id').primaryKey(),
    workspaceId: uuid('workspace_id').notNull(),
    projectId: uuid('project_id').notNull(),
    sectionId: uuid('section_id'),
    parentTaskId: uuid('parent_task_id'),
    workPackageId: uuid('work_package_id').notNull(),
    title: text('title').notNull(),
    description: text('description').notNull().default(''),
    statusId: uuid('status_id').notNull(),
    responsibleMembershipId: uuid('responsible_membership_id'),
    participantsRevision: integer('participants_revision').notNull().default(1),
    startDate: date('start_date', { mode: 'string' }),
    dueDate: date('due_date', { mode: 'string' }),
    priority: taskPriorityEnum('priority').notNull().default('none'),
    revision: integer('revision').notNull().default(1),
    position: integer('position').notNull(),
    visibility: taskVisibilityEnum('visibility').notNull().default('workspace'),
    archivedAt: timestamp('archived_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check('tasks_dates_range_check',sql`${table.startDate} IS NULL OR ${table.dueDate} IS NULL OR ${table.startDate} <= ${table.dueDate}`),
    check('tasks_dates_supported_year_check',sql`(${table.startDate} IS NULL OR ${table.startDate} BETWEEN DATE '0001-01-01' AND DATE '9999-12-31') AND (${table.dueDate} IS NULL OR ${table.dueDate} BETWEEN DATE '0001-01-01' AND DATE '9999-12-31')`),
    foreignKey({
      name: 'tasks_project_fk',
      columns: [table.workspaceId, table.projectId],
      foreignColumns: [projects.workspaceId, projects.id],
    }),
    foreignKey({
      name: 'tasks_parent_fk',
      columns: [table.workspaceId, table.projectId, table.parentTaskId],
      foreignColumns: [table.workspaceId, table.projectId, table.id],
    }),
    foreignKey({
      name: 'tasks_section_fk',
      columns: [table.workspaceId, table.projectId, table.sectionId],
      foreignColumns: [sections.workspaceId, sections.projectId, sections.id],
    }),
    foreignKey({
      name: 'tasks_status_fk',
      columns: [table.workspaceId, table.projectId, table.statusId],
      foreignColumns: [taskStatuses.workspaceId, taskStatuses.projectId, taskStatuses.id],
    }),
    foreignKey({
      name: 'tasks_work_package_fk',
      columns: [table.workspaceId, table.projectId, table.workPackageId],
      foreignColumns: [workPackages.workspaceId, workPackages.projectId, workPackages.id],
    }),
    foreignKey({
      name: 'tasks_responsible_membership_fk',
      columns: [table.workspaceId, table.responsibleMembershipId],
      foreignColumns: [memberships.workspaceId, memberships.id],
    }),
    unique('tasks_workspace_id_id_unique').on(table.workspaceId, table.id),
    unique('tasks_workspace_project_id_unique').on(table.workspaceId, table.projectId, table.id),
    index('tasks_project_position_idx').on(table.workspaceId, table.projectId, table.position, table.id),
    index('tasks_status_idx').on(table.workspaceId, table.projectId, table.statusId),
    index('tasks_parent_idx').on(table.workspaceId, table.projectId, table.parentTaskId),
    check('tasks_parent_not_self', sql`parent_task_id is null or parent_task_id <> id`),
    check('tasks_title_length', sql`char_length(btrim(title)) between 1 and 500`),
    check('tasks_description_length', sql`char_length(description) <= 20000`),
    check('tasks_position_nonnegative', sql`position >= 0`),
    check('tasks_revision_positive', sql`revision >= 1`),
    check('tasks_participants_revision_positive', sql`participants_revision >= 1`),
  ],
);

/** Removed participants are deactivated (active = false), never deleted. */
export const taskParticipants = pgTable(
  'task_participants',
  {
    workspaceId: uuid('workspace_id').notNull(),
    taskId: uuid('task_id').notNull(),
    membershipId: uuid('membership_id').notNull(),
    role: taskParticipantRoleEnum('role').notNull().default('assignee'),
    active: boolean('active').notNull().default(true),
    revision: integer('revision').notNull().default(1),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ name: 'task_participants_pk', columns: [table.workspaceId, table.taskId, table.membershipId] }),
    foreignKey({
      name: 'task_participants_task_fk',
      columns: [table.workspaceId, table.taskId],
      foreignColumns: [tasks.workspaceId, tasks.id],
    }),
    foreignKey({
      name: 'task_participants_membership_fk',
      columns: [table.workspaceId, table.membershipId],
      foreignColumns: [memberships.workspaceId, memberships.id],
    }),
    index('task_participants_membership_idx').on(table.workspaceId, table.membershipId, table.active),
    check('task_participants_revision_positive', sql`revision >= 1`),
  ],
);

export const taskTags = pgTable(
  'task_tags',
  {
    workspaceId: uuid('workspace_id').notNull(),
    taskId: uuid('task_id').notNull(),
    tagId: uuid('tag_id').notNull(),
  },
  (table) => [
    primaryKey({ name: 'task_tags_pk', columns: [table.workspaceId, table.taskId, table.tagId] }),
    foreignKey({
      name: 'task_tags_task_fk',
      columns: [table.workspaceId, table.taskId],
      foreignColumns: [tasks.workspaceId, tasks.id],
    }),
    foreignKey({
      name: 'task_tags_tag_fk',
      columns: [table.workspaceId, table.tagId],
      foreignColumns: [workspaceTags.workspaceId, workspaceTags.id],
    }),
    index('task_tags_tag_idx').on(table.workspaceId, table.tagId, table.taskId),
  ],
);

/**
 * Replay record per (workspace, actor, command, Idempotency-Key). `result` is the committed
 * response DTO; `payload_hash` detects key reuse with a different body. Rows are not expired.
 */
export const commandIdempotency = pgTable(
  'command_idempotency',
  {
    workspaceId: uuid('workspace_id').notNull(),
    actorUserId: uuid('actor_user_id').notNull(),
    command: text('command').notNull(),
    idempotencyKey: text('idempotency_key').notNull(),
    payloadHash: text('payload_hash').notNull(),
    result: jsonb('result').$type<unknown>().notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({
      name: 'command_idempotency_pk',
      columns: [table.workspaceId, table.actorUserId, table.command, table.idempotencyKey],
    }),
    foreignKey({
      name: 'command_idempotency_actor_membership_fk',
      columns: [table.workspaceId, table.actorUserId],
      foreignColumns: [memberships.workspaceId, memberships.userId],
    }),
    check('command_idempotency_command_length', sql`char_length(command) between 1 and 80`),
    check('command_idempotency_key_format', sql`idempotency_key ~ '^[ -~]{1,128}$'`),
    check('command_idempotency_payload_hash_format', sql`payload_hash ~ '^[0-9a-f]{64}$'`),
  ],
);

// P1b: project-scoped typed custom task fields, shared column settings and value history.

export const taskFieldTypeEnum = pgEnum('task_field_type', [
  'text',
  'number',
  'duration',
  'date',
  'single_select',
  'multi_select',
  'person',
  'boolean',
  'url',
]);

/**
 * Current field definition; the type is immutable. Archived fields keep their name reserved
 * (case-insensitive) so a restore never collides. `definition_version_id` points at the current
 * immutable version. Its FK to task_field_definition_versions is DEFERRABLE INITIALLY DEFERRED and
 * exists only in SQL: the definition row is inserted before its first version in the same
 * transaction, and declaring it here would make the two tables reference each other.
 */
export const taskFieldDefinitions = pgTable(
  'task_field_definitions',
  {
    id: uuid('id').primaryKey(),
    workspaceId: uuid('workspace_id').notNull(),
    projectId: uuid('project_id').notNull(),
    name: text('name').notNull(),
    type: taskFieldTypeEnum('type').notNull(),
    revision: integer('revision').notNull().default(1),
    definitionVersionId: uuid('definition_version_id').notNull(),
    historyEnabled: boolean('history_enabled').notNull().default(true),
    locked: boolean('locked').notNull().default(false),
    archivedAt: timestamp('archived_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    foreignKey({
      name: 'task_field_definitions_project_fk',
      columns: [table.workspaceId, table.projectId],
      foreignColumns: [projects.workspaceId, projects.id],
    }),
    unique('task_field_definitions_workspace_project_id_unique').on(table.workspaceId, table.projectId, table.id),
    unique('task_field_definitions_workspace_project_id_type_unique').on(
      table.workspaceId,
      table.projectId,
      table.id,
      table.type,
    ),
    uniqueIndex('task_field_definitions_project_name_unique_idx').on(
      table.workspaceId,
      table.projectId,
      sql`lower(name)`,
    ),
    check('task_field_definitions_name_length', sql`char_length(btrim(name)) between 1 and 160`),
    check('task_field_definitions_revision_positive', sql`revision >= 1`),
  ],
);

/**
 * Immutable definition versions (UPDATE/DELETE/TRUNCATE rejected by trigger). `snapshot` is the
 * full definition DTO at that revision, including every option (ID, label, color, archived) and
 * the history/lock policy, so history never relabels the past.
 */
export const taskFieldDefinitionVersions = pgTable(
  'task_field_definition_versions',
  {
    id: uuid('id').primaryKey(),
    workspaceId: uuid('workspace_id').notNull(),
    projectId: uuid('project_id').notNull(),
    fieldId: uuid('field_id').notNull(),
    revision: integer('revision').notNull(),
    snapshot: jsonb('snapshot').$type<TaskFieldDefinitionDto>().notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    foreignKey({
      name: 'task_field_definition_versions_field_fk',
      columns: [table.workspaceId, table.projectId, table.fieldId],
      foreignColumns: [taskFieldDefinitions.workspaceId, taskFieldDefinitions.projectId, taskFieldDefinitions.id],
    }),
    unique('task_field_definition_versions_workspace_project_field_id_unique').on(
      table.workspaceId,
      table.projectId,
      table.fieldId,
      table.id,
    ),
    unique('task_field_definition_versions_field_revision_unique').on(
      table.workspaceId,
      table.projectId,
      table.fieldId,
      table.revision,
    ),
    check('task_field_definition_versions_revision_positive', sql`revision >= 1`),
    check(
      'task_field_definition_versions_snapshot_identity',
      sql`(jsonb_typeof(snapshot) = 'object' and snapshot ->> 'id' = field_id::text and snapshot ->> 'workspaceId' = workspace_id::text and snapshot ->> 'projectId' = project_id::text and snapshot ->> 'definitionVersionId' = id::text and snapshot -> 'revision' = to_jsonb(revision)) is true`,
    ),
  ],
);

/** Select options. IDs are stable across rename and archive; archived names stay reserved. */
export const taskFieldOptions = pgTable(
  'task_field_options',
  {
    id: uuid('id').primaryKey(),
    workspaceId: uuid('workspace_id').notNull(),
    projectId: uuid('project_id').notNull(),
    fieldId: uuid('field_id').notNull(),
    name: text('name').notNull(),
    color: text('color'),
    position: integer('position').notNull(),
    revision: integer('revision').notNull().default(1),
    archivedAt: timestamp('archived_at', { withTimezone: true }),
  },
  (table) => [
    foreignKey({
      name: 'task_field_options_field_fk',
      columns: [table.workspaceId, table.projectId, table.fieldId],
      foreignColumns: [taskFieldDefinitions.workspaceId, taskFieldDefinitions.projectId, taskFieldDefinitions.id],
    }),
    unique('task_field_options_workspace_project_field_id_unique').on(
      table.workspaceId,
      table.projectId,
      table.fieldId,
      table.id,
    ),
    uniqueIndex('task_field_options_field_name_unique_idx').on(
      table.workspaceId,
      table.projectId,
      table.fieldId,
      sql`lower(name)`,
    ),
    check('task_field_options_name_length', sql`char_length(btrim(name)) between 1 and 100`),
    check('task_field_options_color_hex', sql`color is null or color ~ '^#[0-9a-f]{6}$'`),
    check('task_field_options_position_nonnegative', sql`position >= 0`),
    check('task_field_options_revision_positive', sql`revision >= 1`),
  ],
);

/**
 * Shared project column settings header. Absent means virtual revision 1 with no columns; the
 * first write (the first field append) inserts revision 2.
 */
export const projectColumnSettings = pgTable(
  'project_column_settings',
  {
    workspaceId: uuid('workspace_id').notNull(),
    projectId: uuid('project_id').notNull(),
    revision: integer('revision').notNull(),
  },
  (table) => [
    primaryKey({ name: 'project_column_settings_pk', columns: [table.workspaceId, table.projectId] }),
    foreignKey({
      name: 'project_column_settings_project_fk',
      columns: [table.workspaceId, table.projectId],
      foreignColumns: [projects.workspaceId, projects.id],
    }),
    check('project_column_settings_revision_positive', sql`revision >= 1`),
  ],
);

/**
 * Column bindings for active fields. A settings replacement deletes all of the project's rows
 * before inserting the new set; this is configuration only and never touches values or history.
 */
export const projectColumns = pgTable(
  'project_columns',
  {
    workspaceId: uuid('workspace_id').notNull(),
    projectId: uuid('project_id').notNull(),
    fieldId: uuid('field_id').notNull(),
    visible: boolean('visible').notNull().default(true),
    width: integer('width').notNull(),
    position: integer('position').notNull(),
  },
  (table) => [
    primaryKey({ name: 'project_columns_pk', columns: [table.workspaceId, table.projectId, table.fieldId] }),
    foreignKey({
      name: 'project_columns_settings_fk',
      columns: [table.workspaceId, table.projectId],
      foreignColumns: [projectColumnSettings.workspaceId, projectColumnSettings.projectId],
    }),
    foreignKey({
      name: 'project_columns_field_fk',
      columns: [table.workspaceId, table.projectId, table.fieldId],
      foreignColumns: [taskFieldDefinitions.workspaceId, taskFieldDefinitions.projectId, taskFieldDefinitions.id],
    }),
    unique('project_columns_workspace_project_position_unique').on(table.workspaceId, table.projectId, table.position),
    check('project_columns_width_range', sql`width between 80 and 640`),
    check('project_columns_position_nonnegative', sql`position >= 0`),
  ],
);

/**
 * Current typed value per (task, field). `value` is `{type, value}` where `type` equals the
 * field type and `value` is JSON null (an explicit clear) or a primitive of that type. Option and
 * membership references inside the value are validated by the domain under the workspace barrier.
 */
export const taskFieldValues = pgTable(
  'task_field_values',
  {
    workspaceId: uuid('workspace_id').notNull(),
    projectId: uuid('project_id').notNull(),
    taskId: uuid('task_id').notNull(),
    fieldId: uuid('field_id').notNull(),
    fieldType: taskFieldTypeEnum('field_type').notNull(),
    definitionVersionId: uuid('definition_version_id').notNull(),
    revision: integer('revision').notNull().default(1),
    value: jsonb('value').$type<TaskFieldData>().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ name: 'task_field_values_pk', columns: [table.workspaceId, table.taskId, table.fieldId] }),
    foreignKey({
      name: 'task_field_values_task_fk',
      columns: [table.workspaceId, table.projectId, table.taskId],
      foreignColumns: [tasks.workspaceId, tasks.projectId, tasks.id],
    }),
    foreignKey({
      name: 'task_field_values_field_type_fk',
      columns: [table.workspaceId, table.projectId, table.fieldId, table.fieldType],
      foreignColumns: [
        taskFieldDefinitions.workspaceId,
        taskFieldDefinitions.projectId,
        taskFieldDefinitions.id,
        taskFieldDefinitions.type,
      ],
    }),
    foreignKey({
      name: 'task_field_values_definition_version_fk',
      columns: [table.workspaceId, table.projectId, table.fieldId, table.definitionVersionId],
      foreignColumns: [
        taskFieldDefinitionVersions.workspaceId,
        taskFieldDefinitionVersions.projectId,
        taskFieldDefinitionVersions.fieldId,
        taskFieldDefinitionVersions.id,
      ],
    }),
    index('task_field_values_field_idx').on(table.workspaceId, table.projectId, table.fieldId),
    check('task_field_values_revision_positive', sql`revision >= 1`),
    check(
      'task_field_values_value_shape',
      sql`(case when jsonb_typeof(value) = 'object' then value ? 'type' and value ? 'value' and value - 'type' - 'value' = '{}'::jsonb and jsonb_typeof(value -> 'type') = 'string' else false end) is true`,
    ),
    check('task_field_values_value_type_matches', sql`(value ->> 'type' = field_type::text) is true`),
    check(
      'task_field_values_value_primitive',
      sql`(jsonb_typeof(value -> 'value') = 'null' or case
        when field_type = 'text' then jsonb_typeof(value -> 'value') = 'string' and char_length(value ->> 'value') <= 10000
        when field_type = 'number' then case when jsonb_typeof(value -> 'value') = 'number' then (value -> 'value')::numeric between -1000000000000 and 1000000000000 else false end
        when field_type = 'duration' then case when jsonb_typeof(value -> 'value') = 'number' then (value -> 'value')::numeric between 0 and 2147483647 and (value -> 'value')::numeric = trunc((value -> 'value')::numeric) else false end
        when field_type = 'date' then jsonb_typeof(value -> 'value') = 'string' and value ->> 'value' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
        when field_type = 'single_select' then jsonb_typeof(value -> 'value') = 'string' and value ->> 'value' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
        when field_type in ('multi_select', 'person') then case when jsonb_typeof(value -> 'value') = 'array' then jsonb_array_length(value -> 'value') <= 100 and not jsonb_path_exists(value -> 'value', '$[*] ? (@.type() != "string" || !(@ like_regex "^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$"))') else false end
        when field_type = 'boolean' then jsonb_typeof(value -> 'value') = 'boolean'
        when field_type = 'url' then jsonb_typeof(value -> 'value') = 'string' and char_length(value ->> 'value') <= 2048 and value ->> 'value' ~* '^https?://'
        else false
      end) is true`,
    ),
  ],
);

/**
 * Immutable value history (UPDATE/DELETE/TRUNCATE rejected by trigger), written only for changed
 * values while the field has history enabled. `before` NULL means no row existed; a typed
 * `{"value": null}` is a clear. The definition label set comes from the referenced version's
 * snapshot; the actor display name is snapshotted here. Full before/after values live only here,
 * never in audit_events or outbox_events. One row per audit event ordinal.
 */
export const taskFieldValueHistory = pgTable(
  'task_field_value_history',
  {
    id: uuid('id').primaryKey(),
    workspaceId: uuid('workspace_id').notNull(),
    projectId: uuid('project_id').notNull(),
    taskId: uuid('task_id').notNull(),
    fieldId: uuid('field_id').notNull(),
    definitionVersionId: uuid('definition_version_id').notNull(),
    valueRevision: integer('value_revision').notNull(),
    before: jsonb('before').$type<TaskFieldData>(),
    after: jsonb('after').$type<TaskFieldData>().notNull(),
    actorUserId: uuid('actor_user_id').notNull(),
    actorDisplayName: text('actor_display_name').notNull(),
    source: commandSourceEnum('source').notNull(),
    recordedAt: timestamp('recorded_at', { withTimezone: true }).notNull(),
    changeSeq: bigint('change_seq', { mode: 'bigint' }).notNull(),
    eventOrdinal: integer('event_ordinal').notNull(),
  },
  (table) => [
    foreignKey({
      name: 'task_field_value_history_task_fk',
      columns: [table.workspaceId, table.projectId, table.taskId],
      foreignColumns: [tasks.workspaceId, tasks.projectId, tasks.id],
    }),
    foreignKey({
      name: 'task_field_value_history_field_fk',
      columns: [table.workspaceId, table.projectId, table.fieldId],
      foreignColumns: [taskFieldDefinitions.workspaceId, taskFieldDefinitions.projectId, taskFieldDefinitions.id],
    }),
    foreignKey({
      name: 'task_field_value_history_definition_version_fk',
      columns: [table.workspaceId, table.projectId, table.fieldId, table.definitionVersionId],
      foreignColumns: [
        taskFieldDefinitionVersions.workspaceId,
        taskFieldDefinitionVersions.projectId,
        taskFieldDefinitionVersions.fieldId,
        taskFieldDefinitionVersions.id,
      ],
    }),
    foreignKey({ name: 'task_field_value_history_actor_user_fk', columns: [table.actorUserId], foreignColumns: [users.id] }),
    unique('task_field_value_history_workspace_seq_ordinal_unique').on(
      table.workspaceId,
      table.changeSeq,
      table.eventOrdinal,
    ),
    // Scanned backward for newest-first keyset pages.
    index('task_field_value_history_keyset_idx').on(
      table.workspaceId,
      table.taskId,
      table.fieldId,
      table.changeSeq,
      table.eventOrdinal,
      table.id,
    ),
    check('task_field_value_history_value_revision_positive', sql`value_revision >= 1`),
    check('task_field_value_history_change_seq_positive', sql`change_seq >= 1`),
    check('task_field_value_history_event_ordinal_positive', sql`event_ordinal >= 1`),
    check(
      'task_field_value_history_actor_display_name_length',
      sql`char_length(btrim(actor_display_name)) between 1 and 200`,
    ),
    check(
      'task_field_value_history_after_shape',
      sql`(case when jsonb_typeof("after") = 'object' then "after" ? 'type' and "after" ? 'value' and "after" - 'type' - 'value' = '{}'::jsonb and jsonb_typeof("after" -> 'type') = 'string' and "after" ->> 'type' in ('text', 'number', 'duration', 'date', 'single_select', 'multi_select', 'person', 'boolean', 'url') else false end) is true`,
    ),
    check(
      'task_field_value_history_before_shape',
      sql`"before" is null or (case when jsonb_typeof("before") = 'object' then "before" ? 'type' and "before" ? 'value' and "before" - 'type' - 'value' = '{}'::jsonb and jsonb_typeof("before" -> 'type') = 'string' and "before" ->> 'type' = "after" ->> 'type' else false end) is true`,
    ),
  ],
);

/** Tables the running application requires; readiness fails if any is missing. */
export const REQUIRED_TABLES = [
  'meetings','meeting_revisions','meeting_attendances','meeting_attendance_revisions','meeting_schedule_locks',
  'users',
  'workspaces',
  'memberships',
  'audit_events',
  'outbox_events',
  'projects',
  'sections',
  'task_statuses',
  'workspace_tags',
  'work_packages',
  'tasks',
  'task_participants',
  'task_tags',
  'command_idempotency',
  'task_field_definitions',
  'task_field_definition_versions',
  'task_field_options',
  'project_column_settings',
  'project_columns',
  'task_field_values',
  'task_field_value_history',
  'planning_periods',
  'period_commitments',
  'commitment_allocations',
  'period_commitment_revisions',
  'plan_baselines',
  'package_baselines',
  'package_freeze_observations',
  'planning_locks',
  'work_logs',
  'work_log_revisions',
  'weekly_report_runs',
  'project_work_category_bindings',
  'project_work_category_binding_versions',
  'work_type_report_runs',
  'recurrence_series','recurrence_series_versions','recurrence_generation_authorizations','recurrence_period_bindings',
  'recurrence_instances','recurrence_exception_versions','recurrence_calendar_locks',
  'task_dependencies','project_dependency_policies','graph_layouts','graph_layout_positions',
] as const;


// P2a: weekly planning, immutable source snapshots, period work and pinned report runs.
export const planningPeriodStateEnum = pgEnum('planning_period_state', ['planning', 'frozen']);
export const commitmentStateEnum = pgEnum('commitment_state', ['active', 'removed']);
export const baselineScopeEnum = pgEnum('baseline_scope', ['self', 'project']);
export const baselineModeEnum = pgEnum('baseline_mode', ['manual', 'cutoff']);
export const planningLockKindEnum = pgEnum('planning_lock_kind', ['estimate', 'custom_value', 'commitment']);
export const workLogStateEnum = pgEnum('work_log_state', ['active', 'void']);

export const planningPeriods = pgTable('planning_periods', {
  id: uuid('id').primaryKey(), workspaceId: uuid('workspace_id').notNull(), projectId: uuid('project_id').notNull(),
  name: text('name').notNull(), localStart: date('local_start').notNull(), localEndExclusive: date('local_end_exclusive').notNull(),
  timezone: text('timezone').notNull(), cutoffAt: timestamp('cutoff_at', {withTimezone:true}).notNull(),
  state: planningPeriodStateEnum('state').notNull().default('planning'), revision: integer('revision').notNull().default(1),
  protectedFieldIds: jsonb('protected_field_ids').$type<string[]>().notNull().default(sql`'[]'::jsonb`),
  protectEstimate: boolean('protect_estimate').notNull().default(true), projectBaselineId: uuid('project_baseline_id'),
  createdAt: timestamp('created_at', {withTimezone:true}).notNull(), updatedAt: timestamp('updated_at', {withTimezone:true}).notNull(),
}, t=>[
  unique('planning_periods_scope_id_unique').on(t.workspaceId,t.projectId,t.id),
  unique('planning_periods_workspace_id_unique').on(t.workspaceId,t.id),
  unique('planning_periods_project_week_unique').on(t.workspaceId,t.projectId,t.localStart),
  foreignKey({name:'planning_periods_project_fk', columns:[t.workspaceId,t.projectId], foreignColumns:[projects.workspaceId,projects.id]}),
  check('planning_periods_week',sql`local_end_exclusive = local_start + 7`),
  check('planning_periods_revision',sql`revision >= 1`),
  check('planning_periods_name',sql`char_length(btrim(name)) between 1 and 160`),
  check('planning_periods_field_ids_array',sql`jsonb_typeof(protected_field_ids) = 'array'`),
  check('planning_periods_state_baseline',sql`(state = 'frozen') = (project_baseline_id is not null)`),
]);

export const periodCommitments = pgTable('period_commitments', {
  id:uuid('id').primaryKey(),workspaceId:uuid('workspace_id').notNull(),projectId:uuid('project_id').notNull(),
  periodId:uuid('period_id').notNull(),workPackageId:uuid('work_package_id').notNull(),membershipId:uuid('membership_id').notNull(),
  plannedMinutes:integer('planned_minutes'),state:commitmentStateEnum('state').notNull().default('active'),revision:integer('revision').notNull(),
  added:boolean('added').notNull().default(false),createdAt:timestamp('created_at',{withTimezone:true}).notNull(),updatedAt:timestamp('updated_at',{withTimezone:true}).notNull(),
},t=>[
  unique('period_commitments_workspace_id_unique').on(t.workspaceId,t.id),
  unique('period_commitments_scope_id_unique').on(t.workspaceId,t.projectId,t.id),
  unique('period_commitments_source_unique').on(t.workspaceId,t.periodId,t.workPackageId,t.membershipId),
  foreignKey({name:'period_commitments_period_fk',columns:[t.workspaceId,t.projectId,t.periodId],foreignColumns:[planningPeriods.workspaceId,planningPeriods.projectId,planningPeriods.id]}),
  foreignKey({name:'period_commitments_package_fk',columns:[t.workspaceId,t.projectId,t.workPackageId],foreignColumns:[workPackages.workspaceId,workPackages.projectId,workPackages.id]}),
  foreignKey({name:'period_commitments_member_fk',columns:[t.workspaceId,t.membershipId],foreignColumns:[memberships.workspaceId,memberships.id]}),
  check('period_commitments_minutes',sql`planned_minutes is null or planned_minutes >= 0`),check('period_commitments_revision',sql`revision >= 1`),
]);
export const commitmentAllocations = pgTable('commitment_allocations', {
  workspaceId:uuid('workspace_id').notNull(),projectId:uuid('project_id').notNull(),commitmentId:uuid('commitment_id').notNull(),taskId:uuid('task_id').notNull(),minutes:integer('minutes').notNull(),
},t=>[
  primaryKey({name:'commitment_allocations_pk',columns:[t.workspaceId,t.commitmentId,t.taskId]}),
  foreignKey({name:'commitment_allocations_commitment_fk',columns:[t.workspaceId,t.projectId,t.commitmentId],foreignColumns:[periodCommitments.workspaceId,periodCommitments.projectId,periodCommitments.id]}),
  foreignKey({name:'commitment_allocations_task_fk',columns:[t.workspaceId,t.projectId,t.taskId],foreignColumns:[tasks.workspaceId,tasks.projectId,tasks.id]}),
  check('commitment_allocations_minutes',sql`minutes >= 0`),
]);
export const periodCommitmentRevisions = pgTable('period_commitment_revisions',{
  id:uuid('id').primaryKey(),workspaceId:uuid('workspace_id').notNull(),commitmentId:uuid('commitment_id').notNull(),revision:integer('revision').notNull(),
  snapshot:jsonb('snapshot').$type<PeriodCommitmentDto>().notNull(),actorUserId:uuid('actor_user_id').notNull(),recordedAt:timestamp('recorded_at',{withTimezone:true}).notNull(),changeSeq:bigint('change_seq',{mode:'bigint'}).notNull(),
},t=>[
  unique('period_commitment_revisions_source_unique').on(t.workspaceId,t.commitmentId,t.revision),
  foreignKey({name:'period_commitment_revisions_source_fk',columns:[t.workspaceId,t.commitmentId],foreignColumns:[periodCommitments.workspaceId,periodCommitments.id]}),
  foreignKey({name:'period_commitment_revisions_actor_fk',columns:[t.actorUserId],foreignColumns:[users.id]}),
  check('period_commitment_revisions_snapshot',sql`(jsonb_typeof(snapshot) = 'object' and snapshot->>'id' = commitment_id::text and (snapshot->>'revision')::integer = revision) is true`),
  check('period_commitment_revisions_positive',sql`revision >= 1 and change_seq >= 1`),
]);
export const planBaselines = pgTable('plan_baselines',{
  id:uuid('id').primaryKey(),workspaceId:uuid('workspace_id').notNull(),projectId:uuid('project_id').notNull(),periodId:uuid('period_id').notNull(),
  scope:baselineScopeEnum('scope').notNull(),membershipId:uuid('membership_id'),mode:baselineModeEnum('mode').notNull(),
  requestedCutoffAt:timestamp('requested_cutoff_at',{withTimezone:true}).notNull(),frozenAt:timestamp('frozen_at',{withTimezone:true}).notNull(),
  actorUserId:uuid('actor_user_id').notNull(),source:commandSourceEnum('source').notNull(),changeSeq:bigint('change_seq',{mode:'bigint'}).notNull(),
  snapshot:jsonb('snapshot').$type<PlanningSnapshotDto>().notNull(),
},t=>[
  unique('plan_baselines_workspace_id_unique').on(t.workspaceId,t.id),
  unique('plan_baselines_scope_id_unique').on(t.workspaceId,t.projectId,t.id),
  uniqueIndex('plan_baselines_personal_unique').on(t.workspaceId,t.periodId,t.membershipId).where(sql`scope = 'self'`),
  uniqueIndex('plan_baselines_project_unique').on(t.workspaceId,t.periodId).where(sql`scope = 'project'`),
  foreignKey({name:'plan_baselines_period_fk',columns:[t.workspaceId,t.projectId,t.periodId],foreignColumns:[planningPeriods.workspaceId,planningPeriods.projectId,planningPeriods.id]}),
  foreignKey({name:'plan_baselines_member_fk',columns:[t.workspaceId,t.membershipId],foreignColumns:[memberships.workspaceId,memberships.id]}),
  foreignKey({name:'plan_baselines_actor_fk',columns:[t.actorUserId],foreignColumns:[users.id]}),
  check('plan_baselines_scope_member',sql`(scope = 'self') = (membership_id is not null)`),
  check('plan_baselines_seq',sql`change_seq >= 1`),
  check('plan_baselines_snapshot_scope',sql`(jsonb_typeof(snapshot) = 'object' and snapshot->>'schemaVersion' = '1' and snapshot#>>'{period,id}' = period_id::text and snapshot#>>'{period,workspaceId}' = workspace_id::text and snapshot#>>'{period,projectId}' = project_id::text) is true`),
]);
export const packageBaselines = pgTable('package_baselines',{
  id:uuid('id').primaryKey(),workspaceId:uuid('workspace_id').notNull(),projectId:uuid('project_id').notNull(),workPackageId:uuid('work_package_id').notNull(),
  estimateMinutes:integer('estimate_minutes').notNull(),sourcePackageRevision:integer('source_package_revision').notNull(),
  sourceBaselineId:uuid('source_baseline_id').notNull(),acceptedAt:timestamp('accepted_at',{withTimezone:true}).notNull(),
},t=>[
  unique('package_baselines_workspace_id_unique').on(t.workspaceId,t.id),unique('package_baselines_package_unique').on(t.workspaceId,t.workPackageId),
  foreignKey({name:'package_baselines_package_fk',columns:[t.workspaceId,t.projectId,t.workPackageId],foreignColumns:[workPackages.workspaceId,workPackages.projectId,workPackages.id]}),
  foreignKey({name:'package_baselines_source_fk',columns:[t.workspaceId,t.projectId,t.sourceBaselineId],foreignColumns:[planBaselines.workspaceId,planBaselines.projectId,planBaselines.id]}),
  check('package_baselines_values',sql`estimate_minutes >= 0 and source_package_revision >= 1`),
]);
export const planningLocks = pgTable('planning_locks',{
  id:uuid('id').primaryKey(),workspaceId:uuid('workspace_id').notNull(),projectId:uuid('project_id').notNull(),baselineId:uuid('baseline_id').notNull(),
  kind:planningLockKindEnum('kind').notNull(),workPackageId:uuid('work_package_id'),taskId:uuid('task_id'),fieldId:uuid('field_id'),commitmentId:uuid('commitment_id'),
},t=>[
  foreignKey({name:'planning_locks_baseline_fk',columns:[t.workspaceId,t.projectId,t.baselineId],foreignColumns:[planBaselines.workspaceId,planBaselines.projectId,planBaselines.id]}),
  foreignKey({name:'planning_locks_package_fk',columns:[t.workspaceId,t.projectId,t.workPackageId],foreignColumns:[workPackages.workspaceId,workPackages.projectId,workPackages.id]}),
  foreignKey({name:'planning_locks_task_fk',columns:[t.workspaceId,t.projectId,t.taskId],foreignColumns:[tasks.workspaceId,tasks.projectId,tasks.id]}),
  foreignKey({name:'planning_locks_field_fk',columns:[t.workspaceId,t.projectId,t.fieldId],foreignColumns:[taskFieldDefinitions.workspaceId,taskFieldDefinitions.projectId,taskFieldDefinitions.id]}),
  foreignKey({name:'planning_locks_commitment_fk',columns:[t.workspaceId,t.projectId,t.commitmentId],foreignColumns:[periodCommitments.workspaceId,periodCommitments.projectId,periodCommitments.id]}),
  uniqueIndex('planning_locks_estimate_unique').on(t.workspaceId,t.baselineId,t.workPackageId).where(sql`kind = 'estimate'`),
  uniqueIndex('planning_locks_value_unique').on(t.workspaceId,t.baselineId,t.taskId,t.fieldId).where(sql`kind = 'custom_value'`),
  uniqueIndex('planning_locks_commitment_unique').on(t.workspaceId,t.baselineId,t.commitmentId).where(sql`kind = 'commitment'`),
  check('planning_locks_shape',sql`(kind = 'estimate' and work_package_id is not null and task_id is null and field_id is null and commitment_id is null) or (kind = 'custom_value' and task_id is not null and field_id is not null and work_package_id is null and commitment_id is null) or (kind = 'commitment' and commitment_id is not null and work_package_id is null and task_id is null and field_id is null)`),
]);
export const meetings=pgTable('meetings',{
 id:uuid('id').primaryKey(),workspaceId:uuid('workspace_id').notNull(),projectId:uuid('project_id').notNull(),taskId:uuid('task_id').notNull(),workPackageId:uuid('work_package_id').notNull(),plannedPeriodId:uuid('planned_period_id').notNull(),revision:integer('revision').notNull(),document:jsonb('document').$type<MeetingDto>().notNull(),
},t=>[
 unique('meetings_workspace_id_unique').on(t.workspaceId,t.id),unique('meetings_project_id_unique').on(t.workspaceId,t.projectId,t.id),unique('meetings_task_unique').on(t.workspaceId,t.taskId),unique('meetings_package_unique').on(t.workspaceId,t.workPackageId),unique('meetings_source_unique').on(t.workspaceId,t.id,t.taskId,t.plannedPeriodId),
 foreignKey({name:'meetings_task_fk',columns:[t.workspaceId,t.projectId,t.taskId],foreignColumns:[tasks.workspaceId,tasks.projectId,tasks.id]}),
 foreignKey({name:'meetings_package_fk',columns:[t.workspaceId,t.projectId,t.workPackageId],foreignColumns:[workPackages.workspaceId,workPackages.projectId,workPackages.id]}),
 foreignKey({name:'meetings_period_fk',columns:[t.workspaceId,t.projectId,t.plannedPeriodId],foreignColumns:[planningPeriods.workspaceId,planningPeriods.projectId,planningPeriods.id]}),
 check('meetings_document_identity',sql`(document ?& array['id','workspaceId','projectId','taskId','workPackageId','plannedPeriodId','revision'] and document->>'id'=id::text and document->>'workspaceId'=workspace_id::text and document->>'projectId'=project_id::text and document->>'taskId'=task_id::text and document->>'workPackageId'=work_package_id::text and document->>'plannedPeriodId'=planned_period_id::text and (document->>'revision')::integer=revision and revision>=1) is true`),
]);
export const meetingRevisions=pgTable('meeting_revisions',{
 id:uuid('id').primaryKey(),workspaceId:uuid('workspace_id').notNull(),meetingId:uuid('meeting_id').notNull(),revision:integer('revision').notNull(),document:jsonb('document').$type<MeetingDto>().notNull(),actorUserId:uuid('actor_user_id').notNull(),changeSeq:bigint('change_seq',{mode:'bigint'}).notNull(),
},t=>[unique('meeting_revisions_source_unique').on(t.workspaceId,t.meetingId,t.revision),foreignKey({name:'meeting_revisions_meeting_fk',columns:[t.workspaceId,t.meetingId],foreignColumns:[meetings.workspaceId,meetings.id]}),foreignKey({name:'meeting_revisions_actor_fk',columns:[t.actorUserId],foreignColumns:[users.id]}),check('meeting_revisions_document_identity',sql`(document->>'id'=meeting_id::text and document->>'workspaceId'=workspace_id::text and (document->>'revision')::integer=revision and revision>=1 and change_seq>=1) is true`)]);
export const meetingAttendances=pgTable('meeting_attendances',{
 id:uuid('id').primaryKey(),workspaceId:uuid('workspace_id').notNull(),projectId:uuid('project_id').notNull(),meetingId:uuid('meeting_id').notNull(),taskId:uuid('task_id').notNull(),membershipId:uuid('membership_id').notNull(),revision:integer('revision').notNull(),document:jsonb('document').$type<AttendanceDto>().notNull(),
},t=>[unique('meeting_attendances_workspace_id_unique').on(t.workspaceId,t.id),unique('meeting_attendances_member_unique').on(t.workspaceId,t.meetingId,t.membershipId),unique('meeting_attendances_source_unique').on(t.workspaceId,t.meetingId,t.taskId,t.membershipId,t.id),
 foreignKey({name:'meeting_attendances_meeting_fk',columns:[t.workspaceId,t.projectId,t.meetingId],foreignColumns:[meetings.workspaceId,meetings.projectId,meetings.id]}),foreignKey({name:'meeting_attendances_task_fk',columns:[t.workspaceId,t.projectId,t.taskId],foreignColumns:[tasks.workspaceId,tasks.projectId,tasks.id]}),foreignKey({name:'meeting_attendances_member_fk',columns:[t.workspaceId,t.membershipId],foreignColumns:[memberships.workspaceId,memberships.id]}),
 check('meeting_attendances_document_identity',sql`(document ?& array['id','workspaceId','meetingId','taskId','membershipId','revision','rosterActive','status','postingState'] and document->>'id'=id::text and document->>'workspaceId'=workspace_id::text and document->>'meetingId'=meeting_id::text and document->>'taskId'=task_id::text and document->>'membershipId'=membership_id::text and (document->>'revision')::integer=revision and revision>=1 and jsonb_typeof(document->'rosterActive')='boolean' and document->>'status' in ('unknown','present','partial','absent') and document->>'postingState' in ('unconfirmed','active','void')) is true`),
]);
export const meetingAttendanceRevisions=pgTable('meeting_attendance_revisions',{
 id:uuid('id').primaryKey(),workspaceId:uuid('workspace_id').notNull(),attendanceId:uuid('attendance_id').notNull(),revision:integer('revision').notNull(),document:jsonb('document').$type<AttendanceHistoryDto>().notNull(),
},t=>[unique('meeting_attendance_revisions_source_unique').on(t.workspaceId,t.attendanceId,t.revision),foreignKey({name:'meeting_attendance_revisions_attendance_fk',columns:[t.workspaceId,t.attendanceId],foreignColumns:[meetingAttendances.workspaceId,meetingAttendances.id]}),check('meeting_attendance_revisions_document_identity',sql`(document->>'id'=id::text and document->>'attendanceId'=attendance_id::text and (document->>'revision')::integer=revision and revision>=1) is true`)]);
export const meetingScheduleLocks=pgTable('meeting_schedule_locks',{
 id:uuid('id').primaryKey(),workspaceId:uuid('workspace_id').notNull(),meetingId:uuid('meeting_id').notNull(),baselineId:uuid('baseline_id').notNull(),
},t=>[unique('meeting_schedule_locks_baseline_unique').on(t.workspaceId,t.meetingId,t.baselineId),foreignKey({name:'meeting_schedule_locks_meeting_fk',columns:[t.workspaceId,t.meetingId],foreignColumns:[meetings.workspaceId,meetings.id]}),foreignKey({name:'meeting_schedule_locks_baseline_fk',columns:[t.workspaceId,t.baselineId],foreignColumns:[planBaselines.workspaceId,planBaselines.id]})]);
export const workLogs = pgTable('work_logs',{
  id:uuid('id').primaryKey(),workspaceId:uuid('workspace_id').notNull(),projectId:uuid('project_id').notNull(),taskId:uuid('task_id').notNull(),workPackageId:uuid('work_package_id').notNull(),
  membershipId:uuid('membership_id').notNull(),periodId:uuid('period_id').notNull(),sourceKind:text('source_kind').notNull().default('manual_period'),sourceKey:text('source_key').notNull(),
  revision:integer('revision').notNull(),revisionId:uuid('revision_id').notNull(),meetingId:uuid('meeting_id'),attendanceId:uuid('attendance_id'),
},t=>[
  unique('work_logs_project_id_unique').on(t.workspaceId,t.id,t.projectId),
  unique('work_logs_workspace_id_unique').on(t.workspaceId,t.id),uniqueIndex('work_logs_manual_source_unique').on(t.workspaceId,t.taskId,t.membershipId,t.periodId).where(sql`source_kind = 'manual_period'`),
  unique('work_logs_source_key_unique').on(t.workspaceId,t.sourceKind,t.sourceKey),
  foreignKey({name:'work_logs_task_fk',columns:[t.workspaceId,t.projectId,t.taskId],foreignColumns:[tasks.workspaceId,tasks.projectId,tasks.id]}),
  foreignKey({name:'work_logs_package_fk',columns:[t.workspaceId,t.projectId,t.workPackageId],foreignColumns:[workPackages.workspaceId,workPackages.projectId,workPackages.id]}),
  foreignKey({name:'work_logs_period_fk',columns:[t.workspaceId,t.projectId,t.periodId],foreignColumns:[planningPeriods.workspaceId,planningPeriods.projectId,planningPeriods.id]}),
  foreignKey({name:'work_logs_member_fk',columns:[t.workspaceId,t.membershipId],foreignColumns:[memberships.workspaceId,memberships.id]}),
  foreignKey({name:'work_logs_meeting_fk',columns:[t.workspaceId,t.meetingId,t.taskId,t.periodId],foreignColumns:[meetings.workspaceId,meetings.id,meetings.taskId,meetings.plannedPeriodId]}),
  foreignKey({name:'work_logs_attendance_fk',columns:[t.workspaceId,t.meetingId,t.taskId,t.membershipId,t.attendanceId],foreignColumns:[meetingAttendances.workspaceId,meetingAttendances.meetingId,meetingAttendances.taskId,meetingAttendances.membershipId,meetingAttendances.id]}),
  check('work_logs_source_identity',sql`((source_kind = 'manual_period' and meeting_id is null and attendance_id is null and source_key = task_id::text || ':' || membership_id::text || ':' || period_id::text) or (source_kind='meeting_attendance' and meeting_id is not null and attendance_id is not null and source_key=attendance_id::text)) is true`),
  check('work_logs_revision',sql`revision >= 1`),
]);
export const workLogRevisions = pgTable('work_log_revisions',{
  id:uuid('id').primaryKey(),workspaceId:uuid('workspace_id').notNull(),workLogId:uuid('work_log_id').notNull(),revision:integer('revision').notNull(),
  minutes:integer('minutes').notNull(),state:workLogStateEnum('state').notNull(),reason:text('reason'),actorUserId:uuid('actor_user_id').notNull(),
  recordedAt:timestamp('recorded_at',{withTimezone:true}).notNull(),changeSeq:bigint('change_seq',{mode:'bigint'}).notNull(),
  meetingId:uuid('meeting_id'),attendanceId:uuid('attendance_id'),confirmedMeetingRevision:integer('confirmed_meeting_revision'),attribution:jsonb('attribution').$type<AttendanceAttribution>(),
  category:jsonb('category').$type<WorkCategorySnapshot>(),categoryProjectId:uuid('category_project_id'),categoryBindingVersionId:uuid('category_binding_version_id'),categoryBindingRevision:integer('category_binding_revision'),categoryFieldId:uuid('category_field_id'),categoryDefinitionVersionId:uuid('category_definition_version_id'),categoryOptionId:uuid('category_option_id'),categoryOptionRevision:integer('category_option_revision'),
},t=>[
  unique('work_log_revisions_workspace_id_unique').on(t.workspaceId,t.id),unique('work_log_revisions_source_unique').on(t.workspaceId,t.workLogId,t.revision),
  foreignKey({name:'work_log_revisions_log_fk',columns:[t.workspaceId,t.workLogId],foreignColumns:[workLogs.workspaceId,workLogs.id]}),
  foreignKey({name:'work_log_revisions_actor_fk',columns:[t.actorUserId],foreignColumns:[users.id]}),
  foreignKey({name:'work_log_revisions_category_source_project_fk',columns:[t.workspaceId,t.workLogId,t.categoryProjectId],foreignColumns:[workLogs.workspaceId,workLogs.id,workLogs.projectId]}),
  foreignKey({name:'work_log_revisions_category_binding_fk',columns:[t.workspaceId,t.categoryProjectId,t.categoryBindingVersionId],foreignColumns:[projectWorkCategoryBindingVersions.workspaceId,projectWorkCategoryBindingVersions.projectId,projectWorkCategoryBindingVersions.id]}),
  foreignKey({name:'work_log_revisions_category_field_fk',columns:[t.workspaceId,t.categoryProjectId,t.categoryFieldId],foreignColumns:[taskFieldDefinitions.workspaceId,taskFieldDefinitions.projectId,taskFieldDefinitions.id]}),
  foreignKey({name:'work_log_revisions_category_definition_fk',columns:[t.workspaceId,t.categoryProjectId,t.categoryFieldId,t.categoryDefinitionVersionId],foreignColumns:[taskFieldDefinitionVersions.workspaceId,taskFieldDefinitionVersions.projectId,taskFieldDefinitionVersions.fieldId,taskFieldDefinitionVersions.id]}),
  foreignKey({name:'work_log_revisions_category_option_fk',columns:[t.workspaceId,t.categoryProjectId,t.categoryFieldId,t.categoryOptionId],foreignColumns:[taskFieldOptions.workspaceId,taskFieldOptions.projectId,taskFieldOptions.fieldId,taskFieldOptions.id]}),
  check('work_log_revisions_category_snapshot',sql`(
    (category is null and category_project_id is null and category_binding_version_id is null and category_binding_revision is null and category_field_id is null and category_definition_version_id is null and category_option_id is null and category_option_revision is null)
    or (category is not null and category_project_id is not null and (category_binding_revision is null or category_binding_revision >= 1) and jsonb_typeof(category) = 'object' and (
      (category->>'kind' = 'categorized' and category ?& array['bindingVersionId','bindingRevision','fieldId','fieldDefinitionVersionId','fieldLabel','optionId','optionRevision','optionLabel','color','optionArchivedAt']
       and category_binding_version_id is not null and category_binding_revision >= 2 and category_field_id is not null and category_definition_version_id is not null and category_option_id is not null and category_option_revision >= 1
       and category->>'bindingVersionId' = category_binding_version_id::text and category->>'bindingRevision' = category_binding_revision::text and category->>'fieldId' = category_field_id::text and category->>'fieldDefinitionVersionId' = category_definition_version_id::text and category->>'optionId' = category_option_id::text and category->>'optionRevision' = category_option_revision::text
       and jsonb_typeof(category->'fieldLabel') = 'string' and jsonb_typeof(category->'optionLabel') = 'string')
      or (category->>'kind' = 'uncategorized' and category ?& array['reason','bindingVersionId','bindingRevision','fieldId'] and category->>'reason' in ('legacy','unbound','field_unavailable','unset','explicit_clear')
       and (category->>'bindingVersionId') is not distinct from category_binding_version_id::text and (category->>'bindingRevision') is not distinct from category_binding_revision::text and (category->>'fieldId') is not distinct from category_field_id::text
       and category_definition_version_id is null and category_option_id is null and category_option_revision is null)
    ))) is true`),
  foreignKey({name:'work_log_revisions_meeting_version_fk',columns:[t.workspaceId,t.meetingId,t.confirmedMeetingRevision],foreignColumns:[meetingRevisions.workspaceId,meetingRevisions.meetingId,meetingRevisions.revision]}),
  check('work_log_revisions_occurrence_shape',sql`((meeting_id is null and attendance_id is null and confirmed_meeting_revision is null and attribution is null) or (meeting_id is not null and attendance_id is not null and confirmed_meeting_revision>=1 and attribution ?& array['basis','plannedStartAt','actualStartAt'] and jsonb_typeof(attribution->'plannedStartAt')='string' and ((attribution->>'basis'='actual_meeting' and jsonb_typeof(attribution->'actualStartAt')='string') or (attribution->>'basis'='planned_absence' and attribution->'actualStartAt'='null'::jsonb and minutes=0)))) is true`),
  check('work_log_revisions_values',sql`minutes >= 0 and revision >= 1 and change_seq >= 1`),
  check('work_log_revisions_reason',sql`((revision = 1 and state = 'active') or char_length(btrim(reason)) between 1 and 1000) is true`),
]);
export const weeklyReportRuns = pgTable('weekly_report_runs',{
  id:uuid('id').primaryKey(),workspaceId:uuid('workspace_id').notNull(),projectId:uuid('project_id').notNull(),periodId:uuid('period_id').notNull(),baselineId:uuid('baseline_id').notNull(),
  document:jsonb('document').$type<WeeklyPlanFactReportRunDto>().notNull(),rows:jsonb('rows').$type<WeeklyPlanFactRowDto[]>().notNull(),createdAt:timestamp('created_at',{withTimezone:true}).notNull(),
},t=>[
  unique('weekly_report_runs_workspace_id_unique').on(t.workspaceId,t.id),
  foreignKey({name:'weekly_report_runs_period_fk',columns:[t.workspaceId,t.projectId,t.periodId],foreignColumns:[planningPeriods.workspaceId,planningPeriods.projectId,planningPeriods.id]}),
  foreignKey({name:'weekly_report_runs_baseline_fk',columns:[t.workspaceId,t.projectId,t.baselineId],foreignColumns:[planBaselines.workspaceId,planBaselines.projectId,planBaselines.id]}),
  check('weekly_report_runs_document_identity',sql`(jsonb_typeof(document) = 'object' and document->>'id' = id::text and document->>'workspaceId' = workspace_id::text and document->>'projectId' = project_id::text and document->>'periodId' = period_id::text and document->>'baselineId' = baseline_id::text and document->>'metricVersion' = 'weekly_plan_fact_v1' and jsonb_typeof(rows) = 'array' and jsonb_array_length(rows) = (document->>'rowCount')::integer) is true`),
]);

/** First related freeze is recorded even if the estimate was unknown and not protected. */
export const packageFreezeObservations = pgTable('package_freeze_observations',{
  workspaceId:uuid('workspace_id').notNull(),projectId:uuid('project_id').notNull(),workPackageId:uuid('work_package_id').notNull(),
  estimateMinutes:integer('estimate_minutes'),packageRevision:integer('package_revision').notNull(),baselineId:uuid('baseline_id').notNull(),
},t=>[
  primaryKey({name:'package_freeze_observations_pk',columns:[t.workspaceId,t.workPackageId]}),
  foreignKey({name:'package_freeze_observations_package_fk',columns:[t.workspaceId,t.projectId,t.workPackageId],foreignColumns:[workPackages.workspaceId,workPackages.projectId,workPackages.id]}),
  foreignKey({name:'package_freeze_observations_baseline_fk',columns:[t.workspaceId,t.projectId,t.baselineId],foreignColumns:[planBaselines.workspaceId,planBaselines.projectId,planBaselines.id]}),
  check('package_freeze_observations_values',sql`(estimate_minutes is null or estimate_minutes >= 0) and package_revision >= 1`),
]);


// P2b: project-owned taxonomy binding and independent pinned work-type reports.
export const projectWorkCategoryBindings=pgTable('project_work_category_bindings',{
 workspaceId:uuid('workspace_id').notNull(),projectId:uuid('project_id').notNull(),revision:integer('revision').notNull(),versionId:uuid('version_id').notNull(),fieldId:uuid('field_id'),
},t=>[
 primaryKey({name:'project_work_category_bindings_pk',columns:[t.workspaceId,t.projectId]}),
 foreignKey({name:'project_work_category_bindings_version_fk',columns:[t.workspaceId,t.projectId,t.versionId,t.revision],foreignColumns:[projectWorkCategoryBindingVersions.workspaceId,projectWorkCategoryBindingVersions.projectId,projectWorkCategoryBindingVersions.id,projectWorkCategoryBindingVersions.revision]}),
 foreignKey({name:'project_work_category_bindings_project_fk',columns:[t.workspaceId,t.projectId],foreignColumns:[projects.workspaceId,projects.id]}),
 foreignKey({name:'project_work_category_bindings_field_fk',columns:[t.workspaceId,t.projectId,t.fieldId],foreignColumns:[taskFieldDefinitions.workspaceId,taskFieldDefinitions.projectId,taskFieldDefinitions.id]}),
 check('project_work_category_bindings_revision',sql`revision >= 2`),
]);
export const projectWorkCategoryBindingVersions=pgTable('project_work_category_binding_versions',{
 id:uuid('id').primaryKey(),workspaceId:uuid('workspace_id').notNull(),projectId:uuid('project_id').notNull(),revision:integer('revision').notNull(),fieldId:uuid('field_id'),
 actorUserId:uuid('actor_user_id').notNull(),recordedAt:timestamp('recorded_at',{withTimezone:true}).notNull(),changeSeq:bigint('change_seq',{mode:'bigint'}).notNull(),
},t=>[
 unique('project_work_category_binding_versions_scope_unique').on(t.workspaceId,t.projectId,t.id),
 unique('project_work_category_binding_versions_head_unique').on(t.workspaceId,t.projectId,t.id,t.revision),
 unique('project_work_category_binding_versions_revision_unique').on(t.workspaceId,t.projectId,t.revision),
 foreignKey({name:'project_work_category_binding_versions_project_fk',columns:[t.workspaceId,t.projectId],foreignColumns:[projects.workspaceId,projects.id]}),
 foreignKey({name:'project_work_category_binding_versions_field_fk',columns:[t.workspaceId,t.projectId,t.fieldId],foreignColumns:[taskFieldDefinitions.workspaceId,taskFieldDefinitions.projectId,taskFieldDefinitions.id]}),
 foreignKey({name:'project_work_category_binding_versions_actor_fk',columns:[t.actorUserId],foreignColumns:[users.id]}),
 check('project_work_category_binding_versions_values',sql`revision >= 2 and change_seq >= 1`),
]);
export const workTypeReportRuns=pgTable('work_type_report_runs',{
 id:uuid('id').primaryKey(),workspaceId:uuid('workspace_id').notNull(),projectId:uuid('project_id').notNull(),periodId:uuid('period_id').notNull(),
 document:jsonb('document').$type<WorkTypeReportRunDto>().notNull(),rows:jsonb('rows').$type<WorkTypeReportRowDto[]>().notNull(),createdAt:timestamp('created_at',{withTimezone:true}).notNull(),
},t=>[
 unique('work_type_report_runs_workspace_id_unique').on(t.workspaceId,t.id),
 foreignKey({name:'work_type_report_runs_period_fk',columns:[t.workspaceId,t.projectId,t.periodId],foreignColumns:[planningPeriods.workspaceId,planningPeriods.projectId,planningPeriods.id]}),
 check('work_type_report_runs_document_identity',sql`(jsonb_typeof(document) = 'object' and document->>'id' = id::text and document->>'workspaceId' = workspace_id::text and document->>'projectId' = project_id::text and document->>'periodId' = period_id::text and document->>'metricVersion' = 'weekly_work_type_v1' and jsonb_typeof(rows) = 'array' and jsonb_array_length(rows) = (document->>'rowCount')::integer and jsonb_typeof(document->'workLogRevisionIds') = 'array' and jsonb_array_length(document->'workLogRevisionIds') = jsonb_array_length(rows)) is true`),
]);


// P3b: finite recurring meeting series, explicit period bindings, stable reserved instance headers,
// immutable versions/exceptions/grants and calendar-only freeze locks (docs/16-p3b-contract.md).
// Circular head references live only in SQL as DEFERRABLE INITIALLY DEFERRED FKs (series → current
// version, series → current authorization, instance → exception head), as for task_field_definitions.
// Immutability, attach-once, head/version and meeting/task/package consistency guards are SQL triggers.
export const recurrenceSeriesStateEnum=pgEnum('recurrence_series_state',['active','paused']);
export const recurrenceCalendarStateEnum=pgEnum('recurrence_calendar_state',['scheduled','cancelled']);
export const recurrenceExceptionKindEnum=pgEnum('recurrence_exception_kind',['skip','move','restore','reset']);

/** Mutable series head. Pause stops only background generation; it never removes registered census. */
export const recurrenceSeries=pgTable('recurrence_series',{
 id:uuid('id').primaryKey(),workspaceId:uuid('workspace_id').notNull(),projectId:uuid('project_id').notNull(),
 revision:integer('revision').notNull(),state:recurrenceSeriesStateEnum('state').notNull(),currentVersionId:uuid('current_version_id').notNull(),
 authorizationId:uuid('authorization_id'),authorizationRevision:integer('authorization_revision'),
 createdAt:timestamp('created_at',{withTimezone:true}).notNull(),updatedAt:timestamp('updated_at',{withTimezone:true}).notNull(),
},t=>[
 unique('recurrence_series_workspace_id_unique').on(t.workspaceId,t.id),
 unique('recurrence_series_scope_id_unique').on(t.workspaceId,t.projectId,t.id),
 foreignKey({name:'recurrence_series_project_fk',columns:[t.workspaceId,t.projectId],foreignColumns:[projects.workspaceId,projects.id]}),
 index('recurrence_series_project_idx').on(t.workspaceId,t.projectId,t.state,t.id),
 check('recurrence_series_revision',sql`revision >= 1`),
 check('recurrence_series_authorization_pair',sql`((authorization_id is null and authorization_revision is null) or (authorization_id is not null and authorization_revision >= 1)) is true`),
]);

/** Immutable "this and future" versions with a pinned policy. Several versions may share an effective
 * boundary: for each nominal date the highest revision with effective_from <= date wins, so a later write
 * supersedes even older future segments. */
export const recurrenceSeriesVersions=pgTable('recurrence_series_versions',{
 id:uuid('id').primaryKey(),workspaceId:uuid('workspace_id').notNull(),projectId:uuid('project_id').notNull(),seriesId:uuid('series_id').notNull(),
 revision:integer('revision').notNull(),effectiveFromNominalDate:date('effective_from_nominal_date',{mode:'string'}).notNull(),
 schedule:jsonb('schedule').$type<RecurrenceScheduleInput>().notNull(),template:jsonb('template').$type<RecurrenceTemplateInput>().notNull(),
 policyVersion:text('policy_version').notNull(),
 actorUserId:uuid('actor_user_id').notNull(),source:commandSourceEnum('source').notNull(),
 createdAt:timestamp('created_at',{withTimezone:true}).notNull(),changeSeq:bigint('change_seq',{mode:'bigint'}).notNull(),
},t=>[
 unique('recurrence_series_versions_workspace_id_unique').on(t.workspaceId,t.id),
 unique('recurrence_series_versions_head_unique').on(t.workspaceId,t.projectId,t.seriesId,t.id),
 unique('recurrence_series_versions_revision_unique').on(t.workspaceId,t.seriesId,t.revision),
 index('recurrence_series_versions_effective_idx').on(t.workspaceId,t.seriesId,t.effectiveFromNominalDate,t.revision),
 foreignKey({name:'recurrence_series_versions_series_fk',columns:[t.workspaceId,t.projectId,t.seriesId],foreignColumns:[recurrenceSeries.workspaceId,recurrenceSeries.projectId,recurrenceSeries.id]}),
 foreignKey({name:'recurrence_series_versions_actor_fk',columns:[t.actorUserId],foreignColumns:[users.id]}),
 check('recurrence_series_versions_values',sql`revision >= 1 and change_seq >= 1 and policy_version = 'first_valid_gap_earlier_overlap_v1' and effective_from_nominal_date between '2000-01-01' and '2100-12-31'`),
 check('recurrence_series_versions_schedule_shape',sql`(case when jsonb_typeof(schedule) = 'object' then
    schedule ?& array['startDate','localTime','timezone','frequency','plannedDurationMinutes','end']
    and schedule - array['startDate','localTime','timezone','frequency','weekdays','plannedDurationMinutes','end'] = '{}'::jsonb
    and jsonb_typeof(schedule->'startDate') = 'string' and schedule->>'startDate' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' and schedule->>'startDate' between '2000-01-01' and '2100-12-31'
    and jsonb_typeof(schedule->'localTime') = 'string' and schedule->>'localTime' ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
    and jsonb_typeof(schedule->'timezone') = 'string' and char_length(schedule->>'timezone') between 1 and 100
    and case when jsonb_typeof(schedule->'plannedDurationMinutes') = 'number' then (schedule->'plannedDurationMinutes')::numeric between 1 and 1440 and (schedule->'plannedDurationMinutes')::numeric = trunc((schedule->'plannedDurationMinutes')::numeric) else false end
    and case
      when schedule->>'frequency' = 'daily' then not schedule ? 'weekdays'
      when schedule->>'frequency' = 'weekly' then case when jsonb_typeof(schedule->'weekdays') = 'array' then jsonb_array_length(schedule->'weekdays') between 1 and 7 and not jsonb_path_exists(schedule->'weekdays', '$[*] ? (@.type() != "number" || @ < 1 || @ > 7 || @.floor() != @)') else false end
      else false end
    and case when jsonb_typeof(schedule->'end') = 'object' then case
      when schedule#>>'{end,kind}' = 'on_date' then (schedule->'end') - 'kind' - 'endDate' = '{}'::jsonb and jsonb_typeof(schedule#>'{end,endDate}') = 'string' and schedule#>>'{end,endDate}' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' and schedule#>>'{end,endDate}' between schedule->>'startDate' and '2100-12-31'
      when schedule#>>'{end,kind}' = 'after_count' then (schedule->'end') - 'kind' - 'count' = '{}'::jsonb and case when jsonb_typeof(schedule#>'{end,count}') = 'number' then (schedule#>'{end,count}')::numeric between 1 and 366 and (schedule#>'{end,count}')::numeric = trunc((schedule#>'{end,count}')::numeric) else false end
      else false end else false end
  else false end) is true`),
 check('recurrence_series_versions_template_shape',sql`(case when jsonb_typeof(template) = 'object' then
    template ?& array['title','statusId','organizerMembershipId','attendeeMembershipIds']
    and template - array['title','statusId','sectionId','organizerMembershipId','attendeeMembershipIds','joinUrl'] = '{}'::jsonb
    and jsonb_typeof(template->'title') = 'string' and char_length(btrim(template->>'title')) between 1 and 500
    and jsonb_typeof(template->'statusId') = 'string' and template->>'statusId' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    and jsonb_typeof(template->'organizerMembershipId') = 'string' and template->>'organizerMembershipId' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    and (not template ? 'sectionId' or jsonb_typeof(template->'sectionId') = 'null' or (jsonb_typeof(template->'sectionId') = 'string' and template->>'sectionId' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'))
    and case when jsonb_typeof(template->'attendeeMembershipIds') = 'array' then jsonb_array_length(template->'attendeeMembershipIds') between 1 and 100 and not jsonb_path_exists(template->'attendeeMembershipIds', '$[*] ? (@.type() != "string" || !(@ like_regex "^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$"))') else false end
    and (not template ? 'joinUrl' or jsonb_typeof(template->'joinUrl') = 'null' or (jsonb_typeof(template->'joinUrl') = 'string' and char_length(template->>'joinUrl') <= 2048 and template->>'joinUrl' ~* '^https?://'))
  else false end) is true`),
]);

/** Immutable explicit generation grants; the worker resolves and revalidates the stored authorizer, never a payload actor. */
export const recurrenceGenerationAuthorizations=pgTable('recurrence_generation_authorizations',{
 id:uuid('id').primaryKey(),workspaceId:uuid('workspace_id').notNull(),projectId:uuid('project_id').notNull(),seriesId:uuid('series_id').notNull(),
 revision:integer('revision').notNull(),authorizerUserId:uuid('authorizer_user_id').notNull(),authorizerMembershipId:uuid('authorizer_membership_id').notNull(),
 actorUserId:uuid('actor_user_id').notNull(),source:commandSourceEnum('source').notNull(),
 recordedAt:timestamp('recorded_at',{withTimezone:true}).notNull(),changeSeq:bigint('change_seq',{mode:'bigint'}).notNull(),
},t=>[
 unique('recurrence_generation_authorizations_workspace_id_unique').on(t.workspaceId,t.id),
 unique('recurrence_generation_authorizations_head_unique').on(t.workspaceId,t.seriesId,t.id,t.revision),
 unique('recurrence_generation_authorizations_revision_unique').on(t.workspaceId,t.seriesId,t.revision),
 foreignKey({name:'recurrence_generation_authorizations_series_fk',columns:[t.workspaceId,t.projectId,t.seriesId],foreignColumns:[recurrenceSeries.workspaceId,recurrenceSeries.projectId,recurrenceSeries.id]}),
 foreignKey({name:'recurrence_generation_authorizations_membership_fk',columns:[t.workspaceId,t.authorizerMembershipId],foreignColumns:[memberships.workspaceId,memberships.id]}),
 foreignKey({name:'recurrence_generation_authorizations_authorizer_fk',columns:[t.workspaceId,t.authorizerUserId],foreignColumns:[memberships.workspaceId,memberships.userId]}),
 foreignKey({name:'recurrence_generation_authorizations_actor_fk',columns:[t.actorUserId],foreignColumns:[users.id]}),
 check('recurrence_generation_authorizations_values',sql`revision >= 1 and change_seq >= 1`),
]);

/** Explicit finite period association; series/period and candidate ownership are immutable once bound. */
export const recurrencePeriodBindings=pgTable('recurrence_period_bindings',{
 id:uuid('id').primaryKey(),workspaceId:uuid('workspace_id').notNull(),projectId:uuid('project_id').notNull(),
 seriesId:uuid('series_id').notNull(),periodId:uuid('period_id').notNull(),revision:integer('revision').notNull(),
 sourceManifestHash:text('source_manifest_hash').notNull(),createdAt:timestamp('created_at',{withTimezone:true}).notNull(),
},t=>[
 unique('recurrence_period_bindings_workspace_id_unique').on(t.workspaceId,t.id),
 unique('recurrence_period_bindings_series_period_unique').on(t.workspaceId,t.seriesId,t.periodId),
 unique('recurrence_period_bindings_source_unique').on(t.workspaceId,t.projectId,t.seriesId,t.id,t.periodId),
 foreignKey({name:'recurrence_period_bindings_series_fk',columns:[t.workspaceId,t.projectId,t.seriesId],foreignColumns:[recurrenceSeries.workspaceId,recurrenceSeries.projectId,recurrenceSeries.id]}),
 foreignKey({name:'recurrence_period_bindings_period_fk',columns:[t.workspaceId,t.projectId,t.periodId],foreignColumns:[planningPeriods.workspaceId,planningPeriods.projectId,planningPeriods.id]}),
 index('recurrence_period_bindings_period_idx').on(t.workspaceId,t.periodId,t.seriesId),
 check('recurrence_period_bindings_revision',sql`revision >= 1`),
 check('recurrence_period_bindings_hash',sql`source_manifest_hash ~ '^[0-9a-f]{64}$'`),
]);

/**
 * Stable reserved header with natural key (workspace, series, original nominal date). The key, sequence,
 * binding and period never change; real meeting/task/package locators are all-or-none and attach once.
 * A never-materialized cancelled header is valid header-only calendar census.
 */
export const recurrenceInstances=pgTable('recurrence_instances',{
 id:uuid('id').primaryKey(),workspaceId:uuid('workspace_id').notNull(),projectId:uuid('project_id').notNull(),
 seriesId:uuid('series_id').notNull(),bindingId:uuid('binding_id').notNull(),periodId:uuid('period_id').notNull(),
 occurrenceKey:date('occurrence_key',{mode:'string'}).notNull(),nominalSequence:integer('nominal_sequence'),
 sourceVersionId:uuid('source_version_id').notNull(),revision:integer('revision').notNull(),
 calendarState:recurrenceCalendarStateEnum('calendar_state').notNull(),resolution:jsonb('resolution').$type<RecurrenceResolutionDto>().notNull(),
 exceptionVersionId:uuid('exception_version_id'),
 meetingId:uuid('meeting_id'),taskId:uuid('task_id'),workPackageId:uuid('work_package_id'),
 createdAt:timestamp('created_at',{withTimezone:true}).notNull(),updatedAt:timestamp('updated_at',{withTimezone:true}).notNull(),
},t=>[
 unique('recurrence_instances_natural_key_unique').on(t.workspaceId,t.seriesId,t.occurrenceKey),
 unique('recurrence_instances_sequence_unique').on(t.workspaceId,t.seriesId,t.nominalSequence),
 unique('recurrence_instances_workspace_id_unique').on(t.workspaceId,t.id),
 unique('recurrence_instances_scope_id_unique').on(t.workspaceId,t.projectId,t.id),
 unique('recurrence_instances_meeting_lock_unique').on(t.workspaceId,t.id,t.meetingId),
 unique('recurrence_instances_meeting_unique').on(t.workspaceId,t.meetingId),
 unique('recurrence_instances_task_unique').on(t.workspaceId,t.taskId),
 unique('recurrence_instances_package_unique').on(t.workspaceId,t.workPackageId),
 foreignKey({name:'recurrence_instances_series_fk',columns:[t.workspaceId,t.projectId,t.seriesId],foreignColumns:[recurrenceSeries.workspaceId,recurrenceSeries.projectId,recurrenceSeries.id]}),
 foreignKey({name:'recurrence_instances_binding_fk',columns:[t.workspaceId,t.projectId,t.seriesId,t.bindingId,t.periodId],foreignColumns:[recurrencePeriodBindings.workspaceId,recurrencePeriodBindings.projectId,recurrencePeriodBindings.seriesId,recurrencePeriodBindings.id,recurrencePeriodBindings.periodId]}),
 foreignKey({name:'recurrence_instances_source_version_fk',columns:[t.workspaceId,t.projectId,t.seriesId,t.sourceVersionId],foreignColumns:[recurrenceSeriesVersions.workspaceId,recurrenceSeriesVersions.projectId,recurrenceSeriesVersions.seriesId,recurrenceSeriesVersions.id]}),
 foreignKey({name:'recurrence_instances_meeting_fk',columns:[t.workspaceId,t.projectId,t.meetingId],foreignColumns:[meetings.workspaceId,meetings.projectId,meetings.id]}),
 foreignKey({name:'recurrence_instances_meeting_source_fk',columns:[t.workspaceId,t.meetingId,t.taskId,t.periodId],foreignColumns:[meetings.workspaceId,meetings.id,meetings.taskId,meetings.plannedPeriodId]}),
 foreignKey({name:'recurrence_instances_task_fk',columns:[t.workspaceId,t.projectId,t.taskId],foreignColumns:[tasks.workspaceId,tasks.projectId,tasks.id]}),
 foreignKey({name:'recurrence_instances_package_fk',columns:[t.workspaceId,t.projectId,t.workPackageId],foreignColumns:[workPackages.workspaceId,workPackages.projectId,workPackages.id]}),
 index('recurrence_instances_binding_idx').on(t.workspaceId,t.bindingId,t.occurrenceKey),
 check('recurrence_instances_values',sql`revision >= 1 and occurrence_key between '2000-01-01' and '2100-12-31' and (nominal_sequence is null or nominal_sequence between 1 and 366)`),
 check('recurrence_instances_locator_all_or_none',sql`((meeting_id is null and task_id is null and work_package_id is null) or (meeting_id is not null and task_id is not null and work_package_id is not null)) is true`),
 check('recurrence_instances_resolution_shape',sql`(case when jsonb_typeof(resolution) = 'object' then
    resolution ?& array['policyVersion','intendedLocalDate','intendedLocalTime','resolvedStartAt','resolvedEndAt','resolvedLocalDate','resolvedLocalTime','resolvedOffset','plannedDurationMinutes','warning','provenance']
    and resolution - array['policyVersion','intendedLocalDate','intendedLocalTime','resolvedStartAt','resolvedEndAt','resolvedLocalDate','resolvedLocalTime','resolvedOffset','plannedDurationMinutes','warning','provenance'] = '{}'::jsonb
    and jsonb_typeof(resolution->'policyVersion') = 'string' and resolution->>'policyVersion' = 'first_valid_gap_earlier_overlap_v1'
    and jsonb_typeof(resolution->'intendedLocalDate') = 'string' and resolution->>'intendedLocalDate' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' and resolution->>'intendedLocalDate' between '2000-01-01' and '2100-12-31'
    and jsonb_typeof(resolution->'resolvedLocalDate') = 'string' and resolution->>'resolvedLocalDate' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' and resolution->>'resolvedLocalDate' between '2000-01-01' and '2100-12-31'
    and jsonb_typeof(resolution->'intendedLocalTime') = 'string' and resolution->>'intendedLocalTime' ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
    and jsonb_typeof(resolution->'resolvedLocalTime') = 'string' and resolution->>'resolvedLocalTime' ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
    and jsonb_typeof(resolution->'resolvedStartAt') = 'string' and resolution->>'resolvedStartAt' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}(:[0-9]{2}([.][0-9]+)?)?Z$'
    and jsonb_typeof(resolution->'resolvedEndAt') = 'string' and resolution->>'resolvedEndAt' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}(:[0-9]{2}([.][0-9]+)?)?Z$'
    and jsonb_typeof(resolution->'resolvedOffset') = 'string' and resolution->>'resolvedOffset' ~ '^[+-]([01][0-9]|2[0-3]):[0-5][0-9]$'
    and case when jsonb_typeof(resolution->'plannedDurationMinutes') = 'number' then (resolution->'plannedDurationMinutes')::numeric between 1 and 1440 and (resolution->'plannedDurationMinutes')::numeric = trunc((resolution->'plannedDurationMinutes')::numeric) else false end
    and (jsonb_typeof(resolution->'warning') = 'null' or (jsonb_typeof(resolution->'warning') = 'string' and resolution->>'warning' in ('ambiguous_earlier','gap_first_valid','skipped_local_date')))
    and case when jsonb_typeof(resolution->'provenance') = 'object' then
      resolution->'provenance' ?& array['timezone','implementation','tzdataVersion','icuVersion']
      and (resolution->'provenance') - array['timezone','implementation','tzdataVersion','icuVersion'] = '{}'::jsonb
      and jsonb_typeof(resolution#>'{provenance,timezone}') = 'string' and char_length(resolution#>>'{provenance,timezone}') between 1 and 100
      and jsonb_typeof(resolution#>'{provenance,implementation}') = 'string' and char_length(resolution#>>'{provenance,implementation}') between 1 and 100
      and (jsonb_typeof(resolution#>'{provenance,tzdataVersion}') = 'null' or (jsonb_typeof(resolution#>'{provenance,tzdataVersion}') = 'string' and char_length(resolution#>>'{provenance,tzdataVersion}') between 1 and 40))
      and (jsonb_typeof(resolution#>'{provenance,icuVersion}') = 'null' or (jsonb_typeof(resolution#>'{provenance,icuVersion}') = 'string' and char_length(resolution#>>'{provenance,icuVersion}') between 1 and 40))
    else false end
  else false end) is true`),
]);

/** Immutable "only this one" exception versions; the current head is instances.exception_version_id. */
export const recurrenceExceptionVersions=pgTable('recurrence_exception_versions',{
 id:uuid('id').primaryKey(),workspaceId:uuid('workspace_id').notNull(),projectId:uuid('project_id').notNull(),instanceId:uuid('instance_id').notNull(),
 revision:integer('revision').notNull(),kind:recurrenceExceptionKindEnum('kind').notNull(),
 localDate:date('local_date',{mode:'string'}),localTime:text('local_time'),reason:text('reason').notNull(),
 actorUserId:uuid('actor_user_id').notNull(),source:commandSourceEnum('source').notNull(),
 recordedAt:timestamp('recorded_at',{withTimezone:true}).notNull(),changeSeq:bigint('change_seq',{mode:'bigint'}).notNull(),
},t=>[
 unique('recurrence_exception_versions_workspace_id_unique').on(t.workspaceId,t.id),
 unique('recurrence_exception_versions_head_unique').on(t.workspaceId,t.instanceId,t.id),
 unique('recurrence_exception_versions_revision_unique').on(t.workspaceId,t.instanceId,t.revision),
 foreignKey({name:'recurrence_exception_versions_instance_fk',columns:[t.workspaceId,t.projectId,t.instanceId],foreignColumns:[recurrenceInstances.workspaceId,recurrenceInstances.projectId,recurrenceInstances.id]}),
 foreignKey({name:'recurrence_exception_versions_actor_fk',columns:[t.actorUserId],foreignColumns:[users.id]}),
 check('recurrence_exception_versions_values',sql`revision >= 1 and change_seq >= 1 and char_length(btrim(reason)) between 1 and 1000`),
 check('recurrence_exception_versions_move_shape',sql`((kind = 'move' and local_date between '2000-01-01' and '2100-12-31' and local_time ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$') or (kind <> 'move' and local_date is null and local_time is null)) is true`),
]);

/** Immutable calendar-only freeze locks: original schedule/roster provenance per instance identity, even when
 * the header was never materialized (meeting null). No commitment, minute cohort or package baseline. */
export const recurrenceCalendarLocks=pgTable('recurrence_calendar_locks',{
 id:uuid('id').primaryKey(),workspaceId:uuid('workspace_id').notNull(),projectId:uuid('project_id').notNull(),
 baselineId:uuid('baseline_id').notNull(),instanceId:uuid('instance_id').notNull(),meetingId:uuid('meeting_id'),
},t=>[
 unique('recurrence_calendar_locks_baseline_instance_unique').on(t.workspaceId,t.baselineId,t.instanceId),
 foreignKey({name:'recurrence_calendar_locks_baseline_fk',columns:[t.workspaceId,t.projectId,t.baselineId],foreignColumns:[planBaselines.workspaceId,planBaselines.projectId,planBaselines.id]}),
 foreignKey({name:'recurrence_calendar_locks_instance_fk',columns:[t.workspaceId,t.projectId,t.instanceId],foreignColumns:[recurrenceInstances.workspaceId,recurrenceInstances.projectId,recurrenceInstances.id]}),
 foreignKey({name:'recurrence_calendar_locks_instance_meeting_fk',columns:[t.workspaceId,t.instanceId,t.meetingId],foreignColumns:[recurrenceInstances.workspaceId,recurrenceInstances.id,recurrenceInstances.meetingId]}),
 foreignKey({name:'recurrence_calendar_locks_meeting_fk',columns:[t.workspaceId,t.projectId,t.meetingId],foreignColumns:[meetings.workspaceId,meetings.projectId,meetings.id]}),
 index('recurrence_calendar_locks_instance_idx').on(t.workspaceId,t.instanceId),
]);

/** P4a current finish-to-start graph; historic baselines deliberately do not join these mutable heads. */
export const taskDependencies=pgTable('task_dependencies',{
 id:uuid('id').primaryKey(),workspaceId:uuid('workspace_id').notNull(),predecessorTaskId:uuid('predecessor_task_id').notNull(),successorTaskId:uuid('successor_task_id').notNull(),
 type:text('type').$type<'finish_to_start'>().notNull(),state:text('state').$type<'active'|'removed'>().notNull(),revision:integer('revision').notNull(),
 createdAt:timestamp('created_at',{withTimezone:true}).notNull(),updatedAt:timestamp('updated_at',{withTimezone:true}).notNull(),
},t=>[
 unique('task_dependencies_workspace_id_unique').on(t.workspaceId,t.id),unique('task_dependencies_identity_unique').on(t.workspaceId,t.predecessorTaskId,t.successorTaskId,t.type),
 foreignKey({name:'task_dependencies_predecessor_fk',columns:[t.workspaceId,t.predecessorTaskId],foreignColumns:[tasks.workspaceId,tasks.id]}),
 foreignKey({name:'task_dependencies_successor_fk',columns:[t.workspaceId,t.successorTaskId],foreignColumns:[tasks.workspaceId,tasks.id]}),
 check('task_dependencies_self_check',sql`${t.predecessorTaskId} <> ${t.successorTaskId}`),check('task_dependencies_type_check',sql`${t.type} = 'finish_to_start'`),check('task_dependencies_state_check',sql`${t.state} in ('active','removed')`),check('task_dependencies_revision_check',sql`${t.revision} >= 1`),
 index('task_dependencies_predecessor_idx').on(t.workspaceId,t.predecessorTaskId,t.state),index('task_dependencies_successor_idx').on(t.workspaceId,t.successorTaskId,t.state),
]);
export const projectDependencyPolicies=pgTable('project_dependency_policies',{
 workspaceId:uuid('workspace_id').notNull(),projectId:uuid('project_id').notNull(),mode:text('mode').$type<'warn'|'enforce'>().notNull(),revision:integer('revision').notNull(),updatedAt:timestamp('updated_at',{withTimezone:true}).notNull(),
},t=>[primaryKey({columns:[t.workspaceId,t.projectId]}),foreignKey({name:'project_dependency_policies_project_fk',columns:[t.workspaceId,t.projectId],foreignColumns:[projects.workspaceId,projects.id]}),check('project_dependency_policies_mode_check',sql`${t.mode} in ('warn','enforce')`),check('project_dependency_policies_revision_check',sql`${t.revision} >= 1`)]);
export const graphLayouts=pgTable('graph_layouts',{
 id:uuid('id').primaryKey(),workspaceId:uuid('workspace_id').notNull(),projectId:uuid('project_id').notNull(),membershipId:uuid('membership_id').notNull(),viewKey:text('view_key').$type<'default'>().notNull(),revision:integer('revision').notNull(),updatedAt:timestamp('updated_at',{withTimezone:true}).notNull(),
},t=>[unique('graph_layouts_workspace_id_unique').on(t.workspaceId,t.id),unique('graph_layouts_identity_unique').on(t.workspaceId,t.projectId,t.membershipId,t.viewKey),foreignKey({name:'graph_layouts_project_fk',columns:[t.workspaceId,t.projectId],foreignColumns:[projects.workspaceId,projects.id]}),foreignKey({name:'graph_layouts_membership_fk',columns:[t.workspaceId,t.membershipId],foreignColumns:[memberships.workspaceId,memberships.id]}),check('graph_layouts_view_check',sql`${t.viewKey} = 'default'`),check('graph_layouts_revision_check',sql`${t.revision} >= 1`)]);
export const graphLayoutPositions=pgTable('graph_layout_positions',{
 workspaceId:uuid('workspace_id').notNull(),layoutId:uuid('layout_id').notNull(),taskId:uuid('task_id').notNull(),x:doublePrecision('x').notNull(),y:doublePrecision('y').notNull(),
},t=>[primaryKey({columns:[t.workspaceId,t.layoutId,t.taskId]}),foreignKey({name:'graph_layout_positions_layout_fk',columns:[t.workspaceId,t.layoutId],foreignColumns:[graphLayouts.workspaceId,graphLayouts.id]}),foreignKey({name:'graph_layout_positions_task_fk',columns:[t.workspaceId,t.taskId],foreignColumns:[tasks.workspaceId,tasks.id]}),check('graph_layout_positions_finite_check',sql`${t.x} between -100000 and 100000 and ${t.y} between -100000 and 100000`)]);
