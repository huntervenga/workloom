import type { MembershipDto, TaskDto, TaskStatusDto } from '@workloom/contracts';
import { Badge, Button, cn } from '@workloom/ui';
import { useId, type ReactNode, type PointerEvent as ReactPointerEvent } from 'react';
import { useTranslation } from '../../i18n';
import { Check, GripVertical } from 'lucide-react';
import { TagBadge } from '../tasks/TagBadge';
import { usePointerBoardDrag, type BoardDragState, type BoardMoveCard } from './usePointerBoardDrag';
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
  isStatusEditBusy?: ((task: TaskDto) => boolean) | undefined;
  /** Atomic canonical home status and manual-order intent; never enabled under a different sort. */
  onMoveCard?: BoardMoveCard | undefined;
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
  const contextKey = `${props.dragContextKey ?? 'board'}:${props.writable}:${Boolean(props.onMoveCard)}:${Boolean(props.onMoveStatus)}:${model.lanes.map(lane => `${lane.statusId}:${lane.status?.revision ?? ''}`).join(',')}:${cards.map(card => `${card.task.id}:${card.task.revision}:${card.task.position}:${card.task.statusId}`).join(',')}`;
  const pointer = usePointerBoardDrag({ tasks: new Map(cards.map(card => [card.task.id, card.task])), statuses: new Map(props.statuses.map(status => [status.id, status])),
    allowed, blocked: props.dragBlocked === true, contextKey, onMoveCard: props.onMoveCard, onMoveStatus: props.onMoveStatus, acquireProtection: props.acquireDragProtection });
  const catalogLaneCount = model.lanes.filter(lane => lane.status !== null).length;
  return <section aria-labelledby={`${id}-title`} className="min-w-0 max-w-full space-y-3">
    <div><h2 id={`${id}-title`} className="sr-only">{props.caption ?? t('board.title')}</h2><p id={`${id}-scope`} className="text-xs text-muted">{t('board.loadedCount', { count: model.loadedCount })}</p>{props.partial ? <p className="mt-1 text-xs text-muted">{t('board.partial')}</p> : null}</div>
    <p id={`${id}-help`} className="sr-only">{t('board.navigationHelp')}</p>
    <div data-board-scroll role="region" aria-label={t('board.lanes')} aria-describedby={`${id}-scope ${id}-help`} tabIndex={0} className="relative max-w-full overflow-x-auto overscroll-x-contain rounded-xl pb-3 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-ink">
      <div className="flex min-w-full items-start gap-3">
        {model.lanes.map((lane, index) => <section key={lane.statusId} aria-labelledby={`${id}-lane-${index}`} data-board-status={lane.status?.id} data-board-drop={pointer.drag?.statusId === lane.statusId ? 'active' : undefined} className={cn("w-[min(19rem,calc(100vw-4rem))] min-w-0 shrink-0 space-y-3 rounded-xl border bg-canvas p-3", pointer.drag?.statusId === lane.statusId ? "border-accent ring-2 ring-accent-soft" : "border-line")}>
          <header className="space-y-1"><h3 id={`${id}-lane-${index}`} className="text-sm font-semibold [overflow-wrap:anywhere]">{lane.status?.name ?? t('board.missingStatus', { number: index - catalogLaneCount + 1 })}</h3><p className="text-xs text-muted">{t('board.laneCount', { count: lane.cards.length })}</p></header>
          {/* The lane-end marker is an overlay in the lane padding; it never joins the lane's spaced flow. */}
          <div data-board-lane-body className="relative">
            {lane.cards.length === 0 ? <p className="rounded-lg border border-dashed border-line px-3 py-4 text-xs text-muted">{t('board.emptyLane')}</p> : <ul className="space-y-2">{lane.cards.map(card => <TaskCard key={card.task.id} card={card} props={props} status={lane.status} editor={editors.get(card.task.id)} canDrag={Boolean(props.onMoveCard || props.onMoveStatus) && allowed(card.task)} dragDisabled={props.dragBlocked === true} drag={pointer.drag} onDrag={pointer.startDrag} insertion={props.onMoveCard && pointer.drag?.statusId === lane.statusId && pointer.drag.anchorTaskId === card.task.id ? pointer.drag.placement : undefined} />)}</ul>}
            {pointer.drag?.statusId === lane.statusId && pointer.drag.anchorTaskId === null ? <div data-board-lane-end className="pointer-events-none absolute inset-x-0 -bottom-1.5"><DropLine label={t('board.dropHere', { status: lane.status?.name ?? '' })} /></div> : null}
          </div>
        </section>)}
      </div>
    </div>
    {pointer.drag ? <div data-testid="board-drag-preview" aria-hidden="true" inert className="pointer-events-none fixed z-[100] -rotate-2 rounded-lg shadow-2xl" style={{ width: Math.min(pointer.drag.width, window.innerWidth - 16), left: Math.max(8, Math.min(pointer.drag.point.x - pointer.drag.offset.x, window.innerWidth - Math.min(pointer.drag.width, window.innerWidth - 16) - 8)), top: Math.max(8, Math.min(pointer.drag.point.y - pointer.drag.offset.y, window.innerHeight - Math.min(pointer.drag.height, window.innerHeight - 16) - 8)) }}>
      <ul><TaskCard card={cards.find(card => card.task.id === pointer.drag?.task.id) ?? { task: pointer.drag.task, parent: { kind: 'none' } }} props={props} status={props.statuses.find(status => status.id === pointer.drag?.task.statusId) ?? null} editor={null} canDrag={false} dragDisabled drag={null} onDrag={pointer.startDrag} preview /></ul>
    </div> : null}
    {model.loadedCount === 0 ? <p className="text-sm text-muted">{t('board.empty')}</p> : null}
  </section>;
}

