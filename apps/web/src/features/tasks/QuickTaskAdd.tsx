import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import type { MembershipDto, SectionDto, TagDto, TaskDto, TaskFieldDefinitionDto, TaskStatusDto } from '@workloom/contracts';
import { Button, cn } from '@workloom/ui';
import { Expand, X } from 'lucide-react';
import { useCallback, useEffect, useId, useMemo, useRef, useState, type FocusEvent, type FormEvent, type KeyboardEvent, type ReactNode } from 'react';
import { useTranslation } from '../../i18n';
import { useUnsavedChangesWarning } from '../../lib/useUnsavedChangesWarning';
import { SaveFeedback } from '../../shared/SaveFeedback';
// Direct module imports, as in InitialTaskCells: the fields index pulls in queries.
import { FieldValueDisplay } from '../fields/FieldValueDisplay';
import { parseFieldDraft } from '../fields/valueDraft';
import { CellPopover } from './CellPopover';
import {
  emptyInitialTaskCellsDraft, hasInitialTaskCells, InitialCustomFieldCell, InitialTaskTimeCell, validateInitialTaskCells,
  type InitialHoursKind, type InitialTaskCellsDraft, type InitialTaskCellsIssue, type InitialTimeContext,
} from './InitialTaskCells';
import { renderTaskDraftCell, taskDraftPreviewText, type TaskDraftCellContext } from './TaskDraftCells';
import type { TaskLookups } from './TaskFields';
import { buildCreateInput, buildInitialCreateExtras, inheritsEstimate, taskDraftIssue, TASK_TITLE_MAX, type InitialCreateExtras, type TaskDraft, type TaskDraftErrors } from './taskDraft';
import { canResumeQuickSession, defaultTaskStatusId, freshQuickSession, nextQuickRequest, quickCreateOptions, quickSessionHasValues } from './tableEditing';
import { canTransferQuickSession, unresolvedTaskCommand, type CreateRequest, type CreateSession, type TaskCommands } from './useTaskCommands';

/** `cancel` (Escape/Collapse/Discard) may return focus to the add row; `blur` leaves focus where it went. */
export type QuickAddCloseReason = 'cancel' | 'blur';

/** Renders one table row with the table's own cells; `renderCell` fills a column by its ID. */
export type QuickTaskRowRenderer = (renderCell: (columnId: string) => ReactNode) => ReactNode;

export interface QuickTaskAddProps {
  projectId: string;
  sectionId: string | null;
  sectionName: string;
  statuses: readonly TaskStatusDto[];
  commands: TaskCommands;
  writable: boolean;
  onClose: (reason?: QuickAddCloseReason) => void;
  onMoreDetails: () => void;
  onCreated: (task: TaskDto) => void;
  /** Parent and insertion point of the row; absent for the section's bottom add row. */
  request?: CreateRequest | undefined;
  members?: readonly MembershipDto[] | undefined;
  tags?: readonly TagDto[] | undefined;
  sections?: readonly SectionDto[] | undefined;
  /** A full table row; without it only the title form is rendered. */
  renderRow?: QuickTaskRowRenderer | undefined;
  /** Custom field definitions whose columns (keyed by field ID) stage a value for the new task. */
  initialFields?: readonly TaskFieldDefinitionDto[] | undefined;
  /**
   * The explicitly displayed week and person of the time columns, or null. Never a fallback such
   * as the current person or week. Captured on the first typed hours; later changes never retarget.
   */
  initialTimeContext?: InitialTimeContext | null | undefined;
  /** The person may write hours for that context; without it typed hours stay for review only. */
  initialTimeWritable?: boolean | undefined;
  /** The time projection behind the context is loaded and current. */
  initialTimeCurrent?: boolean | undefined;
  /**
   * The details form takes over staged custom values and hours. Without it a row holding them
   * keeps its whole draft instead of opening details without them.
   */
  detailsKeepInitialCells?: boolean | undefined;
}

/** Time columns of the table and the staged hours each one edits. */
const timeColumns: ReadonlyMap<string, InitialHoursKind> = new Map([['weekly-plan', 'planned'], ['weekly-fact', 'fact']]);
const typedHours = (cells: InitialTaskCellsDraft) => cells.time.planned.raw.trim() !== '' || cells.time.fact.raw.trim() !== '';

