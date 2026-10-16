import { useTranslation } from '../../i18n';
import { MATERIALIZATION_REQUIRED, type FreezePreviewDto, type FreezeScope, type PlanningPeriodDto } from '@workloom/contracts';
import { Badge, Button } from '@workloom/ui';
import { RefreshCw } from 'lucide-react';
import { useEffect, useState } from 'react';
import { ApiError } from '../../lib/api';
import { DialogShell } from '../../shared/DialogShell';
import { QueryErrorState } from '../../shared/QueryErrorState';
import { SaveFeedback } from '../../shared/SaveFeedback';
import { formatEstimate } from '../task-table';
import { fetchFreezePreview } from './api';
import type { PlanningCommands } from './queries';

export interface FreezeRequest { period: PlanningPeriodDto; scope: FreezeScope; nonce: number }
interface Props {
  workspaceId: string;
  request: FreezeRequest | null;
  open: boolean;
  mutation: PlanningCommands['freeze'];
  onClose: () => void;
  onFrozen: (periodId: string, baselineId: string) => void;
  /** The period's series meetings are not all prepared; the parent reveals that period's readiness. */
  onMaterializationRequired?: ((periodId: string) => void) | undefined;
}

/** Only the public code is read; recovery goes through the readiness read, never error details. */
function needsMeetings(error: Error | null): boolean {
  return error instanceof ApiError && error.code === MATERIALIZATION_REQUIRED;
}

