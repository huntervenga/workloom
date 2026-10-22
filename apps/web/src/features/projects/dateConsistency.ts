import type { ProjectDto, TaskDto, TaskStatusDto } from '@workloom/contracts';

export type DateIssueKind = 'missing' | 'before' | 'after';
export interface DateIssueInfo { kind: DateIssueKind; finished: boolean }
export interface DateIssue { taskId: string; kind: DateIssueKind; /** True for a finished task; false for an open top-level task that has no date at all. */ finished: boolean }

/**
 * Completed tasks whose due date does not fit the project's dates, so a finished task cannot quietly fall outside the
 * period the project stands for: no due date at all, one before the project starts, or one after it ends. An open
 * top-level task with no due date is flagged too, because period reports cannot place it. Nothing is checked for a project
 * without dates, and cancelled or archived tasks are left alone.
 */
export function completedDateIssues(project: Pick<ProjectDto, 'dateRange'>, tasks: readonly (Pick<TaskDto, 'id' | 'dueDate' | 'statusId' | 'archivedAt'> & { parentTaskId?: string | null })[], statuses: readonly Pick<TaskStatusDto, 'id' | 'group'>[]): DateIssue[] {
  const range = project.dateRange;
  if (!range) return [];
  const group = new Map(statuses.map(status => [status.id.toLowerCase(), status.group]));
  const issues: DateIssue[] = [];
  for (const task of tasks) {
    if (task.archivedAt !== null) continue;
    const state = group.get(task.statusId.toLowerCase());
    if (state === 'done') {
      if (task.dueDate === null) issues.push({ taskId: task.id, kind: 'missing', finished: true });
      else if (task.dueDate < range.from) issues.push({ taskId: task.id, kind: 'before', finished: true });
      else if (task.dueDate > range.to) issues.push({ taskId: task.id, kind: 'after', finished: true });
    } else if ((state === 'todo' || state === 'in_progress') && task.dueDate === null && !task.parentTaskId) {
      // An undated open task would simply not appear in any period report, so say so early.
      issues.push({ taskId: task.id, kind: 'missing', finished: false });
    }
  }
  return issues;
}
