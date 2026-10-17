import { t, useTranslation } from '../../i18n';
/**
 * Extra cells of the unsaved task row: custom field values and weekly hours staged before the
 * task exists. Everything stays local: no request, no mutation, no timer. The staged draft is plain
 * data; `validateInitialTaskCells` turns it into generic values for the atomic create composer,
 * which maps them to its own request later.
 */
import type { MembershipDto, TaskFieldData, TaskFieldDefinitionDto } from '@workloom/contracts';
import { Button, cn, inputClassName } from '@workloom/ui';
import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
// Direct module imports: the fields and table indexes pull in queries this row must not need.
import { FieldInput } from '../fields/FieldInput';
import { FieldValueDisplay } from '../fields/FieldValueDisplay';
import { clearedFieldDraft, parseFieldDraft, sameId, type FieldDraft } from '../fields/valueDraft';
import { parseEstimateInput } from '../task-table/estimate';
import { CellPopover } from './CellPopover';

export type InitialHoursKind = 'planned' | 'fact';

/** One custom field value staged against the definition snapshot taken when it was first entered. */
export interface InitialFieldEntry {
  readonly field: TaskFieldDefinitionDto;
  readonly draft: FieldDraft;
}

/**
 * The loaded parent package commitment for the context's week and person. `expectedRevision` is
 * its current revision; `null` means it is known to be absent.
 */
export interface InitialTimePlanSource {
  readonly workPackageId: string;
  readonly expectedRevision: number | null;
}

/** An explicitly selected week and person. Names are kept so a later review can show them. */
export interface InitialTimeContext {
  readonly periodId: string;
  readonly membershipId: string;
  readonly periodName: string;
  readonly memberName: string;
  /** Only with a loaded parent commitment; without it a shared package plan stays blocked. */
  readonly plan?: InitialTimePlanSource;
}

/** Raw typed hours; blank means «not entered», `0` an explicit zero. */
export interface InitialHoursDraft {
  readonly raw: string;
  readonly touched: boolean;
}

export interface InitialTaskTimeDraft {
  /** Captured on the first typed hours and kept while any hours remain typed. */
  readonly context: InitialTimeContext | null;
  readonly planned: InitialHoursDraft;
  readonly fact: InitialHoursDraft;
}

export interface InitialTaskCellsDraft {
  /** Keyed by field ID. A missing key is «not set on create»; a cleared draft is an explicit `null`. */
  readonly fields: Readonly<Record<string, InitialFieldEntry>>;
  readonly time: InitialTaskTimeDraft;
}

/** A value row created together with the task, so no row exists yet: `expectedValueRevision` is 0. */
export interface InitialFieldValueData {
  readonly fieldId: string;
  readonly definitionVersionId: string;
  readonly expectedDefinitionRevision: number;
  readonly expectedValueRevision: 0;
  readonly value: TaskFieldData;
}

/** Hours for the captured context. A blank cell leaves its key out; `0` is kept. */
export interface InitialTimeData {
  readonly periodId: string;
  readonly membershipId: string;
  /**
   * Whole parent package total for the captured week and person, not an allocation to the new
   * subtask. Without `expectedPlanRevision` it plans the new task's own package.
   */
  readonly plannedMinutes?: number;
  /** Captured parent commitment revision guarding a shared package plan; `null` expects none. */
  readonly expectedPlanRevision?: number | null;
  readonly actualMinutes?: number;
}

export interface InitialTaskCellsData {
  readonly fields: readonly InitialFieldValueData[];
  readonly time: InitialTimeData | null;
}

export type InitialTaskCellsIssue =
  | { readonly kind: 'field'; readonly fieldId: string; readonly message: string }
  | { readonly kind: 'hours'; readonly hours: InitialHoursKind; readonly message: string };

export type InitialTaskCellsValidation =
  /** `contextChanged`: the hours keep their captured week and person, which the table no longer shows. */
  | { readonly ok: true; readonly data: InitialTaskCellsData; readonly contextChanged: boolean }
  | { readonly ok: false; readonly issues: readonly InitialTaskCellsIssue[] };

export interface InitialTaskCellsValidationOptions {
  /** Current definitions. A staged value whose field changed or left is reported, never re-targeted. */
  readonly definitions?: readonly TaskFieldDefinitionDto[] | undefined;
  /** Current explicit selection, only to report a review; the captured context always wins. */
  readonly currentContext?: InitialTimeContext | null | undefined;
  /**
   * A subtask in its parent's work package: planned hours set that package's total and need the
   * captured parent commitment; they are never an allocation to the new row.
   */
  readonly sharesParentPackage?: boolean | undefined;
}

