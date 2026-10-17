import { useLayoutEffect, useRef, useState } from 'react';
import { cn } from '@workloom/ui';
import type { TaskDto, TaskStatusDto } from '@workloom/contracts';
import * as Menu from '@radix-ui/react-dropdown-menu';
import { Check, CircleSlash, LoaderCircle } from 'lucide-react';
import { useTranslation } from '../../i18n';
import { taskCompletion } from './taskCompletion';

interface Props { task: TaskDto; statuses: readonly TaskStatusDto[]; writable: boolean; blocked: boolean; pending: boolean; hasDraft: boolean; editing: boolean; onChoose: (task: TaskDto, statusId: string, source?: HTMLButtonElement | null) => void; onTargetReady?: ((task: TaskDto, target: HTMLButtonElement) => () => void) | undefined; onReview: (id: string) => void }
export function TaskCompletionAction({ task, statuses, writable, blocked, pending, hasDraft, editing, onChoose, onReview, onTargetReady }: Props) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  useLayoutEffect(() => { const target = triggerRef.current; return target ? onTargetReady?.(task, target) : undefined; }, [onTargetReady, task, statuses, writable, blocked, pending, hasDraft, editing]);
  const decision = taskCompletion(task, statuses);
  const state = !decision.current ? t('tasks.completion.refresh') : decision.completed ? t('tasks.completion.completedState', { title: task.title }) : decision.cancelled ? t('tasks.completion.cancelledState', { title: task.title }) : t('tasks.completion.incompleteState', { title: task.title });
  // One clean circle in a 28px target: an outlined check that previews completion on hover, filled once done.
  const icon = pending ? <LoaderCircle size={14} className="animate-spin" /> : !decision.completed && decision.cancelled ? <CircleSlash size={18} />
    : <span className={cn('inline-flex size-[18px] items-center justify-center rounded-full border transition-colors', decision.completed ? 'border-emerald-600 bg-emerald-600 text-white' : 'border-line-strong text-transparent group-hover/complete:border-emerald-600 group-hover/complete:text-emerald-600')}><Check size={12} strokeWidth={3} /></span>;
  const style = cn('group/complete inline-flex size-7 shrink-0 items-center justify-center rounded-full text-muted transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-ink disabled:opacity-50');
  if (!writable || !decision.eligible) return <span role="img" aria-label={state} title={decision.current ? state : t('tasks.completion.refresh')} className={style}><span aria-hidden="true" className="inline-flex">{icon}</span></span>;
  const label = pending ? t('tasks.completion.saving', { title: task.title }) : editing ? t('tasks.completion.finishEdit') : hasDraft ? t('tasks.completion.resume', { title: task.title }) : blocked ? t('tasks.completion.otherCommand') : decision.choices.length === 0 ? decision.reopening ? t('tasks.completion.noActive') : t('tasks.completion.noDone') : decision.reopening ? t('tasks.completion.reopen', { title: task.title }) : t('tasks.completion.complete', { title: task.title });
  const directChoice = decision.choices[0];
  const canChoose = !hasDraft && !editing && !pending && !blocked && !decision.direct && decision.choices.length > 0;
  const button = <button ref={triggerRef} type="button" data-task-completion={task.id} aria-label={label} title={label} className={style} aria-disabled={blocked || pending || undefined} disabled={editing || !hasDraft && decision.choices.length === 0} onClick={() => {
    if (blocked || pending || editing) return;
    if (hasDraft) onReview(task.id);
    else if (decision.direct && directChoice) onChoose(task, directChoice.id, triggerRef.current);
  }}><span aria-hidden="true" className="inline-flex">{icon}</span></button>;
  // Keep one native button across idle/pending/confirmed renders. Aria-disabled remains
  // focusable while the explicit handler and command gate refuse any second write.
  return <Menu.Root modal={false} open={canChoose && open} onOpenChange={next => setOpen(canChoose && next)}>
    <Menu.Trigger asChild aria-haspopup={canChoose ? 'menu' : undefined} aria-expanded={canChoose ? open : undefined}
      onPointerDown={event => { if (!canChoose) { event.preventDefault(); event.currentTarget.focus(); } }}
      onKeyDown={event => { if (!canChoose && ['Enter', ' ', 'ArrowDown'].includes(event.key)) { event.preventDefault(); if (event.key !== 'ArrowDown') event.currentTarget.click(); } }}>
      {button}
    </Menu.Trigger>
    {canChoose ? <Menu.Portal><Menu.Content data-task-completion-menu={task.id} sideOffset={5} align="start" className="z-50 max-w-72 min-w-44 rounded-lg border border-line bg-surface p-1 shadow-lg"><Menu.Label className="px-2 py-1 text-xs text-muted">{decision.reopening ? t('tasks.completion.reopenChoice') : t('tasks.completion.completeChoice')}</Menu.Label>{decision.choices.map(status => <Menu.Item key={status.id} onSelect={() => onChoose(task, status.id, triggerRef.current)} className="cursor-pointer rounded px-2 py-2 text-sm outline-none data-highlighted:bg-accent-soft [overflow-wrap:anywhere]">{decision.reopening ? t('tasks.completion.reopenAs', { status: status.name }) : t('tasks.completion.completeAs', { status: status.name })}</Menu.Item>)}</Menu.Content></Menu.Portal> : null}
  </Menu.Root>;
}
