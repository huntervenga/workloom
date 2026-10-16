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
  past: 'Встреча уже прошла',
  done: 'Встреча отмечена выполненной',
  posted_attendance: 'По встрече уже вносили присутствие',
  schedule_frozen: 'Расписание встречи зафиксировано в плане периода',
  cross_period: 'Новое время выходит за границы периода, к которому относится встреча',
};

/** Friendly reason labels in server order, each once. */
export function recurrenceProtectedReasonLabels(reasons: readonly RecurrenceProtectedReason[]): string[] {
  return [...new Set(reasons)].map((reason) => recurrenceProtectedReasonCopy[reason]);
}

const impactActionCopy: Record<RecurrenceEditImpactDto['action'], { label: string; tone: BadgeTone }> = {
  update: { label: 'Изменится', tone: 'accent' },
  create: { label: 'Добавится', tone: 'accent' },
  cancel: { label: 'Будет отменена', tone: 'warning' },
  retain: { label: 'Без изменений', tone: 'muted' },
};

const exceptionKindCopy: Record<RecurrenceExceptionKind, string> = {
  skip: 'Отменить только эту встречу',
  move: 'Перенести только эту встречу',
  restore: 'Восстановить встречу',
  reset: 'Вернуть встречу к правилу серии',
};

const calendarStateAfterCopy: Record<RecurrenceCalendarState, { label: string; tone: BadgeTone }> = {
  scheduled: { label: 'Будет запланирована', tone: 'neutral' },
  cancelled: { label: 'Будет отменена', tone: 'warning' },
};

/** Server-resolved planned start with its zone, plus the rule time when the start was shifted. */
function PlannedResolution({ resolution, emptyLabel, showDuration = true }: { resolution: RecurrenceResolutionDto | null; emptyLabel: string; showDuration?: boolean }) {
  if (resolution === null) return <span className="text-muted">{emptyLabel}</span>;
  const shifted =
    resolution.resolvedLocalDate !== resolution.intendedLocalDate || resolution.resolvedLocalTime !== resolution.intendedLocalTime;
  return (
    <div className="space-y-1">
      <time dateTime={resolution.resolvedStartAt} className={`block ${shifted ? 'font-medium text-amber-900' : ''}`}>
        {formatRecurrenceDate(resolution.resolvedLocalDate)}, <span className="tabular-nums">{resolution.resolvedLocalTime}</span>
      </time>
      <span className="block text-xs text-muted [overflow-wrap:anywhere]">
        UTC{resolution.resolvedOffset} · {resolution.provenance.timezone}{showDuration ? ` · ${resolution.plannedDurationMinutes} мин` : null}
      </span>
      {shifted ? (
        <span className="block text-xs text-muted">
          По правилу: {formatRecurrenceDate(resolution.intendedLocalDate)}, {resolution.intendedLocalTime}
        </span>
      ) : null}
      {resolution.warning !== null ? (
        <p className="text-xs text-amber-800">{recurrenceWarningCopy[resolution.warning].description}</p>
      ) : null}
    </div>
  );
}

