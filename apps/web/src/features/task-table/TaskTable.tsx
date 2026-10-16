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
import { ChevronDown, ChevronRight, Flag, Link2, Pencil, Plus, TriangleAlert, UserRound } from 'lucide-react';
import { useCallback, useMemo, useState, type ReactNode } from 'react';
import { formatEstimate } from './estimate';
import { buildTaskGroups, visibleTaskRows, type TaskGroup, type TaskTreeNode } from './taskTree';
import { summarizeWorkPackages, type WorkPackageSummary } from './workPackages';

/** A column supplied by the parent, shown after «Приоритет» and before the estimate. */
export interface TaskTableCustomColumn {
  /** Stable key, e.g. the field ID. */
  id: string;
  label: string;
  /** Column width in pixels. */
  width: number;
  renderCell: (task: TaskDto) => ReactNode;
}

export interface TaskTableProps {
  selectedTaskIds?: readonly string[] | undefined;
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
  className?: string | undefined;
}

const COLUMN_COUNT = 8;
/** Width of the built-in columns at the minimum table width: title 360px plus 800px. */
const BASE_MIN_WIDTH = 1160;
const noCustomColumns: readonly TaskTableCustomColumn[] = [];

/** Icon-only control; callers add its size and text color. */
const iconButtonClassName =
  'inline-flex shrink-0 items-center justify-center rounded-md transition-colors hover:bg-slate-100 hover:text-ink';

/**
 * From `lg` the estimate column sticks to the right edge, so the header, every task estimate and
 * the total stay in view while the wider table scrolls. Small screens keep plain local scrolling.
 */
const stickyEstimateClassName =
  'lg:sticky lg:right-0 lg:z-[1] lg:shadow-[inset_1px_0_0_var(--color-line),-8px_0_8px_-8px_rgb(15_23_42/0.18)]';

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

function DueDateCell({ dueDate, today, finished }: { dueDate: string | null; today: string | undefined; finished: boolean }) {
  const { t } = useTranslation();
  if (dueDate === null) return <Empty label={t('taskTable.taskTable.noDueDate')} />;
  const date = calendarDate(dueDate);
  const referenceYear = today === undefined ? new Date().getFullYear() : calendarDate(today).getUTCFullYear();
  const text =
    date.getUTCFullYear() === referenceYear ? dayMonthFormat.format(date) : fullDateFormat.format(date);
  const overdue = today !== undefined && !finished && dueDate < today;
  return (
    <time
      dateTime={dueDate}
      title={longDateFormat.format(date)}
      className={cn('tabular-nums', overdue ? 'font-medium text-rose-700' : 'text-ink-soft')}
    >
      {text}
      {overdue ? <span className="sr-only">{t('taskTable.taskTable.overdue')}</span> : null}
    </time>
  );
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
  selectedTaskIds: readonly string[];
  onSelectTask: ((id: string, selected: boolean) => void) | undefined;
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
  expandedColumns: boolean;
}

function sectionLabel(sectionId: string | null, sectionById: ReadonlyMap<string, SectionDto>): string {
  if (sectionId === null) return t('taskTable.taskTable.noSection');
  return sectionById.get(sectionId)?.name ?? t('taskTable.taskTable.sectionUnavailable');
}

