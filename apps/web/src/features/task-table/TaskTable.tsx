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
import { pluralizeRu } from '../../lib/format';
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
  low: { label: 'Низкий', className: 'text-muted' },
  medium: { label: 'Средний', className: 'text-ink-soft' },
  high: { label: 'Высокий', className: 'text-amber-700' },
  urgent: { label: 'Срочный', className: 'text-rose-700' },
};

function formatTaskCount(count: number): string {
  return pluralizeRu(count, { one: 'задача', few: 'задачи', many: 'задач' });
}

function formatSubtaskCount(count: number): string {
  return pluralizeRu(count, { one: 'подзадача', few: 'подзадачи', many: 'подзадач' });
}

const dayMonthFormat = new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'short', timeZone: 'UTC' });
const fullDateFormat = new Intl.DateTimeFormat('ru-RU', {
  day: '2-digit',
  month: '2-digit',
  year: 'numeric',
  timeZone: 'UTC',
});
const longDateFormat = new Intl.DateTimeFormat('ru-RU', { dateStyle: 'long', timeZone: 'UTC' });

function calendarDate(value: string): Date {
  const [year = 0, month = 1, day = 1] = value.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day));
}

function Empty({ label }: { label: string }) {
  return (
    <>
      <span aria-hidden="true" className="text-subtle">
        —
      </span>
      <span className="sr-only">{label}</span>
    </>
  );
}

const UNKNOWN_MEMBER = 'Участник недоступен';

function MemberName({ membershipId, memberById }: { membershipId: string; memberById: ReadonlyMap<string, MembershipDto> }) {
  const member = memberById.get(membershipId);
  if (member === undefined) {
    return (
      <span className="flex min-w-0 items-center gap-2 text-muted">
        <span className="inline-flex size-6 shrink-0 items-center justify-center rounded-full bg-slate-100">
          <UserRound size={14} aria-hidden="true" />
        </span>
        <span className="truncate">{UNKNOWN_MEMBER}</span>
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
  const [first] = membershipIds;
  if (first === undefined) return <Empty label="Нет участников" />;
  if (membershipIds.length === 1) return <MemberName membershipId={first} memberById={memberById} />;

  const names = membershipIds.map((id) => memberById.get(id)?.displayName ?? UNKNOWN_MEMBER);
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
      {archived ? <span className="shrink-0 text-subtle">· архив</span> : null}
    </span>
  );
}

function TagsCell({ tags }: { tags: readonly TagDto[] }) {
  const unique = [...new Map(tags.map((tag) => [tag.id, tag])).values()];
  if (unique.length === 0) return <Empty label="Без тегов" />;
  const shown = unique.slice(0, 2);
  const rest = unique.slice(2);
  const label = (tag: TagDto) => (tag.archivedAt === null ? tag.name : `${tag.name} (архив)`);
  return (
    <span className="flex min-w-0 items-center gap-1">
      {shown.map((tag) => (
        <TagChip key={tag.id} tag={tag} />
      ))}
      {rest.length > 0 ? (
        <span className="shrink-0 text-xs text-muted tabular-nums" title={rest.map(label).join(', ')}>
          <span aria-hidden="true">+{rest.length}</span>
          <span className="sr-only">ещё: {rest.map(label).join(', ')}</span>
        </span>
      ) : null}
    </span>
  );
}

function DueDateCell({ dueDate, today, finished }: { dueDate: string | null; today: string | undefined; finished: boolean }) {
  if (dueDate === null) return <Empty label="Без срока" />;
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
      {overdue ? <span className="sr-only">, просрочено</span> : null}
    </time>
  );
}

function PriorityCell({ priority }: { priority: TaskPriority }) {
  if (priority === 'none') return <Empty label="Без приоритета" />;
  const view = priorityView[priority];
  return (
    <span className={cn('inline-flex items-center gap-1.5', view.className)}>
      <Flag size={14} aria-hidden="true" className="shrink-0" />
      {view.label}
    </span>
  );
}

function EstimateCell({ task, summary }: { task: TaskDto; summary: WorkPackageSummary }) {
  const entry = summary.packages.get(task.workPackageId);
  const sharedWith = entry === undefined ? 0 : entry.taskIds.length - 1;

  if (entry?.estimate.status === 'conflict') {
    return (
      <span className="inline-flex items-center justify-end gap-1.5 text-amber-800">
        <TriangleAlert size={14} aria-hidden="true" className="shrink-0" />
        <span>Обновите данные</span>
        <span className="sr-only">: загруженные копии оценки расходятся</span>
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
          title={`Общая оценка с ${pluralizeRu(sharedWith, { one: 'задачей', few: 'задачами', many: 'задачами' })}; в итоге учтена один раз`}
        >
          <Link2 size={12} aria-hidden="true" />
          общая
        </span>
      ) : null}
      {minutes === null ? (
        <Empty label="Не оценено" />
      ) : (
        <span className="font-medium text-ink tabular-nums">{formatEstimate(minutes)}</span>
      )}
    </span>
  );
}

