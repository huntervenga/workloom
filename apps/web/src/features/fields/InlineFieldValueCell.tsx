import { useTranslation } from '../../i18n';
import type { MembershipDto, TaskDto, TaskFieldData, TaskFieldDefinitionDto, TaskFieldValueDto } from '@workloom/contracts';
import { Button, cn } from '@workloom/ui';
import { CircleAlert, LoaderCircle, Lock } from 'lucide-react';
import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { ApiError } from '../../lib/api';
import { ChoicePicker, type ChoiceOption } from '../../shared/ChoicePicker';
import { SaveFeedback } from '../../shared/SaveFeedback';
import { CellPopover } from '../tasks/CellPopover';
import { FieldValueDisplay } from './FieldValueDisplay';
import { heldFieldCommand, isSessionDirty, newFieldSession, type FieldEditSession, type SetFieldValueMutation } from './FieldValueForm';
import type { ObservableFieldValueDraftStore } from './fieldValueDraftStore';
import type { SetTaskFieldValueVariables } from './queries';
import { NOTHING_SELECTED, NOT_SET, UNAVAILABLE_MEMBER, optionsByPosition, parseFieldDraft, referenceLabels, sameId, type FieldDraft } from './valueDraft';

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
}

/** Picker value when nothing is stored: it matches no option, so the trigger stays blank. */
const NONE = '\u0000none';
/** Picker value for an explicit empty person list (`[]`), distinct from a cleared value. */
const EMPTY = '\u0000empty';

const cellButtonClassName = cn(
  'flex h-8 min-w-0 flex-1 items-center gap-1.5 rounded-sm px-1.5 text-left outline-none',
  'hover:bg-slate-100 focus-visible:bg-slate-100 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent',
);
// The picker keeps its focus and open rings; at rest it reads as plain cell text.
const pickerClassName = 'border-transparent! bg-transparent! px-1.5 shadow-none! hover:bg-slate-100!';

function isCommandFor(variables: SetTaskFieldValueVariables | null | undefined, taskId: string, fieldId: string): boolean {
  return variables !== null && variables !== undefined && sameId(variables.taskId, taskId) && sameId(variables.fieldId, fieldId);
}

function isProtected(session: FieldEditSession | undefined): session is FieldEditSession {
  return session !== undefined && (isSessionDirty(session) || session.stale || session.serverLocked);
}

/** Same rule as the value form: an unchanged value or clearing an empty one sends nothing. */
function unchanged(original: TaskFieldData | null, next: TaskFieldData): boolean {
  return original === null ? next.value === null : JSON.stringify(original) === JSON.stringify(next);
}

type ChoiceKind = 'single' | 'person';

/** A person value with several people cannot be shown as one choice, so it is edited in details. */
function choiceKind(field: TaskFieldDefinitionDto, data: TaskFieldData | null): ChoiceKind | null {
  if (field.type === 'single_select') return 'single';
  if (field.type !== 'person') return null;
  return data?.type !== 'person' || data.value === null || data.value.length <= 1 ? 'person' : null;
}

function pickerValue(data: TaskFieldData | null): string {
  if (data?.type === 'single_select') return data.value?.toLowerCase() ?? NONE;
  if (data?.type === 'person') return data.value === null ? NONE : (data.value[0]?.toLowerCase() ?? EMPTY);
  return NONE;
}

function choiceOptions(kind: ChoiceKind, field: TaskFieldDefinitionDto, current: string, members: readonly MembershipDto[]): ChoiceOption[] {
  const stored = current === NONE || current === EMPTY ? null : current;
  if (kind === 'single') {
    const active = optionsByPosition(field.options).filter((option) => option.archivedAt === null);
    const retained = stored !== null && !active.some((option) => sameId(option.id, stored)) ? referenceLabels(field, [stored], members)[0] : undefined;
    return [
      { value: '', label: NOT_SET() },
      // An archived or unknown stored option stays visible, but is never offered as a new choice.
      ...(retained ? [{ value: stored ?? '', label: retained.label, color: retained.color ?? undefined, disabled: true }] : []),
      ...active.map((option) => ({ value: option.id.toLowerCase(), label: option.name, color: option.color ?? undefined })),
    ];
  }
  return [
    { value: '', label: NOT_SET() },
    ...(current === EMPTY ? [{ value: EMPTY, label: NOTHING_SELECTED(), disabled: true }] : []),
    ...(stored !== null && !members.some((member) => sameId(member.id, stored)) ? [{ value: stored, label: UNAVAILABLE_MEMBER(), disabled: true }] : []),
    ...members.map((member) => ({ value: member.id.toLowerCase(), label: member.displayName, avatarName: member.displayName })),
  ];
}

/** The draft for an explicit choice, with the stable ID exactly as loaded; null for anything not offered. */
function draftForChoice(kind: ChoiceKind, field: TaskFieldDefinitionDto, choice: string, members: readonly MembershipDto[]): FieldDraft | null {
  if (kind === 'single') {
    if (choice === '') return { type: 'single_select', value: null };
    const option = field.options.find((candidate) => candidate.archivedAt === null && sameId(candidate.id, choice));
    return option ? { type: 'single_select', value: option.id } : null;
  }
  if (choice === '') return { type: 'person', value: null };
  const member = members.find((candidate) => sameId(candidate.id, choice));
  return member ? { type: 'person', value: [member.id] } : null;
}

/**
 * One custom-field value in a fixed-size table cell. Single-select and single-person values are
 * chosen directly and saved at once through the page's value command, against the exact loaded
 * value and definition revisions. Other types, kept drafts, conflicts and locks open the task's
 * details. Feedback floats in a cell popover, so the cell and its row never change size.
 */