export type InitialHoursResult = { ok: true; minutes: number | null } | { ok: false; message: string };

const HOURS_KINDS: readonly InitialHoursKind[] = ['planned', 'fact'];
const UNTOUCHED: InitialHoursDraft = { raw: '', touched: false };

export function emptyInitialTaskCellsDraft(): InitialTaskCellsDraft {
  return { fields: {}, time: { context: null, planned: UNTOUCHED, fact: UNTOUCHED } };
}

/**
 * A context only from an explicit week and person selection; anything blank gives `null`.
 * Pass the selected values themselves, never a fallback such as the current person. `plan` is the
 * loaded parent commitment for exactly this week and person; an unusable one is left out.
 */
export function explicitTimeContext(input: {
  periodId: string | null | undefined;
  membershipId: string | null | undefined;
  periodName: string;
  memberName: string;
  plan?: { workPackageId: string | null | undefined; expectedRevision: number | null } | null | undefined;
}): InitialTimeContext | null {
  const periodId = input.periodId?.trim() ?? '';
  const membershipId = input.membershipId?.trim() ?? '';
  if (periodId === '' || membershipId === '') return null;
  const workPackageId = input.plan?.workPackageId?.trim() ?? '';
  const revision = input.plan?.expectedRevision;
  const knownRevision = revision === null || (typeof revision === 'number' && Number.isSafeInteger(revision) && revision >= 0);
  const plan = workPackageId !== '' && knownRevision ? { workPackageId, expectedRevision: revision ?? null } : null;
  return {
    periodId,
    membershipId,
    periodName: input.periodName,
    memberName: input.memberName,
    ...(plan !== null ? { plan } : {}),
  };
}

export function sameTimeContext(a: InitialTimeContext | null, b: InitialTimeContext | null): boolean {
  if (a === null || b === null) return a === b;
  return sameId(a.periodId, b.periodId) && sameId(a.membershipId, b.membershipId);
}

/** Stages a field value. The first staging snapshots the definition; later edits keep that snapshot. */
export function stageInitialField(
  draft: InitialTaskCellsDraft,
  field: TaskFieldDefinitionDto,
  value: FieldDraft,
): InitialTaskCellsDraft {
  const snapshot = draft.fields[field.id]?.field ?? field;
  return { ...draft, fields: { ...draft.fields, [field.id]: { field: snapshot, draft: value } } };
}

/** Back to «not set on create»: no value row is created for this field. */
export function unstageInitialField(draft: InitialTaskCellsDraft, fieldId: string): InitialTaskCellsDraft {
  if (!(fieldId in draft.fields)) return draft;
  const fields = Object.fromEntries(Object.entries(draft.fields).filter(([id]) => id !== fieldId));
  return { ...draft, fields };
}

/**
 * Keeps typed hours as raw text. The first typed hours capture `context`; later edits stay on the
 * captured context even when the selection has changed. Without any explicit context nothing is
 * staged. Once both cells are blank again the capture is released.
 */
export function setInitialHours(
  draft: InitialTaskCellsDraft,
  kind: InitialHoursKind,
  raw: string,
  context: InitialTimeContext | null,
): InitialTaskCellsDraft {
  const captured = draft.time.context ?? context;
  if (captured === null) return draft;
  const edited: InitialHoursDraft = { raw, touched: true };
  const planned = kind === 'planned' ? edited : draft.time.planned;
  const fact = kind === 'fact' ? edited : draft.time.fact;
  const typed = planned.raw.trim() !== '' || fact.raw.trim() !== '';
  return { ...draft, time: { context: typed ? captured : null, planned, fact } };
}

/** Whether anything would be sent with the task, valid or not. */
export function hasInitialTaskCells(draft: InitialTaskCellsDraft): boolean {
  return (
    Object.keys(draft.fields).length > 0 ||
    draft.time.planned.raw.trim() !== '' ||
    draft.time.fact.raw.trim() !== ''
  );
}

