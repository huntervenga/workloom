import { Button } from '@workloom/ui';
import { useTranslation } from '../../i18n';
import type { TaskCommentsWorkspace } from './useTaskCommentsWorkspace';

export function CommentCommandRecovery({ controller, visibleTaskId, onOpen }: { controller: TaskCommentsWorkspace; visibleTaskId: string | null; onOpen: (taskId: string) => void }) {
  const { t } = useTranslation();
  const taskId = controller.held?.variables.taskId ?? Object.keys(controller.drafts)[0];
  if (!taskId || visibleTaskId === taskId && controller.tabs[taskId] === 'discussion') return null;
  return <div role="status" className="flex flex-wrap items-center gap-2 rounded-lg border border-line bg-canvas px-3 py-2 text-xs text-ink-soft"><span className="min-w-0 flex-1">{controller.held ? controller.command.uncertain ? t('comments.recovery.unknown') : t('comments.recovery.pending') : t('comments.recovery.draft')}</span><Button size="sm" onClick={() => { controller.setTab(taskId, 'discussion'); onOpen(taskId); }}>{t('comments.recovery.open')}</Button></div>;
}