export function InlineFieldValueCell({ actorId, workspaceId, task, field, value, members, writable, mutation, drafts, onMoreDetails }: InlineFieldValueCellProps) {
  const { t } = useTranslation();
  const key = field.id.toLowerCase();
  const context = `${actorId}:${workspaceId}:${task.id}:${field.id}`.toLowerCase();
  // The task's session object changes identity on every write, so same-dirty edits re-render too.
  const sessions = useSyncExternalStore(drafts.subscribe, () => drafts.getTask(task.id));
  const kept = sessions[key];
  const [anchor, setAnchor] = useState<HTMLDivElement | null>(null);
  const [feedbackOpen, setFeedbackOpen] = useState(false);
  const restoreFocus = useRef(false);

  const held = heldFieldCommand(mutation);
  const heldHere = isCommandFor(held, task.id, field.id) ? held : null;
  const blocked = held !== null && heldHere === null;
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
  const review = heldHere === null && isProtected(kept) ? kept : null;
  const ownError = review?.submitted === true && isCommandFor(mutation.variables, task.id, field.id) ? mutation.error : null;
  const feedbackError = (pending ? null : uncertainHere?.error) ?? ownError;
  const editable = writable && !field.locked && field.archivedAt === null;

  // A disabled trigger drops focus while sending; give it back only if nothing else took it.
  useEffect(() => {
    if (pending || !restoreFocus.current) return;
    restoreFocus.current = false;
    const active = document.activeElement;
    if (active === null || active === document.body) anchor?.querySelector<HTMLElement>('button:not([disabled])')?.focus({ preventScroll: true });
  }, [pending, anchor]);

  const handleError = (error: Error) => {
    if (!(error instanceof ApiError) || error.kind !== 'conflict') return;
    const current = drafts.getTask(task.id);
    const session = current[key];
    if (!session) return;
    // Kept for review in details; never reset or rebased here.
    drafts.set(task.id, { ...current, [key]: error.code === 'FIELD_LOCKED' ? { ...session, serverLocked: true } : { ...session, stale: true } });
  };

  const choose = (kind: ChoiceKind, choice: string) => {
    if (heldFieldCommand(mutation) !== null || !editable) return;
    const current = drafts.getTask(task.id);
    // Checked again at commit: a draft, conflict or lock kept since this render is never replaced.
    if (isProtected(current[key])) return;
    const draft = draftForChoice(kind, field, choice, members);
    if (draft === null) return;
    const parsed = parseFieldDraft(field, draft);
    if (!parsed.ok || unchanged(base?.value ?? null, parsed.value)) return;
    const session = newFieldSession(field, base, draft);
    drafts.set(task.id, { ...current, [key]: { ...session, submitted: true } });
    // Captured before sending; the page's confirmation retires only this exact session.
    drafts.capture(task.id, session);
    restoreFocus.current = true;
    setFeedbackOpen(true);
    mutation.mutate(
      {
        taskId: task.id,
        fieldId: field.id,
        input: { expectedRevision: session.value?.revision ?? 0, expectedDefinitionRevision: session.field.revision, value: parsed.value },
      },
      { onError: handleError },
    );
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
  const kind = choiceKind(field, shown);
  const display = (
    <span className="min-w-0 flex-1 truncate">
      <FieldValueDisplay field={field} value={shown} members={members} compact />
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
  } else if (kind !== null && (editable || heldHere !== null)) {
    const current = pickerValue(shown);
    control = (
      <div className="min-w-0 flex-1" title={blocked ? t('inlineFields.otherCommand') : undefined}>
        <ChoicePicker
          compact
          label={editLabel}
          value={current}
          options={choiceOptions(kind, field, current, members)}
          searchable={kind === 'person' ? true : undefined}
          placeholder=""
          disabled={held !== null}
          onValueChange={(choice) => choose(kind, choice)}
          className={pickerClassName}
        />
      </div>
    );
  } else if (editable || heldHere !== null) {
    control = (
      <button type="button" aria-label={editLabel} title={editLabel} className={cellButtonClassName} onClick={moreDetails}>
        {display}
      </button>
    );
  } else {
    const lockedLabel = field.locked ? t('inlineFields.locked', { field: field.name }) : undefined;
    control = (
      <span className="flex h-8 min-w-0 flex-1 items-center gap-1 px-1.5" title={lockedLabel}>
        {field.locked ? <Lock size={12} aria-label={lockedLabel} className="shrink-0 text-muted" /> : null}
        {display}
      </span>
    );
  }

  return (
    <div ref={setAnchor} data-inline-field-cell={`${task.id}:${field.id}`} className="relative flex h-8 min-w-0 flex-1 items-center gap-1">
      {control}
      {pending ? (
        <>
          <LoaderCircle size={14} aria-hidden="true" className="pointer-events-none absolute right-6 text-muted motion-safe:animate-spin" />
          <span role="status" className="sr-only">{t('inlineFields.saving', { field: field.name, title })}</span>
        </>
      ) : null}
      {feedbackError && !feedbackOpen ? (
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
      {feedbackError && feedbackOpen ? (
        <CellPopover anchor={anchor} side="top">
          <SaveFeedback subject="fieldValueSave" error={ownError} uncertainError={pending ? null : (uncertainHere?.error ?? null)} />
          <div data-inline-actions="" className="flex min-w-0 flex-wrap items-center gap-1">
            {uncertainHere ? (
              <Button size="sm" variant="primary" onClick={retry}>{t('inlineFields.retry')}</Button>
            ) : (
              <Button size="sm" onClick={moreDetails}>{t('inlineFields.review')}</Button>
            )}
            <Button size="sm" variant="ghost" onClick={() => setFeedbackOpen(false)}>{t('inlineFields.hide')}</Button>
          </div>
        </CellPopover>
      ) : null}
    </div>
  );
}
