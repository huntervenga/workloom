import type { TaskDto, TaskTimelineItemDto } from '@workloom/contracts';
import { Button, inputClassName } from '@workloom/ui';
import { useQueryClient } from '@tanstack/react-query';
import { Fragment, useEffect, useId, useRef, type FormEvent } from 'react';
import { useTranslation, type TranslationKey } from '../../i18n';
import { ApiError, isAccessDenied } from '../../lib/api';
import { QueryErrorState } from '../../shared/QueryErrorState';
import { SaveFeedback } from '../../shared/SaveFeedback';
import { UserAvatar } from '../../shared/UserAvatar';
import { TIMELINE_PAGE_SIZE } from './api';
import { chronological, describeChange, detailNote, headline, type ActivityItem, type ChangeLine, type Shown } from './presentation';
import { discussionKeys, invalidateTaskTimelines, useTimelineQuery } from './queries';
import { MentionTextarea } from './MentionTextarea';
import type { CommentProblem, TaskCommentsWorkspace } from './useTaskCommentsWorkspace';

const problemKeys = { blank: 'comments.problem.blank', tooLong: 'comments.problem.tooLong', nul: 'comments.problem.nul' } satisfies Record<CommentProblem, TranslationKey>;
const unavailable = (error: unknown) => isAccessDenied(error) || error instanceof ApiError && error.kind === 'unauthenticated';

export interface TaskActivityStreamProps {
  task: TaskDto; controller: TaskCommentsWorkspace; writable: boolean; canRetry: boolean; timezone: string; onOpenTask: (taskId: string) => void;
}

/**
 * One chronological feed of comments and activity with the composer below it. Mount it outside
 * any task edit form: it owns its own comment form, and the draft lives in the page controller.
 */
