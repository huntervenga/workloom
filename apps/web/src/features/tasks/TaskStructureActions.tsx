import type { TaskDto, TaskStatusDto } from '@workloom/contracts';
import { Button, TextInput } from '@workloom/ui';
import { useState, type FormEvent } from 'react';
import { useTranslation } from '../../i18n';
import { DialogShell } from '../../shared/DialogShell';
import { SaveFeedback } from '../../shared/SaveFeedback';
import { taskLink } from './CopyTaskLink';
import { useTaskListQuery, useTaskQuery } from './queries';
import { useDebouncedValue } from './TaskFilters';
import { TASK_TITLE_MAX } from './taskDraft';
import type { TaskCommands } from './useTaskCommands';

interface Props {
  actorId: string;
  task: TaskDto;
  statuses: readonly TaskStatusDto[];
  commands: TaskCommands;
  disabled: boolean;
  onOpenTask: (id: string) => void;
}

export function TaskStructureActions(props: Props) {
  const { t } = useTranslation();
  const [dialog, setDialog] = useState<'structure' | 'followUp' | null>(null);
  return <div className="flex flex-wrap items-center gap-1 pt-2">
    <Button type="button" variant="ghost" size="sm" disabled={props.disabled} onClick={() => setDialog('structure')}>{t('tasks.structure.change')}</Button>
    <Button type="button" variant="ghost" size="sm" disabled={props.disabled} onClick={() => setDialog('followUp')}>{t('tasks.structure.followUp')}</Button>
    {dialog === 'structure' ? <StructureDialog {...props} close={() => setDialog(null)} /> : null}
    {dialog === 'followUp' ? <FollowUpDialog {...props} close={() => setDialog(null)} /> : null}
  </div>;
}

function StructureDialog({ actorId, task, commands, close, disabled }: Props & { close: () => void }) {
  const { t } = useTranslation();
  const [term, setTerm] = useState('');
  const [picked, setPicked] = useState<string | null>(null);
  const [sent, setSent] = useState(false);
  const q = useDebouncedValue(term.trim(), 180);
  const search = useTaskListQuery(actorId, task.workspaceId, { projectId: task.projectId, search: q },
    { limit: 20, enabled: q.length >= 2 });
  const parent = useTaskQuery(actorId, task.workspaceId, task.parentTaskId ?? '');
  const results = search.isSuccess && term.trim() === q && q.length >= 2 ? search.data.pages.flatMap(page => page.tasks)
    .filter(row => row.id !== task.id && row.id !== task.parentTaskId && row.meetingId === null && row.archivedAt === null) : [];
  const independent = parent.isSuccess && parent.data.workPackageId !== task.workPackageId;
  const update = commands.update;
  const held = sent && (update.pendingCommand !== null || update.uncertain !== null);
  const setParent = (parentTaskId: string | null) => {
    if (held || disabled || update.hasOtherProtectedCommands() ||
        (parentTaskId === null ? !independent : !results.some(item => item.id === parentTaskId))) return;
    setSent(true);
    update.mutate({ taskId: task.id, input: { parentTaskId, expectedRevision: task.revision } }, { onSuccess: close });
  };
  return <DialogShell open title={t('tasks.structure.change')} description={t('tasks.structure.description')}
    onOpenChange={open => { if (!open && !held) close(); }}>
    <div className="space-y-3">
      <label className="grid gap-1 text-sm">{t('tasks.structure.findParent')}
        <TextInput autoFocus value={term} maxLength={200} disabled={held} onChange={event => { setTerm(event.target.value); setPicked(null); }} />
      </label>
      {results.length > 0 ? <ul className="max-h-56 space-y-1 overflow-y-auto">
        {results.map(item => <li key={item.id}><button type="button" className="block w-full rounded px-2 py-1.5 text-left text-sm hover:bg-accent-soft aria-pressed:bg-accent-soft"
          aria-pressed={picked === item.id} disabled={held} onClick={() => setPicked(item.id)}>{item.title}</button></li>)}
      </ul> : q.length >= 2 && !search.isPending && !search.isFetching ? <p className="text-sm text-muted">
        {t(search.isError ? 'quickJump.searchFailed' : 'tasks.structure.noParents')}</p> : null}
      {sent ? <SaveFeedback error={update.error} uncertainError={update.uncertain?.error ?? null} subject="taskSave" /> : null}
      <div className="flex flex-wrap gap-2">
        {sent && update.uncertain ? <Button type="button" disabled={update.pendingCommand !== null} onClick={() => update.retryUncertain({ onSuccess: close })}>{t('common.retry')}</Button> :
          <>
            <Button type="button" disabled={!picked || held || disabled} onClick={() => { if (picked) setParent(picked); }}>{t('tasks.structure.makeSubtask')}</Button>
            {task.parentTaskId !== null ? <Button type="button" variant="secondary" disabled={!independent || held || disabled}
              onClick={() => setParent(null)}>{t('tasks.structure.makeTopLevel')}</Button> : null}
          </>}
      </div>
      {parent.isSuccess && !independent ? <p className="text-xs text-muted">{t('tasks.structure.sharedEstimate')}</p> : null}
    </div>
  </DialogShell>;
}

export function FollowUpDialog({ task, statuses, commands, close, disabled, onOpenTask, comment }: Omit<Props, 'actorId'> & { close: () => void; comment?: string }) {
  const { t } = useTranslation();
  const [title, setTitle] = useState('');
  const [sent, setSent] = useState(false);
  const create = commands.create;
  const held = sent && (create.pendingCommand !== null || create.uncertain !== null);
  const status = statuses.find(item => item.group === 'todo') ?? statuses.find(item => item.group === 'in_progress');
  const label = t(comment === undefined ? 'tasks.structure.followUp' : 'tasks.structure.followUpComment');
  const saved = (created: TaskDto) => { close(); onOpenTask(created.id); };
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!title.trim() || held || disabled || !status || create.hasOtherProtectedCommands()) return;
    setSent(true);
    const source = t('tasks.structure.followUpLink', { url: taskLink(window.location.origin, task.workspaceId, task.projectId, task.id) });
    create.mutate({ input: {
      title: title.trim(), projectId: task.projectId, statusId: status.id, sectionId: task.sectionId,
      description: comment === undefined ? source : `${source}\n\n${comment}`,
    } }, { onSuccess: saved });
  };
  return <DialogShell open title={label} description={t(comment === undefined ? 'tasks.structure.followUpDescription' : 'tasks.structure.followUpCommentDescription', { title: task.title })}
    onOpenChange={open => { if (!open && !held) close(); }}>
    <form className="space-y-3" onSubmit={submit}>
      <label className="grid gap-1 text-sm">{t('tasks.taskFields.taskName')}
        <TextInput autoFocus required value={title} maxLength={TASK_TITLE_MAX} readOnly={held} onChange={event => setTitle(event.target.value)} />
      </label>
      {sent ? <SaveFeedback error={create.error} uncertainError={create.uncertain?.error ?? null} subject="taskSave" /> : null}
      {sent && create.uncertain ? <Button type="button" disabled={create.pendingCommand !== null} onClick={() => create.retryUncertain({ onSuccess: saved })}>{t('common.retry')}</Button> :
        <Button type="submit" disabled={held || disabled || !status || !title.trim()}>{label}</Button>}
    </form>
  </DialogShell>;
}