function DropLine({ label }: { label: string }) {
  return <div data-board-drop-placeholder className="pointer-events-none relative h-0.5 rounded-full bg-accent"><span className="absolute -left-1 -top-0.5 size-1.5 rounded-full bg-accent" /><span className="sr-only">{label}</span></div>;
}

const handleChrome = "absolute right-1 top-1 flex size-7 items-center justify-center rounded-md text-muted";

/** Card chrome (padding reserved for the top-right handle) is identical for every card in every drag state and in the ghost. */
function TaskCard({ card, props, status, editor, canDrag, dragDisabled, drag, onDrag, insertion, preview = false }: { card: BoardCard; props: TaskBoardProps; status: TaskStatusDto | null; editor: ReactNode; canDrag: boolean; dragDisabled: boolean; drag: BoardDragState | null; onDrag: (task: TaskDto, event: ReactPointerEvent<HTMLButtonElement>) => void; insertion?: 'before' | 'after' | undefined; preview?: boolean }) {
  const { t, formatDate } = useTranslation();
  const { task, parent } = card;
  const id = useId();
  const hasEditor = editor !== null && editor !== undefined && editor !== false;
  const person = task.responsibleMembershipId === null ? t('board.unassigned') : props.members.find(member => member.id === task.responsibleMembershipId)?.displayName ?? t('board.memberUnavailable');
  const overdue = props.today !== undefined && task.dueDate !== null && task.dueDate < props.today && (status?.group === 'todo' || status?.group === 'in_progress');
  const due = task.dueDate === null ? t('board.noDueDate') : t('board.dueDate', { date: formatDate(new Date(`${task.dueDate}T12:00:00Z`), { dateStyle: 'medium', timeZone: 'UTC' }) });
  return <li data-board-card={preview ? undefined : task.id} className={cn("relative min-w-0 rounded-lg border bg-surface", preview ? "border-accent shadow-xl" : "border-line shadow-xs", drag?.task.id === task.id && "opacity-50")} onClick={event => {
    if (hasEditor || event.defaultPrevented || !(event.target instanceof Element) || !event.currentTarget.contains(event.target) || event.target.closest('button,input,textarea,select,a,label,summary,[role="button"],[contenteditable="true"]')) return;
    props.onOpenTask(task.id);
  }}>
    {insertion ? <div className={cn("absolute inset-x-0", insertion === 'before' ? "-top-1.5" : "-bottom-1.5")}><DropLine label={t('board.dropBefore', { title: task.title })} /></div> : null}
    {preview ? <span aria-hidden="true" className={handleChrome}><GripVertical size={16} aria-hidden="true" /></span>
      // Pending/refetch blocks keep the handle mounted and visibly disabled; eligibility alone decides whether it exists.
      : canDrag ? <button type="button" disabled={dragDisabled} aria-label={t('board.dragHandle', { title: task.title })} title={t(props.onMoveCard ? 'board.dragOrderHelp' : 'board.dragHelp')} onPointerDown={event => onDrag(task, event)} onClick={event => event.stopPropagation()} className={cn(handleChrome, "cursor-grab hover:bg-canvas hover:text-ink active:cursor-grabbing focus-visible:outline-2 focus-visible:outline-accent-ink disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-muted")} style={{ touchAction: 'none' }}><GripVertical size={16} aria-hidden="true" /></button> : null}
    <div data-board-card-body className="min-w-0 space-y-2 p-3 pr-9">
    {parent.kind === 'loaded' ? <div className="space-y-0.5 text-xs"><p id={`${id}-parent`} className="text-muted">{t('board.parent')}</p><button aria-describedby={`${id}-parent`} type="button" onClick={() => props.onOpenTask(parent.task.id)} className="block min-h-6 max-w-full rounded text-left text-accent-ink [overflow-wrap:anywhere] hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-ink">{parent.task.title}</button></div> : parent.kind === 'not_loaded' ? <p className="text-xs text-muted">{t('board.parentNotLoaded')}</p> : null}
    {/* A plain completion shape keeps the ghost's wrap without mounting a second live completion/focus registration. */}
    <div className="flex min-w-0 items-start gap-1.5">{preview ? props.renderCompletionAction ? <span aria-hidden="true" className="inline-flex size-7 shrink-0 items-center justify-center"><span className={cn('inline-flex size-[18px] items-center justify-center rounded-full border', status?.group === 'done' ? 'border-emerald-600 bg-emerald-600 text-white' : 'border-line-strong text-transparent')}><Check size={12} strokeWidth={3} /></span></span> : null : props.renderCompletionAction?.(task)}<button id={`${id}-title`} type="button" onClick={() => props.onOpenTask(task.id)} className="block min-h-8 w-full rounded text-left text-sm font-semibold [overflow-wrap:anywhere] hover:text-accent-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-ink">{task.title}</button></div>
    <dl className="min-w-0 text-xs [overflow-wrap:anywhere]"><dt className="sr-only">{t('board.assignee')}</dt><dd>{person}</dd></dl>
    {task.archivedAt !== null || task.meetingId !== null || props.draftTaskIds?.has(task.id) ? <div className="flex flex-wrap gap-1">
      {task.archivedAt !== null ? <Badge tone="muted">{t('board.archived')}</Badge> : null}
      {task.meetingId === undefined ? <Badge tone="warning">{t('board.refreshTaskType')}</Badge> : task.meetingId !== null ? <Badge tone="muted">{t('board.meeting')}</Badge> : null}
      {props.draftTaskIds?.has(task.id) ? <Badge tone="muted">{t('board.draftKept')}</Badge> : null}
    </div> : null}
    <div className="flex min-w-0 flex-wrap items-center justify-between gap-x-3 gap-y-2">
      <dl className="min-w-0 text-xs [overflow-wrap:anywhere]"><dt className="sr-only">{t('board.due')}</dt><dd className={overdue ? 'text-amber-800' : 'text-muted'}>{due}{overdue ? <span className="ml-1 font-medium">{t('board.overdue')}</span> : null}</dd></dl>
      {!hasEditor && props.writable && canEditTaskInline(task) ? preview ? <Button size="sm" variant="ghost" className="shrink-0" tabIndex={-1}>{t('board.changeStatus')}</Button> : <Button size="sm" variant="ghost" className="shrink-0" data-task-cell={`${task.id}:statusId`} disabled={props.isStatusEditBusy?.(task)} aria-describedby={`${id}-title`} onClick={() => props.onEditStatus(task)}>{t('board.changeStatus')}</Button> : null}
    </div>
    {task.tags.length ? <div className="flex min-w-0 flex-wrap gap-1">{task.tags.slice(0, 3).map(tag => <TagBadge key={tag.id} tag={tag} />)}{task.tags.length > 3 ? <span className="text-xs text-muted">+{task.tags.length - 3}</span> : null}</div> : null}
    {hasEditor ? <div className="border-t border-line pt-2">{editor}</div> : null}
    </div>
  </li>;
}
