import type { PlanFactTemplateResultDto, ProjectColumnsDto, ProjectDto } from '@workloom/contracts';
import { Button, TextInput } from '@workloom/ui';
import { useState } from 'react';
import { useTranslation } from '../../i18n';
import { useProtectedDraft } from '../../lib/protectedDrafts';
import { SaveFeedback } from '../../shared/SaveFeedback';
import type { useReportCommands } from './queries';
export function PlanFactTemplate({ project, writable, columns, command, onCreated }: { actorId: string; workspaceId: string; project: ProjectDto; writable: boolean; columns: ProjectColumnsDto | undefined; command: ReturnType<typeof useReportCommands>['template']; onCreated: (report: PlanFactTemplateResultDto['report']) => void }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false), [planName, setPlan] = useState(''), [factName, setFact] = useState(''), [reportName, setReport] = useState('');
  const held = command.pendingCommand !== null || command.uncertain !== null;
  useProtectedDraft(open && (planName !== '' || factName !== '' || reportName !== ''));
  const success = (result: PlanFactTemplateResultDto) => { setOpen(false); setPlan(''); setFact(''); setReport(''); onCreated(result.report); };
  return <section className="rounded-xl border border-line bg-surface p-3"><Button variant="ghost" size="sm" disabled={!writable && !held} onClick={() => { if (!held) { setOpen(!open); if (!open && !planName && !factName && !reportName) { setPlan(t('genericReports.defaultPlan')); setFact(t('genericReports.defaultFact')); setReport(t('genericReports.defaultComparison')); } } }}>{t('genericReports.previewTemplate')}</Button>{open || held ? <form className="mt-3 space-y-3" onSubmit={event => { event.preventDefault(); if (!writable || held || command.hasOtherProtectedCommands() || !columns || !planName.trim() || !factName.trim() || !reportName.trim() || planName.trim().toLowerCase() === factName.trim().toLowerCase()) return; command.mutate({ input: { planName, factName, reportName, expectedColumnsRevision: columns.revision } }, { onSuccess: success }); }}>
    <p className="text-sm text-muted">{t('genericReports.templatePreview', { project: project.name })}</p><div className="grid gap-3 sm:grid-cols-3">{[{ label: t('genericReports.planName'), value: planName, change: setPlan }, { label: t('genericReports.factName'), value: factName, change: setFact }, { label: t('genericReports.reportName'), value: reportName, change: setReport }].map(control => <label key={control.label} className="grid gap-1 text-xs text-muted">{control.label}<TextInput value={control.value} maxLength={160} disabled={held || !writable} onChange={event => control.change(event.target.value)}/></label>)}</div><div className="flex gap-2"><Button type="submit" size="sm" disabled={!writable || held || !columns}>{t('genericReports.applyTemplate')}</Button><Button variant="ghost" size="sm" disabled={held} onClick={() => setOpen(false)}>{t('common.cancel')}</Button></div>
  </form> : null}<SaveFeedback error={command.error} uncertainError={command.uncertain?.error ?? null} subject="fieldValueSave"/>{command.uncertain ? <Button size="sm" disabled={!writable || command.pendingCommand !== null} onClick={() => command.retryUncertain({ onSuccess: success })}>{t('genericReports.retry')}</Button> : null}</section>;
}
