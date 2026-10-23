import { ListChecks } from 'lucide-react';
import { useState } from 'react';
import { Button } from '@workloom/ui';
import { useTranslation } from '../../i18n';
import { DialogShell } from '../../shared/DialogShell';
import { SaveFeedback } from '../../shared/SaveFeedback';
import { useProjectRules, useSaveProjectRules } from './queries';

/** Optional rules of one project, for people who manage it. Every rule is off until switched on. */
export function ProjectRulesDialog({ actorId, workspaceId, projectId, canManage }: { actorId: string; workspaceId: string; projectId: string; canManage: boolean }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  if (!canManage) return null;
  return <>
    <Button size="sm" variant="ghost" onClick={() => setOpen(true)}><ListChecks size={16} aria-hidden="true" />{t('projectRules.open')}</Button>
    {open ? <RulesEditor actorId={actorId} workspaceId={workspaceId} projectId={projectId} onClose={() => setOpen(false)} /> : null}
  </>;
}

function RulesEditor({ actorId, workspaceId, projectId, onClose }: { actorId: string; workspaceId: string; projectId: string; onClose: () => void }) {
  const { t } = useTranslation();
  const rules = useProjectRules(actorId, workspaceId, projectId);
  // Hosted here, not in the form, so closing never forgets a save whose outcome is unknown.
  const save = useSaveProjectRules(actorId, workspaceId, projectId, onClose);
  const holding = save.pendingCommand !== null || save.uncertain !== null;
  return <DialogShell open onOpenChange={next => { if (!next && !holding) onClose(); }} title={t('projectRules.title')} description={t('projectRules.description')}>
    {rules.isSuccess ? <RulesForm key={rules.data.revision} saved={rules.data} save={save} holding={holding} onClose={onClose} />
      : rules.isError ? <p role="alert" className="text-sm text-danger">{t('projectRules.loadFailed')}</p>
      : <p role="status" className="text-sm text-muted">{t('projectRules.loading')}</p>}
  </DialogShell>;
}

function RulesForm({ saved, save, holding, onClose }: { saved: { revision: number; config: { singleProject: boolean } }; save: ReturnType<typeof useSaveProjectRules>; holding: boolean; onClose: () => void }) {
  const { t } = useTranslation();
  const [singleProject, setSingleProject] = useState(saved.config.singleProject);
  const pending = save.pendingCommand !== null;
  return <form className="space-y-4" onSubmit={event => { event.preventDefault(); if (!pending) save.mutate({ input: { expectedRevision: saved.revision, config: { singleProject } } }); }}>
    <fieldset disabled={pending} className="space-y-2">
      <label className="flex items-start gap-3 text-sm"><input type="checkbox" className="mt-1" checked={singleProject} onChange={event => setSingleProject(event.target.checked)} />
        <span><span className="block font-medium text-ink">{t('projectRules.singleProject')}</span><span className="block text-xs text-muted">{t('projectRules.singleProjectHelp')}</span></span></label>
    </fieldset>
    <SaveFeedback error={save.error} uncertainError={save.uncertain?.error ?? null} subject="fieldValueSave" />
    <div className="flex flex-wrap justify-end gap-2">
      <Button type="button" variant="ghost" disabled={holding} onClick={onClose}>{t('projectRules.cancel')}</Button>
      {save.uncertain ? <Button type="button" onClick={() => save.retryUncertain()}>{t('projectRules.retry')}</Button> : null}
      <Button type="submit" variant="primary" disabled={pending || singleProject === saved.config.singleProject}>{pending ? t('projectRules.saving') : t('projectRules.save')}</Button>
    </div>
  </form>;
}
