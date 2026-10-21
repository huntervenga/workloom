// Explicit historical test data only. Current ORM/domain factories require newer columns;
// these helpers deliberately name only columns available before the tested upgrade.
import { createHash, randomUUID } from 'node:crypto';
import type { TaskFieldDefinitionDto } from '@workloom/contracts';
import type { Database } from '../src/client.js';
import { DEMO_MEMBERSHIPS, DEMO_USERS, DEMO_WORKSPACES } from '../src/fixtures.js';

type Sql = Database['sql'];
export interface LegacyActor { readonly userId: string; readonly workspaceId: string; readonly membershipId: string }
export function legacyActor(workspaceId: string, userId: string): LegacyActor {
  const membership = DEMO_MEMBERSHIPS.find(row => row.workspaceId === workspaceId && row.userId === userId);
  if (!membership) throw new Error('Historical synthetic membership required.');
  return { workspaceId, userId, membershipId: membership.id };
}
export async function seedLegacyIdentities(sql: Sql): Promise<void> {
  for (const user of DEMO_USERS) await sql`insert into users(id,display_name,kind) values(${user.id},${user.displayName},${user.kind}) on conflict do nothing`;
  for (const workspace of DEMO_WORKSPACES) await sql`insert into workspaces(id,name,timezone,week_start) values(${workspace.id},${workspace.name},${workspace.timezone},${workspace.weekStart}) on conflict do nothing`;
  for (const member of DEMO_MEMBERSHIPS) await sql`insert into memberships(id,workspace_id,user_id,role) values(${member.id},${member.workspaceId},${member.userId},${member.role}) on conflict do nothing`;
}
async function recordLegacyCommand(sql: Sql, actor: LegacyActor, name: string, entityType: string, id: string, payload: Record<string, unknown>, revision = 1): Promise<void> {
  const [head] = await sql<{ seq: string }[]>`update workspaces set change_seq=change_seq+1 where id=${actor.workspaceId} returning change_seq::text as seq`;
  if (!head) throw new Error('Historical fixture workspace required.');
  await sql`insert into audit_events(workspace_id,change_seq,event_ordinal,actor_user_id,actor_membership_id,source,request_id,entity_type,entity_id,entity_revision,action,diff,recorded_at)
    values(${actor.workspaceId},${head.seq},1,${actor.userId},${actor.membershipId},'web',${randomUUID()},${entityType},${id},${revision},${revision === 1 ? 'created' : 'updated'},${JSON.stringify(payload)}::jsonb,now())`;
  await sql`insert into outbox_events(workspace_id,change_seq,event_ordinal,type,aggregate_type,aggregate_id,aggregate_revision,payload,occurred_at)
    values(${actor.workspaceId},${head.seq},1,${`${entityType}.${revision === 1 ? 'created' : 'updated'}`},${entityType},${id},${revision},${JSON.stringify({ id, ...payload })}::jsonb,now())`;
  await sql`insert into command_idempotency(workspace_id,actor_user_id,command,idempotency_key,payload_hash,result)
    values(${actor.workspaceId},${actor.userId},${name},${randomUUID()},${createHash('sha256').update(JSON.stringify(payload)).digest('hex')},${JSON.stringify({ id })}::jsonb)`;
}
export async function createLegacyProject(sql: Sql, actor: LegacyActor, name: string): Promise<{ id: string; todoStatusId: string }> {
  const id = randomUUID();
  await sql`insert into projects(id,workspace_id,name) values(${id},${actor.workspaceId},${name})`;
  let todoStatusId = '';
  const statuses = [['To do', 'todo'], ['In progress', 'in_progress'], ['Done', 'done'], ['Cancelled', 'cancelled']] as const;
  for (const [position, [label, group]] of statuses.entries()) {
    const statusId = randomUUID();
    if (group === 'todo') todoStatusId = statusId;
    await sql`insert into task_statuses(id,workspace_id,project_id,name,"group",position) values(${statusId},${actor.workspaceId},${id},${label},${group},${position})`;
  }
  await recordLegacyCommand(sql, actor, 'project.create', 'project', id, { name });
  return { id, todoStatusId };
}
export async function createLegacyTask(sql: Sql, actor: LegacyActor, input: { projectId: string; statusId: string; title: string; position?: number }): Promise<{ id: string }> {
  const id = randomUUID(), packageId = randomUUID();
  await sql`insert into work_packages(id,workspace_id,project_id,origin) values(${packageId},${actor.workspaceId},${input.projectId},'new_task')`;
  await sql`insert into tasks(id,workspace_id,project_id,work_package_id,title,status_id,position) values(${id},${actor.workspaceId},${input.projectId},${packageId},${input.title},${input.statusId},${input.position ?? 0})`;
  await recordLegacyCommand(sql, actor, 'task.create', 'task', id, { projectId: input.projectId, title: input.title });
  return { id };
}
export async function createLegacyTextField(sql: Sql, actor: LegacyActor, projectId: string, name: string, archived = false): Promise<{ id: string }> {
  const id = randomUUID(), createdAt = new Date().toISOString();
  const initial: TaskFieldDefinitionDto = { id, workspaceId: actor.workspaceId, projectId, name, type: 'text', revision: 1, definitionVersionId: randomUUID(), historyEnabled: true, locked: false, archivedAt: null, options: [], createdAt, updatedAt: createdAt };
  await sql.begin(async tx => {
    await tx`insert into task_field_definitions(id,workspace_id,project_id,name,type,definition_version_id,history_enabled,locked,created_at,updated_at) values(${id},${actor.workspaceId},${projectId},${name},'text',${initial.definitionVersionId},true,false,${createdAt},${createdAt})`;
    await tx`insert into task_field_definition_versions(id,workspace_id,project_id,field_id,revision,snapshot) values(${initial.definitionVersionId},${actor.workspaceId},${projectId},${id},1,${JSON.stringify(initial)}::jsonb)`;
    await tx`insert into project_column_settings(workspace_id,project_id,revision) values(${actor.workspaceId},${projectId},1) on conflict(workspace_id,project_id) do update set revision=project_column_settings.revision+1`;
    await tx`insert into project_columns(workspace_id,project_id,field_id,width,position) values(${actor.workspaceId},${projectId},${id},160,(select count(*)::int from project_columns where workspace_id=${actor.workspaceId} and project_id=${projectId}))`;
  });
  await recordLegacyCommand(sql, actor, 'field.create', 'task_field', id, { projectId, name, type: 'text' });
  if (archived) {
    const updatedAt = new Date().toISOString(), version = { ...initial, revision: 2, definitionVersionId: randomUUID(), archivedAt: updatedAt, updatedAt };
    await sql.begin(async tx => {
      await tx`update task_field_definitions set revision=2,definition_version_id=${version.definitionVersionId},archived_at=${updatedAt},updated_at=${updatedAt} where id=${id}`;
      await tx`insert into task_field_definition_versions(id,workspace_id,project_id,field_id,revision,snapshot) values(${version.definitionVersionId},${actor.workspaceId},${projectId},${id},2,${JSON.stringify(version)}::jsonb)`;
    });
    await recordLegacyCommand(sql, actor, 'field.update', 'task_field', id, { archived: true }, 2);
  }
  return { id };
}
export interface LegacyTableSnapshot { readonly table: string; readonly columns: readonly string[]; readonly count: number; readonly sha256: string }
/** Capture every old public column; later nullable/default columns are not old-value changes. */
export async function snapshotLegacyRows(sql: Sql, previous?: readonly LegacyTableSnapshot[]): Promise<LegacyTableSnapshot[]> {
  const tables = previous ?? await sql<{ table: string; columns: string[] }[]>`select c.table_name as "table",array_agg(c.column_name::text order by c.ordinal_position) as columns from information_schema.columns c join information_schema.tables t on t.table_schema=c.table_schema and t.table_name=c.table_name where c.table_schema='public' and t.table_type='BASE TABLE' group by c.table_name order by c.table_name`;
  const result: LegacyTableSnapshot[] = [];
  for (const table of tables) {
    if (![table.table, ...table.columns].every(name => /^[a-z_]+$/.test(name))) throw new Error('Unsafe historical fixture identifier.');
    const columns = table.columns.map(name => `"${name}"`).join(',');
    const rows = await sql.unsafe<{ line: string }[]>(`select row_to_json(t)::text as line from (select ${columns} from public."${table.table}") t order by row_to_json(t)::text collate "C"`);
    result.push({ table: table.table, columns: [...table.columns], count: rows.length, sha256: createHash('sha256').update(rows.map(row => row.line).join('\n')).digest('hex') });
  }
  return result;
}
