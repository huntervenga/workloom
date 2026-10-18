import { Button } from '@workloom/ui';
import { useTranslation } from '../../i18n';
import { InlineTagCreateRecovery } from './InlineTagCreateRecovery';
import { TaskFeedbackLayer } from './TaskCompletionFeedback';
import { unresolvedTaskCommand, type TaskCommands } from './useTaskCommands';

/**
 * A collapsed editor must never make the original command or its kept draft unreachable. The page
 * mounts this always; `showTaskRecovery` is its own gate for the task notice, while an inline tag
 * create from a clean editor stays reachable without any kept task draft.
 */
export function TaskCommandRecovery({ commands, onResumeCreate, onOpenTask, showTaskRecovery = true }: {
  commands: TaskCommands; onResumeCreate: () => void; onOpenTask: (id: string) => void; showTaskRecovery?: boolean | undefined;
}) {
  const { t } = useTranslation();
  const held = unresolvedTaskCommand(commands);
  const createDraft = commands.createSession.current;
  const editDraftIds = [...commands.editSessions.current.keys()];
  const firstEditDraft = editDraftIds[0];
  // An inline tag create stays reachable on its own, also while a bulk command holds the page.
  const inlineTag = <InlineTagCreateRecovery controller={commands.inlineTags} onResumeCreate={onResumeCreate} onOpenTask={onOpenTask}
    raised={showTaskRecovery && (held !== null || createDraft !== null || firstEditDraft !== undefined)} />;
  if (!showTaskRecovery) return inlineTag;
  if (held?.kind === 'bulk') return inlineTag; // The visible selection bar owns this immutable command and its retry.
  if (!held && !createDraft && !firstEditDraft) return inlineTag;
  return <>{inlineTag}<TaskFeedbackLayer><div role="status" className="fixed inset-x-3 bottom-3 z-[55] mx-auto flex max-w-3xl flex-wrap items-center gap-2 rounded-lg border border-line bg-canvas px-3 py-2 text-xs text-ink-soft shadow-lg">
    <span className="min-w-0 flex-1">{held ? t(held.uncertain ? 'tasks.recovery.unconfirmed' : 'tasks.recovery.pending') : createDraft ? t('tasks.recovery.draftKept') : t('tasks.recovery.editDraftCount', { count: editDraftIds.length })}</span>
    <Button size="sm" onClick={() => held?.taskId ? onOpenTask(held.taskId) : held || createDraft ? onResumeCreate() : firstEditDraft ? onOpenTask(firstEditDraft) : undefined}>{t('tasks.recovery.resume')}</Button>
  </div></TaskFeedbackLayer></>;
}
