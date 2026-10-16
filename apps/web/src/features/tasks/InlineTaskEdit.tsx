import type { MembershipDto, TaskDto, TaskStatusDto } from '@workloom/contracts';
import { Button, TextInput, inputClassName } from '@workloom/ui';
import { Expand, X } from 'lucide-react';
import { useEffect, useLayoutEffect, useId, useRef, useState, type FormEvent, type RefObject } from 'react';
import { useTranslation } from '../../i18n';
import { ApiError, isAccessDenied } from '../../lib/api';
import { useUnsavedChangesWarning } from '../../lib/useUnsavedChangesWarning';
import { SaveFeedback } from '../../shared/SaveFeedback';
import { submitTaskFormShortcut } from './TaskDrawer';
import { buildUpdateInput, changedKeys, draftFromTask, TASK_TITLE_MAX, type TaskDraft, type TaskDraftErrors } from './taskDraft';
import { canEditTaskInline, canResumeInlineSession, type TaskInlineField } from './tableEditing';
import { unresolvedTaskCommand, type EditSession, type TaskCommands } from './useTaskCommands';

export interface InlineTaskEditProps {
  /** One claim per explicit open; card/view remounts must not steal focus. */
  focusClaim?: RefObject<boolean>;
  task: TaskDto;
  field: TaskInlineField;
  statuses: readonly TaskStatusDto[];
  members: readonly MembershipDto[];
  commands: TaskCommands;
  writable: boolean;
  onClose: () => void;
  onMoreDetails: () => void;
  onSaved: (task: TaskDto) => void;
}

