import { orderExportFiles } from './classifyExport';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Button } from '@workloom/ui';
import { FileUp } from 'lucide-react';
import { useRef, useState } from 'react';
import { useTranslation } from '../../i18n';
import { ApiError, isUncertainOutcome, sendMutation, type AssigneeConflict } from '../../lib/api';
import { fetchProjectRules, setProjectRulesRequest } from '../project-rules/api';
import { queryKeys } from '../../lib/queryKeys';
import { DialogShell } from '../../shared/DialogShell';
import { BusyOverlay } from '../projects/ProjectArchive';
import { invalidateProjectList } from '../projects/queries';
import { WorkspaceLink } from '../workspace/WorkspaceNavigation';
import { defaultChoices, choicesComplete, toActions, UnmatchedAssignees, type AssigneeChoice } from './UnmatchedAssignees';
import { applyAsanaImport, fetchAsanaImportCapability, fileBase64, MAX_ASANA_FILE_BYTES, previewAsanaImport, type AsanaImportResult, type AsanaUpload } from './api';

interface Props { actorId: string; workspaceId: string; isOwner: boolean }
export function AsanaImportButton(props: Props) {
  const capability = useQuery({
    queryKey: [...queryKeys.workspace(props.actorId, props.workspaceId), 'dev-asana-import'],
    queryFn: ({ signal }) => fetchAsanaImportCapability(props.workspaceId, signal),
    enabled: props.isOwner, retry: false, staleTime: 60_000,
  });
  if (!props.isOwner) return null;
  return <AsanaImportDialog key={`${props.actorId}:${props.workspaceId}`} {...props} available={capability.data === true && !capability.isError} />;
}

