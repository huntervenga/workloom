import type { TaskDto, TaskStatusDto, UpdateTaskInput } from '@workloom/contracts';
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type MouseEvent } from 'react';
import { isUncertainOutcome } from '../../lib/api';
import { draftFromTask } from './taskDraft';
import { taskCompletion } from './taskCompletion';
import { unresolvedTaskCommand, type EditSession, type TaskCommands } from './useTaskCommands';

interface Attempt { session: EditSession; variables: { taskId: string; input: UpdateTaskInput }; error: Error | null }
interface Context { tasks: readonly TaskDto[]; statuses: readonly TaskStatusDto[]; writable: boolean; editingTaskId: string | null; focusScope?: string }
interface FocusLease { session: EditSession; scope: string | undefined; source: HTMLButtonElement; receipt: TaskDto | null }
interface FocusTarget { task: TaskDto; element: HTMLButtonElement }
/** Explicit button/menu intents share the existing update command and exact draft ledger. */
export function useTaskCompletion(commands: TaskCommands, context: Context, onSaved: () => void) {
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const latest = useRef(context); latest.current = context;
  const latestCommands = useRef(commands); latestCommands.current = commands;
  const current = useRef<Attempt | null>(null);
  const busy = useRef(false);
  // This lease grants focus only for one explicit intent. It never owns a command or draft.
  const focusLease = useRef<FocusLease | null>(null);
  const focusTargets = useRef(new Map<string, FocusTarget>());
  const ownsFocus = useCallback((lease: FocusLease, target: EventTarget | null) => target === lease.source || target === focusTargets.current.get(lease.session.base.id)?.element || target instanceof Element && target.closest('[data-task-completion-menu]')?.getAttribute('data-task-completion-menu') === lease.session.base.id, []);
  const restoreFocus = useCallback(() => {
    const lease = focusLease.current;
    if (!lease) return;
    const head = latest.current;
    const retained = latestCommands.current.editSessions.current.get(lease.session.base.id);
    if (!alive.current || !head.writable || head.focusScope !== lease.scope || head.editingTaskId !== null || retained && retained !== lease.session) { focusLease.current = null; return; }
    const receipt = lease.receipt;
    if (!receipt || !latestCommands.current.confirmedSessions.current.has(lease.session)) return;
    const task = head.tasks.find(task => task.id === receipt.id);
    // List refetch and receipt can arrive in either order. Never target an older or newer head.
    if (!task) { focusLease.current = null; return; }
    if (task.revision < receipt.revision) return;
    if (task.revision !== receipt.revision || task.statusId !== receipt.statusId || !taskCompletion(task, head.statuses).eligible) { focusLease.current = null; return; }
    const target = focusTargets.current.get(task.id);
    if (!target || target.task.revision !== task.revision || target.task.statusId !== task.statusId || !target.element.isConnected || target.element.disabled || target.element.getAttribute('aria-disabled') === 'true') return;
    if (document.activeElement !== document.body && !ownsFocus(lease, document.activeElement)) { focusLease.current = null; return; }
    focusLease.current = null;
    if (document.activeElement !== target.element) target.element.focus();
  }, [ownsFocus]);
  const targetReady = useCallback((task: TaskDto, element: HTMLButtonElement) => {
    if (!alive.current) return () => undefined;
    const target = { task, element };
    focusTargets.current.set(task.id, target);
    restoreFocus();
    // An old lane's cleanup must not unregister a replacement mounted in the new lane.
    return () => { if (focusTargets.current.get(task.id) === target) focusTargets.current.delete(task.id); };
  }, [restoreFocus]);
  const claimFocus = (session: EditSession, source: HTMLButtonElement | null | undefined) => {
    focusLease.current = source?.isConnected ? { session, scope: latest.current.focusScope, source, receipt: null } : null;
  };
  useLayoutEffect(() => { restoreFocus(); });
  useEffect(() => {
    const targets = focusTargets.current;
    const outside = (event: Event) => { const lease = focusLease.current; if (lease && !ownsFocus(lease, event.target)) focusLease.current = null; };
    const blur = () => { focusLease.current = null; };
    document.addEventListener('pointerdown', outside, true);
    document.addEventListener('focusin', outside, true);
    window.addEventListener('blur', blur);
    return () => { focusLease.current = null; targets.clear(); document.removeEventListener('pointerdown', outside, true); document.removeEventListener('focusin', outside, true); window.removeEventListener('blur', blur); };
  }, [ownsFocus]);
  const [attempt, setAttempt] = useState<Attempt | null>(null);
  const [reviewTaskId, setReviewTaskId] = useState<string | null>(null);
  const confirmed = attempt ? commands.confirmedSessions.current.has(attempt.session) : false;
  useEffect(() => {
    if (confirmed) { current.current = null; busy.current = false; setAttempt(null); }
  }, [confirmed]);
  const saved = (submitted: Attempt, task: TaskDto) => {
    commands.confirmSession(submitted.session, task);
    if (focusLease.current?.session === submitted.session) { focusLease.current.receipt = task; restoreFocus(); }
    if (current.current?.session !== submitted.session) return;
    current.current = null; busy.current = false; if (alive.current) { setAttempt(null); onSaved(); }
  };
  const choose = (seen: TaskDto, statusId: string, source?: HTMLButtonElement | null) => {
    const head = latest.current;
    if (!alive.current || !head.writable || busy.current || current.current?.error && isUncertainOutcome(current.current.error) || unresolvedTaskCommand(latestCommands.current) || head.editingTaskId === seen.id || commands.editSessions.current.has(seen.id)) return;
    const task = head.tasks.find(task => task.id === seen.id);
    if (!task || task.revision !== seen.revision || task.statusId !== seen.statusId) { setReviewTaskId(seen.id); return; }
    const decision = taskCompletion(task, head.statuses);
    if (!decision.eligible || !decision.choices.some(status => status.id === statusId)) { setReviewTaskId(seen.id); return; }
    const session: EditSession = { base: task, draft: { ...draftFromTask(task), statusId }, inlineField: 'statusId' };
    const submitted: Attempt = { session, variables: { taskId: task.id, input: { expectedRevision: task.revision, statusId } }, error: null };
    claimFocus(session, source);
    busy.current = true; current.current = submitted; setAttempt(submitted); setReviewTaskId(null);
    commands.editSessions.current.set(task.id, session);
    commands.update.mutate(submitted.variables, {
      onSuccess: task => saved(submitted, task),
      onError: error => { if (focusLease.current?.session === session) focusLease.current = null; if (current.current?.session === session) { const failed = { ...submitted, error }; current.current = failed; setAttempt(failed); } },
      onSettled: () => { busy.current = false; },
    });
  };
  const uncertain = attempt !== null && commands.update.uncertain?.variables === attempt.variables;
  const pending = attempt !== null && commands.update.pendingCommand?.variables === attempt.variables;
  const canRetry = uncertain && context.writable;
  const retained = attempt ? commands.editSessions.current.get(attempt.session.base.id) : null;
  useEffect(() => {
    if (attempt && !pending && !uncertain && !confirmed && retained !== attempt.session) { current.current = null; setAttempt(null); }
  }, [attempt, confirmed, pending, retained, uncertain]);
  const retry = (event?: Pick<MouseEvent<HTMLButtonElement>, 'currentTarget'>) => {
    const submitted = current.current;
    if (!alive.current || !submitted || !latest.current.writable || busy.current || latestCommands.current.update.pendingCommand || latestCommands.current.update.uncertain?.variables !== submitted.variables) return;
    claimFocus(submitted.session, event?.currentTarget);
    busy.current = true;
    latestCommands.current.update.retryUncertain({ onSuccess: task => saved(submitted, task), onError: error => { if (focusLease.current?.session === submitted.session) focusLease.current = null; if (current.current?.session === submitted.session) { const failed = { ...submitted, error }; current.current = failed; setAttempt(failed); } }, onSettled: () => { busy.current = false; } });
  };
  const acknowledgeReview = (taskId: string) => setReviewTaskId(before => before === taskId ? null : before);
  return { acknowledgeReview, targetReady, choose, attempt: confirmed ? null : attempt, pending, uncertain, canRetry, retry, reviewTaskId };
}
export type TaskCompletionController = ReturnType<typeof useTaskCompletion>;
