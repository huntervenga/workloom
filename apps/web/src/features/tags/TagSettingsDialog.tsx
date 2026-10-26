import { createTagInputSchema, type TagDto, type UpdateTagInput } from '@workloom/contracts';
import { Button, TextInput, inputClassName } from '@workloom/ui';
import { useState } from 'react';
import { useTranslation } from '../../i18n';
import { ApiError } from '../../lib/api';
import { useProtectedDraft } from '../../lib/protectedDrafts';
import { DialogShell } from '../../shared/DialogShell';
import { SaveFeedback } from '../../shared/SaveFeedback';
import { TagColorPalette } from '../tasks/TagColorPalette';
import { useReloadTags, useUpdateTagMutation } from '../tasks/queries';

interface Props {
  actorId: string;
  workspaceId: string;
  tag: TagDto | null;
  canEdit: boolean;
  onClose: () => void;
}

export function TagSettingsDialog({ actorId, workspaceId, tag, canEdit, onClose }: Props) {
  const { t } = useTranslation();
  const mutation = useUpdateTagMutation(actorId, workspaceId);
  const reload = useReloadTags(actorId, workspaceId);
  const held = mutation.pendingCommand !== null || mutation.uncertain !== null;
  const close = () => { if (!held) { mutation.reset(); onClose(); } };
  return <DialogShell open={tag !== null} onOpenChange={open => { if (!open) close(); }} title={t('tags.settings')} description={t('tags.archiveHelp')}>
    {tag ? <TagSettingsForm key={tag.id} tag={tag} mutation={mutation} reload={reload} canEdit={canEdit}
      onClose={close} onSaved={() => { mutation.reset(); onClose(); }} /> : null}
  </DialogShell>;
}

function TagSettingsForm({ tag, mutation, reload, canEdit, onClose, onSaved }: {
  tag: TagDto;
  mutation: ReturnType<typeof useUpdateTagMutation>;
  reload: ReturnType<typeof useReloadTags>;
  canEdit: boolean;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { t } = useTranslation();
  const [base, setBase] = useState(tag);
  const [name, setName] = useState(tag.name);
  const [color, setColor] = useState(tag.color);
  const [archived, setArchived] = useState(tag.archivedAt !== null);
  const [reloading, setReloading] = useState(false);
  const [reloadFailed, setReloadFailed] = useState(false);
  const dirty = name.trim() !== base.name || color !== base.color || archived !== (base.archivedAt !== null);
  useProtectedDraft(dirty);
  const held = mutation.pendingCommand !== null || mutation.uncertain !== null;
  const frozen = !canEdit || held || reloading;
  const valid = createTagInputSchema.safeParse({ name, color }).success;
  const loadLatest = async () => {
    if (frozen) return;
    setReloading(true); setReloadFailed(false);
    try {
      const latest = (await reload()).find(value => value.id === tag.id);
      if (!latest) { setReloadFailed(true); return; }
      // Keep only intentional edits; a concurrent rename/color change must not be undone by an archive-only draft.
      if (name.trim() === base.name) setName(latest.name);
      if (color === base.color) setColor(latest.color);
      if (archived === (base.archivedAt !== null)) setArchived(latest.archivedAt !== null);
      setBase(latest); mutation.reset();
    } catch { setReloadFailed(true); }
    finally { setReloading(false); }
  };
  return <form className="space-y-4" onSubmit={event => {
    event.preventDefault();
    if (frozen || !valid || !dirty || mutation.hasOtherProtectedCommands()) return;
    const input: UpdateTagInput = { expectedRevision: base.revision };
    if (name.trim() !== base.name) input.name = name.trim();
    if (color !== base.color) input.color = color;
    if (archived !== (base.archivedAt !== null)) input.archived = archived;
    mutation.mutate({ tagId: base.id, input }, { onSuccess: onSaved });
  }}>
    <label className="block space-y-1 text-sm"><span>{t('tasks.tagDialogs.tagName')}</span>
      <TextInput value={name} maxLength={80} disabled={frozen} onChange={event => setName(event.target.value)} />
    </label>
    <TagColorPalette value={color} disabled={frozen} onChange={setColor} />
    <label className="flex items-center gap-2 text-sm"><span>{t('tasks.tagDialogs.tagColor')}</span>
      <input type="color" value={color ?? '#64748b'} disabled={frozen} onChange={event => setColor(event.target.value)} />
    </label>
    <Button size="sm" disabled={frozen} onClick={() => setColor(null)}>{t('tagColors.automatic')}</Button>
    <label className="block space-y-1 text-sm"><span>{t('tags.status')}</span>
      <select className={inputClassName()} value={archived ? 'archived' : 'active'} disabled={frozen} onChange={event => setArchived(event.target.value === 'archived')}>
        <option value="active">{t('tags.active')}</option><option value="archived">{t('routes.archived')}</option>
      </select>
    </label>
    <SaveFeedback error={mutation.error} uncertainError={mutation.uncertain?.error ?? null} subject="tagSave" />
    {mutation.uncertain ? <Button disabled={!canEdit || mutation.pendingCommand !== null} onClick={() => mutation.retryUncertain({ onSuccess: onSaved })}>{t('tags.retry')}</Button> : null}
    {mutation.error instanceof ApiError && mutation.error.kind === 'conflict' && !held
      ? <Button disabled={frozen} onClick={() => void loadLatest()}>{t('tasks.tagDialogs.loadLatestVersion')}</Button> : null}
    {reloadFailed ? <p role="alert">{t('tasks.tagDialogs.couldNotLoadTheLatestTagTryAgain')}</p> : null}
    <div className="flex gap-2 border-t border-line pt-3">
      <Button variant="primary" type="submit" disabled={frozen || !valid || !dirty}>{t('tasks.tagDialogs.save')}</Button>
      <Button disabled={held} onClick={onClose}>{t('tags.cancel')}</Button>
    </div>
  </form>;
}
