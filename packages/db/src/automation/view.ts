import { and, asc, desc, eq, gt, ilike, inArray, isNull, lt, or, sql, type SQL } from 'drizzle-orm';
import type { PublicTaskListQuery, TaskView } from '@workloom/contracts';
import { DomainError } from '@workloom/domain';
import type { WorkloomExecutor } from '../client.js';
import { memberships, projects, sections, taskParticipants, taskStatuses, taskTags, tasks, users, workPackages, workspaceTags } from '../schema.js';

type TaskRow = typeof tasks.$inferSelect;

/** Joins the names a caller needs next to the ids, for a bounded batch of tasks of one workspace. */
export async function loadTaskViews(tx: WorkloomExecutor, workspaceId: string, rows: readonly TaskRow[]): Promise<TaskView[]> {
  if (rows.length === 0) return [];
  const taskIds = rows.map(row => row.id);
  const projectIds = [...new Set(rows.map(row => row.projectId))];
  const [projectRows, sectionRows, statusRows, packageRows, participantRows, tagRows] = await Promise.all([
    tx.select({ id: projects.id, name: projects.name }).from(projects).where(and(eq(projects.workspaceId, workspaceId), inArray(projects.id, projectIds))),
    tx.select({ id: sections.id, name: sections.name }).from(sections).where(and(eq(sections.workspaceId, workspaceId), inArray(sections.projectId, projectIds))),
    tx.select({ id: taskStatuses.id, name: taskStatuses.name, group: taskStatuses.group }).from(taskStatuses).where(and(eq(taskStatuses.workspaceId, workspaceId), inArray(taskStatuses.projectId, projectIds))),
    tx.select({ id: workPackages.id, estimate: workPackages.estimateMinutes }).from(workPackages).where(and(eq(workPackages.workspaceId, workspaceId), inArray(workPackages.id, rows.map(row => row.workPackageId)))),
    tx.select({ taskId: taskParticipants.taskId, membershipId: taskParticipants.membershipId }).from(taskParticipants).where(and(eq(taskParticipants.workspaceId, workspaceId), inArray(taskParticipants.taskId, taskIds), eq(taskParticipants.active, true))),
    tx.select({ taskId: taskTags.taskId, id: workspaceTags.id, name: workspaceTags.name }).from(taskTags).innerJoin(workspaceTags, and(eq(workspaceTags.workspaceId, taskTags.workspaceId), eq(workspaceTags.id, taskTags.tagId))).where(and(eq(taskTags.workspaceId, workspaceId), inArray(taskTags.taskId, taskIds))),
  ]);
  const memberIds = [...new Set([...participantRows.map(row => row.membershipId), ...rows.flatMap(row => row.responsibleMembershipId ? [row.responsibleMembershipId] : [])])];
  const memberRows = memberIds.length === 0 ? [] : await tx.select({ id: memberships.id, name: users.displayName }).from(memberships).innerJoin(users, eq(users.id, memberships.userId)).where(and(eq(memberships.workspaceId, workspaceId), inArray(memberships.id, memberIds)));
  const byId = <T extends { id: string }>(list: readonly T[]) => new Map(list.map(item => [item.id, item]));
  const project = byId(projectRows), section = byId(sectionRows), status = byId(statusRows), pkg = byId(packageRows), member = byId(memberRows);
  return rows.map(row => {
    const state = status.get(row.statusId);
    const person = (membershipId: string) => ({ membershipId, displayName: member.get(membershipId)?.name ?? 'Unknown member' });
    return {
      id: row.id, workspaceId: row.workspaceId, title: row.title, description: row.description,
      project: { id: row.projectId, name: project.get(row.projectId)?.name ?? '' },
      section: row.sectionId ? { id: row.sectionId, name: section.get(row.sectionId)?.name ?? '' } : null,
      status: { id: row.statusId, name: state?.name ?? '', group: state?.group ?? 'todo' },
      assignee: row.responsibleMembershipId ? person(row.responsibleMembershipId) : null,
      participants: participantRows.filter(item => item.taskId === row.id).map(item => person(item.membershipId)),
      priority: row.priority, startDate: row.startDate ?? null, dueDate: row.dueDate ?? null,
      estimateMinutes: pkg.get(row.workPackageId)?.estimate ?? null,
      tags: tagRows.filter(tag => tag.taskId === row.id).map(tag => ({ id: tag.id, name: tag.name })).sort((a, b) => a.name.localeCompare(b.name)),
      parentTaskId: row.parentTaskId, revision: row.revision, archived: row.archivedAt !== null,
      createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString(),
    } satisfies TaskView;
  });
}

export async function loadTaskView(tx: WorkloomExecutor, workspaceId: string, taskId: string): Promise<TaskView | null> {
  const [row] = await tx.select().from(tasks).where(and(eq(tasks.workspaceId, workspaceId), eq(tasks.id, taskId))).limit(1);
  return row ? (await loadTaskViews(tx, workspaceId, [row]))[0] ?? null : null;
}

/** Ids already resolved by the service; empty arrays mean "this filter matches nothing". */
export interface ResolvedTaskFilter {
  readonly projectIds?: readonly string[];
  readonly sectionIds?: readonly string[];
  readonly statusIds?: readonly string[];
  readonly tagIds?: readonly string[];
  /** Membership ids; `unassigned` additionally matches tasks without a responsible person. */
  readonly assigneeIds?: readonly string[];
  readonly unassigned?: boolean;
}

