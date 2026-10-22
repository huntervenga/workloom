import { useState } from 'react';
import { CalendarX } from 'lucide-react';
import type { ProjectDto, TaskDto } from '@workloom/contracts';
import { Button } from '@workloom/ui';
import { useTranslation } from '../../i18n';
import type { DateIssue } from './dateConsistency';

const LIST_LIMIT = 30;

/** Says how many finished tasks do not fit the project's dates, with the tasks one click away. */
export function CompletedDateBanner({ project, issues, tasks, partial, onOpenTask }: { project: Pick<ProjectDto, 'dateRange'>; issues: readonly DateIssue[]; tasks: readonly Pick<TaskDto, 'id' | 'title' | 'dueDate'>[]; partial: boolean; onOpenTask: (taskId: string) => void }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  if (issues.length === 0 || !project.dateRange) return null;
  const missing = issues.filter(issue => issue.kind === 'missing').length;
  const outside = issues.length - missing;
  const byId = new Map(tasks.map(task => [task.id, task]));
  const kindText = (kind: DateIssue['kind']) => kind === 'missing' ? t('projectDates.kindMissing') : kind === 'before' ? t('projectDates.kindBefore') : t('projectDates.kindAfter');
  return <section role="status" aria-label={t('projectDates.title')} className="space-y-2 rounded-xl border border-amber-300 bg-amber-50 p-3 text-sm text-amber-950 [[data-theme=dark]_&]:border-amber-500/40 [[data-theme=dark]_&]:bg-amber-500/10 [[data-theme=dark]_&]:text-amber-100">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <p className="flex items-center gap-2 font-medium"><CalendarX size={16} aria-hidden="true" />{t('projectDates.summary', { count: issues.length, from: project.dateRange.from, to: project.dateRange.to })}</p>
      <Button size="sm" variant="ghost" aria-expanded={open} onClick={() => setOpen(value => !value)}>{open ? t('projectDates.hide') : t('projectDates.show')}</Button>
    </div>
    <p className="text-xs">{t('projectDates.breakdown', { missing, outside })}{partial ? ` ${t('projectDates.partial')}` : ''}</p>
    {open ? <ul className="space-y-1">{issues.slice(0, LIST_LIMIT).map(issue => {
      const task = byId.get(issue.taskId);
      return <li key={issue.taskId}><button type="button" className="text-left underline decoration-dotted" onClick={() => onOpenTask(issue.taskId)}>{task?.title ?? issue.taskId}</button><span className="ml-2 text-xs">{kindText(issue.kind)}{task?.dueDate ? ` (${task.dueDate})` : ''}</span></li>;
    })}{issues.length > LIST_LIMIT ? <li className="text-xs">{t('projectDates.more', { count: issues.length - LIST_LIMIT })}</li> : null}</ul> : null}
  </section>;
}
