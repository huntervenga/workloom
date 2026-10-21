import { useQueryClient } from '@tanstack/react-query';
import { workspaceSlugSchema, type WorkspaceDto } from '@workloom/contracts';
import { Button } from '@workloom/ui';
import { useEffect, useId, useMemo, useState, useSyncExternalStore } from 'react';
import { useTranslation } from '../../i18n';
import { ApiError } from '../../lib/api';
import { useProtectedDraft } from '../../lib/protectedDrafts';
import { isCurrentCreator } from './workspaceCreationController';
import { WorkspaceSlugController } from './workspaceSlugController';
import { workspaceReference } from './workspaceRouting';

/** A URL label is editable here; membership and every stored task keep their UUID identity. */
export function CompanyAddressCard({ actorId, workspace }: { actorId: string; workspace: WorkspaceDto }) {
  const { t } = useTranslation();
  const client = useQueryClient();
  const controller = useMemo(() => new WorkspaceSlugController(client, actorId, workspace.id), [client, actorId, workspace.id]);
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot);
  useEffect(() => { controller.activate(); return () => controller.dispose(); }, [controller]);
  const [draft, setDraft] = useState<string | null>(null);
  const id = useId();
  const value = draft ?? workspace.slug ?? '';
  const parsed = workspaceSlugSchema.safeParse(value);
  const dirty = draft !== null && value.trim().toLowerCase() !== (workspace.slug ?? '');
  useProtectedDraft(dirty && state.saved?.slug !== value.trim().toLowerCase());
  const pending = state.phase !== 'editing';
  const owner = workspace.role === 'owner';
  const writable = owner && isCurrentCreator(client, actorId) && workspace.slugRevision !== undefined;
  const preview = `${window.location.origin}/app/w/${parsed.success ? parsed.data : value || workspaceReference(workspace)}`;
  const error = state.error instanceof ApiError ? state.error : null;
  const errorKey = state.phase === 'uncertain' ? 'workspace.slug.uncertain' : error?.kind === 'conflict' ? 'workspace.slug.conflict' : error?.kind === 'validation' || error?.kind === 'invalid_input' ? 'workspace.slug.unavailable' : 'workspace.slug.failed';
  return <section className="rounded-xl border border-line bg-surface px-4 py-3.5" aria-labelledby={`${id}-heading`}>
    <h2 id={`${id}-heading`} className="text-sm font-semibold text-ink">{t('workspace.slug.title')}</h2>
    <p className="mt-1 text-xs text-muted">{t('workspace.slug.help')}</p>
    {owner ? <form className="mt-3 space-y-2" onSubmit={event => { event.preventDefault(); if (writable && dirty && parsed.success && workspace.slugRevision !== undefined) void controller.save(parsed.data, workspace.slugRevision); }}>
      <label htmlFor={id} className="sr-only">{t('workspace.slug.label')}</label>
      <div className="flex flex-wrap items-center gap-2">
        <input id={id} value={value} maxLength={63} autoCapitalize="none" autoComplete="off" spellCheck={false} disabled={pending || !writable} placeholder={t('workspace.slug.placeholder')} onChange={event => setDraft(event.target.value)} className="min-w-48 flex-1 rounded-lg border border-line bg-canvas px-3 py-2 text-sm text-ink outline-none focus:border-accent-line focus:ring-2 focus:ring-accent-soft" aria-describedby={`${id}-hint`} />
        <Button type="submit" variant="primary" size="sm" disabled={!writable || pending || !dirty || !parsed.success}>{state.phase === 'pending' ? t('workspace.slug.saving') : t('workspace.slug.save')}</Button>
        {dirty && !pending ? <Button type="button" size="sm" onClick={() => setDraft(null)}>{t('common.cancel')}</Button> : null}
      </div>
      <p id={`${id}-hint`} className="text-xs text-muted">{t('workspace.slug.format')}</p>
      {state.error ? <div role="alert" className="rounded-lg bg-red-50 p-2 text-sm text-red-800"><p>{t(errorKey)}</p>{state.phase === 'uncertain' ? <Button type="button" size="sm" onClick={() => void controller.retry()} disabled={!writable}>{t('workspace.slug.retry')}</Button> : null}</div> : null}
      {state.saved?.slug === value.trim().toLowerCase() && !dirty ? <p role="status" className="text-xs text-accent-ink">{t('workspace.slug.saved')}</p> : null}
    </form> : null}
    <p className="mt-2 break-all text-xs text-muted">{preview}</p>
  </section>;
}
