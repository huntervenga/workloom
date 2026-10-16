import { t, useTranslation } from '../../i18n';
import type {
  PlanningPeriodDto,
  MembershipDto,
  RecurrencePlannedCalendarDto,
  RecurrenceCalendarState,
  RecurrenceEditImpactDto,
  RecurrenceEditPreviewDto,
  RecurrenceExceptionKind,
  RecurrenceExceptionPreviewDto,
  RecurrenceNominalCountsDto,
  RecurrencePeriodPreviewDto,
  RecurrenceProtectedReason,
  RecurrenceResolutionDto,
} from '@workloom/contracts';
import { Badge, type BadgeTone } from '@workloom/ui';
import { useId, type ReactNode } from 'react';
import {
  RecurrenceCandidateTable,
  formatMeetingCount,
  formatRecurrenceDate,
  recurrencePeriodName,
  recurrenceWarningCopy,
} from './RecurrencePreview';

/** Fixed explanations of why the server protects an occurrence from a change. */
export const recurrenceProtectedReasonCopy: Record<RecurrenceProtectedReason, string> = {
  get past() { return t('recurrence.meetingHasAlreadyTakenPlace'); },
  get done() { return t('recurrence.meetingIsMarkedComplete'); },
  get posted_attendance() { return t('recurrence.attendanceHasAlreadyBeenRecorded'); },
  get schedule_frozen() { return t('recurrence.meetingScheduleIsLockedInThePeriodBaseline'); },
  get cross_period() { return t('recurrence.newTimeIsOutsideTheMeetingsOriginalPeriod'); },
};

/** Friendly reason labels in server order, each once. */
export function recurrenceProtectedReasonLabels(reasons: readonly RecurrenceProtectedReason[]): string[] {
  return [...new Set(reasons)].map((reason) => recurrenceProtectedReasonCopy[reason]);
}

const impactActionCopy: Record<RecurrenceEditImpactDto['action'], { label: string; tone: BadgeTone }> = {
  update: { get label() { return t('recurrence.willChange'); }, tone: 'accent' },
  create: { get label() { return t('recurrence.willAdd'); }, tone: 'accent' },
  cancel: { get label() { return t('recurrence.willCancel'); }, tone: 'warning' },
  retain: { get label() { return t('recurrence.unchanged'); }, tone: 'muted' },
};

const exceptionKindCopy: Record<RecurrenceExceptionKind, string> = {
  get skip() { return t('recurrence.cancelOnlyThisMeeting'); },
  get move() { return t('recurrence.moveOnlyThisMeeting'); },
  get restore() { return t('recurrence.restoreMeeting'); },
  get reset() { return t('recurrence.resetMeetingToSeriesRule'); },
};

const calendarStateAfterCopy: Record<RecurrenceCalendarState, { label: string; tone: BadgeTone }> = {
  scheduled: { get label() { return t('recurrence.willSchedule'); }, tone: 'neutral' },
  cancelled: { get label() { return t('recurrence.willCancel'); }, tone: 'warning' },
};

/** Server-resolved planned start with its zone, plus the rule time when the start was shifted. */
function PlannedResolution({ resolution, emptyLabel, showDuration = true }: { resolution: RecurrenceResolutionDto | null; emptyLabel: string; showDuration?: boolean }) {
  const { t } = useTranslation();
  if (resolution === null) return <span className="text-muted">{emptyLabel}</span>;
  const shifted =
    resolution.resolvedLocalDate !== resolution.intendedLocalDate || resolution.resolvedLocalTime !== resolution.intendedLocalTime;
  return (
    <div className="space-y-1">
      <time dateTime={resolution.resolvedStartAt} className={`block ${shifted ? 'font-medium text-amber-900' : ''}`}>
        {formatRecurrenceDate(resolution.resolvedLocalDate)}, <span className="tabular-nums">{resolution.resolvedLocalTime}</span>
      </time>
      <span className="block text-xs text-muted [overflow-wrap:anywhere]">
        {showDuration ? t('recurrence.utcOffsetZoneDuration', { offset: resolution.resolvedOffset, timezone: resolution.provenance.timezone, minutes: resolution.plannedDurationMinutes }) : t('recurrence.utcOffsetZone', { offset: resolution.resolvedOffset, timezone: resolution.provenance.timezone })}
      </span>
      {shifted ? (
        <span className="block text-xs text-muted">{t('recurrence.byRule3', { ruleDate: formatRecurrenceDate(resolution.intendedLocalDate), intendedLocalTime: resolution.intendedLocalTime })}</span>
      ) : null}
      {resolution.warning !== null ? (
        <p className="text-xs text-amber-800">{recurrenceWarningCopy[resolution.warning].description}</p>
      ) : null}
    </div>
  );
}

