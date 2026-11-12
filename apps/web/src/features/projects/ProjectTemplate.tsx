import type { ProjectDto } from '@workloom/contracts';
import { Button } from '@workloom/ui';
import { LayoutTemplate } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from '../../i18n';
import { DialogShell } from '../../shared/DialogShell';
import { BusyOverlay } from './ProjectArchive';
import { useUpdateProjectMutation } from './queries';

/**
 * Marks a project as a template (it asks first: the tasks leave personal lists and reports) or turns it back into an
 * ordinary project at once. The revision is the one the page last loaded.
 */
export function ProjectTemplateButton({ actorId, workspaceId, project }: { actorId: string; workspaceId: string; project: ProjectDto }) {
  const { t } = useTranslation();
  const mutation = useUpdateProjectMutation(actorId, workspaceId);
  const [open, setOpen] = useState(false);
  const send = (next: boolean) => mutation.mutate(
    { projectId: project.id, input: { expectedRevision: project.revision, isTemplate: next } },
    { onSuccess: () => setOpen(false) },
  );
  if (project.isTemplate === true) {
    return (
      <>
        <Button size="sm" variant="ghost" disabled={mutation.isPending} onClick={() => send(false)}>
          <LayoutTemplate size={16} aria-hidden="true" />{t('projects.template.unmark')}
        </Button>
        {mutation.error ? <p role="alert" className="px-2 text-xs text-red-700">{t('projects.template.failed')}</p> : null}
      </>
    );
  }
  return (
    <DialogShell
      title={t('projects.template.markTitle')}
      description={t('projects.template.markWarning')}
      trigger={<Button size="sm" variant="ghost"><LayoutTemplate size={16} aria-hidden="true" />{t('projects.template.mark')}</Button>}
      open={open}
      onOpenChange={next => { if (!mutation.isPending) { setOpen(next); if (!next) mutation.reset(); } }}
    >
      <div className="relative space-y-3">
        <p className="break-words text-sm font-medium text-ink">{project.name}</p>
        {mutation.error ? <p role="alert" className="text-sm text-red-700">{t('projects.template.failed')}</p> : null}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" disabled={mutation.isPending} onClick={() => setOpen(false)}>{t('projects.template.cancel')}</Button>
          <Button type="button" variant="primary" disabled={mutation.isPending} onClick={() => send(true)}><LayoutTemplate size={16} aria-hidden="true" />{t('projects.template.markAction')}</Button>
        </div>
        {mutation.isPending ? <BusyOverlay label={t('projects.template.marking')} /> : null}
      </div>
    </DialogShell>
  );
}
