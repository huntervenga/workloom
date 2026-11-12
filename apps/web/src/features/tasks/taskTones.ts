import type { TaskPriority, TaskStatusGroup } from '@workloom/contracts';

/**
 * One colour per status group and per priority wherever they show: table cells, pickers and the
 * task pane. Each tone pairs the table's theme utility with the same theme variable for inline
 * dots, so every theme recolours the cell and the picker alike.
 */
export const statusTones: Record<TaskStatusGroup, { dot: string; color: string }> = {
  todo: { dot: 'bg-slate-400', color: 'var(--color-slate-400)' },
  in_progress: { dot: 'bg-accent', color: 'var(--color-accent)' },
  done: { dot: 'bg-emerald-500', color: 'var(--color-emerald-500)' },
  cancelled: { dot: 'bg-slate-300', color: 'var(--color-slate-300)' },
};

export const priorityTones: Record<Exclude<TaskPriority, 'none'>, { text: string; color: string }> = {
  low: { text: 'text-muted', color: 'var(--color-muted)' },
  medium: { text: 'text-ink-soft', color: 'var(--color-ink-soft)' },
  high: { text: 'text-amber-700', color: 'var(--color-amber-700)' },
  urgent: { text: 'text-rose-700', color: 'var(--color-rose-700)' },
};

/** The picker dot of a priority; "No priority" has none. */
export function priorityColor(priority: TaskPriority): string | undefined {
  return priority === 'none' ? undefined : priorityTones[priority].color;
}
