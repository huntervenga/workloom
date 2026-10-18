import type { TagDto } from '@workloom/contracts';
import { Button } from '@workloom/ui';
import { useRef, useState } from 'react';
import { useTranslation } from '../../i18n';
import { ApiError } from '../../lib/api';
import { SaveFeedback } from '../../shared/SaveFeedback';
import { TagColorPalette } from './TagColorPalette';
import { tagColor } from './tagColors';
import { useReloadTags, useUpdateTagMutation } from './queries';

/** Keep this owner outside the dialog: closing it must never forget an unknown PATCH. */
export function useTagColorCommand(actorId: string, workspaceId: string) {
  const mutation = useUpdateTagMutation(actorId, workspaceId);
  const reload = useReloadTags(actorId, workspaceId);
  return { ...mutation, reload };
}

type ColorCommand = ReturnType<typeof useTagColorCommand>;
export function TagColorEditor({ tag, command, canEdit, blocked }: {
  tag: TagDto; command: ColorCommand; canEdit: boolean; blocked: boolean;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false), [reloading, setReloading] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const sent = command.pendingCommand?.variables ?? command.uncertain?.variables;
  const own = sent?.tagId === tag.id;
  const held = sent !== undefined;
  const error = command.variables?.tagId === tag.id ? command.error : null;
  const uncertain = command.uncertain?.variables.tagId === tag.id ? command.uncertain : null;
  const pending = own && command.pendingCommand !== null;
  const disabled = !canEdit || blocked || held || reloading;
  // Only a confirmed server reply may supply a newer revision while catalog invalidation finishes.
  const current = command.data?.id === tag.id && command.data.revision > tag.revision ? command.data : tag;
  const pick = (color: string | null) => {
    if (disabled || color === current.color) return;
    trigger.current?.focus({ preventScroll: true });
    command.mutate({ tagId: current.id, input: { expectedRevision: current.revision, color } });
  };
  const retry = () => { if (canEdit && !blocked && !pending && uncertain) { trigger.current?.focus({ preventScroll: true }); command.retryUncertain(); } };
  const reload = async () => {
    if (reloading || command.uncertain !== null || command.pendingCommand !== null) return;
    trigger.current?.focus({ preventScroll: true });
    setReloading(true);
    try { await command.reload(); command.reset(); }
    finally { setReloading(false); }
  };
  return <div className="space-y-2">
    <Button ref={trigger} size="sm" variant="ghost" aria-expanded={open} aria-label={t('tagColors.change', { name: tag.name })}
      aria-disabled={!canEdit || blocked || (held && !own) || undefined}
      onClick={() => { if (canEdit && !blocked && (!held || own)) setOpen(value => !value); }}>
      <span aria-hidden="true" className="size-3 rounded-full" style={{ backgroundColor: tagColor(current) }} />{t('tagColors.palette')}
    </Button>
    {open ? <div className="space-y-2 rounded-lg border border-line bg-canvas p-2">
      <p className="text-xs text-muted">{t('tagColors.help')}</p>
      <TagColorPalette value={current.color} disabled={disabled} onChange={pick} />
      <Button size="sm" aria-disabled={disabled || undefined} onClick={() => pick(null)}>{t('tagColors.automatic')}</Button>
    </div> : null}
    {pending ? <p role="status" className="text-xs text-muted">{t('tagColors.saving')}</p> : null}
    {error ? <SaveFeedback error={uncertain ? null : error} uncertainError={uncertain?.error ?? null} subject="tagSave" /> : null}
    {uncertain ? <Button size="sm" aria-disabled={!canEdit || blocked || pending || undefined} onClick={retry}>{t('tagColors.retry')}</Button> : null}
    {error instanceof ApiError && error.kind === 'conflict' && !uncertain ? <Button size="sm" aria-disabled={reloading || undefined} onClick={() => { void reload().catch(() => undefined); }}>{t('tagColors.reload')}</Button> : null}
  </div>;
}
