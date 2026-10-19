import { useTranslation } from '../../i18n';
import { taskScheduleBatchInputSchema, type TaskDto, type TaskScheduleContextRowDto, type TaskSchedulePreviewDto, type TaskScheduleBatchInput } from '@workloom/contracts';
import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { ApiError, isAccessDenied, isUncertainOutcome } from '../../lib/api';
import { PendingCommandError, UncertainCommandError } from '../../lib/idempotency';
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
/**
 * Where a Gantt drop is in the direct save lane: waiting its turn, previewing/applying, sent with an unknown outcome
 * (kept for Retry original), or stopped for explicit review (known failure or a preview that is not an exact clean match).
 */
export type MoveState = 'queued' | 'sending' | 'unknown' | 'failed';
/** `origin: 'move'` marks a draft staged by a Gantt bar drop; `moveState` is its place in the direct save lane. */
export interface ScheduleDraft { id: string; rows: ScheduleDraftRow[]; preview: TaskSchedulePreviewDto | null; previewFingerprint: string | null; error: Error | null; origin?: 'move'; moveState?: MoveState }
/** Why a bar move cannot start or stage now; the manual date editor stays available either way. */
export type MoveGate = 'draft' | 'command' | 'denied' | 'scope' | null;
export interface MoveScope { actorId: string; workspaceId: string; projectId: string }
/** Synchronous lane entry; `row` is frozen and replaced only while the entry is still queued (unsent). */
interface MoveEntry { state: MoveState; row: Readonly<ScheduleDraftRow> }
const fingerprint = (input: TaskScheduleBatchInput) => JSON.stringify(input);
export function scheduleDraftInput(draft: Pick<ScheduleDraft, 'rows'>): TaskScheduleBatchInput | null {
  const parsed = taskScheduleBatchInputSchema.safeParse({ rows: draft.rows.map(row => ({ taskId: row.taskId, expectedRevision: row.expectedRevision, startDate: row.startDate || null, dueDate: row.dueDate || null })) });
  return parsed.success ? parsed.data : null;
}
/**
 * A drop applies by itself only when the server preview is exactly the captured move: the one task at the captured
 * revision, before equal to the captured source, after equal to the proposal, and no protected/readiness blocker.
 * Dependency date comparisons are warnings, as in the manual editor and server apply contract.
 */