/** Shared hours parser with copy about hours rather than task estimates. */
export function parseInitialHours(raw: string): InitialHoursResult {
  const parsed = parseEstimateInput(raw);
  if (parsed.valid) return { ok: true, minutes: parsed.minutes };
  switch (parsed.messageKey) {
    case 'taskTable.estimate.estimateIsTooLarge':
      return { ok: false, message: t('taskRows.time.tooLarge') };
    case 'taskTable.estimate.valueIsTooLong':
      return { ok: false, message: t('taskRows.time.tooLong') };
    case 'taskTable.estimate.estimateCannotBeNegative':
      return { ok: false, message: t('taskRows.time.negative') };
    case 'taskTable.estimate.inHMMFormatMinutesMustBeBetween':
      return { ok: false, message: t('taskRows.time.clockMinutes') };
    case 'taskTable.estimate.useWholeMinutesSuchAs15Or':
      return { ok: false, message: t('taskRows.time.wholeMinutes') };
    case 'taskTable.estimate.enterHoursSuchAs15Or1':
      return { ok: false, message: t('taskRows.time.format') };
  }
}

function definitionIssue(
  snapshot: TaskFieldDefinitionDto,
  definitions: readonly TaskFieldDefinitionDto[] | undefined,
): string | null {
  if (definitions === undefined) return null;
  const current = definitions.find((field) => sameId(field.id, snapshot.id));
  if (!current || current.archivedAt !== null) return t('taskRows.field.definitionUnavailable');
  return current.revision === snapshot.revision ? null : t('taskRows.field.definitionChanged');
}

function hoursIssue(
  draft: InitialTaskCellsDraft,
  kind: InitialHoursKind,
  sharesParentPackage: boolean,
): { minutes: number | null } | { message: string } {
  const parsed = parseInitialHours(draft.time[kind].raw);
  if (!parsed.ok) return { message: parsed.message };
  if (parsed.minutes === null) return { minutes: null };
  // The captured context carries the parent commitment, so it matches the week and person by construction.
  if (kind === 'planned' && sharesParentPackage && draft.time.context?.plan === undefined) {
    return { message: t('taskRows.time.sharedPackagePlan') };
  }
  if (draft.time.context === null) return { message: t('taskRows.time.contextMissing') };
  return { minutes: parsed.minutes };
}

/**
 * Validates every staged value without rounding or guessing. Any issue blocks the whole result;
 * the raw drafts are left untouched so the person can correct them.
 */
export function validateInitialTaskCells(
  draft: InitialTaskCellsDraft,
  options: InitialTaskCellsValidationOptions = {},
): InitialTaskCellsValidation {
  const issues: InitialTaskCellsIssue[] = [];
  const fields: InitialFieldValueData[] = [];
  for (const [fieldId, entry] of Object.entries(draft.fields)) {
    const stale = definitionIssue(entry.field, options.definitions);
    if (stale !== null) {
      issues.push({ kind: 'field', fieldId, message: stale });
      continue;
    }
    const parsed = parseFieldDraft(entry.field, entry.draft);
    if (!parsed.ok) {
      issues.push({ kind: 'field', fieldId, message: parsed.message });
      continue;
    }
    fields.push({
      fieldId: entry.field.id,
      definitionVersionId: entry.field.definitionVersionId,
      expectedDefinitionRevision: entry.field.revision,
      expectedValueRevision: 0,
      value: parsed.value,
    });
  }

  const minutes: Record<InitialHoursKind, number | null> = { planned: null, fact: null };
  for (const kind of HOURS_KINDS) {
    const result = hoursIssue(draft, kind, options.sharesParentPackage === true);
    if ('message' in result) issues.push({ kind: 'hours', hours: kind, message: result.message });
    else minutes[kind] = result.minutes;
  }
  if (issues.length > 0) return { ok: false, issues };

  const context = draft.time.context;
  // A shared package plan replaces the parent total only at the captured revision, never silently.
  const sharedPlan = options.sharesParentPackage === true && minutes.planned !== null ? (context?.plan ?? null) : null;
  const time: InitialTimeData | null =
    context !== null && (minutes.planned !== null || minutes.fact !== null)
      ? {
          periodId: context.periodId,
          membershipId: context.membershipId,
          ...(minutes.planned !== null ? { plannedMinutes: minutes.planned } : {}),
          ...(sharedPlan !== null ? { expectedPlanRevision: sharedPlan.expectedRevision } : {}),
          ...(minutes.fact !== null ? { actualMinutes: minutes.fact } : {}),
        }
      : null;
  const contextChanged =
    time !== null && options.currentContext !== undefined && !sameTimeContext(context, options.currentContext);
  return { ok: true, data: { fields, time }, contextChanged };
}

/** Typed text of a draft that does not parse, shown as entered. */
function rawDraftText(draft: FieldDraft): string | null {
  return 'text' in draft ? draft.text : null;
}