interface RowContext {
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
}

function sectionLabel(sectionId: string | null, sectionById: ReadonlyMap<string, SectionDto>): string {
  if (sectionId === null) return 'Без раздела';
  return sectionById.get(sectionId)?.name ?? 'Раздел недоступен';
}

function TaskRow({ node, group, ctx }: { node: TaskTreeNode; group: TaskGroup; ctx: RowContext }) {
  const { task } = node;
  const status = ctx.statusById.get(task.statusId);
  const childCount = node.children.length;
  const expanded = !ctx.collapsedIds.has(task.id);
  const finished = status?.group === 'done' || status?.group === 'cancelled';
  const showSection = node.depth > 0 && task.sectionId !== group.sectionId;
  const activeParticipantIds = [
    ...new Set(task.participants.filter((participant) => participant.active).map((participant) => participant.membershipId)),
  ];
  const childCountText = ctx.partial ? `Загружено: ${formatSubtaskCount(childCount)}` : formatSubtaskCount(childCount);

  return (
    <tr className="group h-11 border-t border-line hover:bg-canvas/70">
      <td
        className="py-1 pr-3 lg:sticky lg:left-0 lg:z-[1] lg:bg-surface lg:shadow-[inset_-1px_0_0_var(--color-line),8px_0_8px_-8px_rgb(15_23_42/0.18)] lg:group-hover:bg-[color-mix(in_srgb,var(--color-canvas)_70%,var(--color-surface))]"
        style={{ paddingLeft: `${12 + node.depth * 20}px` }}>
        <div className="flex min-w-0 items-center gap-1.5">
          {childCount > 0 ? (
            <button
              type="button"
              aria-expanded={expanded}
              aria-label={`${expanded ? 'Свернуть' : 'Развернуть'} подзадачи «${task.title}»`}
              onClick={() => ctx.onToggle(task.id)}
              className={cn(iconButtonClassName, 'size-6 text-muted')}
            >
              {expanded ? <ChevronDown size={16} aria-hidden="true" /> : <ChevronRight size={16} aria-hidden="true" />}
            </button>
          ) : (
            <span aria-hidden="true" className="size-6 shrink-0" />
          )}
          {node.depth > 0 ? <span className="sr-only">Подзадача:</span> : null}
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
            <Badge tone="muted" title="Родительская задача не входит в загруженные">
              Подзадача
              <span className="sr-only">, родительская задача не загружена</span>
            </Badge>
          ) : null}
          {node.detachedReason === 'cycle' ? (
            <Badge tone="warning" title="Связи родитель–подзадача образуют цикл; обновите данные">
              Цикл в иерархии
            </Badge>
          ) : null}
          {showSection ? (
            <Badge tone="muted" className="min-w-0 max-w-40">
              <span className="min-w-0 truncate">Раздел: {sectionLabel(task.sectionId, ctx.sectionById)}</span>
            </Badge>
          ) : null}
          {task.archivedAt !== null ? <Badge tone="muted">В архиве</Badge> : null}
          {ctx.onCreateChild !== null && task.archivedAt === null ? (
            <button
              type="button"
              aria-label={`Добавить подзадачу к «${task.title}»`}
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
          <span className="text-muted">Статус недоступен</span>
        ) : (
          <span className="flex min-w-0 items-center gap-1.5">
            <span aria-hidden="true" className={cn('size-2 shrink-0 rounded-full', statusDotClasses[status.group])} />
            <span className="truncate text-ink-soft">{status.name}</span>
          </span>
        )}
      </td>
      <td className="px-3 py-1">
        {task.responsibleMembershipId === null ? (
          <Empty label="Не назначен" />
        ) : (
          <MemberName membershipId={task.responsibleMembershipId} memberById={ctx.memberById} />
        )}
      </td>
      <td className="px-3 py-1">
        <ParticipantsCell membershipIds={activeParticipantIds} memberById={ctx.memberById} />
      </td>
      <td className="px-3 py-1">
        <DueDateCell dueDate={task.dueDate} today={ctx.today} finished={finished} />
      </td>
      <td className="px-3 py-1">
        <TagsCell tags={task.tags} />
      </td>
      <td className="px-3 py-1">
        <PriorityCell priority={task.priority} />
      </td>
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
  if (group.kind === 'missing_section') return 'Раздел недоступен';
  return 'Без раздела';
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
  const title = groupTitle(group);
  const { section } = group;
  const archived = section !== null && section.archivedAt !== null;
  const canCreate = writable && group.kind !== 'missing_section' && !archived;
  const countText = partial ? `загружено: ${formatTaskCount(group.taskCount)}` : formatTaskCount(group.taskCount);

  return (
    <tr className="h-10 border-t border-line bg-canvas">
      <th scope="rowgroup" colSpan={columnCount} className="px-3 py-1 text-left font-normal">
        <div className="flex min-w-0 items-center gap-2">
          <span className="truncate text-[13px] font-semibold text-ink">{title}</span>
          <span className="shrink-0 text-xs text-muted tabular-nums">
            <span aria-hidden="true">{group.taskCount}</span>
            <span className="sr-only">, {countText}</span>
          </span>
          {archived ? <Badge tone="muted">Раздел в архиве</Badge> : null}
          <div className="ml-auto flex shrink-0 items-center gap-1">
            {writable && section !== null && !archived && onRenameSection !== undefined ? (
              <button
                type="button"
                aria-label={`Переименовать раздел «${section.name}»`}
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
                aria-label={section === null ? 'Добавить задачу без раздела' : `Добавить задачу в раздел «${section.name}»`}
                onClick={() => onCreateTask(section === null ? null : section.id)}
              >
                <Plus size={14} aria-hidden="true" />
                Задача
              </Button>
            ) : null}
          </div>
        </div>
      </th>
    </tr>
  );
}

