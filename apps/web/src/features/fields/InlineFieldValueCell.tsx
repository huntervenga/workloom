import { useTranslation } from '../../i18n';
import type { MembershipDto, TaskDto, TaskFieldData, TaskFieldDefinitionDto, TaskFieldValueDto } from '@workloom/contracts';
import { useQueryClient } from '@tanstack/react-query';
import { protectedCommandsFor } from '../../lib/protectedCommands';
import { Button, cn } from '@workloom/ui';
import { CircleAlert, LoaderCircle, Lock } from 'lucide-react';
import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { ApiError } from '../../lib/api';
import { CalculatedValue, FieldCellControl } from './FieldCellControl';
import { FieldAdvisoryIndicator, fieldAdvisoryStyle, type FieldAdvisory } from './FieldAdvisory';
import { BooleanFieldControl } from './BooleanFieldControl';
import { SaveFeedback } from '../../shared/SaveFeedback';
import { CellPopover } from '../tasks/CellPopover';
import { FieldValueDisplay } from './FieldValueDisplay';
import { heldFieldCommand, isSessionDirty, newFieldSession, type FieldEditSession, type SetFieldValueMutation } from './FieldValueForm';
import type { ObservableFieldValueDraftStore } from './fieldValueDraftStore';
import type { SetTaskFieldValueVariables } from './queries';
import { parseFieldDraft, sameId, type FieldDraft } from './valueDraft';

export interface InlineFieldValueCellProps {
  actorId: string;
  workspaceId: string;
  task: TaskDto;
  field: TaskFieldDefinitionDto;
  /** Loaded value row; null when the task has none (`expectedRevision: 0`). The parent renders unloaded values. */
  value: TaskFieldValueDto | null;
  members: readonly MembershipDto[];
  writable: boolean;
  /** Page-owned, so a pending or unconfirmed write outlives the row and the drawer. */
  mutation: SetFieldValueMutation;
  /** Page-owned retained sessions shared with the task drawer. */
  drafts: ObservableFieldValueDraftStore;
  /** Opens the task's details, where drafts, conflicts and locks are reviewed. */
  onMoreDetails: () => void;
  presentation?: 'pane' | 'cell';
  /** Presentation of an authoritative advisory; never changes editability or value semantics. */
  advisory?: FieldAdvisory | null;
  /** Rolled-up subtask total, shown muted while this task has no value of its own. */
  inherited?: TaskFieldData | null;
}

const cellButtonClassName = cn('flex h-8 min-w-0 flex-1 items-center gap-1.5 rounded-sm px-1.5 text-left outline-none hover:bg-canvas focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent');

function isCommandFor(variables: SetTaskFieldValueVariables | null | undefined, taskId: string, fieldId: string): boolean {
  return variables !== null && variables !== undefined && sameId(variables.taskId, taskId) && sameId(variables.fieldId, fieldId);
}

function isProtected(session: FieldEditSession | undefined): boolean {
  return session !== undefined && (isSessionDirty(session) || session.stale || session.serverLocked);
}

/** Same rule as the value form: an unchanged value or clearing an empty one sends nothing. */
function unchanged(original: TaskFieldData | null, next: TaskFieldData): boolean {
  return original === null ? next.value === null : JSON.stringify(original) === JSON.stringify(next);
}

