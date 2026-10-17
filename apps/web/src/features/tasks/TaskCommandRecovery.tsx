import { Button } from '@workloom/ui';
import { useTranslation } from '../../i18n';
import { TaskFeedbackLayer } from './TaskCompletionFeedback';
import { unresolvedTaskCommand, type TaskCommands } from './useTaskCommands';

/** A collapsed editor must never make the original command or its kept draft unreachable. */
export function TaskCommandRecovery({ commands, onResumeCreate, onOpenTask }: { commands: TaskCommands; onResumeCreate: () => void; onOpenTask: (id: string) => void }) {
  const { t } = useTranslation();
  const held = unresolvedTaskCommand(commands);
  if (held?.kind === 'bulk') return null; // The visible selection bar owns this immutable command and its retry.
  const createDraft = commands.createSession.current;
  const editDraftIds = [...commands.editSessions.current.keys()];
  const firstEditDraft = editDraftIds[0];
  if (!held && !createDraft && !firstEditDraft) return null;
  return <TaskFeedbackLayer><div role="status" className="fixed inset-x-3 bottom-3 z-[55] mx-auto flex max-w-3xl flex-wrap items-center gap-2 rounded-lg border border-line bg-canvas px-3 py-2 text-xs text-ink-soft shadow-lg">
    <span className="min-w-0 flex-1">{held ? t(held.uncertain ? 'tasks.recovery.unconfirmed' : 'tasks.recovery.pending') : createDraft ? t('tasks.recovery.draftKept') : t('tasks.recovery.editDraftCount', { count: editDraftIds.length })}</span>
    <Button size="sm" onClick={() => held?.taskId ? onOpenTask(held.taskId) : held || createDraft ? onResumeCreate() : firstEditDraft ? onOpenTask(firstEditDraft) : undefined}>{t('tasks.recovery.resume')}</Button>
  </div></TaskFeedbackLayer>;
}
