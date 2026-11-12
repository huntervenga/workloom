import { and, asc, desc, eq, gt, ilike, inArray, isNull, lt, or, sql, type SQL } from 'drizzle-orm';
import { idSchema, sqlCalendarDateSchema, type PublicTaskListQuery, type TaskView } from '@workloom/contracts';
import { DomainError } from '@workloom/domain';
import type { WorkloomExecutor } from '../client.js';
import { memberships, projects, sections, taskParticipants, taskProjectPlacements, taskStatuses, taskTags, tasks, users, workPackages, workspaceTags } from '../schema.js';

type TaskRow = typeof tasks.$inferSelect;

/** Joins the names a caller needs next to the ids, for a bounded batch of tasks of one workspace. */
export async function loadTaskViews(tx: WorkloomExecutor, workspaceId: string, rows: readonly TaskRow[]): Promise<TaskView[]> {
  if (rows.length === 0) return [];
  const taskIds = rows.map(row => row.id);
  const projectIds = [...new Set(rows.map(row => row.projectId))];
  // The other projects each task is shown in (active placements outside its home).
  const linkedRows = await tx.select({ taskId: taskProjectPlacements.taskId, projectId: taskProjectPlacements.projectId, sectionId: taskProjectPlacements.sectionId })
    .from(taskProjectPlacements)
    .where(and(eq(taskProjectPlacements.workspaceId, workspaceId), inArray(taskProjectPlacements.taskId, taskIds), isNull(taskProjectPlacements.archivedAt), sql`${taskProjectPlacements.projectId} <> ${taskProjectPlacements.homeProjectId}`));
  const namedProjectIds = [...new Set([...projectIds, ...linkedRows.map(row => row.projectId)])];
  const [projectRows, sectionRows, statusRows, packageRows, participantRows, tagRows] = await Promise.all([
    tx.select({ id: projects.id, name: projects.name }).from(projects).where(and(eq(projects.workspaceId, workspaceId), inArray(projects.id, namedProjectIds))),
    tx.select({ id: sections.id, name: sections.name }).from(sections).where(and(eq(sections.workspaceId, workspaceId), inArray(sections.projectId, namedProjectIds))),
    tx.select({ id: taskStatuses.id, name: taskStatuses.name, group: taskStatuses.group }).from(taskStatuses).where(and(eq(taskStatuses.workspaceId, workspaceId), inArray(taskStatuses.projectId, projectIds))),
    tx.select({ id: workPackages.id, estimate: workPackages.estimateMinutes }).from(workPackages).where(and(eq(workPackages.workspaceId, workspaceId), inArray(workPackages.id, rows.map(row => row.workPackageId)))),
    tx.select({ taskId: taskParticipants.taskId, membershipId: taskParticipants.membershipId }).from(taskParticipants).where(and(eq(taskParticipants.workspaceId, workspaceId), inArray(taskParticipants.taskId, taskIds), eq(taskParticipants.active, true))),
    tx.select({ taskId: taskTags.taskId, id: workspaceTags.id, name: workspaceTags.name }).from(taskTags).innerJoin(workspaceTags, and(eq(workspaceTags.workspaceId, taskTags.workspaceId), eq(workspaceTags.id, taskTags.tagId))).where(and(eq(taskTags.workspaceId, workspaceId), inArray(taskTags.taskId, taskIds))),
  ]);
  const memberIds = [...new Set([...participantRows.map(row => row.membershipId), ...rows.flatMap(row => row.responsibleMembershipId ? [row.responsibleMembershipId] : [])])];
  const memberRows = memberIds.length === 0 ? [] : await tx.select({ id: memberships.id, name: users.displayName }).from(memberships).innerJoin(users, eq(users.id, memberships.userId)).where(and(eq(memberships.workspaceId, workspaceId), inArray(memberships.id, memberIds)));
  const byId = <T extends { id: string }>(list: readonly T[]) => new Map(list.map(item => [item.id, item]));
  const project = byId(projectRows), section = byId(sectionRows), status = byId(statusRows), pkg = byId(packageRows), member = byId(memberRows);
  const sectionOf = (sectionId: string | null) => sectionId ? { id: sectionId, name: section.get(sectionId)?.name ?? '' } : null;
  const projectName = (projectId: string) => project.get(projectId)?.name ?? '';
  return rows.map(row => {
    const state = status.get(row.statusId);
    const person = (membershipId: string) => ({ membershipId, displayName: member.get(membershipId)?.name ?? 'Unknown member' });
    const linked = linkedRows.filter(item => item.taskId === row.id)
      .map(item => ({ id: item.projectId, name: projectName(item.projectId), home: false, section: sectionOf(item.sectionId) }))
      .sort((a, b) => a.name.localeCompare(b.name) || (a.id < b.id ? -1 : 1));
    return {
      id: row.id, workspaceId: row.workspaceId, title: row.title, description: row.description,
      project: { id: row.projectId, name: projectName(row.projectId) },
      section: sectionOf(row.sectionId),
      projects: [{ id: row.projectId, name: projectName(row.projectId), home: true, section: sectionOf(row.sectionId) }, ...linked],
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
    const parsedId = idSchema.safeParse(i);
    if (!parsedId.success) throw invalid();
    // The position is exactly what this server writes: a real SQL calendar date, or a canonical ISO instant.
    if (v !== null) {
      if (sort === 'due') {
        if (!sqlCalendarDateSchema.safeParse(v).success) throw invalid();
      } else {
        const instant = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(v) ? new Date(v) : null;
        if (instant === null || !Number.isFinite(instant.getTime()) || instant.toISOString() !== v) throw invalid();
      }
    }
    return { s: sort, v, i: parsedId.data };
  } catch { throw invalid(); }
}

const escapeLike = (text: string) => text.replace(/[\\%_]/g, char => `\\${char}`);

export async function listTaskViews(tx: WorkloomExecutor, workspaceId: string, query: PublicTaskListQuery, filter: ResolvedTaskFilter, meId: string): Promise<{ items: TaskView[]; nextCursor: string | null }> {
  const where: SQL[] = [eq(tasks.workspaceId, workspaceId)];
  const uuidList = (ids: readonly string[]) => sql`(${sql.join(ids.map(id => sql`${id}::uuid`), sql`, `)})`;
  if (filter.projectIds || filter.sectionIds) {
    // A project or section filter matches a task at home there, or shown there from its home (an active placement).
    const home: SQL[] = [], linked: SQL[] = [];
    if (filter.projectIds) {
      home.push(filter.projectIds.length ? inArray(tasks.projectId, [...filter.projectIds]) : sql`false`);
      linked.push(filter.projectIds.length ? sql`tpp.project_id in ${uuidList(filter.projectIds)}` : sql`false`);
    }
    if (filter.sectionIds) {
      home.push(filter.sectionIds.length ? inArray(tasks.sectionId, [...filter.sectionIds]) : sql`false`);
      linked.push(filter.sectionIds.length ? sql`tpp.section_id in ${uuidList(filter.sectionIds)}` : sql`false`);
    }
    if (!query.includeArchived) linked.push(sql`not exists (select 1 from ${projects} lp where lp.workspace_id = tpp.workspace_id and lp.id = tpp.project_id and lp.archived_at is not null)`);
    const shown = sql`exists (select 1 from ${taskProjectPlacements} tpp where tpp.workspace_id = ${tasks.workspaceId} and tpp.task_id = ${tasks.id} and tpp.archived_at is null and tpp.project_id <> tpp.home_project_id and ${sql.join(linked, sql` and `)})`;
    where.push(or(and(...home), shown) ?? sql`false`);
  }
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
  // Without a project or section, a template's tasks (standard tasks for future weeks) are not listed.
  if (!filter.projectIds && !filter.sectionIds) where.push(sql`not exists (select 1 from ${projects} pr where pr.workspace_id = ${tasks.workspaceId} and pr.id = ${tasks.projectId} and pr.is_template)`);
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
