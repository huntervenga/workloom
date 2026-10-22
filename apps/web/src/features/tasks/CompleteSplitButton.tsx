import * as Menu from '@radix-ui/react-dropdown-menu';
import { Check, ChevronDown, CornerDownRight, RotateCcw } from 'lucide-react';
import { useRef } from 'react';
import { Button } from '@workloom/ui';
import type { TaskDto, TaskStatusDto } from '@workloom/contracts';
import { useTranslation } from '../../i18n';
import { taskCompletion } from './taskCompletion';

/** "Mark complete" like in Asana, with a menu beside it: complete and carry on in another project. */
export function CompleteSplitButton({ task, statuses, busy, onComplete, onContinue }: { task: TaskDto; statuses: readonly TaskStatusDto[]; busy: boolean; onComplete: (task: TaskDto, statusId: string, source: HTMLButtonElement | null) => void; onContinue: (task: TaskDto) => void }) {
  const { t } = useTranslation();
  const anchor = useRef<HTMLButtonElement>(null);
  const decision = taskCompletion(task, statuses);
  if (!decision.eligible || decision.cancelled) return null;
  const choice = decision.choices[0];
  const label = decision.completed ? t('tasks.completeButton.completed') : t('tasks.completeButton.complete');
  return <span className="inline-flex" data-complete-button="">
    <Button ref={anchor} size="sm" variant={decision.completed ? 'secondary' : 'primary'} className="rounded-r-none" disabled={busy || !choice} aria-pressed={decision.completed}
      title={decision.completed ? t('tasks.completeButton.reopenHint') : undefined} onClick={() => { if (choice) onComplete(task, choice.id, anchor.current); }}>
      {decision.completed ? <RotateCcw size={14} aria-hidden="true" /> : <Check size={14} aria-hidden="true" />}{label}
    </Button>
    <Menu.Root modal={false}>
      <Menu.Trigger asChild><Button size="sm" variant={decision.completed ? 'secondary' : 'primary'} className="rounded-l-none border-l border-white/30 px-1.5" disabled={busy} aria-label={t('tasks.completeButton.more')}><ChevronDown size={14} aria-hidden="true" /></Button></Menu.Trigger>
      <Menu.Portal><Menu.Content align="end" className="z-50 min-w-60 rounded-lg border border-line bg-surface p-1 shadow-lg" onCloseAutoFocus={event => event.preventDefault()}>
        <Menu.Item className="flex cursor-pointer items-center gap-2 rounded px-3 py-2 text-sm text-ink outline-none data-[highlighted]:bg-canvas" onSelect={() => onContinue(task)}>
          <CornerDownRight size={14} aria-hidden="true" />{decision.completed ? t('tasks.completeButton.continue') : t('tasks.completeButton.completeAndContinue')}
        </Menu.Item>
      </Menu.Content></Menu.Portal>
    </Menu.Root>
  </span>;
}
