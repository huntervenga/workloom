import type { TaskDto, TaskStatusDto } from '@workloom/contracts';
import { Button, cn } from '@workloom/ui';
import { Expand, X } from 'lucide-react';
import { useCallback, useEffect, useId, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import { useTranslation } from '../../i18n';
import { useUnsavedChangesWarning } from '../../lib/useUnsavedChangesWarning';
import { SaveFeedback } from '../../shared/SaveFeedback';
import { CellPopover } from './CellPopover';
import { buildCreateInput, changedKeys, emptyDraft, TASK_TITLE_MAX, type TaskDraft, type TaskDraftErrors } from './taskDraft';
import { canResumeQuickSession, defaultTaskStatusId, freshQuickSession } from './tableEditing';
import { unresolvedTaskCommand, type CreateSession, type TaskCommands } from './useTaskCommands';

/** `cancel` (Escape/Collapse) may return focus to the add row; `blur` leaves focus where it went. */
export type QuickAddCloseReason = 'cancel' | 'blur';

export interface QuickTaskAddProps {
  projectId: string;
  sectionId: string | null;
  sectionName: string;
  statuses: readonly TaskStatusDto[];
  commands: TaskCommands;
  writable: boolean;
  onClose: (reason?: QuickAddCloseReason) => void;
  onMoreDetails: () => void;
  onCreated: (task: TaskDto) => void;
}

const iconActionClassName = cn('inline-flex size-7 shrink-0 items-center justify-center text-muted hover:bg-canvas hover:text-ink disabled:opacity-50', 'rounded');

/**
 * One title-first table row for root tasks. Enter creates through the existing command and keeps
 * the same focused row for the next task; no row is added until the command confirms it.
 */
export function QuickTaskAdd(props: QuickTaskAddProps) {
  const { t } = useTranslation();
  const { projectId, sectionId, sectionName, statuses, commands, writable, onClose, onMoreDetails, onCreated } = props;
  const statusId = defaultTaskStatusId(statuses);
  const [foreignDraft] = useState(() => commands.createSession.current !== null && !canResumeQuickSession(commands.createSession.current, sectionId));
  const [session, setSession] = useState<CreateSession | null>(() => (commands.quick.draft && canResumeQuickSession(commands.quick.draft, sectionId) ? commands.quick.draft : null) ?? commands.createSession.current ?? (statusId ? freshQuickSession(sectionId, statusId) : null));
  const [errors, setErrors] = useState<TaskDraftErrors>({});
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const attach = useCallback((node: HTMLElement | null) => setAnchor(node), []);
  const titleRef = useRef<HTMLInputElement>(null);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const id = useId();
  const unresolved = unresolvedTaskCommand(commands);
  const blocked = unresolved !== null && unresolved.taskId !== null;
  // A task save that is merely being sent only delays queued creates; an unknown outcome needs the person.
  const blockedUnknown = unresolved !== null && unresolved.taskId !== null && unresolved.uncertain;
  const pending = commands.create.pendingCommand !== null;
  const uncertain = commands.create.uncertain !== null;
  // Submitted titles live in the page-owned queue; this is always the next unsent input.
  const frozen = !writable;
  const dirty = session !== null && changedKeys(emptyDraft(session.draft.statusId, sectionId), session.draft).length > 0;
  useUnsavedChangesWarning(dirty || uncertain);
  useEffect(() => {
    if (!foreignDraft && session && commands.quick.draft !== session) commands.setQuickDraft(session);
  }, [commands, foreignDraft, session]);
  const issues = Object.entries(errors);
  const hasFeedback = issues.length > 0 || blockedUnknown || commands.create.error !== null || uncertain;
  // Leaving an untouched row closes it, like an unused Asana add row; typed drafts and titles
  // still waiting to be sent stay put.
  const leave = useRef<() => void>(() => undefined);
  leave.current = () => { if (!dirty && !pending && !uncertain && !hasFeedback && commands.quick.queue.length === 0) onClose('blur'); };
  const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onClose('cancel'); } };

  if (foreignDraft) return <div ref={attach} onKeyDown={escape} className="flex h-8 min-w-0 flex-1 items-center gap-2 text-sm">
    <span className="min-w-0 truncate text-muted" title={t('tasks.quickAdd.existingDraft')}>{t('tasks.quickAdd.existingDraft')}</span>
    <Button autoFocus size="sm" className="h-7 px-2" onClick={onMoreDetails}>{t('tasks.quickAdd.resumeDraft')}</Button>
    <Button size="sm" className="h-7 px-2" variant="ghost" onClick={() => onClose('cancel')}>{t('tasks.quickAdd.collapse')}</Button>
  </div>;
  if (!session || !statusId) return <p className="flex h-8 min-w-0 items-center truncate text-sm text-muted">{t('tasks.quickAdd.noStatus')}</p>;
  const { draft } = session;
  const change = (patch: Partial<TaskDraft>) => {
    const next = { ...session, draft: { ...session.draft, ...patch } };
    commands.setQuickDraft(next);
    setSession(next);
    setErrors({});
  };
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (event.target !== event.currentTarget || !writable) return;
    const result = buildCreateInput(projectId, draft, { parentTaskId: null, workScope: 'detail' });
    if (!result.ok) { setErrors(result.errors); return; }
    const next = freshQuickSession(sectionId, statusId);
    // Clear only the submitted input, synchronously, before its ACK. A later confirmation
    // never edits this next buffer or restores focus after the person moves elsewhere.
    commands.enqueueQuickCreate(session, result.input, next, onCreated);
    setSession(next);
    setErrors({});
  };
  const describedBy = [`${id}-hint`, ...issues.map(([field]) => `${id}-${field}`)].join(' ');
  return <form ref={attach} noValidate aria-label={t('tasks.quickAdd.form', { section: sectionName })} aria-busy={pending || undefined} onSubmit={submit}
    onKeyDown={event => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onClose('cancel'); return; }
      if (event.key !== 'Enter' || event.target !== titleRef.current) return;
      if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
      event.preventDefault();
      if (frozen || event.altKey || event.shiftKey) return;
      // Enter on a blank row creates nothing and keeps the row focused for typing.
      if (draft.title.trim() === '') return;
      event.currentTarget.requestSubmit();
    }}
    onBlur={event => {
      const form = event.currentTarget;
      if (event.relatedTarget instanceof Node && form.contains(event.relatedTarget)) return;
      window.setTimeout(() => {
        if (!mounted.current || !form.isConnected || (document.activeElement !== null && form.contains(document.activeElement))) return;
        leave.current();
      }, 0);
    }}
    className="flex h-8 min-w-0 flex-1 items-center gap-1">
    <span aria-hidden="true" className="mr-1 inline-flex size-4 shrink-0 rounded-full border border-dashed border-line-strong" />
    <input ref={titleRef} autoFocus aria-label={t('tasks.taskFields.taskName')} aria-invalid={Boolean(errors.title) || undefined} aria-describedby={describedBy}
      placeholder={t('tasks.quickAdd.titlePlaceholder')} autoComplete="off" maxLength={TASK_TITLE_MAX} readOnly={frozen} aria-disabled={frozen || undefined}
      value={draft.title} onChange={event => change({ title: event.target.value })}
      className="block h-8 w-full min-w-0 flex-1 rounded border border-accent-line bg-surface px-2 text-sm text-ink outline-none ring-2 ring-accent-soft placeholder:text-subtle read-only:bg-canvas read-only:text-muted aria-[invalid=true]:border-red-300" />
    <span id={`${id}-hint`} className="sr-only">{t('tasks.quickAdd.keyboardHintNext')}</span>
    <Button size="sm" variant="primary" type="submit" className="h-7 px-2" aria-disabled={!writable || undefined}>{t('tasks.quickAdd.add')}</Button>
    {pending ? <span role="status" className="sr-only">{t('tasks.quickAdd.creating')}</span> : null}
    {commands.quick.paused ? <Button size="sm" type="button" className="h-7 px-2" onClick={commands.retryQuickCreate}>{t('tasks.quickAdd.retry')}</Button> : null}
    <button type="button" className={iconActionClassName} title={t('tasks.quickAdd.moreDetails')} aria-label={t('tasks.quickAdd.moreDetails')} disabled={pending || uncertain || blocked || commands.quick.queue.length > 0}
      onClick={() => { commands.createSession.current = dirty ? session : null; commands.releaseQuickDraft(); onMoreDetails(); }}><Expand size={14} aria-hidden="true" /></button>
    <button type="button" className={iconActionClassName} title={t('tasks.quickAdd.collapse')} aria-label={t('tasks.quickAdd.collapse')} onClick={() => onClose('cancel')}><X size={14} aria-hidden="true" /></button>
    {hasFeedback ? <CellPopover anchor={anchor}>
      {commands.quick.queue[0] ? <p className="break-words font-medium">{t('tasks.quickAdd.submittedTitle', { title: commands.quick.queue[0].session.draft.title })}</p> : null}
      {commands.quick.paused && !uncertain ? <Button size="sm" variant="ghost" onClick={commands.discardRejectedQuickCreate}>{t('tasks.quickAdd.discardRejected')}</Button> : null}
      {issues.map(([field, issue]) => <p role="alert" id={`${id}-${field}`} key={field} className="text-red-700">{t(issue.key, issue.params)}</p>)}
      {blockedUnknown ? <p role="status" className="text-amber-800">{t('tasks.quickAdd.otherCommand')}</p> : null}
      <SaveFeedback subject="taskSave" error={commands.create.error} uncertainError={commands.create.uncertain?.error ?? null} />
    </CellPopover> : null}
  </form>;
}
