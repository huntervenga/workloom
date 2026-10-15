/**
 * Drizzle description of the P0, P1a and P1b schema. The executable source of truth is the
 * reviewed SQL in ../migrations; keep both in sync (drizzle-kit generate must
 * produce no diff). Immutability triggers live only in SQL.
 */
import type { TaskFieldData, TaskFieldDefinitionDto } from '@workloom/contracts';
import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  check,
  date,
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
] as const;
