import type { TaskActivityDto, TaskDto } from '@workloom/contracts';
import { Button, inputClassName } from '@workloom/ui';
import { useQueryClient } from '@tanstack/react-query';
import { useId, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { useTranslation, type TranslationKey } from '../../i18n';
import { ApiError, isAccessDenied } from '../../lib/api';
import { QueryErrorState } from '../../shared/QueryErrorState';
import { SaveFeedback } from '../../shared/SaveFeedback';
import { UserAvatar } from '../../shared/UserAvatar';
import { discussionKeys, uniqueRows, useActivityQuery, useCommentsQuery } from './queries';
import { MentionTextarea } from './MentionTextarea';
import type { TaskCommentsWorkspace, CommentProblem } from './useTaskCommentsWorkspace';

const activityKeys = {
  created: 'comments.activity.created', updated: 'comments.activity.updated', archived: 'comments.activity.archived',
  restored: 'comments.activity.restored', schedule_updated: 'comments.activity.schedule_updated',
} satisfies Record<TaskActivityDto['kind'], TranslationKey>;
const problemKeys = { blank: 'comments.problem.blank', tooLong: 'comments.problem.tooLong', nul: 'comments.problem.nul' } satisfies Record<CommentProblem, TranslationKey>;
const unavailable = (error: unknown) => isAccessDenied(error) || error instanceof ApiError && error.kind === 'unauthenticated';

interface DiscussionProps {
  task: TaskDto; controller: TaskCommentsWorkspace; writable: boolean; canRetry: boolean; timezone: string; active: boolean; onOpenTask: (taskId: string) => void;
}

/** Two sibling mounted panes: switching to discussion cannot reset or submit task fields. */
export function TaskDiscussionPanels({ task, controller, writable, canRetry, timezone, onOpenTask, children }: Omit<DiscussionProps, 'active'> & { children: ReactNode }) {
  const { t } = useTranslation();
  const id = useId();
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const tab = controller.tabs[task.id] ?? 'details';
  const discussion = tab === 'discussion';
  return <>
    <div role="tablist" aria-label={t('comments.tabs')} className="mt-3 flex shrink-0 gap-2 border-b border-line pb-2">
      {(['details', 'discussion'] as const).map((value, index) => <button key={value} ref={node => { refs.current[index] = node; }} type="button" role="tab" id={`${id}-${value}-tab`} aria-controls={`${id}-${value}-panel`} aria-selected={tab === value} tabIndex={tab === value ? 0 : -1} className={`rounded px-3 py-1.5 text-sm font-medium ${tab === value ? 'bg-accent/10 text-accent' : 'text-muted hover:bg-canvas'}`} onClick={() => controller.setTab(task.id, value)} onKeyDown={event => {
        const next = event.key === 'ArrowRight' || event.key === 'ArrowLeft' ? 1 - index : event.key === 'Home' ? 0 : event.key === 'End' ? 1 : null;
        if (next === null) return;
        event.preventDefault(); controller.setTab(task.id, next === 0 ? 'details' : 'discussion'); refs.current[next]?.focus();
      }}>{value === 'details' ? t('comments.details') : controller.drafts[task.id] ? t('comments.draftTab') : t('comments.discussion')}</button>)}
    </div>
    <div role="tabpanel" id={`${id}-details-panel`} aria-labelledby={`${id}-details-tab`} hidden={discussion} className={discussion ? 'hidden' : 'flex min-h-0 flex-1 flex-col'}>{children}</div>
    <div role="tabpanel" id={`${id}-discussion-panel`} aria-labelledby={`${id}-discussion-tab`} hidden={!discussion} className={discussion ? 'min-h-0 flex-1 overflow-y-auto px-1 pt-3 pb-6' : 'hidden'}>
      <TaskDiscussion task={task} controller={controller} writable={writable} canRetry={canRetry} timezone={timezone} onOpenTask={onOpenTask} active={discussion} />
    </div>
  </>;
}

export function TaskDiscussion({ task, controller, writable, canRetry, timezone, active, onOpenTask }: DiscussionProps) {
  const { t, formatDate } = useTranslation();
  const client = useQueryClient();
  const id = useId();
  const [activityOpen, setActivityOpen] = useState(false);
  const comments = useCommentsQuery(controller.actorId, controller.workspaceId, task.id, active);
  const activity = useActivityQuery(controller.actorId, controller.workspaceId, task.id, active && activityOpen);
  const { command } = controller;
  const ownError = command.variables?.taskId === task.id ? command.error : null;
  const denial = [comments.error, activity.error, ownError].find(unavailable);
  const pending = command.pendingCommand?.variables.taskId === task.id;
  const uncertain = command.uncertain?.variables.taskId === task.id;
  const otherHeld = controller.held !== null && controller.held.variables.taskId !== task.id;
  const body = controller.drafts[task.id]?.body ?? '';
  const problem = controller.problems[task.id];
  const canPost = writable && task.archivedAt === null;
  const refresh = async () => {
    const result = await comments.refetch();
    const events = activityOpen ? await activity.refetch() : null;
    if (result.isSuccess && (!events || events.isSuccess) && unavailable(ownError)) command.reset();
  };
  const restart = () => {
    void client.resetQueries({ queryKey: discussionKeys.comments(controller.actorId, controller.workspaceId, task.id), exact: true });
    if (activityOpen) void client.resetQueries({ queryKey: discussionKeys.activity(controller.actorId, controller.workspaceId, task.id), exact: true });
  };
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (event.target !== event.currentTarget || (!canPost && !(uncertain && canRetry)) || denial || pending || otherHeld) return;
    if (uncertain) command.retryUncertain(); else controller.submit(task.id);
  };
  if (denial) return <div className="space-y-3"><QueryErrorState error={denial} subject="task" headingLevel={3} /><Button size="sm" onClick={() => void refresh()} aria-disabled={comments.isFetching || activity.isFetching || undefined}>{t('comments.refresh')}</Button></div>;
  const rows = uniqueRows(comments.data?.pages);
  const events = uniqueRows(activity.data?.pages);
  const time = (value: string) => formatDate(value, { dateStyle: 'medium', timeStyle: 'short', timeZone: timezone });
  return <section aria-label={t('comments.discussion')} className="space-y-4">
    {canPost || pending || uncertain && canRetry ? <form noValidate onSubmit={submit} onKeyDown={event => {
      if (!event.defaultPrevented && !event.nativeEvent.isComposing && event.key === 'Enter' && (event.metaKey || event.ctrlKey) && !event.altKey && !event.shiftKey) { event.preventDefault(); event.currentTarget.requestSubmit(); }
    }} className="space-y-2">
      <label htmlFor={`${id}-body`} className="block text-sm font-medium">{t('comments.body')}</label>
      <MentionTextarea actorId={controller.actorId} workspaceId={controller.workspaceId} id={`${id}-body`} rows={3} maxLength={4000} placeholder={t('comments.placeholder')} className={inputClassName('resize-y')} value={body} disabled={pending || uncertain} aria-invalid={Boolean(problem) || undefined} aria-describedby={`${id}-hint${problem ? ` ${id}-problem` : ''}`} onValueChange={next => controller.setBody(task.id, next)} />
      <p id={`${id}-hint`} className="text-xs text-muted">{t('comments.hint')}</p>
      {problem ? <p role="alert" id={`${id}-problem`} className="text-sm text-red-700">{t(problemKeys[problem])}</p> : null}
      <SaveFeedback subject="commentSave" error={ownError} uncertainError={uncertain ? command.uncertain?.error ?? null : null} />
      {otherHeld ? <div role="status" className="space-y-2 text-xs text-amber-800"><p>{t('comments.otherPending')}</p><Button size="sm" onClick={() => { const original = controller.held?.variables.taskId; if (original) { controller.setTab(original, 'discussion'); onOpenTask(original); } }}>{t('comments.recovery.open')}</Button></div> : null}
      <Button size="sm" variant="primary" type="submit" aria-disabled={pending || otherHeld || undefined}>{pending ? t('comments.posting') : uncertain ? t('comments.retry') : t('comments.add')}</Button>
    </form> : <p className="text-sm text-muted">{t(task.archivedAt !== null ? 'comments.archived' : 'comments.readOnly')}</p>}
    {controller.postedTaskId === task.id ? <p role="status" className="text-sm text-muted">{t('comments.posted')}</p> : null}
    <div className="flex items-center justify-between gap-2"><h3 className="text-sm font-semibold">{t('comments.heading')}</h3><Button size="sm" variant="ghost" onClick={restart} aria-disabled={comments.isFetching || undefined}>{t('comments.refresh')}</Button></div>
    {comments.isError ? <QueryErrorState error={comments.error} subject="comments" headingLevel={3} onRetry={restart} retrying={comments.isFetching} /> : null}
    {comments.isPending ? <p role="status" className="text-sm text-muted">{t('comments.loading')}</p> : rows.length === 0 && !comments.isError ? <p className="text-sm text-muted">{t('comments.empty')}</p> : null}
    <ol className="space-y-3">{rows.map(comment => <li key={comment.id} data-task-comment-id={comment.id} className="rounded-lg border border-line p-3"><div className="flex flex-wrap items-center gap-2 text-xs"><UserAvatar name={comment.authorDisplayNameSnapshot} seed={comment.authorUserId} avatarUrl={comment.authorAvatarUrl ?? null} size="sm" /><span className="font-medium">{comment.authorDisplayNameSnapshot}</span><time dateTime={comment.createdAt} className="text-muted">{time(comment.createdAt)}</time></div><p className="mt-2 whitespace-pre-wrap break-words text-sm">{comment.body}</p></li>)}</ol>
    {comments.hasNextPage ? <Button size="sm" onClick={() => { if (!comments.isFetchingNextPage) void comments.fetchNextPage(); }} aria-disabled={comments.isFetchingNextPage || undefined}>{comments.isFetchingNextPage ? t('comments.loadingMore') : t('comments.more')}</Button> : null}
    <details className="border-t border-line pt-3" onToggle={event => setActivityOpen(event.currentTarget.open)}>
      <summary className="cursor-pointer text-sm font-semibold">{t('comments.activity.heading')}</summary>
      <div className="mt-3 space-y-3"><p className="text-xs text-muted">{t('comments.activity.currentNames')}</p>
        {activity.isError ? <QueryErrorState error={activity.error} subject="activity" headingLevel={3} onRetry={restart} retrying={activity.isFetching} /> : null}
        {activity.isPending ? <p role="status" className="text-sm text-muted">{t('comments.activity.loading')}</p> : events.length === 0 && !activity.isError ? <p className="text-sm text-muted">{t('comments.activity.empty')}</p> : null}
        <ol className="space-y-2">{events.map(event => <li key={event.id} className="text-sm"><p>{t(activityKeys[event.kind], { name: event.actorDisplayName })}</p><time dateTime={event.occurredAt} className="text-xs text-muted">{time(event.occurredAt)}</time></li>)}</ol>
        {activity.hasNextPage ? <Button size="sm" onClick={() => { if (!activity.isFetchingNextPage) void activity.fetchNextPage(); }} aria-disabled={activity.isFetchingNextPage || undefined}>{t('comments.activity.more')}</Button> : null}
      </div>
    </details>
  </section>;
}
