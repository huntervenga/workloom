import { t, useTranslation } from '../../i18n';
import type {
  PlanningPeriodDto,
  RecurrenceBindingProgressDto,
  RecurrenceBlockedCode,
  RecurrenceMaterializationResultDto,
  RecurrenceReadinessDto,
} from '@workloom/contracts';
import { Badge, Button, type BadgeTone } from '@workloom/ui';
import { RefreshCw } from 'lucide-react';
import { useId } from 'react';
import { isAccessDenied } from '../../lib/api';
import { QueryErrorState } from '../../shared/QueryErrorState';

export interface RecurrenceReadinessCardProps {
  period: PlanningPeriodDto;
  data: RecurrenceReadinessDto | undefined;
  error: Error | null;
  loading: boolean;
  fetching: boolean;
  /** Outcome of the latest explicit prepare command; shown only when it belongs to `period`. */
  lastResult?: RecurrenceMaterializationResultDto | undefined;
  materializing: boolean;
  /** Another held command owns the write slot; a new prepare must wait. */
  blocked: boolean;
  writable: boolean;
  /** The parent owns the cursor, idempotency key and original period of the command. */
  onPrepare: () => void;
  onRefresh: () => void;
  onOpenSeries: (seriesId: string) => void;
}

type ReadinessState = RecurrenceReadinessDto['state'];

const stateLabels: Record<ReadinessState, string> = {
  get complete() { return t('recurrence.meetingsPrepared'); },
  get pending() { return t('recurrence.preparationIncomplete'); },
  get blocked() { return t('recurrence.preparationBlocked'); },
};

const stateTones: Record<ReadinessState, BadgeTone> = {
  complete: 'accent',
  pending: 'muted',
  blocked: 'warning',
};

const stateDescriptions: Record<ReadinessState, string> = {
  get complete() { return t('recurrence.allRecurringMeetingsInThisPeriodArePrepared'); },
  get pending() { return t('recurrence.someRecurringMeetingsInThisPeriodAreNotPrepared'); },
  get blocked() { return t('recurrence.preparationIsBlockedForSomeMeetingsResolveItIn'); },
};

const bindingStateLabels: Record<RecurrenceBindingProgressDto['state'], string> = {
  get complete() { return t('recurrence.prepared'); },
  get pending() { return t('recurrence.incomplete'); },
  get blocked() { return t('recurrence.blocked'); },
};

/** Fixed, payload-free copy for every bounded block code. */
const blockedReasons: Record<RecurrenceBlockedCode, string> = {
  get authorization_missing() { return t('recurrence.noOneHasAuthorizedPreparationOfThisSeriesOn'); },
  get authorizer_inactive() { return t('recurrence.thePersonWhoAuthorizedPreparationIsNoLongerA'); },
  get authorizer_capability_revoked() { return t('recurrence.thePersonWhoAuthorizedPreparationNoLongerHasTask'); },
  get authorization_revision_stale() { return t('recurrence.preparationAuthorizationIsOutdatedAfterASeriesChange'); },
  get cross_period_conflict() { return t('recurrence.aSeriesMeetingFallsWithinMoreThanOneSelected'); },
  get candidate_limit_exceeded() { return t('recurrence.theSeriesHasMoreMeetingsThanCanBePrepared'); },
  get source_unavailable() { return t('recurrence.seriesDataIsCurrentlyUnavailableForPreparation'); },
  get unsupported_event_version() { return t('recurrence.thePreparationRequestUsesAnUnsupportedFormat'); },
};

const authorizationCodes: ReadonlySet<RecurrenceBlockedCode> = new Set([
  'authorization_missing',
  'authorizer_inactive',
  'authorizer_capability_revoked',
  'authorization_revision_stale',
]);

const hintClass = 'text-xs leading-relaxed text-muted';

const pauseNote = () =>
  t('recurrence.meetingsArePreparedOnlyInExplicitlySelectedPeriodsPausing');

