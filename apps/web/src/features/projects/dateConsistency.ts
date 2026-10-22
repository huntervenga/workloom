import type { ProjectDto, TaskDto, TaskStatusDto } from '@workloom/contracts';

export type DateIssueKind = 'missing' | 'before' | 'after';
export interface DateIssue { taskId: string; kind: DateIssueKind }

/**
 * Completed tasks whose due date does not fit the project's dates, so a finished task cannot quietly fall outside the
 * period the project stands for: no due date at all, one before the project starts, or one after it ends. Nothing is
 * checked for a project without dates, and open, cancelled or archived tasks are left alone.
 */
export function completedDateIssues(project: Pick<ProjectDto, 'dateRange'>, tasks: readonly Pick<TaskDto, 'id' | 'dueDate' | 'statusId' | 'archivedAt'>[], statuses: readonly Pick<TaskStatusDto, 'id' | 'group'>[]): DateIssue[] {
  const range = project.dateRange;
  if (!range) return [];
  const done = new Set(statuses.filter(status => status.group === 'done').map(status => status.id.toLowerCase()));
  const issues: DateIssue[] = [];
  for (const task of tasks) {
    if (task.archivedAt !== null || !done.has(task.statusId.toLowerCase())) continue;
    if (task.dueDate === null) issues.push({ taskId: task.id, kind: 'missing' });
    else if (task.dueDate < range.from) issues.push({ taskId: task.id, kind: 'before' });
    else if (task.dueDate > range.to) issues.push({ taskId: task.id, kind: 'after' });
  }
  return issues;
}
