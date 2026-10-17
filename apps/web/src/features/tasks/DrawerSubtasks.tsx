import type { MembershipDto, SectionDto, TagDto, TaskDto, TaskFieldDefinitionDto, TaskStatusDto } from '@workloom/contracts';
import { Badge, Button, cn } from '@workloom/ui';
import { GripVertical, Plus } from 'lucide-react';
import { Fragment, useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react';
import { formatDate, message, useTranslation, type TranslationMessage } from '../../i18n';
import { SaveFeedback } from '../../shared/SaveFeedback';
import { formatEstimate } from '../task-table/estimate';
import type { TaskDropPlacement, TaskTableCustomColumn, TaskTableDraftRow, TaskTableDraftRowState } from '../task-table/TaskTable';
import { TaskDragPreview } from '../task-table/TaskDragPreview';
import { usePointerRowDrag, usePointerRowDragProtection } from '../task-table/usePointerRowDrag';
import { summarizeWorkPackages } from '../task-table/workPackages';
import type { InitialTimeContext } from './InitialTaskCells';
import { InlineTaskEdit, type InlineCloseReason } from './InlineTaskEdit';
import { QuickTaskAdd, QuickTaskDraftPreview, type QuickAddCloseReason } from './QuickTaskAdd';
import { canEditTaskInline } from './tableEditing';
import { TaskCompletionAction } from './TaskCompletionAction';
import { TaskCompletionFeedback } from './TaskCompletionFeedback';
import type { LoadedSubtasks } from './TaskDrawer';
import { unresolvedTaskCommand, type CreateRequest, type TaskCommands } from './useTaskCommands';
import { useTaskCompletion } from './useTaskCompletion';

/** Every built-in column a new subtask row fills, in table order. */
const COLUMNS = ['title', 'status', 'responsible', 'participants', 'startDate', 'dueDate', 'priority', 'tags', 'estimate'] as const;
type BuiltinColumn = (typeof COLUMNS)[number];
const WIDTHS: Record<BuiltinColumn, number> = { title: 280, status: 112, responsible: 136, participants: 88, startDate: 96, dueDate: 96, priority: 88, tags: 112, estimate: 88 };
/** One fixed single-line height for saved and new rows alike: content truncates, never wraps. */
const cellClassName = 'h-[41px] max-h-[41px] overflow-hidden whitespace-nowrap px-1.5 py-0 align-middle text-sm text-ink-soft';
const noColumns: readonly TaskTableCustomColumn[] = [];

/**
 * A row created with no sibling to follow: the first body keeps the legacy parent create, and each
 * next row of the same input follows the previous confirmed one. Read by the create queue.
 */
type FirstChildRequest = CreateRequest & { continueInPlace?: true };

/** Sibling creates continued from one subtask (or appended by the explicit add row). */
interface SubtaskChain {
  /** Null: the rows close the list. */
  anchorTaskId: string | null;
  request: CreateRequest;
  open: boolean;
  confirmed: readonly { task: TaskDto; at: number }[];
}

export interface DrawerSubtasksProps {
  parent: TaskDto;
  scope: LoadedSubtasks;
  projectId: string;
  statuses: readonly TaskStatusDto[];
  members: readonly MembershipDto[];
  sections: readonly SectionDto[];
  tags: readonly TagDto[];
  /** Page-owned: the queue, retained drafts and unknown outcomes outlive this drawer. */
  commands: TaskCommands;
  /** The actor may create and edit subtasks of `parent` now. */
  writable: boolean;
  /** Keeps the drawer's own draft before navigating. */
  onOpen: (taskId: string) => void;
  /** Continues the unsent row in the full create form. */
  onMoreDetails: () => void;
  onCreated: (task: TaskDto) => void;
  /** Completion and reorder results; absent, they are shown but not announced. */
  onAnnounce?: ((message: TranslationMessage) => void) | undefined;
  /** Visible custom and weekly columns of the page table, in its order. Saved rows show their cells. */
  extraColumns?: readonly TaskTableCustomColumn[] | undefined;
  /** Staging inputs of a new row, as for the table's quick row. */
  initialFields?: readonly TaskFieldDefinitionDto[] | undefined;
  initialTimeContext?: InitialTimeContext | null | undefined;
  initialTimeWritable?: boolean | undefined;
  initialTimeCurrent?: boolean | undefined;
  /** Each new value opens the inline subtask row, e.g. from the drawer's Add subtask. */
  addRequest?: number | undefined;
}

function calendarText(value: string | null | undefined): string | null {
  if (!value) return null;
  return formatDate(new Date(`${value}T00:00:00Z`), { day: 'numeric', month: 'short', timeZone: 'UTC' });
}

/**
 * Loaded direct subtasks as compact rows of the task table: the name renames in place, the free
 * area to its right opens the subtask, and Enter on a saved or unchanged name continues with a
 * new sibling right after it, through the same page-owned create queue as the table. Completion
 * and same-parent reorder use the page's commands; the refetched list stays the order.
 */
export function DrawerSubtasks({
  parent, scope, projectId, statuses, members, sections, tags, commands, writable, onOpen, onMoreDetails, onCreated, onAnnounce,
  extraColumns = noColumns, initialFields, initialTimeContext, initialTimeWritable, initialTimeCurrent, addRequest,
}: DrawerSubtasksProps) {
  const acquireDragProtection = usePointerRowDragProtection();
  const { t } = useTranslation();
  const headingId = useId();
  const [editing, setEditing] = useState<{ taskId: string; focusClaim: { current: boolean } } | null>(null);
  const [chain, setChain] = useState<SubtaskChain | null>(null);
  // Each submitted row keeps one identity while it waits, so the rows below it never remount.
  const queuedKeys = useRef({ next: 0, keys: new WeakMap<object, string>() });
  const queuedKey = (session: object) => {
    const known = queuedKeys.current.keys.get(session);
    if (known) return known;
    const key = `queued-${++queuedKeys.current.next}`;
    queuedKeys.current.keys.set(session, key);
    return key;
  };
  const packages = useMemo(() => summarizeWorkPackages([parent, ...scope.tasks]).packages, [parent, scope.tasks]);
  const taskById = useMemo(() => new Map(scope.tasks.map(child => [child.id, child])), [scope.tasks]);
  const canCreate = writable && parent.archivedAt === null && parent.meetingId === null;
  const empty = scope.partial ? t('tasks.subtasks.noneLoaded') : scope.includesArchived ? t('tasks.subtasks.none') : t('tasks.subtasks.noneActive');
  const loadedIds = new Set(scope.tasks.map(child => child.id));
  const announce = (next: TranslationMessage) => onAnnounce?.(next);
  // Its own controller keeps focus and announcements with these rows, apart from the table's.
  const completion = useTaskCompletion(commands, { tasks: [parent, ...scope.tasks], statuses, writable, editingTaskId: editing?.taskId ?? null, focusScope: `drawer-subtasks:${parent.id}` }, () => announce(message('tasks.completion.saved')));

  const openAfter = (anchor: TaskDto | null) => {
    if (!canCreate) return;
    setEditing(null);
    const sectionId = anchor?.sectionId ?? parent.sectionId;
    const first: FirstChildRequest = { sectionId, parent, continueInPlace: true };
    setChain({ anchorTaskId: anchor?.id ?? null, open: true, confirmed: [],
      request: anchor ? { sectionId, parent, insertion: { anchorTaskId: anchor.id, placement: 'after' } } : first });
  };
  // The primary add: a retained chain or titles still being sent keep their own row, place and context.
  const openPrimary = () => {
    if (!canCreate) return;
    const held = commands.createSession.current !== null || commands.quick.queue.length > 0 || commands.create.pendingCommand !== null || commands.create.uncertain !== null;
    if (held && chain !== null) { setChain({ ...chain, open: true }); return; }
    openAfter(null);
  };
  const openPrimaryHead = useRef(openPrimary);
  openPrimaryHead.current = openPrimary;
  const seenAddRequest = useRef(addRequest);
  useEffect(() => {
    if (addRequest === undefined || addRequest === seenAddRequest.current) return;
    seenAddRequest.current = addRequest;
    openPrimaryHead.current();
  }, [addRequest]);
  const belongs = (request: CreateRequest, current: SubtaskChain) => request.parent?.id === parent.id && request.sectionId === current.request.sectionId;
  const queued = chain ? commands.quick.queue.filter(entry => belongs(entry.session.request, chain)) : [];
  // A confirmed row stays in place until a list loaded after it arrives, so the input never jumps.
  const retained = chain ? chain.confirmed.filter(entry => !loadedIds.has(entry.task.id) && (scope.fetching === true || (scope.loadedAt ?? 0) < entry.at)) : [];
  const anchorId = chain === null ? null : [chain.anchorTaskId, ...chain.confirmed.map(entry => entry.task.id)].filter((id): id is string => id !== null && loadedIds.has(id)).at(-1) ?? chain.anchorTaskId;
  const focusLater = (selector: string) => requestAnimationFrame(() => {
    if (document.activeElement === null || document.activeElement === document.body) document.querySelector<HTMLElement>(selector)?.focus();
  });

  // Same-parent manual reorder: one guarded move at a time, after every other task command resolved.
  const moveBlocked = !writable || unresolvedTaskCommand(commands) !== null || commands.move.pendingCommand !== null || commands.move.uncertain !== null
    || commands.quick.queue.length > 0 || commands.quick.sending || scope.fetching === true;
  const siblingIndex = (task: TaskDto) => scope.tasks.findIndex(item => item.id === task.id);
  const dropAllowed = (source: TaskDto, anchor: TaskDto, placement: TaskDropPlacement): boolean => {
    if (anchor.id === source.id || anchor.parentTaskId !== source.parentTaskId || anchor.sectionId !== source.sectionId || !canEditTaskInline(anchor)) return false;
    const index = siblingIndex(source);
    if (index < 0) return false;
    // Dropping right next to itself changes nothing and sends nothing.
    return placement === 'after' ? scope.tasks[index - 1]?.id !== anchor.id : scope.tasks[index + 1]?.id !== anchor.id;
  };
  const neighbour = (task: TaskDto, direction: -1 | 1): TaskDto | undefined => {
    const candidate = scope.tasks[siblingIndex(task) + direction];
    return candidate && dropAllowed(task, candidate, direction < 0 ? 'before' : 'after') ? candidate : undefined;
  };
  const moveTask = (task: TaskDto, anchor: TaskDto, placement: TaskDropPlacement) => {
    if (commands.editSessions.current.has(task.id)) { announce(message('taskTable.move.draft', { title: task.title })); return; }
    if (moveBlocked) { announce(message('taskTable.move.wait')); return; }
    if (!dropAllowed(task, anchor, placement)) return;
    setEditing(null);
    announce(message('taskTable.move.moving', { title: task.title }));
    commands.move.mutate({ taskId: task.id, input: { expectedRevision: task.revision, anchorTaskId: anchor.id, placement } }, {
      onSuccess: moved => announce(message('taskTable.move.moved', { title: moved.title })),
    });
  };
  const { drag, startDrag } = usePointerRowDrag({ taskById, dropAllowed, onMove: moveTask, blocked: moveBlocked, acquireProtection: acquireDragProtection });
  // A refused or unknown reorder of one of these rows is resolved here; an unknown one resends exactly.
  const heldMoveTaskId = commands.move.uncertain?.variables.taskId ?? commands.move.variables?.taskId ?? null;
  const moveFeedback = heldMoveTaskId !== null && taskById.has(heldMoveTaskId)
    && (commands.move.uncertain !== null || (commands.move.error !== null && commands.move.pendingCommand === null));

  const columnIds: readonly string[] = [...COLUMNS, ...extraColumns.map(column => column.id)];
  const draftRow = (state: TaskTableDraftRowState): TaskTableDraftRow => renderCell => (
    <tr data-task-draft-row="" data-task-draft-state={state} aria-busy={state === 'pending' || undefined} className={cn('h-[41px] border-t border-line', state !== 'draft' && 'text-muted')}>
      {columnIds.map(id => <td key={id} className={cn(cellClassName, id === 'estimate' && 'text-right')}><div className="flex h-[41px] min-w-0 items-center overflow-hidden">{renderCell(id)}</div></td>)}
    </tr>
  );
  const readRow = (child: TaskDto, readOnly: boolean): ReactNode => {
    const status = statuses.find(item => item.id === child.statusId)?.name ?? t('tasks.taskFields.statusUnavailable');
    const kind = child.workPackageId === parent.workPackageId ? t('tasks.subtasks.detail') : t('tasks.subtasks.additional');
    const editable = !readOnly && writable && canEditTaskInline(child);
    const movable = editable && taskById.has(child.id) && scope.tasks.length > 1;
    const previous = movable ? neighbour(child, -1) : undefined;
    const next = movable ? neighbour(child, 1) : undefined;
    const drop = drag?.target?.taskId === child.id ? drag.target.placement : undefined;
    const responsible = child.responsibleMembershipId === null ? null : members.find(member => member.id === child.responsibleMembershipId)?.displayName ?? t('taskTable.taskTable.memberUnavailable');
    const participants = child.participants.filter(participant => participant.active).length;
    const dash = <span aria-hidden="true" className="text-subtle">—</span>;
    const values: Record<Exclude<BuiltinColumn, 'title'>, ReactNode> = {
      status: <span className="truncate" title={status}>{status}</span>,
      responsible: responsible === null ? dash : <span className="truncate" title={responsible}>{responsible}</span>,
      participants: participants > 0 ? <span className="tabular-nums">{participants}</span> : dash,
      startDate: calendarText(child.startDate) ?? dash,
      dueDate: calendarText(child.dueDate) ?? dash,
      priority: child.priority === 'none' ? dash : t(child.priority === 'urgent' ? 'taskTable.taskTable.urgent' : child.priority === 'high' ? 'taskTable.taskTable.high' : child.priority === 'medium' ? 'taskTable.taskTable.medium' : 'taskTable.taskTable.low'),
      tags: child.tags.length > 0 ? <span className="truncate">{child.tags.map(tag => tag.name).join(', ')}</span> : dash,
      estimate: child.estimateMinutes === null ? dash : <span className="tabular-nums">{formatEstimate(child.estimateMinutes)}</span>,
    };
    return (
      <tr key={child.id} data-task-row={child.id} data-task-drop={drop} data-task-dragging={drag?.taskId === child.id ? '' : undefined}
        className={cn('group h-[41px] border-t border-line hover:bg-canvas/70', drop === 'before' && 'shadow-[inset_0_2px_0_var(--color-accent)]', drop === 'after' && 'shadow-[inset_0_-2px_0_var(--color-accent)]', drag?.taskId === child.id && 'opacity-60')}>
        <td className="h-[41px] max-h-[41px] overflow-hidden py-0 pr-1 pl-1 align-middle">
          <div className="flex h-[41px] min-w-0 items-center gap-1">
            {movable ? (
              <button type="button" data-task-move-handle={child.id} aria-label={t('taskTable.move.handle', { title: child.title })} title={t('taskTable.move.handleHint')}
                aria-disabled={moveBlocked || undefined}
                onPointerDown={event => startDrag(child, event)}
                onKeyDown={event => {
                  if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;
                  event.preventDefault();
                  const anchor = event.key === 'ArrowUp' ? previous : next;
                  if (anchor) moveTask(child, anchor, event.key === 'ArrowUp' ? 'before' : 'after');
                }}
                className="flex h-6 w-3 shrink-0 cursor-grab touch-none items-center justify-center rounded text-subtle outline-none focus-visible:ring-2 focus-visible:ring-accent active:cursor-grabbing">
                <GripVertical size={12} aria-hidden="true" />
              </button>
            ) : <span aria-hidden="true" className="w-3 shrink-0" />}
            {readOnly ? <span aria-hidden="true" className="size-7 shrink-0" /> : (
              <TaskCompletionAction task={child} statuses={statuses} writable={writable} blocked={unresolvedTaskCommand(commands) !== null}
                pending={completion.pending && completion.attempt?.session.base.id === child.id} hasDraft={commands.editSessions.current.has(child.id)}
                editing={editing?.taskId === child.id} onChoose={completion.choose} onTargetReady={completion.targetReady} onReview={onOpen} />
            )}
            {editing?.taskId === child.id ? (
              <div className="min-w-0 flex-1">
                <InlineTaskEdit key={`${child.id}:title`} focusClaim={editing.focusClaim} task={child} field="title" estimatePackages={packages} statuses={statuses} members={members} sections={sections}
                  tags={tags} commands={commands} writable={writable} onMoreDetails={() => onOpen(child.id)} onSaved={() => undefined}
                  onClose={(reason: InlineCloseReason = 'cancel') => {
                    setEditing(null);
                    if (reason === 'next') openAfter(child);
                    else if (reason === 'cancel') focusLater(`button[data-subtask-title="${child.id}"]`);
                  }}
                  onSaveStarted={(form, intent) => {
                    // A held title save keeps its retained session; the next sibling row opens at once
                    // and its create waits in the queue for this save's confirmed answer.
                    const continued = intent.continueWithNext && form.contains(document.activeElement) && commands.editSessions.current.has(child.id);
                    if (continued) openAfter(child);
                    return {
                      onSettled: () => undefined,
                      onSuccess: () => { if (!continued) setEditing(before => before?.taskId === child.id ? null : before); },
                    };
                  }} />
              </div>
            ) : (
              <>
                {/* The full name stays the control's accessible name and tooltip while it truncates. */}
                {editable ? <button type="button" data-subtask-title={child.id} data-task-cell={`${child.id}:title`} title={child.title} onClick={() => setEditing({ taskId: child.id, focusClaim: { current: false } })}
                  className="min-w-0 max-w-full shrink cursor-text truncate rounded px-1 py-1 text-left text-sm text-ink outline-none hover:bg-slate-100 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent">{child.title}</button>
                  : <span title={child.title} className="min-w-0 shrink truncate px-1 py-1 text-sm text-ink">{child.title}</span>}
                {commands.editSessions.current.has(child.id) ? <span className="shrink-0 rounded-full bg-amber-50 px-1.5 text-[11px] text-amber-800 ring-1 ring-amber-200" title={t('tasks.inlineEdit.draftHint')}>{t('tasks.inlineEdit.draft')}</span> : null}
                {/* The rest of the name cell opens the subtask; it never wraps the name control. */}
                <button type="button" onClick={() => onOpen(child.id)} aria-label={t('tasks.subtasks.open', { title: child.title, status, scope: kind })}
                  className="flex h-8 min-w-6 flex-1 items-center justify-end gap-1 overflow-hidden rounded px-1 outline-none hover:bg-slate-100 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent">
                  <Badge tone="muted">{kind}</Badge>
                  {child.archivedAt !== null ? <Badge tone="muted">{t('tasks.taskDrawer.archived')}</Badge> : null}
                </button>
              </>
            )}
          </div>
        </td>
        {COLUMNS.slice(1).map(id => <td key={id} className={cn(cellClassName, id === 'estimate' && 'text-right')}>{values[id as Exclude<BuiltinColumn, 'title'>]}</td>)}
        {/* A confirmed row the list has not loaded has no loaded values yet; nothing is shown for it. */}
        {extraColumns.map(column => <td key={column.id} className={cellClassName}><div className="flex h-[41px] min-w-0 items-center overflow-hidden">{readOnly ? null : column.renderCell(child)}</div></td>)}
      </tr>
    );
  };
  const quickBlock = chain === null || (!chain.open && queued.length === 0 && retained.length === 0) ? null : <Fragment key="quick-add">
    {retained.map(entry => readRow(entry.task, true))}
    {queued.map((entry, index) => {
      const uncertain = index === 0 && commands.create.uncertain !== null;
      return <QuickTaskDraftPreview key={queuedKey(entry.session)} session={entry.session} renderRow={draftRow(uncertain ? 'uncertain' : 'pending')} pending={!uncertain} uncertain={uncertain} />;
    })}
    {chain.open ? <QuickTaskAdd key={`subtask:${chain.anchorTaskId ?? 'end'}`} projectId={projectId} sectionId={chain.request.sectionId}
      sectionName={sections.find(section => section.id === chain.request.sectionId)?.name ?? t('tasks.taskFields.noSection')}
      statuses={statuses} members={members} tags={tags} sections={sections} commands={commands} writable={canCreate} request={chain.request} renderRow={draftRow('draft')} detailsKeepInitialCells
      initialFields={initialFields} initialTimeContext={initialTimeContext} initialTimeWritable={initialTimeWritable} initialTimeCurrent={initialTimeCurrent}
      onClose={(reason: QuickAddCloseReason = 'cancel') => {
        setChain(before => before && { ...before, open: false });
        if (reason === 'cancel') focusLater(anchorId === null ? '[data-subtask-add]' : `button[data-subtask-title="${anchorId}"]`);
      }}
      onMoreDetails={onMoreDetails}
      onCreated={task => { setChain(before => before && { ...before, confirmed: [...before.confirmed, { task, at: Date.now() }] }); onCreated(task); }} /> : null}
  </Fragment>;
  const rows: ReactNode[] = scope.tasks.map(child => readRow(child, false));
  if (quickBlock !== null) {
    const index = anchorId === null ? -1 : scope.tasks.findIndex(child => child.id === anchorId);
    rows.splice(index < 0 ? rows.length : index + 1, 0, quickBlock);
  }
  const widthOf = (id: string) => WIDTHS[id as BuiltinColumn] ?? extraColumns.find(column => column.id === id)?.width ?? 120;
  const columnLabels: Record<BuiltinColumn, string> = { title: t('tasks.subtasks.columns.title'), status: t('tasks.subtasks.columns.status'), responsible: t('tasks.subtasks.columns.responsible'), participants: t('tasks.subtasks.columns.participants'), startDate: t('tasks.subtasks.columns.startDate'), dueDate: t('tasks.subtasks.columns.dueDate'), priority: t('tasks.subtasks.columns.priority'), tags: t('tasks.subtasks.columns.tags'), estimate: t('tasks.subtasks.columns.estimate') };
  const labelOf = (id: string) => (COLUMNS as readonly string[]).includes(id) ? columnLabels[id as BuiltinColumn] : extraColumns.find(column => column.id === id)?.label ?? '';

  return (
    <section aria-labelledby={headingId} className="space-y-2">
      {drag ? <TaskDragPreview task={drag.task} pointer={drag.pointer} /> : null}
      <h3 id={headingId} className="text-sm font-medium text-ink">{t('tasks.subtasks.heading')}</h3>
      {scope.partial ? <p className="text-xs text-muted">{t('tasks.subtasks.loadedOnly')}</p> : null}
      <TaskCompletionFeedback controller={completion} onReview={onOpen} />
      {moveFeedback ? <>
        <SaveFeedback subject="taskSave" error={commands.move.uncertain === null ? commands.move.error : null} uncertainError={commands.move.uncertain?.error ?? null}
          action={<Button size="sm" variant="ghost" onClick={() => commands.move.reset()}>{t('taskTable.move.dismiss')}</Button>} />
        {commands.move.uncertain !== null ? <Button size="sm" aria-disabled={commands.move.pendingCommand !== null || undefined} onClick={() => { if (commands.move.pendingCommand === null) commands.move.retryUncertain(); }}>{t('tasks.quickAdd.retry')}</Button> : null}
      </> : null}
      {scope.tasks.length === 0 && quickBlock === null ? <p className="text-sm text-muted">{empty}</p> : (
        <div className="overflow-x-auto rounded-lg border border-line">
          <table className="w-full table-fixed border-collapse text-left text-sm" style={{ minWidth: columnIds.reduce((sum, id) => sum + widthOf(id), 0) }}>
            <caption className="sr-only">{t('tasks.subtasks.heading')}</caption>
            <colgroup>{columnIds.map(id => <col key={id} style={{ width: widthOf(id) }} />)}</colgroup>
            <thead className="text-xs text-muted"><tr className="h-8">{columnIds.map(id => <th key={id} scope="col" title={labelOf(id)} className={cn('truncate px-1.5 font-medium', id === 'estimate' && 'text-right')}>{labelOf(id)}</th>)}</tr></thead>
            <tbody>{rows}</tbody>
          </table>
        </div>
      )}
      {canCreate ? <button type="button" data-subtask-add="" onClick={openPrimary}
        className="flex h-8 items-center gap-2 rounded px-1.5 text-sm text-muted outline-none hover:bg-slate-100 hover:text-ink focus-visible:ring-2 focus-visible:ring-accent">
        <Plus size={14} aria-hidden="true" />{t('tasks.subtasks.addInline')}
      </button> : null}
    </section>
  );
}