function CountsSummary({ counts }: { counts: RecurrenceNominalCountsDto }) {
  const { t } = useTranslation();
  const summary: (readonly [string, string])[] = [[t('recurrence.meetingsByRule'), String(counts.nominalCount)]];
  if (counts.consumedNominalCount > 0 || counts.remainingNominalCount !== counts.nominalCount) {
    summary.push([t('recurrence.beforeChangeDate'), String(counts.consumedNominalCount)]);
    summary.push([t('recurrence.fromChangeDate'), String(counts.remainingNominalCount)]);
  }
  if (counts.skippedCount > 0) summary.push([t('recurrence.skipped'), String(counts.skippedCount)]);
  if (counts.cancelledCount > 0) summary.push([t('recurrence.cancelled'), String(counts.cancelledCount)]);
  return (
    <dl className="grid grid-cols-1 gap-x-4 gap-y-2 text-sm sm:grid-cols-2">
      {summary.map(([label, value]) => (
        <div key={label} className="flex min-w-0 justify-between gap-2 rounded-lg bg-canvas px-3 py-2">
          <dt className="min-w-0 text-muted">{label}</dt>
          <dd className="font-medium tabular-nums">{value}</dd>
        </div>
      ))}
    </dl>
  );
}

/** Blocking explanation; the server rejects the whole change while any reason remains. */
function ProtectedNotice({ title, children }: { title: string; children: ReactNode }) {
  const titleId = useId();
  return (
    <section aria-labelledby={titleId} className="space-y-2 rounded-lg border border-amber-200 bg-amber-50/80 px-3 py-2.5 text-sm text-amber-900">
      <h4 id={titleId} className="font-semibold">{title}</h4>
      {children}
    </section>
  );
}

export interface RecurrenceEditPreviewProps {
  preview: RecurrenceEditPreviewDto;
  periods: readonly PlanningPeriodDto[];
}

