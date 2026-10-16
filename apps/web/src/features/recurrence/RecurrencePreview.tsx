import { t, useTranslation, formatDate } from '../../i18n';
import type {
  PlanningPeriodDto,
  RecurrenceCandidateDto,
  RecurrenceCreatePreviewDto,
  RecurrenceResolutionDto,
  RecurrenceResolutionWarning,
} from '@workloom/contracts';
import { useId } from 'react';

/** Fixed explanations of the server's resolution warnings. */
export const recurrenceWarningCopy: Record<RecurrenceResolutionWarning, { label: string; description: string }> = {
  gap_first_valid: {
    get label() { return t('recurrence.daylightSavingGap'); },
    get description() { return t('recurrence.thisTimeIsSkippedDuringADaylightSavingChange'); },
  },
  ambiguous_earlier: {
    get label() { return t('recurrence.daylightSavingOverlap'); },
    get description() { return t('recurrence.thisTimeOccursTwiceDuringADaylightSavingChange'); },
  },
  skipped_local_date: {
    get label() { return t('recurrence.skippedDate'); },
    get description() { return t('recurrence.thisDateIsSkippedInTheSeriesTimeZone'); },
  },
};


/** Presentation only: the server's calendar date with its weekday; no recurrence is calculated here. */
export function formatRecurrenceDate(date: string): string {
  const [year, month, day] = date.split('-').map(Number);
  if (year === undefined || month === undefined || day === undefined) return date;
  const at = new Date(Date.UTC(year, month - 1, day));
  return Number.isNaN(at.getTime()) ? date : `${date}, ${formatDate(at, { weekday: 'short', timeZone: 'UTC' })}`;
}

export const formatMeetingCount = (count: number) => t('recurrence.meetingCount', { count });

/** A period's name, or neutral copy; a period ID is never shown. */
export function recurrencePeriodName(periodId: string | null, periods: readonly PlanningPeriodDto[]): string {
  if (periodId === null) return t('recurrence.noPeriodSelected');
  const key = periodId.toLowerCase();
  return periods.find((period) => period.id.toLowerCase() === key)?.name ?? t('recurrence.periodUnavailable');
}

/** Intended nominal wall time next to the server-resolved start; both come from the server. */
export function RecurrenceResolutionCells({ resolution }: { resolution: RecurrenceResolutionDto }) {
  const { t } = useTranslation();
  const moved =
    resolution.resolvedLocalDate !== resolution.intendedLocalDate || resolution.resolvedLocalTime !== resolution.intendedLocalTime;
  return (
    <>
      <td className="px-2 py-2 align-top">
        {formatRecurrenceDate(resolution.intendedLocalDate)} {resolution.intendedLocalTime}
      </td>
      <td className="px-2 py-2 align-top">
        <span className={moved ? 'font-medium text-amber-900' : undefined}>
          {formatRecurrenceDate(resolution.resolvedLocalDate)} {resolution.resolvedLocalTime}
        </span>
        <span className="block text-xs text-muted">{t('recurrence.utcMin', { resolvedOffset: resolution.resolvedOffset, timezone: resolution.provenance.timezone, plannedDurationMinutes: resolution.plannedDurationMinutes })}</span>
      </td>
    </>
  );
}

function CandidateNote({ candidate }: { candidate: RecurrenceCandidateDto }) {
  const { t } = useTranslation();
  const warning = candidate.resolution.warning;
  const collisions = candidate.collidesWithOccurrenceKeys;
  if (warning === null && collisions.length === 0) return <span className="text-muted">—</span>;
  return (
    <div className="space-y-1">
      {warning ? (
        <>
          <p className="text-xs font-medium text-amber-800">{recurrenceWarningCopy[warning].label}</p>
          <p className="text-xs text-muted">{recurrenceWarningCopy[warning].description}</p>
        </>
      ) : null}
      {collisions.length > 0 ? (
        <p className="text-xs text-amber-900">{t('recurrence.startsAtTheSameTimeAsRuleMeetingsOn2', { seriesDates: collisions.join(', ') })}</p>
      ) : null}
    </div>
  );
}

export interface RecurrenceCandidateTableProps {
  candidates: readonly RecurrenceCandidateDto[];
  periods: readonly PlanningPeriodDto[];
  caption: string;
}

