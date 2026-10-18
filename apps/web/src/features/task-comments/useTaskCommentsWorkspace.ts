import type { CreateTaskCommentInput } from '@workloom/contracts';
import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useRef, useState } from 'react';
import { useIdempotentMutation, type IdempotentVariables } from '../../lib/useIdempotentMutation';
import { useUnsavedChangesWarning } from '../../lib/useUnsavedChangesWarning';
import { createCommentRequest } from './api';
import { discussionKeys, invalidateTaskTimelines } from './queries';

export interface CommentDraft { readonly body: string }
interface CommentVariables extends IdempotentVariables { taskId: string; input: CreateTaskCommentInput; session: CommentDraft }
export type CommentProblem = 'blank' | 'tooLong' | 'nul';
export type TaskDetailTab = 'details' | 'discussion';
export function commentProblem(body: string): CommentProblem | null {
  if (!body.trim()) return 'blank';
  if (body.length > 4000) return 'tooLong';
  if (body.includes('\0')) return 'nul';
  return null;
}
/** Page-owned state; a drawer/tab remount cannot replace a sent comment or resurrect it. */
export function useTaskCommentsWorkspace(actorId: string, workspaceId: string) {
  const client = useQueryClient();
  const [drafts, setDrafts] = useState<Readonly<Record<string, CommentDraft>>>({});
  const draftsRef = useRef(drafts);
  const [tabs, setTabs] = useState<Readonly<Record<string, TaskDetailTab>>>({});
  const [problems, setProblems] = useState<Readonly<Record<string, CommentProblem | null>>>({});
  const [postedTaskId, setPostedTaskId] = useState<string | null>(null);
  const command = useIdempotentMutation({
    prepare: ({ taskId, input }: CommentVariables) => createCommentRequest(workspaceId, taskId, input),
    onSuccess: (_comment, variables) => {
      // Match identity before clearing: independently replaced or other-task drafts survive.
      if (draftsRef.current[variables.taskId] === variables.session) {
        const next = Object.fromEntries(Object.entries(draftsRef.current).filter(([taskId]) => taskId !== variables.taskId));
        draftsRef.current = next; setDrafts(next);
        setProblems(before => ({ ...before, [variables.taskId]: null }));
      }
      setPostedTaskId(variables.taskId);
      void client.invalidateQueries({ queryKey: discussionKeys.comments(actorId, workspaceId, variables.taskId), exact: true });
      void invalidateTaskTimelines(client, actorId, workspaceId, [variables.taskId]);
    },
  });
  const held = command.pendingCommand ?? command.uncertain;
  const setBody = useCallback((taskId: string, body: string) => {
    if (held?.variables.taskId === taskId) return;
    const next = body.length ? { ...draftsRef.current, [taskId]: { body } } : Object.fromEntries(Object.entries(draftsRef.current).filter(([id]) => id !== taskId));
    draftsRef.current = next; setDrafts(next);
    setProblems(before => ({ ...before, [taskId]: null })); setPostedTaskId(null);
  }, [held]);
  const submit = (taskId: string) => {
    if (held) return;
    const session = draftsRef.current[taskId];
    const problem = commentProblem(session?.body ?? '');
    setProblems(before => ({ ...before, [taskId]: problem }));
    if (!session || problem) return;
    setPostedTaskId(null);
    command.mutate({ taskId, input: { body: session.body }, session });
  };
  const setTab = useCallback((taskId: string, tab: TaskDetailTab) => setTabs(before => ({ ...before, [taskId]: tab })), []);
  useUnsavedChangesWarning(Object.values(drafts).some(draft => draft.body.length > 0) || held !== null);
  return { actorId, workspaceId, drafts, problems, tabs, setTab, setBody, submit, command, held, postedTaskId };
}
export type TaskCommentsWorkspace = ReturnType<typeof useTaskCommentsWorkspace>;
