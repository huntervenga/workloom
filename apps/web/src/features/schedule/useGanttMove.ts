import { useLayoutEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { useQueryClient, type QueryClient } from '@tanstack/react-query';
import { protectedDraftsFor } from '../../lib/protectedDrafts';
import { queryKeys } from '../../lib/queryKeys';
import { DATE_MOVE_THRESHOLD, dateMoveAtPixels, type DateMoveProposal, type DateMoveSource } from './dateGesture';

export interface DateMoveProtection { dispose: () => void }
export type DateMoveCancelReason = 'escape' | 'pointercancel' | 'lostcapture' | 'viewport' | 'blur' | 'source' | 'capture';

/**
 * Set protection and cancel old mount-affecting answers in the pointerdown stack, before React
 * effects or the live-refresh observer's microtask. Cancellation also rejects signal-ignoring reads.
 */
export function protectDateMove(client: QueryClient, actorId: string, workspaceId: string): DateMoveProtection {
  const entry = protectedDraftsFor(client).register();
  entry.set(true);
  const scope = queryKeys.workspace(actorId, workspaceId);
  void client.cancelQueries({ predicate: query => {
    const key = query.queryKey;
    if (!scope.every((part, index) => key[index] === part)) return false;
    const branch = key[scope.length];
    return query.isActive() && (branch === undefined || branch === 'project' || branch === 'tasks' || branch === 'schedule' || branch === 'change-head');
  } }).catch(() => undefined);
  return { dispose: entry.dispose };
}

interface MoveOptions {
  actorId: string;
  workspaceId: string;
  source: DateMoveSource | null;
  /** Changes whenever the window, zoom, filter/view scope or controlled geometry changes. */
  viewportKey: string;
  pixelsPerDay: number;
  getTrack: () => HTMLElement | null;
  /** True transfers the lease to the page-owned retained draft. False keeps no proposal. */
  onDrop: (proposal: DateMoveProposal, protection: DateMoveProtection) => boolean;
  onCancel?: (reason: DateMoveCancelReason) => void;
}
interface MoveSession {
  pointerId: number;
  clientX: number;
  target: HTMLElement;
  track: HTMLElement;
  trackLeft: number;
  trackWidth: number;
  trackTop: number;
  actorId: string;
  workspaceId: string;
  source: DateMoveSource;
  viewportKey: string;
  pixelsPerDay: number;
  protection: DateMoveProtection;
  active: boolean;
  cleanup: () => void;
}
/** One gesture per QueryClient: every bar has its own hook, and mouse and pen can both be primary pointers. */
const gestures = new WeakMap<QueryClient, object>();
export const dateMoveActive = (client: QueryClient) => gestures.has(client);
const sameSource = (a: DateMoveSource | null, b: DateMoveSource) => !!a && a.taskId === b.taskId && a.title === b.title &&
  a.expectedRevision === b.expectedRevision && a.startDate === b.startDate && a.dueDate === b.dueDate;

/** Move only: the caller renders a proposal ghost and keeps saved bars/connectors authoritative. */
export function useGanttMove(options: MoveOptions) {
  const client = useQueryClient();
  const latest = useRef(options); latest.current = options;
  const session = useRef<MoveSession | null>(null);
  const suppressClick = useRef(false);
  const [proposal, setProposal] = useState<DateMoveProposal | null>(null);
  const cancelRef = useRef<(reason: DateMoveCancelReason) => void>(() => undefined);

  const detach = (current: MoveSession) => {
    if (session.current !== current) return;
    session.current = null;
    if (gestures.get(client) === current) gestures.delete(client);
    current.cleanup();
    try { if (current.target.hasPointerCapture(current.pointerId)) current.target.releasePointerCapture(current.pointerId); } catch { /* Capture may already be lost. */ }
    setProposal(null);
  };
  const cancel = (reason: DateMoveCancelReason) => {
    const current = session.current;
    if (!current) return;
    suppressClick.current = current.active;
    detach(current);
    current.protection.dispose();
    latest.current.onCancel?.(reason);
  };
  cancelRef.current = cancel;

  useLayoutEffect(() => {
    const current = session.current;
    if (current && (options.actorId !== current.actorId || options.workspaceId !== current.workspaceId || !sameSource(options.source, current.source) || options.viewportKey !== current.viewportKey || options.pixelsPerDay !== current.pixelsPerDay)) cancelRef.current('source');
  });
  useLayoutEffect(() => () => {
    const current = session.current;
    if (!current) return;
    session.current = null;
    if (gestures.get(client) === current) gestures.delete(client);
    current.cleanup();
    try { if (current.target.hasPointerCapture(current.pointerId)) current.target.releasePointerCapture(current.pointerId); } catch { /* Detached target. */ }
    current.protection.dispose();
  }, [client, options.actorId, options.workspaceId]);

  const onPointerDown = (event: ReactPointerEvent<HTMLElement>) => {
    const input = latest.current;
    if (session.current || gestures.has(client) || !input.source || !event.isPrimary || event.button !== 0 || !Number.isFinite(event.clientX) ||
      !Number.isFinite(input.pixelsPerDay) || input.pixelsPerDay <= 0) return;
    const track = input.getTrack();
    const rect = track?.getBoundingClientRect();
    if (!track || !rect || rect.width <= 0 || !Number.isFinite(rect.left) || !Number.isFinite(rect.width)) return;
    // This order is deliberate: protection and cancellation precede capture, focus or state updates.
    const protection = protectDateMove(client, input.actorId, input.workspaceId);
    const target = event.currentTarget;
    const current: MoveSession = { pointerId: event.pointerId, clientX: event.clientX, target, track,
      trackLeft: rect.left, trackWidth: rect.width, trackTop: rect.top, actorId: input.actorId, workspaceId: input.workspaceId, source: Object.freeze({ ...input.source }), viewportKey: input.viewportKey,
      pixelsPerDay: input.pixelsPerDay, protection, active: false, cleanup: () => undefined };
    session.current = current;
    gestures.set(client, current);
    suppressClick.current = false;
    const validGeometry = () => {
      const now = latest.current, bounds = track.getBoundingClientRect();
      return track.isConnected && target.isConnected && now.actorId === current.actorId && now.workspaceId === current.workspaceId && sameSource(now.source, current.source) &&
        now.viewportKey === current.viewportKey && now.pixelsPerDay === current.pixelsPerDay &&
        bounds.left === current.trackLeft && bounds.width === current.trackWidth && bounds.top === current.trackTop;
    };
    const update = (e: PointerEvent) => {
      if (session.current !== current || e.pointerId !== current.pointerId) return null;
      if (!validGeometry()) { cancelRef.current('viewport'); return null; }
      const pixels = e.clientX - current.clientX;
      if (!Number.isFinite(pixels)) { cancelRef.current('pointercancel'); return null; }
      if (Math.abs(pixels) >= DATE_MOVE_THRESHOLD) current.active = true;
      const next = dateMoveAtPixels(current.source, pixels, current.pixelsPerDay);
      if (!next) { cancelRef.current('pointercancel'); return null; }
      if (current.active) setProposal(next);
      return next;
    };
    const move = (e: PointerEvent) => { const next = update(e); if (next && current.active && e.cancelable) e.preventDefault(); };
    const up = (e: PointerEvent) => {
      const next = update(e);
      if (!next || session.current !== current) return;
      const changed = current.active && next.dayDelta !== 0;
      suppressClick.current = current.active;
      detach(current);
      let transferred = false;
      try { if (changed) transferred = latest.current.onDrop(next, protection); }
      finally { if (!transferred) protection.dispose(); }
    };
    const pointerCancel = (e: PointerEvent) => { if (e.pointerId === current.pointerId) cancelRef.current('pointercancel'); };
    const lostCapture = (e: PointerEvent) => { if (e.pointerId === current.pointerId) cancelRef.current('lostcapture'); };
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); cancelRef.current('escape'); } };
    const viewport = () => cancelRef.current('viewport');
    const blur = () => cancelRef.current('blur');
    const hidden = () => { if (document.visibilityState === 'hidden') cancelRef.current('blur'); };
    document.addEventListener('pointermove', move, { passive: false });
    document.addEventListener('pointerup', up);
    document.addEventListener('pointercancel', pointerCancel);
    target.addEventListener('lostpointercapture', lostCapture);
    document.addEventListener('keydown', key, true);
    document.addEventListener('scroll', viewport, true);
    document.addEventListener('visibilitychange', hidden);
    window.addEventListener('resize', viewport);
    window.addEventListener('blur', blur);
    current.cleanup = () => {
      document.removeEventListener('pointermove', move);
      document.removeEventListener('pointerup', up);
      document.removeEventListener('pointercancel', pointerCancel);
      target.removeEventListener('lostpointercapture', lostCapture);
      document.removeEventListener('keydown', key, true);
      document.removeEventListener('scroll', viewport, true);
      document.removeEventListener('visibilitychange', hidden);
      window.removeEventListener('resize', viewport);
      window.removeEventListener('blur', blur);
    };
    try { target.setPointerCapture(event.pointerId); }
    catch { cancelRef.current('capture'); }
  };
  return { proposal, onPointerDown,
    onClickCapture: (event: { preventDefault: () => void; stopPropagation: () => void }) => {
      if (!suppressClick.current) return;
      suppressClick.current = false; event.preventDefault(); event.stopPropagation();
    },
    cancel: () => cancelRef.current('source'),
  };
}