function AsanaImportDialog({ actorId, workspaceId, available }: Props & { available: boolean }) {
  const { t } = useTranslation();
  const client = useQueryClient();
  const [open, setOpen] = useState(false);
  const [json, setJson] = useState<File | null>(null), [csv, setCsv] = useState<File | null>(null);
  const [milestones, setMilestones] = useState(false), [external, setExternal] = useState(false), [skipShared, setSkipShared] = useState(false);
  const [upload, setUpload] = useState<AsanaUpload | null>(null);
  const [result, setResult] = useState<AsanaImportResult | null>(null);
  const [busy, setBusy] = useState<'preview' | 'apply' | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [uncertain, setUncertain] = useState(false);
  const [filesProblem, setFilesProblem] = useState(false);
  const [choices, setChoices] = useState<Record<string, AssigneeChoice>>({});
  // Everyone the server has ever asked about for these files: decisions stay until the files change, so none is lost between checks.
  const [seen, setSeen] = useState<AssigneeConflict | null>(null);
  const resetDecisions = () => { setSeen(null); setChoices({}); };
  const inFlight = useRef(false);
  const applyKey = useRef<string | null>(null);
  const oversized = (json?.size ?? 0) > MAX_ASANA_FILE_BYTES || (csv?.size ?? 0) > MAX_ASANA_FILE_BYTES;
  const currentActor = () => (client.getQueryData(queryKeys.me) as { actor?: { id?: string } } | undefined)?.actor?.id === actorId;
  const check = async (actions?: Record<string, AssigneeChoice>, leaveOut = skipShared) => {
    if (!json || !csv || oversized || inFlight.current || upload) return;
    inFlight.current = true; setBusy('preview'); setError(null);
    try {
      // The files may have been chosen in the wrong fields; sort them by what they contain.
      const ordered = await orderExportFiles(json, csv);
      if (!ordered) { setFilesProblem(true); return; }
      setFilesProblem(false);
      const [jsonBase64, csvBase64] = await Promise.all([fileBase64(ordered.json), fileBase64(ordered.csv)]);
      if (!currentActor()) throw new ApiError({ kind: 'unauthenticated', status: 401 });
      const next = await previewAsanaImport(workspaceId, actorId, { jsonBase64, csvBase64, preserveMilestones: milestones, preserveExternalDependencies: external, ...(leaveOut ? { skipShared: true } : {}), ...(actions && Object.keys(actions).length > 0 ? { assigneeActions: toActions(actions) } : {}) }, crypto.randomUUID());
      if (currentActor()) { setUpload(next); applyKey.current = crypto.randomUUID(); }
    } catch (caught) {
      setError(caught);
      // First refusal: offer a choice for each person; later refusals keep the choices already made.
      if (caught instanceof ApiError && caught.assigneeConflict) {
        const asked = caught.assigneeConflict;
        setSeen(before => ({ targets: asked.targets, people: [...(before?.people ?? []), ...asked.people.filter(person => !before?.people.some(known => known.email === person.email))] }));
        setChoices(before => ({ ...defaultChoices(asked), ...before }));
      }
    }
    finally { inFlight.current = false; setBusy(null); }
  };
  const apply = async () => {
    if (!upload || !applyKey.current || upload.preview.existingProjectId || inFlight.current) return;
    inFlight.current = true; setBusy('apply'); setError(null);
    try {
      if (!currentActor()) throw new ApiError({ kind: 'unauthenticated', status: 401 });
      const next = await applyAsanaImport(workspaceId, actorId, upload.uploadId, applyKey.current);
      setUncertain(false);
      if (currentActor()) { setResult(next); void invalidateProjectList(client, actorId, workspaceId); }
    } catch (caught) { setError(caught); setUncertain(previous => previous || isUncertainOutcome(caught)); }
    finally { inFlight.current = false; setBusy(null); }
  };
  const errorKey = error instanceof ApiError && (error.kind === 'unauthenticated' || error.kind === 'forbidden') ? 'projects.asanaImport.accessError'
    : error instanceof ApiError && error.status === 413 ? 'projects.asanaImport.sizeError'
    : uncertain ? 'projects.asanaImport.uncertainError'
    : error instanceof ApiError && error.code === 'ASANA_IMPORT_MAPPING_REQUIRED' ? 'projects.asanaImport.mappingError'
    : error instanceof ApiError && error.code === 'ASANA_IMPORT_PROJECT_RULE' ? 'projects.asanaImport.projectRuleError'
    : error instanceof ApiError && error.code === 'ASANA_IMPORT_REVIEW_REQUIRED' ? 'projects.asanaImport.reviewError'
    : error instanceof ApiError && error.code === 'ASANA_IMPORT_BUSY' ? 'projects.asanaImport.busyError'
    : error instanceof ApiError && error.code === 'ASANA_IMPORT_EXTERNAL_DEPENDENCY' ? 'projects.asanaImport.externalDependencyError'
    : error instanceof ApiError && error.code === 'ASANA_IMPORT_MILESTONE_OPTION' ? 'projects.asanaImport.milestoneOptionError'
    : error instanceof ApiError && error.code === 'ASANA_IMPORT_TEXT_BOUNDS' ? 'projects.asanaImport.textBoundsError'
    : upload ? 'projects.asanaImport.applyError' : 'projects.asanaImport.previewError';
  // The server names the e-mail addresses it could not match to a teammate.
  const missingEmails = error instanceof ApiError && error.missingMailboxes.length > 0 ? error.missingMailboxes.join(', ') : undefined;
  const ruleList = error instanceof ApiError ? error.ruleProjects : [];
  const ruleProjects = ruleList.length > 0 ? ruleList.map(project => project.name).join(', ') : undefined;
  // One click turns the rule off in exactly the projects the server named, then checks the files again.
  const releaseRules = async () => {
    if (inFlight.current) return;
    inFlight.current = true; setBusy('preview'); setError(null);
    try {
      for (const project of ruleList) {
        const rules = await fetchProjectRules(workspaceId, project.id);
        if (rules.config.singleProject) await sendMutation(setProjectRulesRequest(workspaceId, project.id, { expectedRevision: rules.revision, config: { ...rules.config, singleProject: false } }), { idempotencyKey: crypto.randomUUID() });
      }
    } catch (caught) { setError(caught); inFlight.current = false; setBusy(null); return; }
    inFlight.current = false; setBusy(null);
    await check(choicesComplete(choices) ? choices : undefined);
  };
  const conflict = !upload ? seen : null;
  const projectId = result?.projectId ?? upload?.preview.existingProjectId;
  const importAnother = () => {
    if (!projectId || uncertain || inFlight.current) return;
    setJson(null); setCsv(null); setMilestones(false); setExternal(false); setSkipShared(false); resetDecisions();
    setUpload(null); setResult(null); setError(null); setUncertain(false);
    applyKey.current = null;
  };
  const warningLabel = (warning: string) => {
    if (warning === 'source_history') return t('projects.asanaImport.warningHistory');
    if (warning === 'linked_fields') return t('projects.asanaImport.warningLinked');
    const count = /^(milestones_as_tasks|external_dependencies):(\d{1,8})$/.exec(warning);
    if (count?.[1] === 'milestones_as_tasks') return t('projects.asanaImport.warningMilestones', { count: Number(count[2]) });
    if (count?.[1] === 'external_dependencies') return t('projects.asanaImport.warningExternal', { count: Number(count[2]) });
    return t('projects.asanaImport.warningUnknown');
  };
  return <DialogShell variant="double" title={t('projects.asanaImport.title')} description={t('projects.asanaImport.description')}
    trigger={available ? <Button><FileUp size={16} aria-hidden="true" />{t('projects.asanaImport.trigger')}</Button> : undefined}
    open={open} onOpenChange={next => { if (!inFlight.current) setOpen(next); }}>
    <div className="relative mt-5 flex max-h-[calc(100dvh-15rem)] min-h-0 flex-col">
      {busy ? <BusyOverlay label={t(busy === 'apply' ? 'projects.asanaImport.importing' : 'projects.asanaImport.checking')} /> : null}
      <div className="min-h-0 space-y-4 overflow-y-auto pr-1">
      <p className="text-xs font-medium text-muted">{t(result ? 'projects.asanaImport.stepDone' : upload ? 'projects.asanaImport.stepReview' : 'projects.asanaImport.stepFiles')}</p>
      {!upload ? <>
        <details className="rounded-lg border border-line p-3 text-sm" open><summary className="cursor-pointer font-medium text-ink">{t('projects.asanaImport.howTitle')}</summary>
          <ol className="mt-2 list-decimal space-y-1 pl-5 text-muted"><li>{t('projects.asanaImport.howOne')}</li><li>{t('projects.asanaImport.howTwo')}</li><li>{t('projects.asanaImport.howThree')}</li><li>{t('projects.asanaImport.howFour')}</li></ol>
        </details>
        <p className="text-sm text-muted">{t('projects.asanaImport.fileHelp')}</p>
        <label className="block space-y-1 text-sm font-medium text-ink">{t('projects.asanaImport.jsonFile')}<input type="file" accept=".json,application/json" disabled={busy !== null} className="block w-full rounded-lg border border-line p-2 text-sm" onChange={event => { setJson(event.target.files?.[0] ?? null); setError(null); resetDecisions(); }} /></label>
        <label className="block space-y-1 text-sm font-medium text-ink">{t('projects.asanaImport.csvFile')}<input type="file" accept=".csv,text/csv" disabled={busy !== null} className="block w-full rounded-lg border border-line p-2 text-sm" onChange={event => { setCsv(event.target.files?.[0] ?? null); setError(null); resetDecisions(); }} /></label>
        {oversized ? <p role="alert" className="text-sm text-red-600">{t('projects.asanaImport.sizeError')}</p> : null}
        {filesProblem ? <p role="alert" className="text-sm text-red-600">{t('projects.asanaImport.wrongFiles')}</p> : null}
        <details className="rounded-lg border border-line p-3 text-sm"><summary className="cursor-pointer font-medium text-ink">{t('projects.asanaImport.advanced')}</summary><div className="mt-3 space-y-3 text-muted">
          <label className="flex items-start gap-2"><input type="checkbox" checked={milestones} disabled={busy !== null} onChange={event => setMilestones(event.target.checked)} />{t('projects.asanaImport.milestones')}</label>
          <label className="flex items-start gap-2"><input type="checkbox" checked={external} disabled={busy !== null} onChange={event => setExternal(event.target.checked)} />{t('projects.asanaImport.external')}</label>
          <label className="flex items-start gap-2"><input type="checkbox" checked={skipShared} disabled={busy !== null} onChange={event => setSkipShared(event.target.checked)} />{t('projects.asanaImport.skipShared')}</label>
        </div></details>
      </> : <>
        <h2 className="break-words text-lg font-semibold text-ink">{upload.preview.projectName}</h2>
        <dl className="grid grid-cols-2 gap-3 rounded-xl border border-line bg-canvas p-3 text-sm">
          <div><dt className="text-muted">{t('projects.asanaImport.tasks')}</dt><dd className="font-semibold text-ink">{upload.preview.tasks}</dd></div>
          <div><dt className="text-muted">{t('projects.asanaImport.completed')}</dt><dd className="font-semibold text-ink">{upload.preview.completed}</dd></div>
          <div><dt className="text-muted">{t('projects.asanaImport.sections')}</dt><dd className="font-semibold text-ink">{upload.preview.sections}</dd></div>
          <div><dt className="text-muted">{t('projects.asanaImport.roots')}</dt><dd className="text-ink">{upload.preview.roots}</dd></div>
          <div><dt className="text-muted">{t('projects.asanaImport.subtasks')}</dt><dd className="text-ink">{upload.preview.subtasks}</dd></div>
          <div><dt className="text-muted">{t('projects.asanaImport.newTasks')}</dt><dd className="text-ink">{result?.createdTasks ?? upload.preview.createTasks}</dd></div>
          <div><dt className="text-muted">{t('projects.asanaImport.sharedTasks')}</dt><dd className="text-ink">{result?.reusedTasks ?? upload.preview.reuseTasks}</dd></div>
        </dl>
        {upload.preview.fields.length ? <div><h3 className="text-sm font-medium text-ink">{t('projects.asanaImport.fields')}</h3><ul className="mt-1 flex flex-wrap gap-1">{upload.preview.fields.map((field, index) => <li key={index} className="rounded-md border border-line px-2 py-1 text-xs text-muted">{field.name}</li>)}</ul></div> : null}
        {upload.preview.warnings.length ? <div className="rounded-lg border border-amber-400/50 bg-amber-100/20 p-3 text-sm text-ink"><h3 className="font-medium">{t('projects.asanaImport.warnings')}</h3><ul className="mt-1 list-disc space-y-1 pl-4">{upload.preview.warnings.map((warning, index) => <li key={index} className="break-words">{warningLabel(warning)}</li>)}</ul></div> : null}
        <p className="text-sm text-muted">{t(result ? 'projects.asanaImport.success' : projectId ? 'projects.asanaImport.existing' : 'projects.asanaImport.reviewHelp')}</p>
      </>}
      {conflict ? <UnmatchedAssignees conflict={conflict} choices={choices} onChange={setChoices} disabled={busy !== null} /> : null}
      {error && !(error instanceof ApiError && error.assigneeConflict) ? <p role="alert" className="rounded-lg border border-red-400/50 bg-red-100/20 p-3 text-sm text-ink">{t(errorKey)}{missingEmails ? ` ${t('projects.asanaImport.missingEmails', { emails: missingEmails })}` : ''}{ruleProjects ? ` ${t('projects.asanaImport.ruleProjects', { projects: ruleProjects })}` : ''}{ruleList.length > 0 ? <span className="mt-2 block"><Button size="sm" variant="primary" disabled={busy !== null} onClick={() => { void releaseRules(); }}>{t('projects.asanaImport.releaseRules')}</Button><span className="mt-1 block text-xs text-muted">{t('projects.asanaImport.releaseRulesHelp')}</span><Button size="sm" className="mt-3" disabled={busy !== null} onClick={() => { setSkipShared(true); void check(choicesComplete(choices) ? choices : undefined, true); }}>{t('projects.asanaImport.leaveOut')}</Button><span className="mt-1 block text-xs text-muted">{t('projects.asanaImport.leaveOutHelp')}</span></span> : null}</p> : null}

      </div>
      <div className="mt-4 flex shrink-0 flex-wrap items-center justify-end gap-2 border-t border-line bg-surface pt-4">
        <Button disabled={busy !== null} onClick={() => setOpen(false)}>{t('common.close')}</Button>
        {!upload ? (conflict ? <Button variant="primary" disabled={!json || !csv || oversized || busy !== null || !choicesComplete(choices)} onClick={() => { void check(choices); }}>{t('projects.asanaImport.forceCheck')}</Button>
          : <Button variant="primary" disabled={!json || !csv || oversized || busy !== null} onClick={() => { void check(); }}>{t('projects.asanaImport.check')}</Button>)
          : projectId ? <>
            <Button disabled={busy !== null} onClick={importAnother}>{t('projects.asanaImport.importAnother')}</Button>
            <WorkspaceLink to={`/w/${workspaceId}/projects/${projectId}`} className="rounded-lg bg-accent px-4 py-2 text-sm font-medium text-white">{t('projects.asanaImport.openProject')}</WorkspaceLink>
          </>
          : <>
            {!uncertain ? <Button disabled={busy !== null} onClick={() => { setUpload(null); setError(null); applyKey.current = null; }}>{t('projects.asanaImport.changeFiles')}</Button> : null}
            <Button variant="primary" disabled={busy !== null} onClick={() => { void apply(); }}>{t(uncertain ? 'projects.asanaImport.retry' : 'projects.asanaImport.import')}</Button>
          </>}
      </div>
    </div>
  </DialogShell>;
}
