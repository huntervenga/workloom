import type { BulkUpdateTasksInput, MembershipDto, TaskDto } from '@workloom/contracts';
import { bulkUpdateTasksInputSchema } from '@workloom/contracts';
import { Button } from '@workloom/ui';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from '../../i18n';
import { useProtectedDraft } from '../../lib/protectedDrafts';
import { ChoicePicker } from '../../shared/ChoicePicker';
import { SaveFeedback } from '../../shared/SaveFeedback';
import { TaskDateInput } from '../tasks/TaskDateInput';
import type { TaskCommands } from '../tasks/useTaskCommands';

export interface BulkTaskToolbarProps {
  projectId: string;
  tasks: readonly TaskDto[];
  count: number;
  hiddenCount?: number;
  onClearHidden?: () => void;
  onReload?: (() => void | Promise<void>) | undefined;
  members: readonly MembershipDto[];
  commands: TaskCommands;
  writable: boolean;
  blocked: boolean;
  onClear: () => void;
  /** Opens the "continue in another project" dialog for the frozen selection. */
  onContinue?: (() => void) | undefined;
  /** Deletes the frozen selection; every task keeps its own Undo. */
  onDelete?: (() => void) | undefined;
  onConfirmed: (tasks: readonly TaskDto[]) => void;
}
/** The person explicitly applies one patch to a frozen selection, through one atomic command. */
export function BulkTaskToolbar({ projectId, tasks, count, members, commands, writable, blocked, onClear, onContinue, onDelete, onConfirmed, hiddenCount = 0, onClearHidden, onReload }: BulkTaskToolbarProps) {
  const { t } = useTranslation();
  const command = commands.bulk;
  const [changes, setChanges] = useState<BulkUpdateTasksInput['changes']>({});
  const [datesOpen, setDatesOpen] = useState(false);
  const [invalid, setInvalid] = useState(false);
  const [reloading, setReloading] = useState(false);
  const [reloadError, setReloadError] = useState<Error | null>(null);
  const [saved, setSaved] = useState<number | null>(null);
  const dateButton = useRef<HTMLButtonElement>(null);
  const datePanel = useRef<HTMLDivElement>(null);
  const closeDates = () => { setDatesOpen(false); dateButton.current?.focus({ preventScroll: true }); };
  useEffect(() => {
    if (!datesOpen) return;
    const outside = (event: PointerEvent) => { if (event.target instanceof Node && !datePanel.current?.contains(event.target) && !dateButton.current?.contains(event.target)) setDatesOpen(false); };
    document.addEventListener('pointerdown', outside, true);
    return () => document.removeEventListener('pointerdown', outside, true);
  }, [datesOpen]);
  const held = command.pendingCommand !== null || command.uncertain !== null;
  const dirty = Object.keys(changes).length > 0;
  useProtectedDraft(dirty);
  const unavailable = tasks.length !== count || tasks.some(task => task.meetingId !== null || task.archivedAt !== null || commands.editSessions.current.has(task.id));
  const locked = held || reloading || blocked || !writable || unavailable;
  const apply = () => {
    if (locked || !dirty) return;
    const parsed = bulkUpdateTasksInputSchema.safeParse({ projectId, tasks: tasks.map(task => ({ taskId: task.id, expectedRevision: task.revision })), changes });
    const badRange = tasks.some(task => { const start = (changes.startDate === undefined ? task.startDate : changes.startDate) ?? null; const due = (changes.dueDate === undefined ? task.dueDate : changes.dueDate) ?? null; return start !== null && due !== null && start > due; });
    setInvalid(!parsed.success || badRange);
    if (!parsed.success || badRange) return;
    // Immutable normalized input is held by the shared exact-body/idempotency tracker.
    command.mutate({ input: structuredClone(parsed.data) }, { onSuccess: rows => { setSaved(rows.length); setChanges({}); setDatesOpen(false); onConfirmed(rows); } });
  };
  return <section aria-label={t('taskTable.bulk.region')} className="fixed inset-x-3 bottom-3 z-[45] mx-auto max-w-3xl rounded-xl border border-accent-line bg-surface p-3 text-sm shadow-xl">
    <div className="flex flex-wrap items-center gap-2">
      <span role="status" className="font-medium">{t('taskTable.bulk.count', { count })}</span>
      <ChoicePicker compact label={t('taskTable.bulk.assignee')} value={changes.responsibleMembershipId === undefined ? 'unchanged' : changes.responsibleMembershipId ?? 'unassigned'}
        disabled={locked} options={[{ value: 'unchanged', label: t('taskTable.bulk.unchanged') }, { value: 'unassigned', label: t('taskTable.taskTable.unassigned') }, ...members.map(member => ({ value: member.id, label: member.displayName }))]}
        onValueChange={value => { setSaved(null); setChanges(before => { const next = { ...before }; if (value === 'unchanged') { const { responsibleMembershipId: _unused, ...rest } = next; return rest; } return { ...next, responsibleMembershipId: value === 'unassigned' ? null : value }; }); }} />
      <Button ref={dateButton} size="sm" variant="ghost" aria-expanded={datesOpen} disabled={locked} onClick={() => setDatesOpen(value => !value)}>{t('taskTable.bulk.dates')}</Button>
      <Button size="sm" variant="primary" disabled={locked || !dirty} onClick={apply}>{t('taskTable.bulk.apply')}</Button>
      {onContinue ? <Button size="sm" variant="ghost" disabled={locked} onClick={onContinue}>{t('taskTable.bulk.continue')}</Button> : null}
      {onDelete ? <Button size="sm" variant="ghost" className="text-rose-700" disabled={locked} onClick={onDelete}>{t('taskTable.bulk.delete')}</Button> : null}
      <Button size="sm" variant="ghost" disabled={held} onClick={onClear}>{t('taskTable.bulk.clear')}</Button>
    </div>
    {datesOpen ? <div ref={datePanel} role="dialog" aria-label={t('taskTable.bulk.dateDialog')} className="absolute bottom-full left-0 mb-2 w-72 max-w-[calc(100vw-1.5rem)] max-h-[70dvh] overflow-auto rounded-xl border border-line bg-surface p-3 shadow-xl"
      onKeyDown={event => { if (event.key === 'Escape' && !event.defaultPrevented) { event.preventDefault(); event.stopPropagation(); closeDates(); } }}>
      <TaskDateInput allowEmptyClear autoFocus startDate={changes.startDate ?? ''} dueDate={changes.dueDate ?? ''} disabled={locked}
        onChange={patch => { setSaved(null); setChanges(before => ({ ...before, ...('startDate' in patch ? { startDate: patch.startDate || null } : {}), ...('dueDate' in patch ? { dueDate: patch.dueDate || null } : {}) })); }} />
      <p className="mt-2 text-xs text-muted">{t('taskTable.bulk.dateHint')}</p>
      <Button size="sm" variant="ghost" onClick={closeDates}>{t('taskTable.bulk.done')}</Button>
    </div> : null}
    {hiddenCount > 0 ? <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-muted"><span>{t('taskTable.bulk.hidden', { count: hiddenCount })}</span><Button size="sm" variant="ghost" disabled={held} onClick={onClearHidden}>{t('taskTable.bulk.clearHidden')}</Button></div> : null}
    {invalid ? <p role="alert" className="mt-2 text-red-700">{t('taskTable.bulk.invalid')}</p> : null}
    {unavailable ? <p role="status" className="mt-2 text-muted">{t('taskTable.bulk.unavailable')}</p> : null}
    {command.pendingCommand ? <p role="status" className="mt-2 text-muted">{t('taskTable.bulk.saving')}</p> : null}
    <SaveFeedback subject="taskSave" error={command.uncertain ? null : reloadError ?? command.error} uncertainError={command.uncertain?.error ?? null} />
    {command.error && !command.uncertain && onReload ? <Button size="sm" variant="ghost" disabled={reloading} onClick={() => { setReloading(true); setReloadError(null); void Promise.resolve().then(onReload).then(() => { command.reset(); setReloading(false); }, error => { setReloadError(error instanceof Error ? error : new Error(String(error))); setReloading(false); }); }}>{t('taskTable.bulk.reload')}</Button> : null}
    {command.uncertain ? <Button size="sm" disabled={command.pendingCommand !== null || !writable} onClick={() => command.retryUncertain({ onSuccess: rows => { setSaved(rows.length); setChanges({}); setDatesOpen(false); onConfirmed(rows); } })}>{t('taskTable.bulk.retry')}</Button> : null}
    {saved !== null ? <p role="status" className="mt-2 text-emerald-700">{t('taskTable.bulk.saved', { count: saved })}</p> : null}
  </section>;
}
