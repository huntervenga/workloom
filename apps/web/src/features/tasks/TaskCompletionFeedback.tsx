import { createPortal } from 'react-dom';
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { Button } from '@workloom/ui';
import { useTranslation } from '../../i18n';
import { SaveFeedback } from '../../shared/SaveFeedback';
import type { TaskCompletionController } from './useTaskCompletion';

/** Keep feedback outside the table's layout; modal feedback stays in its accessible dialog. */
export function TaskFeedbackLayer({ children }: { children: ReactNode }) {
  const anchor = useRef<HTMLSpanElement>(null);
  const [host, setHost] = useState<HTMLElement | null>(null);
  useLayoutEffect(() => { setHost(anchor.current?.closest<HTMLElement>('[role="dialog"]') ?? document.body); }, []);
  return <><span ref={anchor} aria-hidden="true" className="hidden" />{host ? createPortal(children, host) : null}</>;
}

/** Page-owned feedback remains visible if a task leaves the loaded view or its column is hidden. */
export function TaskCompletionFeedback({ controller: c, onReview }: { controller: TaskCompletionController; onReview: (id: string) => void }) {
  const { t } = useTranslation();
  const layer = (content: ReactNode) => <TaskFeedbackLayer>{content}</TaskFeedbackLayer>;
  const { reviewTaskId, attempt } = c;
  const dismissible = attempt?.released === true && !c.pending;
  const { dismiss } = c;
  useEffect(() => {
    if (!dismissible) return;
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') dismiss(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [dismissible, dismiss]);
  if (reviewTaskId) return layer(<div role="status" className="fixed right-3 top-20 z-[60] max-w-[calc(100vw-1.5rem)] shadow-lg flex flex-wrap items-center gap-2 rounded-lg border border-line bg-canvas p-3 text-xs"><p>{t('tasks.completion.refresh')}</p><Button size="sm" onClick={() => { c.acknowledgeReview(reviewTaskId); onReview(reviewTaskId); }}>{t('tasks.completion.review')}</Button></div>);
  if (!attempt || !c.pending && !attempt.error) return layer(null);
  return layer(<section aria-label={t('tasks.completion.feedback')} className="fixed right-3 top-20 z-[60] w-[min(28rem,calc(100vw-1.5rem))] max-h-[50dvh] overflow-auto shadow-lg space-y-2 [overflow-wrap:anywhere] rounded-lg border border-line bg-surface p-3 text-xs"><p>{c.pending ? t('tasks.completion.saving', { title: attempt.session.base.title }) : t('tasks.completion.reviewChange', { title: attempt.session.base.title })}</p><SaveFeedback subject="taskSave" error={c.uncertain ? null : attempt.error} uncertainError={c.uncertain ? attempt.error : null} /><div className="flex gap-2">{c.canRetry ? <Button size="sm" disabled={c.pending} onClick={c.retry}>{t('tasks.completion.retry')}</Button> : null}<Button size="sm" variant="ghost" onClick={() => onReview(attempt.session.base.id)}>{t('tasks.completion.review')}</Button>{dismissible ? <Button size="sm" variant="ghost" onClick={c.dismiss}>{t('tasks.completion.dismiss')}</Button> : null}</div></section>);
}
