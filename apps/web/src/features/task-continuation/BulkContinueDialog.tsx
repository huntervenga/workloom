import { useQueryClient } from '@tanstack/react-query';
import { useRef, useState } from 'react';
import type { TaskDto } from '@workloom/contracts';
import { Button } from '@workloom/ui';
import { useTranslation } from '../../i18n';
import { ApiError, sendMutation } from '../../lib/api';
import { describeError } from '../../lib/errors';
import { DialogShell } from '../../shared/DialogShell';
import { useTaskFieldsQuery } from '../fields/queries';
import { queryKeys } from '../../lib/queryKeys';
import { invalidateTasks } from '../tasks/queries';
import { invalidateProject, useProjectsQuery } from '../projects/queries';
import { continueTaskRequest } from './api';
import { carryableFields } from './carryableFields';

type Outcome = { state: 'done' } | { state: 'failed'; message: string };

/**
 * Carries a whole selection into another project, e.g. the unfinished tasks of last week. Every task goes through the same
 * command as the single "Complete and continue", one after another, each with its own key so a retry never duplicates.
 */
export function BulkContinueDialog({ actorId, workspaceId, tasks, currentProjectId, initialTarget = '', onClose, onFinished }: { actorId: string; workspaceId: string; tasks: readonly TaskDto[]; currentProjectId: string; /** Preselected destination, e.g. the project that was just copied. */ initialTarget?: string; onClose: () => void; onFinished?: () => void }) {
  const { t } = useTranslation();
  const client = useQueryClient();
  const projects = useProjectsQuery(actorId, workspaceId);
  const choices = (projects.data?.projects ?? []).filter(project => project.archivedAt === null && project.id !== currentProjectId);
  const [target, setTarget] = useState(initialTarget);
  const [carried, setCarried] = useState<readonly string[]>([]);
  const [outcomes, setOutcomes] = useState<Record<string, Outcome>>({});
  const [running, setRunning] = useState(false);
  const keys = useRef(new Map<string, { signature: string; key: string }>());
  const sourceFields = useTaskFieldsQuery(actorId, workspaceId, currentProjectId);
  const targetFields = useTaskFieldsQuery(actorId, workspaceId, target);
  const carryable = target ? carryableFields(sourceFields.data ?? [], targetFields.data ?? []) : [];
  const carryFieldIds = carryable.filter(field => carried.includes(field.id)).map(field => field.id);
  const pending = tasks.filter(task => outcomes[task.id]?.state !== 'done');
  const done = tasks.length - pending.length;

  async function run() {
    if (running || !target || pending.length === 0) return;
    setRunning(true);
    try {
      for (const task of pending) {
        const input = { targetProjectId: target, carryFieldIds };
        const signature = JSON.stringify(input);
        const known = keys.current.get(task.id);
        const key = known?.signature === signature ? known.key : crypto.randomUUID();
        keys.current.set(task.id, { signature, key });
        try {
          await sendMutation(continueTaskRequest(workspaceId, task.id, input), { idempotencyKey: key });
          setOutcomes(current => ({ ...current, [task.id]: { state: 'done' } }));
        } catch (error) {
          if (error instanceof ApiError && (error.kind === 'unauthenticated' || error.kind === 'forbidden')) throw error;
          setOutcomes(current => ({ ...current, [task.id]: { state: 'failed', message: describeError(error, 'taskSave').description } }));
        }
      }
    } catch { /* access changed: the tasks left stay pending and nothing else is sent */ }
    finally {
      setRunning(false);
      for (const projectId of new Set([currentProjectId, target])) void invalidateProject(client, actorId, workspaceId, projectId);
      invalidateTasks(client, actorId, workspaceId);
      void client.invalidateQueries({ queryKey: [...queryKeys.workspace(actorId, workspaceId), 'schedule'] });
      void client.invalidateQueries({ queryKey: [...queryKeys.workspace(actorId, workspaceId), 'dependencies'] });
      onFinished?.();
    }
  }

  const targetName = choices.find(project => project.id === target)?.name ?? '';
  return <DialogShell open variant="wide" onOpenChange={next => { if (!next && !running) onClose(); }} title={t('bulkContinue.title', { count: tasks.length })} description={t('bulkContinue.description')}>
    <div className="space-y-4">
      <label className="grid gap-1 text-xs text-muted">{t('taskContinuation.project')}
        <select className="h-9 rounded-md border border-line bg-surface px-2 text-sm text-ink" value={target} disabled={running || done > 0} onChange={event => { setTarget(event.target.value); setCarried([]); }}>
          <option value="">{t('taskContinuation.choose')}</option>
          {choices.map(project => <option key={project.id} value={project.id}>{project.name}</option>)}
        </select>
      </label>
      {carryable.length > 0 ? <fieldset disabled={running} className="grid gap-1 text-sm">
        <legend className="text-xs text-muted">{t('taskContinuation.carryLegend')}</legend>
        {carryable.map(field => <label key={field.id} className="flex items-center gap-2">
          <input type="checkbox" checked={carried.includes(field.id)} onChange={event => setCarried(event.target.checked ? [...carried, field.id] : carried.filter(id => id !== field.id))} />{field.name}
        </label>)}
      </fieldset> : null}
      <ul className="list-disc space-y-1 pl-5 text-xs text-muted"><li>{t('taskContinuation.rule1')}</li><li>{t('taskContinuation.rule2')}</li><li>{t('taskContinuation.rule3')}</li></ul>
      <ul aria-label={t('bulkContinue.list')} className="max-h-56 divide-y divide-line overflow-y-auto rounded-lg border border-line text-sm">
        {tasks.map(task => {
          const outcome = outcomes[task.id];
          return <li key={task.id} className="flex items-baseline justify-between gap-3 px-3 py-1.5">
            <span className="min-w-0 truncate">{task.title}</span>
            <span className={`shrink-0 text-xs ${outcome?.state === 'failed' ? 'text-danger' : outcome?.state === 'done' ? 'text-emerald-700' : 'text-muted'}`}>
              {outcome?.state === 'done' ? t('bulkContinue.done') : outcome?.state === 'failed' ? outcome.message || t('bulkContinue.failed') : t('bulkContinue.waiting')}
            </span>
          </li>;
        })}
      </ul>
      {done > 0 ? <p role="status" className="text-sm">{t('bulkContinue.summary', { done, total: tasks.length })}</p> : null}
      <div className="flex flex-wrap justify-end gap-2">
        <Button variant="ghost" disabled={running} onClick={onClose}>{pending.length === 0 ? t('taskContinuation.close') : t('taskContinuation.cancel')}</Button>
        <Button variant="primary" disabled={!target || running || pending.length === 0} onClick={() => void run()}>
          {running ? t('taskContinuation.working') : done > 0 ? t('bulkContinue.retry', { count: pending.length }) : targetName ? t('bulkContinue.submit', { count: tasks.length, project: targetName }) : t('taskContinuation.submitGeneric')}
        </Button>
      </div>
    </div>
  </DialogShell>;
}