const iconActionClassName = cn('inline-flex size-7 shrink-0 items-center justify-center text-muted hover:bg-canvas hover:text-ink disabled:opacity-50', 'rounded');
const menuItemClassName = 'flex h-8 cursor-default select-none items-center rounded px-2 outline-none data-[highlighted]:bg-canvas data-[disabled]:text-subtle';
const noMembers: readonly MembershipDto[] = [];
const noTags: readonly TagDto[] = [];
const noSections: readonly SectionDto[] = [];

function useTaskLookups(statuses: readonly TaskStatusDto[], members = noMembers, tags = noTags, sections = noSections): TaskLookups {
  return useMemo(() => ({ statuses, members, sections, tags: new Map(tags.map(tag => [tag.id, tag])) }), [statuses, members, tags, sections]);
}

/**
 * One title-first table row. Enter creates through the existing command and keeps the same
 * focused row for the next task; no row is added until the command confirms it; Escape discards
 * the unsent draft. With `renderRow` the row looks like any task row: the other built-in cells
 * edit the same local draft and send nothing themselves, and the less common actions live in a
 * context menu (Shift+F10, the menu key or a right click) instead of a toolbar.
 */
export function QuickTaskAdd(props: QuickTaskAddProps) {
  const { t } = useTranslation();
  const { projectId, sectionId, sectionName, statuses, commands, writable, onClose, onMoreDetails, onCreated, request, renderRow } = props;
  const fullRow = renderRow !== undefined;
  const lookups = useTaskLookups(statuses, props.members, props.tags, props.sections);
  const statusId = defaultTaskStatusId(statuses);
  const [foreignDraft] = useState(() => commands.createSession.current !== null && !canResumeQuickSession(commands.createSession.current, sectionId, request, fullRow));
  const [session, setSession] = useState<CreateSession | null>(() => {
    // A submitted session belongs to the queue; editing it again here would send it twice.
    const resumable = (candidate: CreateSession | null) => candidate !== null && !commands.quick.queue.some(entry => entry.session === candidate) && canResumeQuickSession(candidate, sectionId, request, fullRow);
    const { draft } = commands.quick;
    const kept = commands.createSession.current;
    return resumable(draft) ? draft : resumable(kept) ? kept : statusId ? freshQuickSession(sectionId, statusId, request) : null;
  });
  const [errors, setErrors] = useState<TaskDraftErrors>({});
  const [initialIssues, setInitialIssues] = useState<readonly InitialTaskCellsIssue[]>([]);
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const attach = useCallback((node: HTMLElement | null) => setAnchor(node), []);
  const titleRef = useRef<HTMLInputElement>(null);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  // The session this row last handed to details; the same one is never handed over twice.
  const handedOff = useRef<CreateSession | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  // From opening the actions menu until its close has placed focus; leaving the row waits for it.
  const menuActive = useRef(false);
  // Closing the menu returns focus to the title, except after details, a discard or a click elsewhere.
  const menuReturnsFocus = useRef(true);
  const id = useId();
  const unresolved = unresolvedTaskCommand(commands);
  // A task save that is merely being sent only delays queued creates; an unknown outcome needs the person.
  const blockedUnknown = unresolved !== null && unresolved.taskId !== null && unresolved.uncertain;
  const pending = commands.create.pendingCommand !== null;
  const uncertain = commands.create.uncertain !== null;
  // Submitted titles live in the page-owned queue; this is always the next unsent input.
  const frozen = !writable;
  const dirty = session !== null && quickSessionHasValues(session);
  useUnsavedChangesWarning(dirty || uncertain);
  useEffect(() => {
    // A session handed to details belongs to them; this row does not take it back.
    if (!foreignDraft && session && handedOff.current !== session && commands.quick.draft !== session) commands.setQuickDraft(session);
  }, [commands, foreignDraft, session]);
  const issues = Object.entries(errors);
  const hasFeedback = issues.length > 0 || initialIssues.length > 0 || blockedUnknown || commands.create.error !== null || uncertain;
  // Leaving an untouched row closes it, like an unused Asana add row; typed drafts and titles
  // still waiting to be sent stay put.
  const leave = useRef<() => void>(() => undefined);
  leave.current = () => { if (!dirty && !pending && !uncertain && !hasFeedback && commands.quick.queue.length === 0) onClose('blur'); };
  // A staged field editor opens in a portalled panel that its trigger in this row controls.
  const controlledByRow = (node: Element) => [...document.querySelectorAll('[aria-controls]')].some(trigger =>
    trigger.closest('[data-quick-draft]')?.getAttribute('data-quick-draft') === id && document.getElementById(trigger.getAttribute('aria-controls') ?? '')?.contains(node) === true);
  // The row spans several cells and portalled lists; focus inside any of them stays in the row.
  const inside = (node: unknown) => node instanceof Element && (node.closest('[data-quick-draft]')?.getAttribute('data-quick-draft') === id || node.closest('[data-choice-picker-menu]') !== null || controlledByRow(node));
  // Checked once focus settles, so moves into the row's own lists or menu never close it.
  const checkLeft = (row: Element | null) => window.setTimeout(() => {
    if (!mounted.current || menuActive.current || !row?.isConnected || inside(document.activeElement)) return;
    leave.current();
  }, 0);
  const leaveRow = (event: FocusEvent<HTMLElement>) => { if (!inside(event.relatedTarget)) checkLeft(event.currentTarget); };
  // An explicit cancel drops this row's never-sent draft, title and staged extras alike, in every
  // row, so reopening any row shows nothing of it. Queued, sending or unknown creates always stay,
  // and a foreign draft shown only as a stub is never this row's to drop.
  const cancel = () => {
    if (!foreignDraft && session && commands.cancelQuickDraft(session)) {
      setSession(statusId ? freshQuickSession(sectionId, statusId, session.request) : null);
      setErrors({});
      setInitialIssues([]);
    }
    onClose('cancel');
  };
  // Own the row's Escape before the enclosing Radix drawer's document-capture handler.
  // Portalled cell editors and menus own their own Escape; their targets are outside this row.
  const cancelHead = useRef(cancel);
  cancelHead.current = cancel;
  useEffect(() => {
    if (!fullRow) return;
    const escapeRow = (event: globalThis.KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented || event.isComposing || menuActive.current || !(event.target instanceof Element)) return;
      const owner = event.target.closest('[data-quick-draft]');
      if (owner?.getAttribute('data-quick-draft') !== id || owner.querySelector('[role="combobox"][aria-expanded="true"]')) return;
      event.preventDefault();
      event.stopPropagation();
      cancelHead.current();
    };
    window.addEventListener('keydown', escapeRow, true);
    return () => window.removeEventListener('keydown', escapeRow, true);
  }, [fullRow, id]);
  // A nested list or menu that already handled Escape keeps the row.
  const escape = (event: KeyboardEvent) => { if (event.key === 'Escape' && !event.defaultPrevented) { event.preventDefault(); event.stopPropagation(); cancel(); } };
  const titleOnly = (node: ReactNode) => renderRow ? <>{renderRow(columnId => columnId === 'title' ? node : null)}</> : node;
  const keepsInitialCells = props.detailsKeepInitialCells === true;
  // Details continue the foreign draft itself, or this row's live session.
  const detailsTarget = foreignDraft ? commands.createSession.current : session;
  const canOpenDetails = detailsTarget !== null && handedOff.current !== detailsTarget && canTransferQuickSession(commands, detailsTarget, keepsInitialCells);
  const detailsBlocked = detailsTarget === null || canOpenDetails || handedOff.current === detailsTarget ? null
    : canTransferQuickSession(commands, detailsTarget, true) ? t('taskRows.quickRow.detailsKeepExtras') : t('taskRows.quickRow.detailsBlocked');
  // The one way into details, for the foreign draft's Resume, the title-only button and the row menu.
  // Checked again at the moment of use; a refusal changes and clears nothing.
  const openDetails = () => {
    const target = foreignDraft ? commands.createSession.current : session;
    if (target === null || handedOff.current === target || !canTransferQuickSession(commands, target, keepsInitialCells)) return;
    handedOff.current = target;
    menuReturnsFocus.current = false;
    // The live session is captured before the row lets it go; an untouched row opens empty
    // details. A foreign draft already is the retained session and stays exactly as it is.
    if (!foreignDraft) {
      commands.createSession.current = quickSessionHasValues(target) ? target : null;
      commands.releaseQuickDraft();
    }
    onMoreDetails();
  };

  if (foreignDraft) return titleOnly(<div ref={attach} onKeyDown={escape} className="flex h-8 min-w-0 flex-1 items-center gap-2 text-sm">
    <span id={`${id}-details`} className="min-w-0 truncate text-muted" title={detailsBlocked ?? t('tasks.quickAdd.existingDraft')}>{detailsBlocked ?? t('tasks.quickAdd.existingDraft')}</span>
    {/* Stays focusable while refused; recovery of a queued or unknown create stays on the page. */}
    <Button autoFocus size="sm" className="h-7 px-2" aria-disabled={!canOpenDetails || undefined} aria-describedby={`${id}-details`} onClick={openDetails}>{t('tasks.quickAdd.resumeDraft')}</Button>
    <Button size="sm" className="h-7 px-2" variant="ghost" onClick={() => onClose('cancel')}>{t('tasks.quickAdd.collapse')}</Button>
  </div>);
  if (!session || !statusId) return titleOnly(<p className="flex h-8 min-w-0 items-center truncate text-sm text-muted">{t('tasks.quickAdd.noStatus')}</p>);
  const { draft } = session;
  const sharesParentPackage = inheritsEstimate(quickCreateOptions(session));
  const timeContext = props.initialTimeContext ?? null;
  const timeEditable = props.initialTimeWritable === true && props.initialTimeCurrent === true;
  const change = (patch: Partial<TaskDraft>) => {
    const next = { ...session, draft: { ...session.draft, ...patch } };
    commands.setQuickDraft(next);
    setSession(next);
    setErrors({});
    setInitialIssues([]);
  };
  // Extras replace only this unsent session's staged cells; built-in values stay as they are.
  const changeInitial = (initialCells: InitialTaskCellsDraft) => {
    const next = { ...session, initialCells };
    commands.setQuickDraft(next);
    setSession(next);
    setErrors({});
    setInitialIssues([]);
  };
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (event.target !== event.currentTarget || !writable) return;
    // Every built-in and staged value is checked first; any issue keeps the whole row and sends nothing.
    const result = buildCreateInput(projectId, draft, quickCreateOptions(session));
    const cells = session.initialCells;
    const checked = cells !== undefined && hasInitialTaskCells(cells)
      ? validateInitialTaskCells(cells, { definitions: props.initialFields, currentContext: props.initialTimeContext, sharesParentPackage })
      : null;
    const cellIssues = checked !== null && !checked.ok ? checked.issues : [];
    const nextErrors: TaskDraftErrors = result.ok ? {} : { ...result.errors };
    // Hours typed before the person lost time rights stay for review but are not sent.
    if (cells !== undefined && typedHours(cells) && props.initialTimeWritable !== true) nextErrors.form ??= taskDraftIssue('tasks.taskDraft.checkTheCompletedFields');
    let initial: InitialCreateExtras | undefined;
    if (result.ok && checked?.ok === true) {
      const extras = buildInitialCreateExtras(result.input, checked.data, sharesParentPackage);
      if (extras.ok) initial = extras.input;
      else Object.assign(nextErrors, extras.errors);
    }
    if (!result.ok || cellIssues.length > 0 || Object.keys(nextErrors).length > 0) { setErrors(nextErrors); setInitialIssues(cellIssues); return; }
    // Clear only the submitted input, synchronously, before its ACK. A later confirmation
    // never edits this next buffer or restores focus after the person moves elsewhere.
    // A continuing row's next task follows the one just queued, whatever ID it gets.
    const next = commands.enqueueQuickCreate(session, result.input, resultAnchor => freshQuickSession(sectionId, statusId, nextQuickRequest(session.request, resultAnchor)), onCreated, initial);
    setSession(next);
    setErrors({});
    setInitialIssues([]);
  };
  const initialIssueName = (issue: InitialTaskCellsIssue) => issue.kind === 'field'
    ? props.initialFields?.find(field => field.id === issue.fieldId)?.name ?? session.initialCells?.fields[issue.fieldId]?.field.name ?? null
    : null;
  const describedBy = [`${id}-hint`, `${id}-keys`, ...issues.map(([field]) => `${id}-${field}`), ...initialIssues.map((_, index) => `${id}-initial-${index}`)].join(' ');
  const openMenu = () => { menuActive.current = true; menuReturnsFocus.current = true; setMenuOpen(true); };
  // Keys and right clicks from the portalled menu reach this form through React; the menu owns them.
  const fromRow = (event: { currentTarget: Element; target: EventTarget }) => event.target instanceof Node && event.currentTarget.contains(event.target);
  // The full row's less common actions: one Radix menu at the title, no toolbar in the grid.
  const actionsMenu = <DropdownMenu.Root open={menuOpen} onOpenChange={setMenuOpen} modal={false}>
    <DropdownMenu.Trigger asChild><span aria-hidden="true" className="size-0 shrink-0 self-end" /></DropdownMenu.Trigger>
    {/* Inside a modal drawer the menu must live in the drawer's own top layer. */}
    <DropdownMenu.Portal container={anchor?.closest('dialog') ?? null}>
      <DropdownMenu.Content align="end" sideOffset={4} aria-labelledby={undefined} aria-label={t('taskRows.quickRow.actions')}
        onInteractOutside={() => { menuReturnsFocus.current = false; menuActive.current = false; checkLeft(anchor); }}
        onCloseAutoFocus={event => {
          // Focus goes back to the same title input, never into a drawer details just opened.
          event.preventDefault();
          menuActive.current = false;
          if (menuReturnsFocus.current && mounted.current) titleRef.current?.focus({ preventScroll: true });
        }}
        className="z-50 min-w-48 max-w-72 rounded-md border border-line bg-surface p-1 text-sm text-ink shadow-lg">
        <DropdownMenu.Item className={menuItemClassName} disabled={frozen || draft.title.trim() === ''} onSelect={() => { if (anchor instanceof HTMLFormElement) anchor.requestSubmit(); }}>{t('taskRows.quickRow.addNext')}</DropdownMenu.Item>
        <DropdownMenu.Item className={menuItemClassName} disabled={!canOpenDetails} onSelect={openDetails}>{t('taskRows.quickRow.moreDetails')}</DropdownMenu.Item>
        {detailsBlocked !== null ? <DropdownMenu.Label className="px-2 py-1 text-xs text-muted">{detailsBlocked}</DropdownMenu.Label> : null}
        <DropdownMenu.Separator className="my-1 h-px bg-line" />
        <DropdownMenu.Item className={menuItemClassName} onSelect={() => { menuReturnsFocus.current = false; cancel(); }}>{t('taskRows.quickRow.discard')}</DropdownMenu.Item>
      </DropdownMenu.Content>
    </DropdownMenu.Portal>
  </DropdownMenu.Root>;
  const titleCell = <form ref={attach} data-quick-draft={id} noValidate aria-label={t('tasks.quickAdd.form', { section: sectionName })} aria-busy={pending || undefined} onSubmit={submit}
    onContextMenu={fullRow ? event => { if (!fromRow(event)) return; event.preventDefault(); openMenu(); } : undefined}
    onKeyDown={event => {
      if (!fromRow(event)) return;
      if (event.key === 'Escape') { if (event.defaultPrevented) return; event.preventDefault(); event.stopPropagation(); cancel(); return; }
      if (fullRow && (event.key === 'ContextMenu' || (event.key === 'F10' && event.shiftKey))) { event.preventDefault(); openMenu(); return; }
      if (event.key !== 'Enter' || event.target !== titleRef.current) return;
      if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
      event.preventDefault();
      if (frozen || event.altKey || event.shiftKey) return;
      // Enter on a blank row creates nothing and keeps the row focused for typing.
      if (draft.title.trim() === '') return;
      event.currentTarget.requestSubmit();
    }}
    onBlur={leaveRow}
    className="flex h-8 min-w-0 flex-1 items-center gap-1">
    {/* The full row shows the ordinary, inactive completion circle of a task row. */}
    {fullRow
      ? <span aria-hidden="true" className="inline-flex size-7 shrink-0 items-center justify-center"><span className="size-[18px] rounded-full border border-line-strong" /></span>
      : <span aria-hidden="true" className="mr-1 inline-flex size-4 shrink-0 rounded-full border border-dashed border-line-strong" />}
    <input ref={titleRef} autoFocus aria-label={t('tasks.taskFields.taskName')} aria-invalid={Boolean(errors.title) || undefined} aria-describedby={describedBy}
      placeholder={t('tasks.quickAdd.titlePlaceholder')} autoComplete="off" maxLength={TASK_TITLE_MAX} readOnly={frozen} aria-disabled={frozen || undefined}
      value={draft.title} onChange={event => change({ title: event.target.value })}
      className={fullRow
        ? 'block h-8 w-full min-w-0 flex-1 rounded bg-transparent px-1 text-sm text-ink outline-none placeholder:text-subtle focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent-soft read-only:text-muted aria-[invalid=true]:ring-2 aria-[invalid=true]:ring-inset aria-[invalid=true]:ring-red-300'
        : 'block h-8 w-full min-w-0 flex-1 rounded border border-accent-line bg-surface px-2 text-sm text-ink outline-none ring-2 ring-accent-soft placeholder:text-subtle read-only:bg-canvas read-only:text-muted aria-[invalid=true]:border-red-300'} />
    <span id={`${id}-hint`} className="sr-only">{t('tasks.quickAdd.keyboardHintNext')}</span>
    <span id={`${id}-keys`} className="sr-only">{t(fullRow ? 'taskRows.quickRow.keysHint' : 'taskRows.quickRow.escapeHint')}</span>
    {fullRow ? null : <Button size="sm" variant="primary" type="submit" className="h-7 px-2" aria-disabled={!writable || undefined}>{t('tasks.quickAdd.add')}</Button>}
    {pending ? <span role="status" className="sr-only">{t('tasks.quickAdd.creating')}</span> : null}
    {commands.quick.paused ? <Button size="sm" type="button" className="h-7 px-2" onClick={commands.retryQuickCreate}>{t('tasks.quickAdd.retry')}</Button> : null}
    {fullRow ? actionsMenu : <>
      <button type="button" className={iconActionClassName} title={t('tasks.quickAdd.moreDetails')} aria-label={t('tasks.quickAdd.moreDetails')} disabled={!canOpenDetails} onClick={openDetails}><Expand size={14} aria-hidden="true" /></button>
      <button type="button" className={iconActionClassName} title={t('tasks.quickAdd.collapse')} aria-label={t('tasks.quickAdd.collapse')} onClick={cancel}><X size={14} aria-hidden="true" /></button>
    </>}
    {hasFeedback ? <CellPopover anchor={anchor}>
      {commands.quick.queue[0] ? <p className="break-words font-medium">{t('tasks.quickAdd.submittedTitle', { title: commands.quick.queue[0].session.draft.title })}</p> : null}
      {commands.quick.paused && !uncertain ? <Button size="sm" variant="ghost" onClick={commands.discardRejectedQuickCreate}>{t('tasks.quickAdd.discardRejected')}</Button> : null}
      {issues.map(([field, issue]) => <p role="alert" id={`${id}-${field}`} key={field} className="text-red-700">{t(issue.key, issue.params)}</p>)}
      {initialIssues.map((issue, index) => {
        const name = initialIssueName(issue);
        return <p role="alert" id={`${id}-initial-${index}`} key={issue.kind === 'field' ? `field-${issue.fieldId}` : `hours-${issue.hours}`} className="break-words text-red-700">
          {name !== null ? <span className="font-medium">{name} </span> : null}{issue.message}
        </p>;
      })}
      {blockedUnknown ? <p role="status" className="text-amber-800">{t('tasks.quickAdd.otherCommand')}</p> : null}
      <SaveFeedback subject="taskSave" error={commands.create.error} uncertainError={commands.create.uncertain?.error ?? null} />
    </CellPopover> : null}
  </form>;
  if (!renderRow) return titleCell;
  const context: TaskDraftCellContext = {
    draft, onChange: change, lookups, disabled: frozen, errors, errorId: field => `${id}-${field}`,
    inheritsEstimate: sharesParentPackage, rowKey: id,
  };
  const staged = session.initialCells ?? emptyInitialTaskCellsDraft();
  // Columns without a built-in draft value: a staged custom field or weekly hours, else nothing.
  const renderInitialCell = (columnId: string): ReactNode => {
    const kind = timeColumns.get(columnId);
    if (kind !== undefined) {
      // Without a time source the column stays empty; typed hours stay visible for review.
      if (props.initialTimeContext === undefined && !typedHours(staged)) return null;
      return <InitialTaskTimeCell kind={kind} draft={staged} onChange={changeInitial} context={timeContext} sharesParentPackage={sharesParentPackage} disabled={frozen || props.initialTimeWritable !== true || (!timeEditable && !typedHours(staged))} />;
    }
    const field = props.initialFields?.find(candidate => candidate.id === columnId) ?? (Object.hasOwn(staged.fields, columnId) ? staged.fields[columnId]?.field : undefined);
    return field ? <InitialCustomFieldCell field={field} draft={staged} onChange={changeInitial} members={props.members ?? noMembers} disabled={frozen} /> : null;
  };
  return <>{renderRow(columnId => {
    if (columnId === 'title') return titleCell;
    const content = renderTaskDraftCell(columnId, context) ?? renderInitialCell(columnId);
    return content === null ? null : <div data-quick-draft={id} onKeyDown={escape} onBlur={leaveRow} className="flex h-8 min-w-0 items-center">{content}</div>;
  })}</>;
}