/** Server candidates as given. Only the table scrolls sideways on narrow screens; cell content wraps. */
export function RecurrenceCandidateTable({ candidates, periods, caption }: RecurrenceCandidateTableProps) {
  const { t } = useTranslation();
  const captionId = useId();
  return (
    <div role="region" aria-labelledby={captionId} tabIndex={0} className="-mx-1 overflow-x-auto px-1">
      <table className="w-full min-w-[40rem] border-collapse text-left text-sm">
        <caption id={captionId} className="mb-2 text-left text-sm font-medium">{caption}</caption>
        <thead>
          <tr className="border-b border-line text-xs text-muted">
            <th scope="col" className="px-2 py-2 font-medium">{t('recurrence.ruleDate')}</th>
            <th scope="col" className="px-2 py-2 font-medium">{t('recurrence.ruleTime')}</th>
            <th scope="col" className="px-2 py-2 font-medium">{t('recurrence.meetingStart')}</th>
            <th scope="col" className="px-2 py-2 font-medium">{t('recurrence.period')}</th>
            <th scope="col" className="px-2 py-2 font-medium">{t('recurrence.note')}</th>
          </tr>
        </thead>
        <tbody>
          {candidates.map((candidate) => (
            <tr key={candidate.occurrenceKey} className="border-b border-line/70 [overflow-wrap:anywhere]">
              <th scope="row" className="px-2 py-2 text-left align-top font-medium">
                {formatRecurrenceDate(candidate.occurrenceKey)}
                {candidate.nominalSequence !== null ? (
                  <span className="block text-xs font-normal text-muted">№ {candidate.nominalSequence}</span>
                ) : null}
              </th>
              <RecurrenceResolutionCells resolution={candidate.resolution} />
              <td className={`px-2 py-2 align-top ${candidate.periodId === null ? 'text-muted' : ''}`}>
                {recurrencePeriodName(candidate.periodId, periods)}
              </td>
              <td className="px-2 py-2 align-top">
                <CandidateNote candidate={candidate} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export interface RecurrenceCreatePreviewProps {
  preview: RecurrenceCreatePreviewDto;
  periods: readonly PlanningPeriodDto[];
}

/** Read-only server preview of a new series: counts, period ownership, warnings and every candidate. */
export function RecurrenceCreatePreview({ preview, periods }: RecurrenceCreatePreviewProps) {
  const { t } = useTranslation();
  const headingId = useId();
  const { counts, provenance } = preview;
  const summary: (readonly [string, string])[] = [
    [t('recurrence.meetingsByRule'), String(counts.nominalCount)],
    [t('recurrence.noSelectedPeriod'), String(preview.unboundCandidateCount)],
  ];
  if (counts.consumedNominalCount > 0 || counts.remainingNominalCount !== counts.nominalCount) {
    summary.push([t('recurrence.seriesSlotsUsed'), String(counts.consumedNominalCount)]);
    summary.push([t('recurrence.seriesSlotsRemaining'), String(counts.remainingNominalCount)]);
  }
  if (counts.skippedCount > 0) summary.push([t('recurrence.skipped'), String(counts.skippedCount)]);
  if (counts.cancelledCount > 0) summary.push([t('recurrence.cancelled'), String(counts.cancelledCount)]);

  return (
    <section aria-labelledby={headingId} className="min-w-0 space-y-4">
      <h3 id={headingId} className="text-sm font-semibold">{t('recurrence.schedulePreview')}</h3>
      <p className="text-sm text-muted">
        {t('recurrence.creatingASeriesReservesTheseDatesInTheProject')}</p>

      <dl className="grid grid-cols-1 gap-x-4 gap-y-2 text-sm sm:grid-cols-2">
        {summary.map(([label, value]) => (
          <div key={label} className="flex min-w-0 justify-between gap-2 rounded-lg bg-canvas px-3 py-2">
            <dt className="min-w-0 text-muted">{label}</dt>
            <dd className="font-medium tabular-nums">{value}</dd>
          </div>
        ))}
      </dl>

      {preview.periods.length > 0 ? (
        <div className="min-w-0 space-y-1">
          <p className="text-sm font-medium">{t('recurrence.seriesPeriods')}</p>
          <ul className="space-y-1 text-sm">
            {preview.periods.map((ownership) => (
              <li key={ownership.periodId} className="[overflow-wrap:anywhere]">
                {recurrencePeriodName(ownership.periodId, periods)} · {formatMeetingCount(ownership.candidateCount)}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {preview.warnings.length > 0 ? (
        <ul className="space-y-1 rounded-lg border border-amber-200 bg-amber-50/80 px-3 py-2.5 text-sm text-amber-900">
          {[...new Set(preview.warnings)].map((warning) => (
            <li key={warning}>{recurrenceWarningCopy[warning].description}</li>
          ))}
        </ul>
      ) : null}

      <p className="text-xs text-muted [overflow-wrap:anywhere]">{t('recurrence.meetingTimesUseTheSeriesTimeZoneRuleTime', { timezone: provenance.timezone })}</p>

      {preview.candidates.length < counts.nominalCount ? (
        <p className="text-xs text-muted">{t('recurrence.showingOfRuleDates', { shownCount: preview.candidates.length, nominalCount: counts.nominalCount })}</p>
      ) : null}
      <RecurrenceCandidateTable
        candidates={preview.candidates}
        periods={periods}
        caption={t('recurrence.seriesDates', { meetings: formatMeetingCount(preview.candidates.length) })}
      />
    </section>
  );
}
