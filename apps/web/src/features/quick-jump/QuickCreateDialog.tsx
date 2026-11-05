import { createTaskInputSchema } from '@workloom/contracts';
import { Button, TextInput, inputClassName } from '@workloom/ui';
import { useRef, useState, type FormEvent } from 'react';
import { useLocation, useMatch } from 'react-router';
import { useTranslation } from '../../i18n';
import { DialogShell } from '../../shared/DialogShell';
import { SaveFeedback } from '../../shared/SaveFeedback';
import { useUnsavedChangesWarning } from '../../lib/useUnsavedChangesWarning';
import { useProjectsQuery, useSectionsQuery, useStatusesQuery } from '../projects/queries';
import { useTaskDefaults } from '../task-defaults/queries';
import { useCreateTaskMutation, useTaskQuery } from '../tasks/queries';
import { TASK_TITLE_MAX } from '../tasks/taskDraft';
import { useMembershipsQuery } from '../workspace/queries';

export function QuickCreateDialog({ actorId, workspaceId, onClose }: { actorId: string; workspaceId: string; onClose: () => void }) {
  const { t } = useTranslation();
  const currentProject = useMatch('/w/:workspace/projects/:projectId/*')?.params.projectId ?? '';
  const myTasks = useMatch('/w/:workspace/my-tasks') !== null;
  const taskId = new URLSearchParams(useLocation().search).get('task') ?? '';
  const [projectId, setProjectId] = useState(currentProject);
  const [sectionId, setSectionId] = useState<string | null>(null);
  const [self, setSelf] = useState(myTasks);
  const [title, setTitle] = useState('');
  const [created, setCreated] = useState('');
  const titleInput = useRef<HTMLInputElement>(null);
  const projects = useProjectsQuery(actorId, workspaceId);
  const projectList = projects.isSuccess ? projects.data.projects.filter(project => project.archivedAt === null) : [];
  const project = projectList.find(item => item.id === projectId);
  const sections = useSectionsQuery(actorId, workspaceId, project?.id ?? '');
  const statuses = useStatusesQuery(actorId, workspaceId, project?.id ?? '');
  const defaults = useTaskDefaults(actorId, workspaceId, project?.id ?? '', project !== undefined);
  const members = useMembershipsQuery(actorId, workspaceId);
  const detail = useTaskQuery(actorId, workspaceId, taskId);
  const create = useCreateTaskMutation(actorId, workspaceId);
  const held = create.pendingCommand !== null || create.uncertain !== null;
  const person = members.isSuccess ? members.data.find(member => member.userId === actorId && !member.pending) : undefined;
  const status = statuses.isSuccess
    ? statuses.data.find(item => defaults.isSuccess && item.id === defaults.data.config.statusId)
      ?? statuses.data.find(item => item.group === 'todo') ?? statuses.data[0] : undefined;
  const activeSections = sections.isSuccess ? sections.data.filter(item => item.archivedAt === null) : [];
  const suggested = detail.isSuccess && detail.data.projectId === projectId ? detail.data.sectionId : null;
  const section = activeSections.find(item => item.id === (sectionId ?? suggested));
  const ready = project !== undefined && status !== undefined && sections.isSuccess && (!self || person !== undefined);

  useUnsavedChangesWarning(title.trim() !== '' || held);
  const onSaved = (saved: { title: string }) => {
    setCreated(saved.title);
    setTitle('');
    window.requestAnimationFrame(() => titleInput.current?.focus());
  };
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!ready || !status || held || create.hasOtherProtectedCommands()) return;
    const input = createTaskInputSchema.safeParse({
      title: title.trim(), projectId, statusId: status.id,
      ...(sectionId === '' ? { sectionId: null } : section ? { sectionId: section.id } : {}),
      ...(self && person ? { responsibleMembershipId: person.id } : {}),
    });
    if (!input.success) return;
    create.mutate({ input: input.data }, { onSuccess: onSaved });
  };

  return <DialogShell open title={t('quickJump.createTask')} description={t('quickJump.createHint')} onOpenChange={open => { if (!open && !held) onClose(); }}>
    <form className="space-y-3" onSubmit={submit}>
      <label className="grid gap-1 text-sm">
        {t('tasks.taskFields.taskName')}
        <TextInput ref={titleInput} autoFocus required readOnly={held} value={title} maxLength={TASK_TITLE_MAX}
          onChange={event => { setTitle(event.target.value); setCreated(''); }} />
      </label>
      <label className="grid gap-1 text-sm">
        {t('quickJump.project')}
        <select className={inputClassName()} value={project?.id ?? ''} required disabled={held}
          onChange={event => { setProjectId(event.target.value); setSectionId(null); }}>
          <option value="">{t('quickJump.chooseProject')}</option>
          {projectList.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
        </select>
      </label>
      <label className="grid gap-1 text-sm">
        {t('tasks.taskFields.section')}
        <select className={inputClassName()} value={section?.id ?? ''} disabled={held || !sections.isSuccess}
          onChange={event => setSectionId(event.target.value)}>
          <option value="">{t('tasks.taskFields.noSection')}</option>
          {activeSections.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
        </select>
      </label>
      {person ? <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={self} disabled={held} onChange={event => setSelf(event.target.checked)} />{t('quickJump.assignMe')}</label> : null}
      <SaveFeedback error={create.error} uncertainError={create.uncertain?.error ?? null} subject="taskSave" />
      {projects.isError || statuses.isError || sections.isError || (myTasks && members.isError) ? <p role="alert" className="text-sm text-danger">{t('quickJump.createContextError')}</p> : null}
      {created ? <p role="status" className="text-sm text-muted">{t('quickJump.created', { title: created })}</p> : null}
      <div className="flex gap-2">
        {create.uncertain ? <Button type="button" disabled={create.pendingCommand !== null}
          onClick={() => create.retryUncertain({ onSuccess: onSaved })}>{t('common.retry')}</Button>
          : <Button type="submit" disabled={!ready || held || title.trim() === ''}>{t('quickJump.createTask')}</Button>}
      </div>
    </form>
  </DialogShell>;
}