export function directMovePreviewMatches(preview: TaskSchedulePreviewDto, row: Readonly<ScheduleDraftRow>, projectId: string): boolean {
  const only = preview.rows.length === 1 ? preview.rows[0] : undefined;
  return !!only && preview.projectId === projectId && only.taskId === row.taskId && only.expectedRevision === row.expectedRevision && only.changed &&
    (only.before.startDate ?? '') === row.baseStart && (only.before.dueDate ?? '') === row.baseDue &&
    (only.after.startDate ?? '') === row.startDate && (only.after.dueDate ?? '') === row.dueDate &&
    !preview.protectedTargets.length && !preview.recoveryPeriodIds.length;
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
  // Synchronous mirror of retained drafts and their task IDs: a drop in the same tick as open/discard sees them before React renders.
  const draftTasks = useRef(new Map<string, readonly string[]>());
  // Synchronous direct-save lane: entries by draft ID, unsent order, and the one draft being previewed/applied.
  const moves = useRef(new Map<string, MoveEntry>());
  const queue = useRef<string[]>([]);
  const lane = useRef<{ id: string; generation: number } | null>(null);
  // Bumped by scope cleanup: an answer for an older generation never stages, previews further or applies.
  const generation = useRef(0);
  const invalidateMoveScope = useCallback(() => { generation.current++; }, []);
  // Refresh leases transferred by Gantt drops. Only apply success, a known failure or explicit review state, explicit
  // discard or scope cleanup release them; an unknown outcome keeps its lease. Closing the dialog or unmounting the bar never does.
  const moveLeases = useRef(new Map<string, DateMoveProtection>());
  const liveScope = useRef<MoveScope | null>(null);
  const releaseMove = useCallback((id: string) => {
    const lease = moveLeases.current.get(id);
    if (!lease) return;
    moveLeases.current.delete(id); lease.dispose();
  }, []);
  const forget = useCallback((id: string) => {
    draftTasks.current.delete(id); moves.current.delete(id);
    queue.current = queue.current.filter(item => item !== id);
    releaseMove(id);
  }, [releaseMove]);
  const patchDraft = useCallback((id: string, patch: Partial<ScheduleDraft>) => setDrafts(current => current[id] ? { ...current, [id]: { ...current[id], ...patch } } : current), []);
  useLayoutEffect(() => {
    liveScope.current = { actorId, workspaceId, projectId };
    const leases = moveLeases.current, entries = moves.current, tasks = draftTasks.current;
    return () => {
      liveScope.current = null; invalidateMoveScope(); lane.current = null;
      for (const lease of leases.values()) lease.dispose();
      leases.clear();
      // Unsent and in-flight-preview proposals belong to the old scope and were never written: drop them without a write.
      const dropped = [...entries].filter(([, entry]) => entry.state === 'queued' || entry.state === 'sending').map(([id]) => id);
      for (const id of dropped) { entries.delete(id); tasks.delete(id); }
      queue.current = [];
      if (dropped.length) setDrafts(current => Object.fromEntries(Object.entries(current).filter(([id]) => !dropped.includes(id))));
    };
  }, [actorId, workspaceId, projectId, invalidateMoveScope]);
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
  // Confirmed success only: the receipt is never merged into the cache; useApplySchedule invalidates the authoritative reads.
  const mutation = useApplySchedule(actorId, workspaceId, projectId, variables => {
    forget(variables.draftId);
    setDrafts(current => Object.fromEntries(Object.entries(current).filter(([id]) => id !== variables.draftId)));
    setActiveId(current => current === variables.draftId ? null : current);
  });
  const latestMutation = useRef(mutation); latestMutation.current = mutation;
  const held = mutation.pendingCommand?.variables ?? mutation.uncertain?.variables ?? null;
  const active = activeId ? drafts[activeId] ?? null : null;
  /** Queued or sending lane drafts are owned by the lane; the manual editor waits for them to settle. */
  const laneOwned = (id: string) => { const state = moves.current.get(id)?.state; return state === 'queued' || state === 'sending'; };
  const open = (tasks: readonly TaskDto[], contexts: ReadonlyMap<string, TaskScheduleContextRowDto>) => {
    if (!tasks.length || tasks.length > 100 || tasks.some(task => !contexts.has(task.id))) return;
    if ([...draftTasks.current].some(([id, taskIds]) => laneOwned(id) && tasks.some(task => taskIds.includes(task.id)))) return;
    const ids = tasks.map(task => task.id).sort().join(',');
    const previous = Object.values(drafts).find(draft => draft.rows.map(row => row.taskId).sort().join(',') === ids);
    if (previous) { setActiveId(previous.id); return; }
    const draft: ScheduleDraft = { id: crypto.randomUUID(), preview: null, previewFingerprint: null, error: null, rows: tasks.map(task => {
      const context = contexts.get(task.id);
      if (!context) throw new Error(t('schedule.useScheduleWorkspace.authorizedContextMissing'));
      return { taskId: task.id, title: task.title, expectedRevision: context.taskRevision, startDate: context.current.startDate ?? '', dueDate: context.current.dueDate ?? '', baseStart: context.current.startDate ?? '', baseDue: context.current.dueDate ?? '', editable: context.editableDates };
    }) };
    draftTasks.current.set(draft.id, draft.rows.map(row => row.taskId));
    setDrafts(current => ({ ...current, [draft.id]: draft })); setActiveId(draft.id);
  };
  const change =(id: string, taskId: string, patch: Partial<Pick<ScheduleDraftRow, 'startDate' | 'dueDate'>>) => {
    if (held?.draftId === id || laneOwned(id)) return;
    setDrafts(current => { const draft = current[id]; return draft ? { ...current, [id]: { ...draft, rows: draft.rows.map(row => row.taskId === taskId ? { ...row, ...patch } : row), preview: null, previewFingerprint: null, error: null } } : current; });
  };
  const shift = (id: string, amount: number) => {
    if (held?.draftId === id || laneOwned(id)) return;
    setDrafts(current => {
      const draft = current[id]; if (!draft) return current;
      const rows = draft.rows.map(row => ({ ...row, startDate: row.startDate ? shiftDay(row.startDate, amount) : '', dueDate: row.dueDate ? shiftDay(row.dueDate, amount) : '' }));
      if (rows.some(row => row.startDate === null || row.dueDate === null)) return { ...current, [id]: { ...draft, error: new Error(t('schedule.useScheduleWorkspace.theMoveExceedsTheAllowedCalendarDateRange')) } };
      return { ...current, [id]: { ...draft, rows: rows.map(row => ({ ...row, startDate: row.startDate ?? '', dueDate: row.dueDate ?? '' })), preview: null, previewFingerprint: null, error: null } };
    });
  };
  const preview = async (draft: ScheduleDraft) => {
    const input = scheduleDraftInput(draft);
    if (!input || held || denied || previewing === draft.id || laneOwned(draft.id)) return;
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
    if (held || rebasing !== null || laneOwned(draft.id)) return;
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
    if (!input || held || denied || rebasing !== null || laneOwned(draft.id) || !draft.preview || draft.previewFingerprint !== fingerprint(input) || draft.preview.protectedTargets.length || draft.preview.recoveryPeriodIds.length) return;
    mutation.mutate({ draftId: draft.id, undoPreview: structuredClone(draft.preview), input: { ...input, previewHash: draft.preview.previewHash } });
  };
  /** Cancel never writes: a queued proposal leaves the lane, an in-flight preview is ignored when it answers. */
  const discard = (id: string) => { if (held?.draftId === id) return; forget(id); setDrafts(current => Object.fromEntries(Object.entries(current).filter(([key]) => key !== id))); setActiveId(current => current === id ? null : current); };
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
  /** Known failure or an inexact/blocked preview: retained for explicit review; its lease goes so unrelated rows still refresh and move. */
  const stopMove = useCallback((id: string, error: Error | null) => {
    const entry = moves.current.get(id);
    if (!entry) return;
    entry.state = 'failed'; releaseMove(id);
    patchDraft(id, { moveState: 'failed', error });
  }, [patchDraft, releaseMove]);
  /** One lane step: preview the exact frozen row, then apply only an exact clean match. Never rebases or resends. */
  const runMove = async (id: string, entry: MoveEntry, scopeGeneration: number): Promise<'done' | 'unknown'> => {
    const live = () => generation.current === scopeGeneration && liveScope.current !== null && moves.current.get(id) === entry;
    const row = entry.row;
    // Preview is read-only: the row remains unsent and may be replaced by a newer proposal
    // from the exact same captured revision. Only the apply boundary below makes it sending.
    entry.state = 'queued';
    patchDraft(id, { moveState: 'sending', preview: null, previewFingerprint: null, error: null });
    const replaced = () => {
      if (entry.row === row) return false;
      queue.current = [id, ...queue.current.filter(item => item !== id)];
      patchDraft(id, { moveState: 'queued', preview: null, previewFingerprint: null, error: null });
      return true;
    };
    const input = scheduleDraftInput({ rows: [row] });
    if (!input) { stopMove(id, new Error(t('schedule.scheduleDialog.checkDatesStartMustBeOnOrBefore'))); return 'done'; }
    let result: TaskSchedulePreviewDto;
    try { result = await previewSchedule(workspaceId, projectId, input); }
    catch (error) {
      if (!live() || replaced()) return 'done';
      if (isAccessDenied(error)) noteReadDenied();
      stopMove(id, error instanceof Error ? error : new Error(t('schedule.useScheduleWorkspace.couldNotPreviewDates')));
      return 'done';
    }
    if (!live() || replaced()) return 'done';
    patchDraft(id, { preview: result, previewFingerprint: fingerprint(input) });
    if (!directMovePreviewMatches(result, row, projectId)) { stopMove(id, null); return 'done'; }
    const m = latestMutation.current;
    // Another write (or this hook's unknown) appeared while previewing: wait unsent at the head of the lane.
    if (m.uncertain || m.pendingCommand || m.hasOtherProtectedCommands() || deniedNow.current) {
      entry.state = 'queued'; queue.current = [id, ...queue.current.filter(item => item !== id)];
      patchDraft(id, { moveState: 'queued', preview: null, previewFingerprint: null });
      return 'unknown';
    }
    try {
      entry.state = 'sending';
      patchDraft(id, { moveState: 'sending' });
      await m.mutateAsync({ draftId: id, undoPreview: structuredClone(result), input: { ...input, previewHash: result.previewHash } });
      return 'done';
    } catch (error) {
      if (moves.current.get(id) !== entry) return 'done';
      if (error instanceof PendingCommandError || error instanceof UncertainCommandError) {
        // Refused before sending: nothing was written, so it may wait its turn again.
        entry.state = 'queued'; queue.current = [id, ...queue.current.filter(item => item !== id)];
        patchDraft(id, { moveState: 'queued', preview: null, previewFingerprint: null });
        return 'unknown';
      }
      if (isUncertainOutcome(error)) {
        // Keeps the exact command, key and lease; only the explicit Retry original resends it.
        entry.state = 'unknown'; patchDraft(id, { moveState: 'unknown' });
        return 'unknown';
      }
      if (isAccessDenied(error)) noteReadDenied();
      stopMove(id, error instanceof Error ? error : new Error(t('schedule.useScheduleWorkspace.couldNotPreviewDates')));
      return 'done';
    }
  };
  const pump = () => {
    if (lane.current || !liveScope.current || deniedNow.current) return;
    const m = latestMutation.current;
    if (m.uncertain || m.pendingCommand || m.hasOtherProtectedCommands()) return;
    let next: [string, MoveEntry] | null = null;
    while (!next && queue.current.length) {
      const [head, ...rest] = queue.current; queue.current = rest;
      const candidate = head === undefined ? undefined : moves.current.get(head);
      if (head !== undefined && candidate?.state === 'queued') next = [head, candidate];
    }
    if (!next) return;
    const [id, entry] = next;
    const token = { id, generation: generation.current };
    lane.current = token;
    void runMove(id, entry, token.generation).catch(() => 'done' as const).then(outcome => {
      if (lane.current !== token) return;
      lane.current = null;
      // After an unknown or a refusal the lane waits for the held command to settle (see the effect below).
      if (outcome === 'done') latestPump.current();
    });
  };
  const latestPump = useRef(pump); latestPump.current = pump;
  // Resume when a held command settles, a denial clears or any other protected command of this client ends.
  useEffect(() => { if (!held && !denied) latestPump.current(); }, [held, denied]);
  useEffect(() => protectedCommandsFor(client).subscribe(() => queueMicrotask(() => latestPump.current())), [client]);
  // An explicit Retry original of a moved row that then failed with a known answer stops for review and releases its lease.
  const settledError = mutation.error, settledId = mutation.variables?.draftId;
  useEffect(() => {
    if (held || !settledError || !settledId || isUncertainOutcome(settledError)) return;
    if (moves.current.get(settledId)?.state !== 'unknown') return;
    if (isAccessDenied(settledError)) noteReadDenied();
    stopMove(settledId, settledError);
  }, [held, settledError, settledId, noteReadDenied, stopMove]);
  /**
   * Synchronous refs only. Without a task: scope, any other hook's pending/unknown command, this hook's unknown or
   * manual pending command, or a denial refuses every move; this hook's own pending move does not. With a task, a
   * retained draft of that task also refuses it, except an unsent queued move, which a matching drop may coalesce.
   */
  const moveGate = useCallback((taskId?: string): MoveGate => {
    if (!liveScope.current) return 'scope';
    const m = latestMutation.current, pending = m.pendingCommand?.variables.draftId;
    if (m.hasOtherProtectedCommands() || m.uncertain || [...moves.current.values()].some(entry => entry.state === 'unknown') || (pending !== undefined && !moves.current.has(pending))) return 'command';
    if (deniedNow.current) return 'denied';
    if (taskId !== undefined) for (const [id, taskIds] of draftTasks.current) if (taskIds.includes(taskId) && moves.current.get(id)?.state !== 'queued') return 'draft';
    return null;
  }, []);
  /**
   * Atomic drop handoff: rechecks the task gate and enqueues the frozen proposal for the direct lane without opening
   * any dialog. An unsent queued proposal of the same task is replaced only when its captured revision and base dates
   * match exactly; anything else is refused. True adopts the lease.
   */
  const stageMove = useCallback((proposal: DateMoveProposal, lease: DateMoveProtection, scope: MoveScope): boolean => {
    const live = liveScope.current, { source } = proposal;
    if (moveGate(source.taskId) !== null || !live || live.actorId !== scope.actorId || live.workspaceId !== scope.workspaceId || live.projectId !== scope.projectId) return false;
    if (proposal.dayDelta === 0 || (source.startDate === null) !== (proposal.startDate === null) || (source.dueDate === null) !== (proposal.dueDate === null)) return false;
    const row: Readonly<ScheduleDraftRow> = Object.freeze({ taskId: source.taskId, title: source.title, expectedRevision: source.expectedRevision, startDate: proposal.startDate ?? '',
      dueDate: proposal.dueDate ?? '', baseStart: source.startDate ?? '', baseDue: source.dueDate ?? '', editable: true });
    if (!scheduleDraftInput({ rows: [row] })) return false;
    const same = [...moves.current].find(([, entry]) => entry.row.taskId === row.taskId);
    if (same) {
      const [id, entry] = same;
      if (entry.state !== 'queued' || entry.row.expectedRevision !== row.expectedRevision || entry.row.baseStart !== row.baseStart || entry.row.baseDue !== row.baseDue) return false;
      entry.row = row;
      const previous = moveLeases.current.get(id);
      moveLeases.current.set(id, lease);
      if (previous && previous !== lease) previous.dispose();
      setDrafts(current => current[id] ? { ...current, [id]: { ...current[id], rows: [{ ...row }], preview: null, previewFingerprint: null, error: null } } : current);
      return true;
    }
    const id = crypto.randomUUID();
    draftTasks.current.set(id, [row.taskId]); moves.current.set(id, { state: 'queued', row }); moveLeases.current.set(id, lease); queue.current.push(id);
    setDrafts(current => ({ ...current, [id]: { id, origin: 'move', moveState: 'queued', preview: null, previewFingerprint: null, error: null, rows: [{ ...row }] } }));
    latestPump.current();
    return true;
  }, [moveGate]);
  return { drafts, active, activeId, setActiveId, open, change, shift, preview, previewing, rebase, rebasing, apply, discard, mutation, held, denied, noteReadDenied, clearDenial, openingRecovery, resolveRecoveryPeriod, moveGate, stageMove,
    windowStart, setWindowStart, windowSize, setWindowSize, windowFit, fitWindow, initializeWindow, baselinePeriodId, setBaselinePeriodId, baselineId, setBaselineId };
}
export type ScheduleWorkspace = ReturnType<typeof useScheduleWorkspace>;
export const scheduleConflict = (error: unknown) => error instanceof ApiError && error.kind === 'conflict';