function SummaryRow({ summary, partial, columnCount }: { summary: WorkPackageSummary; partial: boolean; columnCount: number }) {
  const { total } = summary;
  return (
    <tr className="h-11 border-t border-line-strong bg-canvas">
      <td colSpan={columnCount - 1} className="px-3 py-1.5 text-xs text-muted">
        <span className="font-medium text-ink-soft">Оценка загруженных задач</span>
        <span> · Оценки показывают общий объём работы команды.</span>
        <span> · Загружено: {formatTaskCount(summary.taskCount)}</span>
        <span> · Без оценки: {formatTaskCount(summary.unestimatedTaskCount)}</span>
        {partial ? <span> · Показана часть задач проекта, итог только по ним</span> : null}
        {total.status === 'needs_refresh' ? (
          <span className="text-amber-800"> · Оценки одной работы расходятся — обновите данные, чтобы получить итог</span>
        ) : null}
      </td>
      <td
        className={cn(
          'px-3 py-1.5 text-right text-sm font-semibold text-ink tabular-nums',
          stickyEstimateClassName,
          'lg:bg-canvas',
        )}
      >
        {total.status === 'ok' ? formatEstimate(total.minutes) : <Empty label="Итог недоступен" />}
      </td>
    </tr>
  );
}

/**
 * Read-mostly project task table: sections, collapsible subtask hierarchy and the work package
 * budget («Оценка задачи», each package counted once). Data and mutations belong to the parent.
 */
export function TaskTable({
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
  caption = 'Задачи проекта',
  customColumns = noCustomColumns,
  className,
}: TaskTableProps) {
  const columnCount = COLUMN_COUNT + customColumns.length;
  const minWidth = BASE_MIN_WIDTH + customColumns.reduce((sum, column) => sum + column.width, 0);
  const groups = useMemo(() => buildTaskGroups(tasks, sections), [tasks, sections]);
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
  };

  return (
    <div className={cn('relative min-w-0 overflow-auto rounded-2xl border border-line bg-surface', className)}>
      <table className="w-full min-w-[1160px] table-fixed border-collapse text-left text-sm" style={{ minWidth }}>
        <caption className="sr-only">{caption}</caption>
        <colgroup>
          {/* The secondary columns take 800px plus the custom widths, leaving the title 360px at the minimum width. */}
          <col />
          <col className="w-28" />
          <col className="w-36" />
          <col className="w-24" />
          <col className="w-24" />
          <col className="w-32" />
          <col className="w-24" />
          {customColumns.map((column) => (
            <col key={column.id} style={{ width: column.width }} />
          ))}
          <col className="w-32" />
        </colgroup>
        <thead className="sticky top-0 z-10 bg-surface text-xs text-muted shadow-[inset_0_-1px_0_var(--color-line)]">
          <tr className="h-9">
            <th
              scope="col"
              className="px-3 font-medium lg:sticky lg:left-0 lg:z-[1] lg:bg-surface lg:shadow-[inset_-1px_0_0_var(--color-line),inset_0_-1px_0_var(--color-line),8px_0_8px_-8px_rgb(15_23_42/0.18)]"
            >
              <span className="pl-[30px]">Задача</span>
            </th>
            <th scope="col" className="px-3 font-medium">
              Статус
            </th>
            <th scope="col" className="px-3 font-medium">
              Ответственный
            </th>
            <th scope="col" className="px-3 font-medium">
              Участники
            </th>
            <th scope="col" className="px-3 font-medium">
              Срок
            </th>
            <th scope="col" className="px-3 font-medium">
              Теги
            </th>
            <th scope="col" className="px-3 font-medium">
              Приоритет
            </th>
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
              Оценка задачи
            </th>
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
                    {partial ? 'Среди загруженных задач здесь ничего нет' : 'Задач пока нет'}
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
