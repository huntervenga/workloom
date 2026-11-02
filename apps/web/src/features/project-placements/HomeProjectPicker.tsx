import type { ProjectDto, TaskDto, TransferTaskProjectResult } from '@workloom/contracts';
import { Button } from '@workloom/ui';
import { useState } from 'react';
import { useTranslation } from '../../i18n';
import { ApiError, type TransferReason } from '../../lib/api';
import { ChoicePicker } from '../../shared/ChoicePicker';
import { SaveFeedback } from '../../shared/SaveFeedback';
import { useTransferTaskProject } from './queries';

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
  }
};

/**
 * The task's own project as a dropdown: choosing another project moves the task, with its subtasks, there at once.
 * What moved and what stayed behind is shown next to it, with a one-click way back.
 */
export function HomeProjectPicker({ actorId, task, homeProject, projects, disabled }: {
  actorId: string; task: TaskDto; homeProject: ProjectDto; projects: readonly ProjectDto[]; disabled: boolean;
}) {
  const { t } = useTranslation();
  const transfer = useTransferTaskProject(actorId, task.workspaceId);
  const [moved, setMoved] = useState<{ result: TransferTaskProjectResult; fromId: string } | null>(null);
  // Until the pane reloads the task, the picker keeps showing where the task went.
  const shownId = moved && homeProject.id !== moved.result.task.projectId ? moved.result.task.projectId : homeProject.id;
  const nameOf = (id: string) => projects.find(project => project.id === id)?.name ?? homeProject.name;
  const holding = transfer.pendingCommand !== null;
  const reason = transfer.error instanceof ApiError ? transfer.error.transferReason : null;
  const send = (projectId: string, fromId: string, revision: number) => {
    if (holding || transfer.uncertain !== null) return;
    transfer.mutate({ taskId: task.id, input: { expectedRevision: revision, projectId } }, { onSuccess: result => setMoved({ result, fromId }) });
  };
  const options = projects.filter(project => project.archivedAt === null || project.id === shownId).map(project => ({ value: project.id, label: project.name }));
  return <div className="min-w-0 space-y-1.5">
    <ChoicePicker searchable label={t('placements.transfer.pick')} value={shownId} options={options} disabled={disabled || holding || transfer.uncertain !== null}
      onValueChange={projectId => { if (projectId !== shownId && options.some(option => option.value === projectId)) send(projectId, shownId, moved?.result.task.revision ?? task.revision); }} />
    {holding ? <p role="status" className="text-xs text-muted">{t('placements.transfer.moving')}</p> : null}
    {moved && !holding ? <div role="status" className="space-y-1 text-xs text-muted">
      <p className="font-medium text-ink">{t('placements.transfer.done', { project: nameOf(moved.result.task.projectId) })}</p>
      {moved.result.carriedValues > 0 ? <p>{t('placements.transfer.carried', { count: moved.result.carriedValues })}</p> : null}
      {moved.result.notCarried.length > 0 ? <p className="text-amber-900">{t('placements.transfer.notCarried', { fields: moved.result.notCarried.map(item => `${item.fieldName} (${item.count})`).join(', ') })}</p> : null}
      <Button size="sm" variant="ghost" disabled={disabled} onClick={() => send(moved.fromId, moved.result.task.projectId, moved.result.task.revision)}>{t('placements.transfer.back', { project: nameOf(moved.fromId) })}</Button>
    </div> : null}
    {reason ? <p role="alert" className="text-xs text-red-700">{t('placements.transfer.reason', { reason: reasonText(t, reason) })}</p> : null}
    {transfer.error && !reason && !transfer.uncertain ? <p role="alert" className="text-xs text-red-700">{t('placements.transfer.failed')}</p> : null}
    <SaveFeedback error={null} uncertainError={transfer.uncertain?.error ?? null} subject="projectSave" />
    {transfer.uncertain ? <Button size="sm" variant="ghost" onClick={() => transfer.retryUncertain({ onSuccess: result => setMoved({ result, fromId: homeProject.id }) })}>{t('placements.transfer.retry')}</Button> : null}
  </div>;
}
