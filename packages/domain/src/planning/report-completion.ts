import type { TaskDto, TaskStatusDto, WeeklyPlanFactRowDto } from '@workloom/contracts';

/** Full authorized server census, never the report row's subset or a loaded UI page. */
export function completionAtCalculation(
  workPackageId: string,
  tasks: readonly Pick<TaskDto, 'workPackageId' | 'statusId' | 'archivedAt'>[],
  statuses: readonly Pick<TaskStatusDto, 'id' | 'group'>[],
): NonNullable<WeeklyPlanFactRowDto['completionAtCalculation']> {
  const eligible = tasks.filter(task => task.workPackageId.toLowerCase() === workPackageId.toLowerCase() && task.archivedAt === null);
  const groups = eligible.map(task => statuses.find(status => status.id.toLowerCase() === task.statusId.toLowerCase())?.group);
  const state = eligible.length === 0 || groups.some(group => group === undefined) ? 'unknown'
    : groups.every(group => group === 'done') ? 'done' : 'not_done';
  return { rule: 'all_nonarchived_package_tasks_v1', state, taskCount: eligible.length };
}