/** The frozen display of a submitted row's staged extras; nothing here edits or confirms them. */
function initialPreview(columnId: string, cells: InitialTaskCellsDraft | undefined, members: readonly MembershipDto[]): ReactNode {
  if (!cells) return null;
  const kind = timeColumns.get(columnId);
  if (kind !== undefined) {
    const raw = cells.time[kind].raw.trim();
    return raw === '' ? null : <span className="block truncate px-2 text-sm text-muted" title={raw}>{raw}</span>;
  }
  const entry = Object.hasOwn(cells.fields, columnId) ? cells.fields[columnId] : undefined;
  if (!entry) return null;
  const parsed = parseFieldDraft(entry.field, entry.draft);
  return parsed.ok ? <span className="block truncate px-2 text-sm text-muted"><FieldValueDisplay field={entry.field} value={parsed.value} members={members} compact /></span> : null;
}

export interface QuickTaskDraftPreviewProps {
  session: CreateSession;
  renderRow: QuickTaskRowRenderer;
  pending?: boolean | undefined;
  uncertain?: boolean | undefined;
  statuses?: readonly TaskStatusDto[] | undefined;
  members?: readonly MembershipDto[] | undefined;
  tags?: readonly TagDto[] | undefined;
  sections?: readonly SectionDto[] | undefined;
}

