import type { MembershipDto, TaskDto, TaskFieldDefinitionDto, TaskFieldValueDto } from '@workloom/contracts';
import { Button } from '@workloom/ui';
import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { useTranslation } from '../../i18n';
import { useUnsavedChangesWarning } from '../../lib/useUnsavedChangesWarning';
import { DialogShell } from '../../shared/DialogShell';
import { SaveFeedback } from '../../shared/SaveFeedback';
import { FieldInput } from '../fields/FieldInput';
import { FieldValueDisplay } from '../fields/FieldValueDisplay';
import { newFieldSession, type FieldEditSession } from '../fields/FieldValueForm';
import type { ObservableFieldValueDraftStore } from '../fields/fieldValueDraftStore';
import { parseFieldDraft, type FieldDraft } from '../fields/valueDraft';
import type { InlineBulkEditPort } from '../tasks/InlineTaskEdit';

/** The same typed field input as details; its one value is atomically applied to a captured selection. */
export function BulkCustomFieldCell({ task, field, value, members, writable, drafts, capture, port }: {
  task: TaskDto; field: TaskFieldDefinitionDto; value: TaskFieldValueDto | null;
  members: readonly MembershipDto[]; writable: boolean; drafts: ObservableFieldValueDraftStore;
  capture: (identity: object, baseField: TaskFieldDefinitionDto, baseValue: TaskFieldValueDto | null) => void; port: (identity: object) => InlineBulkEditPort | undefined;
}) {
  const { t } = useTranslation();
  const sessions = useSyncExternalStore(drafts.subscribe, () => drafts.getTask(task.id));
  const session = sessions[field.id.toLowerCase()];
  const [open, setOpen] = useState(false);
  const [parseError, setParseError] = useState<string | null>(null);
  const mounted = useRef(true);
  const sending = useRef(false);
  const sentSession = useRef<FieldEditSession | null>(null);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const bulk = session ? port(session.identity) : undefined;
  const held = bulk?.pending === true || bulk?.uncertain === true;
  useUnsavedChangesWarning(session !== undefined || held);
  const setSession = (next: FieldEditSession) => drafts.set(task.id, { ...drafts.getTask(task.id), [field.id.toLowerCase()]: next });
  const discard = (submitted: FieldEditSession) => {
    const current = drafts.getTask(task.id);
    if (current[field.id.toLowerCase()]?.identity !== submitted.identity || current[field.id.toLowerCase()]?.draft !== submitted.draft) return;
    drafts.set(task.id, Object.fromEntries(Object.entries(current).filter(([key]) => key !== field.id.toLowerCase())));
  };
  const begin = () => {
    if (!writable || field.locked || field.archivedAt !== null) return;
    const next = session ?? newFieldSession(field, value);
    capture(next.identity, next.field, next.value); setSession(next); setOpen(true);
  };
  const submit = (draft?: FieldDraft) => {
    // Read the retained store at commit time; a discrete picker change may precede React render.
    const current = drafts.getTask(task.id)[field.id.toLowerCase()];
    const currentBulk = current ? port(current.identity) : undefined;
    if (!current || !currentBulk || !writable || field.locked || field.archivedAt !== null || currentBulk.pending || sending.current) return;
    const submitted = draft === undefined || draft === current.draft ? current : { ...current, draft };
    const callbacks = { onConfirmed: () => discard(submitted), onSuccess: () => { if (mounted.current) setOpen(false); }, onSettled: () => { sending.current = false; } };
    if (currentBulk.uncertain) { sending.current = true; currentBulk.retry(callbacks); return; }
    const parsed = parseFieldDraft(submitted.field, submitted.draft);
    if (!parsed.ok) { setParseError(parsed.message); return; }
    setParseError(null);
    setSession(submitted);
    sending.current = true;
    sentSession.current = submitted;
    const result = currentBulk.submit({ customField: { fieldId: submitted.field.id, expectedDefinitionRevision: submitted.field.revision, value: parsed.value } }, callbacks);
    if (result !== 'sent') { sending.current = false; sentSession.current = null; }
    if (result === 'unchanged') { discard(submitted); setOpen(false); }
  };
  const close = () => {
    // Escape cancels only an unsent buffer. An original sent/unknown batch retains its payload.
    if (session && !held && !sending.current && sentSession.current?.identity !== session.identity) discard(session);
    setOpen(false);
  };
  return <>
    <button type="button" disabled={!writable || field.locked || field.archivedAt !== null} aria-label={t('bulkInline.editField', { field: field.name, title: task.title })}
      onClick={begin} className="flex h-8 min-w-0 flex-1 items-center rounded-sm px-1.5 text-left outline-none hover:bg-canvas focus-visible:ring-2 focus-visible:ring-accent">
      {value?.value.type === 'url' && value.value.value !== null
        ? <span className="block truncate" title={value.value.value}>{value.value.value}</span>
        : <FieldValueDisplay compact field={field} value={value?.value ?? null} members={members} />}
      {session ? <span className="sr-only">{t('bulkInline.retained')}</span> : null}
    </button>
    <DialogShell open={open && session !== undefined} onOpenChange={next => { if (!next) close(); else setOpen(true); }} title={t('bulkInline.editField', { field: field.name, title: task.title })} description={t('bulkInline.customDescription')}>
      {session ? <form onSubmit={event => { event.preventDefault(); event.stopPropagation(); submit(); }}>
        <p role="status" className="mb-3 text-sm font-medium text-accent-ink">{t('bulkInline.appliesTo', { count: bulk?.count ?? 0 })}</p>
        <FieldInput field={session.field} draft={session.draft} originalValue={session.value?.value ?? null} members={members} disabled={held || !writable}
          error={parseError} onChange={draft => { setSession({ ...session, draft }); setParseError(null); }} onCommit={draft => submit(draft)} />
        {bulk?.notice ? <p role="alert" className="mt-2 text-sm text-red-700">{t(bulk.notice.key, bulk.notice.params)}</p> : null}
        <SaveFeedback subject="taskSave" error={bulk?.uncertain ? null : bulk?.error ?? null} uncertainError={bulk?.uncertain ? bulk.error : null} />
        <div className="mt-4 flex flex-wrap justify-end gap-2">
          <Button type="button" variant="ghost" onClick={close}>{t('tasks.quickAdd.collapse')}</Button>
          {bulk?.uncertain || bulk?.error ? <Button type="submit" variant="primary" aria-disabled={bulk?.pending || !writable || undefined}>{t('tasks.inlineEdit.retry')}</Button> : null}
        </div>
      </form> : null}
    </DialogShell>
  </>;
}
