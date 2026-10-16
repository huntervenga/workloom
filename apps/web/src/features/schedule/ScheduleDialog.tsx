import { useTranslation } from '../../i18n';
import type { PlanningPeriodDto } from '@workloom/contracts';
import { Button, TextInput } from '@workloom/ui';
import { useNavigate } from 'react-router';
import { isAccessDenied } from '../../lib/api';
import { DialogShell } from '../../shared/DialogShell';
import { SaveFeedback } from '../../shared/SaveFeedback';
import { ComparisonList } from './ComparisonList';
import { scheduleDraftInput, scheduleConflict, type ScheduleWorkspace } from './useScheduleWorkspace';

export function ScheduleDialog({ controller: c, workspaceId, periods, writable }: { controller: ScheduleWorkspace; workspaceId: string; projectId: string; periods: readonly PlanningPeriodDto[]; writable: boolean }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const draft = c.active;
  if (!draft) return null;
  const ownHeld = c.held?.draftId === draft.id ? c.held : null;
  const rows = ownHeld ? draft.rows.map(row => { const sent = ownHeld.input.rows.find(item => item.taskId === row.taskId); return sent ? { ...row, startDate: sent.startDate ?? '', dueDate: sent.dueDate ?? '', expectedRevision: sent.expectedRevision } : row; }) : draft.rows;
  const input = scheduleDraftInput(draft);
  const locked = !!c.held || c.rebasing !== null || !writable;
  const error = c.mutation.variables?.draftId === draft.id ? c.mutation.error : null;
  const denied = c.denied || isAccessDenied(error);
  const preview = draft.preview;
  const names = new Map(draft.rows.map(row => [row.taskId, row.title]));
  return <DialogShell variant="drawer" title={t('schedule.scheduleDialog.editTaskDates')} description={t('schedule.scheduleDialog.enterCalendarDatesReviewChangesAndApplyThem')} open onOpenChange={open => { if (!open) c.setActiveId(null); }}>
    <div className="min-h-0 flex-1 space-y-5 overflow-y-auto py-5 [scroll-padding-bottom:1rem]">
      {denied ? <p role="alert" className="text-sm text-muted">{t('schedule.scheduleDialog.datesAreHiddenBecauseAccessIsUnconfirmedClose')}</p> : <>
        <fieldset disabled={locked} className="space-y-4"><legend className="sr-only">{t('schedule.scheduleDialog.selectedTaskDates')}</legend>
          {rows.map(row => <section key={row.taskId} aria-label={t('schedule.scheduleDialog.datesValue', { p0: row.title })} className="space-y-3 rounded-xl border border-line p-3"><h3 className="text-sm font-semibold [overflow-wrap:anywhere]">{row.title}</h3>{!row.editable ? <p className="text-xs text-muted">{t('schedule.scheduleDialog.theseTaskDatesCannotBeEditedHereUse')}</p> : null}<div className="grid gap-3 sm:grid-cols-2"><label className="space-y-1 text-sm font-medium">{t('schedule.scheduleDialog.startDate')}<TextInput type="date" min="0001-01-01" max="9999-12-31" value={row.startDate} disabled={!row.editable} onChange={e => c.change(draft.id, row.taskId, { startDate: e.target.value })} /></label><label className="space-y-1 text-sm font-medium">{t('schedule.scheduleDialog.dueDate')}<TextInput type="date" min="0001-01-01" max="9999-12-31" value={row.dueDate} disabled={!row.editable} onChange={e => c.change(draft.id, row.taskId, { dueDate: e.target.value })} /></label></div><p className="text-xs text-muted">{t('schedule.scheduleDialog.anEmptyFieldExplicitlyRemovesTheDateThe')}</p></section>)}
          <div className="flex flex-wrap gap-2"><Button disabled={rows.some(row => !row.editable)} onClick={() => c.shift(draft.id, -1)}>{t('schedule.scheduleDialog.moveOneDayEarlier')}</Button><Button disabled={rows.some(row => !row.editable)} onClick={() => c.shift(draft.id, 1)}>{t('schedule.scheduleDialog.moveOneDayLater')}</Button></div>
        </fieldset>
        {!input ? <p role="alert" className="text-sm text-red-800">{t('schedule.scheduleDialog.checkDatesStartMustBeOnOrBefore')}</p> : null}
        {c.previewing === draft.id ? <p role="status" className="text-sm text-muted">{t('schedule.scheduleDialog.checkingCurrentDatesAndDependencies')}</p> : null}
        <SaveFeedback subject="taskSave" error={draft.error ?? error} uncertainError={ownHeld ? c.mutation.uncertain?.error ?? null : null} />
        {(scheduleConflict(error) || scheduleConflict(draft.error)) && !c.held ? <div className="space-y-2"><p className="text-xs text-muted">{t('schedule.scheduleDialog.sourcesChangedRefreshVersionsWhileKeepingYourDates')}</p><Button disabled={c.rebasing !== null} onClick={() => void c.rebase(draft)}>{t('schedule.scheduleDialog.refreshVersionsAndKeepDates')}</Button></div> : null}
        {preview ? <section aria-label={t('schedule.scheduleDialog.taskDateChangePreview')} className="space-y-4"><h3 className="font-semibold">{t('schedule.scheduleDialog.reviewChanges')}</h3><ul className="space-y-3">{preview.rows.map(row => <li key={row.taskId} className="rounded-lg border border-line p-3 text-sm"><p className="font-medium [overflow-wrap:anywhere]">{names.get(row.taskId) ?? t('schedule.scheduleDialog.selectedTask')}</p><p className="mt-1 text-xs text-muted">{t('schedule.scheduleDialog.dateRangeBefore', { start: row.before.startDate ?? t('schedule.scheduleDialog.noStartDate'), due: row.before.dueDate ?? t('schedule.scheduleDialog.noDueDate') })}</p><p className="mt-1 text-xs">{t('schedule.scheduleDialog.dateRangeAfter', { start: row.after.startDate ?? t('schedule.scheduleDialog.noStartDate'), due: row.after.dueDate ?? t('schedule.scheduleDialog.noDueDate') })}{row.changed ? '' : t('schedule.scheduleDialog.unchanged')}</p></li>)}</ul>
          {preview.protectedTargets.length ? <div role="alert" className="space-y-2 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900"><p>{t('schedule.scheduleDialog.theseDatesCannotBeApplied')}</p>{preview.protectedTargets.map(target => <p key={target.taskId}>{names.get(target.taskId) ?? t('schedule.scheduleDialog.selectedTask')} · {target.reason === 'meeting_task' ? t('schedule.scheduleDialog.openTheMeetingCalendar') : t('schedule.scheduleDialog.restoreTheArchivedTaskFirst')}</p>)}</div> : null}
          {preview.recoveryPeriodIds.length ? <div role="alert" className="space-y-2 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900"><p>{t('schedule.scheduleDialog.prepareMeetingsAndRefreshPeriodStateFirstThen')}</p>{preview.recoveryPeriodIds.map((id, index) => <Button key={id} size="sm" disabled={c.openingRecovery !== null} onClick={() => { void c.resolveRecoveryPeriod(draft, id).then(route => { if (route) void navigate(route); }); }}>{t('schedule.scheduleDialog.openNamedPeriod', { name: periods.find(period => period.id === id)?.name ?? t('schedule.scheduleDialog.periodValue', { p0: index + 1 }) })}</Button>)}</div> : null}
          <ComparisonList comparisons={preview.comparisons} names={names} workspaceId={workspaceId} />
        </section> : null}
      </>}
      {c.held && !ownHeld ? <p role="status" className="text-sm text-amber-900">{t('schedule.scheduleDialog.anotherDateSubmissionIsUnconfirmedItsOriginalDates')}</p> : null}
      {ownHeld ? <p role="status" className="text-sm text-amber-900">{t('schedule.scheduleDialog.showingTheOriginalSubmittedDatesTheyStayFixed')}</p> : null}
    </div>
    <div role="group" aria-label={t('schedule.scheduleDialog.dateActions')} className="flex shrink-0 flex-wrap justify-end gap-2 border-t border-line bg-surface pt-4"><Button disabled={!!ownHeld} onClick={() => c.discard(draft.id)}>{t('schedule.scheduleDialog.discardDateDraft')}</Button><Button onClick={() => c.setActiveId(null)}>{t('schedule.scheduleDialog.close')}</Button>{ownHeld && c.mutation.uncertain ? <Button variant="primary" disabled={!!c.mutation.pendingCommand} onClick={() => c.mutation.retryUncertain()}>{t('schedule.scheduleDialog.retryOriginalDates')}</Button> : <><Button disabled={locked || denied || !input || c.previewing !== null} onClick={() => void c.preview(draft)}>{t('schedule.scheduleDialog.previewChanges')}</Button><Button variant="primary" disabled={locked || denied || !input || !preview || c.previewing !== null || !!preview.protectedTargets.length || !!preview.recoveryPeriodIds.length || !!error} onClick={() => c.apply(draft)}>{t('schedule.scheduleDialog.applyDates')}</Button></>}</div>
  </DialogShell>;
}

