import { useTranslation } from '../../i18n';
import { taskScheduleBatchInputSchema, type TaskDto, type TaskScheduleContextRowDto, type TaskSchedulePreviewDto, type TaskScheduleBatchInput } from '@workloom/contracts';
import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useLayoutEffect, useRef, useState } from 'react';
import { ApiError, isAccessDenied } from '../../lib/api';
import { protectedCommandsFor } from '../../lib/protectedCommands';
import { useProtectedDraft } from '../../lib/protectedDrafts';
import { useUnsavedChangesWarning } from '../../lib/useUnsavedChangesWarning';
import { fetchPlanningPeriod } from '../planning/api';
import { fetchScheduleContext, previewSchedule } from './api';
import { shiftDay, todayIn, type LoadedFit } from './dates';
import type { DateMoveProposal } from './dateGesture';
import { useApplySchedule } from './queries';
import type { DateMoveProtection } from './useGanttMove';
export type WindowFit = Exclude<LoadedFit, { kind: 'none' }> & { origin: 'initial' | 'explicit' };
export interface ScheduleDraftRow { taskId: string; title: string; expectedRevision: number; startDate: string; dueDate: string; baseStart: string; baseDue: string; editable: boolean }
/** `origin: 'move'` marks a draft staged by a Gantt bar drop; it is otherwise an ordinary retained draft. */
export interface ScheduleDraft { id: string; rows: ScheduleDraftRow[]; preview: TaskSchedulePreviewDto | null; previewFingerprint: string | null; error: Error | null; origin?: 'move' }
/** Why a bar move cannot start or stage now; the manual date editor stays available either way. */
export type MoveGate = 'draft' | 'command' | 'denied' | 'scope' | null;
export interface MoveScope { actorId: string; workspaceId: string; projectId: string }
const fingerprint = (input: TaskScheduleBatchInput) => JSON.stringify(input);
export function scheduleDraftInput(draft: ScheduleDraft): TaskScheduleBatchInput | null {
  const parsed = taskScheduleBatchInputSchema.safeParse({ rows: draft.rows.map(row => ({ taskId: row.taskId, expectedRevision: row.expectedRevision, startDate: row.startDate || null, dueDate: row.dueDate || null })) });
  return parsed.success ? parsed.data : null;
}
export function useScheduleWorkspace(actorId: string, workspaceId: string, projectId: string, timezone: string) {
  const { t } = useTranslation();
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
  const client = useQueryClient();
  // Synchronous mirror of retained draft IDs: a drop in the same tick as open/discard sees them before React renders.
  const draftIds = useRef(new Set<string>());
  // Refresh leases transferred by Gantt drops. Only apply success, explicit discard or scope cleanup release them;
  // closing the dialog, switching views or unmounting the bar never does.
  const moveLeases = useRef(new Map<string, DateMoveProtection>());
  const liveScope = useRef<MoveScope | null>(null);
  const releaseMove = useCallback((id: string) => {
    const lease = moveLeases.current.get(id);
    if (!lease) return;
    moveLeases.current.delete(id); lease.dispose();
  }, []);
  useLayoutEffect(() => {
    liveScope.current = { actorId, workspaceId, projectId };
    const leases = moveLeases.current;
    return () => { liveScope.current = null; for (const lease of leases.values()) lease.dispose(); leases.clear(); };
  }, [actorId, workspaceId, projectId]);
  const [windowStart, setWindowStartState] = useState(() => todayIn(timezone));
  const [windowSize, setWindowSizeState] = useState(28);
  const [windowFit, setWindowFit] = useState<WindowFit | null>(null);
  // Page-owned and synchronous: any explicit window choice settles the window before a late context read can.
  const windowSettled = useRef(false);
  const setWindowStart = useCallback((value: string) => { windowSettled.current = true; setWindowStartState(value); }, []);
  const setWindowSize = useCallback((value: number) => { windowSettled.current = true; setWindowSizeState(value); }, []);
  const applyFit = useCallback((fit: LoadedFit, origin: WindowFit['origin']) => {
    windowSettled.current = true;
    if (fit.kind === 'none') return;
    setWindowStartState(fit.start); setWindowSizeState(fit.days); setWindowFit({ ...fit, origin });
  }, []);
  const fitWindow = useCallback((fit: LoadedFit) => applyFit(fit, 'explicit'), [applyFit]);
  /** One shot per controller; callers pass only a complete, authorized loaded snapshot. No dates also settles it. */
  const initializeWindow = useCallback((fit: LoadedFit) => { if (!windowSettled.current) applyFit(fit, 'initial'); }, [applyFit]);
  const [baselinePeriodId, setBaselinePeriodId] = useState('');
  const [baselineId, setBaselineId] = useState('');
  const mutation = useApplySchedule(actorId, workspaceId, projectId, variables => {
    draftIds.current.delete(variables.draftId); releaseMove(variables.draftId);
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
      if (!context) throw new Error(t('schedule.useScheduleWorkspace.authorizedContextMissing'));
      return { taskId: task.id, title: task.title, expectedRevision: context.taskRevision, startDate: context.current.startDate ?? '', dueDate: context.current.dueDate ?? '', baseStart: context.current.startDate ?? '', baseDue: context.current.dueDate ?? '', editable: context.editableDates };
    }) };
    draftIds.current.add(draft.id);
    setDrafts(current => ({ ...current, [draft.id]: draft })); setActiveId(draft.id);
  };
  const change =(id: string, taskId: string, patch: Partial<Pick<ScheduleDraftRow, 'startDate' | 'dueDate'>>) => {
    if (held?.draftId === id) return;
    setDrafts(current => { const draft = current[id]; return draft ? { ...current, [id]: { ...draft, rows: draft.rows.map(row => row.taskId === taskId ? { ...row, ...patch } : row), preview: null, previewFingerprint: null, error: null } } : current; });
  };
  const shift = (id: string, amount: number) => {
    if (held?.draftId === id) return;
    setDrafts(current => {
      const draft = current[id]; if (!draft) return current;
      const rows = draft.rows.map(row => ({ ...row, startDate: row.startDate ? shiftDay(row.startDate, amount) : '', dueDate: row.dueDate ? shiftDay(row.dueDate, amount) : '' }));
      if (rows.some(row => row.startDate === null || row.dueDate === null)) return { ...current, [id]: { ...draft, error: new Error(t('schedule.useScheduleWorkspace.theMoveExceedsTheAllowedCalendarDateRange')) } };
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
    } catch (error) { if (isAccessDenied(error)) noteReadDenied(); setDrafts(current => { const now = current[draft.id]; const parsed = now ? scheduleDraftInput(now) : null; return now && parsed && requests.current[draft.id] === stamp && fingerprint(parsed) === source ? { ...current, [draft.id]: { ...now, error: error instanceof Error ? error : new Error(t('schedule.useScheduleWorkspace.couldNotPreviewDates')) } } : current; }); }
    finally { setPreviewing(current => current === draft.id ? null : current); }
  };
  const rebase = async (draft: ScheduleDraft) => {
    if (held || rebasing !== null) return;
    setRebasing(draft.id);
    try {
      const result = await fetchScheduleContext(workspaceId, projectId, { taskIds: draft.rows.map(row => row.taskId) });
      setDrafts(current => { const now = current[draft.id]; return now ? { ...current, [draft.id]: { ...now, rows: now.rows.map(row => { const fresh = result.rows.find(item => item.taskId === row.taskId); return fresh ? { ...row, expectedRevision: fresh.taskRevision, baseStart: fresh.current.startDate ?? '', baseDue: fresh.current.dueDate ?? '', editable: fresh.editableDates } : row; }), preview: null, previewFingerprint: null, error: null } } : current; });
      mutation.reset();
    } catch (error) { if (isAccessDenied(error)) noteReadDenied(); setDrafts(current => current[draft.id] ? { ...current, [draft.id]: { ...current[draft.id], error: error instanceof Error ? error : new Error(t('schedule.useScheduleWorkspace.couldNotRefreshDates')) } } : current); }
    finally { setRebasing(null); }
  };
  const apply = (draft: ScheduleDraft) => {
    const input = scheduleDraftInput(draft);
    if (!input || held || denied || rebasing !== null || !draft.preview || draft.previewFingerprint !== fingerprint(input) || draft.preview.protectedTargets.length || draft.preview.recoveryPeriodIds.length) return;
    mutation.mutate({ draftId: draft.id, input: { ...input, previewHash: draft.preview.previewHash } });
  };
  const discard = (id: string) => { if (held?.draftId === id) return; draftIds.current.delete(id); releaseMove(id); setDrafts(current => Object.fromEntries(Object.entries(current).filter(([key]) => key !== id))); setActiveId(current => current === id ? null : current); };
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
      setDrafts(current => current[draft.id] ? { ...current, [draft.id]: { ...current[draft.id], error: error instanceof Error ? error : new Error(t('schedule.useScheduleWorkspace.couldNotOpenThePeriod')) } } : current);
      return null;
    } finally { setOpeningRecovery(null); }
  };
  const dirty = Object.values(drafts).some(draft => draft.rows.some(row => row.startDate !== row.baseStart || row.dueDate !== row.baseDue));
  useProtectedDraft(dirty); useUnsavedChangesWarning(dirty);
  const deniedNow = useRef(denied); deniedNow.current = denied;
  const heldNow = useRef(held); heldNow.current = held;
  const latestPreview = useRef(preview); latestPreview.current = preview;
  /**
   * Synchronous refs only. Any pending/unknown command of this QueryClient and every retained schedule draft
   * refuse a move: a drop never reuses, opens or previews an older draft. Unrelated task drafts keep their own owners,
   * and the gesture's own transferred lease is not a reason to refuse.
   */
  const moveGate = useCallback((): MoveGate => {
    if (!liveScope.current) return 'scope';
    if (protectedCommandsFor(client).protecting || heldNow.current) return 'command';
    if (draftIds.current.size || moveLeases.current.size || Object.keys(latestDrafts.current).length) return 'draft';
    return deniedNow.current ? 'denied' : null;
  }, [client]);
  /** Atomic drop handoff: rechecks the gate, creates exactly one new draft and previews that exact input. True adopts the lease. */
  const stageMove = useCallback((proposal: DateMoveProposal, lease: DateMoveProtection, scope: MoveScope): boolean => {
    const live = liveScope.current, { source } = proposal;
    if (moveGate() !== null || !live || live.actorId !== scope.actorId || live.workspaceId !== scope.workspaceId || live.projectId !== scope.projectId) return false;
    if (proposal.dayDelta === 0 || (source.startDate === null) !== (proposal.startDate === null) || (source.dueDate === null) !== (proposal.dueDate === null)) return false;
    const draft: ScheduleDraft = { id: crypto.randomUUID(), origin: 'move', preview: null, previewFingerprint: null, error: null, rows: [{
      taskId: source.taskId, title: source.title, expectedRevision: source.expectedRevision, startDate: proposal.startDate ?? '', dueDate: proposal.dueDate ?? '',
      baseStart: source.startDate ?? '', baseDue: source.dueDate ?? '', editable: true }] };
    if (!scheduleDraftInput(draft)) return false;
    draftIds.current.add(draft.id); moveLeases.current.set(draft.id, lease);
    setDrafts(current => ({ ...current, [draft.id]: draft })); setActiveId(draft.id);
    void latestPreview.current(draft);
    return true;
  }, [moveGate]);
  return { drafts, active, activeId, setActiveId, open, change, shift, preview, previewing, rebase, rebasing, apply, discard, mutation, held, denied, noteReadDenied, clearDenial, openingRecovery, resolveRecoveryPeriod, moveGate, stageMove,
    windowStart, setWindowStart, windowSize, setWindowSize, windowFit, fitWindow, initializeWindow, baselinePeriodId, setBaselinePeriodId, baselineId, setBaselineId };
}
export type ScheduleWorkspace = ReturnType<typeof useScheduleWorkspace>;
export const scheduleConflict = (error: unknown) => error instanceof ApiError && error.kind === 'conflict';
