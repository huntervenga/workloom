// Test-only explicit SQL for populating historical migration prefixes inside owned throwaway
// databases. Current stores read columns that only exist after later migrations, so old-schema
// fixtures must never go through them. Every value is a db.sql parameter; identifiers are literals.
import { createHash, randomUUID } from 'node:crypto';
import type { Database } from '@workloom/db';
import { DEMO_MEMBERSHIPS, DEMO_USERS, DEMO_WORKSPACES } from '@workloom/db/fixtures';

type Sql = Database['sql'];

export interface LegacyActor {
  readonly userId: string;
  readonly workspaceId: string;
  readonly membershipId: string;
}

export const sha256Hex = (value: string): string => createHash('sha256').update(value).digest('hex');

async function insertOwner(sql: Sql, input: { userId: string; kind: 'fixture' | 'real'; displayName: string;
  workspaceId: string; workspaceName: string; timezone: string }): Promise<LegacyActor> {
  const membershipId = randomUUID();
  await sql`insert into users (id, display_name, kind) values (${input.userId}, ${input.displayName}, ${input.kind})`;
  await sql`insert into workspaces (id, name, timezone) values (${input.workspaceId}, ${input.workspaceName}, ${input.timezone})`;
  await sql`insert into memberships (id, workspace_id, user_id, role) values (${membershipId}, ${input.workspaceId}, ${input.userId}, 'owner')`;
  return { userId: input.userId, workspaceId: input.workspaceId, membershipId };
}

/** Advances the workspace head and appends the matching immutable audit event. */
async function recordAudit(sql: Sql, actor: LegacyActor, event: { entityType: string; entityId: string; action: string; diff: Record<string, unknown> }) {
  const [head] = await sql<{ seq: string }[]>`update workspaces set change_seq = change_seq + 1 where id = ${actor.workspaceId} returning change_seq::text as seq`;
  if (!head) throw new Error('Expected the legacy fixture workspace.');
  await sql`insert into audit_events (workspace_id, change_seq, event_ordinal, actor_user_id, actor_membership_id, source,
    request_id, entity_type, entity_id, entity_revision, action, diff, recorded_at)
    values (${actor.workspaceId}, ${head.seq}, 1, ${actor.userId}, ${actor.membershipId}, 'web', ${randomUUID()},
    ${event.entityType}, ${event.entityId}, 1, ${event.action}, ${JSON.stringify(event.diff)}::jsonb, now())`;
}

/** One synthetic domain command: audit event plus its idempotency receipt. */
async function recordCommand(sql: Sql, actor: LegacyActor, command: { name: string; entityType: string; entityId: string; payload: Record<string, unknown> }) {
  await recordAudit(sql, actor, { entityType: command.entityType, entityId: command.entityId, action: 'created', diff: command.payload });
  await sql`insert into command_idempotency (workspace_id, actor_user_id, command, idempotency_key, payload_hash, result)
    values (${actor.workspaceId}, ${actor.userId}, ${command.name}, ${randomUUID()}, ${sha256Hex(JSON.stringify(command.payload))},
    ${JSON.stringify({ id: command.entityId })}::jsonb)`;
}

/** Same canonical synthetic identity rows as seedDemoData, using only historical columns. */
export async function seedLegacyDemoData(sql: Sql): Promise<void> {
  for (const user of DEMO_USERS) await sql`insert into users (id,display_name,kind)
    values (${user.id},${user.displayName},${user.kind}) on conflict do nothing`;
  for (const workspace of DEMO_WORKSPACES) await sql`insert into workspaces (id,name,timezone,week_start)
    values (${workspace.id},${workspace.name},${workspace.timezone},${workspace.weekStart}) on conflict do nothing`;
  for (const membership of DEMO_MEMBERSHIPS) await sql`insert into memberships (id,workspace_id,user_id,role)
    values (${membership.id},${membership.workspaceId},${membership.userId},${membership.role}) on conflict do nothing`;
}

export async function insertLegacyFixtureOwner(sql: Sql, input: { userId: string; workspaceId: string; displayName: string; workspaceName: string }): Promise<LegacyActor> {
  const [existing] = await sql<{ id: string }[]>`select id from memberships
    where workspace_id=${input.workspaceId} and user_id=${input.userId} and role='owner' and state='active'`;
  if (existing) return { userId: input.userId, workspaceId: input.workspaceId, membershipId: existing.id };
  return insertOwner(sql, { ...input, kind: 'fixture', timezone: 'UTC' });
}

/** Requires 0014: a real user with a home workspace, owner membership and shared Auth identity. */
export async function insertLegacyAuthPrincipal(sql: Sql, input: { issuer: string; subject: string; displayName: string;
  workspaceName: string; timezone: string }): Promise<LegacyActor> {
  const actor = await insertOwner(sql, { userId: randomUUID(), kind: 'real', displayName: input.displayName,
    workspaceId: randomUUID(), workspaceName: input.workspaceName, timezone: input.timezone });
  await sql`insert into shared_auth_identities (issuer, subject, user_id, workspace_id, membership_id)
    values (${input.issuer}, ${input.subject}, ${actor.userId}, ${actor.workspaceId}, ${actor.membershipId})`;
  return actor;
}

export async function insertLegacyAuthSession(sql: Sql, input: { sessionHash: string; userId: string; encryptedTokens: string;
  accessExpiresAt: string; expiresAt: string }): Promise<void> {
  await sql`insert into shared_auth_sessions (session_hash, user_id, encrypted_tokens, access_expires_at, expires_at)
    values (${input.sessionHash}, ${input.userId}, ${input.encryptedTokens}, ${input.accessExpiresAt}, ${input.expiresAt})`;
}

