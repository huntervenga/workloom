import type { ProjectColumnsDto, TaskFieldDefinitionDto, TaskTableBuiltinColumn } from '@workloom/contracts';
import { Button } from '@workloom/ui';
import { ArrowDown, ArrowUp, Columns3 } from 'lucide-react';
import { useLayoutEffect, useRef } from 'react';
import { useTranslation, type TranslationKey } from '../../i18n';
import { ApiError, isAccessDenied } from '../../lib/api';
import { DialogShell } from '../../shared/DialogShell';
import { QueryErrorState } from '../../shared/QueryErrorState';
import { SaveFeedback } from '../../shared/SaveFeedback';
import { columnKey, reconcilePersonalColumns } from './personalColumns';
import type { PersonalTablePreferenceController } from './usePersonalTablePreference';

const builtinLabels = {
  title: 'taskTable.taskTable.task2', status: 'taskTable.taskTable.status', responsible: 'taskTable.taskTable.assignee',
  participants: 'taskTable.taskTable.participants', dueDate: 'taskTable.taskTable.dueDate', tags: 'taskTable.taskTable.tags',
  priority: 'taskTable.taskTable.priority', estimate: 'taskTable.taskTable.teamEstimate',
  weeklyPlan: 'taskTable.personalColumns.weeklyPlan', weeklyActual: 'taskTable.personalColumns.weeklyActual',
} satisfies Record<TaskTableBuiltinColumn, TranslationKey>;
/** Mirrors the controller's denial rule so the shown cause is the actual denial, not a stale unrelated error. */
const unavailable = (error: unknown) => isAccessDenied(error) || error instanceof ApiError && error.kind === 'unauthenticated';
interface Props {
  controller: PersonalTablePreferenceController; fields: readonly TaskFieldDefinitionDto[];
  projectColumns: ProjectColumnsDto | undefined; timeAvailable: boolean; catalogError: unknown;
  onReloadCatalog: () => Promise<void>;
  showTrigger?: boolean;
}
export function PersonalColumnsDialog({ controller: c, fields, projectColumns, timeAvailable, catalogError, onReloadCatalog, showTrigger = true }: Props) {
  const { t } = useTranslation();
  const refs = useRef(new Map<string, HTMLButtonElement>());
  const focusAfterMove = useRef<string | null>(null);
  const stored = c.held ? c.held.variables.input.columns : c.draft ? c.draft.columns : c.query.data?.columns ?? null;
  const result = projectColumns ? reconcilePersonalColumns(stored, fields, projectColumns, timeAvailable) : null;
  const choices = result?.choices ?? [];
  const ownFields = new Map(fields.filter(field => field.projectId === projectColumns?.projectId && field.workspaceId === projectColumns.workspaceId).map(field => [field.id.toLowerCase(), field]));
  const conflict = c.command.error instanceof ApiError && c.command.error.kind === 'conflict';
  const frozen = c.frozen || !c.query.data || !projectColumns || Boolean(catalogError);
  // A definitive rejection or failed post-save head read must stay visible after close, including views without the trigger.
  const closedFailure = !c.open && c.held === null && (c.command.error !== null || c.head === 'failed');
  // Any command error means that command was not saved; a denied head read alone says nothing about an acknowledged save.
  const closedFailureKey = c.denied ? c.command.error ? 'taskTable.personalColumns.collapsedDenied' : 'taskTable.personalColumns.unavailableView' : conflict ? 'taskTable.personalColumns.collapsedConflict' : c.command.error ? 'taskTable.personalColumns.collapsedFailed' : 'taskTable.personalColumns.collapsedHeadFailed';
  const deniedError = unavailable(c.query.error) ? c.query.error : c.command.error;
  useLayoutEffect(() => { const key = focusAfterMove.current; if (key) { focusAfterMove.current = null; const primary = refs.current.get(key); const opposite = key.endsWith(':-1') ? `${key.slice(0, -3)}:1` : `${key.slice(0, -2)}:-1`; (primary && !primary.disabled ? primary : refs.current.get(opposite))?.focus(); } });
  const reload = async () => { await onReloadCatalog(); await c.reload(); };
  const move = (index: number, direction: -1 | 1) => {
    const target = index + direction;
    if (frozen || index === 0 || target < 1 || target >= choices.length) return;
    const next = [...choices]; const a = next[index]; const b = next[target]; if (!a || !b) return;
    next[index] = b; next[target] = a;
    focusAfterMove.current = `${columnKey(a.column)}:${direction}`; c.setDraft(next);
  };
  return <>
    {showTrigger ? <Button size="sm" aria-haspopup="dialog" aria-expanded={c.open} onClick={() => c.setOpen(true)}><Columns3 size={16} aria-hidden="true" />{t(c.draft ? 'taskTable.personalColumns.columnsDraft' : 'taskTable.personalColumns.columns')}</Button> : null}
    {c.held && !c.open ? <div role="status" className="text-xs text-amber-800">{t(c.command.uncertain ? 'taskTable.personalColumns.collapsedUnknown' : 'taskTable.personalColumns.collapsedPending')}{!showTrigger ? <Button size="sm" variant="ghost" onClick={() => c.setOpen(true)}>{t('taskTable.personalColumns.resumeSave')}</Button> : null}</div> : null}
    {closedFailure ? <div role="status" className="text-xs text-amber-800">{t(closedFailureKey)}{!showTrigger ? <Button size="sm" variant="ghost" onClick={() => c.setOpen(true)}>{t('taskTable.personalColumns.reviewColumns')}</Button> : null}</div> : null}
    <DialogShell title={t('taskTable.personalColumns.title')} description={t('taskTable.personalColumns.description')} open={c.open} onOpenChange={c.setOpen}>
      {c.denied ? <QueryErrorState error={deniedError} subject="tablePreference" headingLevel={2} /> : <>
        <p className="mt-3 text-xs text-muted">{t(c.query.data?.columns === null ? 'taskTable.personalColumns.followingDefaults' : 'taskTable.personalColumns.personalView')}</p>
        {c.query.isPending ? <p role="status" className="mt-3 text-sm">{t('taskTable.personalColumns.loading')}</p> : null}
        {c.query.isError ? <QueryErrorState error={c.query.error} subject="tablePreference" headingLevel={2} onRetry={() => void reload()} retrying={c.query.isFetching} /> : null}
        {catalogError ? <QueryErrorState error={catalogError} subject="columns" headingLevel={2} onRetry={() => void reload()} /> : null}
        {result?.addedRefs.length ? <p role="status" className="mt-3 text-xs text-muted">{t('taskTable.personalColumns.newColumns', { count: result.addedRefs.length })}</p> : null}
        {result?.limitExceeded ? <p role="alert" className="mt-3 text-sm text-red-700">{t('taskTable.personalColumns.limit')}</p> : null}
        {result?.invalidRefs.length ? <p role="alert" className="mt-3 text-sm text-red-700">{t('taskTable.personalColumns.invalid')}</p> : null}
        <ul aria-label={t('taskTable.personalColumns.list')} className="mt-3 max-h-[48dvh] space-y-2 overflow-y-auto py-1">
          {choices.map((choice, index) => {
            const ref = choice.column; const key = columnKey(ref);
            const field = ref.kind === 'field' ? ownFields.get(ref.fieldId.toLowerCase()) : undefined;
            const invalid = ref.kind === 'field' && !field;
            const inactive = field?.archivedAt !== undefined && field.archivedAt !== null;
            const time = ref.kind === 'builtin' && (ref.key === 'weeklyPlan' || ref.key === 'weeklyActual');
            const name = ref.kind === 'builtin' ? t(builtinLabels[ref.key]) : field?.name ?? t('taskTable.personalColumns.unavailable');
            return <li key={key} className="flex items-center gap-2 rounded-lg border border-line px-2 py-2 text-sm">
              <label className="flex min-w-0 flex-1 items-start gap-2"><input type="checkbox" className="mt-0.5" checked={choice.visible} disabled={frozen || index === 0 || inactive || invalid} onChange={event => c.setDraft(choices.map((item, at) => at === index ? { ...item, visible: event.target.checked } : item))} /><span className="min-w-0"><span className="block truncate" title={name}>{name}</span>{index === 0 ? <span className="block text-xs text-muted">{t('taskTable.personalColumns.pinned')}</span> : inactive || invalid ? <span className="block text-xs text-muted">{t('taskTable.personalColumns.inactive')}</span> : time && !timeAvailable ? <span className="block text-xs text-muted">{t('taskTable.personalColumns.timeUnavailable')}</span> : null}</span></label>
              {inactive || invalid ? <Button size="sm" variant="ghost" disabled={frozen} aria-label={t('taskTable.personalColumns.remove', { name })} onClick={() => c.setDraft(choices.filter((_, at) => at !== index))}>{t('taskTable.personalColumns.removeShort')}</Button> : null}
              {([-1, 1] as const).map(direction => <button key={direction} ref={node => { const id = `${key}:${direction}`; if (node) refs.current.set(id, node); else refs.current.delete(id); }} type="button" disabled={frozen || index === 0 || index + direction < 1 || index + direction >= choices.length} aria-label={t(direction === -1 ? 'taskTable.personalColumns.moveUp' : 'taskTable.personalColumns.moveDown', { name })} className="inline-flex size-7 shrink-0 items-center justify-center rounded text-muted hover:bg-canvas disabled:opacity-30" onClick={() => move(index, direction)}>{direction === -1 ? <ArrowUp size={14} aria-hidden="true" /> : <ArrowDown size={14} aria-hidden="true" />}</button>)}
            </li>;
          })}
        </ul>
        <SaveFeedback subject="tablePreferenceSave" error={c.command.error} uncertainError={c.command.uncertain?.error ?? null} />
        {c.saveConfirmed && c.head === 'idle' ? <p role="status" className="mt-3 text-sm text-ink-soft">{t('taskTable.personalColumns.saved')}</p> : null}
        {c.head === 'loading' ? <p role="status" className="mt-3 text-xs">{t('taskTable.personalColumns.refreshingHead')}</p> : c.head === 'failed' ? <p role="alert" className="mt-3 text-xs text-red-700">{t(c.saveConfirmed ? 'taskTable.personalColumns.headFailed' : 'taskTable.personalColumns.headRefreshFailed')}</p> : null}
        <p className="mt-3 text-xs text-muted">{t(c.draft?.columns === null ? 'taskTable.personalColumns.resetPending' : 'taskTable.personalColumns.saveHint')}</p>
      </>}
      <div className="mt-4 flex flex-wrap gap-2 border-t border-line pt-3">
        {c.command.uncertain ? <Button size="sm" variant="primary" disabled={c.command.pendingCommand !== null || c.denied} onClick={() => c.command.retryUncertain()}>{t('taskTable.personalColumns.retry')}</Button> : <Button size="sm" variant="primary" disabled={frozen || conflict || !c.draft || Boolean(result?.invalidRefs.length) || Boolean(result?.limitExceeded)} onClick={() => c.save(c.draft?.columns === null ? null : choices)}>{t('taskTable.personalColumns.save')}</Button>}
        <Button size="sm" disabled={frozen} onClick={() => c.setDraft(null)}>{t('taskTable.personalColumns.reset')}</Button>
        <Button size="sm" variant="ghost" disabled={c.held !== null} onClick={c.discard}>{t('taskTable.personalColumns.discard')}</Button>
        {conflict || c.head === 'failed' || c.denied ? <Button size="sm" disabled={c.held !== null || c.query.isFetching} onClick={() => void reload()}>{t('taskTable.personalColumns.reload')}</Button> : null}
        <Button size="sm" variant="ghost" onClick={() => c.setOpen(false)}>{t('taskTable.personalColumns.close')}</Button>
      </div>
    </DialogShell>
  </>;
}
