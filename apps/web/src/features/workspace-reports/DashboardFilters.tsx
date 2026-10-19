import { useState } from 'react';
import { workspaceReportQueryInputSchema, type WorkspaceReportQueryInput, type WorkspaceReportSourcesDto } from '@workloom/contracts';
import { Button, TextInput } from '@workloom/ui';
import { useTranslation } from '../../i18n';
import { defaultSourceBinding } from './state';
import { ChoicePicker } from '../../shared/ChoicePicker';

export function DashboardFilters({ discovery, input, busy, onApply, onReset, sourcesOpen, onSourcesOpenChange }: { discovery: WorkspaceReportSourcesDto; input: WorkspaceReportQueryInput; busy: boolean; onApply: (input: WorkspaceReportQueryInput) => void; onReset: () => void; sourcesOpen: boolean; onSourcesOpenChange: (open: boolean) => void }) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState(input);
  const [invalid, setInvalid] = useState(false);
  const person = draft.people.kind === 'selected' ? draft.people.membershipIds.length === 1 ? draft.people.membershipIds[0] ?? 'all' : 'selection' : 'all';
  const unavailable = draft.sources.filter(binding => !discovery.sources.some(source => source.report.id === binding.reportId));
  const projects = [...new Map(discovery.sources.map(source => [source.projectId, source])).values()];
  const update = (change: Partial<WorkspaceReportQueryInput>) => { setDraft(before => ({ ...before, ...change })); setInvalid(false); };
  return <form aria-label={t('workspaceReports.filters')} className="space-y-3" onSubmit={event => { event.preventDefault(); const parsed = workspaceReportQueryInputSchema.safeParse(draft); setInvalid(!parsed.success); if (parsed.success) onApply(parsed.data); }}>
    <div className="flex flex-wrap items-end gap-2 rounded-xl border border-line bg-surface p-3">
      <label className="grid min-w-44 gap-1 text-xs text-muted">{t('workspaceReports.peopleFilter')}<ChoicePicker compact label={t('workspaceReports.peopleFilter')} value={person} options={[{ value: 'all', label: t('workspaceReports.everyone') }, ...(draft.people.kind === 'selected' && draft.people.membershipIds.length > 1 ? [{ value: 'selection', label: t('workspaceReports.selectedPeople', { count: draft.people.membershipIds.length }), disabled: true }] : []), ...discovery.members.map(member => ({ value: member.membershipId, label: member.displayName, avatarName: member.displayName, avatarUrl: member.avatarUrl }))]} onValueChange={value => update({ people: value === 'all' ? { kind: 'all_active' } : { kind: 'selected', membershipIds: [value] } })}/></label>
      <label className="grid w-40 gap-1 text-xs text-muted">{t('workspaceReports.from')}<TextInput type="date" value={draft.range.from} onChange={event => update({ range: { ...draft.range, from: event.target.value } })}/></label>
      <label className="grid w-40 gap-1 text-xs text-muted">{t('workspaceReports.to')}<TextInput type="date" value={draft.range.to} onChange={event => update({ range: { ...draft.range, to: event.target.value } })}/></label>
      <label className="grid min-w-32 gap-1 text-xs text-muted">{t('workspaceReports.period')}<ChoicePicker compact label={t('workspaceReports.period')} value={draft.bucket} options={[{ value: 'week', label: t('workspaceReports.week') }, { value: 'month', label: t('workspaceReports.month') }]} onValueChange={value => update({ bucket: value === 'month' ? 'month' : 'week' })}/></label>
      <Button type="submit" variant="primary" size="sm" disabled={busy}>{t('workspaceReports.apply')}</Button><Button type="button" variant="ghost" size="sm" onClick={onReset}>{t('workspaceReports.reset')}</Button>
    </div>
    {invalid ? <p role="alert" className="text-sm text-danger">{t('workspaceReports.invalid')}</p> : null}
    <details id="workspace-report-sources" open={sourcesOpen} onToggle={event => onSourcesOpenChange(event.currentTarget.open)} className="rounded-xl border border-line bg-surface px-3 py-2"><summary className="cursor-pointer text-sm font-medium">{t('workspaceReports.sourcesTitle')}<span className="ml-2 text-xs font-normal text-muted">{t('workspaceReports.projectCount', { count: draft.sources.length })}</span></summary>
      <div className="mt-3 space-y-3"><p className="text-xs text-muted">{t('workspaceReports.sourcesHint')}</p>{projects.length > 20 ? <p className="text-xs text-muted">{t('workspaceReports.projectLimit')}</p> : null}{unavailable.map(binding => <div key={binding.reportId} className="flex items-center justify-between gap-2 rounded-lg border border-danger/25 p-3 text-sm"><span>{t('workspaceReports.unavailableSource')} <code className="text-xs text-muted">{binding.reportId.slice(0, 8)}</code></span><Button size="sm" type="button" aria-label={t('workspaceReports.removeUnavailable', { id: binding.reportId })} onClick={() => update({ sources: draft.sources.filter(source => source.reportId !== binding.reportId) })}>{t('workspaceReports.removeSource')}</Button></div>)}<div className="grid gap-3 xl:grid-cols-2">{projects.map(project => {
        const reports = discovery.sources.filter(source => source.projectId === project.projectId);
        const binding = draft.sources.find(source => reports.some(report => report.report.id === source.reportId));
        const selected = reports.find(source => source.report.id === binding?.reportId) ?? reports[0];
        const category = binding?.categoryFieldId !== undefined ? binding.categoryFieldId : selected?.report.config.groupBy.kind === 'category' ? selected.report.config.groupBy.fieldId : null;
        const replace = (reportId: string, categoryFieldId?: string | null) => {
          const report = reports.find(source => source.report.id === reportId);
          if (!report) return;
          update({ sources: [...draft.sources.filter(source => !reports.some(candidate => candidate.report.id === source.reportId)), { ...defaultSourceBinding(report), ...(categoryFieldId !== undefined ? { categoryFieldId } : {}) }] });
        };
        return <div key={project.projectId} className="space-y-2 rounded-lg border border-line p-3"><label className="flex items-center gap-2 text-sm font-medium"><input type="checkbox" checked={Boolean(binding)} aria-label={t('workspaceReports.sourceToggle', { project: project.projectName })} onChange={event => { if (event.target.checked && selected) replace(selected.report.id); else update({ sources: draft.sources.filter(source => !reports.some(report => report.report.id === source.reportId)) }); }}/>{project.projectName}</label>
          {binding && selected ? <div className="grid gap-2 sm:grid-cols-2"><ChoicePicker compact label={t('workspaceReports.sourceReport', { project: project.projectName })} value={binding.reportId} options={reports.map(source => ({ value: source.report.id, label: source.report.name }))} onValueChange={value => replace(value)}/><ChoicePicker compact label={t('workspaceReports.sourceCategory', { project: project.projectName })} value={category ?? ''} options={[{ value: '', label: t('workspaceReports.noCategory') }, ...selected.fields.filter(field => field.type === 'single_select' && field.archivedAt === null).map(field => ({ value: field.id, label: field.name }))]} onValueChange={value => replace(binding.reportId, value || null)}/></div> : null}
        </div>;
      })}</div>
      <div className="grid gap-2 sm:grid-cols-3"><ChoicePicker compact label={t('workspaceReports.dateSource')} value={draft.dateSource} options={[{ value: 'due_date', label: t('workspaceReports.dueDate') }, { value: 'report_date_field', label: t('workspaceReports.mappedDate') }]} onValueChange={value => update({ dateSource: value === 'report_date_field' ? 'report_date_field' : 'due_date' })}/><ChoicePicker compact label={t('workspaceReports.hierarchy')} value={draft.hierarchy} options={[{ value: 'all_tasks', label: t('workspaceReports.allTasks') }, { value: 'root_tasks', label: t('workspaceReports.rootTasks') }]} onValueChange={value => update({ hierarchy: value === 'root_tasks' ? 'root_tasks' : 'all_tasks' })}/><ChoicePicker compact label={t('workspaceReports.comparisonFilter')} value={draft.completion} options={[{ value: 'done_only', label: t('workspaceReports.doneOnly') }, { value: 'all_tasks', label: t('workspaceReports.anyStatus') }]} onValueChange={value => update({ completion: value === 'all_tasks' ? 'all_tasks' : 'done_only' })}/></div>
      </div>
    </details>
  </form>;
}
