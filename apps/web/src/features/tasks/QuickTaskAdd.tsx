import type { MembershipDto, TaskDto, TaskStatusDto } from '@workloom/contracts';
import { Button, TextInput, inputClassName } from '@workloom/ui';
import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { useTranslation } from '../../i18n';
import { useUnsavedChangesWarning } from '../../lib/useUnsavedChangesWarning';
import { SaveFeedback } from '../../shared/SaveFeedback';
import { submitTaskFormShortcut } from './TaskDrawer';
import { buildCreateInput, changedKeys, emptyDraft, TASK_TITLE_MAX, type TaskDraft, type TaskDraftErrors } from './taskDraft';
import { canResumeQuickSession, defaultTaskStatusId, freshQuickSession } from './tableEditing';
import { unresolvedTaskCommand, type CreateSession, type TaskCommands } from './useTaskCommands';

export interface QuickTaskAddProps {
  projectId: string;
  sectionId: string | null;
  sectionName: string;
  statuses: readonly TaskStatusDto[];
  members: readonly MembershipDto[];
  commands: TaskCommands;
  writable: boolean;
  onClose: () => void;
  onMoreDetails: () => void;
  onCreated: (task: TaskDto) => void;
}

/** One explicit root-task create. No row is added until the existing command confirms it. */
export function QuickTaskAdd(props: QuickTaskAddProps) {
  const { t } = useTranslation();
  const { projectId, sectionId, sectionName, statuses, members, commands, writable, onClose, onMoreDetails, onCreated } = props;
  const statusId = defaultTaskStatusId(statuses);
  const [foreignDraft] = useState(() => commands.createSession.current !== null && !canResumeQuickSession(commands.createSession.current, sectionId));
  const [session, setSession] = useState<CreateSession | null>(() => commands.createSession.current ?? (statusId ? freshQuickSession(sectionId, statusId) : null));
  const [errors, setErrors] = useState<TaskDraftErrors>({});
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
  const frozen = pending || uncertain || blocked || !writable;
  const dirty = session !== null && changedKeys(emptyDraft(session.draft.statusId, sectionId), session.draft).length > 0;
  useUnsavedChangesWarning(dirty || uncertain);
  useEffect(() => {
    if (!foreignDraft && !confirmed) commands.createSession.current = dirty || pending || uncertain ? session : null;
  }, [commands.createSession, confirmed, dirty, foreignDraft, pending, session, uncertain]);

  if (foreignDraft) return <div onKeyDown={event => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onClose(); } }} className="flex flex-wrap items-center gap-2 py-2 text-sm"><span>{t('tasks.quickAdd.existingDraft')}</span><Button autoFocus size="sm" onClick={onMoreDetails}>{t('tasks.quickAdd.resumeDraft')}</Button><Button size="sm" variant="ghost" onClick={onClose}>{t('tasks.quickAdd.collapse')}</Button></div>;
  if (!session || !statusId) return <p className="py-2 text-sm text-muted">{t('tasks.quickAdd.noStatus')}</p>;
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
    requestAnimationFrame(() => titleRef.current?.focus());
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
  return <form noValidate aria-label={t('tasks.quickAdd.form', { section: sectionName })} onSubmit={submit} onKeyDown={event => {
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onClose(); return; }
    submitTaskFormShortcut(event, !frozen);
  }} className="w-full max-w-[calc(100vw-3rem)] space-y-2 py-2 lg:max-w-none">
    <p className="text-xs font-medium text-muted">{t('tasks.quickAdd.section', { section: sectionName })}</p>
    <fieldset disabled={frozen} className="grid min-w-0 gap-2 sm:grid-cols-[minmax(14rem,1fr)_minmax(9rem,11rem)_9rem]">
      <legend className="sr-only">{t('tasks.quickAdd.fields')}</legend>
      <TextInput ref={titleRef} autoFocus aria-label={t('tasks.taskFields.taskName')} aria-invalid={Boolean(errors.title) || undefined} aria-describedby={errors.title ? `${id}-title` : undefined} placeholder={t('tasks.quickAdd.titlePlaceholder')} autoComplete="off" maxLength={TASK_TITLE_MAX} value={draft.title} onChange={event => change({ title: event.target.value })} />
      <select aria-label={t('tasks.taskFields.assignee')} className={inputClassName()} value={draft.responsibleMembershipId ?? ''} onChange={event => change({ responsibleMembershipId: event.target.value || null })}><option value="">{t('tasks.taskFields.unassigned')}</option>{members.map(member => <option key={member.id} value={member.id}>{member.displayName}</option>)}</select>
      <TextInput aria-label={t('tasks.taskFields.dueDate')} aria-invalid={Boolean(errors.dueDate) || undefined} aria-describedby={errors.dueDate ? `${id}-dueDate` : undefined} type="date" min="0001-01-01" max="9999-12-31" value={draft.dueDate} onChange={event => change({ dueDate: event.target.value })} />
    </fieldset>
    {Object.entries(errors).map(([field, issue]) => <p role="alert" id={`${id}-${field}`} key={field} className="text-xs text-red-700">{t(issue.key, issue.params)}</p>)}
    {blocked ? <p role="status" className="text-xs text-amber-800">{t('tasks.quickAdd.otherCommand')}</p> : null}
    <SaveFeedback subject="taskSave" error={commands.create.error} uncertainError={commands.create.uncertain?.error ?? null} />
    <div className="flex flex-wrap items-center gap-2">
      <Button size="sm" variant="primary" type="submit" aria-disabled={pending || blocked || !writable || undefined}>{pending ? t('tasks.quickAdd.creating') : uncertain ? t('tasks.quickAdd.retry') : t('tasks.quickAdd.add')}</Button>
      <Button size="sm" disabled={pending || uncertain || blocked} onClick={() => { commands.createSession.current = session; onMoreDetails(); }}>{t('tasks.quickAdd.moreDetails')}</Button>
      <Button size="sm" variant="ghost" onClick={onClose}>{t('tasks.quickAdd.collapse')}</Button>
      <span className="text-xs text-muted">{t('tasks.quickAdd.keyboardHint')}</span>
    </div>
  </form>;
}
