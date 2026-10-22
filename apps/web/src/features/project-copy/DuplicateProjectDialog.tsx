import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { CopyPlus } from 'lucide-react';
import type { DuplicateProjectResult, ProjectDto } from '@workloom/contracts';
import { Button, TextInput } from '@workloom/ui';
import { useTranslation } from '../../i18n';
import { DialogShell } from '../../shared/DialogShell';
import { SaveFeedback } from '../../shared/SaveFeedback';
import { useIdempotentMutation, type IdempotentVariables } from '../../lib/useIdempotentMutation';
import { invalidateProjectList } from '../projects/queries';
import { WorkspaceLink as Link } from '../workspace/WorkspaceNavigation';
import { duplicateProjectRequest } from './api';
import { hasDateInName, suggestNextProjectName } from './suggestName';

type CopyFlags = { aggregates: boolean; checks: boolean; defaults: boolean; reports: boolean; workCategory: boolean };

export function DuplicateProjectDialog({ actorId, workspaceId, project, canManage }: { actorId: string; workspaceId: string; project: ProjectDto; canManage: boolean }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  if (!canManage) return null;
  return <>
    <Button size="sm" variant="ghost" onClick={() => setOpen(true)}><CopyPlus size={16} aria-hidden="true" />{t('projectCopy.open')}</Button>
    {open ? <CopyForm actorId={actorId} workspaceId={workspaceId} project={project} onClose={() => setOpen(false)} /> : null}
  </>;
}

function CopyForm({ actorId, workspaceId, project, onClose }: { actorId: string; workspaceId: string; project: ProjectDto; onClose: () => void }) {
  const { t } = useTranslation();
  const client = useQueryClient();
  const suggested = suggestNextProjectName(project.name);
  const [name, setName] = useState(suggested === project.name ? `${project.name} (copy)` : suggested);
  const [shift, setShift] = useState(String(project.dateRange || hasDateInName(project.name) ? 7 : 0));
  const [flags, setFlags] = useState<CopyFlags>({ aggregates: true, checks: true, defaults: true, reports: true, workCategory: true });
  const [result, setResult] = useState<DuplicateProjectResult | null>(null);
  const copy = useIdempotentMutation({
    prepare: ({ input }: IdempotentVariables & { input: Parameters<typeof duplicateProjectRequest>[2] }) => duplicateProjectRequest(workspaceId, project.id, input),
    onSuccess: saved => { setResult(saved); void invalidateProjectList(client, actorId, workspaceId); },
  });
  const days = Number(shift);
  const valid = name.trim().length > 0 && Number.isInteger(days) && Math.abs(days) <= 3660;
  const busy = copy.pendingCommand !== null;
  const toggle = (key: keyof CopyFlags) => setFlags(current => ({ ...current, [key]: !current[key] }));
  const labels: [keyof CopyFlags, string][] = [['aggregates', t('projectCopy.aggregates')], ['checks', t('projectCopy.checks')], ['defaults', t('projectCopy.defaults')], ['reports', t('projectCopy.reports')], ['workCategory', t('projectCopy.workCategory')]];

  return <DialogShell open variant="wide" onOpenChange={next => { if (!next && !busy) onClose(); }} title={t('projectCopy.title')} description={t('projectCopy.description')}>
    {result ? <div className="space-y-4">
      <p role="status" className="text-sm text-ink">{t('projectCopy.done', { name: result.name })}</p>
      <ul className="list-disc space-y-1 pl-5 text-sm text-ink-soft">
        <li>{t('projectCopy.copiedStructure', { sections: result.copied.sections, fields: result.copied.fields })}</li>
        {result.copied.checkRules > 0 ? <li>{t('projectCopy.copiedChecks', { count: result.copied.checkRules })}</li> : null}
        {result.copied.reports > 0 ? <li>{t('projectCopy.copiedReports', { count: result.copied.reports })}</li> : null}
        {result.copied.aggregates ? <li>{t('projectCopy.copiedAggregates')}</li> : null}
        {result.copied.defaults ? <li>{t('projectCopy.copiedDefaults')}</li> : null}
      </ul>
      {result.warnings.length > 0 ? <div role="alert" className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-950 [[data-theme=dark]_&]:border-amber-500/40 [[data-theme=dark]_&]:bg-amber-500/10 [[data-theme=dark]_&]:text-amber-100">
        <p className="font-medium">{t('projectCopy.warningsTitle')}</p>
        <ul className="list-disc pl-5">{result.warnings.map(warning => <li key={warning.part}>{warning.message}</li>)}</ul>
      </div> : null}
      <div className="flex flex-wrap justify-end gap-2">
        <Button variant="ghost" onClick={onClose}>{t('projectCopy.close')}</Button>
        <Link className="inline-flex h-9 items-center rounded-md bg-accent px-3 text-sm font-medium text-white hover:bg-accent-strong" to={`/w/${workspaceId}/projects/${result.projectId}`}>{t('projectCopy.openNew')}</Link>
      </div>
    </div> : <form className="space-y-4" onSubmit={event => { event.preventDefault(); if (valid && !busy) copy.mutate({ input: { name: name.trim(), shiftDays: days, copy: flags } }); }}>
      <fieldset disabled={busy} className="space-y-4">
        <label className="grid gap-1 text-xs text-muted">{t('projectCopy.name')}<TextInput required maxLength={160} value={name} onChange={event => setName(event.target.value)} /></label>
        <p className="text-sm text-ink-soft">{t('projectCopy.always')}</p>
        <fieldset className="space-y-2"><legend className="mb-1 text-xs text-muted">{t('projectCopy.alsoCopy')}</legend>
          {labels.map(([key, label]) => <label key={key} className="flex items-center gap-2 text-sm"><input type="checkbox" checked={flags[key]} onChange={() => toggle(key)} />{label}</label>)}
        </fieldset>
        <label className="grid max-w-48 gap-1 text-xs text-muted">{t('projectCopy.shift')}<TextInput inputMode="numeric" value={shift} onChange={event => setShift(event.target.value)} /></label>
        <p className="text-xs text-muted">{t('projectCopy.shiftHelp')}</p>
        <p className="text-xs text-muted">{t('projectCopy.noTasks')}</p>
        <SaveFeedback error={copy.error} uncertainError={copy.uncertain?.error ?? null} subject="fieldValueSave" />
      </fieldset>
      <div className="flex flex-wrap justify-end gap-2">
        <Button type="button" variant="ghost" disabled={busy} onClick={onClose}>{t('projectCopy.cancel')}</Button>
        {copy.uncertain ? <Button type="button" onClick={() => copy.retryUncertain()}>{t('projectCopy.retry')}</Button> : null}
        <Button type="submit" variant="primary" disabled={!valid || busy}>{busy ? t('projectCopy.creating') : t('projectCopy.create')}</Button>
      </div>
    </form>}
  </DialogShell>;
}