export interface InitialCustomFieldCellProps {
  field: TaskFieldDefinitionDto;
  draft: InitialTaskCellsDraft;
  onChange: (draft: InitialTaskCellsDraft) => void;
  members: readonly MembershipDto[];
  disabled?: boolean | undefined;
}

/**
 * Custom field cell of the unsaved row. The editor opens as a top-layer cell popover, so the row
 * keeps its height and the cell's overflow never clips it; values are only staged into `draft`.
 */
export function InitialCustomFieldCell({ field, draft, onChange, members, disabled = false }: InitialCustomFieldCellProps) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [anchor, setAnchor] = useState<HTMLDivElement | null>(null);
  const id = useId();
  const panelId = `${id}-panel`;
  const errorId = `${id}-error`;
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  // The popover never takes focus itself; only an open by the person moves focus into it.
  const focusOnOpenRef = useRef(false);
  const entry = draft.fields[field.id];
  // A staged value is edited against its own snapshot, so it never silently switches definitions.
  const editField = entry?.field ?? field;
  const parsed = entry ? parseFieldDraft(entry.field, entry.draft) : null;
  const error = parsed && !parsed.ok ? parsed.message : null;
  const label = t('taskRows.field.editLabel', { field: field.name });

  useEffect(() => {
    if (!open || !focusOnOpenRef.current) return;
    focusOnOpenRef.current = false;
    panelRef.current?.querySelector<HTMLElement>('textarea, input, button')?.focus();
  }, [open]);

  // Own Escape before Radix's document-capture listener can close the enclosing drawer.
  // An expanded nested picker keeps first refusal and closes only its own list.
  useEffect(() => {
    if (!open) return undefined;
    const panel = panelRef.current;
    const view = panel?.ownerDocument.defaultView ?? window;
    const onEscape = (event: globalThis.KeyboardEvent) => {
      if (event.key !== 'Escape' || event.isComposing || event.defaultPrevented || !(event.target instanceof Node) || !panel?.contains(event.target)) return;
      if (panel.querySelector('[role="combobox"][aria-expanded="true"]')) return;
      event.preventDefault();
      event.stopPropagation();
      setOpen(false);
      triggerRef.current?.focus();
    };
    view.addEventListener('keydown', onEscape, true);
    return () => view.removeEventListener('keydown', onEscape, true);
  }, [open]);

  const close = () => {
    setOpen(false);
    triggerRef.current?.focus();
  };
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    // A nested picker handles its own Escape first and closes only its menu.
    if (event.key !== 'Escape' || event.defaultPrevented) return;
    event.preventDefault();
    event.stopPropagation();
    close();
  };

  let summary: ReactNode;
  if (!entry) {
    summary = (
      <span title={t('taskRows.field.notStaged')} className="text-muted">
        <span aria-hidden="true">—</span>
        <span className="sr-only">{t('taskRows.field.notStaged')}</span>
      </span>
    );
  } else if (parsed?.ok) {
    summary = (
      <>
        <span className="min-w-0 flex-1 truncate">
          <FieldValueDisplay field={entry.field} value={parsed.value} members={members} compact />
        </span>
        <span aria-hidden="true" className="size-1.5 shrink-0 rounded-full bg-accent" />
        <span className="sr-only">{t('taskRows.field.staged')}</span>
      </>
    );
  } else {
    summary = <span className="min-w-0 flex-1 truncate text-red-700">{rawDraftText(entry.draft) ?? error}</span>;
  }

  return (
    <div ref={setAnchor} className="flex h-full min-w-0 items-center">
      <button
        ref={triggerRef}
        type="button"
        className={cn(
          'flex h-9 w-full min-w-0 items-center gap-1.5 rounded px-1.5 text-left text-sm sm:h-7',
          'hover:bg-canvas focus-visible:outline-2 focus-visible:outline-accent disabled:opacity-60',
          error ? 'ring-1 ring-red-300' : null,
        )}
        aria-label={label}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        aria-describedby={error ? errorId : undefined}
        disabled={disabled}
        onClick={() => {
          if (open) {
            close();
            return;
          }
          focusOnOpenRef.current = true;
          setOpen(true);
        }}
      >
        {summary}
      </button>
      {error ? (
        <span id={errorId} className="sr-only">
          {error}
        </span>
      ) : null}
      {open ? (
        <CellPopover anchor={anchor} id={panelId} role="dialog" ariaLabel={label} className="w-72 p-3 text-sm">
          <div ref={panelRef} className="space-y-3" onKeyDown={onKeyDown}>
            <FieldInput
              field={editField}
              draft={entry?.draft ?? clearedFieldDraft(editField)}
              members={members}
              disabled={disabled}
              error={error}
              onChange={(next) => onChange(stageInitialField(draft, editField, next))}
            />
            <p className="text-xs text-muted">{entry ? t('taskRows.field.stagedHint') : t('taskRows.field.unstagedHint')}</p>
            <div className="flex justify-end gap-2">
              <Button
                variant="ghost"
                size="sm"
                disabled={disabled || !entry}
                onClick={() => onChange(unstageInitialField(draft, field.id))}
              >
                {t('taskRows.field.leaveUnset')}
              </Button>
              <Button size="sm" onClick={close}>
                {t('taskRows.field.done')}
              </Button>
            </div>
          </div>
        </CellPopover>
      ) : null}
    </div>
  );
}