function TaskRow({ node, group, ctx }: { node: TaskTreeNode; group: TaskGroup; ctx: RowContext }) {
  const { t } = useTranslation();
  const { task } = node;
  const status = ctx.statusById.get(task.statusId);
  const childCount = node.children.length;
  const expanded = !ctx.collapsedIds.has(task.id);
  const finished = status?.group === 'done' || status?.group === 'cancelled';
  const showSection = node.depth > 0 && task.sectionId !== group.sectionId;
  const activeParticipantIds = [
    ...new Set(task.participants.filter((participant) => participant.active).map((participant) => participant.membershipId)),
  ];
  const childCountText = ctx.partial ? t('taskTable.taskTable.loadedValue', { p0: formatSubtaskCount(childCount) }) : formatSubtaskCount(childCount);

  return (
    <tr className="group h-11 border-t border-line hover:bg-canvas/70">
      <td
        className="py-1 pr-3 lg:sticky lg:left-0 lg:z-[1] lg:bg-surface lg:shadow-[inset_-1px_0_0_var(--color-line),8px_0_8px_-8px_rgb(15_23_42/0.18)] lg:group-hover:bg-[color-mix(in_srgb,var(--color-canvas)_70%,var(--color-surface))]"
        style={{ paddingLeft: `${12 + node.depth * 20}px` }}>
        <div className="flex min-w-0 items-center gap-1.5">
          {ctx.onSelectTask ? <input type="checkbox" aria-label={t('taskTable.taskTable.selectForGraphValue', { p0: task.title })} checked={ctx.selectedTaskIds.includes(task.id)} disabled={ctx.selectedTaskIds.length >= 100 && !ctx.selectedTaskIds.includes(task.id)} onChange={event => ctx.onSelectTask?.(task.id, event.target.checked)} /> : null}
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
          ) : (
            <span aria-hidden="true" className="size-6 shrink-0" />
          )}
          {node.depth > 0 ? <span className="sr-only">{t('taskTable.taskTable.subtask2')}</span> : null}
          <button
            type="button"
            onClick={() => ctx.onOpenTask(task.id)}
            title={task.title}
            className={cn(
              'min-w-0 truncate rounded-sm text-left text-sm font-medium hover:text-accent-ink hover:underline',
              finished ? 'text-muted' : 'text-ink',
            )}
          >
            {task.title}
          </button>
          {childCount > 0 ? (
            <span className="shrink-0 text-xs text-muted tabular-nums" title={childCountText}>
              <span aria-hidden="true">{childCount}</span>
              <span className="sr-only">{childCountText}</span>
            </span>
          ) : null}
          {node.detachedReason === 'parent_not_loaded' ? (
            <Badge tone="muted" title={t('taskTable.taskTable.parentTaskIsOutsideTheLoadedSet')}>
              {t('taskTable.taskTable.subtask3')}<span className="sr-only">{t('taskTable.taskTable.parentTaskNotLoaded')}</span>
            </Badge>
          ) : null}
          {node.detachedReason === 'cycle' ? (
            <Badge tone="warning" title={t('taskTable.taskTable.parentRelationshipsFormACycleRefreshData')}>
              {t('taskTable.taskTable.hierarchyCycle')}</Badge>
          ) : null}
          {showSection ? (
            <Badge tone="muted" className="min-w-0 max-w-40">
              <span className="min-w-0 truncate">{t('taskTable.taskTable.sectionName', { name: sectionLabel(task.sectionId, ctx.sectionById) })}</span>
            </Badge>
          ) : null}
          {task.meetingId ? <Badge tone="muted">{t('taskTable.taskTable.meeting')}</Badge> : null}
          {task.archivedAt !== null ? <Badge tone="muted">{t('taskTable.taskTable.archived2')}</Badge> : null}
          {ctx.onCreateChild !== null && task.archivedAt === null && task.meetingId === null ? (
            <button
              type="button"
              aria-label={t('taskTable.taskTable.addSubtaskToValue', { p0: task.title })}
              onClick={() => ctx.onCreateChild?.(task)}
              className={cn(iconButtonClassName, 'ml-auto size-7 text-subtle group-hover:text-muted')}
            >
              <Plus size={16} aria-hidden="true" />
            </button>
          ) : null}
        </div>
      </td>
      <td className="px-3 py-1">
        {status === undefined ? (
          <span className="text-muted">{t('taskTable.taskTable.statusUnavailable')}</span>
        ) : (
          <span className="flex min-w-0 items-center gap-1.5">
            <span aria-hidden="true" className={cn('size-2 shrink-0 rounded-full', statusDotClasses[status.group])} />
            <span className="truncate text-ink-soft" title={status.name}>{status.name}</span>
          </span>
        )}
      </td>
      <td className="px-3 py-1">
        {task.responsibleMembershipId === null ? (
          <Empty label={t('taskTable.taskTable.unassigned')} />
        ) : (
          <MemberName membershipId={task.responsibleMembershipId} memberById={ctx.memberById} />
        )}
      </td>
      {ctx.expandedColumns ? <td className="px-3 py-1">
        <ParticipantsCell membershipIds={activeParticipantIds} memberById={ctx.memberById} />
      </td> : null}
      <td className="px-3 py-1">
        <DueDateCell dueDate={task.dueDate} today={ctx.today} finished={finished} />
      </td>
      {ctx.expandedColumns ? <td className="px-3 py-1">
        <TagsCell tags={task.tags} />
      </td> : null}
      {ctx.expandedColumns ? <td className="px-3 py-1">
        <PriorityCell priority={task.priority} />
      </td> : null}
      {ctx.customColumns.map((column) => (
        <td key={column.id} className="min-w-0 overflow-hidden px-3 py-1">
          {column.renderCell(task)}
        </td>
      ))}
      <td
        className={cn(
          'px-3 py-1 text-right',
          stickyEstimateClassName,
          // Opaque copies of the row backgrounds, so scrolled cells never show through.
          'lg:bg-surface lg:group-hover:bg-[color-mix(in_srgb,var(--color-canvas)_70%,var(--color-surface))]',
        )}
      >
        <EstimateCell task={task} summary={ctx.summary} />
      </td>
    </tr>
  );
}

