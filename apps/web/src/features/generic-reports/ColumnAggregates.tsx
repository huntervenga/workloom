import { operationLabels } from './translationKeys';
import { reportGroupLabel } from './groupLabel';
import { useState, type ReactNode } from 'react';
import type { GenericReportConfig, GenericReportResultDto, MembershipDto, SectionDto, TaskFieldDefinitionDto } from '@workloom/contracts';
import { Button } from '@workloom/ui';
import { useTranslation } from '../../i18n';
import type { TaskFilterValue } from '../tasks/TaskFilters';
import type { TaskGroupingMode } from '../task-table/taskGrouping';
import { useProtectedDraft } from '../../lib/protectedDrafts';
import { QueryErrorState } from '../../shared/QueryErrorState';
import { SaveFeedback } from '../../shared/SaveFeedback';
import { useAggregateSettings, useAggregates, useCurrentReportAccess, useReportCommands } from './queries';
import { emptyReportConfig, ReportConfigEditor } from './ReportConfigEditor';
import { reportNumber } from './ReportResults';

export function AggregateLine({ result }: { result: GenericReportResultDto }) {
  const { t } = useTranslation();
  const source = result;
  return <div className="flex min-w-0 flex-wrap gap-x-5 gap-y-1 py-2 text-xs text-muted"><span className="font-medium">{t('genericReports.tableTotal')}</span>{source.measures.map(measure => <span key={measure.key} className="tabular-nums"><span>{result.fields.find(field => field.id === measure.fieldId)?.name ?? t('genericReports.task')} · {t(operationLabels[measure.operation])}: </span><strong className="font-medium text-ink">{reportNumber(measure.value, measure.unit)}</strong><span className="ml-1">{t('genericReports.coverage', { filled: measure.coverage.filled, tasks: measure.coverage.tasks, missing: measure.coverage.missing, nulls: measure.coverage.null, zero: measure.coverage.zero })}</span></span>)}</div>;
}
export function useColumnAggregates({ actorId, workspaceId, projectId, fields, members, sections, grouping, filters, writable, enabled }: { actorId: string; workspaceId: string; projectId: string; fields: readonly TaskFieldDefinitionDto[]; members: readonly MembershipDto[]; sections: readonly SectionDto[]; grouping: TaskGroupingMode; filters: TaskFilterValue; writable: boolean; enabled: boolean }) {
  const { t } = useTranslation();
  const access = useCurrentReportAccess(actorId, workspaceId, projectId);
  writable = writable && enabled && (access === 'owner' || access === 'admin');
  const settings = useAggregateSettings(actorId, workspaceId, projectId, enabled), commands = useReportCommands(actorId, workspaceId, projectId);
  const [edit, setEdit] = useState<{ revision: number; config: GenericReportConfig } | null>(null), [open, setOpen] = useState(false);
  const unsupported = filters.search.trim() !== '' || filters.statusId !== '' || filters.participantMembershipId !== '' || filters.includeArchived;
  const config: GenericReportConfig = { ...emptyReportConfig(projectId), measures: settings.data?.measures ?? [], groupBy: { kind: grouping }, filters: { statusGroups: filters.completion === 'open' ? ['todo', 'in_progress'] : [], tagIds: filters.tagId ? [filters.tagId] : [], assignee: { kind: 'all' }, dateRange: null } };
  const result = useAggregates(actorId, workspaceId, projectId, { config, offset: 0, limit: 1 }, enabled && settings.isSuccess && !settings.isFetching && config.measures.length > 0 && !unsupported);
  const command = commands.aggregates, held = command.pendingCommand !== null || command.uncertain !== null;
  useProtectedDraft(edit !== null);
  const save = () => { if (edit && writable && !held && !command.hasOtherProtectedCommands()) command.mutate({ input: { expectedRevision: edit.revision, measures: edit.config.measures } }, { onSuccess: () => { setEdit(null); setOpen(false); } }); };
  const renderLine = (): ReactNode => {
    if (!enabled || settings.isError || config.measures.length === 0) return null;
    if (unsupported) return <p role="status" className="py-2 text-xs text-muted">{t('genericReports.unsupportedFilters')}</p>;
    if (settings.isFetching || result.isFetching) return <p role="status" className="py-2 text-xs text-muted">{t('genericReports.calculating')}</p>;
    if (result.isError) return <QueryErrorState error={result.error} subject="fields" headingLevel={3} onRetry={() => void result.refetch()}/>;
    return result.data ? <AggregateLine result={result.data}/> : null;
  };
  const panel = <details open={open || held} className="rounded-lg border border-line bg-surface p-3"><summary onClick={event => { event.preventDefault(); if (!held) setOpen(!open); }} className="cursor-pointer text-xs font-medium">{t('genericReports.aggregates')}</summary><div className="mt-2 space-y-3"><p className="text-xs text-muted">{t('genericReports.aggregateHint')}</p>{!enabled ? <p role="status" className="text-xs text-muted">{t('genericReports.totalsWaiting')}</p> : settings.isPending ? <p role="status" className="text-xs text-muted">{t('genericReports.loading')}</p> : settings.isError ? <QueryErrorState error={settings.error} subject="fields" headingLevel={3} onRetry={() => void settings.refetch()}/> : edit ? <>
    <ReportConfigEditor measuresOnly config={edit.config} onChange={next => setEdit({ ...edit, config: { ...edit.config, measures: next.measures } })} fields={fields} members={[]} tags={[]} disabled={!writable || held}/>
    {settings.data && settings.data.revision !== edit.revision ? <p role="status" className="text-xs text-muted">{t('genericReports.staleDraft')}</p> : null}<div className="flex flex-wrap gap-2"><Button size="sm" variant="ghost" disabled={!writable || held} onClick={() => setEdit({ ...edit, config: { ...edit.config, measures: [] } })}>{t('genericReports.clearTotals')}</Button><Button size="sm" disabled={!writable || held} onClick={save}>{t('genericReports.saveAggregates')}</Button><Button size="sm" variant="ghost" disabled={held} onClick={() => setEdit(null)}>{t('genericReports.discard')}</Button></div>
  </> : <><p className="text-xs text-muted">{settings.data?.measures.length ? settings.data.measures.map(measure => `${'fieldId' in measure ? fields.find(field => field.id === measure.fieldId)?.name ?? t('genericReports.unavailableField') : t('genericReports.task')} · ${t(operationLabels[measure.operation])}`).join(' · ') : t('genericReports.noAggregates')}</p><Button size="sm" variant="ghost" disabled={!writable || !settings.isSuccess || settings.isFetching || held} onClick={() => { if (settings.data) setEdit({ revision: settings.data.revision, config: { ...emptyReportConfig(projectId), measures: settings.data.measures.length ? settings.data.measures : [{ key: 'tasks', operation: 'count_tasks' }] } }); }}>{t('genericReports.configureAggregates')}</Button></>}
  {enabled && settings.isSuccess && !settings.isFetching && result.isSuccess && !result.isFetching && !unsupported && config.measures.length > 0 ? <section aria-label={t('genericReports.fullGroupTotals')} className="space-y-2"><h3 className="text-xs font-medium">{t(grouping === 'section' ? 'genericReports.ownSectionTotals' : 'genericReports.fullGroupTotals')}</h3>{result.data.groups.map(group => <div key={group.key} className="border-t border-line py-2"><p className="text-xs font-medium">{reportGroupLabel(result.data.config, group.key, group.label, result.data.fields, members, sections)}</p>{group.measures.map(measure => <p key={measure.key} className="text-xs text-muted">{result.data.fields.find(field => field.id === measure.fieldId)?.name ?? t('genericReports.task')} · {t(operationLabels[measure.operation])}: <strong className="text-ink">{reportNumber(measure.value, measure.unit)}</strong> · {t('genericReports.coverage', { filled: measure.coverage.filled, tasks: measure.coverage.tasks, missing: measure.coverage.missing, nulls: measure.coverage.null, zero: measure.coverage.zero })}</p>)}</div>)}</section> : null}
  <SaveFeedback error={command.error} uncertainError={command.uncertain?.error ?? null} subject="fieldValueSave"/>{command.uncertain ? <Button size="sm" disabled={!writable || command.pendingCommand !== null} onClick={() => command.retryUncertain({ onSuccess: () => { setEdit(null); setOpen(false); } })}>{t('genericReports.retry')}</Button> : null}</div></details>;
  return { panel, footer: renderLine() };
}
