import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { ClipboardCopy } from 'lucide-react';
import type { ApplyProjectSettingsResult, ProjectDto } from '@workloom/contracts';
import { Button } from '@workloom/ui';
import { useTranslation } from '../../i18n';
import { DialogShell } from '../../shared/DialogShell';
import { SaveFeedback } from '../../shared/SaveFeedback';
import { useIdempotentMutation, type IdempotentVariables } from '../../lib/useIdempotentMutation';
import { invalidateProject, useProjectsQuery } from '../projects/queries';
import { applyProjectSettingsRequest } from './api';

/** Puts this project's sums, planning checks and new-task defaults onto the other projects chosen here. */
export function ApplySettingsDialog({ actorId, workspaceId, project, canManage }: { actorId: string; workspaceId: string; project: ProjectDto; canManage: boolean }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  if (!canManage) return null;
  return <>
    <Button size="sm" variant="ghost" onClick={() => setOpen(true)}><ClipboardCopy size={16} aria-hidden="true" />{t('projectCopy.applyOpen')}</Button>
    {open ? <ApplyForm actorId={actorId} workspaceId={workspaceId} project={project} onClose={() => setOpen(false)} /> : null}
  </>;
}

function ApplyForm({ actorId, workspaceId, project, onClose }: { actorId: string; workspaceId: string; project: ProjectDto; onClose: () => void }) {
  const { t } = useTranslation();
  const client = useQueryClient();
  const projects = useProjectsQuery(actorId, workspaceId);
  const others = (projects.data?.projects ?? []).filter(other => other.id !== project.id && other.archivedAt === null);
  const [picked, setPicked] = useState<ReadonlySet<string>>(new Set());
  const [replace, setReplace] = useState(false);
  const [result, setResult] = useState<ApplyProjectSettingsResult | null>(null);
  const run = useIdempotentMutation({
    prepare: ({ input }: IdempotentVariables & { input: Parameters<typeof applyProjectSettingsRequest>[2] }) => applyProjectSettingsRequest(workspaceId, project.id, input),
    onSuccess: saved => { setResult(saved); for (const item of saved.results) void invalidateProject(client, actorId, workspaceId, item.projectId); },
  });
  const busy = run.pendingCommand !== null;
  const holding = busy || run.uncertain !== null;
  const count = picked.size;
  const toggle = (id: string) => setPicked(current => { const next = new Set(current); if (!next.delete(id)) next.add(id); return next; });
  const nameOf = (id: string) => others.find(other => other.id === id)?.name ?? id;

  return <DialogShell open variant="wide" onOpenChange={next => { if (!next && !holding) onClose(); }} title={t('projectCopy.applyTitle')} description={t('projectCopy.applyDescription')}>
    {result ? <div className="space-y-4">
      <p role="status" className="text-sm text-ink">{t('projectCopy.applyDone', { count: result.results.filter(item => item.applied.aggregates || item.applied.checkRules > 0 || item.applied.defaults).length })}</p>
      <ul className="max-h-72 space-y-2 overflow-auto text-sm text-ink-soft">
        {result.results.map(item => {
          const parts = [item.applied.aggregates ? t('projectCopy.applyPartAggregates') : null, item.applied.checkRules > 0 ? t('projectCopy.applyPartChecks', { count: item.applied.checkRules }) : null, item.applied.defaults ? t('projectCopy.applyPartDefaults') : null].filter(part => part !== null);
          return <li key={item.projectId}>
            <p>{parts.length > 0 ? t('projectCopy.applyProjectResult', { name: nameOf(item.projectId), parts: parts.join(', ') }) : t('projectCopy.applyProjectNothing', { name: nameOf(item.projectId) })}</p>
            {item.warnings.length > 0 ? <ul className="list-disc pl-5 text-xs text-muted">{item.warnings.map(warning => <li key={warning.part}>{warning.message}</li>)}</ul> : null}
          </li>;
        })}
      </ul>
      <div className="flex justify-end"><Button variant="ghost" onClick={onClose}>{t('projectCopy.close')}</Button></div>
    </div> : <form className="space-y-4" onSubmit={event => { event.preventDefault(); if (count > 0 && !busy) run.mutate({ input: { targetProjectIds: [...picked], replaceExisting: replace } }); }}>
      <fieldset disabled={busy} className="space-y-3">
        <div className="flex items-center justify-between gap-2"><legend className="text-xs text-muted">{t('projectCopy.applyTargets')}</legend>
          <span className="flex gap-2"><Button type="button" size="sm" variant="ghost" onClick={() => setPicked(new Set(others.map(other => other.id)))}>{t('projectCopy.applySelectAll')}</Button><Button type="button" size="sm" variant="ghost" onClick={() => setPicked(new Set())}>{t('projectCopy.applySelectNone')}</Button></span></div>
        {others.length === 0 ? <p className="text-sm text-muted">{t('projectCopy.applyNoProjects')}</p>
          : <div className="max-h-72 space-y-1 overflow-auto rounded border border-line p-2">{others.map(other => <label key={other.id} className="flex items-center gap-2 text-sm"><input type="checkbox" checked={picked.has(other.id)} onChange={() => toggle(other.id)} />{other.name}</label>)}</div>}
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={replace} onChange={() => setReplace(value => !value)} />{t('projectCopy.applyReplace')}</label>
        <SaveFeedback error={run.error} uncertainError={run.uncertain?.error ?? null} subject="fieldValueSave" />
      </fieldset>
      <div className="flex flex-wrap justify-end gap-2">
        <Button type="button" variant="ghost" disabled={holding} onClick={onClose}>{t('projectCopy.cancel')}</Button>
        {run.uncertain ? <Button type="button" onClick={() => run.retryUncertain()}>{t('projectCopy.retry')}</Button> : null}
        <Button type="submit" variant="primary" disabled={count === 0 || busy}>{busy ? t('projectCopy.applyRunning') : count === 1 ? t('projectCopy.applyRunOne') : t('projectCopy.applyRun', { count })}</Button>
      </div>
    </form>}
  </DialogShell>;
}
