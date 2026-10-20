import { useSummaryTemplateWorkspace } from '../summary-templates/queries';
import { usePlanningCheckSettings } from '../planning-checks/queries';
import { HeaderWidgets, replaceHeaderWidgets, sameWidgetGroup } from './HeaderWidgets';
import { ColumnAggregateCell, replaceColumnOperation } from './ColumnAggregateCell';
import type { TableTaskGroup } from '../task-table/taskGrouping';
import { operationLabels } from './translationKeys';
import { reportGroupLabel } from './groupLabel';
import { useState, type ReactNode } from 'react';
import type { GenericReportConfig, GenericReportResultDto, MembershipDto, SectionDto, TaskFieldDefinitionDto } from '@workloom/contracts';
import { Button } from '@workloom/ui';
import { useTranslation } from '../../i18n';
import type { TaskFilterValue } from '../tasks/TaskFilters';
import type { TaskGroupingMode } from '../task-table/taskGrouping';
import { ApiError } from '../../lib/api';
import { useProtectedDraft } from '../../lib/protectedDrafts';
import { QueryErrorState } from '../../shared/QueryErrorState';
import { SaveFeedback } from '../../shared/SaveFeedback';
import { useWorkspaceReadPresentation } from '../workspace/workspaceReadPresentation';
import { useAggregateSettings, useHeaderWidgetResults, useAggregates, useCurrentReportAccess, useReportCommands } from './queries';
import { emptyReportConfig, ReportConfigEditor } from './ReportConfigEditor';
import { reportNumber } from './ReportResults';