export function TaskActivityStream({ task, controller, writable, canRetry, timezone, onOpenTask }: TaskActivityStreamProps) {
  const { t, formatDate } = useTranslation();
  const client = useQueryClient();
  const id = useId();
  const timeline = useTimelineQuery(controller.actorId, controller.workspaceId, task.id);
  const key = discussionKeys.timeline(controller.actorId, controller.workspaceId, task.id);
  // Changes that bypass task-list invalidation still surface once the confirmed revision moves.
  const revision = `${task.id.toLowerCase()}:${task.revision}`;
  const seenRevision = useRef(revision);
  const { actorId, workspaceId } = controller;
  useEffect(() => {
    const before = seenRevision.current;
    seenRevision.current = revision;
    const [taskId] = revision.split(':');
    if (before === revision || before.split(':')[0] !== taskId || !taskId) return;
    void invalidateTaskTimelines(client, actorId, workspaceId, [taskId]);
  }, [client, actorId, workspaceId, revision]);

  const { command } = controller;
  const ownError = command.variables?.taskId === task.id ? command.error : null;
  const denial = [timeline.error, ownError].find(unavailable);
  const pending = command.pendingCommand?.variables.taskId === task.id;
  const uncertain = command.uncertain?.variables.taskId === task.id;
  const otherHeld = controller.held !== null && controller.held.variables.taskId !== task.id;
  const body = controller.drafts[task.id]?.body ?? '';
  const problem = controller.problems[task.id];
  const canPost = writable && task.archivedAt === null;

  /** Drops every loaded page of this one timeline and starts again from the newest window. */
  const restart = () => client.resetQueries({ queryKey: key, exact: true });
  const refresh = async () => {
    await restart();
    if (client.getQueryState(key)?.status === 'success' && unavailable(ownError)) command.reset();
  };
  const loadOlder = () => { if (timeline.hasNextPage && !timeline.isFetching) void timeline.fetchNextPage(); };
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (event.target !== event.currentTarget || (!canPost && !(uncertain && canRetry)) || denial || pending || otherHeld) return;
    if (uncertain) command.retryUncertain(); else controller.submit(task.id);
  };

  // A denial hides every cached row: nothing loaded under an earlier grant stays visible.
  if (denial) return <div className="space-y-3"><QueryErrorState error={denial} subject="activity" headingLevel={3} /><Button size="sm" onClick={() => void refresh()} aria-disabled={timeline.isFetching || undefined}>{t('comments.refresh')}</Button></div>;

  const rows = chronological(timeline.data?.pages);
  const time = (value: string) => formatDate(value, { dateStyle: 'medium', timeStyle: 'short', timeZone: timezone });
  const day = (value: string) => formatDate(`${value}T00:00:00Z`, { dateStyle: 'medium', timeZone: 'UTC' });
  const shown = (value: Shown) => 'key' in value ? t(value.key, value.params)
    : 'date' in value ? day(value.date)
    : 'number' in value ? String(value.number)
    : <>{value.text}{value.note ? <span className="text-muted"> ({t(value.note)})</span> : null}</>;
  const list = (values: readonly Shown[]) => values.map((value, index) => <Fragment key={index}>{index ? ', ' : null}{shown(value)}</Fragment>);
  const line = (change: ChangeLine, index: number) => { const open = change.openTaskId; return <li key={index} className="break-words">
    <span className="text-muted">{t(change.label.key, change.label.params)}: </span>
    {change.value ? <span>{list(change.value)}</span> : null}
    {change.from && change.to ? <><span>{list(change.from)}</span><span aria-hidden="true"> → </span><span className="sr-only"> {t('activity.to')} </span><span>{list(change.to)}</span></> : null}
    {change.added?.length ? <span className="block">{t('activity.added')}: {list(change.added)}</span> : null}
    {change.removed?.length ? <span className="block">{t('activity.removed')}: {list(change.removed)}</span> : null}
    {change.omitted ? <span className="block text-muted">{t('activity.omitted', { count: change.omitted })}</span> : null}
    {change.note ? <span className="block text-muted">{t(change.note.key, change.note.params)}</span> : null}
    {open ? <Button size="sm" variant="ghost" onClick={() => onOpenTask(open)}>{t('activity.openTask')}</Button> : null}
  </li>; };
  const activity = (item: ActivityItem) => {
    const name = item.actorDisplayName || t('activity.actorUnknown');
    const note = detailNote(item);
    return <>
      <div className="flex flex-wrap items-baseline gap-x-2 text-xs">
        <UserAvatar name={name} seed={item.actorUserId} avatarUrl={item.actorAvatarUrl ?? null} size="sm" className="self-center" />
        <span className="text-ink">{t(headline(item), { name })}</span>
        <time dateTime={item.occurredAt} className="text-muted">{time(item.occurredAt)}</time>
      </div>
      {item.changes.length ? <ul className="mt-1 space-y-0.5 pl-8 text-xs text-ink">{item.changes.flatMap(describeChange).map(line)}</ul> : null}
      {note ? <p className="mt-1 pl-8 text-xs text-muted">{t(note)}</p> : null}
    </>;
  };
  const entry = (item: TaskTimelineItemDto) => item.type === 'comment'
    ? <li key={item.id} data-task-comment-id={item.comment.id} className="rounded-lg border border-line bg-surface p-2.5">
        <div className="flex flex-wrap items-center gap-x-2 text-xs">
          <UserAvatar name={item.comment.authorDisplayNameSnapshot} seed={item.comment.authorUserId} avatarUrl={item.comment.authorAvatarUrl ?? null} size="sm" />
          <span className="font-medium text-ink">{item.comment.authorDisplayNameSnapshot}</span>
          <time dateTime={item.occurredAt} className="text-muted">{time(item.occurredAt)}</time>
        </div>
        <p className="mt-1.5 whitespace-pre-wrap break-words pl-8 text-sm text-ink">{item.comment.body}</p>
      </li>
    : <li key={item.id} data-task-activity-id={item.id} className="px-1">{activity(item)}</li>;

  return <section aria-label={t('activity.heading')} className="flex min-h-0 flex-col gap-3 text-ink">
    <div className="space-y-2">
      {timeline.hasNextPage ? <div className="flex flex-wrap items-center gap-2 text-xs text-muted">
        <span>{t('activity.window', { count: rows.length, size: TIMELINE_PAGE_SIZE })}</span>
        <Button size="sm" variant="ghost" onClick={loadOlder} aria-disabled={timeline.isFetching || undefined}>{timeline.isFetchingNextPage ? t('activity.loadingOlder') : t('activity.older', { size: TIMELINE_PAGE_SIZE })}</Button>
      </div> : rows.length && !timeline.isError ? <p className="text-xs text-muted">{t('activity.beginning')}</p> : null}
      {timeline.isFetchNextPageError ? <div role="alert" className="space-y-1 text-xs">
        <p>{t('activity.olderFailed')}</p>
        <div className="flex gap-2"><Button size="sm" onClick={loadOlder} aria-disabled={timeline.isFetching || undefined}>{t('activity.olderRetry')}</Button><Button size="sm" variant="ghost" onClick={() => void restart()}>{t('activity.restart')}</Button></div>
      </div> : timeline.isError ? <QueryErrorState error={timeline.error} subject="activity" headingLevel={3} onRetry={() => void (rows.length ? timeline.refetch() : restart())} retrying={timeline.isFetching} /> : null}
      {timeline.isPending ? <p role="status" className="text-sm text-muted">{t('activity.loading')}</p>
        : rows.length === 0 && !timeline.isError ? <p className="text-sm text-muted">{t('activity.empty')}</p> : null}
      <ol aria-label={t('activity.heading')} className="space-y-2">{rows.map(entry)}</ol>
    </div>

    <div className="shrink-0 border-t border-line bg-surface pt-2">
      {controller.postedTaskId === task.id ? <p role="status" className="mb-1 text-xs text-muted">{t('comments.posted')}</p> : null}
      {canPost || pending || uncertain && canRetry ? <form noValidate onSubmit={submit} onKeyDown={event => {
        if (!event.defaultPrevented && !event.nativeEvent.isComposing && event.key === 'Enter' && (event.metaKey || event.ctrlKey) && !event.altKey && !event.shiftKey) { event.preventDefault(); event.currentTarget.requestSubmit(); }
      }} className="space-y-1.5">
        <label htmlFor={`${id}-body`} className="sr-only">{t('comments.body')}</label>
        <MentionTextarea actorId={controller.actorId} workspaceId={controller.workspaceId} id={`${id}-body`} rows={2} maxLength={4000} placeholder={t('comments.placeholder')} className={inputClassName('resize-y text-sm')} value={body} disabled={pending || uncertain} aria-invalid={Boolean(problem) || undefined} aria-describedby={`${id}-hint${problem ? ` ${id}-problem` : ''}`} onValueChange={next => controller.setBody(task.id, next)} />
        {problem ? <p role="alert" id={`${id}-problem`} className="text-xs text-ink">{t(problemKeys[problem])}</p> : null}
        <SaveFeedback subject="commentSave" error={ownError} uncertainError={uncertain ? command.uncertain?.error ?? null : null} />
        {otherHeld ? <div role="status" className="flex flex-wrap items-center gap-2 text-xs text-muted"><p>{t('comments.otherPending')}</p><Button size="sm" onClick={() => { const original = controller.held?.variables.taskId; if (original) onOpenTask(original); }}>{t('comments.recovery.open')}</Button></div> : null}
        <div className="flex items-center justify-between gap-2">
          <p id={`${id}-hint`} className="text-xs text-muted">{t('comments.hint')}</p>
          <Button size="sm" variant="primary" type="submit" aria-disabled={pending || otherHeld || undefined}>{pending ? t('comments.posting') : uncertain ? t('comments.retry') : t('comments.add')}</Button>
        </div>
      </form> : <p className="text-xs text-muted">{t(task.archivedAt !== null ? 'comments.archived' : 'comments.readOnly')}</p>}
    </div>
  </section>;
}
