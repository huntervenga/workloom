import type { TaskDto, TaskStatusDto } from '@workloom/contracts';
import { canEditTaskInline } from './tableEditing';

/** Catalog identity and group determine completion; names and prior status never do. */
export function taskCompletion(task: TaskDto, statuses: readonly TaskStatusDto[]) {
  const own = statuses.filter(status => status.workspaceId === task.workspaceId && status.projectId === task.projectId);
  const current = own.find(status => status.id === task.statusId);
  const completed = current?.group === 'done';
  const cancelled = current?.group === 'cancelled';
  const reopening = completed || cancelled;
  const choices = own.filter(status => reopening ? status.group === 'todo' || status.group === 'in_progress' : status.group === 'done')
    .sort((a, b) => a.position - b.position || a.id.localeCompare(b.id));
  return { current, completed, cancelled, reopening, choices, eligible: current !== undefined && canEditTaskInline(task), direct: !reopening && choices.length === 1 };
}
