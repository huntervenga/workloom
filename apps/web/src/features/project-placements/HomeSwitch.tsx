import type { ProjectDto, TaskDto } from '@workloom/contracts';
import { Button } from '@workloom/ui';
import { X } from 'lucide-react';
import { useTranslation } from '../../i18n';
import { ApiError, type TransferReason } from '../../lib/api';
import { SaveFeedback } from '../../shared/SaveFeedback';
import { transferNotices, useTransferNotice, useTransferTaskProject } from './queries';

const reasonText = (t: (key: `${string}.${string}`) => string, reason: TransferReason): string => {
  switch (reason) {
    case 'archived': return t('placements.transfer.reasons.archived');
    case 'subtask': return t('placements.transfer.reasons.subtask');
    case 'same_project': return t('placements.transfer.reasons.same_project');
    case 'locked_from': return t('placements.transfer.reasons.locked_from');
    case 'locked_to': return t('placements.transfer.reasons.locked_to');
    case 'too_many': return t('placements.transfer.reasons.too_many');
    case 'plans': return t('placements.transfer.reasons.plans');
    case 'work_logs': return t('placements.transfer.reasons.work_logs');
    case 'baseline': return t('placements.transfer.reasons.baseline');
    case 'meeting': return t('placements.transfer.reasons.meeting');
    case 'shared_package': return t('placements.transfer.reasons.shared_package');
    case 'split_package': return t('placements.transfer.reasons.split_package');
    case 'no_status': return t('placements.transfer.reasons.no_status');
    case 'single_project': return t('placements.transfer.reasons.single_project');
    case 'single_project_former': return t('placements.transfer.reasons.single_project_former');
  }
};

/**
 * Makes another of the task's projects its home, with its subtasks. The former home stays among the task's projects,
 * so the task remains visible there and the change can be undone with the same action.
 */
export function useHomeSwitch(actorId: string, task: TaskDto, homeProject: ProjectDto) {
  const transfer = useTransferTaskProject(actorId, task.workspaceId);
  const notice = useTransferNotice(task.id);
  // Shown only while the task is still where that change left it (or the pane has not reloaded it yet).
  const moved = notice && (homeProject.id === notice.result.task.projectId || homeProject.id === notice.fromProjectId) ? { result: notice.result, fromId: notice.fromProjectId } : null;
  // Until the pane reloads the task, the project the task just moved to is already its home.
  const homeId = moved && homeProject.id !== moved.result.task.projectId ? moved.result.task.projectId : homeProject.id;
  // The pane's own task is the newest; only while it still shows the old home (not yet reloaded) is the answer newer.
  const revision = moved && homeProject.id !== moved.result.task.projectId ? Math.max(task.revision, moved.result.task.revision) : task.revision;
  const holding = transfer.pendingCommand !== null;
  const busy = holding || transfer.uncertain !== null;
  const makeHome = (projectId: string) => {
    if (busy || projectId === homeId) return;
    transfer.mutate({ taskId: task.id, input: { expectedRevision: revision, projectId, keepFormerHome: true }, fromProjectId: homeId });
  };
  return { transfer, moved, homeId, holding, busy, makeHome };
}
export type HomeSwitch = ReturnType<typeof useHomeSwitch>;

/** What the last home change did: progress, copied and uncopied field values, the way back, or why it was refused. */
export function HomeSwitchFeedback({ task, home, nameOf, disabled }: { task: TaskDto; home: HomeSwitch; nameOf: (projectId: string) => string; disabled: boolean }) {
  const { t } = useTranslation();
  const { transfer, moved, holding } = home;
  const reason = transfer.error instanceof ApiError ? transfer.error.transferReason : null;
  return <>
    {holding ? <p role="status" className="text-xs text-muted">{t('placements.transfer.moving')}</p> : null}
    {moved && !holding ? <div role="status" className="space-y-1 text-xs text-muted">
      <div className="flex items-center gap-1"><p className="min-w-0 flex-1 font-medium text-ink">{t('placements.transfer.done', { project: nameOf(moved.result.task.projectId) })}</p>
        <Button size="sm" variant="ghost" aria-label={t('placements.transfer.dismiss')} onClick={() => transferNotices.clear(task.id)}><X size={14} aria-hidden="true" /></Button></div>
      {moved.result.carriedValues > 0 ? <p>{t('placements.transfer.carried', { count: moved.result.carriedValues })}</p> : null}
      {moved.result.notCarried.length > 0 ? <p className="text-amber-900">{t('placements.transfer.notCarried', { fields: moved.result.notCarried.map(item => `${item.fieldName} (${item.count})`).join(', ') })}</p> : null}
      <Button size="sm" variant="ghost" disabled={disabled || home.busy} onClick={() => home.makeHome(moved.fromId)}>{t('placements.transfer.back', { project: nameOf(moved.fromId) })}</Button>
    </div> : null}
    {reason ? <p role="alert" className="text-xs text-red-700">{t('placements.transfer.reason', { reason: reasonText(t, reason) })}</p> : null}
    {transfer.error && !reason && !transfer.uncertain ? <p role="alert" className="text-xs text-red-700">{t('placements.transfer.failed')}</p> : null}
    <SaveFeedback error={null} uncertainError={transfer.uncertain?.error ?? null} subject="projectSave" />
    {transfer.uncertain ? <Button size="sm" variant="ghost" onClick={() => transfer.retryUncertain()}>{t('placements.transfer.retry')}</Button> : null}
  </>;
}
