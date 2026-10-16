import { and, asc, eq, exists, gt, isNull, or, sql, type SQL } from 'drizzle-orm';
import type { MyTaskDto } from '@workloom/contracts';
import type { MyTasksReadRepository } from '@workloom/domain';
import type { WorkloomExecutor } from '../client.js';
import { projects, tasks, taskParticipants, taskStatuses } from '../schema.js';
import { createTaskRepository } from '../repositories/task-repository.js';

/** One page query followed by the existing constant-count batch task decoration, in the same TX. */
export function createMyTasksReadRepository(db: WorkloomExecutor): MyTasksReadRepository {
  const taskRepository = createTaskRepository(db);
  return {
    access: taskRepository.access,
    permissionEpoch: taskRepository.permissionEpoch,
    async list(workspaceId, membershipId, filters, after, take) {
      if (!Number.isSafeInteger(take) || take < 1 || take > 201) throw new TypeError('Personal task pages are bounded to 201 read rows.');
      const participant = exists(db.select({ one: sql`1` }).from(taskParticipants).where(and(eq(taskParticipants.workspaceId, workspaceId), eq(taskParticipants.taskId, tasks.id), eq(taskParticipants.membershipId, membershipId), eq(taskParticipants.active, true))));
      const assigned = eq(tasks.responsibleMembershipId, membershipId);
      const conditions: (SQL | undefined)[] = [eq(tasks.workspaceId, workspaceId), filters.relation === 'assigned' ? assigned : filters.relation === 'participating' ? participant : or(assigned, participant)];
      if (filters.completion !== 'all') conditions.push(filters.completion === 'open' ? or(eq(taskStatuses.group, 'todo'), eq(taskStatuses.group, 'in_progress')) : or(eq(taskStatuses.group, 'done'), eq(taskStatuses.group, 'cancelled')));
      if (!filters.includeArchived) conditions.push(isNull(tasks.archivedAt), isNull(projects.archivedAt));
      if (filters.search) {
        const pattern = `%${filters.search.replace(/[\\%_]/g, match => `\\${match}`)}%`;
        conditions.push(or(sql`${tasks.title} ilike ${pattern} escape '\\'`, sql`${tasks.description} ilike ${pattern} escape '\\'`));
      }
      if (after) conditions.push(after.dueDate === null ? and(isNull(tasks.dueDate), gt(tasks.id, after.id)) : or(gt(tasks.dueDate, after.dueDate), isNull(tasks.dueDate), and(eq(tasks.dueDate, after.dueDate), gt(tasks.id, after.id))));
      const rows = await db.select({ id: tasks.id, projectId: projects.id, projectName: projects.name, projectArchivedAt: projects.archivedAt, statusId: taskStatuses.id, statusName: taskStatuses.name, statusGroup: taskStatuses.group })
        .from(tasks)
        .innerJoin(projects, and(eq(projects.workspaceId, tasks.workspaceId), eq(projects.id, tasks.projectId)))
        .innerJoin(taskStatuses, and(eq(taskStatuses.workspaceId, tasks.workspaceId), eq(taskStatuses.projectId, tasks.projectId), eq(taskStatuses.id, tasks.statusId)))
        .where(and(...conditions)).orderBy(sql`${tasks.dueDate} asc nulls last`, asc(tasks.id)).limit(take);
      if (!rows.length) return [];
      const decorated = new Map((await taskRepository.findTasksByIds(workspaceId, rows.map(row => row.id))).map(task => [task.id, task]));
      return rows.map((row): MyTaskDto => {
        const task = decorated.get(row.id);
        if (!task) throw new Error('A task disappeared inside its read-only snapshot.');
        return { task, project: { id: row.projectId, name: row.projectName, archivedAt: row.projectArchivedAt?.toISOString() ?? null }, status: { id: row.statusId, name: row.statusName, group: row.statusGroup } };
      });
    },
  };
}
