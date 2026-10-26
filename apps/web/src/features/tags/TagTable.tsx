import { updateTagInputSchema, type TagDto, type UpdateTagInput } from '@workloom/contracts';
import { Badge, Button, StateCard, TextInput, inputClassName } from '@workloom/ui';
import { ArrowUpRight, LoaderCircle, Tags, X } from 'lucide-react';
import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { useTranslation } from '../../i18n';
import { ApiError } from '../../lib/api';
import { useProtectedDraft } from '../../lib/protectedDrafts';
import { SaveFeedback } from '../../shared/SaveFeedback';
import { TagBadge } from '../tasks/TagBadge';
import { TagColorPalette } from '../tasks/TagColorPalette';
import { CellPopover } from '../tasks/CellPopover';
import { keepFocusOnPopoverPress } from '../tasks/TaskDateInput';
import { tagColor } from '../tasks/tagColors';
import { useReloadTags, useUpdateTagMutation } from '../tasks/queries';
import { WorkspaceLink as Link } from '../workspace/WorkspaceNavigation';

type Field = 'name' | 'color' | 'status';
interface Edit { base: TagDto; field: Field; value: string | null }
const fields: readonly Field[] = ['name', 'color', 'status'];
const cellClassName = 'flex h-9 min-w-0 w-full items-center rounded-md px-2 text-left hover:bg-canvas focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent';
const valueOf = (tag: TagDto, field: Field) => field === 'status' ? (tag.archivedAt === null ? 'active' : 'archived') : tag[field];
const normalized = (edit: Edit) => edit.field === 'status' ? edit.value : edit.value?.trim() ?? null;
const changed = (edit: Edit) => normalized(edit) !== valueOf(edit.base, edit.field);
function inputFor(edit: Edit): UpdateTagInput {
  return { expectedRevision: edit.base.revision, ...(edit.field === 'status' ? { archived: edit.value === 'archived' }
    : edit.field === 'name' ? { name: normalized(edit) ?? '' } : { color: normalized(edit) }) };
}

