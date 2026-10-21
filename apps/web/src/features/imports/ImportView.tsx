import { useWorkspaceNavigate as useNavigate } from '../workspace/WorkspaceNavigation';
import { useTranslation } from '../../i18n';
import type { ProjectDto } from '@workloom/contracts';
import { Button, TextInput } from '@workloom/ui';
import { useEffect, useLayoutEffect, useRef } from 'react';

import { isAccessDenied } from '../../lib/api';
import { isUuid } from '../../lib/format';
import { QueryErrorState } from '../../shared/QueryErrorState';
import { SaveFeedback } from '../../shared/SaveFeedback';
import { buildImportMapping, formFromMapping } from './mapping';
import { MappingEditor, type ImportCatalog } from './MappingEditor';
import { useImportReconciliation, useProjectImport } from './queries';
import { ImportPreview, ReconciliationView } from './ImportResults';
import { SourceTable } from './SourceTable';
import type { ImportWorkspace } from './useImportWorkspace';

export function ImportView(props: { actorId: string; workspaceId: string; project: ProjectDto; selectedId: string; canManage: boolean; writable: boolean; catalog: ImportCatalog; catalogDenied: boolean; onRefreshCatalog: () => Promise<boolean>; controller: ImportWorkspace; onSelect: (id: string) => void; onOpenTask: (id: string) => void }) {
  const { t } = useTranslation();
  if (!props.canManage) return <p role="alert" className="rounded-xl border border-line p-4 text-sm text-muted">{t('imports.importSourceFilesAreAvailableToWorkspaceOwnersAnd')}</p>;
  if (props.selectedId && !isUuid(props.selectedId)) return <p role="alert" className="text-sm text-muted">{t('imports.importUnavailableInvalidId')}</p>;
  return <AuthorizedImportView {...props} />;
}
function AuthorizedImportView({ actorId, workspaceId, project, selectedId, writable, catalog, catalogDenied, onRefreshCatalog, controller: c, onSelect, onOpenTask }: Parameters<typeof ImportView>[0]) {
  const { t } = useTranslation();
  const source = useProjectImport(actorId, workspaceId, project.id, selectedId, !!selectedId);
  const reconciliation = useImportReconciliation(actorId, workspaceId, project.id, selectedId, !!selectedId);
  const navigate = useNavigate();
  const deniedRead = catalogDenied || isAccessDenied(source.error) || isAccessDenied(reconciliation.error), noteDenied = c.noteDenied;
  useLayoutEffect(() => { if (deniedRead) noteDenied(); }, [deniedRead, noteDenied]);
  const ensure = c.ensureDraft;
  useEffect(() => { if (source.isSuccess && !isAccessDenied(reconciliation.error)) ensure(source.data, reconciliation.data?.status === 'applied' ? reconciliation.data.mapping : undefined); }, [source.isSuccess, source.data, reconciliation.data, reconciliation.error, ensure]);
  const sourceId = useRef(selectedId); sourceId.current = selectedId;
  const ownStage = c.stageHeld?.draftId === c.upload.id ? c.stageHeld : null;
  const draft = c.drafts[selectedId];
  const held = c.applyHeld?.importId === selectedId ? c.applyHeld : null;
  const artifact = source.data && draft && draft.source.revision > source.data.revision ? draft.source : source.data;
  const mapping = draft ? buildImportMapping(draft.source, draft.form, catalog.fields) : null;
  const saved = reconciliation.data?.status === 'applied' ? reconciliation.data : null;
  const applied = artifact?.status === 'applied';
  const heldForm = held ? formFromMapping(held.input.mapping) : null;
  if (c.denied || deniedRead) return <section className="space-y-3 rounded-xl border border-line p-4"><p role="alert" className="text-sm text-muted">{t('imports.sourceFileAndMappingAreHiddenUntilAccessIs')}</p><Button disabled={c.checkingAccess} onClick={() => void c.recoverAccess(async () => {
    const selected = sourceId.current;
    const reads = await Promise.all([onRefreshCatalog(), ...(selected ? [source.refetch().then(result => result.isSuccess), reconciliation.refetch().then(result => result.isSuccess)] : [])]);
    return sourceId.current === selected && reads.every(Boolean);
  })}>{t('imports.checkImportAccess')}</Button>{selectedId ? <Button onClick={() => onSelect('')}>{t('imports.backToFileSelection')}</Button> : null}</section>;
  return <section aria-label={t('imports.projectCsvImport')} className="min-w-0 space-y-5"><header className="space-y-2"><h2 className="text-lg font-semibold">{t('imports.importCsv')}</h2><p className="max-w-3xl text-sm text-muted">{t('imports.oneProjectUpTo50TaskRows100Columns')}</p></header>
    {selectedId ? <Button onClick={() => onSelect('')}>{t('imports.stageAnotherFile')}</Button> : <section aria-label={t('imports.csvFileSelection')} className="space-y-4 rounded-xl border border-line p-4"><h3 className="font-semibold">{t('imports.chooseAFileAndIdSource')}</h3><label className="block space-y-1 text-sm font-medium">{t('imports.sourceIdentifier')}<TextInput maxLength={160} disabled={!!c.stageHeld || !writable} value={ownStage?.input.sourceNamespace ?? c.upload.namespace} onChange={e => c.setNamespace(e.target.value)} placeholder={t('imports.asanaTeamProject')} /></label><p className="text-xs text-muted">{t('imports.useTheSameIdentifierWhenUploadingThisProjectAgain')}</p><label className="block space-y-2 text-sm font-medium">{t('imports.utf8CsvFile')}<input className="block w-full min-w-0 text-sm" type="file" accept=".csv,text/csv" disabled={!!c.stageHeld || c.reading || !writable} onChange={e => { const file = e.currentTarget.files?.[0]; if (file) void c.chooseFile(file); e.currentTarget.value = ''; }} /></label>{c.reading ? <p role="status" className="text-sm text-muted">{t('imports.checkingLocalUtf8File')}</p> : null}{ownStage || c.upload.file ? <p className="text-sm [overflow-wrap:anywhere]">{t('imports.selectedFile2', { fileName: ownStage?.input.fileName ?? c.upload.file?.fileName })}</p> : null}{c.fileError ? <p role="alert" className="text-sm text-red-800">{c.fileError}</p> : null}<p className="text-xs text-muted">{t('imports.stagingPreservesTheSourceFileForMappingItDoes')}</p><div className="flex flex-wrap gap-2"><Button disabled={!!c.stageHeld || !writable || c.reading || !!c.fileError || !c.upload.file || !c.upload.namespace.trim()} variant="primary" onClick={c.stage}>{t('imports.stageFile')}</Button><Button disabled={!!c.stageHeld} onClick={c.clearUpload}>{t('imports.clearFileSelection')}</Button>{c.commands.stage.uncertain ? <Button disabled={!!c.commands.stage.pendingCommand} onClick={() => c.commands.stage.retryUncertain()}>{t('imports.retryOriginalFileStaging')}</Button> : null}</div><SaveFeedback subject="taskSave" error={c.commands.stage.error} uncertainError={c.commands.stage.uncertain?.error ?? null} /></section>}
    {selectedId && source.isPending ? <p role="status" className="text-sm text-muted">{t('imports.loadingStagedFile')}</p> : null}
    {selectedId && artifact && !draft ? reconciliation.error ? <QueryErrorState error={reconciliation.error} subject="tasks" headingLevel={3} onRetry={() => void reconciliation.refetch()} /> : <p role="status" className="text-sm text-muted">{t('imports.loadingFileMapping')}</p> : null}
    {selectedId && source.error ? <QueryErrorState error={source.error} subject="tasks" headingLevel={3} onRetry={() => void source.refetch()} /> : artifact && draft ? <>
      <section className="space-y-2 rounded-xl border border-line bg-canvas p-4"><h3 className="font-semibold [overflow-wrap:anywhere]">{artifact.fileName}</h3><p className="text-xs text-muted">{t('imports.idSource')}<code className="whitespace-pre-wrap [overflow-wrap:anywhere]">{artifact.sourceNamespace}</code> {t('imports.rows')}{artifact.sourceRows.length} · {applied ? t('imports.applied') : t('imports.stagedOnly2')}</p></section>
      <SourceTable key={artifact.id} source={artifact} />
      {applied ? <>{saved ? <><ReconciliationView result={saved} onOpenTask={onOpenTask} /><details className="rounded-xl border border-line p-4"><summary className="cursor-pointer text-sm font-medium">{t('imports.confirmedMappingAndSourceUnits')}</summary><div className="mt-4"><MappingEditor source={artifact} form={formFromMapping(saved.mapping)} catalog={catalog} disabled onChange={() => undefined} /></div></details></> : reconciliation.error ? <QueryErrorState error={reconciliation.error} subject="tasks" headingLevel={3} onRetry={() => void reconciliation.refetch()} /> : <p role="status" className="text-sm text-muted">{t('imports.loadingReconciliation')}</p>}{heldForm ? <details className="rounded-xl border border-amber-200 p-4"><summary className="cursor-pointer text-sm font-medium">{t('imports.originalRequestAwaitingConfirmation')}</summary><MappingEditor source={artifact} form={heldForm} catalog={catalog} disabled onChange={() => undefined} /></details> : null}</> : <>
        <MappingEditor source={draft.source} form={heldForm ?? draft.form} catalog={catalog} disabled={!writable || !!held || c.rebasing !== null} onChange={form => c.change(selectedId, form)} />
        {!mapping ? <p role="alert" className="text-sm text-muted">{t('imports.chooseRequiredColumnsAStatusAndTheNecessaryDelimiters')}</p> : null}
        <SaveFeedback subject="taskSave" error={draft.error ?? (c.commands.apply.variables?.importId === selectedId ? c.commands.apply.error : null)} uncertainError={held ? c.commands.apply.uncertain?.error ?? null : null} />
        <div className="flex flex-wrap gap-2"><Button disabled={!writable || !mapping || !!c.applyHeld || c.previewing !== null || c.rebasing !== null} onClick={() => void c.preview(draft, catalog.fields)}>{t('imports.previewImport')}</Button><Button disabled={!!c.applyHeld || c.rebasing !== null} onClick={() => void c.rebase(draft, onRefreshCatalog)}>{t('imports.refreshSourcesAndKeepMySelections')}</Button></div>
        {c.previewing === draft.id ? <p role="status" className="text-sm text-muted">{t('imports.checkingAllRowsAndCurrentReferences')}</p> : null}
        {draft.preview ? <ImportPreview source={draft.source} draft={draft} result={draft.preview} catalog={catalog} controller={c} onOpenTask={onOpenTask} onRecovery={id => { void c.openRecovery(draft, id).then(route => { if (route) void navigate(route); }); }} /> : null}
        <div role="group" aria-label={t('imports.applyImport')} className="flex flex-wrap items-center gap-3 rounded-xl border border-line bg-surface p-4"><p className="min-w-0 flex-1 text-xs text-muted">{t('imports.allRowsAreImportedTogetherConflictsPrivateEntriesAnd')}</p><Button variant="primary" disabled={!writable || !c.canApply(draft, catalog.fields)} onClick={() => c.apply(draft, catalog.fields)}>{t('imports.applyImport')}</Button></div>
      </>}
      {held ? <div role="status" className="space-y-2 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900"><p>{t('imports.theOriginalMappingAndOperationKeyStayLockedUntil')}</p>{c.commands.apply.uncertain ? <Button disabled={!!c.commands.apply.pendingCommand} onClick={() => c.commands.apply.retryUncertain()}>{t('imports.retryOriginalImport')}</Button> : null}</div> : null}
    </> : null}
  </section>;
}
export function ImportNotices({ controller: c, onSelect, selectedId, canManage }: { controller: ImportWorkspace; onSelect: (id: string) => void; selectedId: string; canManage: boolean }) {
  const { t } = useTranslation();
  return <>{(['stage', 'apply'] as const).map(kind => { const command = c.commands[kind], held = command.pendingCommand?.variables ?? command.uncertain?.variables; if (!held) return null; return <div key={kind} role="status" className="space-y-2 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900"><p>{t('imports.originalDataAndOperationKeyArePreserved2', { action: kind === 'stage' ? t('imports.fileStaging') : t('imports.applyImport'), saveState: command.pendingCommand ? t('imports.saving') : t('imports.unconfirmed') })}</p>{canManage && !c.denied ? <div className="flex flex-wrap gap-2"><Button size="sm" onClick={() => onSelect('importId' in held ? held.importId : '')}>{t('imports.openOriginalImportRequest')}</Button>{command.uncertain ? <Button size="sm" onClick={() => command.retryUncertain()}>{t('imports.retryOriginalImportRequest')}</Button> : null}</div> : null}</div>; })}{canManage && c.lastStagedId && c.lastStagedId !== selectedId ? <Button size="sm" onClick={() => { if (c.lastStagedId) onSelect(c.lastStagedId); }}>{t('imports.openStagedImport')}</Button> : null}{canManage ? Object.values(c.drafts).filter(draft => draft.source.id !== selectedId && JSON.stringify(draft.form) !== draft.baseForm).map(draft => <Button key={draft.id} size="sm" onClick={() => onSelect(draft.source.id)}>{t('imports.resumeImportMapping')}</Button>) : null}</>;
}
