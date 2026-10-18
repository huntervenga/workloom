import { TaskDragPreview } from './TaskDragPreview';
import { selectTaskRows, type SelectionModifiers } from './taskSelection';
import { resolveDraftPlacement, type DraftPlacementSnapshot } from './draftPlacement';
import { canEditTaskInline, canMoveTaskSection, isCurrentEstimateProjection, type TaskInlineField } from '../tasks/tableEditing';
import { t, useTranslation, formatDate } from '../../i18n';
import type {
  MembershipDto,
  SectionDto,
  TagDto,
  TaskDto,
  TaskPriority,
  TaskStatusDto,
  TaskStatusGroup,
} from '@workloom/contracts';
import { Avatar, Badge, Button, cn } from '@workloom/ui';
import * as Menu from '@radix-ui/react-dropdown-menu';
import { ArrowDown, ArrowUp, ChevronDown, ChevronRight, Flag, FolderInput, GripVertical, Link2, MoreHorizontal, PanelRightOpen, Pencil, Plus, TriangleAlert, UserRound } from 'lucide-react';
import { useCallback, useId, useMemo, useRef, useState, Fragment, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react';
import { formatEstimate } from './estimate';
import { visibleTaskRows, type TaskTreeNode } from './taskTree';
import { buildTableGroups, type TableTaskGroup, type TaskGroupingMode } from './taskGrouping';
import { dedupeTasks } from './workPackages';
import type { TaskSortMode } from './taskOrdering';
import { summarizeWorkPackages, type WorkPackageSummary } from './workPackages';
import { usePointerRowDrag, type DropTarget } from './usePointerRowDrag';
import { titleCaretFromPoint } from './titleCaret';

/** A column supplied by the parent, shown after «Приоритет» and before the estimate. */
export interface TaskTableCustomColumn {
  /** Stable key, e.g. the field ID. */
  id: string;
  label: string;
  /** Column width in pixels. */
  width: number;
  renderCell: (task: TaskDto) => ReactNode;
}

/** `draft` is the one unsent input row; submitted rows wait as `pending` or `uncertain`. */
export type TaskTableDraftRowState = 'draft' | 'pending' | 'uncertain';
/** Renders one normal table row: one cell per visible column, filled by `renderCell(columnId)`. */
export type TaskTableDraftRow = (renderCell: (columnId: string) => ReactNode) => ReactNode;
export type TaskDropPlacement = 'before' | 'after';

export interface TaskTableQuickAdd {
  placement?: DraftPlacementSnapshot | undefined;
  sectionId: string | null;
  /**
   * Manual order only: the rows sit right after this loaded task and its visible subtree instead
   * of closing the section. An anchor that is not visible falls back to the section's end.
   */
  afterTaskId?: string | null | undefined;
  /** The new rows are subtasks of this task; they are indented like their siblings. */
  parentTaskId?: string | null | undefined;
  /** Confirmed creates the list has not loaded yet; shown read-only in place until it does. */
  confirmedTasks?: readonly TaskDto[] | undefined;
  /** Legacy single-cell content spanning every column. */
  content?: ReactNode;
  /** Full rows; `draftRow(state)` renders one normal row per visible column. Wins over `content`. */
  render?: ((draftRow: (state: TaskTableDraftRowState) => TaskTableDraftRow) => ReactNode) | undefined;
}

export interface TaskTableProps {
  selectedTaskIds?: readonly string[] | undefined;
  selectionDisabled?: boolean | undefined;
  dragScope?: string | undefined;
  onSelectionChange?: ((ids: string[]) => void) | undefined;
  onSelectTask?: ((id: string, selected: boolean) => void) | undefined;
  /** Loaded tasks of one project. The table never fetches or invents tasks. */
  tasks: readonly TaskDto[];
  /** Project sections; archived ones are shown only while loaded tasks sit in them. */
  sections: readonly SectionDto[];
  /** Project statuses, matched by `TaskDto.statusId`. */
  statuses: readonly TaskStatusDto[];
  /** Workspace memberships, matched by `membership.id` (never `userId`). */
  members: readonly MembershipDto[];
  /** Opens the task detail editor. */
  onOpenTask: (taskId: string) => void;
  /** Starts creating a root task in a section; `null` means «Без раздела». Shown only when `writable`. */
  onCreateTask: (sectionId?: string | null) => void;
  /** Starts creating a subtask under `parent`. Shown only when `writable` and `parent` is not archived. */
  onCreateChild: (parent: TaskDto) => void;
  /** Starts renaming a section. Shown only when provided and `writable`. */
  onRenameSection?: ((section: SectionDto) => void) | undefined;
  /** The actor may create tasks here. Defaults to `false`. */
  writable?: boolean | undefined;
  /**
   * `tasks` is a subset (filter, search or a page with more to load). Counts and the estimate
   * total are then labelled as covering loaded tasks only.
   */
  partial?: boolean | undefined;
  /** Today in the workspace time zone (`YYYY-MM-DD`); enables overdue marking. */
  today?: string | undefined;
  /** Accessible table caption. */
  caption?: string | undefined;
  /** Extra columns in this order; the table renders what the parent gives and fetches nothing. */
  customColumns?: readonly TaskTableCustomColumn[] | undefined;
  /** Compact keeps everyday columns; expanded also shows participants, tags and priority. */
  columnPreset?: 'compact' | 'expanded' | undefined;
  /** Exact visible built-in/custom IDs; title remains pinned first. */
  columnIds?: readonly string[] | undefined;
  renderCompletionAction?: ((task: TaskDto) => ReactNode) | undefined;
  /** `titleCaret` is passed only by a pointer click on the title text: the clicked character's offset. */
  onEditTaskField?: ((task: TaskDto, field: TaskInlineField, titleCaret?: number) => void) | undefined;
  renderTaskFieldEditor?: ((task: TaskDto, field: TaskInlineField) => ReactNode) | undefined;
  /**
   * Presentation only: the cell whose editor `renderTaskFieldEditor` returns. It is marked, never
   * widened: column widths and row heights stay fixed while any cell editor is open.
   */
  activeFieldEditor?: { taskId: string; field: TaskInlineField } | undefined;
  draftTaskIds?: ReadonlySet<string> | undefined;
  quickAdd?: TaskTableQuickAdd | undefined;
  /**
   * Persists a manual reorder: `task` goes right before/after `anchor` (same parent; a subtask also
   * stays in its section). Offered only in manual order grouped by section. The rows never move
   * locally: the refetched list is the authoritative order.
   */
  onMoveTask?: ((task: TaskDto, anchor: TaskDto | null, placement: TaskDropPlacement, target?: { responsibleMembershipId: string | null }) => void) | undefined;
  /** A task command is still being sent or unconfirmed: reordering is refused until it resolves. */
  moveBlocked?: boolean | undefined;
  acquireDragProtection?: (() => () => void) | undefined;
  /** Orders rows within the existing group/parent structure. */
  sortMode?: TaskSortMode | undefined;
  grouping?: TaskGroupingMode | undefined;
  /** Page-owned descendant disclosure; standalone callers keep local state. */
  collapsedTaskIds?: ReadonlySet<string> | undefined;
  onTaskCollapsedChange?: ((taskId: string, collapsed: boolean) => void) | undefined;
  /** Controlled group disclosure retained across query/view switches. */
  collapsedGroupKeys?: ReadonlySet<string> | undefined;
  onGroupCollapsedChange?: ((groupKey: string, collapsed: boolean) => void) | undefined;
  className?: string | undefined;
}

/** The scroller container gives desktop names room while leaving medium/mobile browsing usable. */
const titleWidth = 'clamp(280px, 42cqw, 460px)';
const noCustomColumns: readonly TaskTableCustomColumn[] = [];

/**
 * One explicit inline open pans only this table's own horizontal scroll so the editor sits between
 * the sticky title/estimate cells and inside the window. It never scrolls the page, moves focus or
 * paints over neighbouring cells; outside a task table (Board, standalone) it does nothing.
 */
export function revealInlineEditor(editor: HTMLElement): void {
  const scroller = editor.closest<HTMLElement>('[data-task-table-scroll]');
  const cell = editor.closest('td');
  const row = cell?.parentElement;
  if (!scroller || !cell || !row || getComputedStyle(cell).position === 'sticky') return;
  const frame = scroller.getBoundingClientRect();
  let left = Math.max(frame.left + scroller.clientLeft, 0);
  let right = Math.min(frame.left + scroller.clientLeft + scroller.clientWidth, document.documentElement.clientWidth);
  let before = true;
  for (const sibling of row.children) {
    if (sibling === cell) { before = false; continue; }
    if (getComputedStyle(sibling).position !== 'sticky') continue;
    const rect = sibling.getBoundingClientRect();
    if (before) left = Math.max(left, rect.right); else right = Math.min(right, rect.left);
  }
  const target = editor.getBoundingClientRect();
  // A target wider than the clear area keeps its start (input and Save) in view.
  const delta = target.left < left || target.width > right - left ? target.left - left : target.right > right ? target.right - right : 0;
  if (delta !== 0) scroller.scrollLeft += delta;
}

/** Icon-only control; callers add its size and text color. */
const iconButtonClassName =
  'inline-flex shrink-0 items-center justify-center rounded-md transition-colors hover:bg-slate-100 hover:text-ink';

/** Row actions stay in the accessibility tree; pointer users see them on hover or focus. */
const rowActionClassName =
  'pointer-events-none opacity-0 group-hover:pointer-events-auto group-hover:opacity-100 group-focus-within:pointer-events-auto group-focus-within:opacity-100 [@media(hover:none)]:pointer-events-auto [@media(hover:none)]:opacity-100';

/**
 * Every body cell has one fixed single-line height. Content truncates instead of wrapping, so
 * opening, typing, choosing, pending and error states never grow a row or a column.
 */
const cellClassName = 'h-10 max-h-10 overflow-hidden whitespace-nowrap px-1.5 py-0 align-middle';

/** Vertical grid line drawn inside the cell, so it also follows sticky cells while scrolling. */
const gridLineClassName = 'shadow-[inset_-1px_0_0_var(--color-line)]';

/** Paint on each cell, above its sticky background, and retain its existing vertical/edge shadow. */
const dropCellStyle = (drop: TaskDropPlacement | undefined) => drop === undefined ? undefined : {
  boxShadow: `inset 0 ${drop === 'before' ? 2 : -2}px 0 var(--color-accent), var(--tw-shadow, 0 0 #0000)`,
};

/** A selected row paints every cell, sticky ones included, with the one opaque selection token. */
const rowCellStyle = (drop: TaskDropPlacement | undefined, selected: boolean) =>
  selected ? { ...dropCellStyle(drop), backgroundColor: 'var(--color-selection)' } : dropCellStyle(drop);

/** Read-mode cell control: the whole cell is the click target, with one consistent hover/focus. */
const cellButtonClassName = cn(
  'flex h-8 w-full min-w-0 items-center px-1.5 outline-none hover:bg-slate-100 focus-visible:bg-slate-100 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent', 'rounded');

/**
 * From `lg` the estimate column sticks to the right edge, so the header, every task estimate and
 * the total stay in view while the wider table scrolls. Small screens keep plain local scrolling.
 */
const stickyEstimateClassName =
  'lg:sticky lg:right-0 lg:z-[1] lg:shadow-[inset_1px_0_0_var(--color-line),-8px_0_8px_-8px_rgb(15_23_42/0.18)]';

/** The title cell of every row, real or draft: pinned left from `lg`. */
const titleCellClassName =
  'h-10 max-h-10 overflow-hidden whitespace-nowrap py-0 pr-1 align-middle max-lg:shadow-[inset_-1px_0_0_var(--color-line)] lg:sticky lg:left-0 lg:z-[1] lg:bg-surface lg:shadow-[inset_-1px_0_0_var(--color-line),8px_0_8px_-8px_rgb(15_23_42/0.18)] lg:group-hover:bg-[color-mix(in_srgb,var(--color-canvas)_70%,var(--color-surface))]';

const menuItemClassName = 'flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-sm outline-none data-highlighted:bg-accent-soft data-disabled:cursor-default data-disabled:opacity-50';

/** Editors and text fields keep their native context menu and keyboard. */
function ownsNativeMenu(target: EventTarget): boolean {
  return target instanceof Element && target.closest('input, textarea, select, [contenteditable="true"], [data-editing], [role="menu"], [role="listbox"], [role="dialog"]') !== null;
}

const statusDotClasses: Record<TaskStatusGroup, string> = {
  todo: 'bg-slate-400',
  in_progress: 'bg-accent',
  done: 'bg-emerald-500',
  cancelled: 'bg-slate-300',
};

const priorityView: Record<Exclude<TaskPriority, 'none'>, { label: string; className: string }> = {
  low: { get label() { return t('taskTable.taskTable.low'); }, className: 'text-muted' },
  medium: { get label() { return t('taskTable.taskTable.medium'); }, className: 'text-ink-soft' },
  high: { get label() { return t('taskTable.taskTable.high'); }, className: 'text-amber-700' },
  urgent: { get label() { return t('taskTable.taskTable.urgent'); }, className: 'text-rose-700' },
};

function formatTaskCount(count: number): string {
  return t('taskTable.taskTable.taskCount', { count });
}

function formatSubtaskCount(count: number): string {
  return t('taskTable.taskTable.subtaskCount', { count });
}

const dayMonthFormat = { format: (date: Date) => formatDate(date, { day: 'numeric', month: 'short', timeZone: 'UTC' }) };
const fullDateFormat = { format: (date: Date) => formatDate(date, {
  day: '2-digit',
  month: '2-digit',
  year: 'numeric',
  timeZone: 'UTC',
}) };
const longDateFormat = { format: (date: Date) => formatDate(date, { dateStyle: 'long', timeZone: 'UTC' }) };

function calendarDate(value: string): Date {
  const [year = 0, month = 1, day = 1] = value.split('-').map(Number);
  const date = new Date(0);
  date.setUTCHours(0, 0, 0, 0);
  date.setUTCFullYear(year, month - 1, day);
  return date;
}

function Empty({ label }: { label: string }) {
  useTranslation();
  return (
    <>
      <span aria-hidden="true" className="text-subtle">
        —
      </span>
      <span className="sr-only">{label}</span>
    </>
  );
}

const UNKNOWN_MEMBER = () => t('taskTable.taskTable.memberUnavailable');

function MemberName({ membershipId, memberById }: { membershipId: string; memberById: ReadonlyMap<string, MembershipDto> }) {
  useTranslation();
  const member = memberById.get(membershipId);
  if (member === undefined) {
    return (
      <span className="flex min-w-0 items-center gap-2 text-muted">
        <span className="inline-flex size-6 shrink-0 items-center justify-center rounded-full bg-slate-100">
          <UserRound size={14} aria-hidden="true" />
        </span>
        <span className="truncate">{UNKNOWN_MEMBER()}</span>
      </span>
    );
  }
  return (
    <span className="flex min-w-0 items-center gap-2">
      <Avatar name={member.displayName} seed={member.userId} size="sm" />
      <span className="truncate text-ink-soft" title={member.displayName}>
        {member.displayName}
      </span>
    </span>
  );
}

function ParticipantsCell({
  membershipIds,
  memberById,
}: {
  membershipIds: readonly string[];
  memberById: ReadonlyMap<string, MembershipDto>;
}) {
  const { t } = useTranslation();
  const [first] = membershipIds;
  if (first === undefined) return <Empty label={t('taskTable.taskTable.noParticipants')} />;
  if (membershipIds.length === 1) return <MemberName membershipId={first} memberById={memberById} />;

  const names = membershipIds.map((id) => memberById.get(id)?.displayName ?? UNKNOWN_MEMBER());
  const shown = membershipIds.slice(0, 3);
  const hidden = membershipIds.length - shown.length;
  return (
    <span className="flex items-center" title={names.join(', ')}>
      <span className="sr-only">{names.join(', ')}</span>
      <span aria-hidden="true" className="flex items-center -space-x-1.5">
        {shown.map((id) => {
          const member = memberById.get(id);
          return member === undefined ? (
            <span
              key={id}
              className="inline-flex size-6 items-center justify-center rounded-full bg-slate-100 text-muted ring-2 ring-surface"
            >
              <UserRound size={14} />
            </span>
          ) : (
            <Avatar key={id} name={member.displayName} seed={member.userId} size="sm" className="ring-2 ring-surface" />
          );
        })}
      </span>
      {hidden > 0 ? (
        <span aria-hidden="true" className="ml-1.5 text-xs text-muted tabular-nums">
          +{hidden}
        </span>
      ) : null}
    </span>
  );
}

function TagChip({ tag }: { tag: TagDto }) {
  const { t } = useTranslation();
  const archived = tag.archivedAt !== null;
  return (
    <span
      className={cn(
        'inline-flex min-w-0 items-center gap-1 rounded-full px-2 py-0.5 text-xs ring-1 ring-inset',
        archived ? 'bg-canvas text-muted ring-line' : 'bg-slate-50 text-ink-soft ring-line',
      )}
    >
      <span
        aria-hidden="true"
        className={cn('size-2 shrink-0 rounded-full', tag.color === null && 'bg-subtle', archived && 'opacity-50')}
        style={tag.color === null ? undefined : { backgroundColor: tag.color }}
      />
      <span className="truncate">{tag.name}</span>
      {archived ? <span className="shrink-0 text-subtle">{t('taskTable.taskTable.archived')}</span> : null}
    </span>
  );
}

function TagsCell({ tags }: { tags: readonly TagDto[] }) {
  const { t } = useTranslation();
  const unique = [...new Map(tags.map((tag) => [tag.id, tag])).values()];
  if (unique.length === 0) return <Empty label={t('taskTable.taskTable.noTags')} />;
  const shown = unique.slice(0, 2);
  const rest = unique.slice(2);
  const label = (tag: TagDto) => (tag.archivedAt === null ? tag.name : t('taskTable.taskTable.valueArchived', { p0: tag.name }));
  return (
    <span className="flex min-w-0 items-center gap-1">
      {shown.map((tag) => (
        <TagChip key={tag.id} tag={tag} />
      ))}
      {rest.length > 0 ? (
        <span className="shrink-0 text-xs text-muted tabular-nums" title={rest.map(label).join(', ')}>
          <span aria-hidden="true">+{rest.length}</span>
          <span className="sr-only">{t('taskTable.taskTable.more')}{rest.map(label).join(', ')}</span>
        </span>
      ) : null}
    </span>
  );
}

function DueDateCell({ startDate, dueDate, today, finished }: { startDate: string | null; dueDate: string | null; today: string | undefined; finished: boolean }) {
  const { t } = useTranslation();
  if (dueDate === null && startDate === null) return <Empty label={t('taskTable.taskTable.noDueDate')} />;
  const referenceYear = today === undefined ? new Date().getFullYear() : calendarDate(today).getUTCFullYear();
  const short = (value: string) => { const date = calendarDate(value); return date.getUTCFullYear() === referenceYear ? dayMonthFormat.format(date) : fullDateFormat.format(date); };
  const long = (value: string) => longDateFormat.format(calendarDate(value));
  const text = startDate !== null && dueDate !== null ? t('taskTable.dates.range', { start: short(startDate), due: short(dueDate) })
    : dueDate !== null ? short(dueDate) : t('taskTable.dates.startOnly', { start: short(startDate ?? dueDate ?? '') });
  const label = startDate !== null && dueDate !== null ? t('taskTable.dates.rangeLabel', { start: long(startDate), due: long(dueDate) })
    : dueDate !== null ? long(dueDate) : t('taskTable.dates.startOnly', { start: long(startDate ?? dueDate ?? '') });
  const overdue = today !== undefined && !finished && dueDate !== null && dueDate < today;
  return <span title={label} aria-label={label} className={cn('block truncate tabular-nums', overdue ? 'font-medium text-rose-700' : 'text-ink-soft')}>
    {text}{overdue ? <span className="sr-only">{t('taskTable.taskTable.overdue')}</span> : null}
  </span>;
}

function PriorityCell({ priority }: { priority: TaskPriority }) {
  const { t } = useTranslation();
  if (priority === 'none') return <Empty label={t('taskTable.taskTable.noPriority')} />;
  const view = priorityView[priority];
  return (
    <span className={cn('inline-flex items-center gap-1.5', view.className)}>
      <Flag size={14} aria-hidden="true" className="shrink-0" />
      {view.label}
    </span>
  );
}

function EstimateCell({ task, summary }: { task: TaskDto; summary: WorkPackageSummary }) {
  const { t } = useTranslation();
  const entry = summary.packages.get(task.workPackageId);
  const sharedWith = entry === undefined ? 0 : entry.taskIds.length - 1;

  if (entry?.estimate.status === 'conflict') {
    return (
      <span className="inline-flex items-center justify-end gap-1.5 text-amber-800">
        <TriangleAlert size={14} aria-hidden="true" className="shrink-0" />
        <span>{t('taskTable.taskTable.refreshData')}</span>
        <span className="sr-only">{t('taskTable.taskTable.loadedEstimatesDisagree')}</span>
      </span>
    );
  }

  // The newest package revision among loaded tasks wins over a stale copy on this row.
  const minutes =
    entry === undefined ? task.estimateMinutes : entry.estimate.status === 'estimated' ? entry.estimate.minutes : null;

  return (
    <span className="inline-flex items-center justify-end gap-1.5">
      {sharedWith > 0 ? (
        <span
          className="inline-flex items-center gap-0.5 text-xs text-muted"
          title={t('taskTable.taskTable.sharedWithValueCountedOnceInTotals', { p0: formatTaskCount(sharedWith) })}
        >
          <Link2 size={12} aria-hidden="true" />
          {t('taskTable.taskTable.shared')}</span>
      ) : null}
      {minutes === null ? (
        <Empty label={t('taskTable.taskTable.notEstimated')} />
      ) : (
        <span className="font-medium text-ink tabular-nums">{formatEstimate(minutes)}</span>
      )}
    </span>
  );
}

interface RowContext {
  grouping: TaskGroupingMode;
  taskById: ReadonlyMap<string, TaskDto>;
  selectedTaskIds: readonly string[];
  selectionDisabled: boolean;
  onSelectTask: ((id: string, selected: boolean) => void) | undefined;
  selectRow: ((id: string, modifiers: SelectionModifiers) => void) | undefined;
  statusById: ReadonlyMap<string, TaskStatusDto>;
  memberById: ReadonlyMap<string, MembershipDto>;
  sectionById: ReadonlyMap<string, SectionDto>;
  summary: WorkPackageSummary;
  collapsedIds: ReadonlySet<string>;
  onToggle: (taskId: string) => void;
  onOpenTask: (taskId: string) => void;
  onCreateChild: ((parent: TaskDto) => void) | null;
  partial: boolean;
  today: string | undefined;
  customColumns: readonly TaskTableCustomColumn[];
  columnIds: readonly string[];
  onEditTaskField: TaskTableProps['onEditTaskField'];
  renderTaskFieldEditor: TaskTableProps['renderTaskFieldEditor'];
  renderCompletionAction: TaskTableProps['renderCompletionAction'];
  draftTaskIds: ReadonlySet<string>;
  /** Grid line classes of a visible column, shared by its header and body cells. */
  columnLine: (id: string) => string | undefined;
  activeFieldEditor: TaskTableProps['activeFieldEditor'];
  /** Manual reorder: null when this table offers none. */
  move: RowMove | null;
  /** The pointer drag's current valid drop, drawn on the anchor row. */
  dropTarget: DropTarget | null;
  draggingTaskId: string | null;
}

interface RowMove {
  canMove: (task: TaskDto) => boolean;
  blocked: boolean;
  /** The previous/next sibling a keyboard move would pass, if any. */
  neighbour: (task: TaskDto, direction: -1 | 1) => TaskDto | undefined;
  move: (task: TaskDto, anchor: TaskDto, placement: TaskDropPlacement) => void;
  startDrag: (task: TaskDto, event: ReactPointerEvent<HTMLButtonElement>) => void;
}

function sectionLabel(sectionId: string | null, sectionById: ReadonlyMap<string, SectionDto>): string {
  if (sectionId === null) return t('taskTable.taskTable.noSection');
  return sectionById.get(sectionId)?.name ?? t('taskTable.taskTable.sectionUnavailable');
}

function TaskRow({ node, group, ctx }: { node: TaskTreeNode; group: TableTaskGroup; ctx: RowContext }) {
  const { t } = useTranslation();
  const { task } = node;
  const hierarchyDescriptionId = useId();
  const status = ctx.statusById.get(task.statusId);
  const childCount = node.children.length;
  const expanded = !ctx.collapsedIds.has(task.id);
  const finished = status?.group === 'done' || status?.group === 'cancelled';
  const showSection = ctx.grouping === 'section' && node.depth > 0 && task.sectionId !== group.sectionId;
  const activeParticipantIds = [
    ...new Set(task.participants.filter((participant) => participant.active).map((participant) => participant.membershipId)),
  ];
  const childCountText = ctx.partial ? t('taskTable.taskTable.loadedValue', { p0: formatSubtaskCount(childCount) }) : formatSubtaskCount(childCount);

  const parent = task.parentTaskId === null ? undefined : ctx.taskById.get(task.parentTaskId);
  const context = ctx.grouping === 'assignee' ? task.parentTaskId === null
    ? t('taskTable.grouping.sectionContext', { section: sectionLabel(task.sectionId, ctx.sectionById) })
    : parent ? t('taskTable.grouping.parentContext', { section: sectionLabel(task.sectionId, ctx.sectionById), parent: parent.title })
      : t('taskTable.grouping.unloadedParentContext', { section: sectionLabel(task.sectionId, ctx.sectionById) }) : null;
  const titleEditor = ctx.renderTaskFieldEditor?.(task, 'title');
  const editingTitle = titleEditor !== undefined && titleEditor !== null;
  const editable = ctx.onEditTaskField !== undefined && canEditTaskInline(task);
  // The section editor overlays the fixed title cell; the action buttons keep their own flow space.
  const sectionEditor = ctx.renderTaskFieldEditor?.(task, 'sectionId');
  const movingSection = sectionEditor !== undefined && sectionEditor !== null;
  const movable = ctx.onEditTaskField !== undefined && canMoveTaskSection(task);
  const isEditing = (field: TaskInlineField) => ctx.activeFieldEditor?.taskId === task.id && ctx.activeFieldEditor.field === field;
  const cell = (field: TaskInlineField, content: ReactNode): ReactNode => {
    const editor = ctx.renderTaskFieldEditor?.(task, field);
    if (editor !== undefined && editor !== null) return editor;
    const align = field === 'estimate' ? 'justify-end text-right' : 'text-left';
    if (!editable) return <span className={cn('flex h-8 min-w-0 items-center px-1.5', align)}>{content}</span>;
    if (field === 'estimate' && !isCurrentEstimateProjection(task, ctx.summary.packages)) return <span className={cn('flex h-8 min-w-0 items-center px-1.5', align)} title={t('tasks.inlineEstimate.refreshRequired')}>{content}<span className="sr-only">{t('tasks.inlineEstimate.refreshRequired')}</span></span>;
    const label = field === 'estimate' ? t('tasks.inlineEstimate.edit', { title: task.title }) : field === 'title' ? t('tasks.inlineEdit.editTitle', { title: task.title }) : field === 'statusId' ? t('tasks.inlineEdit.editStatus', { title: task.title }) : field === 'responsibleMembershipId' ? t('tasks.inlineEdit.editAssignee', { title: task.title }) : field === 'priority' ? t('tasks.inlineEdit.editPriority', { title: task.title }) : field === 'tagIds' ? t('tasks.inlineEdit.editTags', { title: task.title }) : t('tasks.inlineEdit.editDueDate', { title: task.title });
    return <button type="button" data-task-cell={`${task.id}:${field}`} aria-label={label} title={label} onClick={() => ctx.onEditTaskField?.(task, field)} className={cn(cellButtonClassName, align)}>{content}</button>;
  };
  const td = (id: string, field: TaskInlineField | null, content: ReactNode, className?: string) =>
    <td data-editing={field !== null && isEditing(field) ? '' : undefined} className={cn(cellClassName, ctx.columnLine(id), className)} style={rowCellStyle(drop, selected)}>{content}</td>;
  // Secondary title information stays on the same single line and truncates before the title does.
  const chip = (tone: 'muted' | 'warning', label: ReactNode, title?: string) => <span title={title} className={cn('inline-flex min-w-0 max-w-40 shrink-0 items-center rounded-full px-1.5 py-px text-[11px] font-medium ring-1 ring-inset', tone === 'warning' ? 'bg-amber-50 text-amber-800 ring-amber-200' : 'bg-canvas text-muted ring-line')}><span className="truncate">{label}</span></span>;
  const meta = <>
    {context ? <span className="min-w-0 shrink truncate text-xs text-muted" title={context}>{context}</span> : null}
    {childCount > 0 ? <span className="shrink-0 text-xs text-muted tabular-nums" title={childCountText}><span aria-hidden="true">{childCount}</span><span className="sr-only">{childCountText}</span></span> : null}
    {node.detachedReason === 'parent_not_loaded' ? chip('muted', <>{t('taskTable.taskTable.subtask3')}<span className="sr-only">{t('taskTable.taskTable.parentTaskNotLoaded')}</span></>, t('taskTable.taskTable.parentTaskIsOutsideTheLoadedSet')) : null}
    {node.detachedReason === 'cycle' ? chip('warning', t('taskTable.taskTable.hierarchyCycle'), t('taskTable.taskTable.parentRelationshipsFormACycleRefreshData')) : null}
    {showSection ? chip('muted', t('taskTable.taskTable.sectionName', { name: sectionLabel(task.sectionId, ctx.sectionById) })) : null}
    {ctx.draftTaskIds.has(task.id) ? chip('warning', t('tasks.inlineEdit.draft'), t('tasks.inlineEdit.draftHint')) : null}
    {task.meetingId ? chip('muted', t('taskTable.taskTable.meeting')) : null}
    {task.archivedAt !== null ? chip('muted', t('taskTable.taskTable.archived2')) : null}
  </>;
  const describedBy = node.depth > 0 ? hierarchyDescriptionId : undefined;
  // The name is only as wide as its text; the free area to its right opens the task.
  const titleClassName = cn('min-w-0 max-w-full shrink truncate px-1 py-1 text-left text-sm font-medium leading-5 outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent', 'rounded', finished ? 'text-muted' : 'text-ink');
  const [menuOpen, setMenuOpen] = useState(false);
  // An action that opens its own editor keeps focus there instead of on the trigger.
  const keepMenuFocus = useRef(false);
  const canAddChild = ctx.onCreateChild !== null && task.archivedAt === null && task.meetingId === null;
  const movableHere = ctx.move !== null && ctx.move.canMove(task);
  const previous = movableHere ? ctx.move?.neighbour(task, -1) : undefined;
  const next = movableHere ? ctx.move?.neighbour(task, 1) : undefined;
  const moveBy = (direction: -1 | 1) => {
    const anchor = direction < 0 ? previous : next;
    if (anchor && ctx.move && !ctx.move.blocked) ctx.move.move(task, anchor, direction < 0 ? 'before' : 'after');
  };
  const openMenuFromRow = (event: ReactMouseEvent | ReactKeyboardEvent) => {
    if (ownsNativeMenu(event.target)) return;
    event.preventDefault();
    setMenuOpen(true);
  };
  const drop = ctx.dropTarget?.taskId === task.id ? ctx.dropTarget.placement : undefined;
  const selected = ctx.selectedTaskIds.includes(task.id);
  // A pointer click on the name opens at the clicked character; keyboard activation keeps the default.
  const editTitle = (event: ReactMouseEvent<HTMLButtonElement>) => {
    const caret = event.detail > 0 ? titleCaretFromPoint(event.currentTarget, event.clientX, event.clientY) : undefined;
    if (caret === undefined) ctx.onEditTaskField?.(task, 'title');
    else ctx.onEditTaskField?.(task, 'title', caret);
  };
  const builtinCells: Record<string, ReactNode> = {
    title: (      <td
        data-editing={isEditing('title') ? '' : undefined}
        className={titleCellClassName}
        style={{ paddingLeft: 12, ...rowCellStyle(drop, selected) }}>
        <div className="relative flex h-10 min-w-0 items-center gap-1">
          {/* Boundaries of this row for a pointer drop; hit-testing reads the whole row. */}
          <span aria-hidden="true" data-task-drop-before={task.id} className="pointer-events-none absolute inset-x-0 top-0 h-1/2" />
          <span aria-hidden="true" data-task-drop-after={task.id} className="pointer-events-none absolute inset-x-0 bottom-0 h-1/2" />
          {movableHere ? (
            <button type="button" data-task-move-handle={task.id} aria-label={t('taskTable.move.handle', { title: task.title })} title={t('taskTable.move.handleHint')}
              aria-disabled={ctx.move?.blocked || undefined} aria-describedby={`${hierarchyDescriptionId}-move`}
              onPointerDown={event => ctx.move?.startDrag(task, event)}
              onKeyDown={event => {
                if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;
                event.preventDefault();
                moveBy(event.key === 'ArrowUp' ? -1 : 1);
              }}
              className={cn('absolute -left-3 top-2 flex h-6 w-3 cursor-grab touch-none items-center justify-center rounded text-subtle outline-none focus-visible:ring-2 focus-visible:ring-accent active:cursor-grabbing', rowActionClassName, ctx.draggingTaskId === task.id && 'pointer-events-auto opacity-100')}>
              <GripVertical size={12} aria-hidden="true" />
              <span id={`${hierarchyDescriptionId}-move`} className="sr-only">{t('taskTable.move.handleHint')}</span>
            </button>
          ) : null}
          {ctx.selectRow ? <button type="button" data-task-select={task.id} aria-label={t('taskTable.selection.select', { title: task.title })} aria-pressed={selected} aria-disabled={ctx.selectionDisabled || undefined}
            onClick={event => ctx.selectRow?.(task.id, event)} className={cn('mr-1 h-8 w-8 shrink-0 rounded-l outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent', !selected && 'hover:bg-canvas')} /> : null}
          <div className="flex min-w-0 flex-1 items-center gap-1" style={{ paddingLeft: Math.min(node.depth, 2) * 20 }}>
            {childCount > 0 ? (
              <button
                type="button"
                aria-expanded={expanded}
                aria-label={t('taskTable.taskTable.valueSubtasksOfValue', { p0: expanded ? t('taskTable.taskTable.collapse') : t('taskTable.taskTable.expand'), p1: task.title })}
                onClick={() => ctx.onToggle(task.id)}
                className={cn(iconButtonClassName, 'size-6 text-muted')}
              >
                {expanded ? <ChevronDown size={16} aria-hidden="true" /> : <ChevronRight size={16} aria-hidden="true" />}
              </button>
            ) : <span aria-hidden="true" className="size-6 shrink-0" />}
            {ctx.renderCompletionAction?.(task)}
            {node.depth > 0 ? <span className="sr-only">{t('taskTable.taskTable.subtask2')}</span> : null}
            {editingTitle ? <><div className="min-w-0 flex-1">{titleEditor}</div><span className="flex max-w-[35%] min-w-0 items-center gap-1 overflow-hidden">{meta}</span></> : <>
              {/* Clicking the visible name renames in place (Asana-style); read-only rows open details. */}
              {editable ? <button type="button" data-task-cell={`${task.id}:title`} title={task.title} aria-describedby={describedBy}
                onClick={editTitle} className={cn(titleClassName, 'cursor-text hover:bg-canvas')}>{task.title}</button>
                : <button type="button" onClick={() => ctx.onOpenTask(task.id)} title={task.title} aria-describedby={describedBy}
                  className={cn(titleClassName, 'hover:text-accent-ink hover:underline')}>{task.title}</button>}
              <span className="flex max-w-[35%] min-w-0 shrink-0 items-center gap-1 overflow-hidden">{meta}</span>
              {/* Everything right of the name opens the task; it never wraps the row's other controls. */}
              <button type="button" data-task-open-area={task.id} aria-label={t('taskTable.taskTable.openTask', { title: task.title })} title={t('taskTable.taskTable.openDetails')}
                onClick={() => ctx.onOpenTask(task.id)}
                className="group/open flex h-8 min-w-4 flex-1 items-center justify-end rounded px-1 text-subtle outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent">
                <PanelRightOpen size={14} aria-hidden="true" className="opacity-0 transition-opacity group-hover:opacity-60 group-focus-visible/open:opacity-100" />
              </button>
            </>}
            {movingSection ? <span data-task-section-editor="" className="absolute right-0 top-1 z-[2] flex h-8 w-52 max-w-full items-center rounded bg-surface pl-1 shadow-[-6px_0_6px_var(--color-surface)]">
              <div className="min-w-0 flex-1">{sectionEditor}</div>
            </span> : null}
            {node.depth > 0 ? <span id={hierarchyDescriptionId} className="sr-only">
              {t('taskTable.taskTable.hierarchyDepth', { depth: node.depth })}
              {parent ? ` ${t('taskTable.taskTable.parentContext', { title: parent.title })}` : null}
            </span> : null}
            {/* Section, subtask and details actions; also on right click and Shift+F10 anywhere in the row. */}
            <Menu.Root modal={false} open={menuOpen} onOpenChange={setMenuOpen}>
              <Menu.Trigger asChild>
                <button type="button" data-task-row-actions="" data-task-cell={movable ? `${task.id}:sectionId` : undefined} aria-label={t('taskTable.rowActions.trigger', { title: task.title })}
                  className={cn(iconButtonClassName, 'size-7 text-muted data-[state=open]:pointer-events-auto data-[state=open]:opacity-100', rowActionClassName, movingSection && 'invisible')}>
                  <MoreHorizontal size={15} aria-hidden="true" />
                </button>
              </Menu.Trigger>
              <Menu.Portal>
                <Menu.Content data-task-row-menu={task.id} align="end" sideOffset={4}
                  onCloseAutoFocus={event => { if (keepMenuFocus.current) { keepMenuFocus.current = false; event.preventDefault(); } }}
                  className="z-50 min-w-48 max-w-72 rounded-lg border border-line bg-surface p-1 shadow-lg">
                  <Menu.Item className={menuItemClassName} onSelect={() => { keepMenuFocus.current = true; ctx.onOpenTask(task.id); }}>
                    <PanelRightOpen size={14} aria-hidden="true" />{t('taskTable.rowActions.openDetails')}
                  </Menu.Item>
                  {movable ? <Menu.Item className={menuItemClassName} onSelect={() => { keepMenuFocus.current = true; ctx.onEditTaskField?.(task, 'sectionId'); }}>
                    <FolderInput size={14} aria-hidden="true" />{t('taskTable.rowActions.moveSection')}
                  </Menu.Item> : null}
                  {canAddChild ? <Menu.Item className={menuItemClassName} onSelect={() => { keepMenuFocus.current = true; ctx.onCreateChild?.(task); }}>
                    <Plus size={14} aria-hidden="true" />{t('taskTable.rowActions.addSubtask')}
                  </Menu.Item> : null}
                  {movableHere ? <>
                    <Menu.Item className={menuItemClassName} disabled={!previous || ctx.move?.blocked === true} onSelect={() => moveBy(-1)}>
                      <ArrowUp size={14} aria-hidden="true" />{t('taskTable.rowActions.moveUp')}
                    </Menu.Item>
                    <Menu.Item className={menuItemClassName} disabled={!next || ctx.move?.blocked === true} onSelect={() => moveBy(1)}>
                      <ArrowDown size={14} aria-hidden="true" />{t('taskTable.rowActions.moveDown')}
                    </Menu.Item>
                  </> : null}
                </Menu.Content>
              </Menu.Portal>
            </Menu.Root>
          </div>
        </div>
      </td>),
    status: td('status', 'statusId', cell('statusId', status === undefined ? <span className="text-muted">{t('taskTable.taskTable.statusUnavailable')}</span> : <span className="flex min-w-0 items-center gap-1.5"><span aria-hidden="true" className={cn('size-2 shrink-0 rounded-full', statusDotClasses[status.group])} /><span className="truncate text-ink-soft" title={status.name}>{status.name}</span></span>)),
    responsible: td('responsible', 'responsibleMembershipId', cell('responsibleMembershipId', task.responsibleMembershipId === null ? <Empty label={t('taskTable.taskTable.unassigned')} /> : <MemberName membershipId={task.responsibleMembershipId} memberById={ctx.memberById} />)),
    participants: td('participants', null, <span className="flex h-8 min-w-0 items-center px-1.5"><ParticipantsCell membershipIds={activeParticipantIds} memberById={ctx.memberById} /></span>),
    dueDate: td('dueDate', 'dueDate', cell('dueDate', <DueDateCell startDate={task.startDate ?? null} dueDate={task.dueDate} today={ctx.today} finished={finished} />)),
    tags: td('tags', 'tagIds', cell('tagIds', <span className="flex h-8 min-w-0 items-center px-1.5"><TagsCell tags={task.tags} /></span>)),
    priority: td('priority', 'priority', cell('priority', <PriorityCell priority={task.priority} />)),
    estimate: td('estimate', 'estimate', cell('estimate', <EstimateCell task={task} summary={ctx.summary} />), cn('text-right lg:bg-surface lg:group-hover:bg-[color-mix(in_srgb,var(--color-canvas)_70%,var(--color-surface))]', ctx.columnIds.at(-1) === 'estimate' && stickyEstimateClassName)),
  };
  return <tr data-task-row={task.id} data-task-drop={drop} data-task-dragging={ctx.draggingTaskId === task.id ? '' : undefined}
    onContextMenu={openMenuFromRow}
    onKeyDown={event => { if ((event.shiftKey && event.key === 'F10') || event.key === 'ContextMenu') openMenuFromRow(event); }}
    aria-selected={ctx.selectRow ? selected : undefined}
    className={cn('group h-10 border-t border-line hover:bg-canvas/70', selected && 'bg-selection', drop === 'before' && 'shadow-[inset_0_2px_0_var(--color-accent)]', drop === 'after' && 'shadow-[inset_0_-2px_0_var(--color-accent)]', ctx.draggingTaskId === task.id && 'opacity-60')}>{ctx.columnIds.map(id => {
    const custom = ctx.customColumns.find(column => column.id === id);
    // Supplied cells bring their own control padding; the row height still bounds them.
    return <Fragment key={id}>{builtinCells[id] ?? (custom ? td(id, null, <div className="flex h-10 min-w-0 items-center overflow-hidden">{custom.renderCell(task)}</div>, 'min-w-0') : null)}</Fragment>;
  })}</tr>;
}

function groupTitle(group: TableTaskGroup): string {
  if (group.kind === 'assignee') return group.membershipId === null ? t('taskTable.taskTable.unassigned') : group.member?.displayName ?? t('taskTable.taskTable.memberUnavailable');
  if (group.kind === 'section' && group.section !== null) return group.section.name;
  if (group.kind === 'missing_section') return t('taskTable.taskTable.sectionUnavailable');
  return t('taskTable.taskTable.noSection');
}

/** Root tasks can be created only in real, active section groups (including No section). */
function acceptsNewTasks(group: TableTaskGroup, writable: boolean): boolean {
  return writable && (group.kind === 'section' || group.kind === 'no_section') && (group.section === null || group.section.archivedAt === null);
}

function addTaskLabel(group: TableTaskGroup): string {
  return group.section === null ? t('taskTable.taskTable.addTaskWithoutASection') : t('taskTable.taskTable.addTaskToValue', { p0: group.section.name });
}

function GroupHeader({
  dropMembershipId,
  dropLine,
  group,
  disclosureTitle,
  disclosurePosition,
  collapsed,
  onToggle,
  writable,
  partial,
  columnCount,
  onCreateTask,
  onRenameSection,
}: {
  /** Assignee group whose header is a group-end drop target; undefined when the header accepts no drop. */
  dropMembershipId: string | undefined;
  /** The current pointer drop is this group's end: drawn as the same bottom line as a row drop. */
  dropLine: boolean;
  group: TableTaskGroup;
  disclosureTitle: string;
  disclosurePosition: number | undefined;
  collapsed: boolean;
  onToggle: () => void;
  writable: boolean;
  partial: boolean;
  columnCount: number;
  onCreateTask: (sectionId?: string | null) => void;
  onRenameSection: ((section: SectionDto) => void) | undefined;
}) {
  const { t } = useTranslation();
  const { section } = group;
  const archived = section !== null && section.archivedAt !== null;
  // An expanded group offers its own persistent Add task row at the end instead.
  const canCreate = collapsed && acceptsNewTasks(group, writable);
  const countText = partial ? t('taskTable.taskTable.loadedValue2', { p0: formatTaskCount(group.taskCount) }) : formatTaskCount(group.taskCount);
  const assignee = group.kind === 'assignee';
  const disclosureLabel = assignee
    ? disclosurePosition === undefined
      ? collapsed ? t('taskTable.grouping.expand', { name: disclosureTitle }) : t('taskTable.grouping.collapse', { name: disclosureTitle })
      : collapsed ? t('taskTable.grouping.expandNumbered', { name: disclosureTitle, position: disclosurePosition }) : t('taskTable.grouping.collapseNumbered', { name: disclosureTitle, position: disclosurePosition })
    : disclosurePosition === undefined
    ? collapsed ? t('taskTable.sections.expand', { section: disclosureTitle }) : t('taskTable.sections.collapse', { section: disclosureTitle })
    : collapsed ? t('taskTable.sections.expandNumbered', { section: disclosureTitle, position: disclosurePosition }) : t('taskTable.sections.collapseNumbered', { section: disclosureTitle, position: disclosurePosition });

  return (
    <tr data-task-group-header={dropMembershipId} data-task-drop={dropLine ? 'after' : undefined}
      className={cn('h-10 border-t border-line bg-canvas', dropLine && 'shadow-[inset_0_-2px_0_var(--color-accent)]')}>
      <th scope="rowgroup" colSpan={columnCount} className="h-10 px-3 py-0 text-left font-normal" style={dropCellStyle(dropLine ? 'after' : undefined)}>
        <div className="flex min-w-0 items-center gap-2">
          <button
            type="button"
            data-task-group={group.key}
            aria-expanded={!collapsed}
            aria-label={disclosureLabel}
            onClick={onToggle}
            className="flex min-h-8 min-w-0 items-center gap-1 rounded text-left text-[13px] font-semibold text-ink hover:text-accent-ink"
          >
            {collapsed ? <ChevronRight size={16} className="shrink-0" aria-hidden="true" /> : <ChevronDown size={16} className="shrink-0" aria-hidden="true" />}
            <span className="truncate" title={disclosureTitle}>{disclosureTitle}</span>
          </button>
          <span className="shrink-0 text-xs text-muted tabular-nums">
            <span aria-hidden="true">{group.taskCount}</span>
            <span className="sr-only">, {countText}</span>
          </span>
          {archived ? <Badge tone="muted">{t('taskTable.taskTable.archivedSection')}</Badge> : null}
          <div className="ml-auto flex shrink-0 items-center gap-1">
            {writable && section !== null && !archived && onRenameSection !== undefined ? (
              <button
                type="button"
                aria-label={t('taskTable.taskTable.renameSectionValue', { p0: section.name })}
                onClick={() => onRenameSection(section)}
                className={cn(iconButtonClassName, 'size-8 text-muted')}
              >
                <Pencil size={14} aria-hidden="true" />
              </button>
            ) : null}
            {canCreate ? (
              <Button
                variant="ghost"
                size="sm"
                aria-label={addTaskLabel(group)}
                onClick={() => onCreateTask(section === null ? null : section.id)}
              >
                <Plus size={14} aria-hidden="true" />
                {t('taskTable.taskTable.task2')}</Button>
            ) : null}
          </div>
        </div>
      </th>
    </tr>
  );
}

function AddTaskRow({ sectionId, label, columnCount, onCreate }: { sectionId: string | null; label: string; columnCount: number; onCreate: () => void }) {
  const { t } = useTranslation();
  return (
    <tr className="h-10 border-t border-line">
      <td colSpan={columnCount} className="h-10 p-0">
        <div className="sticky left-0 flex h-10 w-[min(100cqw,44rem)] max-w-full items-center pr-2 pl-[42px]">
          <button type="button" data-add-task-row={sectionId ?? ''} aria-label={label} onClick={onCreate}
            className="flex h-8 min-w-0 flex-1 items-center gap-2 rounded px-1.5 text-left text-sm text-muted outline-none hover:bg-slate-100 hover:text-ink focus-visible:bg-slate-100 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent">
            <Plus size={14} aria-hidden="true" className="shrink-0" />
            <span className="truncate">{t('taskTable.taskTable.addTaskRow')}</span>
          </button>
        </div>
      </td>
    </tr>
  );
}

function SummaryRow({ summary, partial, columnCount }: { summary: WorkPackageSummary; partial: boolean; columnCount: number }) {
  const { t } = useTranslation();
  const { total } = summary;
  return (
    <tr className="h-11 border-t border-line-strong bg-canvas">
      {/* The text pins to the scroller's visible width (container units), so horizontal browsing keeps it readable. */}
      <td colSpan={columnCount} className="p-0 text-xs text-muted">
        <div data-task-table-summary="" className="sticky left-0 w-[100cqw] px-3 py-1.5">
          <span className="mr-3 inline-flex font-semibold text-ink tabular-nums">{total.status === 'ok' ? formatEstimate(total.minutes) : <Empty label={t('taskTable.taskTable.totalUnavailable')} />}</span>
          <span className="font-medium text-ink-soft">{t('taskTable.taskTable.loadedTeamBudget')}</span>
          <span> {t('taskTable.taskTable.loadedCount', { count: summary.taskCount })}</span>
          <span> {t('taskTable.taskTable.unestimatedCount', { count: summary.unestimatedTaskCount })}</span>
          <span> {t('taskTable.taskTable.sharedWorkBudgetForTheWholeTeam')}</span>
          {partial ? <span> {t('taskTable.taskTable.partialProjectTotalCoversLoadedTasksOnly')}</span> : null}
          {total.status === 'needs_refresh' ? (
            <span className="text-amber-800"> {t('taskTable.taskTable.sharedEstimatesDisagreeRefreshDataToCalculateThe')}</span>
          ) : null}
        </div>
      </td>

    </tr>
  );
}

/**
 * Read-mostly project task table: sections, collapsible subtask hierarchy and the work package
 * budget («Оценка задачи», each package counted once). Data and mutations belong to the parent.
 */
export function TaskTable({
  selectedTaskIds = [],
  onSelectTask, onSelectionChange, selectionDisabled = false, dragScope,
  tasks,
  sections,
  statuses,
  members,
  onOpenTask,
  onCreateTask,
  onCreateChild,
  onRenameSection,
  writable = false,
  partial = false,
  today,
  caption = t('taskTable.taskTable.projectTasks'),
  customColumns = noCustomColumns,
  columnPreset = 'expanded',
  columnIds,
  onEditTaskField, renderTaskFieldEditor, activeFieldEditor, renderCompletionAction, draftTaskIds = new Set(), quickAdd,
  onMoveTask, moveBlocked = false, acquireDragProtection,
  grouping = 'section',
  sortMode = 'manual',
  collapsedTaskIds,
  onTaskCollapsedChange,
  collapsedGroupKeys,
  onGroupCollapsedChange,
  className,
}: TaskTableProps) {
  const { t, locale } = useTranslation();
  const expandedColumns = columnPreset === 'expanded';
  const builtinColumns = [
    { id: 'title', label: t('taskTable.taskTable.task2'), width: 460 },
    { id: 'status', label: t('taskTable.taskTable.status'), width: 144 },
    { id: 'responsible', label: t('taskTable.taskTable.assignee'), width: 176 },
    { id: 'participants', label: t('taskTable.taskTable.participants'), width: 96 },
    { id: 'dueDate', label: t('taskTable.taskTable.dueDate'), width: 128 },
    { id: 'tags', label: t('taskTable.taskTable.tags'), width: 128 },
    { id: 'priority', label: t('taskTable.taskTable.priority'), width: 96 },
    { id: 'estimate', label: t('taskTable.taskTable.teamEstimate'), width: 128 },
  ];
  const byColumnId = new Map([...builtinColumns, ...customColumns].map(column => [column.id, column]));
  const defaultIds = ['title', 'status', 'responsible', ...(expandedColumns ? ['participants'] : []), 'dueDate', ...(expandedColumns ? ['tags', 'priority'] : []), ...customColumns.map(column => column.id), 'estimate'];
  const orderedIds = columnIds ? ['title', ...columnIds.filter(id => id !== 'title')] : defaultIds;
  const columns = orderedIds.flatMap(id => { const column = byColumnId.get(id); return column ? [column] : []; });
  const visibleIds = columns.map(column => column.id);
  const columnCount = columns.length;
  const loadedGroups = useMemo(() => buildTableGroups(tasks, sections, members, grouping, locale, sortMode, writable && onMoveTask !== undefined && sortMode === 'manual'), [tasks, sections, members, grouping, locale, sortMode, writable, onMoveTask]);
  // Retain a captured empty group while its unsent row owns this presentation.
  const capturedPlacement = quickAdd?.placement;
  const groups = useMemo<readonly TableTaskGroup[]>(() => capturedPlacement && !loadedGroups.some(group => group.key === capturedPlacement.groupKey)
    ? [...loadedGroups, { ...capturedPlacement.group, roots: [], taskCount: 0 }] : loadedGroups, [loadedGroups, capturedPlacement]);
  const taskById = useMemo(() => new Map(dedupeTasks(tasks).map(task => [task.id, task])), [tasks]);
  // Widths never depend on an open editor: the grid stays still while any cell is edited.
  const otherColumnsWidth = columns.reduce((sum, column) => sum + (column.id === 'title' ? 0 : column.width), 0);
  const minWidth = `calc(${titleWidth} + ${otherColumnsWidth}px)`;
  const stickyEstimate = visibleIds.at(-1) === 'estimate';
  const columnLine = (id: string): string | undefined => {
    const index = visibleIds.indexOf(id);
    if (id === 'title' || index < 0 || index === visibleIds.length - 1) return undefined;
    // From lg the sticky estimate draws its own leading line.
    return stickyEstimate && index === visibleIds.length - 2 ? 'max-lg:shadow-[inset_-1px_0_0_var(--color-line)]' : gridLineClassName;
  };
  const summary = useMemo(() => summarizeWorkPackages(tasks), [tasks]);
  const statusById = useMemo(() => new Map(statuses.map((status) => [status.id, status])), [statuses]);
  const memberById = useMemo(() => new Map(members.map((member) => [member.id, member])), [members]);
  const sectionById = useMemo(() => new Map(sections.map((section) => [section.id, section])), [sections]);
  const [localCollapsedIds, setLocalCollapsedIds] = useState<ReadonlySet<string>>(() => new Set());
  const collapsedIds = collapsedTaskIds ?? localCollapsedIds;
  const [localCollapsedGroups, setLocalCollapsedGroups] = useState<ReadonlySet<string>>(() => new Set());
  const collapsedGroups = collapsedGroupKeys ?? localCollapsedGroups;
  const changeGroup = (key: string, collapsed: boolean) => {
    if (onGroupCollapsedChange) { onGroupCollapsedChange(key, collapsed); return; }
    setLocalCollapsedGroups(before => {
      const next = new Set(before);
      if (collapsed) next.add(key); else next.delete(key);
      return next;
    });
  };
  // Duplicate stored names (including unavailable sections) need distinct disclosure names.
  const titles = groups.map(groupTitle);
  const titleCounts = new Map<string, number>();
  for (const title of titles) titleCounts.set(title, (titleCounts.get(title) ?? 0) + 1);

  const onToggle = useCallback((taskId: string) => {
    if (onTaskCollapsedChange) { onTaskCollapsedChange(taskId, !collapsedIds.has(taskId)); return; }
    setLocalCollapsedIds((previous) => {
      const next = new Set(previous);
      if (next.has(taskId)) next.delete(taskId);
      else next.add(taskId);
      return next;
    });
  }, [collapsedIds, onTaskCollapsedChange]);

  // Manual Section order preserves sibling scope; Assignee order is a flat project sequence.
  const moveEnabled = onMoveTask !== undefined && writable && sortMode === 'manual';
  const treeOrder = useMemo(() => groups.flatMap(group => visibleTaskRows(group.roots, new Set()).map(node => node.task)), [groups]);
  const activeSection = (sectionId: string | null) => sectionId === null || sectionById.get(sectionId)?.archivedAt === null;
  const siblingsOf = (task: TaskDto) => treeOrder.filter(item => grouping === 'assignee' ? item.responsibleMembershipId === task.responsibleMembershipId : item.parentTaskId === task.parentTaskId && item.sectionId === task.sectionId);
  const dropAllowed = (source: TaskDto, anchor: TaskDto, placement: TaskDropPlacement): boolean => {
    if (grouping === 'assignee' && anchor.responsibleMembershipId !== null && !memberById.has(anchor.responsibleMembershipId)) return false;
    if (anchor.id === source.id || (grouping === 'section' && anchor.parentTaskId !== source.parentTaskId) || !canEditTaskInline(anchor) || !activeSection(anchor.sectionId)) return false;
    if (grouping === 'assignee') {
      if (anchor.responsibleMembershipId !== source.responsibleMembershipId) return true;
    } else if (anchor.sectionId !== source.sectionId) return source.parentTaskId === null;
    if (partial) return true;
    const siblings = siblingsOf(source);
    const index = siblings.findIndex(item => item.id === source.id);
    // Dropping right next to itself changes nothing and sends nothing.
    return placement === 'after' ? siblings[index - 1]?.id !== anchor.id : siblings[index + 1]?.id !== anchor.id;
  };
  const commitMove = (source: TaskDto, anchor: TaskDto | null, placement: TaskDropPlacement, target?: { responsibleMembershipId: string | null }) => {
    if (!moveEnabled || moveBlocked || !canEditTaskInline(source) || !activeSection(source.sectionId)) return;
    if (anchor && !dropAllowed(source, anchor, placement)) return;
    if (!anchor && target === undefined) return;
    if (target && (grouping !== 'assignee' || (target.responsibleMembershipId !== null && !memberById.has(target.responsibleMembershipId)) || (anchor && anchor.responsibleMembershipId !== target.responsibleMembershipId))) return;
    if (target) onMoveTask?.(source, anchor, placement, target);
    else onMoveTask?.(source, anchor, placement);
  };
  const { drag, startDrag } = usePointerRowDrag({ taskById, dropAllowed, blocked: moveBlocked || !moveEnabled, acquireProtection: acquireDragProtection, contextKey: `${dragScope ?? ''}:${grouping}:${sortMode}`,
    onMove: (source, anchor, placement) => commitMove(source, anchor, placement),
    resolveDrop: grouping !== 'assignee' ? undefined : (source, over, point) => {
      const body = over?.closest<HTMLElement>('[data-task-assignee-group]');
      if (!body || !moveEnabled || moveBlocked) return null;
      const memberId = body.dataset.taskAssigneeGroup || null;
      if (memberId !== null && !memberById.has(memberId)) return null;
      const element = over?.closest<HTMLElement>('tr[data-task-row]');
      if (element) {
        // A confirmed row the list has not loaded yet is no anchor and no group end.
        const anchor = taskById.get(element.dataset.taskRow ?? '');
        if (!anchor) return null;
        const rect = element.getBoundingClientRect();
        const placement = point.y < rect.top + rect.height / 2 ? 'before' : 'after';
        return dropAllowed(source, anchor, placement) ? { taskId: anchor.id, placement, responsibleMembershipId: memberId } : null;
      }
      // Only the group header (expanded or collapsed) and the empty-group row mean the group end; draft rows do not.
      if (!over?.closest('tr[data-task-group-header], tr[data-task-group-drop]')) return null;
      return { taskId: null, placement: 'after', responsibleMembershipId: memberId };
    },
    onDrop: (source, target) => {
      const anchor = target.taskId ? taskById.get(target.taskId) ?? null : null;
      commitMove(source, anchor, target.placement, target.responsibleMembershipId === undefined ? undefined : { responsibleMembershipId: target.responsibleMembershipId });
    },
  });
  const selectionAnchor = useRef<string | null>(null);
  const [selectionLimit, setSelectionLimit] = useState(false);
  const selectRow = onSelectionChange || onSelectTask ? (id: string, modifiers: SelectionModifiers) => {
    if (selectionDisabled) return;
    const visible = groups.flatMap(group => collapsedGroups.has(group.key) ? [] : visibleTaskRows(group.roots, collapsedIds).map(node => node.task.id));
    const next = selectTaskRows(selectedTaskIds, visible, selectionAnchor.current, id, modifiers);
    setSelectionLimit(next.limitReached === true);
    if (next.limitReached) return;
    selectionAnchor.current = next.anchor;
    if (onSelectionChange) onSelectionChange(next.ids);
    else { for (const changed of new Set([...selectedTaskIds, ...next.ids])) if (selectedTaskIds.includes(changed) !== next.ids.includes(changed)) onSelectTask?.(changed, next.ids.includes(changed)); }
  } : undefined;
  const move: RowMove | null = moveEnabled ? {
    canMove: task => canEditTaskInline(task) && activeSection(task.sectionId),
    blocked: moveBlocked,
    neighbour: (task, direction) => {
      const siblings = siblingsOf(task);
      const candidate = siblings[siblings.findIndex(item => item.id === task.id) + direction];
      return candidate && dropAllowed(task, candidate, direction < 0 ? 'before' : 'after') ? candidate : undefined;
    },
    move: (task, anchor, placement) => commitMove(task, anchor, placement, grouping === 'assignee' ? { responsibleMembershipId: anchor.responsibleMembershipId } : undefined),
    startDrag,
  } : null;

  const ctx: RowContext = {
    move, dropTarget: drag?.target ?? null, draggingTaskId: drag?.taskId ?? null,
    grouping, taskById,
    selectedTaskIds,
    onSelectTask, selectRow, selectionDisabled,
    statusById,
    memberById,
    sectionById,
    summary,
    collapsedIds,
    onToggle,
    onOpenTask,
    onCreateChild: writable ? onCreateChild : null,
    partial,
    today,
    customColumns,
    columnIds: visibleIds,
    onEditTaskField: writable ? onEditTaskField : undefined,
    renderTaskFieldEditor, renderCompletionAction, draftTaskIds,
    columnLine,
    activeFieldEditor: activeFieldEditor && taskById.has(activeFieldEditor.taskId) ? activeFieldEditor : undefined,
  };
  const quickAddRow = (content: ReactNode) => <tr data-quick-add-row="" className="h-10 border-t border-line bg-surface"><td colSpan={columnCount} className="h-10 p-0"><div className="sticky left-0 flex h-10 w-[min(100cqw,44rem)] max-w-full items-center pr-2 pl-[42px]">{content}</div></td></tr>;
  // A draft is a normal row of the same grid: one cell per visible column, same widths and sticky edges.
  const draftRow = (depth: number) => (state: TaskTableDraftRowState): TaskTableDraftRow => renderCell => (
    <tr data-task-draft-row="" data-task-draft-state={state} data-quick-add-row={state === 'draft' ? '' : undefined}
      aria-busy={state === 'pending' || undefined} className={cn('group h-10 border-t border-line', state === 'draft' ? 'bg-surface' : 'text-muted')}>
      {visibleIds.map(id => id === 'title' ? (
        <td key={id} className={titleCellClassName} style={{ paddingLeft: 12 }}>
          <div className="flex h-10 min-w-0 items-center gap-1">
            {selectRow ? <span aria-hidden="true" className="mr-1 h-8 w-8 shrink-0" /> : null}
            <div className="flex min-w-0 flex-1 items-center gap-1" style={{ paddingLeft: Math.min(depth, 2) * 20 }}>
              <span aria-hidden="true" className="size-6 shrink-0" />
              {renderCell(id)}
            </div>
          </div>
        </td>
      ) : (
        <td key={id} className={cn(cellClassName, columnLine(id), id === 'estimate' && cn('text-right lg:bg-surface', stickyEstimate && stickyEstimateClassName))}>
          <div className="flex h-10 min-w-0 items-center overflow-hidden">{renderCell(id)}</div>
        </td>
      ))}
    </tr>
  );
  // Confirmed rows the list has not loaded yet stay in place, read-only, so the next input never jumps.
  const confirmedCtx: RowContext = { ...ctx, onEditTaskField: undefined, renderTaskFieldEditor: undefined, activeFieldEditor: undefined, onCreateChild: null, move: null, renderCompletionAction: () => <span aria-hidden="true" className="size-7 shrink-0" /> };
  const quickRows = (group: TableTaskGroup | null, depth: number): ReactNode => quickAdd ? <>
    {group === null ? null : (quickAdd.confirmedTasks ?? []).filter(task => !taskById.has(task.id)).map(task => <TaskRow key={task.id} node={{ task, depth, children: [], detachedReason: null }} group={group} ctx={confirmedCtx} />)}
    {quickAdd.render ? quickAdd.render(draftRow(depth)) : quickAddRow(quickAdd.content)}
  </> : null;
  // The visible group row the anchored rows follow: after the anchor and its whole visible subtree.
  const anchored = (() => {
    if (quickAdd?.placement) {
      const resolved = resolveDraftPlacement(quickAdd.placement, groups, collapsedIds);
      const group = groups.find(item => item.key === resolved.groupKey);
      const rows = group ? visibleTaskRows(group.roots, collapsedIds) : [];
      const index = resolved.position.taskId === null ? -1 : rows.findIndex(node => node.task.id === resolved.position.taskId);
      return { groupKey: resolved.groupKey, end: index < 0 ? 0 : index + (resolved.position.placement === 'after' ? 1 : 0), depth: resolved.depth };
    }
    const anchorId = grouping === 'section' ? quickAdd?.afterTaskId : undefined;
    if (!anchorId) return null;
    for (const group of groups) {
      if (collapsedGroups.has(group.key)) continue;
      const rows = visibleTaskRows(group.roots, collapsedIds);
      const index = rows.findIndex(node => node.task.id === anchorId);
      const anchor = rows[index];
      if (!anchor) continue;
      let end = index + 1;
      while (end < rows.length && (rows[end]?.depth ?? 0) > anchor.depth) end += 1;
      // Rows anchored on their own parent (its first subtask) sit one level below it.
      const depth = !quickAdd?.parentTaskId ? 0 : quickAdd.parentTaskId === anchorId ? anchor.depth + 1 : anchor.depth;
      return { groupKey: group.key, end, depth };
    }
    return null;
  })();

  return (
    <div data-task-table-scroll="" className={cn('@container relative min-w-0 overflow-auto rounded-2xl border border-line bg-surface', className)}>
      {selectionLimit ? <div role="status" className="fixed right-3 bottom-24 z-[70] max-w-sm rounded-lg border border-line bg-surface p-3 text-sm shadow-lg">{t('taskTable.selection.limit')}<Button size="sm" variant="ghost" onClick={() => setSelectionLimit(false)}>{t('taskTable.selection.dismiss')}</Button></div> : null}
      {drag ? <TaskDragPreview task={drag.task} pointer={drag.pointer} /> : null}
      <table className="w-full table-fixed border-collapse text-left text-sm" style={{ minWidth }}>
        <caption className="sr-only">{caption}</caption>
        <colgroup>{columns.map(column => <col key={column.id} style={{ width: column.id === 'title' ? titleWidth : column.width }} />)}</colgroup>
        <thead className="sticky top-0 z-10 bg-surface text-xs text-muted shadow-[inset_0_-1px_0_var(--color-line)]"><tr className="h-9">{columns.map((column, index) => <th key={column.id} scope="col" className={cn('h-9 overflow-hidden whitespace-nowrap px-3 font-medium transition-colors hover:bg-canvas hover:text-ink-soft', columnLine(column.id), column.id === 'title' && 'max-lg:shadow-[inset_-1px_0_0_var(--color-line)] lg:sticky lg:left-0 lg:z-[1] lg:bg-surface lg:shadow-[inset_-1px_0_0_var(--color-line)]', column.id === 'estimate' && 'text-right', column.id === 'estimate' && index === columns.length - 1 && 'lg:sticky lg:right-0 lg:z-[1] lg:bg-surface')}><span className="flex min-w-0 items-center">{column.id === 'title' && selectRow ? <span aria-hidden="true" className="mr-1 w-8 shrink-0 pr-1 text-center text-[10px] text-subtle"></span> : null}<span className={cn('block truncate', column.id === 'title' && 'pl-[30px]')} title={column.label}>{column.label}</span></span></th>)}</tr></thead>
        {groups.length === 0 ? <tbody><tr><td colSpan={columnCount} className="px-3 py-3 text-sm text-muted">{t('taskTable.grouping.empty')}</td></tr></tbody> : null}
        {groups.map((group, index) => {
          const collapsed = collapsedGroups.has(group.key);
          const rows = visibleTaskRows(group.roots, collapsedIds);
          const items: ReactNode[] = collapsed ? [] : rows.map((node) => <TaskRow key={node.task.id} node={node} group={group} ctx={ctx} />);
          // One keyed block among the rows: when the list grows above it, the block (and its
          // unsent input, focus and selection) stays mounted instead of being recreated.
          if (!collapsed && anchored?.groupKey === group.key) items.splice(anchored.end, 0, <Fragment key={quickAdd?.placement?.blockKey ?? 'quick-add'}>{quickRows(group, anchored.depth)}</Fragment>);
          const emptyRow = !collapsed && items.length === 0;
          // A null-anchor group-end drop is drawn on the empty-group row, otherwise on the header.
          const groupEnd = group.kind === 'assignee' && drag?.target?.taskId === null && drag.target.responsibleMembershipId === group.membershipId;
          return (
            <tbody key={group.key} data-task-assignee-group={group.kind === 'assignee' ? group.membershipId ?? '' : undefined}>
              <GroupHeader
                dropMembershipId={group.kind === 'assignee' && moveEnabled ? group.membershipId ?? '' : undefined}
                dropLine={groupEnd && !emptyRow}
                group={group}
                disclosureTitle={titles[index] ?? groupTitle(group)}
                disclosurePosition={(titleCounts.get(titles[index] ?? '') ?? 0) > 1 ? index + 1 : undefined}
                collapsed={collapsed}
                onToggle={() => changeGroup(group.key, !collapsed)}
                writable={writable}
                partial={partial}
                columnCount={columnCount}
                onCreateTask={sectionId => {
                  // A controlled page expands its actual retained quick-create target itself.
                  if (collapsedGroupKeys === undefined) changeGroup(group.key, false);
                  onCreateTask(sectionId);
                }}
                onRenameSection={onRenameSection}
              />
              {collapsed ? null : emptyRow
                ? <tr data-task-group-drop={group.kind === 'assignee' ? group.membershipId ?? '' : undefined} data-task-drop={groupEnd ? 'after' : undefined} className={cn('h-10 border-t border-line', groupEnd && 'shadow-[inset_0_-2px_0_var(--color-accent)]')}><td colSpan={columnCount} className="h-10 py-0 pr-3 pl-[42px] text-sm text-muted" style={dropCellStyle(groupEnd ? 'after' : undefined)}>{group.kind === 'assignee' && moveEnabled ? t('taskTable.move.emptyGroup', { name: groupTitle(group) }) : partial ? t('taskTable.taskTable.noLoadedTasksInThisSection') : t('taskTable.taskTable.noTasksYet')}</td></tr>
                : items}
              {/* Asana-style: the quick row, or a persistent Add task row, closes every expanded section. */}
              {grouping !== 'section' || collapsed ? null : anchored === null && quickAdd?.sectionId === group.sectionId ? quickRows(group, 0)
                : acceptsNewTasks(group, writable) ? <AddTaskRow sectionId={group.sectionId} label={addTaskLabel(group)} columnCount={columnCount} onCreate={() => onCreateTask(group.sectionId)} /> : null}
            </tbody>
          );
        })}
        {grouping === 'section' && quickAdd && anchored === null && !groups.some(group => group.sectionId === quickAdd.sectionId) ? <tbody>{quickRows(null, 0)}</tbody> : null}
        <tfoot className="sticky bottom-0 z-10">
          <SummaryRow summary={summary} partial={partial} columnCount={columnCount} />
        </tfoot>
      </table>
    </div>
  );
}