export interface InitialTaskTimeCellProps {
  kind: InitialHoursKind;
  draft: InitialTaskCellsDraft;
  onChange: (draft: InitialTaskCellsDraft) => void;
  /** The explicitly selected week and person, or `null`. Never a fallback. */
  context: InitialTimeContext | null;
  /**
   * A subtask in its parent's package: planned hours set the parent package total, and only when
   * the context carries the loaded parent commitment.
   */
  sharesParentPackage?: boolean | undefined;
  disabled?: boolean | undefined;
}

/** Weekly planned or actual hours of the unsaved row, typed in place and kept as raw text. */
export function InitialTaskTimeCell({
  kind,
  draft,
  onChange,
  context,
  sharesParentPackage = false,
  disabled = false,
}: InitialTaskTimeCellProps) {
  const { t } = useTranslation();
  const id = useId();
  const notesId = `${id}-notes`;
  const hours = draft.time[kind];
  const captured = draft.time.context;
  const blank = hours.raw.trim() === '';
  const shared = kind === 'planned' && sharesParentPackage;
  const target = captured ?? context;
  // Without the loaded parent commitment a shared plan could overwrite it unseen, so it stays blocked.
  const sharedBlocked = shared && target?.plan === undefined;

  // Typed hours stay visible below so they can still be cleared; otherwise nothing is offered.
  if (sharedBlocked && blank) {
    return (
      <span className="block truncate text-xs text-muted" title={t('taskRows.time.sharesParentPackage')}>
        {t('taskRows.time.sharesParentPackage')}
      </span>
    );
  }
  if (target === null) {
    return (
      <span className="block truncate text-xs text-muted" title={t('taskRows.time.chooseContext')}>
        {t('taskRows.time.chooseContext')}
      </span>
    );
  }

  const parsed = parseInitialHours(hours.raw);
  const error = !parsed.ok ? parsed.message : sharedBlocked ? t('taskRows.time.sharedPackagePlan') : null;
  const review =
    captured !== null && !sameTimeContext(captured, context)
      ? t('taskRows.time.contextChanged', { period: captured.periodName, member: captured.memberName })
      : null;
  const packageTotal = shared && !sharedBlocked ? t('taskRows.time.sharedPackageTotal') : null;
  const notes = [
    ...(error ? [{ key: 'error', text: error, className: 'text-red-700' }] : []),
    ...(packageTotal ? [{ key: 'total', text: packageTotal, className: 'text-amber-800' }] : []),
    ...(review ? [{ key: 'review', text: review, className: 'text-amber-800' }] : []),
  ];
  const labelParams = { period: target.periodName, member: target.memberName };
  const label =
    kind === 'fact'
      ? t('taskRows.time.factLabel', labelParams)
      : shared
        ? t('taskRows.time.parentPlannedLabel', labelParams)
        : t('taskRows.time.plannedLabel', labelParams);

  return (
    <div className="flex min-w-0 items-center gap-1.5">
      <input
        type="text"
        inputMode="decimal"
        autoComplete="off"
        className={inputClassName('h-8 w-20 shrink-0 px-2 text-sm')}
        value={hours.raw}
        aria-label={label}
        aria-invalid={error ? true : undefined}
        aria-describedby={notes.length > 0 ? notesId : undefined}
        disabled={disabled}
        onChange={(event) => onChange(setInitialHours(draft, kind, event.target.value, context))}
      />
      {notes.length > 0 ? (
        <p id={notesId} className="min-w-0 flex-1 text-[11px] leading-[14px]">
          {notes.map((note) => (
            <span key={note.key} className={cn('block truncate', note.className)} title={note.text}>
              {note.text}
            </span>
          ))}
        </p>
      ) : null}
    </div>
  );
}