/** Uses the exact seen task revision; only this cell's field can enter the update. */
export function InlineTaskEdit({ task, field, statuses, members, commands, writable, onClose, onMoreDetails, onSaved, focusClaim }: InlineTaskEditProps) {
  const { t } = useTranslation();
  const shouldFocus = focusClaim?.current !== true;
  useLayoutEffect(() => { if (focusClaim) focusClaim.current = true; }, [focusClaim]);
  const [foreignDraft] = useState(() => {
    const kept = commands.editSessions.current.get(task.id);
    return kept !== undefined && !canResumeInlineSession(kept, field);
  });
  const [session, setSession] = useState<EditSession>(() => {
    const kept = commands.editSessions.current.get(task.id);
    return kept && changedKeys(draftFromTask(kept.base), kept.draft).length > 0 ? kept : { base: task, draft: draftFromTask(task), inlineField: field };
  });
  const [errors, setErrors] = useState<TaskDraftErrors>({});
  const id = useId();
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const { update, editSessions } = commands;
  const confirmed = commands.confirmedSessions.current.get(session);
  useEffect(() => {
    if (!confirmed) return;
    setSession({ base: confirmed, draft: draftFromTask(confirmed), inlineField: field });
    setErrors({});
  }, [confirmed, field]);
  const unresolved = unresolvedTaskCommand(commands);
  const pending = update.pendingCommand?.variables.taskId === task.id;
  const uncertain = update.uncertain?.variables.taskId === task.id;
  const blocked = unresolved !== null && !pending && !uncertain;
  const ownError = update.variables?.taskId === task.id && update.variables.input.expectedRevision === session.base.revision ? update.error : null;
  const denied = isAccessDenied(ownError);
  const needsReview = ownError instanceof ApiError && ownError.kind === 'conflict';
  const editable = writable && canEditTaskInline(task) && !denied;
  const frozen = pending || uncertain || blocked || !editable;
  const dirty = changedKeys(draftFromTask(session.base), session.draft).length > 0;
  useUnsavedChangesWarning(dirty || uncertain);
  useEffect(() => {
    if (foreignDraft || confirmed) return;
    if (dirty || pending || uncertain) editSessions.current.set(task.id, session);
    else editSessions.current.delete(task.id);
  }, [confirmed, dirty, editSessions, foreignDraft, pending, session, task.id, uncertain]);

  if (foreignDraft) return <div onKeyDown={event => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onClose(); } }} className="space-y-2 py-2 text-xs"><p>{t('tasks.inlineEdit.existingDraft')}</p><Button autoFocus={shouldFocus} size="sm" onClick={onMoreDetails}>{t('tasks.quickAdd.resumeDraft')}</Button><Button size="sm" variant="ghost" onClick={onClose}>{t('tasks.quickAdd.collapse')}</Button></div>;
  if (!editable && !uncertain) return <div onKeyDown={event => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onClose(); } }} className="space-y-2 py-2 text-xs"><p>{t('tasks.inlineEdit.notEditable')}</p><Button autoFocus={shouldFocus} size="sm" onClick={onMoreDetails}>{t('tasks.quickAdd.moreDetails')}</Button><Button size="sm" variant="ghost" onClick={onClose}>{t('tasks.quickAdd.collapse')}</Button></div>;
  const change = (patch: Partial<TaskDraft>) => {
    setSession(before => ({ ...before, draft: { ...before.draft, ...patch } }));
    setErrors({});
  };
  const saved = (confirmed: TaskDto) => {
    if (!commands.confirmSession(session, confirmed)) return;
    onSaved(confirmed);
    if (!mounted.current) return;
    setSession({ base: confirmed, draft: draftFromTask(confirmed), inlineField: field });
    setErrors({});
    onClose();
  };
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (event.target !== event.currentTarget || confirmed || pending || blocked) return;
    if (uncertain) { update.retryUncertain({ onSuccess: saved }); return; }
    if (!editable || needsReview) return;
    // A drawer or another cell's draft must never be submitted through this control.
    if (!canResumeInlineSession(session, field)) return;
    const result = buildUpdateInput(session.base, draftFromTask(session.base), session.draft);
    if (!result.ok) { setErrors(result.errors); return; }
    setErrors({});
    if (result.input === null) { editSessions.current.delete(task.id); onClose(); return; }
    update.mutate({ taskId: task.id, input: result.input }, { onSuccess: saved });
  };
  const currentError = errors.dueDate ?? errors.form ?? errors.title ?? errors.description ?? errors.startDate ?? errors.estimate;
  return <form noValidate aria-label={t('tasks.inlineEdit.form', { title: task.title })} onSubmit={submit} onKeyDown={event => {
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onClose(); return; }
    if (field === 'title' && event.key === 'Enter' && event.target instanceof HTMLInputElement && event.target.closest('form') === event.currentTarget) {
      if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
      event.preventDefault();
      if (!frozen && !needsReview && !event.altKey && !event.shiftKey) event.currentTarget.requestSubmit();
      return;
    }
    submitTaskFormShortcut(event, !frozen && !needsReview);
  }} className="space-y-1.5 py-1">
    <fieldset disabled={frozen}>
      <legend className="sr-only">{t('tasks.inlineEdit.fields')}</legend>
      {field === 'title' ? <TextInput autoFocus={shouldFocus} aria-label={t('tasks.taskFields.taskName')} aria-invalid={Boolean(currentError) || undefined} aria-describedby={currentError ? `${id}-error` : undefined} type="text" maxLength={TASK_TITLE_MAX} autoComplete="off" className="px-2 text-xs" value={session.draft.title} onChange={event => change({ title: event.target.value })} /> : field === 'statusId' ? <select autoFocus={shouldFocus} aria-label={t('tasks.taskFields.status')} className={inputClassName('px-2 text-xs')} value={session.draft.statusId} onChange={event => change({ statusId: event.target.value })}>
        {!statuses.some(status => status.id === session.draft.statusId) ? <option value={session.draft.statusId}>{t('tasks.taskFields.statusUnavailable')}</option> : null}
        {[...statuses].sort((a, b) => a.position - b.position).map(status => <option key={status.id} value={status.id}>{status.name}</option>)}
      </select> : field === 'responsibleMembershipId' ? <select autoFocus={shouldFocus} aria-label={t('tasks.taskFields.assignee')} className={inputClassName('px-2 text-xs')} value={session.draft.responsibleMembershipId ?? ''} onChange={event => change({ responsibleMembershipId: event.target.value || null })}>
        <option value="">{t('tasks.taskFields.unassigned')}</option>
        {session.draft.responsibleMembershipId && !members.some(member => member.id === session.draft.responsibleMembershipId) ? <option value={session.draft.responsibleMembershipId}>{t('tasks.taskFields.memberUnavailable')}</option> : null}
        {members.map(member => <option key={member.id} value={member.id}>{member.displayName}</option>)}
      </select> : <TextInput autoFocus={shouldFocus} aria-label={t('tasks.taskFields.dueDate')} aria-invalid={Boolean(currentError) || undefined} aria-describedby={currentError ? `${id}-error` : undefined} type="date" min="0001-01-01" max="9999-12-31" className="px-1 text-xs" value={session.draft.dueDate} onChange={event => change({ dueDate: event.target.value })} />}
    </fieldset>
    {currentError ? <p role="alert" id={`${id}-error`} className="text-xs text-red-700">{t(currentError.key, currentError.params)}</p> : null}
    {blocked ? <p role="status" className="text-xs text-amber-800">{t('tasks.quickAdd.otherCommand')}</p> : null}
    <SaveFeedback subject="taskSave" error={ownError} uncertainError={uncertain ? update.uncertain?.error ?? null : null} />
    <div className="flex items-center gap-1">
      <Button size="sm" className="px-2" variant="primary" type="submit" aria-disabled={pending || blocked || !writable || needsReview || undefined}>{pending ? t('tasks.inlineEdit.saving') : uncertain ? t('tasks.inlineEdit.retry') : t('tasks.inlineEdit.save')}</Button>
      <button type="button" className="inline-flex size-6 shrink-0 items-center justify-center rounded text-muted hover:bg-canvas" title={t('tasks.quickAdd.moreDetails')} aria-label={t('tasks.quickAdd.moreDetails')} disabled={pending || uncertain || blocked} onClick={() => { editSessions.current.set(task.id, session); onMoreDetails(); }}><Expand size={14} aria-hidden="true" /></button>
      <button type="button" className="inline-flex size-6 shrink-0 items-center justify-center rounded text-muted hover:bg-canvas" title={t('tasks.quickAdd.collapse')} aria-label={t('tasks.quickAdd.collapse')} onClick={onClose}><X size={14} aria-hidden="true" /></button>
    </div>
  </form>;
}