export function AggregateLine({ result }: { result: GenericReportResultDto }) {
  const { t } = useTranslation();
  const source = result;
  return <div className="flex min-w-0 flex-wrap gap-x-5 gap-y-1 py-2 text-xs text-muted"><span className="font-medium">{t('genericReports.tableTotal')}</span>{source.measures.map(measure => <span key={measure.key} className="tabular-nums"><span>{result.fields.find(field => field.id === measure.fieldId)?.name ?? t('genericReports.task')} · {t(operationLabels[measure.operation])}: </span><strong className="font-medium text-ink">{reportNumber(measure.value, measure.unit)}</strong><span className="ml-1">{t('genericReports.coverage', { filled: measure.coverage.filled, tasks: measure.coverage.tasks, missing: measure.coverage.missing, nulls: measure.coverage.null, zero: measure.coverage.zero })}</span></span>)}</div>;
}
export function useColumnAggregates({ actorId, workspaceId, projectId, fields, members, sections, grouping, filters, writable, enabled, projectDateRange, projectRevision }: { actorId: string; workspaceId: string; projectId: string; fields: readonly TaskFieldDefinitionDto[]; members: readonly MembershipDto[]; sections: readonly SectionDto[]; grouping: TaskGroupingMode; filters: TaskFilterValue; writable: boolean; enabled: boolean; projectDateRange?: {from:string;to:string}|null; projectRevision?: number }) {
  const { t } = useTranslation();
  const access = useCurrentReportAccess(actorId, workspaceId, projectId);
  const presentation = useWorkspaceReadPresentation(actorId, workspaceId, projectId);
  writable = writable && enabled && (access === 'owner' || access === 'admin');
  const templateController=useSummaryTemplateWorkspace(actorId,workspaceId,projectId,enabled);
  const templateCheckSettings=usePlanningCheckSettings(actorId,workspaceId,projectId,templateController.catalog.isFetched);
  const settings = useAggregateSettings(actorId, workspaceId, projectId, enabled), commands = useReportCommands(actorId, workspaceId, projectId);
  const [retryingRead, setRetryingRead] = useState<'settings' | 'totals' | 'headers' | null>(null);
  const [edit, setEdit] = useState<{ revision: number; config: GenericReportConfig } | null>(null), [open, setOpen] = useState(false);
  const unsupported = filters.search.trim() !== '' || filters.statusId !== '' || filters.participantMembershipId !== '' || filters.includeArchived;
  const config: GenericReportConfig = { ...emptyReportConfig(projectId), measures: settings.data?.measures ?? [], groupBy: { kind: grouping }, filters: { statusGroups: filters.completion === 'open' ? ['todo', 'in_progress'] : [], tagIds: filters.tagId ? [filters.tagId] : [], assignee: { kind: 'all' }, dateRange: null } };
  const result = useAggregates(actorId, workspaceId, projectId, { config, offset: 0, limit: 1 }, enabled && settings.isSuccess && !settings.isFetching && config.measures.length > 0 && !unsupported);
  const headerResult = useHeaderWidgetResults(actorId, workspaceId, projectId, { expectedSettingsRevision: settings.data?.revision ?? 0, groupBy: grouping, hierarchy: 'all_tasks', filters: config.filters }, enabled && settings.isSuccess && !settings.isFetching && (settings.data.headerWidgets?.length ?? 0) > 0 && !unsupported, projectRevision);
  const command = commands.aggregates, held = command.pendingCommand !== null || command.uncertain !== null;
  // Query keys bind results to the exact actor, project, filters and configured measures.
  // Keep a confirmed read through a background refresh; discard it on errors or lost scope/access.
  const readable = enabled && (access !== 'blocked' || presentation) && settings.isSuccess && settings.data.workspaceId === workspaceId && settings.data.projectId === projectId;
  const currentTotals = readable && !unsupported && result.isSuccess ? result.data : undefined;
  const currentHeaders = readable && !unsupported && headerResult.isSuccess && headerResult.data.projectId === projectId && headerResult.data.settingsRevision === settings.data.revision && headerResult.data.groupBy === grouping ? headerResult.data : undefined;
  useProtectedDraft(edit !== null);
  const save = () => { if (edit && writable && !held && !command.hasOtherProtectedCommands()) command.mutate({ input: { expectedRevision: edit.revision, measures: edit.config.measures } }, { onSuccess: () => { setEdit(null); setOpen(false); } }); };
  const retryRead = async (target: 'settings' | 'totals' | 'headers') => {
    if (retryingRead !== null) return;
    setRetryingRead(target);
    try {
      if (target === 'settings') { await settings.refetch(); return; }
      const query = target === 'totals' ? result : headerResult;
      if (query.error instanceof ApiError && query.error.status === 409) {
        const previousRevision = settings.data?.revision;
        const refreshed = await settings.refetch();
        // A changed revision creates a new enabled query. Never resend the stale query body.
        if (refreshed.isSuccess && refreshed.data.revision === previousRevision) await query.refetch();
      } else await query.refetch();
    } finally { setRetryingRead(null); }
  };
  const failedRead = (copy: string, action: string, target: 'settings' | 'totals' | 'headers') => <p role="alert" className="flex flex-wrap items-center gap-2 rounded border border-line bg-surface px-3 py-2 text-xs text-muted"><span>{copy}</span><Button size="sm" variant="ghost" disabled={retryingRead !== null || settings.isFetching || (target === 'totals' ? result.isFetching : target === 'headers' ? headerResult.isFetching : false)} onClick={() => void retryRead(target)}>{action}</Button></p>;
  const readFeedback = !enabled ? null : <>{settings.isError ? failedRead(t('genericReports.tableAggregates.settingsLoadError'), t('genericReports.tableAggregates.retrySettings'), 'settings') : null}{settings.isSuccess && !unsupported && config.measures.length > 0 && result.isError ? failedRead(t('genericReports.tableAggregates.totalsLoadError'), t('genericReports.tableAggregates.retryTotals'), 'totals') : null}{settings.isSuccess && !unsupported && (settings.data.headerWidgets?.length ?? 0) > 0 && headerResult.isError ? failedRead(t('genericReports.tableAggregates.headersLoadError'), t('genericReports.tableAggregates.retryHeaders'), 'headers') : null}</>;
  const renderLine = (): ReactNode => {
    if (!readable || config.measures.length === 0) return null;
    if (unsupported) return <p role="status" className="py-2 text-xs text-muted">{t('genericReports.unsupportedFilters')}</p>;
    if (result.isError) return <QueryErrorState error={result.error} subject="fields" headingLevel={3} onRetry={() => void result.refetch()}/>;
    if (currentTotals) return <AggregateLine result={currentTotals}/>;
    return settings.isFetching || result.isFetching ? <p role="status" className="py-2 text-xs text-muted">{t('genericReports.calculating')}</p> : null;
  };
  const panel = <div className="space-y-2">{templateController.command.uncertain?<div className="flex flex-wrap gap-2 rounded border border-line p-2"><SaveFeedback subject="fieldValueSave" error={null} uncertainError={templateController.command.uncertain.error}/><Button size="sm" disabled={!writable||templateController.command.pendingCommand!==null} onClick={()=>templateController.command.retryUncertain()}>{t('summaryTemplates.retry')}</Button></div>:null}{readFeedback}<details open={open || command.uncertain !== null} className="rounded-lg border border-line bg-surface p-3"><summary onClick={event => { event.preventDefault(); if (!held) setOpen(!open); }} className="cursor-pointer text-xs font-medium">{t('genericReports.aggregates')}</summary><div className="mt-2 space-y-3"><p className="text-xs text-muted">{t('genericReports.aggregateHint')}</p>{!enabled ? <p role="status" className="text-xs text-muted">{t('genericReports.totalsWaiting')}</p> : settings.isPending ? <p role="status" className="text-xs text-muted">{t('genericReports.loading')}</p> : settings.isError ? <QueryErrorState error={settings.error} subject="fields" headingLevel={3} onRetry={() => void settings.refetch()}/> : edit ? <>
    <ReportConfigEditor measuresOnly config={edit.config} onChange={next => setEdit({ ...edit, config: { ...edit.config, measures: next.measures } })} fields={fields} members={[]} tags={[]} disabled={!writable || held}/>
    {settings.data && settings.data.revision !== edit.revision ? <p role="status" className="text-xs text-muted">{t('genericReports.staleDraft')}</p> : null}<div className="flex flex-wrap gap-2"><Button size="sm" variant="ghost" disabled={!writable || held} onClick={() => setEdit({ ...edit, config: { ...edit.config, measures: [] } })}>{t('genericReports.clearTotals')}</Button><Button size="sm" disabled={!writable || held} onClick={save}>{t('genericReports.saveAggregates')}</Button><Button size="sm" variant="ghost" disabled={held} onClick={() => setEdit(null)}>{t('genericReports.discard')}</Button></div>
  </> : <><p className="text-xs text-muted">{settings.data?.measures.length ? settings.data.measures.map(measure => `${'fieldId' in measure ? fields.find(field => field.id === measure.fieldId)?.name ?? t('genericReports.unavailableField') : t('genericReports.task')} · ${t(operationLabels[measure.operation])}`).join(' · ') : t('genericReports.noAggregates')}</p><Button size="sm" variant="ghost" disabled={!writable || !settings.isSuccess || settings.isFetching || held} onClick={() => { if (settings.data) setEdit({ revision: settings.data.revision, config: { ...emptyReportConfig(projectId), measures: settings.data.measures.length ? settings.data.measures : [{ key: 'tasks', operation: 'count_tasks' }] } }); }}>{t('genericReports.configureAggregates')}</Button></>}
  {currentTotals && config.measures.length > 0 ? <section aria-label={t('genericReports.fullGroupTotals')} className="space-y-2"><h3 className="text-xs font-medium">{t(grouping === 'section' ? 'genericReports.ownSectionTotals' : 'genericReports.fullGroupTotals')}</h3>{currentTotals.groups.map(group => <div key={group.key} className="border-t border-line py-2"><p className="text-xs font-medium">{reportGroupLabel(currentTotals.config, group.key, group.label, currentTotals.fields, members, sections)}</p>{group.measures.map(measure => <p key={measure.key} className="text-xs text-muted">{currentTotals.fields.find(field => field.id === measure.fieldId)?.name ?? t('genericReports.task')} · {t(operationLabels[measure.operation])}: <strong className="text-ink">{reportNumber(measure.value, measure.unit)}</strong> · {t('genericReports.coverage', { filled: measure.coverage.filled, tasks: measure.coverage.tasks, missing: measure.coverage.missing, nulls: measure.coverage.null, zero: measure.coverage.zero })}</p>)}</div>)}</section> : null}
  <SaveFeedback error={command.error} uncertainError={command.uncertain?.error ?? null} subject="fieldValueSave"/>{command.uncertain ? <Button size="sm" disabled={!writable || command.pendingCommand !== null} onClick={() => command.retryUncertain({ onSuccess: () => { setEdit(null); setOpen(false); } })}>{t('genericReports.retry')}</Button> : null}</div></details></div>;
  const renderColumn = (columnId: string, group?: TableTaskGroup): ReactNode => {
    if (!enabled) return null;
    if (columnId === 'title' && !group && unsupported && config.measures.length) return <span role="status" className="block truncate text-xs text-muted" title={t('genericReports.unsupportedFilters')}>{t('genericReports.unsupportedFilters')}</span>;
    if (columnId === 'title') return <span className="text-xs text-muted" title={group?.kind !== 'assignee' && group ? t('genericReports.ownSectionTotals') : t('genericReports.tableAggregates.fullScope')}>{group ? t('genericReports.tableAggregates.sectionTotal') : t('genericReports.tableTotal')}</span>;
    const field = fields.find(item => item.id === columnId && item.archivedAt === null && (item.type === 'number' || item.type === 'duration'));
    if (!field) return null;
    const selected = config.measures.filter(item => 'fieldId' in item && item.fieldId === field.id);
    if (selected.length && (settings.isError || result.isError)) return <span className="text-xs text-muted" title={t('genericReports.tableAggregates.totalsLoadError')}>{t('genericReports.tableAggregates.unavailable')}</span>;
    const key = group ? group.kind === 'assignee' ? group.membershipId === null ? 'unassigned' : group.membershipId : group.sectionId ?? 'no_section' : null;
    const groupResult = group && currentTotals?.groups.find(item => item.key === key || item.key === group.key);
    const total = !group ? currentTotals?.measures : groupResult?.measures;
    const safeResult = currentTotals !== undefined;
    return <div className="flex flex-col items-end">{(selected.length ? selected : [null]).map(measure => <ColumnAggregateCell key={measure?.key ?? 'empty'} fieldName={field.name} operation={measure && measure.operation !== 'count_tasks' ? measure.operation : null} result={safeResult && measure ? total?.find(item => item.key === measure.key) : undefined} writable={writable} disabled={!settings.isSuccess || settings.isFetching || held || edit !== null || command.hasOtherProtectedCommands()} state={unsupported || !readable || result.isError ? 'unavailable' : !safeResult && (settings.isFetching || result.isFetching) ? 'loading' : 'ready'} onChange={operation => { if (settings.data) command.mutate({ input: { expectedRevision: settings.data.revision, measures: replaceColumnOperation(settings.data.measures, field.id, operation, measure?.key) } }, { onError: () => setOpen(true) }); }} />)}</div>;
  };
  const renderGroupMetadata = (group: TableTaskGroup): ReactNode => {
    if (!readable || unsupported) return null;
    const currentSettings = settings.data;
    const widgetGroup = group.kind === 'assignee' ? { kind: 'assignee' as const, membershipId: group.membershipId } : { kind: 'section' as const, sectionId: group.sectionId };
    if (headerResult.isError && currentSettings.headerWidgets?.some(rule => sameWidgetGroup(rule.group, widgetGroup) && rule.widgets.length > 0)) return <span role="status" className="text-xs text-muted" title={t('genericReports.tableAggregates.headersLoadError')}>{t('genericReports.tableAggregates.unavailable')}</span>;
    const title = group.kind === 'assignee' ? group.member?.displayName ?? t('genericReports.unassigned') : group.section?.name ?? t('genericReports.noSection');
    return <HeaderWidgets templateController={templateController} templateChecks={templateCheckSettings.data?.config.rules??[]} templateChecksReady={templateCheckSettings.isSuccess&&!templateCheckSettings.isFetching} group={widgetGroup} title={title} projectDateRange={projectDateRange ?? null} rules={currentSettings.headerWidgets ?? []} revision={currentSettings.revision} result={currentHeaders} fields={fields} members={members} workspaceId={workspaceId} writable={writable} disabled={settings.isFetching || held || edit !== null || command.hasOtherProtectedCommands()} loading={currentHeaders === undefined && (settings.isFetching || headerResult.isFetching)} uncertain={command.uncertain !== null} onRetry={onSuccess => command.retryUncertain({ onSuccess })} feedback={<SaveFeedback error={command.error} uncertainError={command.uncertain?.error ?? null} subject="fieldValueSave"/>} onSave={(widgets, revision, onSuccess) => { command.mutate({ input: { expectedRevision: revision, measures: currentSettings.measures, headerWidgets: replaceHeaderWidgets(currentSettings.headerWidgets ?? [], widgetGroup, widgets) } }, { onSuccess }); }} />;
  };
  return { panel, footer: renderLine(), renderColumn, renderGroupMetadata, templateController };

}
