import type { TaskDto } from '@workloom/contracts';

/** Only time-entry context crosses project/weekly route boundaries. View and command state stay local. */
export interface PlanningNavigationContext {
  periodId?: string | null;
  workerId?: string | null;
  /** An unselected table week must not turn into the standalone weekly page's suggested week. */
  explicitEmptyPeriod?: boolean;
}

export function weeklyPlanningHref(workspaceId: string, projectId: string, context: PlanningNavigationContext = {}): string {
  const params = new URLSearchParams();
  if (context.periodId || context.explicitEmptyPeriod) params.set('period', context.periodId ?? '');
  if (context.workerId !== null && context.workerId !== undefined) params.set('worker', context.workerId);
  const query = params.toString();
  return `/w/${workspaceId}/projects/${projectId}/week${query ? `?${query}` : ''}`;
}

export function projectTimeHref(workspaceId: string, projectId: string, context: PlanningNavigationContext = {}): string {
  const params = new URLSearchParams();
  if (context.periodId) params.set('week', context.periodId);
  if (context.workerId !== null && context.workerId !== undefined) params.set('worker', context.workerId);
  const query = params.toString();
  return `/w/${workspaceId}/projects/${projectId}${query ? `?${query}` : ''}`;
}

export interface ReportTaskSourceContext extends PlanningNavigationContext {
  workspaceId: string;
  projectId: string;
}

/** A report points to the currently authorized task, which may now belong to another project. */
export function currentReportTaskHref(task: Pick<TaskDto, 'id' | 'workspaceId' | 'projectId'>, source: ReportTaskSourceContext): string {
  const sameWorkspace = task.workspaceId === source.workspaceId;
  const params = new URLSearchParams();
  if (sameWorkspace && task.projectId === source.projectId && source.periodId) params.set('week', source.periodId);
  if (sameWorkspace && source.workerId !== null && source.workerId !== undefined) params.set('worker', source.workerId);
  params.set('task', task.id);
  return `/w/${task.workspaceId}/projects/${task.projectId}?${params.toString()}`;
}