function CountsSummary({ counts }: { counts: RecurrenceNominalCountsDto }) {
  const summary: (readonly [string, string])[] = [['Встреч по правилу', String(counts.nominalCount)]];
  if (counts.consumedNominalCount > 0 || counts.remainingNominalCount !== counts.nominalCount) {
    summary.push(['До даты изменения', String(counts.consumedNominalCount)]);
    summary.push(['С даты изменения', String(counts.remainingNominalCount)]);
  }
  if (counts.skippedCount > 0) summary.push(['Пропущено', String(counts.skippedCount)]);
  if (counts.cancelledCount > 0) summary.push(['Отменено', String(counts.cancelledCount)]);
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
  const headingId = useId();
  const captionId = useId();
  const blocked = preview.protectedTargets.length > 0;

  return (
    <section aria-labelledby={headingId} className="min-w-0 space-y-4">
      <h3 id={headingId} className="text-sm font-semibold">Проверка изменения серии</h3>
      <p className="text-sm text-muted">
        Изменение действует с даты серии {formatRecurrenceDate(preview.effectiveFromNominalDate)}. Показано только плановое время
        встреч; личные планы и присутствие этим изменением не подтверждаются.
      </p>

      <CountsSummary counts={preview.counts} />

      {blocked ? (
        <ProtectedNotice title="Изменение серии нельзя применить">
          <p>
            Среди затронутых встреч есть защищённые, поэтому изменение не будет применено целиком — ни к одной встрече. Выберите
            более позднюю дату начала изменения.
          </p>
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
          <p className="text-xs">Перечислены только встречи, которые вам доступны.</p>
        </ProtectedNotice>
      ) : null}

      {preview.impacts.length === 0 ? (
        <p className="rounded-lg border border-dashed border-line p-3 text-sm text-muted">Изменение не затрагивает встречи серии.</p>
      ) : (
        <div role="region" aria-labelledby={captionId} tabIndex={0} className="-mx-1 overflow-x-auto px-1">
          <table className="w-full min-w-[48rem] border-collapse text-left text-sm">
            <caption id={captionId} className="mb-2 text-left text-sm font-medium">
              Затронутые даты серии: {preview.impacts.length}
            </caption>
            <thead>
              <tr className="border-b border-line text-xs text-muted">
                <th scope="col" className="px-2 py-2 font-medium">Дата серии</th>
                <th scope="col" className="px-2 py-2 font-medium">Изменение</th>
                <th scope="col" className="px-2 py-2 font-medium">Было по плану</th>
                <th scope="col" className="px-2 py-2 font-medium">Станет по плану</th>
                <th scope="col" className="px-2 py-2 font-medium">Период</th>
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
                    <PlannedResolution resolution={impact.before} emptyLabel="Встречи не было" />
                  </td>
                  <td className="px-2 py-2 align-top">
                    <PlannedResolution resolution={impact.after} emptyLabel="Встречи не будет" />
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
  const headingId = useId();
  return (
    <section aria-labelledby={headingId} className="min-w-0 space-y-4">
      <h3 id={headingId} className="text-sm font-semibold">Проверка периодов серии</h3>
      <p className="text-sm text-muted">
        Добавление периодов только резервирует даты серии в них. Сами встречи появятся при подготовке периода, а личные планы и
        присутствие по-прежнему подтверждаются отдельно.
      </p>

      {preview.periods.length > 0 ? (
        <div className="min-w-0 space-y-1">
          <p className="text-sm font-medium">Выбранные периоды</p>
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
        <p className="rounded-lg border border-dashed border-line p-3 text-sm text-muted">В выбранных периодах нет дат серии.</p>
      ) : (
        <RecurrenceCandidateTable
          candidates={preview.candidates}
          periods={periods}
          caption={`Даты серии в выбранных периодах: ${formatMeetingCount(preview.candidates.length)}`}
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
  const headingId = useId();
  const stateAfter = calendarStateAfterCopy[preview.calendarStateAfter];
  const protectedLabels = recurrenceProtectedReasonLabels(preview.protectedReasons);

  return (
    <section aria-labelledby={headingId} className="min-w-0 space-y-4">
      <h3 id={headingId} className="text-sm font-semibold">Проверка изменения одной встречи</h3>

      <dl className="grid grid-cols-1 gap-x-4 gap-y-2 text-sm sm:grid-cols-2">
        <div className="min-w-0 rounded-lg bg-canvas px-3 py-2">
          <dt className="text-muted">Дата серии</dt>
          <dd className="font-medium">{formatRecurrenceDate(preview.occurrenceKey)}</dd>
          <dd className="text-xs text-muted">Остаётся прежней при любом изменении</dd>
        </div>
        <div className="min-w-0 rounded-lg bg-canvas px-3 py-2">
          <dt className="text-muted">Действие</dt>
          <dd className="font-medium">{exceptionKindCopy[preview.kind]}</dd>
          <dd className="mt-1">
            <Badge tone={stateAfter.tone}>{stateAfter.label}</Badge>
          </dd>
        </div>
        <div className="min-w-0 rounded-lg bg-canvas px-3 py-2">
          <dt className="text-muted">Сейчас в календаре</dt>
          <dd className="mt-1">
            <PlannedResolution resolution={preview.before} emptyLabel="Время не назначено" showDuration={false} />
          </dd>
        </div>
        <div className="min-w-0 rounded-lg bg-canvas px-3 py-2">
          <dt className="text-muted">После изменения в календаре</dt>
          <dd className="mt-1">
            <PlannedResolution
              resolution={preview.after}
              showDuration={false}
              emptyLabel={preview.calendarStateAfter === 'cancelled' ? 'Встреча не состоится' : 'Время не назначено'}
            />
          </dd>
        </div>
      </dl>

      <section aria-label="Плановое расписание и состав встречи" className="space-y-3">
        <h4 className="text-sm font-semibold">Плановое расписание и состав</h4>
        {preview.kind === 'reset' || preview.kind === 'restore' ? <p className="text-xs leading-relaxed text-muted">Расписание и состав берутся из действующего правила серии для этой даты. Название, статус, материалы и внесённый факт сохраняются.</p> : null}
        <div className="grid min-w-0 gap-3 sm:grid-cols-2">
          <PlannedCalendarReview title="Сейчас" calendar={preview.beforePlannedCalendar} other={preview.afterPlannedCalendar} members={members} after={false} />
          <PlannedCalendarReview title="После изменения" calendar={preview.afterPlannedCalendar} other={preview.beforePlannedCalendar} members={members} after />
        </div>
      </section>

      {protectedLabels.length > 0 ? (
        <ProtectedNotice title="Изменение встречи нельзя применить">
          <ul className="ml-4 list-disc">
            {protectedLabels.map((label) => (
              <li key={label}>{label}</li>
            ))}
          </ul>
          <p className="text-xs">Пока действует хотя бы одна из этих причин, изменение будет отклонено целиком.</p>
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
  const headingId = useId();
  const name = (id: string) => members.find(member => member.id.toLowerCase() === id.toLowerCase())?.displayName ?? 'Сохранённый недоступный участник';
  const otherIds = new Set(other.attendeeMembershipIds.map(id => id.toLowerCase()));
  return <section aria-labelledby={headingId} className="min-w-0 space-y-3 rounded-lg border border-line bg-canvas p-3">
    <h5 id={headingId} className="text-sm font-semibold">{title}</h5>
    <dl className="space-y-2 text-sm">
      <div><dt className="text-xs text-muted">Часовой пояс</dt><dd className="[overflow-wrap:anywhere]">{calendar.timezone}</dd></div>
      <div><dt className="text-xs text-muted">Плановая длительность</dt><dd>{calendar.plannedDurationMinutes} мин</dd></div>
      <div><dt className="text-xs text-muted">Организатор</dt><dd className="[overflow-wrap:anywhere]">{name(calendar.organizerMembershipId)}</dd></div>
    </dl>
    <div className="space-y-1.5"><p className="text-xs text-muted">Участники встречи</p>
      <ul className="space-y-1.5 text-sm">{calendar.attendeeMembershipIds.map((id, index) => <li key={id} className="flex flex-wrap items-center gap-1.5 [overflow-wrap:anywhere]">
        <span>{name(id)}{!members.some(member => member.id.toLowerCase() === id.toLowerCase()) ? ` ${index + 1}` : ''}</span>
        {!otherIds.has(id.toLowerCase()) ? <Badge tone={after ? 'accent' : 'warning'}>{after ? 'Добавится' : 'Не войдёт в новый состав'}</Badge> : null}
      </li>)}</ul>
    </div>
  </section>;
}
