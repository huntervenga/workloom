import type { TaskDto, TaskStatusDto, UpdateTaskInput } from '@workloom/contracts';
import { useEffect, useRef, useState } from 'react';
import { isUncertainOutcome } from '../../lib/api';
import { draftFromTask } from './taskDraft';
import { taskCompletion } from './taskCompletion';
import { unresolvedTaskCommand, type EditSession, type TaskCommands } from './useTaskCommands';

interface Attempt { session: EditSession; variables: { taskId: string; input: UpdateTaskInput }; error: Error | null }
interface Context { tasks: readonly TaskDto[]; statuses: readonly TaskStatusDto[]; writable: boolean; editingTaskId: string | null }
/** Explicit button/menu intents share the existing update command and exact draft ledger. */
export function useTaskCompletion(commands: TaskCommands, context: Context, onSaved: () => void) {
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const latest = useRef(context); latest.current = context;
  const latestCommands = useRef(commands); latestCommands.current = commands;
  const current = useRef<Attempt | null>(null);
  const busy = useRef(false);
  const [attempt, setAttempt] = useState<Attempt | null>(null);
  const [reviewTaskId, setReviewTaskId] = useState<string | null>(null);
  const confirmed = attempt ? commands.confirmedSessions.current.has(attempt.session) : false;
  useEffect(() => {
    if (confirmed) { current.current = null; busy.current = false; setAttempt(null); }
  }, [confirmed]);
  const saved = (submitted: Attempt, task: TaskDto) => {
    commands.confirmSession(submitted.session, task);
    if (current.current?.session !== submitted.session) return;
    current.current = null; busy.current = false; if (alive.current) { setAttempt(null); onSaved(); }
  };
  const choose = (seen: TaskDto, statusId: string) => {
    const head = latest.current;
    if (!alive.current || !head.writable || busy.current || current.current?.error && isUncertainOutcome(current.current.error) || unresolvedTaskCommand(latestCommands.current) || head.editingTaskId === seen.id || commands.editSessions.current.has(seen.id)) return;
    const task = head.tasks.find(task => task.id === seen.id);
    if (!task || task.revision !== seen.revision || task.statusId !== seen.statusId) { setReviewTaskId(seen.id); return; }
    const decision = taskCompletion(task, head.statuses);
    if (!decision.eligible || !decision.choices.some(status => status.id === statusId)) { setReviewTaskId(seen.id); return; }
    const session: EditSession = { base: task, draft: { ...draftFromTask(task), statusId }, inlineField: 'statusId' };
    const submitted: Attempt = { session, variables: { taskId: task.id, input: { expectedRevision: task.revision, statusId } }, error: null };
    busy.current = true; current.current = submitted; setAttempt(submitted); setReviewTaskId(null);
    commands.editSessions.current.set(task.id, session);
    commands.update.mutate(submitted.variables, {
      onSuccess: task => saved(submitted, task),
      onError: error => { if (current.current?.session === session) { const failed = { ...submitted, error }; current.current = failed; setAttempt(failed); } },
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
  const retry = () => {
    const submitted = current.current;
    if (!alive.current || !submitted || !latest.current.writable || busy.current || latestCommands.current.update.pendingCommand || latestCommands.current.update.uncertain?.variables !== submitted.variables) return;
    busy.current = true;
    latestCommands.current.update.retryUncertain({ onSuccess: task => saved(submitted, task), onError: error => { if (current.current?.session === submitted.session) { const failed = { ...submitted, error }; current.current = failed; setAttempt(failed); } }, onSettled: () => { busy.current = false; } });
  };
  const acknowledgeReview = (taskId: string) => setReviewTaskId(before => before === taskId ? null : before);
  return { acknowledgeReview, choose, attempt: confirmed ? null : attempt, pending, uncertain, canRetry, retry, reviewTaskId };
}
export type TaskCompletionController = ReturnType<typeof useTaskCompletion>;