export function ScheduleNotices({ controller: c }: { controller: ScheduleWorkspace }) {
  const { t } = useTranslation();
  return <>{c.held ? <div role="status" className="space-y-2 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900"><p>{t(c.mutation.pendingCommand ? 'schedule.scheduleDialog.datesPending' : 'schedule.scheduleDialog.datesUnconfirmed')}</p><div className="flex flex-wrap gap-2"><Button size="sm" onClick={() => { if (c.held) c.setActiveId(c.held.draftId); }}>{t('schedule.scheduleDialog.openOriginalDates')}</Button>{c.mutation.uncertain ? <Button size="sm" onClick={() => c.mutation.retryUncertain()}>{t('schedule.scheduleDialog.retryOriginalDateSubmission')}</Button> : null}</div></div> : null}{Object.values(c.drafts).filter(draft => draft.id !== c.activeId && draft.id !== c.held?.draftId).map(draft => <div key={draft.id} className="flex flex-wrap items-center gap-2 text-xs text-muted"><span>{t('schedule.scheduleDialog.dateDraftCount', { count: draft.rows.length })}</span><Button size="sm" onClick={() => c.setActiveId(draft.id)}>{t('schedule.scheduleDialog.continueDateDraft')}</Button><Button size="sm" onClick={() => c.discard(draft.id)}>{t('schedule.scheduleDialog.discardDraft')}</Button></div>)}</>;
}