interface Cursor { s: PublicTaskListQuery['sort']; v: string | null; i: string }
const encodeCursor = (cursor: Cursor): string => Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
function decodeCursor(value: string, sort: PublicTaskListQuery['sort']): Cursor {
  const invalid = () => new DomainError('VALIDATION_FAILED', 'The cursor is not valid for this query.');
  try {
    const parsed: unknown = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
    if (typeof parsed !== 'object' || parsed === null) throw invalid();
    const { s, v, i } = parsed as Record<string, unknown>;
    if (s !== sort || typeof i !== 'string' || !(v === null || typeof v === 'string')) throw invalid();
    if (!/^[0-9a-f-]{36}$/i.test(i)) throw invalid();
    if (v !== null && !/^[0-9T:.+\-Z ]{8,40}$/.test(v)) throw invalid();
    return { s: sort, v, i };
  } catch { throw invalid(); }
}

const escapeLike = (text: string) => text.replace(/[\\%_]/g, char => `\\${char}`);

export async function listTaskViews(tx: WorkloomExecutor, workspaceId: string, query: PublicTaskListQuery, filter: ResolvedTaskFilter, meId: string): Promise<{ items: TaskView[]; nextCursor: string | null }> {
  const where: SQL[] = [eq(tasks.workspaceId, workspaceId)];
  if (filter.projectIds) where.push(inArray(tasks.projectId, [...filter.projectIds]));
  if (filter.sectionIds) where.push(inArray(tasks.sectionId, [...filter.sectionIds]));
  if (filter.statusIds) where.push(inArray(tasks.statusId, [...filter.statusIds]));
  if (filter.tagIds) where.push(sql`exists (select 1 from ${taskTags} tt where tt.workspace_id = ${tasks.workspaceId} and tt.task_id = ${tasks.id} and tt.tag_id in ${filter.tagIds.length ? sql`(${sql.join(filter.tagIds.map(id => sql`${id}::uuid`), sql`, `)})` : sql`(null)`})`);
  if (filter.assigneeIds || filter.unassigned) {
    const parts: SQL[] = [];
    if (filter.assigneeIds && filter.assigneeIds.length > 0) {
      const ids = sql.join(filter.assigneeIds.map(id => sql`${id}::uuid`), sql`, `);
      parts.push(sql`${tasks.responsibleMembershipId} in (${ids})`);
      parts.push(sql`exists (select 1 from ${taskParticipants} tp where tp.workspace_id = ${tasks.workspaceId} and tp.task_id = ${tasks.id} and tp.active and tp.membership_id in (${ids}))`);
    }
    if (filter.unassigned) parts.push(isNull(tasks.responsibleMembershipId));
    where.push(or(...parts) ?? sql`false`);
  }
  if (!query.includeArchived) { where.push(isNull(tasks.archivedAt)); where.push(sql`not exists (select 1 from ${projects} pr where pr.workspace_id = ${tasks.workspaceId} and pr.id = ${tasks.projectId} and pr.archived_at is not null)`); }
  if (query.q) where.push(or(ilike(tasks.title, `%${escapeLike(query.q)}%`), ilike(tasks.description, `%${escapeLike(query.q)}%`)) ?? sql`false`);
  if (query.dueBefore) where.push(sql`${tasks.dueDate} <= ${query.dueBefore}::date`);
  if (query.dueAfter) where.push(sql`${tasks.dueDate} >= ${query.dueAfter}::date`);
  const groups = query.statusGroup ?? (query.open ? ['todo', 'in_progress'] : undefined);
  if (groups) where.push(sql`exists (select 1 from ${taskStatuses} ts where ts.workspace_id = ${tasks.workspaceId} and ts.id = ${tasks.statusId} and ts."group" in (${sql.join(groups.map(group => sql`${group}`), sql`, `)}))`);
  void meId;

  const sort = query.sort;
  const cursor = query.cursor ? decodeCursor(query.cursor, sort) : null;
  let order: SQL[];
  if (sort === 'due') {
    order = [sql`${tasks.dueDate} asc nulls last`, asc(tasks.id)];
    if (cursor) where.push(cursor.v === null ? and(isNull(tasks.dueDate), gt(tasks.id, cursor.i)) ?? sql`false` : or(sql`${tasks.dueDate} > ${cursor.v}::date`, isNull(tasks.dueDate), and(sql`${tasks.dueDate} = ${cursor.v}::date`, gt(tasks.id, cursor.i))) ?? sql`false`);
  } else {
    const column = sort === 'created' ? tasks.createdAt : tasks.updatedAt;
    order = [desc(column), desc(tasks.id)];
    if (cursor && cursor.v !== null) where.push(or(lt(column, new Date(cursor.v)), and(eq(column, new Date(cursor.v)), lt(tasks.id, cursor.i))) ?? sql`false`);
  }
  const rows = await tx.select().from(tasks).where(and(...where)).orderBy(...order).limit(query.limit + 1);
  const page = rows.slice(0, query.limit);
  const last = page.at(-1);
  const nextCursor = rows.length > query.limit && last
    ? encodeCursor({ s: sort, v: sort === 'due' ? last.dueDate ?? null : (sort === 'created' ? last.createdAt : last.updatedAt).toISOString(), i: last.id })
    : null;
  return { items: await loadTaskViews(tx, workspaceId, page), nextCursor };
}
