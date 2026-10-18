import { Button, cn } from '@workloom/ui';
import { useRef, useSyncExternalStore } from 'react';
import { useTranslation } from '../../i18n';
import { SaveFeedback } from '../../shared/SaveFeedback';
import type { InlineTagController } from './inlineTagCreate';
import { TaskFeedbackLayer } from './TaskCompletionFeedback';

export interface InlineTagCreateRecoveryProps {
  controller: InlineTagController;
  onResumeCreate: () => void;
  onOpenTask: (id: string) => void;
  /** Another page notice sits at the bottom; this one stays above it. */
  raised?: boolean | undefined;
}

/**
 * The page-owned notice of an inline tag create, reachable after its picker closed. Retry resends
 * the original command; the tag is only ever added by its original draft or by an explicit choice.
 */
export function InlineTagCreateRecovery({ controller, onResumeCreate, onOpenTask, raised = false }: InlineTagCreateRecoveryProps) {
  const { t } = useTranslation();
  useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
  // A native wrapper, so the persistent Open original button is found whatever Button does with refs.
  const actions = useRef<HTMLDivElement>(null);
  const attempt = controller.current();
  // A tag selected in its own draft needs nothing more here; the draft shows and saves it.
  if (!attempt || (attempt.status === 'created' && attempt.added !== false)) return null;
  const params = { name: attempt.name, label: attempt.origin.label };
  const { taskId } = attempt.origin;
  const text = attempt.status === 'pending' ? t('tasks.tags.recoveryPending', params)
    : attempt.status === 'unknown' ? t('tasks.tags.recoveryUnknown', params)
      : attempt.status === 'rejected' ? t('tasks.tags.recoveryRejected', params)
        : t('tasks.tags.recoveryNotAdded', params);
  // Only while no owner of the origin is mounted; a mounted owner offers it in its own picker.
  const canContinue = attempt.status === 'unknown' && !attempt.catalogOnly && controller.canContinueWithoutTag();
  const continueWithoutTag = () => {
    const open = actions.current?.querySelector<HTMLButtonElement>('[data-inline-tag-open]');
    // Focus first lands on the button that stays; without it, nothing is released.
    if (!open || !controller.canContinueWithoutTag()) return;
    open.focus({ preventScroll: true });
    controller.continueWithoutTag();
  };
  return <TaskFeedbackLayer><div role="status" aria-label={t('tasks.tags.recoveryLabel')}
    className={cn('fixed inset-x-3 z-[55] mx-auto flex max-w-3xl flex-col gap-2 rounded-lg border border-line bg-surface px-3 py-2 text-xs text-ink shadow-lg', raised ? 'bottom-16' : 'bottom-3')}>
    <p className="min-w-0 break-words">{text}</p>
    {(attempt.status === 'unknown' || attempt.status === 'pending') && attempt.catalogOnly
      ? <p className="min-w-0 break-words">{t('tasks.tags.continuedWithoutTag', params)}</p>
      : null}
    {attempt.status === 'unknown' || attempt.status === 'rejected'
      ? <SaveFeedback subject="tagSave" error={attempt.status === 'rejected' ? attempt.error : null} uncertainError={attempt.status === 'unknown' ? attempt.error : null} />
      : null}
    <div ref={actions} className="flex flex-wrap items-center gap-2">
      {attempt.status === 'unknown'
        ? <Button size="sm" aria-disabled={!controller.canRetry() || undefined} onClick={() => { controller.retry(); }}>{t('tasks.tags.retry')}</Button>
        : null}
      <Button size="sm" data-inline-tag-open="" onClick={() => taskId ? onOpenTask(taskId) : onResumeCreate()}>{t('tasks.tags.openOriginal')}</Button>
      {canContinue
        ? <Button size="sm" variant="ghost" onClick={continueWithoutTag}>{t('tasks.tags.continueWithoutTag')}</Button>
        : null}
      {attempt.status === 'rejected' || attempt.status === 'created'
        ? <Button size="sm" variant="ghost" onClick={() => { controller.dismiss(); }}>{t('tasks.tags.dismiss')}</Button>
        : null}
    </div>
  </div></TaskFeedbackLayer>;
}
