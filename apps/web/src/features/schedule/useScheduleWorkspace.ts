import { taskScheduleBatchInputSchema, type TaskDto, type TaskScheduleContextRowDto, type TaskSchedulePreviewDto, type TaskScheduleBatchInput } from '@workloom/contracts';
import { useCallback, useRef, useState } from 'react';
import { ApiError, isAccessDenied } from '../../lib/api';
import { useProtectedDraft } from '../../lib/protectedDrafts';
import { useUnsavedChangesWarning } from '../../lib/useUnsavedChangesWarning';
import { fetchPlanningPeriod } from '../planning/api';
import { fetchScheduleContext, previewSchedule } from './api';
import { shiftDay, todayIn } from './dates';
import { useApplySchedule } from './queries';
export interface ScheduleDraftRow { taskId: string; title: string; expectedRevision: number; startDate: string; dueDate: string; baseStart: string; baseDue: string; editable: boolean }
export interface ScheduleDraft { id: string; rows: ScheduleDraftRow[]; preview: TaskSchedulePreviewDto | null; previewFingerprint: string | null; error: Error | null }
const fingerprint = (input: TaskScheduleBatchInput) => JSON.stringify(input);
export function scheduleDraftInput(draft: ScheduleDraft): TaskScheduleBatchInput | null {
  const parsed = taskScheduleBatchInputSchema.safeParse({ rows: draft.rows.map(row => ({ taskId: row.taskId, expectedRevision: row.expectedRevision, startDate: row.startDate || null, dueDate: row.dueDate || null })) });
  return parsed.success ? parsed.data : null;
}
export function useScheduleWorkspace(actorId: string, workspaceId: string, projectId: string, timezone: string) {
  const [drafts, setDrafts] = useState<Record<string, ScheduleDraft>>({});
  const [activeId, setActiveId] = useState<string | null>(null);
  const [readDenied, setReadDenied] = useState(false);
  const noteReadDenied = useCallback(() => setReadDenied(true), []);
  const [previewing, setPreviewing] = useState<string | null>(null);
  const [rebasing, setRebasing] = useState<string | null>(null);
  const [openingRecovery, setOpeningRecovery] = useState<string | null>(null);
  const latestDrafts = useRef(drafts); latestDrafts.current = drafts;
  const latestActive = useRef(activeId); latestActive.current = activeId;
  const requests = useRef<Record<string, number>>({});
  const [windowStart, setWindowStart] = useState(() => todayIn(timezone));
  const [windowSize, setWindowSize] = useState(28);
  const [baselinePeriodId, setBaselinePeriodId] = useState('');
  const [baselineId, setBaselineId] = useState('');
  const mutation = useApplySchedule(actorId, workspaceId, projectId, variables => {
    setDrafts(current => Object.fromEntries(Object.entries(current).filter(([id]) => id !== variables.draftId)));
    setActiveId(current => current === variables.draftId ? null : current);
  });
  const held = mutation.pendingCommand?.variables ?? mutation.uncertain?.variables ?? null;
  const active = activeId ? drafts[activeId] ?? null : null;
  const open = (tasks: readonly TaskDto[], contexts: ReadonlyMap<string, TaskScheduleContextRowDto>) => {
    if (!tasks.length || tasks.length > 100 || tasks.some(task => !contexts.has(task.id))) return;
    const ids = tasks.map(task => task.id).sort().join(',');
    const previous = Object.values(drafts).find(draft => draft.rows.map(row => row.taskId).sort().join(',') === ids);
    if (previous) { setActiveId(previous.id); return; }
    const draft: ScheduleDraft = { id: crypto.randomUUID(), preview: null, previewFingerprint: null, error: null, rows: tasks.map(task => {
      const context = contexts.get(task.id);
      if (!context) throw new Error('Missing authorized context');
      return { taskId: task.id, title: task.title, expectedRevision: context.taskRevision, startDate: context.current.startDate ?? '', dueDate: context.current.dueDate ?? '', baseStart: context.current.startDate ?? '', baseDue: context.current.dueDate ?? '', editable: context.editableDates };
    }) };
    setDrafts(current => ({ ...current, [draft.id]: draft })); setActiveId(draft.id);
  };
  const change = (id: string, taskId: string, patch: Partial<Pick<ScheduleDraftRow, 'startDate' | 'dueDate'>>) => {
    if (held?.draftId === id) return;
    setDrafts(current => { const draft = current[id]; return draft ? { ...current, [id]: { ...draft, rows: draft.rows.map(row => row.taskId === taskId ? { ...row, ...patch } : row), preview: null, previewFingerprint: null, error: null } } : current; });
  };
  const shift = (id: string, amount: number) => {
    if (held?.draftId === id) return;
    setDrafts(current => {
      const draft = current[id]; if (!draft) return current;
      const rows = draft.rows.map(row => ({ ...row, startDate: row.startDate ? shiftDay(row.startDate, amount) : '', dueDate: row.dueDate ? shiftDay(row.dueDate, amount) : '' }));
      if (rows.some(row => row.startDate === null || row.dueDate === null)) return { ...current, [id]: { ...draft, error: new Error('Сдвиг выходит за допустимые календарные даты.') } };
      return { ...current, [id]: { ...draft, rows: rows.map(row => ({ ...row, startDate: row.startDate ?? '', dueDate: row.dueDate ?? '' })), preview: null, previewFingerprint: null, error: null } };
    });
  };
  const preview = async (draft: ScheduleDraft) => {
    const input = scheduleDraftInput(draft);
    if (!input || held || denied || previewing === draft.id) return;
    mutation.reset();
    setDrafts(current => current[draft.id] ? { ...current, [draft.id]: { ...current[draft.id], preview: null, previewFingerprint: null, error: null } } : current);
    const stamp = (requests.current[draft.id] ?? 0) + 1; requests.current[draft.id] = stamp;
    const source = fingerprint(input); setPreviewing(draft.id);
    try {
      const result = await previewSchedule(workspaceId, projectId, input);
      setDrafts(current => { const now = current[draft.id]; const parsed = now ? scheduleDraftInput(now) : null; return now && parsed && requests.current[draft.id] === stamp && fingerprint(parsed) === source ? { ...current, [draft.id]: { ...now, preview: result, previewFingerprint: source, error: null } } : current; });
    } catch (error) { if (isAccessDenied(error)) noteReadDenied(); setDrafts(current => { const now = current[draft.id]; const parsed = now ? scheduleDraftInput(now) : null; return now && parsed && requests.current[draft.id] === stamp && fingerprint(parsed) === source ? { ...current, [draft.id]: { ...now, error: error instanceof Error ? error : new Error('Не удалось проверить сроки.') } } : current; }); }
    finally { setPreviewing(current => current === draft.id ? null : current); }
  };
  const rebase = async (draft: ScheduleDraft) => {
    if (held || rebasing !== null) return;
    setRebasing(draft.id);
    try {
      const result = await fetchScheduleContext(workspaceId, projectId, { taskIds: draft.rows.map(row => row.taskId) });
      setDrafts(current => { const now = current[draft.id]; return now ? { ...current, [draft.id]: { ...now, rows: now.rows.map(row => { const fresh = result.rows.find(item => item.taskId === row.taskId); return fresh ? { ...row, expectedRevision: fresh.taskRevision, baseStart: fresh.current.startDate ?? '', baseDue: fresh.current.dueDate ?? '', editable: fresh.editableDates } : row; }), preview: null, previewFingerprint: null, error: null } } : current; });
      mutation.reset();
    } catch (error) { if (isAccessDenied(error)) noteReadDenied(); setDrafts(current => current[draft.id] ? { ...current, [draft.id]: { ...current[draft.id], error: error instanceof Error ? error : new Error('Не удалось обновить сроки.') } } : current); }
    finally { setRebasing(null); }
  };
  const apply = (draft: ScheduleDraft) => {
    const input = scheduleDraftInput(draft);
    if (!input || held || denied || rebasing !== null || !draft.preview || draft.previewFingerprint !== fingerprint(input) || draft.preview.protectedTargets.length || draft.preview.recoveryPeriodIds.length) return;
    mutation.mutate({ draftId: draft.id, input: { ...input, previewHash: draft.preview.previewHash } });
  };
  const discard = (id: string) => { if (held?.draftId === id) return; setDrafts(current => Object.fromEntries(Object.entries(current).filter(([key]) => key !== id))); setActiveId(current => current === id ? null : current); };
  const denied = readDenied || isAccessDenied(mutation.error) || Object.values(drafts).some(draft => isAccessDenied(draft.error));
  const clearDenial = async (canReveal: () => boolean) => {
    // Filter/view changes must not authorize a privately retained draft by reading other tasks.
    const ids = [...new Set(Object.values(drafts).flatMap(draft => draft.rows.map(row => row.taskId)))].sort();
    try {
      const reads = [];
      for (let offset = 0; offset < ids.length; offset += 100) reads.push(fetchScheduleContext(workspaceId, projectId, { taskIds: ids.slice(offset, offset + 100) }));
      await Promise.all(reads);
    } catch { setReadDenied(true); return false; }
    if (!canReveal()) return false;
    setReadDenied(false);
    if (isAccessDenied(mutation.error)) mutation.reset();
    setDrafts(current => Object.fromEntries(Object.entries(current).map(([id, draft]) => [id, isAccessDenied(draft.error) ? { ...draft, error: null } : draft])));
    return true;
  };
  const resolveRecoveryPeriod = async (draft: ScheduleDraft, periodId: string) => {
    if (openingRecovery !== null) return null;
    const source = draft.preview?.previewHash;
    setOpeningRecovery(periodId);
    try {
      const period = await fetchPlanningPeriod(workspaceId, periodId);
      if (period.id !== periodId || period.workspaceId !== workspaceId) throw new ApiError({ kind: 'invalid_response', status: 200 });
      if (latestActive.current !== draft.id || latestDrafts.current[draft.id]?.preview?.previewHash !== source) return null;
      return `/w/${workspaceId}/projects/${period.projectId}/week?period=${period.id}`;
    } catch (error) {
      if (isAccessDenied(error)) noteReadDenied();
      setDrafts(current => current[draft.id] ? { ...current, [draft.id]: { ...current[draft.id], error: error instanceof Error ? error : new Error('Не удалось открыть период.') } } : current);
      return null;
    } finally { setOpeningRecovery(null); }
  };
  const dirty = Object.values(drafts).some(draft => draft.rows.some(row => row.startDate !== row.baseStart || row.dueDate !== row.baseDue));
  useProtectedDraft(dirty); useUnsavedChangesWarning(dirty);
  return { drafts, active, activeId, setActiveId, open, change, shift, preview, previewing, rebase, rebasing, apply, discard, mutation, held, denied, noteReadDenied, clearDenial, openingRecovery, resolveRecoveryPeriod,
    windowStart, setWindowStart, windowSize, setWindowSize, baselinePeriodId, setBaselinePeriodId, baselineId, setBaselineId };
}
export type ScheduleWorkspace = ReturnType<typeof useScheduleWorkspace>;
export const scheduleConflict = (error: unknown) => error instanceof ApiError && error.kind === 'conflict';