function sameId(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

function recoveryHint(code: RecurrenceBlockedCode | null): string {
  if (code !== null && authorizationCodes.has(code)) {
    return t('recurrence.someoneWithTaskEditingPermissionCanOpenTheSeries');
  }
  return t('recurrence.openTheSeriesToCheckItsScheduleAndSelected');
}

export function RecurrenceReadinessCard({
  period,
  data,
  error,
  loading,
  fetching,
  lastResult,
  materializing,
  blocked,
  writable,
  onPrepare,
  onRefresh,
  onOpenSeries,
}: RecurrenceReadinessCardProps) {
  const { t } = useTranslation();
  const headingId = useId();
  const readiness = data !== undefined && sameId(data.periodId, period.id) ? data : undefined;
  const result = lastResult !== undefined && sameId(lastResult.periodId, period.id) ? lastResult : undefined;

  const header = (
    <div className="min-w-0">
      <h3 id={headingId} className="font-semibold">
        {t('recurrence.recurringMeetingsInPeriod')}</h3>
      <p className="mt-1 text-sm [overflow-wrap:anywhere] text-muted">{period.name}</p>
    </div>
  );

  // A denial hides everything already loaded for this period, including binding controls.
  if (isAccessDenied(error)) {
    return (
      <section aria-labelledby={headingId} className="space-y-4 rounded-xl border border-line bg-surface p-4 sm:p-5">
        {header}
        <QueryErrorState error={error} subject="planning" headingLevel={3} />
      </section>
    );
  }

  if (error !== null) {
    return (
      <section aria-labelledby={headingId} className="space-y-4 rounded-xl border border-line bg-surface p-4 sm:p-5">
        {header}
        <QueryErrorState error={error} subject="planning" headingLevel={3} retrying={fetching} onRetry={onRefresh} />
      </section>
    );
  }

  if (readiness === undefined) {
    return (
      <section aria-labelledby={headingId} className="space-y-4 rounded-xl border border-line bg-surface p-4 sm:p-5">
        {header}
        {loading ? (
          <p role="status" className="text-sm text-muted">
            {t('recurrence.checkingPeriodMeetingPreparation')}</p>
        ) : (
          <div className="space-y-3">
            <p className="text-sm text-muted">{t('recurrence.preparationStateForThisPeriodIsNotAvailableYet')}</p>
            <RefreshButton fetching={fetching} onRefresh={onRefresh} />
          </div>
        )}
      </section>
    );
  }

  const canContinue = result !== undefined && result.status === 'pending' && result.nextCursor !== null;
  const needsPrepare = readiness.state !== 'complete' || canContinue;

  // The normal state stays compact; counts, the last run and per-series progress are one click away.
  if (!needsPrepare) {
    return (
      <section aria-labelledby={headingId} aria-busy={fetching || undefined} className="space-y-3 rounded-xl border border-line bg-surface p-4 sm:p-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          {header}
          <Badge tone={stateTones.complete}>{stateLabels.complete}</Badge>
        </div>
        <p className="text-sm leading-relaxed">{stateDescriptions.complete}</p>
        {result !== undefined && result.frozenBaselineIds.length > 0 ? (
          <p role="status" className={hintClass}>
            {t('recurrence.preparationIsCompleteAndThisPeriodsBaselineIsSaved')}</p>
        ) : null}
        <details className="rounded-lg border border-line bg-canvas px-3 py-2">
          <summary className="cursor-pointer text-sm font-medium">{t('recurrence.preparationDetails')}</summary>
          <div className="mt-3 space-y-4 pb-1">
            <ReadinessCounts readiness={readiness} />
            {result !== undefined ? <LastResult result={result} /> : null}
            <BindingList readiness={readiness} onOpenSeries={onOpenSeries} />
            <p className={hintClass}>{pauseNote()}</p>
            <RefreshButton fetching={fetching} onRefresh={onRefresh} />
          </div>
        </details>
      </section>
    );
  }

  return (
    <section aria-labelledby={headingId} aria-busy={fetching || undefined} className="space-y-4 rounded-xl border border-line bg-surface p-4 sm:p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        {header}
        <Badge tone={stateTones[readiness.state]}>{stateLabels[readiness.state]}</Badge>
      </div>

      <p className="text-sm leading-relaxed">{stateDescriptions[readiness.state]}</p>

      <ReadinessCounts readiness={readiness} />

      {readiness.state !== 'complete' ? (
        <p className={hintClass}>
          {t('recurrence.thePeriodBaselineCannotBeSavedUntilPreparationIs')}</p>
      ) : null}

      {result !== undefined ? <LastResult result={result} /> : null}

      <div className="flex flex-wrap items-center gap-2">
        {writable && needsPrepare ? (
          <Button variant="primary" disabled={blocked || materializing} onClick={onPrepare}>
            {materializing ? t('recurrence.preparingMeetings') : canContinue ? t('recurrence.continuePreparingMeetings') : t('recurrence.preparePeriodMeetings')}
          </Button>
        ) : null}
        <RefreshButton fetching={fetching} onRefresh={onRefresh} />
      </div>
      {writable && needsPrepare && blocked && !materializing ? (
        <p role="status" className={hintClass}>
          {t('recurrence.anotherOperationIsRunningPreparationCanStartAfterIt')}</p>
      ) : null}
      {!writable && needsPrepare ? (
        <p className={hintClass}>{t('recurrence.preparingMeetingsRequiresPermissionToEditProjectTasks')}</p>
      ) : null}

      {readiness.bindings.length > 0 ? (
        <div className="border-t border-line pt-4">
          <BindingList readiness={readiness} onOpenSeries={onOpenSeries} />
        </div>
      ) : null}

      <p className={`border-t border-line pt-4 ${hintClass}`}>{pauseNote()}</p>
    </section>
  );
}

function ReadinessCounts({ readiness }: { readiness: RecurrenceReadinessDto }) {
  const { t } = useTranslation();
  return (
    <div className="space-y-2">
      <dl className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div className="rounded-lg border border-line bg-canvas p-3">
          <dt className="text-xs text-muted">{t('recurrence.notPrepared')}</dt>
          <dd className="mt-1 text-lg font-semibold tabular-nums">{readiness.missingCount}</dd>
        </div>
        <div className="rounded-lg border border-line bg-canvas p-3">
          <dt className="text-xs text-muted">{t('recurrence.blocked')}</dt>
          <dd className="mt-1 text-lg font-semibold tabular-nums">{readiness.blockedCount}</dd>
        </div>
      </dl>
      <p className={hintClass}>
        {t('recurrence.totalsCoverTheEntirePeriodMeetingsCancelledBeforePreparation')}</p>
    </div>
  );
}

function BindingList({
  readiness,
  onOpenSeries,
}: {
  readiness: RecurrenceReadinessDto;
  onOpenSeries: (seriesId: string) => void;
}) {
  const { t } = useTranslation();
  if (readiness.bindings.length === 0) return null;
  return (
    <div className="space-y-2">
      <h4 className="text-sm font-medium">{t('recurrence.periodSeries')}</h4>
      {readiness.truncated ? (
        <p className={hintClass}>{t('recurrence.theStatusAboveCoversTheEntirePeriodButThe')}</p>
      ) : null}
      <ul className="space-y-2">
        {readiness.bindings.map((binding, index) => (
          <BindingRow key={binding.bindingId} binding={binding} position={index + 1} onOpenSeries={onOpenSeries} />
        ))}
      </ul>
    </div>
  );
}

function RefreshButton({ fetching, onRefresh }: { fetching: boolean; onRefresh: () => void }) {
  const { t } = useTranslation();
  return (
    <Button
      aria-disabled={fetching || undefined}
      onClick={() => {
        if (!fetching) onRefresh();
      }}
    >
      <RefreshCw size={16} aria-hidden="true" className={fetching ? 'motion-safe:animate-spin' : undefined} />
      {fetching ? t('recurrence.refreshing') : t('recurrence.refreshStatus')}
    </Button>
  );
}

function LastResult({ result }: { result: RecurrenceMaterializationResultDto }) {
  const { t } = useTranslation();
  return (
    <div role="status" className="space-y-1.5 rounded-lg border border-line bg-canvas p-3">
      <p className="text-sm font-medium">{t('recurrence.lastPreparationRun')}</p>
      <p className="text-sm">
        {t('recurrence.meetingsPreparedInThisStep')}<span className="tabular-nums">{result.createdCount}</span>{t('recurrence.thisCountCoversTheLatestStepNotTheWhole')}</p>
      <p className="text-sm">
        {t('recurrence.stillToPrepareAccordingToTheServer')}<span className="tabular-nums">{result.remainingCount}</span>.
      </p>
      {result.truncated ? <p className={hintClass}>{t('recurrence.onlySomeSeriesAreShownTotalsAboveCoverThe')}</p> : null}
      {result.status === 'blocked' ? (
        <p className={hintClass}>{t('recurrence.someMeetingPreparationIsBlockedReasonsAppearInThe')}</p>
      ) : null}
      {result.frozenBaselineIds.length > 0 ? (
        <p className={hintClass}>{t('recurrence.preparationIsCompleteAndThisPeriodsBaselineIsSaved')}</p>
      ) : null}
    </div>
  );
}

function BindingRow({
  binding,
  position,
  onOpenSeries,
}: {
  binding: RecurrenceBindingProgressDto;
  position: number;
  onOpenSeries: (seriesId: string) => void;
}) {
  const { t } = useTranslation();
  return (
    <li className="space-y-1.5 rounded-lg border border-line p-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm font-medium">{t('recurrence.series2', { position: position })}</span>
        <Badge tone={stateTones[binding.state]}>{bindingStateLabels[binding.state]}</Badge>
        {binding.state !== 'complete' ? (
          <span className="text-xs text-muted">
            {t('recurrence.stillToPrepare')}<span className="tabular-nums">{binding.remainingCount}</span>
          </span>
        ) : null}
      </div>
      {binding.state === 'blocked' ? (
        <>
          <p className="text-sm">
            {binding.blockedCode === null ? t('recurrence.preparationBlocked2') : blockedReasons[binding.blockedCode]}
          </p>
          <p className={hintClass}>{recoveryHint(binding.blockedCode)}</p>
          <Button size="sm" onClick={() => onOpenSeries(binding.seriesId)}>
            {t('recurrence.openSeriesToResolve')}</Button>
        </>
      ) : null}
    </li>
  );
}
