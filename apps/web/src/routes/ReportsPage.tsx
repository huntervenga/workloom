import { useQueryClient } from '@tanstack/react-query';
import { queryKeys } from '../lib/queryKeys';
import { useState, useSyncExternalStore } from 'react';
import { protectedDraftsFor } from '../lib/protectedDrafts';
import { protectedCommandsFor } from '../lib/protectedCommands';
import { Link, useParams, useSearchParams } from 'react-router';
import { Button, TextInput, buttonClassName } from '@workloom/ui';
import { createGenericReportInputSchema, type GenericReportConfig, type GenericReportDefinitionDto, type ProjectDto } from '@workloom/contracts';
import { useTranslation } from '../i18n';
import { useWorkspaceContext } from './WorkspaceLayout';
import { useProjectQuery, useSectionsQuery } from '../features/projects/queries';
import { useMembershipsQuery } from '../features/workspace/queries';
import { useTagsQuery } from '../features/tasks/queries';
import { useProjectColumnsQuery, useTaskFieldsQuery } from '../features/fields';
import { emptyReportConfig, ReportConfigEditor, ReportSelect } from '../features/generic-reports/ReportConfigEditor';
import { ReportDashboardPanels } from '../features/generic-reports/ReportDashboardPanels';
import { ReportQuickFilters } from '../features/generic-reports/ReportQuickFilters';
import { ReportResults } from '../features/generic-reports/ReportResults';
import { useAggregates, useCurrentReportAccess, useInitialSnapshots, useReport, useReportCommands, useReportResult, useReports } from '../features/generic-reports/queries';
import { PlanFactTemplate } from '../features/generic-reports/PlanFactTemplate';
import { SaveFeedback } from '../shared/SaveFeedback';
import { QueryErrorState } from '../shared/QueryErrorState';
import { useProtectedDraft } from '../lib/protectedDrafts';
import { isAccessDenied } from '../lib/api';
import { isUuid } from '../lib/format';
import { useDocumentTitle } from '../lib/useDocumentTitle';

