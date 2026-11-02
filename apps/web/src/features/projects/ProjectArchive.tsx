import type { ProjectDto } from '@workloom/contracts';
import { Button } from '@workloom/ui';
import { Archive, ArchiveRestore, LoaderCircle, Trash2 } from 'lucide-react';
import { useState, type ReactElement } from 'react';
import { useTranslation } from '../../i18n';
import { DialogShell } from '../../shared/DialogShell';
import { SaveFeedback } from '../../shared/SaveFeedback';
import { usePurgeProjectMutation, useUpdateProjectMutation } from './queries';

/** Covers the dialog while a command runs, so nothing can be typed or clicked until the server answers. */
export function BusyOverlay({ label }: { label: string }) {
  return (
    <div role="status" aria-live="polite" className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-2 rounded-xl bg-surface/90 backdrop-blur-[1px]">
      <LoaderCircle size={28} aria-hidden="true" className="text-accent motion-safe:animate-spin" />
      <p className="text-sm font-medium text-ink">{label}</p>
    </div>
  );
}

/** Archiving asks first; restoring is harmless and happens at once. The revision is the one the page last loaded. */
export function ArchiveProjectButton({ actorId, workspaceId, project, onChanged }: {
  actorId: string; workspaceId: string; project: ProjectDto; onChanged?: ((project: ProjectDto) => void) | undefined;
}) {
  const { t } = useTranslation();
  const mutation = useUpdateProjectMutation(actorId, workspaceId);
  const [open, setOpen] = useState(false);
  const archived = project.archivedAt !== null;
  const send = (next: boolean) => mutation.mutate(
    { projectId: project.id, input: { expectedRevision: project.revision, archived: next } },
    { onSuccess: updated => { setOpen(false); onChanged?.(updated); } },
  );
  if (archived) {
    return (
      <>
        <Button size="sm" variant="ghost" disabled={mutation.isPending} onClick={() => send(false)}>
          <ArchiveRestore size={16} aria-hidden="true" />{t('projects.archive.restoreProject')}
        </Button>
        {mutation.error ? <p role="alert" className="px-2 text-xs text-red-700">{t('projects.archive.restoreFailed')}</p> : null}
      </>
    );
  }
  return (
    <DialogShell
      title={t('projects.archive.archiveTitle')}
      description={t('projects.archive.archiveWarning')}
      trigger={<Button size="sm" variant="ghost"><Archive size={16} aria-hidden="true" />{t('projects.archive.archiveProject')}</Button>}
      open={open}
      onOpenChange={next => { if (!mutation.isPending) { setOpen(next); if (!next) mutation.reset(); } }}
    >
      <div className="relative space-y-3">
        <p className="break-words text-sm font-medium text-ink">{project.name}</p>
        {mutation.error ? <p role="alert" className="text-sm text-red-700">{t('projects.archive.archiveFailed')}</p> : null}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" disabled={mutation.isPending} onClick={() => setOpen(false)}>{t('projects.archive.cancel')}</Button>
          <Button type="button" variant="primary" disabled={mutation.isPending} onClick={() => send(true)}><Archive size={16} aria-hidden="true" />{t('projects.archive.archiveAction')}</Button>
        </div>
        {mutation.isPending ? <BusyOverlay label={t('projects.archive.archiving')} /> : null}
      </div>
    </DialogShell>
  );
}

/** Permanent delete: the exact project name has to be typed back, as the server also requires. */
export function DeleteProjectDialog({ actorId, workspaceId, project, trigger }: {
  actorId: string; workspaceId: string; project: ProjectDto; trigger: ReactElement;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState('');
  const mutation = usePurgeProjectMutation(actorId, workspaceId);
  const busy = mutation.isPending;
  // While the server works the dialog cannot be dismissed, so the answer is never missed.
  const change = (next: boolean) => {
    if (busy) return;
    setOpen(next);
    if (!next) { mutation.reset(); setTyped(''); }
  };
  const matches = typed === project.name;
  return (
    <DialogShell title={t('projects.archive.deleteTitle')} description={t('projects.archive.deleteWarning')} trigger={trigger} open={open} onOpenChange={change}>
      <form className="relative space-y-3" onSubmit={event => {
        event.preventDefault();
        if (matches && !busy) mutation.mutate({ projectId: project.id, input: { confirmName: project.name } }, { onSuccess: () => { setOpen(false); setTyped(''); } });
      }}>
        <p className="break-words text-sm font-medium text-ink">{project.name}</p>
        <label className="block text-sm text-muted">
          {t('projects.archive.deleteConfirm')}
          <input value={typed} onChange={event => setTyped(event.target.value)} disabled={busy} autoComplete="off" spellCheck={false}
            className="mt-1 w-full rounded-lg border border-line bg-surface px-3 py-2 text-sm text-ink outline-none focus-visible:ring-2 focus-visible:ring-accent" />
        </label>
        <SaveFeedback error={mutation.error} uncertainError={mutation.uncertain?.error ?? null} subject="projectSave" />
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" disabled={busy} onClick={() => change(false)}>{t('projects.archive.cancel')}</Button>
          <Button type="submit" variant="secondary" className="border-red-300 text-red-700 hover:bg-red-50" disabled={!matches || busy}><Trash2 size={16} aria-hidden="true" />{t('projects.archive.deleteAction')}</Button>
        </div>
        {busy ? <BusyOverlay label={t('projects.archive.deleting')} /> : null}
      </form>
    </DialogShell>
  );
}