const noStatuses: readonly TaskStatusDto[] = [];

/**
 * A submitted, not yet confirmed create in its table row: the values as submitted, shown only.
 * It has no task ID, link or control, so nothing can be written from it; recovery stays in the
 * live add row.
 */
export function QuickTaskDraftPreview({ session, renderRow, pending = false, uncertain = false, statuses = noStatuses, members, tags, sections }: QuickTaskDraftPreviewProps) {
  const lookups = useTaskLookups(statuses, members, tags, sections);
  const inherits = inheritsEstimate(quickCreateOptions(session));
  const title = <div aria-busy={pending || undefined} data-quick-preview={session.clientId} className={cn('flex h-8 min-w-0 items-center gap-2 px-2 text-sm text-muted', uncertain && 'text-amber-800')}>
    <span aria-hidden="true" className="inline-flex size-4 shrink-0 rounded-full border border-dashed border-line-strong" />
    <span className="min-w-0 truncate" title={session.draft.title.trim()}>{session.draft.title.trim()}</span>
  </div>;
  return <>{renderRow(columnId => {
    if (columnId === 'title') return title;
    const text = taskDraftPreviewText(columnId, session.draft, lookups, inherits);
    return text === null ? initialPreview(columnId, session.initialCells, lookups.members) : <span className="block truncate px-2 text-sm text-muted" title={text}>{text}</span>;
  })}</>;
}
