import {
  workspaceResponseSchema, type ProjectImportDto, type ProjectImportMapping, type ProjectImportPreviewDto, type TaskFieldDefinitionDto,
} from '@workloom/contracts';
import { useCallback, useRef, useState } from 'react';
import { ApiError, apiGet, isAccessDenied } from '../../lib/api';
import { useProtectedDraft } from '../../lib/protectedDrafts';
import { useUnsavedChangesWarning } from '../../lib/useUnsavedChangesWarning';
import { fetchPlanningPeriod } from '../planning/api';
import { fetchProject } from '../projects/api';
import { workspacePath } from '../workspace/queries';
import { fetchImportReconciliation, fetchProjectImport, previewProjectImport } from './api';
import { readCsvFile, type CsvFileSource, type CsvUpload } from './file';
import { buildImportMapping, formFromMapping, initialMapping, type ImportMappingForm } from './mapping';
import { useImportCommands } from './queries';
export interface ImportDraft { id: string; source: ProjectImportDto; form: ImportMappingForm; baseForm: string; preview: ProjectImportPreviewDto | null; previewFingerprint: string | null; error: Error | null }
const encoded = (revision: number, mapping: ProjectImportMapping) => JSON.stringify({ expectedImportRevision: revision, mapping });
const newUpload = (namespace = '') => ({ id: crypto.randomUUID(), namespace, baseNamespace: namespace, file: null as CsvUpload | null });
export function useImportWorkspace(a: string, w: string, p: string, selectedId: string, onSelect: (id: string) => void) {
  const [upload, setUpload] = useState(() => newUpload());
  const [drafts, setDrafts] = useState<Record<string, ImportDraft>>({});
  const [reading, setReading] = useState(false), [fileError, setFileError] = useState<string | null>(null);
  const [previewing, setPreviewing] = useState<string | null>(null), [rebasing, setRebasing] = useState<string | null>(null);
  const [readDenied, setReadDenied] = useState(false), [checkingAccess, setCheckingAccess] = useState(false);
  const [openingRecovery, setOpeningRecovery] = useState<string | null>(null);
  const [lastStagedId, setLastStagedId] = useState<string | null>(null);
  const fileSequence = useRef(0), previews = useRef<Record<string, number>>({});
  const latestSelected = useRef(selectedId); latestSelected.current = selectedId;
  const latestDrafts = useRef(drafts); latestDrafts.current = drafts;
  const noteDenied = useCallback(() => setReadDenied(true), []);
  const commands = useImportCommands(a, w, p, (data, variables) => {
    setUpload(current => current.id === variables.draftId ? newUpload(current.namespace) : current);
    setLastStagedId(data.id);
    if (!latestSelected.current) onSelect(data.id);
  }, (data, variables) => {
    // Retire only the submitted mapping's dirty state; keep its normalized decisions visible.
    setDrafts(current => Object.fromEntries(Object.entries(current).map(([id, draft]) => {
      if (draft.id !== variables.draftId) return [id, draft];
      const form = formFromMapping(variables.input.mapping);
      return [id, { ...draft, source: draft.source.revision > data.import.revision ? draft.source : data.import, form, baseForm: JSON.stringify(form), preview: null, previewFingerprint: null, error: null }];
    })));
  });
  const stageHeld = commands.stage.pendingCommand?.variables ?? commands.stage.uncertain?.variables ?? null;
  const applyHeld = commands.apply.pendingCommand?.variables ?? commands.apply.uncertain?.variables ?? null;
  const denied = readDenied || isAccessDenied(commands.stage.error) || isAccessDenied(commands.apply.error) || Object.values(drafts).some(draft => isAccessDenied(draft.error));
  const chooseFile = async (file: CsvFileSource) => {
    if (stageHeld) return;
    const sequence = ++fileSequence.current; setReading(true); setFileError(null);
    setUpload(current => ({ ...current, file: null }));
    try { const decoded = await readCsvFile(file); if (sequence === fileSequence.current) setUpload(current => ({ ...current, file: decoded })); }
    catch (error) { if (sequence === fileSequence.current) setFileError(error instanceof Error ? error.message : 'Не удалось прочитать файл.'); }
    finally { if (sequence === fileSequence.current) setReading(false); }
  };
  const stage = () => {
    if (stageHeld || reading || fileError || denied || !upload.file || !upload.namespace.trim()) return;
    commands.stage.mutate({ draftId: upload.id, input: { ...upload.file, sourceNamespace: upload.namespace } });
  };
  const setNamespace = (namespace: string) => { if (!stageHeld) setUpload(current => ({ ...current, namespace })); };
  const clearUpload = () => { if (stageHeld) return; fileSequence.current += 1; setReading(false); setFileError(null); setUpload(current => newUpload(current.baseNamespace)); };
  const ensureDraft = useCallback((source: ProjectImportDto, savedMapping?: ProjectImportMapping) => setDrafts(current => {
    if (current[source.id]) return current;
    if (source.status === 'applied' && !savedMapping) return current;
    const form = savedMapping ? formFromMapping(savedMapping) : initialMapping();
    return { ...current, [source.id]: { id: crypto.randomUUID(), source, form, baseForm: JSON.stringify(form), preview: null, previewFingerprint: null, error: null } };
  }), []);
  const change = (importId: string, form: ImportMappingForm) => {
    if (applyHeld?.importId === importId || denied) return;
    setDrafts(current => current[importId] ? { ...current, [importId]: { ...current[importId], form, preview: null, previewFingerprint: null, error: null } } : current);
  };
  const preview = async (draft: ImportDraft, fields: readonly TaskFieldDefinitionDto[]) => {
    const mapping = buildImportMapping(draft.source, draft.form, fields);
    if (!mapping || applyHeld || denied || previewing !== null || rebasing !== null) return;
    const fingerprint = encoded(draft.source.revision, mapping), sequence = (previews.current[draft.id] ?? 0) + 1;
    previews.current[draft.id] = sequence; setPreviewing(draft.id); commands.apply.reset();
    setDrafts(current => current[draft.source.id]?.id === draft.id ? { ...current, [draft.source.id]: { ...current[draft.source.id], preview: null, previewFingerprint: null, error: null } } : current);
    try {
      const result = await previewProjectImport(w, p, draft.source.id, { expectedImportRevision: draft.source.revision, mapping });
      const rowNumbers = new Set(draft.source.sourceRows.map(row => row.rowNumber));
      if (result.sourceDigest !== draft.source.fileDigest || result.rows.length !== rowNumbers.size || result.rows.some(row => !rowNumbers.delete(row.rowNumber)) || result.summary.sourceRows !== draft.source.sourceRows.length) throw new ApiError({ kind: 'invalid_response', status: 200 });
      setDrafts(current => {
        const now = current[draft.source.id], nowMapping = now ? buildImportMapping(now.source, now.form, fields) : null;
        return now?.id === draft.id && nowMapping && previews.current[draft.id] === sequence && encoded(now.source.revision, nowMapping) === fingerprint ? { ...current, [draft.source.id]: { ...now, preview: result, previewFingerprint: fingerprint, error: null } } : current;
      });
    } catch (error) {
      if (isAccessDenied(error)) noteDenied();
      setDrafts(current => { const now = current[draft.source.id], nowMapping = now ? buildImportMapping(now.source, now.form, fields) : null; return now?.id === draft.id && nowMapping && previews.current[draft.id] === sequence && encoded(now.source.revision, nowMapping) === fingerprint ? { ...current, [draft.source.id]: { ...now, error: error instanceof Error ? error : new Error('Не удалось проверить импорт.') } } : current; });
    } finally { setPreviewing(current => current === draft.id ? null : current); }
  };
  const canApply = (draft: ImportDraft, fields: readonly TaskFieldDefinitionDto[]) => {
    const mapping = buildImportMapping(draft.source, draft.form, fields), result = draft.preview;
    return !(commands.apply.variables?.importId === draft.source.id && commands.apply.error) && !!mapping && mapping.shareableScopeConfirmed && !applyHeld && !denied && !previewing && !rebasing && !!result && draft.previewFingerprint === encoded(draft.source.revision, mapping) && !result.issues.some(issue => issue.severity === 'blocking') && result.summary.blockedCount === 0 && result.summary.conflictCount === 0 && result.recoveryPeriodIds.length === 0;
  };
  const apply = (draft: ImportDraft, fields: readonly TaskFieldDefinitionDto[]) => {
    const mapping = buildImportMapping(draft.source, draft.form, fields);
    if (!mapping || !draft.preview || !canApply(draft, fields)) return;
    commands.apply.mutate({ draftId: draft.id, importId: draft.source.id, input: { expectedImportRevision: draft.source.revision, mapping, previewHash: draft.preview.previewHash } });
  };
  const rebase = async (draft: ImportDraft, refreshCatalog: () => Promise<boolean>) => {
    if (applyHeld || rebasing || denied) return;
    setRebasing(draft.id);
    try {
      if (!await refreshCatalog()) throw new Error('Не удалось обновить справочники.');
      const fresh = await fetchProjectImport(w, p, draft.source.id);
      setDrafts(current => { const now = current[draft.source.id]; return now?.id === draft.id ? { ...current, [draft.source.id]: { ...now, source: fresh.revision >= now.source.revision ? fresh : now.source, preview: null, previewFingerprint: null, error: null } } : current; });
      commands.apply.reset();
    } catch (error) { if (isAccessDenied(error)) noteDenied(); setDrafts(current => current[draft.source.id]?.id === draft.id ? { ...current, [draft.source.id]: { ...current[draft.source.id], error: error instanceof Error ? error : new Error('Не удалось обновить импорт.') } } : current); }
    finally { setRebasing(null); }
  };
  const recoverAccess = async (refreshCatalog: () => Promise<boolean>) => {
    if (checkingAccess) return;
    const selected = latestSelected.current; setCheckingAccess(true);
    try {
      if (!await refreshCatalog()) return;
      const workspace = (await apiGet(workspacePath(w), workspaceResponseSchema)).data;
      if (workspace.role !== 'owner' && workspace.role !== 'admin') return;
      await fetchProject(w, p);
      const ids = [...new Set([selected, ...Object.keys(drafts), applyHeld?.importId ?? '', lastStagedId ?? ''].filter(Boolean))];
      await Promise.all(ids.flatMap(id => [fetchProjectImport(w, p, id), fetchImportReconciliation(w, p, id)]));
      if (latestSelected.current !== selected) return;
      setReadDenied(false);
      for (const mutation of [commands.stage, commands.apply]) if (isAccessDenied(mutation.error)) mutation.reset();
      setDrafts(current => Object.fromEntries(Object.entries(current).map(([id, draft]) => [id, isAccessDenied(draft.error) ? { ...draft, error: null } : draft])));
    } catch { noteDenied(); }
    finally { setCheckingAccess(false); }
  };
  const openRecovery = async (draft: ImportDraft, periodId: string) => {
    if (openingRecovery) return null;
    const hash = draft.preview?.previewHash; setOpeningRecovery(periodId);
    try {
      const period = await fetchPlanningPeriod(w, periodId);
      if (latestSelected.current !== draft.source.id || latestDrafts.current[draft.source.id]?.preview?.previewHash !== hash) return null;
      return `/w/${w}/projects/${period.projectId}/week?period=${period.id}`;
    } catch (error) { if (isAccessDenied(error)) noteDenied(); setDrafts(current => current[draft.source.id] ? { ...current, [draft.source.id]: { ...current[draft.source.id], error: error instanceof Error ? error : new Error('Не удалось открыть период.') } } : current); return null; }
    finally { setOpeningRecovery(null); }
  };
  const dirty = !!upload.file || upload.namespace !== upload.baseNamespace || Object.values(drafts).some(draft => JSON.stringify(draft.form) !== draft.baseForm);
  useProtectedDraft(dirty); useUnsavedChangesWarning(dirty);
  return { upload, reading, fileError, chooseFile, stage, setNamespace, clearUpload, stageHeld, applyHeld, drafts, ensureDraft, change, preview, previewing, rebase, rebasing, apply, canApply, denied, noteDenied, checkingAccess, recoverAccess, openingRecovery, openRecovery, commands, lastStagedId };
}
export type ImportWorkspace = ReturnType<typeof useImportWorkspace>;