/** Read-only server preview of a series edit: counts, every affected date and protected occurrences. */
export function RecurrenceEditPreview({ preview, periods }: RecurrenceEditPreviewProps) {
  const { t } = useTranslation();
  const headingId = useId();
  const captionId = useId();
  const blocked = preview.protectedTargets.length > 0;

  return (
    <section aria-labelledby={headingId} className="min-w-0 space-y-4">
      <h3 id={headingId} className="text-sm font-semibold">{t('recurrence.reviewSeriesChange')}</h3>
      <p className="text-sm text-muted">{t('recurrence.changeStartsOnSeriesDateOnlyPlannedMeetingTimes', { seriesDate: formatRecurrenceDate(preview.effectiveFromNominalDate) })}</p>

      <CountsSummary counts={preview.counts} />

      {blocked ? (
        <ProtectedNotice title={t('recurrence.seriesChangeCannotBeApplied')}>
          <p>
            {t('recurrence.someAffectedMeetingsAreProtectedSoNoMeetingsWill')}</p>
          <ul className="space-y-1.5">
            {preview.protectedTargets.map((target) => (
              <li key={target.occurrenceKey} className="[overflow-wrap:anywhere]">
                <span className="font-medium">{formatRecurrenceDate(target.occurrenceKey)}</span>
                <ul className="ml-4 list-disc text-xs">
                  {recurrenceProtectedReasonLabels(target.reasons).map((label) => (
                    <li key={label}>{label}</li>
                  ))}
                </ul>
              </li>
            ))}
          </ul>
          <p className="text-xs">{t('recurrence.onlyMeetingsYouCanAccessAreListed')}</p>
        </ProtectedNotice>
      ) : null}

      {preview.impacts.length === 0 ? (
        <p className="rounded-lg border border-dashed border-line p-3 text-sm text-muted">{t('recurrence.thisChangeDoesNotAffectAnySeriesMeetings')}</p>
      ) : (
        <div role="region" aria-labelledby={captionId} tabIndex={0} className="-mx-1 overflow-x-auto px-1">
          <table className="w-full min-w-[48rem] border-collapse text-left text-sm">
            <caption id={captionId} className="mb-2 text-left text-sm font-medium">{t('recurrence.affectedSeriesDates2', { length: preview.impacts.length })}</caption>
            <thead>
              <tr className="border-b border-line text-xs text-muted">
                <th scope="col" className="px-2 py-2 font-medium">{t('recurrence.seriesDate')}</th>
                <th scope="col" className="px-2 py-2 font-medium">{t('recurrence.change')}</th>
                <th scope="col" className="px-2 py-2 font-medium">{t('recurrence.currentPlan')}</th>
                <th scope="col" className="px-2 py-2 font-medium">{t('recurrence.newPlan')}</th>
                <th scope="col" className="px-2 py-2 font-medium">{t('recurrence.period')}</th>
              </tr>
            </thead>
            <tbody>
              {preview.impacts.map((impact) => (
                <tr key={impact.occurrenceKey} className="border-b border-line/70 [overflow-wrap:anywhere]">
                  <th scope="row" className="px-2 py-2 text-left align-top font-medium">
                    {formatRecurrenceDate(impact.occurrenceKey)}
                  </th>
                  <td className="px-2 py-2 align-top">
                    <Badge tone={impactActionCopy[impact.action].tone}>{impactActionCopy[impact.action].label}</Badge>
                  </td>
                  <td className="px-2 py-2 align-top">
                    <PlannedResolution resolution={impact.before} emptyLabel={t('recurrence.noExistingMeeting')} />
                  </td>
                  <td className="px-2 py-2 align-top">
                    <PlannedResolution resolution={impact.after} emptyLabel={t('recurrence.noMeetingAfterwards')} />
                  </td>
                  <td className={`px-2 py-2 align-top ${impact.periodId === null ? 'text-muted' : ''}`}>
                    {recurrencePeriodName(impact.periodId, periods)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

export interface RecurrencePeriodsPreviewProps {
  preview: RecurrencePeriodPreviewDto;
  periods: readonly PlanningPeriodDto[];
}

/** Read-only server preview of newly bound periods: per-period counts and the candidates they would own. */
export function RecurrencePeriodsPreview({ preview, periods }: RecurrencePeriodsPreviewProps) {
  const { t } = useTranslation();
  const headingId = useId();
  return (
    <section aria-labelledby={headingId} className="min-w-0 space-y-4">
      <h3 id={headingId} className="text-sm font-semibold">{t('recurrence.reviewSeriesPeriods')}</h3>
      <p className="text-sm text-muted">
        {t('recurrence.addingPeriodsReservesSeriesDatesOnlyMeetingsAreCreated')}</p>

      {preview.periods.length > 0 ? (
        <div className="min-w-0 space-y-1">
          <p className="text-sm font-medium">{t('recurrence.selectedPeriods')}</p>
          <ul className="space-y-1 text-sm">
            {preview.periods.map((ownership) => (
              <li key={ownership.periodId} className="[overflow-wrap:anywhere]">
                {recurrencePeriodName(ownership.periodId, periods)} · {formatMeetingCount(ownership.candidateCount)}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {preview.candidates.length === 0 ? (
        <p className="rounded-lg border border-dashed border-line p-3 text-sm text-muted">{t('recurrence.noSeriesDatesFallWithinTheSelectedPeriods')}</p>
      ) : (
        <RecurrenceCandidateTable
          candidates={preview.candidates}
          periods={periods}
          caption={t('recurrence.seriesDatesInSelectedPeriods', { meetings: formatMeetingCount(preview.candidates.length) })}
        />
      )}
    </section>
  );
}

export interface RecurrenceExceptionPreviewProps {
  preview: RecurrenceExceptionPreviewDto;
  members: readonly MembershipDto[];
}

/** Read-only server preview of a single-occurrence change; the series date never changes. */
export function RecurrenceExceptionPreview({ preview, members }: RecurrenceExceptionPreviewProps) {
  const { t } = useTranslation();
  const headingId = useId();
  const stateAfter = calendarStateAfterCopy[preview.calendarStateAfter];
  const protectedLabels = recurrenceProtectedReasonLabels(preview.protectedReasons);

  return (
    <section aria-labelledby={headingId} className="min-w-0 space-y-4">
      <h3 id={headingId} className="text-sm font-semibold">{t('recurrence.reviewOneMeetingChange')}</h3>

      <dl className="grid grid-cols-1 gap-x-4 gap-y-2 text-sm sm:grid-cols-2">
        <div className="min-w-0 rounded-lg bg-canvas px-3 py-2">
          <dt className="text-muted">{t('recurrence.seriesDate')}</dt>
          <dd className="font-medium">{formatRecurrenceDate(preview.occurrenceKey)}</dd>
          <dd className="text-xs text-muted">{t('recurrence.staysTheSameThroughAnyChange')}</dd>
        </div>
        <div className="min-w-0 rounded-lg bg-canvas px-3 py-2">
          <dt className="text-muted">{t('recurrence.action')}</dt>
          <dd className="font-medium">{exceptionKindCopy[preview.kind]}</dd>
          <dd className="mt-1">
            <Badge tone={stateAfter.tone}>{stateAfter.label}</Badge>
          </dd>
        </div>
        <div className="min-w-0 rounded-lg bg-canvas px-3 py-2">
          <dt className="text-muted">{t('recurrence.currentlyScheduled')}</dt>
          <dd className="mt-1">
            <PlannedResolution resolution={preview.before} emptyLabel={t('recurrence.noTimeAssigned')} showDuration={false} />
          </dd>
        </div>
        <div className="min-w-0 rounded-lg bg-canvas px-3 py-2">
          <dt className="text-muted">{t('recurrence.scheduledAfterChange')}</dt>
          <dd className="mt-1">
            <PlannedResolution
              resolution={preview.after}
              showDuration={false}
              emptyLabel={preview.calendarStateAfter === 'cancelled' ? t('recurrence.meetingWillNotTakePlace') : t('recurrence.noTimeAssigned')}
            />
          </dd>
        </div>
      </dl>

      <section aria-label={t('recurrence.plannedScheduleAndPeople')} className="space-y-3">
        <h4 className="text-sm font-semibold">{t('recurrence.plannedScheduleAndRoster')}</h4>
        {preview.kind === 'reset' || preview.kind === 'restore' ? <p className="text-xs leading-relaxed text-muted">{t('recurrence.scheduleAndPeopleUseTheCurrentSeriesRuleFor')}</p> : null}
        <div className="grid min-w-0 gap-3 sm:grid-cols-2">
          <PlannedCalendarReview title={t('recurrence.current')} calendar={preview.beforePlannedCalendar} other={preview.afterPlannedCalendar} members={members} after={false} />
          <PlannedCalendarReview title={t('recurrence.afterChange')} calendar={preview.afterPlannedCalendar} other={preview.beforePlannedCalendar} members={members} after />
        </div>
      </section>

      {protectedLabels.length > 0 ? (
        <ProtectedNotice title={t('recurrence.meetingChangeCannotBeApplied')}>
          <ul className="ml-4 list-disc">
            {protectedLabels.map((label) => (
              <li key={label}>{label}</li>
            ))}
          </ul>
          <p className="text-xs">{t('recurrence.theWholeChangeWillBeRejectedWhileAnyOf')}</p>
        </ProtectedNotice>
      ) : null}
    </section>
  );
}

/** Uses membership identity for comparison, retaining unavailable people without exposing their IDs. */
function PlannedCalendarReview({ title, calendar, other, members, after }: {
  title: string;
  calendar: RecurrencePlannedCalendarDto;
  other: RecurrencePlannedCalendarDto;
  members: readonly MembershipDto[];
  after: boolean;
}) {
  const { t } = useTranslation();
  const headingId = useId();
  const name = (id: string) => members.find(member => member.id.toLowerCase() === id.toLowerCase())?.displayName ?? t('recurrence.savedPersonUnavailable');
  const otherIds = new Set(other.attendeeMembershipIds.map(id => id.toLowerCase()));
  return <section aria-labelledby={headingId} className="min-w-0 space-y-3 rounded-lg border border-line bg-canvas p-3">
    <h5 id={headingId} className="text-sm font-semibold">{title}</h5>
    <dl className="space-y-2 text-sm">
      <div><dt className="text-xs text-muted">{t('recurrence.timeZone')}</dt><dd className="[overflow-wrap:anywhere]">{calendar.timezone}</dd></div>
      <div><dt className="text-xs text-muted">{t('recurrence.plannedDuration')}</dt><dd>{t('recurrence.min3', { plannedDurationMinutes: calendar.plannedDurationMinutes })}</dd></div>
      <div><dt className="text-xs text-muted">{t('recurrence.organizer')}</dt><dd className="[overflow-wrap:anywhere]">{name(calendar.organizerMembershipId)}</dd></div>
    </dl>
    <div className="space-y-1.5"><p className="text-xs text-muted">{t('recurrence.meetingParticipants')}</p>
      <ul className="space-y-1.5 text-sm">{calendar.attendeeMembershipIds.map((id, index) => <li key={id} className="flex flex-wrap items-center gap-1.5 [overflow-wrap:anywhere]">
        <span>{name(id)}{!members.some(member => member.id.toLowerCase() === id.toLowerCase()) ? ` ${index + 1}` : ''}</span>
        {!otherIds.has(id.toLowerCase()) ? <Badge tone={after ? 'accent' : 'warning'}>{after ? t('recurrence.willAdd') : t('recurrence.excludedFromNewRoster')}</Badge> : null}
      </li>)}</ul>
    </div>
  </section>;
}