/** Preview is a full server snapshot. Confirm sends its hash, never a reconstructed client manifest. */
export function FreezeDialog({ workspaceId, request, open, mutation, onClose, onFrozen, onMaterializationRequired }: Props) {
  const { t } = useTranslation();
  const [preview, setPreview] = useState<FreezePreviewDto | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const [stale, setStale] = useState(false);
  const [reloadToken, setReloadToken] = useState(0);
  useEffect(() => {
    if (!request) return undefined;
    const controller = new AbortController();
    let active = true;
    setLoading(true); setError(null); setPreview(null); setStale(false);
    void fetchFreezePreview(workspaceId, request.period.id, { scope: request.scope }, controller.signal).then((result) => {
      if (active) { setPreview(result); setLoading(false); }
    }).catch((failure: unknown) => {
      if (active) { setError(failure instanceof Error ? failure : new Error('Preview failed')); setLoading(false); }
    });
    return () => { active = false; controller.abort(); };
  }, [workspaceId, request, reloadToken]);
  if (!request) return null;
  const held = mutation.pendingCommand?.variables ?? mutation.uncertain?.variables ?? null;
  const heldHere = held?.periodId === request.period.id && held.input.scope === request.scope ? held : null;
  const blocked = held !== null && heldHere === null;
  const ownError = mutation.variables?.periodId === request.period.id && mutation.variables.input.scope === request.scope ? mutation.error : null;
  const refresh = () => { if (held !== null) return; mutation.reset(); setReloadToken((value) => value + 1); };
  const confirmNeedsMeetings = held === null && needsMeetings(ownError);
  // Always the original request's period; preparing never freezes, so a fresh preview follows it.
  const prepareMeetings = onMaterializationRequired && (needsMeetings(error) || confirmNeedsMeetings)
    ? <Button size="sm" variant="primary" onClick={() => onMaterializationRequired(request.period.id)}>{t('planning.preparePeriodMeetings')}</Button>
    : null;
  const confirm = () => {
    const success = (baseline: { periodId: string; id: string }) => onFrozen(baseline.periodId, baseline.id);
    if (heldHere) {
      if (!mutation.pendingCommand && mutation.uncertain) mutation.retryUncertain({ onSuccess: success });
      return;
    }
    if (!preview || loading || stale || blocked || preview.existingBaselineId !== null) return;
    mutation.mutate({ periodId: request.period.id, input: { scope: request.scope, previewHash: preview.previewHash } }, {
      onSuccess: success,
      onError: (failure) => { if (failure instanceof ApiError && failure.kind === 'conflict') setStale(true); },
    });
  };
  return (
    <DialogShell title={request.scope === 'self' ? t('planning.saveMyBaseline') : t('planning.saveProjectBaseline')} description={t('planning.theBaselineIsSavedSeparatelyFromLaterWork', { periodName: request.period.name })} open={open} onOpenChange={(next) => { if (!next) onClose(); }}>
      <div className="mt-5 space-y-4">
        {loading ? <p role="status" className="text-sm text-muted">{t('planning.loadingAFreshPreview')}</p> : null}
        {error && needsMeetings(error) ? <div role="alert" className="space-y-2 rounded-lg border border-amber-200 bg-amber-50/80 px-3 py-2.5 text-sm text-amber-900"><p className="font-medium text-amber-950">{t('planning.preparePeriodMeetingsFirst')}</p><p className="leading-relaxed">{t('planning.someRecurringMeetingsInThisPeriodAreNotReady')}</p><div className="flex flex-wrap gap-2">{prepareMeetings}<Button size="sm" disabled={loading} onClick={refresh}><RefreshCw size={14} aria-hidden="true" />{t('planning.refreshPreview')}</Button></div></div> : error ? <QueryErrorState error={error} subject="freeze" headingLevel={3} retrying={loading} onRetry={refresh} /> : null}
        {blocked ? <p role="status" className="text-sm text-amber-800">{t('planning.anotherBaselineSaveIsUnresolvedResolveItFirst')}</p> : null}
        {preview ? <>
          <p className="text-sm text-ink-soft">{t('planning.theServerChecksThisCompleteSnapshotAgainWhenYou')}</p>
          {preview.existingBaselineId ? <Badge tone="muted">{t('planning.thisBaselineIsAlreadySaved')}</Badge> : null}
          <section aria-label={t('planning.baselinePreview')} className="space-y-3 rounded-xl border border-line bg-canvas p-3">
            {preview.snapshot.commitments.length === 0 ? <p className="text-sm text-muted">{t('planning.thereAreNoPersonalCommitmentsInThisBaselineYet')}</p> : preview.snapshot.commitments.map((item) => {
              const member = preview.snapshot.memberships.find((value) => value.id === item.membershipId);
              const work = preview.snapshot.packages.find((value) => value.id === item.workPackageId);
              return <div key={item.id} className="space-y-1 border-b border-line pb-3 last:border-0 last:pb-0"><p className="text-sm font-medium [overflow-wrap:anywhere]">{work?.title ?? t('planning.task')}</p><p className="text-xs text-muted">{t('planning.plannedHours3', { person: member?.displayName ?? t('planning.person'), hours: item.plannedMinutes === null ? t('planning.notSet') : formatEstimate(item.plannedMinutes), status: item.state === 'removed' ? t('planning.removedFromPlan') : '', classification: item.classification === 'added' ? t('planning.addedWork') : '' })}</p>{work ? <p className="text-xs text-muted">{t('planning.totalWork2', { hours: work.estimateMinutes === null ? t('planning.estimateUnknown') : formatEstimate(work.estimateMinutes) })}</p> : null}</div>;
            })}
          </section>
          {preview.snapshot.recurrence ? <section aria-label={t('planning.recurringScheduleInBaseline')} className="space-y-2 rounded-xl border border-line bg-canvas p-3">
            <h3 className="text-sm font-semibold">{t('planning.recurringSchedule')}</h3>
            <p className="text-sm">{t('planning.scheduledCancelled', { scheduledCount: preview.snapshot.recurrence.census.filter(item => item.calendarState === 'scheduled').length, cancelledCount: preview.snapshot.recurrence.census.filter(item => item.calendarState === 'cancelled').length })}</p>
            <p className="text-xs leading-relaxed text-muted">{t('planning.theSnapshotPreservesTheMeetingCalendarIncludingCancelledDates')}</p>
            {preview.snapshot.recurrence.census.length > 0 ? <details className="text-sm"><summary className="cursor-pointer font-medium">{t('planning.viewSeriesDates')}</summary><ul className="mt-2 space-y-2">{preview.snapshot.recurrence.census.slice(0, 20).map(item => <li key={item.instanceId} className="text-xs [overflow-wrap:anywhere]">{t('planning.seriesDateUtc', { occurrenceKey: item.occurrenceKey, resolvedLocalDate: item.resolution.resolvedLocalDate, resolvedLocalTime: item.resolution.resolvedLocalTime, timezone: item.resolution.provenance.timezone, resolvedOffset: item.resolution.resolvedOffset, state: item.calendarState === 'cancelled' ? t('planning.cancelled2') : t('planning.scheduled2') })}</li>)}</ul>{preview.snapshot.recurrence.census.length > 20 ? <p className="mt-2 text-xs text-muted">{t('planning.showingTheFirst20OfDatesTheSnapshotPreserves', { total: preview.snapshot.recurrence.census.length })}</p> : null}</details> : null}
          </section> : null}
          <div className="space-y-1 text-xs leading-relaxed text-muted">{preview.snapshot.period.protectEstimate ? <p>{t('planning.sharedEstimatesForIncludedTasksWillBeProtected')}</p> : null}{preview.snapshot.period.protectedFieldIds.length > 0 ? <p>{t('planning.selectedCustomFieldsWillAlsoBeProtected')}</p> : null}<p>{t('planning.youCanAddNewWorkAfterSavingTheBaseline')}</p></div>
        </> : null}
        <SaveFeedback subject="freeze" error={ownError} uncertainError={heldHere ? mutation.uncertain?.error ?? null : null} action={stale ? <div className="flex flex-wrap gap-2">{confirmNeedsMeetings ? prepareMeetings : null}<Button size="sm" onClick={refresh}><RefreshCw size={14} aria-hidden="true" />{t('planning.refreshPreview')}</Button></div> : null} />
        {confirmNeedsMeetings ? <p className="text-xs leading-relaxed text-muted">{t('planning.someRecurringMeetingsAreNotReadyPrepareThemThen')}</p> : null}
        <div className="flex flex-wrap justify-end gap-2 border-t border-line pt-4"><Button onClick={onClose}>{t('planning.close')}</Button>{held === null && preview && !stale ? <Button onClick={refresh} disabled={loading}>{t('planning.refreshPreview')}</Button> : null}{heldHere || preview?.existingBaselineId === null ? <Button variant="primary" disabled={mutation.pendingCommand !== null || blocked || loading || stale || (!preview && heldHere === null)} onClick={confirm}>{heldHere ? mutation.pendingCommand ? t('planning.savingBaseline') : t('planning.retryOriginalSave') : t('planning.confirmBaseline')}</Button> : null}</div>
      </div>
    </DialogShell>
  );
}