function groupTitle(group: TaskGroup): string {
  if (group.kind === 'section' && group.section !== null) return group.section.name;
  if (group.kind === 'missing_section') return t('taskTable.taskTable.sectionUnavailable');
  return t('taskTable.taskTable.noSection');
}

function GroupHeader({
  group,
  writable,
  partial,
  columnCount,
  onCreateTask,
  onRenameSection,
}: {
  group: TaskGroup;
  writable: boolean;
  partial: boolean;
  columnCount: number;
  onCreateTask: (sectionId?: string | null) => void;
  onRenameSection: ((section: SectionDto) => void) | undefined;
}) {
  const { t } = useTranslation();
  const title = groupTitle(group);
  const { section } = group;
  const archived = section !== null && section.archivedAt !== null;
  const canCreate = writable && group.kind !== 'missing_section' && !archived;
  const countText = partial ? t('taskTable.taskTable.loadedValue2', { p0: formatTaskCount(group.taskCount) }) : formatTaskCount(group.taskCount);

  return (
    <tr className="h-10 border-t border-line bg-canvas">
      <th scope="rowgroup" colSpan={columnCount} className="px-3 py-1 text-left font-normal">
        <div className="flex min-w-0 items-center gap-2">
          <span className="truncate text-[13px] font-semibold text-ink">{title}</span>
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
                aria-label={section === null ? t('taskTable.taskTable.addTaskWithoutASection') : t('taskTable.taskTable.addTaskToValue', { p0: section.name })}
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

function SummaryRow({ summary, partial, columnCount }: { summary: WorkPackageSummary; partial: boolean; columnCount: number }) {
  const { t } = useTranslation();
  const { total } = summary;
  return (
    <tr className="h-11 border-t border-line-strong bg-canvas">
      <td colSpan={columnCount - 1} className="px-3 py-1.5 text-xs text-muted">
        <span className="font-medium text-ink-soft">{t('taskTable.taskTable.loadedTeamBudget')}</span>
        <span> {t('taskTable.taskTable.sharedWorkBudgetForTheWholeTeam')}</span>
        <span> {t('taskTable.taskTable.loadedCount', { count: summary.taskCount })}</span>
        <span> {t('taskTable.taskTable.unestimatedCount', { count: summary.unestimatedTaskCount })}</span>
        {partial ? <span> {t('taskTable.taskTable.partialProjectTotalCoversLoadedTasksOnly')}</span> : null}
        {total.status === 'needs_refresh' ? (
          <span className="text-amber-800"> {t('taskTable.taskTable.sharedEstimatesDisagreeRefreshDataToCalculateThe')}</span>
        ) : null}
      </td>
      <td
        className={cn(
          'px-3 py-1.5 text-right text-sm font-semibold text-ink tabular-nums',
          stickyEstimateClassName,
          'lg:bg-canvas',
        )}
      >
        {total.status === 'ok' ? formatEstimate(total.minutes) : <Empty label={t('taskTable.taskTable.totalUnavailable')} />}
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
  onSelectTask,
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
  className,
}: TaskTableProps) {
  const { t, locale } = useTranslation();
  const expandedColumns = columnPreset === 'expanded';
  const columnCount = (expandedColumns ? COLUMN_COUNT : 5) + customColumns.length;
  const minWidth = (expandedColumns ? BASE_MIN_WIDTH : 820) + customColumns.reduce((sum, column) => sum + column.width, 0);
  const groups = useMemo(() => buildTaskGroups(tasks, sections, locale), [tasks, sections, locale]);
  const summary = useMemo(() => summarizeWorkPackages(tasks), [tasks]);
  const statusById = useMemo(() => new Map(statuses.map((status) => [status.id, status])), [statuses]);
  const memberById = useMemo(() => new Map(members.map((member) => [member.id, member])), [members]);
  const sectionById = useMemo(() => new Map(sections.map((section) => [section.id, section])), [sections]);
  const [collapsedIds, setCollapsedIds] = useState<ReadonlySet<string>>(() => new Set());

  const onToggle = useCallback((taskId: string) => {
    setCollapsedIds((previous) => {
      const next = new Set(previous);
      if (next.has(taskId)) next.delete(taskId);
      else next.add(taskId);
      return next;
    });
  }, []);

  const ctx: RowContext = {
    selectedTaskIds,
    onSelectTask,
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
    expandedColumns,
  };

  return (
    <div className={cn('relative min-w-0 overflow-auto rounded-2xl border border-line bg-surface', className)}>
      <table className="w-full table-fixed border-collapse text-left text-sm" style={{ minWidth }}>
        <caption className="sr-only">{caption}</caption>
        <colgroup>
          <col />
          <col style={{ width: 144 }} />
          <col style={{ width: 176 }} />
          {expandedColumns ? <col className="w-24" /> : null}
          <col style={{ width: 112 }} />
          {expandedColumns ? <col className="w-32" /> : null}
          {expandedColumns ? <col className="w-24" /> : null}
          {customColumns.map(column => <col key={column.id} style={{ width: column.width }} />)}
          <col className="w-32" />
        </colgroup>
        <thead className="sticky top-0 z-10 bg-surface text-xs text-muted shadow-[inset_0_-1px_0_var(--color-line)]">
          <tr className="h-9">
            <th
              scope="col"
              className="px-3 font-medium lg:sticky lg:left-0 lg:z-[1] lg:bg-surface lg:shadow-[inset_-1px_0_0_var(--color-line),inset_0_-1px_0_var(--color-line),8px_0_8px_-8px_rgb(15_23_42/0.18)]"
            >
              <span className="pl-[30px]">{t('taskTable.taskTable.task2')}</span>
            </th>
            <th scope="col" className="px-3 font-medium">
              {t('taskTable.taskTable.status')}</th>
            <th scope="col" className="px-3 font-medium">
              {t('taskTable.taskTable.assignee')}</th>
            {expandedColumns ? <th scope="col" className="px-3 font-medium">
              {t('taskTable.taskTable.participants')}</th> : null}
            <th scope="col" className="px-3 font-medium">
              {t('taskTable.taskTable.dueDate')}</th>
            {expandedColumns ? <th scope="col" className="px-3 font-medium">
              {t('taskTable.taskTable.tags')}</th> : null}
            {expandedColumns ? <th scope="col" className="px-3 font-medium">
              {t('taskTable.taskTable.priority')}</th> : null}
            {customColumns.map((column) => (
              <th key={column.id} scope="col" className="px-3 font-medium">
                <span className="block truncate" title={column.label}>
                  {column.label}
                </span>
              </th>
            ))}
            {/* Same as `stickyEstimateClassName`, plus the header's bottom line its background would cover. */}
            <th
              scope="col"
              className="px-3 text-right font-medium lg:sticky lg:right-0 lg:z-[1] lg:bg-surface lg:shadow-[inset_1px_0_0_var(--color-line),inset_0_-1px_0_var(--color-line),-8px_0_8px_-8px_rgb(15_23_42/0.18)]"
            >
              {t('taskTable.taskTable.teamEstimate')}</th>
          </tr>
        </thead>
        {groups.map((group) => {
          const rows = visibleTaskRows(group.roots, collapsedIds);
          return (
            <tbody key={group.key}>
              <GroupHeader
                group={group}
                writable={writable}
                partial={partial}
                columnCount={columnCount}
                onCreateTask={onCreateTask}
                onRenameSection={onRenameSection}
              />
              {rows.length === 0 ? (
                <tr className="h-11 border-t border-line">
                  <td colSpan={columnCount} className="py-1 pr-3 pl-[42px] text-sm text-muted">
                    {partial ? t('taskTable.taskTable.noLoadedTasksInThisSection') : t('taskTable.taskTable.noTasksYet')}
                  </td>
                </tr>
              ) : (
                rows.map((node) => <TaskRow key={node.task.id} node={node} group={group} ctx={ctx} />)
              )}
            </tbody>
          );
        })}
        <tfoot className="sticky bottom-0 z-10">
          <SummaryRow summary={summary} partial={partial} columnCount={columnCount} />
        </tfoot>
      </table>
    </div>
  );
}
