import type { MembershipDto, TaskDto, TaskStatusDto } from '@workloom/contracts';
import { Badge, Button, cn } from '@workloom/ui';
import { useId, type ReactNode, type PointerEvent as ReactPointerEvent } from 'react';
import { useTranslation } from '../../i18n';
import { GripVertical } from 'lucide-react';
import { TagBadge } from '../tasks/TagBadge';
import { usePointerBoardDrag, type BoardDragState } from './usePointerBoardDrag';
import { canEditTaskInline } from '../tasks/tableEditing';
import { buildBoardModel, type BoardCard } from './boardModel';

export interface TaskBoardProps {
  tasks: readonly TaskDto[];
  statuses: readonly TaskStatusDto[];
  members: readonly MembershipDto[];
  /** More matches may be unloaded. Counts always describe only tasks passed to this projection. */
  partial: boolean;
  writable: boolean;
  /** Optional date-only workspace day; no browser-clock default is inferred. */
  today?: string | undefined;
  draftTaskIds?: ReadonlySet<string> | undefined;
  caption?: string | undefined;
  renderCompletionAction?: ((task: TaskDto) => ReactNode) | undefined;
  onOpenTask: (taskId: string) => void;
  onEditStatus: (task: TaskDto) => void;
  /** One page-owned status command; the board never patches a card optimistically. */
  onMoveStatus?: ((task: TaskDto, statusId: string) => void) | undefined;
  dragBlocked?: boolean | undefined;
  dragContextKey?: string | undefined;
  acquireDragProtection?: (() => () => void) | undefined;
  /** The parent owns eligibility and original-command recovery; return null when inactive. */
  renderStatusEditor: (task: TaskDto) => ReactNode;
}

/** An explicit projection of loaded tasks. The page owns navigation, paging, drafts and writes. */
export function TaskBoard(props: TaskBoardProps) {
  const { t } = useTranslation();
  const id = useId();
  const model = buildBoardModel(props.tasks, props.statuses);
  const cards = model.lanes.flatMap(lane => lane.cards);
  const editors = new Map(cards.map(card => [card.task.id, props.renderStatusEditor(card.task)]));
  const hasEditor = (task: TaskDto) => { const editor = editors.get(task.id); return editor !== null && editor !== undefined && editor !== false; };
  const allowed = (task: TaskDto) => props.writable && canEditTaskInline(task) && !props.draftTaskIds?.has(task.id) && !hasEditor(task);
  const contextKey = `${props.dragContextKey ?? 'board'}:${props.writable}:${model.lanes.map(lane => `${lane.statusId}:${lane.status?.revision ?? ''}`).join(',')}`;
  const pointer = usePointerBoardDrag({ tasks: new Map(cards.map(card => [card.task.id, card.task])), statuses: new Map(props.statuses.map(status => [status.id, status])),
    allowed, blocked: props.dragBlocked === true, contextKey, onMoveStatus: props.onMoveStatus, acquireProtection: props.acquireDragProtection });
  const catalogLaneCount = model.lanes.filter(lane => lane.status !== null).length;
  return <section aria-labelledby={`${id}-title`} className="min-w-0 max-w-full space-y-3">
    <div><h2 id={`${id}-title`} className="sr-only">{props.caption ?? t('board.title')}</h2><p id={`${id}-scope`} className="text-xs text-muted">{t('board.loadedCount', { count: model.loadedCount })}</p>{props.partial ? <p className="mt-1 text-xs text-muted">{t('board.partial')}</p> : null}</div>
    <p id={`${id}-help`} className="sr-only">{t('board.navigationHelp')}</p>
    <div data-board-scroll role="region" aria-label={t('board.lanes')} aria-describedby={`${id}-scope ${id}-help`} tabIndex={0} className="relative max-w-full overflow-x-auto overscroll-x-contain rounded-xl pb-3 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-ink">
      <div className="flex min-w-full items-start gap-3">
        {model.lanes.map((lane, index) => <section key={lane.statusId} aria-labelledby={`${id}-lane-${index}`} data-board-status={lane.status?.id} data-board-drop={pointer.drag?.statusId === lane.statusId ? 'active' : undefined} className={cn("w-[min(19rem,calc(100vw-4rem))] min-w-0 shrink-0 space-y-3 rounded-xl border bg-canvas p-3", pointer.drag?.statusId === lane.statusId ? "border-accent ring-2 ring-accent-soft" : "border-line")}>
          <header className="space-y-1"><h3 id={`${id}-lane-${index}`} className="text-sm font-semibold [overflow-wrap:anywhere]">{lane.status?.name ?? t('board.missingStatus', { number: index - catalogLaneCount + 1 })}</h3><p className="text-xs text-muted">{t('board.laneCount', { count: lane.cards.length })}</p></header>
          {pointer.drag?.statusId === lane.statusId ? <div data-board-drop-placeholder className="rounded-lg border-2 border-dashed border-accent bg-accent-soft px-3 py-4 text-xs font-medium text-ink">{t('board.dropHere', { status: lane.status?.name ?? '' })}</div> : null}
          {lane.cards.length === 0 ? <p className="rounded-lg border border-dashed border-line px-3 py-4 text-xs text-muted">{t('board.emptyLane')}</p> : <ul className="space-y-2">{lane.cards.map(card => <TaskCard key={card.task.id} card={card} props={props} status={lane.status} editor={editors.get(card.task.id)} canDrag={Boolean(props.onMoveStatus) && !props.dragBlocked && allowed(card.task)} drag={pointer.drag} onDrag={pointer.startDrag} />)}</ul>}
        </section>)}
      </div>
    </div>
    {pointer.drag ? <div data-testid="board-drag-preview" aria-hidden="true" className="pointer-events-none fixed z-[100] w-[min(17rem,calc(100vw-1rem))] line-clamp-2 [overflow-wrap:anywhere] rounded-xl border border-accent bg-surface px-3 py-2 text-sm font-semibold text-ink shadow-xl" style={{ left: Math.max(8, Math.min(pointer.drag.point.x + 12, window.innerWidth - 284)), top: Math.max(8, Math.min(pointer.drag.point.y + 12, window.innerHeight - 80)) }}>{pointer.drag.task.title}</div> : null}
    {model.loadedCount === 0 ? <p className="text-sm text-muted">{t('board.empty')}</p> : null}
  </section>;
}

