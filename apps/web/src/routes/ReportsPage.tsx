import { useQueryClient } from '@tanstack/react-query';
import { queryKeys } from '../lib/queryKeys';
import { useState } from 'react';
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
import { ReportResults } from '../features/generic-reports/ReportResults';
import { useCurrentReportAccess, useInitialSnapshots, useReport, useReportCommands, useReportResult, useReports } from '../features/generic-reports/queries';
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
  return <ReportsContent key={`${actorId}:${workspace.id}:${projectId}`} actorId={actorId} workspaceId={workspace.id} project={project.data} writable={workspace.role !== 'viewer' && !project.isFetching && project.data.archivedAt === null}/>;
}
interface Edit { id: string | null; revision: number; name: string; config: GenericReportConfig }
function ReportsContent({ actorId, workspaceId, project, writable }: { actorId: string; workspaceId: string; project: ProjectDto; writable: boolean }) {
  const { t } = useTranslation();
  const [params, setParams] = useSearchParams();
  const selectedId = isUuid(params.get('report') ?? '') ? params.get('report') ?? '' : '';
  const setSelectedId = (id: string) => setParams(before => { const next = new URLSearchParams(before); if (id) next.set('report', id); else next.delete('report'); return next; });
  const [edit, setEdit] = useState<Edit | null>(null);
  const [snapshotId, setSnapshotId] = useState(''), [offset, setOffset] = useState(0), [sourceVersion, setSourceVersion] = useState<string | undefined>();
  const [captureName, setCaptureName] = useState(''), [captureOpen, setCaptureOpen] = useState(false), [invalid, setInvalid] = useState(false);
  const reports = useReports(actorId, workspaceId, project.id), definition = useReport(actorId, workspaceId, selectedId);
  const fields = useTaskFieldsQuery(actorId, workspaceId, project.id), members = useMembershipsQuery(actorId, workspaceId), tags = useTagsQuery(actorId, workspaceId);
  const sections = useSectionsQuery(actorId, workspaceId, project.id);
  const columns = useProjectColumnsQuery(actorId, workspaceId, project.id);
  const client = useQueryClient();
  const commands = useReportCommands(actorId, workspaceId, project.id);
  const access = useCurrentReportAccess(actorId, workspaceId, project.id);
  const current = definition.isSuccess && !definition.isError && definition.data.workspaceId === workspaceId && definition.data.projectId === project.id && definition.data.config.projectId === project.id ? definition.data : null;
  const scopeMismatch = definition.isSuccess && current === null;
  const snapshots = useInitialSnapshots(actorId, workspaceId, current?.id ?? '');
  const result = useReportResult(actorId, workspaceId, selectedId, { expectedRevision: current?.revision ?? 1, snapshotId: snapshotId || null, offset, limit: 100, ...(sourceVersion ? { expectedSourceVersion: sourceVersion } : {}) }, current !== null && !definition.isFetching && edit === null);
  const commandList = [commands.create, commands.update, commands.capture, commands.template];
  const held = commandList.some(command => command.pendingCommand !== null || command.uncertain !== null);
  const denied = [reports.error, definition.error, fields.error, members.error, tags.error, columns.error, snapshots.error, result.error, ...commandList.map(command => command.error)].some(isAccessDenied);
  const canWrite = writable && (access === 'owner' || access === 'admin') && !denied && reports.isSuccess && fields.isSuccess && !fields.isFetching && !members.isFetching;
  const resetPage = () => { setOffset(0); setSourceVersion(undefined); };
  const refreshResult = () => { resetPage(); void definition.refetch(); if (offset === 0 && sourceVersion === undefined) void result.refetch(); };
  const reloadAccess = () => { for (const command of commandList) if (!command.uncertain && !command.pendingCommand) command.reset(); void client.invalidateQueries({ queryKey: queryKeys.workspace(actorId, workspaceId), exact: true }); void client.invalidateQueries({ queryKey: queryKeys.project(actorId, workspaceId, project.id) }); void fields.refetch(); void reports.refetch(); if (selectedId) void definition.refetch(); };
  const choose = (id: string) => { if (edit || held) return; setSelectedId(id); setSnapshotId(''); resetPage(); setCaptureOpen(false); };
  const saved = (report: GenericReportDefinitionDto) => { setEdit(null); setSelectedId(report.id); resetPage(); setInvalid(false); };
  useProtectedDraft(edit !== null || captureName !== '');
  const startNew = () => { if (!canWrite || edit || held) return; setEdit({ id: null, revision: 0, name: '', config: emptyReportConfig(project.id) }); setCaptureOpen(false); };
  const save = () => {
    if (!edit || !canWrite || held || edit.config.projectId !== project.id || (edit.id !== null && current?.id !== edit.id) || commands.create.hasOtherProtectedCommands()) return;
    if (!createGenericReportInputSchema.safeParse({ name: edit.name, config: edit.config }).success) { setInvalid(true); return; }
    setInvalid(false);
    if (edit.id === null) commands.create.mutate({ input: { name: edit.name, config: edit.config } }, { onSuccess: saved });
    else commands.update.mutate({ reportId: edit.id, input: { expectedRevision: edit.revision, name: edit.name, config: edit.config, archived: false } }, { onSuccess: saved });
  };
  const referencedIds = current ? [...current.config.measures.flatMap(measure => 'fieldId' in measure ? [measure.fieldId] : []), ...(current.config.comparison ? [current.config.comparison.planFieldId, current.config.comparison.factFieldId] : []), ...(current.config.groupBy.kind === 'category' ? [current.config.groupBy.fieldId] : []), ...(current.config.filters.dateRange?.source.kind === 'field' ? [current.config.filters.dateRange.source.fieldId] : [])] : [];
  const unavailableFields = fields.isSuccess && referencedIds.some(id => !fields.data.some(field => field.id === id && field.archivedAt === null));
  const listError = reports.error ?? fields.error ?? members.error ?? tags.error;
  return <div className="min-w-0 space-y-5">
    <header className="flex flex-wrap items-center justify-between gap-3"><div><p className="text-xs text-muted">{project.name}</p><h1 className="text-xl font-semibold">{t('genericReports.reports')}</h1></div><Link to={`/w/${workspaceId}/projects/${project.id}`} className={buttonClassName({ size: 'sm', variant: 'ghost' })}>{t('genericReports.backTasks')}</Link></header>
    <div className="flex flex-wrap items-end gap-2"><div className="min-w-48 flex-1"><ReportSelect label={t('genericReports.savedReports')} value={selectedId} disabled={edit !== null || held} onChange={choose}><option value="">{t('genericReports.chooseReport')}</option>{(!reports.isError ? reports.data : [])?.filter(report => report.archivedAt === null && report.workspaceId === workspaceId && report.projectId === project.id && report.config.projectId === project.id).map(report => <option key={report.id} value={report.id}>{report.name}</option>)}</ReportSelect></div><Button size="sm" disabled={!canWrite || edit !== null || held} onClick={startNew}>{t('genericReports.newReport')}</Button></div>
    {denied ? <Button size="sm" variant="ghost" disabled={held} onClick={reloadAccess}>{t('genericReports.reloadAccess')}</Button> : null}
    {listError ? <QueryErrorState error={listError} subject="fields" headingLevel={2} onRetry={() => { void reports.refetch(); void fields.refetch(); void members.refetch(); void tags.refetch(); }}/> : null}
    {!selectedId && !edit && reports.isSuccess ? <p className="text-sm text-muted">{t(reports.data.length ? 'genericReports.selectHint' : 'genericReports.noReports')}</p> : null}
    <PlanFactTemplate actorId={actorId} workspaceId={workspaceId} project={project} writable={canWrite && (access === 'owner' || access === 'admin') && edit === null} columns={columns.isSuccess && !columns.isFetching ? columns.data : undefined} fields={fields.isSuccess && !fields.isFetching ? fields.data : undefined} command={commands.template} onCreated={saved}/>
    {scopeMismatch ? <p role="alert" className="rounded-lg border border-line p-3 text-sm text-muted">{t('genericReports.wrongProject')}</p> : null}
    {definition.isError ? <QueryErrorState error={definition.error} subject="project" headingLevel={2} onRetry={() => void definition.refetch()}/> : null}
    {edit ? <section aria-label={t('genericReports.reportEditor')} className="space-y-4 rounded-xl border border-line bg-surface p-4">
      <label className="grid gap-1 text-sm">{t('genericReports.reportName')}<TextInput value={edit.name} maxLength={160} disabled={held || !canWrite} onChange={event => setEdit({ ...edit, name: event.target.value })}/></label>
      {current && current.id === edit.id && current.revision !== edit.revision ? <p role="status" className="text-sm text-muted">{t('genericReports.staleDraft')}</p> : null}
      <ReportConfigEditor config={edit.config} onChange={config => setEdit({ ...edit, config })} fields={fields.isSuccess ? fields.data : []} members={members.isSuccess ? members.data : []} tags={tags.isSuccess ? tags.data : []} disabled={held || !canWrite}/>
      {invalid ? <p role="alert" className="text-sm text-danger">{t('genericReports.invalid')}</p> : null}
      <div className="flex flex-wrap gap-2"><Button disabled={!canWrite || held} onClick={save}>{t('genericReports.saveReport')}</Button><Button variant="ghost" disabled={held} onClick={() => { setEdit(null); setInvalid(false); commands.create.reset(); commands.update.reset(); }}>{t('genericReports.discard')}</Button></div>
    </section> : current ? <div className="flex flex-wrap items-center gap-2"><h2 className="mr-auto text-lg font-medium">{current.name}</h2><Button size="sm" variant="ghost" disabled={!canWrite || held || definition.isFetching} onClick={() => setEdit({ id: current.id, revision: current.revision, name: current.name, config: structuredClone(current.config) })}>{t('genericReports.editReport')}</Button><Button size="sm" variant="ghost" disabled={held || result.isFetching} onClick={() => { refreshResult(); }}>{t('genericReports.runReport')}</Button></div> : null}
    {[commands.create, commands.update].map((command, index) => <div key={index}><SaveFeedback error={command.error} uncertainError={command.uncertain?.error ?? null} subject="fieldValueSave"/>{command.uncertain ? <Button disabled={!canWrite || command.pendingCommand !== null || ('reportId' in command.uncertain.variables && command.uncertain.variables.reportId !== current?.id)} onClick={() => command.retryUncertain({ onSuccess: saved })}>{t('genericReports.retry')}</Button> : null}</div>)}
    {unavailableFields ? <p role="status" className="rounded-lg border border-line p-3 text-sm text-muted">{t('genericReports.unavailableFieldHint')}</p> : null}
    {current && edit === null && !definition.isError ? <>
      <div className="flex flex-wrap items-end gap-2"><div className="min-w-48 flex-1"><ReportSelect label={t('genericReports.initialSnapshot')} value={snapshotId} disabled={held} onChange={id => { setSnapshotId(id); resetPage(); }}><option value="">{t('genericReports.currentOnly')}</option>{snapshots.data?.map(snapshot => <option key={snapshot.id} value={snapshot.id}>{snapshot.name}</option>)}</ReportSelect></div><Button size="sm" variant="ghost" disabled={!canWrite || held || snapshotId !== '' || !result.isSuccess || result.isFetching} onClick={() => setCaptureOpen(true)}>{t('genericReports.capture')}</Button></div>
      {snapshots.isError ? <QueryErrorState error={snapshots.error} subject="project" headingLevel={2} onRetry={() => void snapshots.refetch()}/> : null}
      {snapshotId ? <p className="text-xs text-muted">{t('genericReports.captureCurrentHint')}</p> : null}
      {captureOpen ? <form className="flex flex-wrap items-end gap-2 rounded-lg border border-line p-3" onSubmit={event => { event.preventDefault(); if (snapshotId === '' && canWrite && !held && !commands.capture.hasOtherProtectedCommands() && result.isSuccess && !result.isFetching && captureName.trim()) commands.capture.mutate({ reportId: current.id, input: { name: captureName, expectedRevision: current.revision, expectedSourceVersion: result.data.sourceVersion } }, { onSuccess: snapshot => { setCaptureOpen(false); setCaptureName(''); setSnapshotId(snapshot.id); resetPage(); } }); }}><label className="grid min-w-48 flex-1 gap-1 text-sm">{t('genericReports.snapshotName')}<TextInput value={captureName} disabled={held} maxLength={160} onChange={event => setCaptureName(event.target.value)}/></label><Button type="submit" disabled={!canWrite || held || !captureName.trim()}>{t('genericReports.confirmCapture')}</Button><Button variant="ghost" disabled={held} onClick={() => { setCaptureOpen(false); setCaptureName(''); }}>{t('common.cancel')}</Button><p className="basis-full text-xs text-muted">{t('genericReports.captureHint')}</p></form> : null}
      <SaveFeedback error={commands.capture.error} uncertainError={commands.capture.uncertain?.error ?? null} subject="fieldValueSave"/>{commands.capture.uncertain ? <Button disabled={!canWrite || commands.capture.pendingCommand !== null} onClick={() => commands.capture.retryUncertain({ onSuccess: snapshot => { setCaptureOpen(false); setCaptureName(''); setSnapshotId(snapshot.id); resetPage(); } })}>{t('genericReports.retry')}</Button> : null}
      {result.isError ? <QueryErrorState error={result.error} subject="fields" headingLevel={2} onRetry={() => { refreshResult(); }}/> : result.isFetching || !result.data ? <p role="status">{t('genericReports.calculating')}</p> : !denied ? <><ReportResults result={result.data} workspaceId={workspaceId} members={members.data ?? []} sections={sections.data ?? []} tags={tags.data ?? []}/><div className="flex items-center gap-3"><Button size="sm" variant="ghost" disabled={offset === 0} onClick={() => { setOffset(0); setSourceVersion(undefined); }}>{t('genericReports.firstPage')}</Button><span className="text-xs text-muted">{t('genericReports.showing', { from: result.data.offset + (result.data.rows.length ? 1 : 0), to: result.data.offset + result.data.rows.length, total: result.data.totalTasks })}</span>{result.data.nextOffset !== null ? <Button size="sm" onClick={() => { if (result.data.nextOffset !== null) { setSourceVersion(result.data.sourceVersion); setOffset(result.data.nextOffset); } }}>{t('genericReports.nextPage')}</Button> : null}</div></> : null}
    </> : null}
  </div>;
}
