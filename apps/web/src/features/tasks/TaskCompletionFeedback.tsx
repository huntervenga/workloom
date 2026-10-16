import { Button } from '@workloom/ui';
import { useTranslation } from '../../i18n';
import { SaveFeedback } from '../../shared/SaveFeedback';
import type { TaskCompletionController } from './useTaskCompletion';

/** Page-owned feedback remains visible if a task leaves the loaded view or its column is hidden. */
export function TaskCompletionFeedback({ controller: c, onReview }: { controller: TaskCompletionController; onReview: (id: string) => void }) {
  const { t } = useTranslation();
  const { reviewTaskId, attempt } = c;
  if (reviewTaskId) return <div role="status" className="flex flex-wrap items-center gap-2 rounded-lg border border-line bg-canvas p-3 text-xs"><p>{t('tasks.completion.refresh')}</p><Button size="sm" onClick={() => { c.acknowledgeReview(reviewTaskId); onReview(reviewTaskId); }}>{t('tasks.completion.review')}</Button></div>;
  if (!attempt || !c.pending && !attempt.error) return null;
  return <section aria-label={t('tasks.completion.feedback')} className="space-y-2 [overflow-wrap:anywhere] rounded-lg border border-line bg-surface p-3 text-xs"><p>{c.pending ? t('tasks.completion.saving', { title: attempt.session.base.title }) : t('tasks.completion.reviewChange', { title: attempt.session.base.title })}</p><SaveFeedback subject="taskSave" error={c.uncertain ? null : attempt.error} uncertainError={c.uncertain ? attempt.error : null} /><div className="flex gap-2">{c.canRetry ? <Button size="sm" disabled={c.pending} onClick={c.retry}>{t('tasks.completion.retry')}</Button> : null}<Button size="sm" variant="ghost" onClick={() => onReview(attempt.session.base.id)}>{t('tasks.completion.review')}</Button></div></section>;
}