export function ReportsPage() {
  const { t } = useTranslation();
  const { actorId, workspace } = useWorkspaceContext(), { projectId = '' } = useParams();
  const project = useProjectQuery(actorId, workspace.id, projectId);
  useDocumentTitle(t('genericReports.reports'));
  if (!isUuid(projectId)) return <p role="alert">{t('genericReports.unavailable')}</p>;
  if (project.isError) return <QueryErrorState error={project.error} subject="project" headingLevel={1} onRetry={() => void project.refetch()}/>;
  if (!project.data) return <p role="status">{t('genericReports.loading')}</p>;
  return <ReportsIdentity key={`${actorId}:${workspace.id}:${projectId}`} actorId={actorId} workspaceId={workspace.id} project={project.data} writable={workspace.role !== 'viewer' && !project.isFetching && project.data.archivedAt === null}/>;
}
/** URL navigation can change report identity without changing pathname. Retain protected forms until resolved. */
function ReportsIdentity(props: {actorId:string;workspaceId:string;project:ProjectDto;writable:boolean}){
 const {t}=useTranslation(),client=useQueryClient(),[params]=useSearchParams();
 const reports=useReports(props.actorId,props.workspaceId,props.project.id);
 const first=reports.data?.find(report=>report.archivedAt===null&&report.workspaceId===props.workspaceId&&report.projectId===props.project.id&&report.config.projectId===props.project.id);
 const desired=isUuid(params.get('report')??'')?params.get('report')??'':first?.id??'';
 const drafts=protectedDraftsFor(client),commands=protectedCommandsFor(client),dirty=useSyncExternalStore(drafts.subscribe,drafts.getSnapshot),held=useSyncExternalStore(commands.subscribe,commands.getSnapshot);
 const [active,setActive]=useState(desired);
 if(active!==desired&&!dirty&&!held)setActive(desired);
 return <>{active!==desired&&(dirty||held)?<p role="status" className="text-xs text-muted">{t('genericReports.finishCurrentReport')}</p>:null}<ReportsContent key={active} {...props} selectedId={active}/></>;
}
interface Edit { id: string | null; revision: number; name: string; config: GenericReportConfig }
function ReportsContent({ actorId, workspaceId, project, writable, selectedId }: { actorId: string; workspaceId: string; project: ProjectDto; writable: boolean; selectedId: string }) {
  const { t } = useTranslation();
  const [, setParams] = useSearchParams();
  const reports = useReports(actorId, workspaceId, project.id);
  const setSelectedId = (id: string) => setParams(before => { const next = new URLSearchParams(before); if (id) next.set('report', id); else next.delete('report'); return next; });
  const [quickConfig, setQuickConfig] = useState<GenericReportConfig | null>(null);
  const [edit, setEdit] = useState<Edit | null>(null);
  const [snapshotId, setSnapshotId] = useState(''), [offset, setOffset] = useState(0), [sourceVersion, setSourceVersion] = useState<string | undefined>();
  const [captureName, setCaptureName] = useState(''), [captureOpen, setCaptureOpen] = useState(false), [invalid, setInvalid] = useState(false);
  const definition = useReport(actorId, workspaceId, selectedId);
  const fields = useTaskFieldsQuery(actorId, workspaceId, project.id), members = useMembershipsQuery(actorId, workspaceId), tags = useTagsQuery(actorId, workspaceId);
  const sections = useSectionsQuery(actorId, workspaceId, project.id);
  const columns = useProjectColumnsQuery(actorId, workspaceId, project.id);
  const client = useQueryClient();
  const commands = useReportCommands(actorId, workspaceId, project.id);
  const access = useCurrentReportAccess(actorId, workspaceId, project.id);
  const current = definition.isSuccess && !definition.isError && definition.data.workspaceId === workspaceId && definition.data.projectId === project.id && definition.data.config.projectId === project.id ? definition.data : null;
  const scopeMismatch = definition.isSuccess && current === null;
  const snapshots = useInitialSnapshots(actorId, workspaceId, current?.id ?? '');
  const savedResult = useReportResult(actorId, workspaceId, selectedId, { expectedRevision: current?.revision ?? 1, snapshotId: snapshotId || null, offset, limit: 100, ...(sourceVersion ? { expectedSourceVersion: sourceVersion } : {}) }, current !== null && !definition.isFetching && edit === null && quickConfig === null);
  const filteredResult = useAggregates(actorId, workspaceId, project.id, { config: quickConfig ?? current?.config ?? emptyReportConfig(project.id), offset, limit: 100, ...(sourceVersion ? { expectedSourceVersion: sourceVersion } : {}) }, current !== null && !definition.isFetching && edit === null && quickConfig !== null);
  const result = quickConfig === null ? savedResult : filteredResult;
  const commandList = [commands.create, commands.update, commands.capture, commands.template];
  const held = commandList.some(command => command.pendingCommand !== null || command.uncertain !== null);
  const denied = [reports.error, definition.error, fields.error, members.error, tags.error, columns.error, snapshots.error, result.error, ...commandList.map(command => command.error)].some(isAccessDenied);
  const canWrite = writable && (access === 'owner' || access === 'admin') && !denied && reports.isSuccess && fields.isSuccess && !fields.isFetching && !members.isFetching;
  const resetPage = () => { setOffset(0); setSourceVersion(undefined); };
  const refreshResult = () => { resetPage(); void definition.refetch(); if (offset === 0 && sourceVersion === undefined) void result.refetch(); };
  const reloadAccess = () => { for (const command of commandList) if (!command.uncertain && !command.pendingCommand) command.reset(); void client.invalidateQueries({ queryKey: queryKeys.workspace(actorId, workspaceId), exact: true }); void client.invalidateQueries({ queryKey: queryKeys.project(actorId, workspaceId, project.id) }); void fields.refetch(); void reports.refetch(); if (selectedId) void definition.refetch(); };
  const choose = (id: string) => { if (edit || held || captureName !== '') return; setSelectedId(id); setQuickConfig(null); setSnapshotId(''); resetPage(); setCaptureOpen(false); };
  const saved = (report: GenericReportDefinitionDto) => { setEdit(null); setQuickConfig(null); setSelectedId(report.id); resetPage(); setInvalid(false); };
  useProtectedDraft(edit !== null || captureName !== '');
  const startNew = () => { if (!canWrite || edit || held || captureName !== '') return; setEdit({ id: null, revision: 0, name: '', config: emptyReportConfig(project.id) }); setCaptureOpen(false); };
  const save = () => {
    if (!edit || !canWrite || held || edit.config.projectId !== project.id || (edit.id !== null && current?.id !== edit.id) || commands.create.hasOtherProtectedCommands()) return;
    if (!createGenericReportInputSchema.safeParse({ name: edit.name, config: edit.config }).success) { setInvalid(true); return; }
    setInvalid(false);
    if (edit.id === null) commands.create.mutate({ input: { name: edit.name, config: edit.config } }, { onSuccess: saved });
    else commands.update.mutate({ reportId: edit.id, input: { expectedRevision: edit.revision, name: edit.name, config: edit.config, archived: false } }, { onSuccess: saved });
  };
  const selectPerson = (membershipId: string | null) => { if (!current || snapshotId || held || captureOpen) return; const base=quickConfig ?? current.config; setQuickConfig({...base,filters:{...base.filters,assignee:membershipId===null?{kind:'unassigned'}:{kind:'member',membershipId}}}); resetPage(); };
  const referencedIds = current ? [...current.config.measures.flatMap(measure => 'fieldId' in measure ? [measure.fieldId] : []), ...(current.config.comparison ? [current.config.comparison.planFieldId, current.config.comparison.factFieldId] : []), ...(current.config.groupBy.kind === 'category' ? [current.config.groupBy.fieldId] : []), ...(current.config.filters.dateRange?.source.kind === 'field' ? [current.config.filters.dateRange.source.fieldId] : [])] : [];
  const unavailableFields = fields.isSuccess && referencedIds.some(id => !fields.data.some(field => field.id === id && field.archivedAt === null));
  const listError = reports.error ?? fields.error ?? members.error ?? tags.error;
  return <div className="min-w-0 space-y-3 pb-8">
    <header className="flex min-w-0 items-center gap-3"><div className="min-w-0 flex-1"><Link to={`/w/${workspaceId}`} className="mb-1 inline-flex text-xs text-muted hover:text-ink">{t('projects.projectPage.backToProjects')}</Link><h1 title={project.name} className="truncate text-xl font-semibold tracking-tight text-ink">{project.name}</h1></div></header>
    <nav aria-label={t('projects.projectPage.projectViews')} className="flex flex-nowrap gap-1 overflow-x-auto border-b border-line pb-2">{(['tasks','board','graph','timeline'] as const).map(view => <Link key={view} to={`/w/${workspaceId}/projects/${project.id}${view === 'tasks' ? '' : `?view=${view === 'timeline' ? 'gantt' : view}`}`} className={buttonClassName({ size: 'sm', variant: 'ghost' })}>{t(view === 'tasks' ? 'projects.projectPage.tasks' : view === 'board' ? 'projects.projectPage.board' : view === 'graph' ? 'projects.projectPage.graph' : 'projects.projectPage.timeline')}</Link>)}<Link to={`/w/${workspaceId}/projects/${project.id}/reports${selectedId ? `?report=${selectedId}` : ''}`} aria-current="page" className={buttonClassName({size:'sm',variant:'primary'})}>{t('genericReports.reports')}</Link></nav>
    <div className="flex flex-wrap items-end gap-2"><div className="min-w-48 max-w-96 flex-1"><ReportSelect label={t('genericReports.savedReports')} value={selectedId} disabled={edit !== null || held || captureName !== ''} onChange={choose}><option value="">{t('genericReports.chooseReport')}</option>{(!reports.isError ? reports.data : [])?.filter(report => report.archivedAt === null && report.workspaceId === workspaceId && report.projectId === project.id && report.config.projectId === project.id).map(report => <option key={report.id} value={report.id}>{report.name}</option>)}</ReportSelect></div><Button size="sm" disabled={!canWrite || edit !== null || held || captureName !== ''} onClick={startNew}>{t('genericReports.newReport')}</Button>{current && edit===null ? <div className="flex flex-wrap items-center gap-2"><h2 className="sr-only">{current.name}</h2><Button size="sm" variant="ghost" disabled={!canWrite || held || definition.isFetching || captureName !== ''} onClick={() => { setQuickConfig(null); setEdit({ id: current.id, revision: current.revision, name: current.name, config: structuredClone(current.config) }); }}>{t('genericReports.editReport')}</Button><Button size="sm" variant="ghost" disabled={held || result.isFetching} onClick={() => { refreshResult(); }}>{t('genericReports.runReport')}</Button></div> : null}</div>
    {denied ? <Button size="sm" variant="ghost" disabled={held} onClick={reloadAccess}>{t('genericReports.reloadAccess')}</Button> : null}
    {listError ? <QueryErrorState error={listError} subject="fields" headingLevel={2} onRetry={() => { void reports.refetch(); void fields.refetch(); void members.refetch(); void tags.refetch(); }}/> : null}
    {!selectedId && !edit && reports.isSuccess ? <p className="text-sm text-muted">{t(reports.data.length ? 'genericReports.selectHint' : 'genericReports.noReports')}</p> : null}
    {scopeMismatch ? <p role="alert" className="rounded-lg border border-line p-3 text-sm text-muted">{t('genericReports.wrongProject')}</p> : null}
    {definition.isError ? <QueryErrorState error={definition.error} subject="project" headingLevel={2} onRetry={() => void definition.refetch()}/> : null}
    {edit ? <section aria-label={t('genericReports.reportEditor')} className="space-y-4 rounded-xl border border-line bg-surface p-4">
      <label className="grid gap-1 text-sm">{t('genericReports.reportName')}<TextInput value={edit.name} maxLength={160} disabled={held || !canWrite} onChange={event => setEdit({ ...edit, name: event.target.value })}/></label>
      {current && current.id === edit.id && current.revision !== edit.revision ? <p role="status" className="text-sm text-muted">{t('genericReports.staleDraft')}</p> : null}
      <ReportConfigEditor config={edit.config} onChange={config => setEdit({ ...edit, config })} fields={fields.isSuccess ? fields.data : []} members={members.isSuccess ? members.data : []} tags={tags.isSuccess ? tags.data : []} disabled={held || !canWrite}/>
      {invalid ? <p role="alert" className="text-sm text-danger">{t('genericReports.invalid')}</p> : null}
      <div className="flex flex-wrap gap-2"><Button disabled={!canWrite || held} onClick={save}>{t('genericReports.saveReport')}</Button><Button variant="ghost" disabled={held} onClick={() => { setEdit(null); setInvalid(false); commands.create.reset(); commands.update.reset(); }}>{t('genericReports.discard')}</Button></div>
    </section> : null}
    {[commands.create, commands.update].map((command, index) => <div key={index}><SaveFeedback error={command.error} uncertainError={command.uncertain?.error ?? null} subject="fieldValueSave"/>{command.uncertain ? <Button disabled={!canWrite || command.pendingCommand !== null || ('reportId' in command.uncertain.variables && command.uncertain.variables.reportId !== current?.id)} onClick={() => command.retryUncertain({ onSuccess: saved })}>{t('genericReports.retry')}</Button> : null}</div>)}
    {unavailableFields ? <p role="status" className="rounded-lg border border-line p-3 text-sm text-muted">{t('genericReports.unavailableFieldHint')}</p> : null}
    {current && edit === null && !definition.isError ? <>
      <ReportQuickFilters key={`${current.id}:${current.revision}:${JSON.stringify(quickConfig?.filters ?? current.config.filters)}`} config={quickConfig ?? current.config} originalConfig={current.config} members={members.data ?? []} fields={fields.data ?? []} disabled={held || result.isFetching || captureOpen || snapshotId !== ''} onApply={config => { setQuickConfig(config); resetPage(); }} onReset={() => { setQuickConfig(null); resetPage(); }}/>
      {quickConfig ? <p role="status" className="sr-only">{t('genericReports.temporaryFilters')}</p> : null}
      {result.isError ? <QueryErrorState error={result.error} subject="fields" headingLevel={2} onRetry={() => { refreshResult(); }}/> : !result.data ? <p role="status">{t('genericReports.calculating')}</p> : !denied ? <>{result.isFetching ? <span role="status" className="sr-only">{t('genericReports.calculating')}</span> : null}<ReportResults result={result.data} {...(!snapshotId ? {...(!captureOpen && !held ? {onPersonSelect: selectPerson} : {}),extraCharts:<ReportDashboardPanels key={`${current.id}:${current.revision}`} actorId={actorId} workspaceId={workspaceId} projectId={project.id} result={result.data} members={members.data ?? []} sections={sections.data ?? []} fields={fields.data ?? []} disabled={captureOpen || held} onPersonSelect={selectPerson}/>} : {})} workspaceId={workspaceId} members={members.data ?? []} sections={sections.data ?? []} tags={tags.data ?? []}/><div className="flex items-center gap-3"><Button size="sm" variant="ghost" disabled={offset === 0} onClick={() => { setOffset(0); setSourceVersion(undefined); }}>{t('genericReports.firstPage')}</Button><span className="text-xs text-muted">{t('genericReports.showing', { from: result.data.offset + (result.data.rows.length ? 1 : 0), to: result.data.offset + result.data.rows.length, total: result.data.totalTasks })}</span>{result.data.nextOffset !== null ? <Button size="sm" onClick={() => { if (result.data.nextOffset !== null) { setSourceVersion(result.data.sourceVersion); setOffset(result.data.nextOffset); } }}>{t('genericReports.nextPage')}</Button> : null}</div></> : null}
      <details className="rounded-lg border border-line px-3 py-2"><summary className="cursor-pointer text-sm text-muted">{t('genericReports.snapshotTools')}</summary><div className="mt-2 flex flex-wrap items-end gap-2"><div className="min-w-48 flex-1"><ReportSelect label={t('genericReports.initialSnapshot')} value={snapshotId} disabled={held || quickConfig !== null} onChange={id => { setSnapshotId(id); resetPage(); }}><option value="">{t('genericReports.currentOnly')}</option>{snapshots.data?.map(snapshot => <option key={snapshot.id} value={snapshot.id}>{snapshot.name}</option>)}</ReportSelect></div><Button size="sm" variant="ghost" disabled={!canWrite || held || quickConfig !== null || snapshotId !== '' || !result.isSuccess || result.isFetching} onClick={() => setCaptureOpen(true)}>{t('genericReports.capture')}</Button></div>
      {snapshots.isError ? <QueryErrorState error={snapshots.error} subject="project" headingLevel={2} onRetry={() => void snapshots.refetch()}/> : null}
      {snapshotId ? <p className="text-xs text-muted">{t('genericReports.captureCurrentHint')}</p> : null}
      {captureOpen ? <form className="flex flex-wrap items-end gap-2 rounded-lg border border-line p-3" onSubmit={event => { event.preventDefault(); if (snapshotId === '' && quickConfig === null && canWrite && !held && !commands.capture.hasOtherProtectedCommands() && result.isSuccess && !result.isFetching && captureName.trim()) commands.capture.mutate({ reportId: current.id, input: { name: captureName, expectedRevision: current.revision, expectedSourceVersion: result.data.sourceVersion } }, { onSuccess: snapshot => { setCaptureOpen(false); setCaptureName(''); setSnapshotId(snapshot.id); resetPage(); } }); }}><label className="grid min-w-48 flex-1 gap-1 text-sm">{t('genericReports.snapshotName')}<TextInput value={captureName} disabled={held} maxLength={160} onChange={event => setCaptureName(event.target.value)}/></label><Button type="submit" disabled={!canWrite || held || !captureName.trim()}>{t('genericReports.confirmCapture')}</Button><Button variant="ghost" disabled={held} onClick={() => { setCaptureOpen(false); setCaptureName(''); }}>{t('common.cancel')}</Button><p className="basis-full text-xs text-muted">{t('genericReports.captureHint')}</p></form> : null}
      <SaveFeedback error={commands.capture.error} uncertainError={commands.capture.uncertain?.error ?? null} subject="fieldValueSave"/>{commands.capture.uncertain ? <Button disabled={!canWrite || commands.capture.pendingCommand !== null} onClick={() => commands.capture.retryUncertain({ onSuccess: snapshot => { setCaptureOpen(false); setCaptureName(''); setSnapshotId(snapshot.id); resetPage(); } })}>{t('genericReports.retry')}</Button> : null}
      </details>
    </> : null}
    <details className="rounded-lg border border-line px-3 py-2"><summary className="cursor-pointer text-sm text-muted">{t('genericReports.setupTools')}</summary><div className="pt-2"><PlanFactTemplate actorId={actorId} workspaceId={workspaceId} project={project} writable={canWrite && (access === 'owner' || access === 'admin') && edit === null} columns={columns.isSuccess && !columns.isFetching ? columns.data : undefined} fields={fields.isSuccess && !fields.isFetching ? fields.data : undefined} command={commands.template} onCreated={saved}/></div></details>
  </div>;
}
