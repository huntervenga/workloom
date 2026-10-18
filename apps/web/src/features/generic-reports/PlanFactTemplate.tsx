import type { PlanFactTemplateResultDto, ProjectColumnsDto, ProjectDto, TaskFieldDefinitionDto } from '@workloom/contracts';
import { Button, TextInput } from '@workloom/ui';
import { useState } from 'react';
import { useTranslation } from '../../i18n';
import { useProtectedDraft } from '../../lib/protectedDrafts';
import { SaveFeedback } from '../../shared/SaveFeedback';
import type { useReportCommands } from './queries';
export function PlanFactTemplate({ project, writable, columns, fields, command, onCreated }: { actorId: string; workspaceId: string; project: ProjectDto; writable: boolean; columns: ProjectColumnsDto | undefined; fields: readonly TaskFieldDefinitionDto[] | undefined; command: ReturnType<typeof useReportCommands>['template']; onCreated: (report: PlanFactTemplateResultDto['report']) => void }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false), [planName, setPlan] = useState(''), [factName, setFact] = useState(''), [reportName, setReport] = useState('');
  const held = command.pendingCommand !== null || command.uncertain !== null;
  useProtectedDraft(open && (planName !== '' || factName !== '' || reportName !== ''));
  const proposed = [planName.trim().toLowerCase(), factName.trim().toLowerCase()];
  const conflicts = held ? [] : (fields ?? []).filter(field => field.workspaceId === project.workspaceId && field.projectId === project.id && proposed.includes(field.name.toLowerCase()));
  const sameName = proposed[0] !== '' && proposed[0] === proposed[1];
  const canApply = writable && !held && columns !== undefined && fields !== undefined && planName.trim() !== '' && factName.trim() !== '' && reportName.trim() !== '' && !sameName && conflicts.length === 0 && !command.hasOtherProtectedCommands();
  const success = (result: PlanFactTemplateResultDto) => { setOpen(false); setPlan(''); setFact(''); setReport(''); onCreated(result.report); };
  return <section className="rounded-xl border border-line bg-surface p-3"><Button variant="ghost" size="sm" disabled={!writable && !held} onClick={() => { if (!held) { setOpen(!open); if (!open && !planName && !factName && !reportName) { setPlan(t('genericReports.defaultPlan')); setFact(t('genericReports.defaultFact')); setReport(t('genericReports.defaultComparison')); } } }}>{t('genericReports.previewTemplate')}</Button>{open || held ? <form className="mt-3 space-y-3" onSubmit={event => { event.preventDefault(); if (!canApply || !columns || command.hasOtherProtectedCommands()) return; command.mutate({ input: { planName, factName, reportName, expectedColumnsRevision: columns.revision } }, { onSuccess: success }); }}>
    <p className="text-sm text-muted">{t('genericReports.templatePreview', { project: project.name })}</p><div className="grid gap-3 sm:grid-cols-3">{[{ label: t('genericReports.planName'), value: planName, change: setPlan }, { label: t('genericReports.factName'), value: factName, change: setFact }, { label: t('genericReports.reportName'), value: reportName, change: setReport }].map(control => <label key={control.label} className="grid gap-1 text-xs text-muted">{control.label}<TextInput value={control.value} maxLength={160} disabled={held || !writable} onChange={event => control.change(event.target.value)}/></label>)}</div>{conflicts.map(field => <p key={field.id} role="alert" className="text-sm text-danger">{t('genericReports.templateNameConflict', { name: field.name })}</p>)}{sameName && !held ? <p role="alert" className="text-sm text-danger">{t('genericReports.templateDistinctNames')}</p> : null}<div className="flex gap-2"><Button type="submit" size="sm" disabled={!canApply}>{t('genericReports.applyTemplate')}</Button><Button variant="ghost" size="sm" disabled={held} onClick={() => setOpen(false)}>{t('common.cancel')}</Button></div>
  </form> : null}<SaveFeedback error={command.error} uncertainError={command.uncertain?.error ?? null} subject="fieldValueSave"/>{command.uncertain ? <Button size="sm" disabled={!writable || command.pendingCommand !== null} onClick={() => command.retryUncertain({ onSuccess: success })}>{t('genericReports.retry')}</Button> : null}</section>;
}