export function InlineFieldValueCell({ actorId, workspaceId, task, field, value, members, writable, mutation, drafts, onMoreDetails, presentation = 'cell', advisory, inherited }: InlineFieldValueCellProps) {
  const { t } = useTranslation();
  const registry = protectedCommandsFor(useQueryClient());
  useSyncExternalStore(registry.subscribe, registry.getSnapshot, registry.getSnapshot);
  const key = field.id.toLowerCase();
  const context = `${actorId}:${workspaceId}:${task.id}:${field.id}`.toLowerCase();
  // The task's session object changes identity on every write, so same-dirty edits re-render too.
  const sessions = useSyncExternalStore(drafts.subscribe, () => drafts.getTask(task.id));
  const kept = sessions[key];
  const [anchor, setAnchor] = useState<HTMLDivElement | null>(null);
  const [feedbackOpen, setFeedbackOpen] = useState(false);
  const restoreFocus = useRef(false);
  const editing = useRef<object | null>(null);
  const [parseError, setParseError] = useState<string | null>(null);

  const held = heldFieldCommand(mutation);
  const heldHere = isCommandFor(held, task.id, field.id) ? held : null;
  const blocked = (held !== null && heldHere === null) || mutation.hasOtherProtectedCommands();
  const pending = heldHere !== null && mutation.pendingCommand !== null;
  const uncertainHere = isCommandFor(mutation.uncertain?.variables, task.id, field.id) ? mutation.uncertain : null;

  // The page's mutation keeps only the latest answer, and another cell's write clears it before this
  // cell's refetched row lands. Keep this cell's highest receipt, scoped to its actor/task/field.
  const [receipt, setReceipt] = useState<{ context: string; value: TaskFieldValueDto } | null>(null);
  const stored = receipt?.context === context ? receipt.value : null;
  const answer = mutation.data;
  const incoming =
    answer && sameId(answer.workspaceId, workspaceId) && sameId(answer.taskId, task.id) && sameId(answer.fieldId, field.id) ? answer : null;
  const confirmed = incoming && (stored === null || incoming.revision > stored.revision) ? incoming : stored;
  useEffect(() => {
    if (confirmed !== null && confirmed !== stored) setReceipt({ context, value: confirmed });
  }, [confirmed, stored, context]);
  // Shown and used as the next base only until a loaded row is as new; it is not the current head,
  // so the server still checks the revision and an older replay can only lead to a reviewed conflict.
  const base = confirmed && confirmed.revision > (value?.revision ?? 0) ? confirmed : value;
  const review = heldHere === null && isProtected(kept) && (editing.current !== kept?.identity || !writable || field.locked || field.archivedAt !== null) ? kept : null;
  const ownError = review?.submitted === true && isCommandFor(mutation.variables, task.id, field.id) ? mutation.error : null;
  const feedbackError = (pending ? null : uncertainHere?.error) ?? ownError;
  const editable = writable && !field.locked && field.archivedAt === null;

  // A successful ACK briefly exposes the submitted review control before the page retires it.
  // Wait for the actual editor, rather than focus a review button that the next render removes.
  const retiringAcknowledgement = review?.submitted === true && incoming !== null && incoming.revision > (review.value?.revision ?? 0) && ownError === null;
  // A disabled trigger drops focus while sending; give it back only if nothing else took it.
  useEffect(() => {
    if (pending || retiringAcknowledgement || !restoreFocus.current) return;
    restoreFocus.current = false;
    const active = document.activeElement;
    if (active === null || active === document.body) anchor?.querySelector<HTMLElement>('input[type="checkbox"]:not([disabled]), button:not([disabled])')?.focus({ preventScroll: true });
  }, [pending, anchor, retiringAcknowledgement]);

  const handleError = (error: Error) => {
    if (!(error instanceof ApiError) || error.kind !== 'conflict') return;
    const current = drafts.getTask(task.id);
    const session = current[key];
    if (!session) return;
    // Kept for review in details; never reset or rebased here.
    drafts.set(task.id, { ...current, [key]: error.code === 'FIELD_LOCKED' ? { ...session, serverLocked: true } : { ...session, stale: true } });
  };

  const begin = () => {
    if (heldFieldCommand(mutation) !== null || mutation.hasOtherProtectedCommands() || !editable) return;
    const current = drafts.getTask(task.id);
    if (current[key]) {
      if (!isProtected(current[key])) editing.current = current[key].identity;
      return;
    }
    const session = newFieldSession(field, base);
    editing.current = session.identity;
    drafts.set(task.id, { ...current, [key]: session });
  };
  const cancel = (onlyClean = false) => {
    const current = drafts.getTask(task.id);
    const session = current[key];
    if (!session || session.identity !== editing.current || session.submitted || heldFieldCommand(mutation) || (onlyClean && isSessionDirty(session))) return;
    drafts.set(task.id, Object.fromEntries(Object.entries(current).filter(([id]) => id !== key)));
    editing.current = null;
    setParseError(null);
  };
  const change = (draft: FieldDraft) => {
    begin();
    const current = drafts.getTask(task.id);
    if (!current[key] || current[key].identity !== editing.current || current[key].submitted) return;
    drafts.set(task.id, { ...current, [key]: { ...current[key], draft } });
    setParseError(null);
  };
  const commit = (draft: FieldDraft): boolean => {
    if (heldFieldCommand(mutation) !== null || mutation.hasOtherProtectedCommands() || !editable) return false;
    begin();
    const current = drafts.getTask(task.id);
    const original = current[key];
    if (!original || original.identity !== editing.current || original.stale || original.serverLocked || original.submitted) return false;
    const parsed = parseFieldDraft(original.field, draft);
    if (!parsed.ok) { setParseError(parsed.message); setFeedbackOpen(true); return false; }
    if (unchanged(original.value?.value ?? null, parsed.value)) { cancel(); return true; }
    const session = { ...original, draft, submitted: true };
    drafts.set(task.id, { ...current, [key]: session });
    drafts.capture(task.id, session);
    editing.current = null;
    restoreFocus.current = true;
    setParseError(null);
    setFeedbackOpen(true);
    mutation.mutate({ taskId: task.id, fieldId: field.id,
      input: { expectedRevision: session.value?.revision ?? 0, expectedDefinitionRevision: session.field.revision, value: parsed.value },
      undo: { before: session.value, field: session.field },
    }, { onError: handleError });
    return true;
  };

  const retry = () => {
    if (pending || uncertainHere === null) return;
    restoreFocus.current = true;
    setFeedbackOpen(true);
    // The original key and body, unchanged.
    mutation.retryUncertain({ onError: handleError });
  };

  const moreDetails = () => {
    setFeedbackOpen(false);
    onMoreDetails();
  };

  const title = task.title;
  const editLabel = t('inlineFields.edit', { field: field.name, title });
  const shown = heldHere ? heldHere.input.value : (base?.value ?? null);
  const display = (
    <span className="min-w-0 flex-1 truncate">
      {shown?.type === 'url' ? <span className="block truncate" title={shown.value ?? undefined}>{shown.value}</span> : inherited && (shown === null || shown.value === null) ? <CalculatedValue field={field} data={inherited} members={members} /> : <FieldValueDisplay field={field} value={shown} members={members} compact />}
    </span>
  );

  let control: ReactNode;
  if (review) {
    const draftLabel = t('inlineFields.draftLabel', { field: field.name, title });
    control = (
      <button type="button" aria-label={draftLabel} title={draftLabel} className={cellButtonClassName} onClick={moreDetails}>
        {display}
        <span className="shrink-0 rounded-full bg-amber-50 px-1.5 py-px text-[11px] font-medium text-amber-800 ring-1 ring-amber-200 ring-inset">
          {t('inlineFields.draft')}
        </span>
      </button>
    );
  } else if (editable || heldHere !== null) {
    control = <FieldCellControl field={field} value={shown} inherited={inherited} members={members} label={editLabel} disabled={held !== null || blocked}
      draft={kept?.identity === editing.current ? kept.draft : undefined}
      error={parseError} onBegin={begin} onChange={change} onCommit={commit} onCancel={cancel} />;
  } else {
    const lockedLabel = field.locked ? t('inlineFields.locked', { field: field.name }) : undefined;
    control = (
      <span className="flex h-8 min-w-0 flex-1 items-center gap-1 px-1.5" title={lockedLabel}>
        {field.locked ? <Lock size={12} aria-label={lockedLabel} className="shrink-0 text-muted" /> : null}
        {field.type === 'boolean' ? <BooleanFieldControl value={shown?.type === 'boolean' ? shown.value : null} label={editLabel} fieldName={field.name} disabled onChange={() => undefined}/> : display}
      </span>
    );
  }

  return (
    <div ref={setAnchor} data-inline-field-cell={`${task.id}:${field.id}`} data-presentation={presentation} style={fieldAdvisoryStyle(advisory)} className="relative flex h-8 min-w-0 flex-1 items-center gap-1" onClick={event => event.stopPropagation()}>
      {control}
      <FieldAdvisoryIndicator advisory={advisory} />
      {pending ? (
        <>
          <LoaderCircle size={14} aria-hidden="true" className="pointer-events-none absolute right-6 text-muted motion-safe:animate-spin" />
          <span role="status" className="sr-only">{t('inlineFields.saving', { field: field.name, title })}</span>
        </>
      ) : null}
      {(feedbackError || parseError) && !feedbackOpen ? (
        <button
          type="button"
          aria-label={t('inlineFields.showProblem', { field: field.name })}
          title={t('inlineFields.showProblem', { field: field.name })}
          className="inline-flex size-6 shrink-0 items-center justify-center rounded text-amber-700 outline-none hover:bg-amber-50 focus-visible:ring-2 focus-visible:ring-accent"
          onClick={() => setFeedbackOpen(true)}
        >
          <CircleAlert size={14} aria-hidden="true" />
        </button>
      ) : null}
      {/* The picker is closed whenever there is feedback, so it sits below the cell, away from page notices above the table. */}
      {(feedbackError || parseError) && feedbackOpen ? (
        <CellPopover anchor={anchor}>
          {parseError ? <p role="alert" className="text-sm text-red-700">{parseError}</p> : null}
          <SaveFeedback subject="fieldValueSave" error={ownError} uncertainError={pending ? null : (uncertainHere?.error ?? null)} />
          <div data-inline-actions="" className="flex min-w-0 flex-wrap items-center gap-1">
            {uncertainHere ? <Button size="sm" variant="primary" onClick={retry}>{t('inlineFields.retry')}</Button> : null}
            {/* Always a direct route to details; opening them neither retries nor discards the held command.
                An unknown outcome keeps this feedback open: it is only hidden under the dialog and returns with its Retry. */}
            <Button size="sm" onClick={uncertainHere ? () => onMoreDetails() : moreDetails}>{t('inlineFields.review')}</Button>
            <Button size="sm" variant="ghost" onClick={() => setFeedbackOpen(false)}>{t('inlineFields.hide')}</Button>
          </div>
        </CellPopover>
      ) : null}
    </div>
  );
}
