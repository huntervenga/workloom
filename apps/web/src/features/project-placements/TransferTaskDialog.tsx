import type { ProjectDto, TaskDto, TransferTaskProjectResult } from '@workloom/contracts';
import { Button } from '@workloom/ui';
import { ArrowRightLeft } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from '../../i18n';
import { ApiError, type TransferReason } from '../../lib/api';
import { ChoicePicker } from '../../shared/ChoicePicker';
import { DialogShell } from '../../shared/DialogShell';
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
 * Changes the home project of a task and its subtasks. The server decides what the move may touch; this dialog asks first,
 * says what changes for hours and reports, and reports what moved with the task and what stayed behind.
 */
export function TransferTaskDialog({ actorId, task, homeProject, projects, disabled }: {
  actorId: string; task: TaskDto; homeProject: ProjectDto; projects: readonly ProjectDto[]; disabled: boolean;
}) {
  const { t } = useTranslation();
  const transfer = useTransferTaskProject(actorId, task.workspaceId);
  const [open, setOpen] = useState(false);
  const [targetId, setTargetId] = useState('');
  const [result, setResult] = useState<TransferTaskProjectResult | null>(null);
  const targets = projects.filter(project => project.archivedAt === null && project.id !== homeProject.id);
  const target = targets.find(project => project.id === targetId);
  const holding = transfer.pendingCommand !== null;
  const reason = transfer.error instanceof ApiError ? transfer.error.transferReason : null;
  const reset = () => { setTargetId(''); setResult(null); transfer.reset(); };
  const send = () => {
    if (!target || holding) return;
    transfer.mutate({ taskId: task.id, input: { expectedRevision: task.revision, projectId: target.id } }, { onSuccess: moved => setResult(moved) });
  };
  const subtask = task.parentTaskId !== null;
  if (task.archivedAt !== null || task.meetingId !== null) return null;
  return <DialogShell
    title={t('placements.transfer.title')}
    description={subtask ? t('placements.transfer.subtask') : target ? t('placements.transfer.intro', { title: task.title, project: target.name }) : t('placements.transfer.pick')}
    trigger={<Button size="sm" variant="ghost" disabled={disabled || subtask || targets.length === 0}><ArrowRightLeft size={14} aria-hidden="true" />{t('placements.transfer.action')}</Button>}
    open={open}
    onOpenChange={next => { if (holding) return; setOpen(next); if (!next) reset(); }}
  >
    {result ? <div className="space-y-2 text-sm">
      <p role="status" className="font-medium text-ink">{t('placements.transfer.done', { project: target?.name ?? '' })}</p>
      {result.carriedValues > 0 ? <p className="text-muted">{t('placements.transfer.carried', { count: result.carriedValues })}</p> : null}
      {result.notCarried.length > 0 ? <p className="text-amber-900">{t('placements.transfer.notCarried', { fields: result.notCarried.map(item => `${item.fieldName} (${item.count})`).join(', ') })}</p> : null}
      <div className="flex justify-end"><Button variant="primary" onClick={() => { setOpen(false); reset(); }}>{t('placements.transfer.close')}</Button></div>
    </div> : <div className="space-y-3 text-sm">
      <ChoicePicker searchable label={t('placements.transfer.pick')} placeholder={t('placements.transfer.pick')} value={targetId}
        options={targets.map(project => ({ value: project.id, label: project.name }))} disabled={holding} onValueChange={setTargetId} />
      {target ? <p className="text-xs text-muted">{t('placements.transfer.effects')}</p> : null}
      {reason ? <p role="alert" className="text-red-700">{t('placements.transfer.reason', { reason: reasonText(t, reason) })}</p> : null}
      {transfer.error && !reason && !transfer.uncertain ? <p role="alert" className="text-red-700">{t('placements.transfer.failed')}</p> : null}
      <SaveFeedback error={null} uncertainError={transfer.uncertain?.error ?? null} subject="projectSave" />
      <div className="flex flex-wrap justify-end gap-2">
        <Button type="button" variant="ghost" disabled={holding} onClick={() => { setOpen(false); reset(); }}>{t('placements.transfer.cancel')}</Button>
        {transfer.uncertain ? <Button type="button" onClick={() => transfer.retryUncertain({ onSuccess: moved => setResult(moved) })}>{t('placements.transfer.retry')}</Button> : null}
        <Button type="button" variant="primary" disabled={!target || holding || transfer.uncertain !== null} onClick={send}>{holding ? t('placements.transfer.moving') : t('placements.transfer.confirm')}</Button>
      </div>
    </div>}
  </DialogShell>;
}
