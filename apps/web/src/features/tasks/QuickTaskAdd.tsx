import type { TaskDto, TaskStatusDto } from '@workloom/contracts';
import { Button } from '@workloom/ui';
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

const iconActionClassName = 'inline-flex size-7 shrink-0 items-center justify-center rounded text-muted hover:bg-canvas hover:text-ink disabled:opacity-50';

/**
 * One title-first table row for root tasks. Enter creates through the existing command and keeps
 * the same focused row for the next task; no row is added until the command confirms it.
 */
export function QuickTaskAdd(props: QuickTaskAddProps) {
  const { t } = useTranslation();
  const { projectId, sectionId, sectionName, statuses, commands, writable, onClose, onMoreDetails, onCreated } = props;
  const statusId = defaultTaskStatusId(statuses);
  const [foreignDraft] = useState(() => commands.createSession.current !== null && !canResumeQuickSession(commands.createSession.current, sectionId));
  const [session, setSession] = useState<CreateSession | null>(() => commands.createSession.current ?? (statusId ? freshQuickSession(sectionId, statusId) : null));
  const [errors, setErrors] = useState<TaskDraftErrors>({});
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const attach = useCallback((node: HTMLElement | null) => setAnchor(node), []);
  const titleRef = useRef<HTMLInputElement>(null);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const confirmed = session ? commands.confirmedSessions.current.get(session) : undefined;
  useEffect(() => {
    if (!confirmed || !statusId) return;
    setSession(freshQuickSession(sectionId, statusId));
    setErrors({});
  }, [confirmed, sectionId, statusId]);
  const id = useId();
  const unresolved = unresolvedTaskCommand(commands);
  const blocked = unresolved !== null && unresolved.taskId !== null;
  const pending = commands.create.pendingCommand !== null;
  const uncertain = commands.create.uncertain !== null;
  // The sent title stays visible and focused but read-only, so focus never drops to the page.
  const frozen = pending || uncertain || blocked || !writable;
  const dirty = session !== null && changedKeys(emptyDraft(session.draft.statusId, sectionId), session.draft).length > 0;
  useUnsavedChangesWarning(dirty || uncertain);
  useEffect(() => {
    if (!foreignDraft && !confirmed) commands.createSession.current = dirty || pending || uncertain ? session : null;
  }, [commands.createSession, confirmed, dirty, foreignDraft, pending, session, uncertain]);
  const issues = Object.entries(errors);
  const hasFeedback = issues.length > 0 || blocked || commands.create.error !== null || uncertain;
  // Leaving an untouched row closes it, like an unused Asana add row; typed drafts stay put.
  const leave = useRef<() => void>(() => undefined);
  leave.current = () => { if (!dirty && !pending && !uncertain && !hasFeedback) onClose('blur'); };
  const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onClose('cancel'); } };

  if (foreignDraft) return <div ref={attach} onKeyDown={escape} className="flex h-8 min-w-0 flex-1 items-center gap-2 text-sm">
    <span className="min-w-0 truncate text-muted" title={t('tasks.quickAdd.existingDraft')}>{t('tasks.quickAdd.existingDraft')}</span>
    <Button autoFocus size="sm" className="h-7 px-2" onClick={onMoreDetails}>{t('tasks.quickAdd.resumeDraft')}</Button>
    <Button size="sm" className="h-7 px-2" variant="ghost" onClick={() => onClose('cancel')}>{t('tasks.quickAdd.collapse')}</Button>
  </div>;
  if (!session || !statusId) return <p className="flex h-8 min-w-0 items-center truncate text-sm text-muted">{t('tasks.quickAdd.noStatus')}</p>;
  const { draft } = session;
  const change = (patch: Partial<TaskDraft>) => {
    setSession(before => before ? { ...before, draft: { ...before.draft, ...patch } } : before);
    setErrors({});
  };
  const created = (task: TaskDto) => {
    if (!commands.confirmSession(session, task)) return;
    onCreated(task);
    if (!mounted.current) return;
    setSession(freshQuickSession(sectionId, statusId));
    setErrors({});
    // Continue in the same row only if the person is still here; a late answer never takes focus.
    const active = document.activeElement;
    if (active === titleRef.current || active === null || active === document.body) titleRef.current?.focus();
  };
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (event.target !== event.currentTarget || confirmed || pending || blocked || !writable) return;
    if (uncertain) { commands.create.retryUncertain({ onSuccess: created }); return; }
    const result = buildCreateInput(projectId, draft, { parentTaskId: null, workScope: 'detail' });
    if (!result.ok) { setErrors(result.errors); return; }
    setErrors({});
    commands.create.mutate({ input: result.input }, { onSuccess: created });
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
    <Button size="sm" variant="primary" type="submit" className="h-7 px-2" aria-disabled={pending || blocked || !writable || undefined}>{pending ? t('tasks.quickAdd.creating') : uncertain ? t('tasks.quickAdd.retry') : t('tasks.quickAdd.add')}</Button>
    <button type="button" className={iconActionClassName} title={t('tasks.quickAdd.moreDetails')} aria-label={t('tasks.quickAdd.moreDetails')} disabled={pending || uncertain || blocked}
      onClick={() => { commands.createSession.current = dirty || pending || uncertain ? session : null; onMoreDetails(); }}><Expand size={14} aria-hidden="true" /></button>
    <button type="button" className={iconActionClassName} title={t('tasks.quickAdd.collapse')} aria-label={t('tasks.quickAdd.collapse')} onClick={() => onClose('cancel')}><X size={14} aria-hidden="true" /></button>
    {hasFeedback ? <CellPopover anchor={anchor}>
      {issues.map(([field, issue]) => <p role="alert" id={`${id}-${field}`} key={field} className="text-red-700">{t(issue.key, issue.params)}</p>)}
      {blocked ? <p role="status" className="text-amber-800">{t('tasks.quickAdd.otherCommand')}</p> : null}
      <SaveFeedback subject="taskSave" error={commands.create.error} uncertainError={commands.create.uncertain?.error ?? null} />
    </CellPopover> : null}
  </form>;
}