function TaskCard({ card, props, status, editor, canDrag, drag, onDrag }: { card: BoardCard; props: TaskBoardProps; status: TaskStatusDto | null; editor: ReactNode; canDrag: boolean; drag: BoardDragState | null; onDrag: (task: TaskDto, event: ReactPointerEvent<HTMLButtonElement>) => void }) {
  const { t, formatDate } = useTranslation();
  const { task, parent } = card;
  const id = useId();
  const hasEditor = editor !== null && editor !== undefined && editor !== false;
  const person = task.responsibleMembershipId === null ? t('board.unassigned') : props.members.find(member => member.id === task.responsibleMembershipId)?.displayName ?? t('board.memberUnavailable');
  const overdue = props.today !== undefined && task.dueDate !== null && task.dueDate < props.today && (status?.group === 'todo' || status?.group === 'in_progress');
  const due = task.dueDate === null ? t('board.noDueDate') : t('board.dueDate', { date: formatDate(new Date(`${task.dueDate}T12:00:00Z`), { dateStyle: 'medium', timeZone: 'UTC' }) });
  return <li data-board-card={task.id} className={cn("min-w-0 space-y-2 rounded-lg border border-line bg-surface p-3 shadow-xs", drag?.task.id === task.id && "opacity-50")} onClick={event => {
    if (hasEditor || event.defaultPrevented || !(event.target instanceof Element) || !event.currentTarget.contains(event.target) || event.target.closest('button,input,textarea,select,a,label,summary,[role="button"],[contenteditable="true"]')) return;
    props.onOpenTask(task.id);
  }}>
    {parent.kind === 'loaded' ? <div className="space-y-0.5 text-xs"><p id={`${id}-parent`} className="text-muted">{t('board.parent')}</p><button aria-describedby={`${id}-parent`} type="button" onClick={() => props.onOpenTask(parent.task.id)} className="block min-h-6 max-w-full rounded text-left text-accent-ink [overflow-wrap:anywhere] hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-ink">{parent.task.title}</button></div> : parent.kind === 'not_loaded' ? <p className="text-xs text-muted">{t('board.parentNotLoaded')}</p> : null}
    <div className="flex min-w-0 items-start gap-1.5">{props.renderCompletionAction?.(task)}<button id={`${id}-title`} type="button" onClick={() => props.onOpenTask(task.id)} className="block min-h-8 w-full rounded text-left text-sm font-semibold [overflow-wrap:anywhere] hover:text-accent-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-ink">{task.title}</button></div>
    <dl className="min-w-0 text-xs [overflow-wrap:anywhere]"><dt className="sr-only">{t('board.assignee')}</dt><dd>{person}</dd></dl>
    {task.archivedAt !== null || task.meetingId !== null || props.draftTaskIds?.has(task.id) ? <div className="flex flex-wrap gap-1">
      {task.archivedAt !== null ? <Badge tone="muted">{t('board.archived')}</Badge> : null}
      {task.meetingId === undefined ? <Badge tone="warning">{t('board.refreshTaskType')}</Badge> : task.meetingId !== null ? <Badge tone="muted">{t('board.meeting')}</Badge> : null}
      {props.draftTaskIds?.has(task.id) ? <Badge tone="muted">{t('board.draftKept')}</Badge> : null}
    </div> : null}
    <div className="flex min-w-0 flex-wrap items-center justify-between gap-x-3 gap-y-2">
      <dl className="min-w-0 text-xs [overflow-wrap:anywhere]"><dt className="sr-only">{t('board.due')}</dt><dd className={overdue ? 'text-amber-800' : 'text-muted'}>{due}{overdue ? <span className="ml-1 font-medium">{t('board.overdue')}</span> : null}</dd></dl>
      {!hasEditor && props.writable && canEditTaskInline(task) ? <Button size="sm" variant="ghost" className="shrink-0" data-task-cell={`${task.id}:statusId`} aria-describedby={`${id}-title`} onClick={() => props.onEditStatus(task)}>{t('board.changeStatus')}</Button> : null}
    </div>
    {task.tags.length ? <div className="flex min-w-0 flex-wrap gap-1">{task.tags.slice(0, 3).map(tag => <TagBadge key={tag.id} tag={tag} />)}{task.tags.length > 3 ? <span className="text-xs text-muted">+{task.tags.length - 3}</span> : null}</div> : null}
    {canDrag ? <button type="button" aria-label={t('board.dragHandle', { title: task.title })} title={t('board.dragHelp')} onPointerDown={event => onDrag(task, event)} onClick={event => event.stopPropagation()} className="flex min-h-7 items-center gap-1 rounded px-1 text-xs text-muted cursor-grab active:cursor-grabbing focus-visible:outline-2 focus-visible:outline-accent-ink" style={{ touchAction: 'none' }}><GripVertical size={14} aria-hidden="true" />{t('board.dragLabel')}</button> : null}
    {hasEditor ? <div className="border-t border-line pt-2">{editor}</div> : null}
  </li>;
}