/** One retained cell/command owner, mounted even when filtering removes its row or reads fail. */
export function TagTable({ actorId, workspaceId, tags, canEdit, ready }: {
  actorId: string; workspaceId: string; tags: readonly TagDto[]; canEdit: boolean; ready: boolean;
}) {
  const { t } = useTranslation();
  const headings = { name: t('tags.name'), color: t('tags.color'), status: t('tags.status') };
  const editLabel = (name: string, field: Field) => ({
    name: t('tags.inline.name', { name }), color: t('tags.inline.color', { name }), status: t('tags.inline.status', { name }),
  })[field];
  const mutation = useUpdateTagMutation(actorId, workspaceId);
  const reload = useReloadTags(actorId, workspaceId);
  const [edit, setEdit] = useState<Edit | null>(null);
  const current = useRef<Edit | null>(null);
  const sending = useRef(false);
  const [reloading, setReloading] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [reviewRequired, setReviewRequired] = useState(false);
  const [confirmed, setConfirmed] = useState<ReadonlyMap<string, TagDto>>(new Map());
  const table = useRef<HTMLTableElement>(null);
  const form = useRef<HTMLFormElement>(null);
  const [anchor, setAnchor] = useState<HTMLFormElement | null>(null);
  const attachForm = useCallback((node: HTMLFormElement | null) => { form.current = node; setAnchor(node); }, []);
  const commitPicker = useRef<(value: string) => void>(() => undefined);
  const attachPicker = useCallback((node: HTMLInputElement | null) => {
    if (!node) return;
    // Native input previews the drag; change commits the finished selection. React's
    // onChange also runs for input, which would save and close the picker mid-drag.
    const commit = () => commitPicker.current(node.value);
    node.addEventListener('change', commit);
    return () => node.removeEventListener('change', commit);
  }, []);
  const panelId = useId();
  const dismiss = useRef<() => void>(() => undefined);
  const editing = edit !== null;
  const focusAfterClose = useRef<{ id: string; field: Field } | null>(null);
  const held = mutation.pendingCommand !== null || mutation.uncertain !== null;
  const frozen = !canEdit || held || reloading;
  useProtectedDraft(edit !== null && changed(edit));

  useEffect(() => {
    if (!editing) return;
    const outside = (event: PointerEvent) => {
      if (event.target instanceof Node && !form.current?.contains(event.target)) dismiss.current();
    };
    document.addEventListener('pointerdown', outside, true);
    return () => document.removeEventListener('pointerdown', outside, true);
  }, [editing]);

  useLayoutEffect(() => {
    const target = focusAfterClose.current;
    if (edit || !target) return;
    focusAfterClose.current = null;
    table.current?.querySelector<HTMLButtonElement>(`[data-tag-cell="${target.id}:${target.field}"]`)?.focus({ preventScroll: true });
  }, [edit]);

  const setSession = (next: Edit | null) => { current.current = next; setEdit(next); };
  const newest = (tag: TagDto) => {
    const ack = confirmed.get(tag.id);
    return ack && ack.revision > tag.revision ? ack : tag;
  };
  const close = (restoreFocus: boolean) => {
    if (sending.current || held || reloading) return;
    if (restoreFocus && current.current) focusAfterClose.current = { id: current.current.base.id, field: current.current.field };
    setSession(null); setNotice(null); setReviewRequired(false); mutation.reset();
  };
  const onSuccess = (saved: TagDto, session: Edit, restoreFocus: boolean) => {
    setConfirmed(before => new Map(before).set(saved.id, saved));
    // A late response must not take focus back from a search/filter the person has moved to.
    if (restoreFocus && (document.activeElement === document.body || form.current?.contains(document.activeElement))) {
      focusAfterClose.current = { id: session.base.id, field: session.field };
    }
    setSession(null); setNotice(null); setReviewRequired(false);
  };
  const save = (session = current.current, restoreFocus = true) => {
    if (!session || sending.current || frozen) return;
    const parsed = updateTagInputSchema.safeParse(inputFor(session));
    if (!parsed.success) { setNotice(t(session.field === 'color' ? 'tasks.tagDialogs.useAColorInRrggbbFormat' : 'tasks.tagDialogs.enterATagName')); return; }
    if (!changed(session)) { close(restoreFocus); return; }
    if (mutation.error instanceof ApiError && mutation.error.kind === 'conflict') return;
    if (mutation.hasOtherProtectedCommands()) { setNotice(t('tags.inline.busy')); return; }
    sending.current = true; setNotice(null);
    mutation.mutate({ tagId: session.base.id, input: parsed.data }, {
      onSuccess: saved => onSuccess(saved, session, restoreFocus),
      onSettled: () => { sending.current = false; },
    });
  };
  const open = (tag: TagDto, field: Field) => {
    if (!canEdit || sending.current || held || reloading) return;
    if (current.current && changed(current.current)) return;
    if (mutation.hasOtherProtectedCommands()) return;
    const base = newest(tag);
    mutation.reset(); setNotice(null); setReviewRequired(false); setSession({ base, field, value: valueOf(base, field) });
  };
  const change = (value: string | null, commit = false) => {
    if (!current.current || frozen || sending.current) return;
    const next = { ...current.current, value };
    setSession(next); setNotice(null);
    if (commit) save(next);
  };
  commitPicker.current = value => change(value, true);
  const retry = () => {
    const session = current.current;
    if (!session || !canEdit || sending.current || reloading || !mutation.uncertain || mutation.hasOtherProtectedCommands()) return;
    sending.current = true;
    mutation.retryUncertain({ onSuccess: saved => onSuccess(saved, session, true), onSettled: () => { sending.current = false; } });
  };
  const loadLatest = async () => {
    const session = current.current;
    if (!session || frozen || sending.current) return;
    setReloading(true); setNotice(null);
    try {
      const latest = (await reload()).find(tag => tag.id === session.base.id);
      if (!latest) { setNotice(t('tags.unavailable')); return; }
      // Only this cell's intentional value survives; unrelated concurrent changes stay intact.
      setSession({ ...session, base: latest }); setReviewRequired(true); mutation.reset();
    } catch { setNotice(t('tasks.tagDialogs.couldNotLoadTheLatestTagTryAgain')); }
    finally { setReloading(false); }
  };
  dismiss.current = () => {
    if (current.current && !mutation.error && !notice && !reviewRequired) save(current.current, false);
  };
  const rows = tags.map(newest);
  // A search, status filter or refresh cannot discard a draft or an unresolved request.
  if (edit && !rows.some(tag => tag.id === edit.base.id)) rows.push(newest(edit.base));
  if (rows.length === 0) return ready ? <StateCard icon={<Tags size={18} />} title={t('tags.empty')} description={t('tags.emptyHelp')} /> : null;
  const conflict = mutation.error instanceof ApiError && mutation.error.kind === 'conflict';
  const hasFeedback = Boolean(notice || mutation.error || reviewRequired);
  const feedback = <>
    {notice ? <p role="alert" className="text-xs text-ink">{notice}</p> : null}
    <SaveFeedback error={mutation.uncertain ? null : mutation.error} uncertainError={mutation.uncertain?.error ?? null} subject="tagSave" />
    {hasFeedback ? <div className="flex flex-wrap gap-1">
      {mutation.uncertain ? <Button size="sm" disabled={!canEdit || sending.current || reloading} onClick={retry}>{t('tags.retry')}</Button>
        : reviewRequired || (mutation.error && !conflict) ? <Button size="sm" disabled={frozen} onClick={() => save()}>{t('tags.inline.reapply')}</Button> : null}
      {conflict && !held ? <Button size="sm" disabled={frozen} onClick={() => void loadLatest()}>{t('tasks.tagDialogs.loadLatestVersion')}</Button> : null}
      {edit?.field !== 'color' ? <Button size="sm" disabled={held || reloading} onClick={() => close(true)}>{t('tags.cancel')}</Button> : null}
    </div> : null}
  </>;
  const editor = edit ? <form ref={attachForm} className="relative flex h-9 min-w-0 w-full items-center" aria-label={editLabel(edit.base.name, edit.field)}
    aria-busy={mutation.pendingCommand !== null || undefined}
    onSubmit={event => { event.preventDefault(); save(); }}
    onMouseDown={keepFocusOnPopoverPress}
    onKeyDown={event => {
      if (event.nativeEvent.isComposing || event.keyCode === 229) {
        if (event.key === 'Enter') event.preventDefault();
        return;
      }
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(true); }
      if (event.key === 'Enter' && event.target instanceof HTMLInputElement && event.target.type === 'text') {
        event.preventDefault(); save();
      }
    }}
    onBlur={event => {
      const owner = event.currentTarget;
      if (event.relatedTarget instanceof Node) {
        if (!owner.contains(event.relatedTarget)) dismiss.current();
        return;
      }
      window.setTimeout(() => {
        if (owner.isConnected && !owner.contains(document.activeElement)) dismiss.current();
      }, 0);
    }}>
    {edit.field === 'name' ? <TextInput className="h-9! px-2! shadow-none!" autoFocus aria-label={t('tasks.tagDialogs.tagName')} value={edit.value ?? ''} maxLength={80}
      disabled={frozen} aria-invalid={notice ? true : undefined} onChange={event => change(event.target.value)} />
      : edit.field === 'status' ? <select autoFocus className={inputClassName('h-9! px-2! shadow-none!')} aria-label={t('tags.status')} disabled={frozen}
        value={edit.value ?? 'active'} onChange={event => change(event.target.value, true)}>
        <option value="active">{t('tags.active')}</option><option value="archived">{t('routes.archived')}</option>
      </select>
      : <button type="button" className={cellClassName} aria-label={editLabel(edit.base.name, edit.field)} aria-haspopup="dialog" aria-expanded="true" aria-controls={panelId}
        aria-disabled={held || reloading || undefined} onClick={() => close(true)}>
        <span aria-hidden="true" className="mr-2 inline-block size-3 shrink-0 rounded-full" style={{ backgroundColor: tagColor(edit.base) }} /><span className="truncate">{edit.base.color ?? t('tagColors.automatic')}</span>
      </button>}
    {mutation.pendingCommand ? <><LoaderCircle size={14} aria-hidden="true" className="pointer-events-none absolute right-2 text-muted motion-safe:animate-spin" /><span role="status" className="sr-only">{t('tags.inline.saving')}</span></> : null}
    {edit.field === 'color' ? <CellPopover anchor={anchor} id={panelId} role="dialog" ariaLabel={editLabel(edit.base.name, 'color')}
      className="w-52! max-h-[calc(100dvh-16px)] overflow-y-auto!">
      <div className="flex items-center justify-between gap-2"><span className="font-medium">{t('tagColors.palette')}</span>
        <button type="button" aria-label={t('tags.cancel')} disabled={held || reloading} className="rounded p-1 text-muted hover:bg-canvas disabled:opacity-50" onClick={() => close(true)}><X size={14} aria-hidden="true" /></button>
      </div>
      <TagColorPalette compact value={edit.value} disabled={frozen} onChange={value => change(value, true)} />
      <div className="flex items-center gap-2">
        <input ref={attachPicker} type="color" aria-label={t('tags.inline.pickColor')} title={t('tags.inline.pickColor')}
          className="h-8 w-9 shrink-0 cursor-pointer rounded-md border border-line bg-surface p-0.5 focus-visible:outline-2 focus-visible:outline-accent disabled:cursor-default disabled:opacity-50"
          value={/^#[0-9a-f]{6}$/i.test(edit.value ?? '') ? edit.value ?? '' : tagColor(edit.base)} disabled={frozen}
          onInput={event => change(event.currentTarget.value)} />
        <TextInput className="h-8! min-w-0 px-2! text-xs!" autoFocus aria-label={t('tags.inline.customColor')} value={edit.value ?? ''} maxLength={7} placeholder={t('tags.inline.colorPlaceholder')}
          disabled={frozen} aria-invalid={notice ? true : undefined} onChange={event => change(event.target.value)} />
      </div>
      <Button size="sm" className="w-full" disabled={frozen} onClick={() => change(null, true)}>{t('tagColors.automatic')}</Button>
      {feedback}
    </CellPopover> : hasFeedback ? <CellPopover anchor={anchor}>{feedback}</CellPopover> : null}
  </form> : null;

  return <div className="overflow-x-auto rounded-xl border border-line bg-surface"><table ref={table} className="w-full min-w-[30rem] table-fixed text-left text-sm">
    <caption className="sr-only">{t('tags.title')}</caption>
    <colgroup><col /><col className="w-44" /><col className="w-36" /></colgroup>
    <thead className="border-b border-line bg-canvas text-muted"><tr>
      {fields.map(field => <th key={field} scope="col" className="px-4 py-3">{headings[field]}</th>)}
    </tr></thead><tbody className="divide-y divide-line">{rows.map(tag => <tr key={tag.id}>
      {fields.map(field => {
        const editing = edit?.base.id === tag.id && edit.field === field;
        const value = field === 'name' ? <TagBadge tag={tag} /> : field === 'color'
          ? <><span aria-hidden="true" className="mr-2 inline-block size-3 shrink-0 rounded-full" style={{ backgroundColor: tagColor(tag) }} /><span className="truncate">{tag.color ?? t('tagColors.automatic')}</span></>
          : <Badge tone="muted">{tag.archivedAt === null ? t('tags.active') : t('routes.archived')}</Badge>;
        return <td key={field} className="px-2 py-2 align-top">
          <div className="flex min-w-0 items-start gap-1">
            {editing ? editor : canEdit ? <button type="button" data-tag-cell={`${tag.id}:${field}`} className={cellClassName}
              aria-label={editLabel(tag.name, field)} aria-haspopup={field === 'color' ? 'dialog' : undefined} aria-expanded={field === 'color' ? false : undefined}
              aria-disabled={held || reloading || undefined} onClick={() => open(tag, field)}>{value}</button>
              : field === 'name' ? <Link className={cellClassName} to={`/w/${workspaceId}/tags/${tag.id}`}>{value}</Link> : <div className={cellClassName}>{value}</div>}
            {field === 'name' && canEdit ? <Link to={`/w/${workspaceId}/tags/${tag.id}`} className="flex size-9 shrink-0 items-center justify-center rounded text-muted hover:bg-canvas hover:text-ink focus-visible:ring-2 focus-visible:ring-accent"
              aria-label={t('tags.inline.open', { name: tag.name })} title={t('tags.inline.open', { name: tag.name })}><ArrowUpRight size={16} aria-hidden="true" /></Link> : null}
          </div>
        </td>;
      })}
    </tr>)}</tbody>
  </table></div>;
}
