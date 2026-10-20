import type { MembershipDto, TaskDto, TaskFieldDefinitionDto, TaskFieldValueDto } from '@workloom/contracts';
import { Button } from '@workloom/ui';
import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { useTranslation } from '../../i18n';
import { useUnsavedChangesWarning } from '../../lib/useUnsavedChangesWarning';
import { CellPopover } from '../tasks/CellPopover';
import { SaveFeedback } from '../../shared/SaveFeedback';
import { FieldCellControl } from '../fields/FieldCellControl';
import { FieldAdvisoryIndicator, fieldAdvisoryStyle, type FieldAdvisory } from '../fields/FieldAdvisory';
import { isSessionDirty, newFieldSession, type FieldEditSession } from '../fields/FieldValueForm';
import type { ObservableFieldValueDraftStore } from '../fields/fieldValueDraftStore';
import { parseFieldDraft, type FieldDraft } from '../fields/valueDraft';
import type { InlineBulkEditPort } from '../tasks/InlineTaskEdit';

/** The same typed field input as details; its one value is atomically applied to a captured selection. */
export function BulkCustomFieldCell({ task, field, value, members, writable, drafts, capture, port, onMoreDetails, advisory }: {
  task: TaskDto; field: TaskFieldDefinitionDto; value: TaskFieldValueDto | null;
  members: readonly MembershipDto[]; writable: boolean; drafts: ObservableFieldValueDraftStore;
  onMoreDetails?: () => void;
  advisory?: FieldAdvisory | null;
  capture: (identity: object, baseField: TaskFieldDefinitionDto, baseValue: TaskFieldValueDto | null) => void; port: (identity: object) => InlineBulkEditPort | undefined;
}) {
  const { t } = useTranslation();
  const sessions = useSyncExternalStore(drafts.subscribe, () => drafts.getTask(task.id));
  const session = sessions[field.id.toLowerCase()];
  const [open, setOpen] = useState(false);
  const [anchor, setAnchor] = useState<HTMLDivElement | null>(null);
  const [parseError, setParseError] = useState<string | null>(null);
  const mounted = useRef(true);
  const sending = useRef(false);
  const restoreFocus = useRef(false);
  const sentSession = useRef<FieldEditSession | null>(null);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const bulk = session ? port(session.identity) : undefined;
  const held = bulk?.pending === true || bulk?.uncertain === true;
  useEffect(() => {
    if (held || !restoreFocus.current) return;
    restoreFocus.current = false;
    const active = document.activeElement;
    if (active === null || active === document.body) anchor?.querySelector<HTMLElement>('input[type=checkbox]:not([disabled]), button:not([disabled])')?.focus({ preventScroll: true });
  }, [held, anchor]);
  useUnsavedChangesWarning((session !== undefined && isSessionDirty(session)) || held);
  const setSession = (next: FieldEditSession) => drafts.set(task.id, { ...drafts.getTask(task.id), [field.id.toLowerCase()]: next });
  const discard = (submitted: FieldEditSession) => {
    const current = drafts.getTask(task.id);
    if (current[field.id.toLowerCase()]?.identity !== submitted.identity || current[field.id.toLowerCase()]?.draft !== submitted.draft) return;
    drafts.set(task.id, Object.fromEntries(Object.entries(current).filter(([key]) => key !== field.id.toLowerCase())));
  };
  const begin = () => {
    if (!writable || field.locked || field.archivedAt !== null) return;
    const current = drafts.getTask(task.id)[field.id.toLowerCase()];
    if (current && (port(current.identity) || isSessionDirty(current) || current.stale || current.serverLocked)) return;
    const next = newFieldSession(field, value);
    capture(next.identity, next.field, next.value); setSession(next);
  };
  const submit = (draft?: FieldDraft): boolean => {
    // Read the retained store at commit time; a discrete picker change may precede React render.
    const current = drafts.getTask(task.id)[field.id.toLowerCase()];
    const currentBulk = current ? port(current.identity) : undefined;
    if (!current || !currentBulk || !writable || field.locked || field.archivedAt !== null || currentBulk.pending || sending.current) return false;
    const submitted = draft === undefined || draft === current.draft ? current : { ...current, draft };
    const callbacks = { onConfirmed: () => discard(submitted), onSuccess: () => { if (mounted.current) setOpen(false); }, onSettled: () => { sending.current = false; } };
    if (currentBulk.uncertain) { sending.current = true; currentBulk.retry(callbacks); return true; }
    const parsed = parseFieldDraft(submitted.field, submitted.draft);
    if (!parsed.ok) { setParseError(parsed.message); setOpen(true); return false; }
    setParseError(null);
    setSession(submitted);
    sending.current = true;
    restoreFocus.current = true;
    sentSession.current = submitted;
    const result = currentBulk.submit({ customField: { fieldId: submitted.field.id, expectedDefinitionRevision: submitted.field.revision, value: parsed.value } }, callbacks);
    if (result !== 'sent') { sending.current = false; sentSession.current = null; }
    if (result === 'refused') { setOpen(true); return false; }
    if (result === 'unchanged') { discard(submitted); setOpen(false); }
    return true;
  };
  const close = (onlyClean = false) => {
    // Escape cancels only an unsent buffer. An original sent/unknown batch retains its payload.
    const current = drafts.getTask(task.id)[field.id.toLowerCase()];
    if (current && (!onlyClean || !isSessionDirty(current)) && !port(current.identity)?.pending && !port(current.identity)?.uncertain && !sending.current && sentSession.current?.identity !== current.identity) discard(current);
    setOpen(false);
  };
  const problem = parseError !== null || bulk?.notice || bulk?.error;
  return <div ref={setAnchor} data-inline-field-cell={`${task.id}:${field.id}`} style={fieldAdvisoryStyle(advisory)} className="relative flex h-8 min-w-0 flex-1 items-center gap-1" onClick={event => event.stopPropagation()}>
    {session && !bulk && (isSessionDirty(session) || session.stale || session.serverLocked) ? <button type="button" className="h-8 min-w-0 flex-1 truncate px-1.5 text-left" onClick={onMoreDetails} aria-label={t('inlineFields.draftLabel', { field: field.name, title: task.title })}>{t('inlineFields.draft')}</button> : <FieldCellControl field={session?.field ?? field} value={value?.value ?? null} members={members}
      label={t('inlineFields.edit', { field: field.name, title: task.title })}
      disabled={!writable || field.locked || field.archivedAt !== null || held}
      draft={session?.draft} error={parseError} onBegin={begin}
      onChange={draft => {
        begin();
        const current = drafts.getTask(task.id)[field.id.toLowerCase()];
        if (current && port(current.identity) && !held && !sending.current) { setSession({ ...current, draft }); setParseError(null); }
      }} onCommit={draft => { begin(); return submit(draft); }} onCancel={close} />}
    <FieldAdvisoryIndicator advisory={advisory} />
    {bulk ? <span className="sr-only">{t('bulkInline.appliesTo', { count: bulk.count })}</span> : null}
    {problem && !open ? <button type="button" className="size-6 shrink-0 text-amber-700" aria-label={t('inlineFields.showProblem', { field: field.name })} onClick={() => setOpen(true)}>!</button> : null}
    {problem && open ? <CellPopover anchor={anchor}>
      {parseError ? <p role="alert" className="text-sm text-red-700">{parseError}</p> : null}
      {bulk?.notice ? <p role="alert" className="text-sm text-red-700">{t(bulk.notice.key, bulk.notice.params)}</p> : null}
      <SaveFeedback subject="taskSave" error={bulk?.uncertain ? null : bulk?.error ?? null} uncertainError={bulk?.uncertain ? bulk.error : null} />
      <div className="flex flex-wrap gap-2">
        <Button type="button" variant="ghost" onClick={() => close()}>{t('inlineFields.hide')}</Button>
        {bulk?.uncertain || bulk?.error ? <Button type="button" variant="primary" onClick={() => submit()} aria-disabled={bulk.pending || !writable || undefined}>{t('tasks.inlineEdit.retry')}</Button> : null}
      </div>
    </CellPopover> : null}
  </div>;
}