export async function insertLegacyLoginAttempt(sql: Sql, input: { stateHash: string; browserHash: string; returnTo: string; expiresAt: string }): Promise<void> {
  await sql`insert into shared_auth_login_attempts (state_hash, browser_hash, return_to, expires_at)
    values (${input.stateHash}, ${input.browserHash}, ${input.returnTo}, ${input.expiresAt})`;
}

/** Requires 0015: an additional owned workspace with its creation audit (head 1) and receipt. */
export async function insertLegacyOptionalWorkspace(sql: Sql, input: { actorUserId: string; name: string; timezone: string;
  idempotencyKey: string }): Promise<LegacyActor> {
  const workspaceId = randomUUID();
  const membershipId = randomUUID();
  await sql`insert into workspaces (id, name, timezone) values (${workspaceId}, ${input.name}, ${input.timezone})`;
  await sql`insert into memberships (id, workspace_id, user_id, role) values (${membershipId}, ${workspaceId}, ${input.actorUserId}, 'owner')`;
  const actor = { userId: input.actorUserId, workspaceId, membershipId };
  await recordAudit(sql, actor, { entityType: 'workspace', entityId: workspaceId, action: 'created', diff: { name: input.name, timezone: input.timezone } });
  await sql`insert into workspace_creation_receipts (actor_user_id, idempotency_key, workspace_id, payload_hash)
    values (${input.actorUserId}, ${input.idempotencyKey}, ${workspaceId}, ${sha256Hex(JSON.stringify({ name: input.name, timezone: input.timezone }))})`;
  return actor;
}

const DEFAULT_STATUSES = [['To do', 'todo'], ['In progress', 'in_progress'], ['Done', 'done'], ['Cancelled', 'cancelled']] as const;

/** A project with the default status ladder, like the domain createProject command. */
export async function createLegacyProject(sql: Sql, actor: LegacyActor, name: string): Promise<{ id: string; todoStatusId: string }> {
  const id = randomUUID();
  await sql`insert into projects (id, workspace_id, name) values (${id}, ${actor.workspaceId}, ${name})`;
  let todoStatusId: string | undefined;
  for (const [position, [statusName, group]] of DEFAULT_STATUSES.entries()) {
    const statusId = randomUUID();
    if (group === 'todo') todoStatusId = statusId;
    await sql`insert into task_statuses (id, workspace_id, project_id, name, "group", position)
      values (${statusId}, ${actor.workspaceId}, ${id}, ${statusName}, ${group}, ${position})`;
  }
  if (!todoStatusId) throw new Error('Expected a default todo status.');
  await recordCommand(sql, actor, { name: 'project.create', entityType: 'project', entityId: id, payload: { name } });
  return { id, todoStatusId };
}

export async function createLegacySection(sql: Sql, actor: LegacyActor, projectId: string, name: string): Promise<{ id: string }> {
  const id = randomUUID();
  await sql`insert into sections (id, workspace_id, project_id, name, position) values (${id}, ${actor.workspaceId}, ${projectId}, ${name}, 0)`;
  await recordCommand(sql, actor, { name: 'section.create', entityType: 'section', entityId: id, payload: { projectId, name } });
  return { id };
}

export async function createLegacyTag(sql: Sql, actor: LegacyActor, name: string): Promise<{ id: string }> {
  const id = randomUUID();
  await sql`insert into workspace_tags (id, workspace_id, name) values (${id}, ${actor.workspaceId}, ${name})`;
  await recordCommand(sql, actor, { name: 'tag.create', entityType: 'tag', entityId: id, payload: { name } });
  return { id };
}

/** A root task gets its own new_task package; a subtask shares its parent's package (estimate stays on the parent's). */
export async function createLegacyTask(sql: Sql, actor: LegacyActor, input: { projectId: string; statusId: string; title: string;
  sectionId?: string; parentTaskId?: string; estimateMinutes?: number; dueDate?: string; tagIds?: readonly string[] }): Promise<{ id: string; workPackageId: string }> {
  const id = randomUUID();
  let workPackageId: string;
  let sectionId = input.sectionId ?? null;
  if (input.parentTaskId) {
    const [parent] = await sql<{ work_package_id: string; section_id: string | null }[]>`select work_package_id,section_id from tasks
      where workspace_id = ${actor.workspaceId} and project_id = ${input.projectId} and id = ${input.parentTaskId}`;
    if (!parent) throw new Error('Expected the legacy parent task.');
    workPackageId = parent.work_package_id;
    sectionId = input.sectionId ?? parent.section_id;
  } else {
    workPackageId = randomUUID();
    await sql`insert into work_packages (id, workspace_id, project_id, origin, estimate_minutes)
      values (${workPackageId}, ${actor.workspaceId}, ${input.projectId}, 'new_task', ${input.estimateMinutes ?? null})`;
  }
  await sql`insert into tasks (id, workspace_id, project_id, section_id, parent_task_id, work_package_id, title, status_id, due_date, position)
    values (${id}, ${actor.workspaceId}, ${input.projectId}, ${sectionId}, ${input.parentTaskId ?? null}, ${workPackageId},
    ${input.title}, ${input.statusId}, ${input.dueDate ?? null},
    (select coalesce(max(position) + 1, 0) from tasks where workspace_id = ${actor.workspaceId} and project_id = ${input.projectId}))`;
  for (const tagId of input.tagIds ?? []) {
    await sql`insert into task_tags (workspace_id, task_id, tag_id) values (${actor.workspaceId}, ${id}, ${tagId})`;
  }
  await recordCommand(sql, actor, { name: 'task.create', entityType: 'task', entityId: id,
    payload: { projectId: input.projectId, title: input.title, parentTaskId: input.parentTaskId ?? null } });
  return { id, workPackageId };
}
