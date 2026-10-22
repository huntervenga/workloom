import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { nextContinuationTitle, type ContinueTaskResult, type TaskDto } from '@workloom/contracts';
import { Button, TextInput } from '@workloom/ui';
import { useTranslation } from '../../i18n';
import { DialogShell } from '../../shared/DialogShell';
import { SaveFeedback } from '../../shared/SaveFeedback';
import { useIdempotentMutation, type IdempotentVariables } from '../../lib/useIdempotentMutation';
import { storeTask } from '../tasks/queries';
import { invalidateProject } from '../projects/queries';
import { useProjectsQuery } from '../projects/queries';
import { useTaskFieldsQuery } from '../fields/queries';
import { carryableFields } from './carryableFields';
import { WorkspaceLink as Link } from '../workspace/WorkspaceNavigation';
import { continueTaskRequest } from './api';

/** Completes a task as it stands and starts "title 2" in another project, blocked by the finished one. */
export function ContinueInProjectDialog({ actorId, workspaceId, task, currentProjectId, onClose }: { actorId: string; workspaceId: string; task: TaskDto; currentProjectId: string; onClose: () => void }) {
  const { t } = useTranslation();
  const client = useQueryClient();
  const projects = useProjectsQuery(actorId, workspaceId);
  const choices = (projects.data?.projects ?? []).filter(project => project.archivedAt === null);
  const [target, setTarget] = useState('');
  const [title, setTitle] = useState(nextContinuationTitle(task.title));
  const [carried, setCarried] = useState<readonly string[]>([]);
  const sourceFields = useTaskFieldsQuery(actorId, workspaceId, currentProjectId);
  const targetFields = useTaskFieldsQuery(actorId, workspaceId, target);
  const carryable = target && target !== currentProjectId ? carryableFields(sourceFields.data ?? [], targetFields.data ?? []) : [];
  const [result, setResult] = useState<ContinueTaskResult | null>(null);
  const run = useIdempotentMutation({
    prepare: ({ input }: IdempotentVariables & { input: { targetProjectId: string; title: string; carryFieldIds: string[] } }) => continueTaskRequest(workspaceId, task.id, input),
    onSuccess: saved => {
      setResult(saved);
      for (const projectId of new Set([currentProjectId, saved.continued.projectId])) void invalidateProject(client, actorId, workspaceId, projectId);
      // Both tasks changed: refresh every task list, My tasks, reports, schedule and dependencies, not just the project records.
      storeTask(client, actorId, workspaceId, saved.closed);
      storeTask(client, actorId, workspaceId, saved.continued);
    },
  });
  // An unknown outcome keeps the dialog: closing would forget the key and a fresh submit could create a second task.
  const busy = run.pendingCommand !== null;
  const holding = busy || run.uncertain !== null;
  const targetName = choices.find(project => project.id === target)?.name ?? '';
  return <DialogShell open variant="wide" onOpenChange={next => { if (!next && !holding) onClose(); }} title={t('taskContinuation.title')} description={t('taskContinuation.description')}>
    {result ? <div className="space-y-4">
      <p role="status" className="text-sm">{t('taskContinuation.done', { title: result.continued.title, project: choices.find(project => project.id === result.continued.projectId)?.name ?? '' })}</p>
      <div className="flex flex-wrap justify-end gap-2">
        <Button variant="ghost" onClick={onClose}>{t('taskContinuation.close')}</Button>
        <Link className="inline-flex h-9 items-center rounded-md bg-accent px-3 text-sm font-medium text-white hover:bg-accent-strong" to={`/w/${workspaceId}/projects/${result.continued.projectId}?task=${result.continued.id}`}>{t('taskContinuation.openNew')}</Link>
      </div>
    </div> : <form className="space-y-4" onSubmit={event => { event.preventDefault(); if (target && title.trim() && !busy) run.mutate({ input: { targetProjectId: target, title: title.trim(), carryFieldIds: carryable.filter(field => carried.includes(field.id)).map(field => field.id) } }); }}>
      <fieldset disabled={busy} className="space-y-4">
        <p className="text-sm text-ink-soft">{t('taskContinuation.explain', { title: task.title })}</p>
        <label className="grid gap-1 text-xs text-muted">{t('taskContinuation.project')}
          <select className="h-9 rounded-md border border-line bg-surface px-2 text-sm text-ink" required value={target} onChange={event => { setTarget(event.target.value); setCarried([]); }}>
            <option value="">{t('taskContinuation.choose')}</option>
            {choices.map(project => <option key={project.id} value={project.id}>{project.name}{project.id === currentProjectId ? ` ${t('taskContinuation.current')}` : ''}</option>)}
          </select>
        </label>
        <label className="grid gap-1 text-xs text-muted">{t('taskContinuation.newTitle')}<TextInput required maxLength={500} value={title} onChange={event => setTitle(event.target.value)} /></label>
        {carryable.length > 0 ? <fieldset className="grid gap-1 text-sm">
          <legend className="text-xs text-muted">{t('taskContinuation.carryLegend')}</legend>
          {carryable.map(field => <label key={field.id} className="flex items-center gap-2">
            <input type="checkbox" checked={carried.includes(field.id)} onChange={event => setCarried(event.target.checked ? [...carried, field.id] : carried.filter(id => id !== field.id))} />{field.name}
          </label>)}
        </fieldset> : null}
        <ul className="list-disc space-y-1 pl-5 text-xs text-muted">
          <li>{t('taskContinuation.rule1')}</li><li>{t('taskContinuation.rule2')}</li><li>{t('taskContinuation.rule3')}</li>
        </ul>
        <SaveFeedback error={run.error} uncertainError={run.uncertain?.error ?? null} subject="fieldValueSave" />
      </fieldset>
      <div className="flex flex-wrap justify-end gap-2">
        <Button type="button" variant="ghost" disabled={holding} onClick={onClose}>{t('taskContinuation.cancel')}</Button>
        {run.uncertain ? <Button type="button" onClick={() => run.retryUncertain()}>{t('taskContinuation.retry')}</Button> : null}
        <Button type="submit" variant="primary" disabled={!target || !title.trim() || busy}>{busy ? t('taskContinuation.working') : targetName ? t('taskContinuation.submit', { project: targetName }) : t('taskContinuation.submitGeneric')}</Button>
      </div>
    </form>}
  </DialogShell>;
}
