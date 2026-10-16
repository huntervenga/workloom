import { useTranslation } from '../../i18n';
import type { PlanningPeriodDto } from '@workloom/contracts';
import { TextInput } from '@workloom/ui';
import { useId } from 'react';

/** Page-owned draft of a series schedule; strings stay raw until the parent validates them. */
export interface RecurrenceRuleDraft {
  frequency: 'daily' | 'weekly';
  /** ISO weekdays, Monday 1 … Sunday 7; kept while daily is selected. */
  weekdays: number[];
  /** Calendar date YYYY-MM-DD in the series timezone. */
  startDate: string;
  /** Wall-clock HH:mm in the series timezone. */
  localTime: string;
  timezone: string;
  durationMinutes: string;
  endKind: 'on_date' | 'after_count';
  endDate: string;
  count: string;
  /** Only explicitly checked periods; nothing is preselected. */
  targetPeriodIds: string[];
}

export interface RecurrenceRuleFieldsProps {
  value: RecurrenceRuleDraft;
  onChange: (next: RecurrenceRuleDraft) => void;
  periods: readonly PlanningPeriodDto[];
  disabled?: boolean | undefined;
  showPeriods?: boolean | undefined;
  editMode?: boolean | undefined;
  immutableCadence?: boolean | undefined;
}

const weekdayNames: readonly (readonly [number, `recurrence.${string}`])[] = [
  [1, 'recurrence.monday'],
  [2, 'recurrence.tuesday'],
  [3, 'recurrence.wednesday'],
  [4, 'recurrence.thursday'],
  [5, 'recurrence.friday'],
  [6, 'recurrence.saturday'],
  [7, 'recurrence.sunday'],
];

const labelClass = 'text-sm font-medium';
const hintClass = 'text-xs text-muted';

function toggled(list: readonly string[], id: string, checked: boolean): string[] {
  return checked ? (list.includes(id) ? [...list] : [...list, id]) : list.filter((item) => item !== id);
}

export function RecurrenceRuleFields({ value, onChange, periods, disabled = false, showPeriods = true, editMode = false, immutableCadence = false }: RecurrenceRuleFieldsProps) {
  const { t } = useTranslation();
  const id = useId();
  const set = <K extends keyof RecurrenceRuleDraft>(key: K, next: RecurrenceRuleDraft[K]) => onChange({ ...value, [key]: next });
  const toggleWeekday = (day: number, checked: boolean) =>
    set('weekdays', checked ? [...new Set([...value.weekdays, day])].sort((a, b) => a - b) : value.weekdays.filter((d) => d !== day));
  const knownPeriodIds = new Set(periods.map((p) => p.id));
  const missingPeriodIds = value.targetPeriodIds.filter((periodId) => !knownPeriodIds.has(periodId));

  return (
    <fieldset disabled={disabled} className="min-w-0 space-y-4">
      <fieldset disabled={immutableCadence} className="min-w-0 space-y-2">
        <legend className={`mb-2 ${labelClass}`}>{t('recurrence.repeat')}</legend>
        <div className="flex flex-wrap gap-x-4 gap-y-2">
          <label className="flex items-center gap-2 text-sm">
            <input type="radio" name={`${id}-frequency`} checked={value.frequency === 'daily'} onChange={() => set('frequency', 'daily')} />
            {t('recurrence.everyDay')}</label>
          <label className="flex items-center gap-2 text-sm">
            <input type="radio" name={`${id}-frequency`} checked={value.frequency === 'weekly'} onChange={() => set('frequency', 'weekly')} />
            {t('recurrence.onWeekdays')}</label>
        </div>
      </fieldset>

      {value.frequency === 'weekly' ? (
        <fieldset disabled={immutableCadence} className="min-w-0 space-y-2">
          <legend className={`mb-2 ${labelClass}`}>{t('recurrence.daysOfTheWeek')}</legend>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            {weekdayNames.map(([day, name]) => (
              <label key={day} className="flex min-w-0 items-center gap-2 text-sm">
                <input type="checkbox" checked={value.weekdays.includes(day)} onChange={(e) => toggleWeekday(day, e.target.checked)} />
                {t(name)}
              </label>
            ))}
          </div>
          {value.weekdays.length === 0 ? <p className={hintClass}>{t('recurrence.chooseAtLeastOneWeekday')}</p> : null}
        </fieldset>
      ) : null}

      <div className="grid min-w-0 gap-4 sm:grid-cols-2">
        <div className="min-w-0 space-y-1.5">
          <label htmlFor={`${id}-start`} className={labelClass}>{t('recurrence.seriesStartDate')}</label>
          <TextInput id={`${id}-start`} type="date" disabled={editMode} value={value.startDate} onChange={(e) => set('startDate', e.target.value)} />
        </div>
        <div className="min-w-0 space-y-1.5">
          <label htmlFor={`${id}-time`} className={labelClass}>{t('recurrence.seriesTime')}</label>
          <TextInput id={`${id}-time`} type="time" step={60} value={value.localTime} onChange={(e) => set('localTime', e.target.value)} />
        </div>
        <div className="min-w-0 space-y-1.5">
          <label htmlFor={`${id}-zone`} className={labelClass}>{t('recurrence.seriesTimeZone')}</label>
          <TextInput
            id={`${id}-zone`}
            value={value.timezone}
            placeholder={t('recurrence.timeZoneExample')}
            aria-describedby={`${id}-zone-hint`}
            onChange={(e) => set('timezone', e.target.value)}
          />
          <p id={`${id}-zone-hint`} className={hintClass}>{t('recurrence.ianaTimeZoneNameYourBrowsersTimeZoneIs')}</p>
        </div>
        <div className="min-w-0 space-y-1.5">
          <label htmlFor={`${id}-duration`} className={labelClass}>{t('recurrence.durationMinutes')}</label>
          <TextInput
            id={`${id}-duration`}
            type="number"
            min={1}
            max={1440}
            step={1}
            value={value.durationMinutes}
            aria-describedby={`${id}-duration-hint`}
            onChange={(e) => set('durationMinutes', e.target.value)}
          />
          <p id={`${id}-duration-hint`} className={hintClass}>
            {t('recurrence.elapsedDurationOf11440MinutesIncludingDuring')}</p>
        </div>
      </div>

      <p className={hintClass}>
        {t('recurrence.duringADaylightSavingGapAMeetingStartsAt')}</p>

      <fieldset className="min-w-0 space-y-3">
        <legend className={`mb-2 ${labelClass}`}>{t('recurrence.seriesEnds')}</legend>
        <div className="flex flex-wrap gap-x-4 gap-y-2">
          <label className="flex items-center gap-2 text-sm">
            <input type="radio" disabled={editMode} name={`${id}-end`} checked={value.endKind === 'on_date'} onChange={() => set('endKind', 'on_date')} />
            {t('recurrence.onADate')}</label>
          <label className="flex items-center gap-2 text-sm">
            <input type="radio" disabled={editMode} name={`${id}-end`} checked={value.endKind === 'after_count'} onChange={() => set('endKind', 'after_count')} />
            {t('recurrence.afterANumberOfMeetings')}</label>
        </div>
        {value.endKind === 'on_date' ? (
          <div className="min-w-0 space-y-1.5">
            <label htmlFor={`${id}-end-date`} className={labelClass}>{t('recurrence.lastSeriesDateInclusive')}</label>
            <TextInput id={`${id}-end-date`} type="date" value={value.endDate} onChange={(e) => set('endDate', e.target.value)} />
          </div>
        ) : (
          <div className="min-w-0 space-y-1.5">
            <label htmlFor={`${id}-count`} className={labelClass}>{t('recurrence.numberOfMeetingsInSeries')}</label>
            <TextInput
              id={`${id}-count`}
              disabled={immutableCadence}
              type="number"
              min={1}
              max={366}
              step={1}
              value={value.count}
              aria-describedby={`${id}-count-hint`}
              onChange={(e) => set('count', e.target.value)}
            />
            <p id={`${id}-count-hint`} className={hintClass}>
              {t('recurrence.totalMeetingsFromTheSeriesStartNotTheNumber')}</p>
          </div>
        )}
      </fieldset>

      {showPeriods ? <fieldset className="min-w-0 space-y-2">
        <legend className={`mb-2 ${labelClass}`}>{t('recurrence.seriesPeriods')}</legend>
        <p className={hintClass}>
          {t('recurrence.meetingsArePreparedOnlyInSelectedPeriodsOtherDates')}</p>
        {periods.length === 0 && missingPeriodIds.length === 0 ? (
          <p className="text-sm text-muted">{t('recurrence.noAvailablePeriodsInThisProjectSeriesMeetingsCannot')}</p>
        ) : null}
        {periods.map((period) => (
          <label key={period.id} className="flex min-w-0 items-start gap-2 text-sm">
            <input
              type="checkbox"
              className="mt-0.5"
              checked={value.targetPeriodIds.includes(period.id)}
              onChange={(e) => set('targetPeriodIds', toggled(value.targetPeriodIds, period.id, e.target.checked))}
            />
            <span className="min-w-0 [overflow-wrap:anywhere]">
              {period.name}
              <span className="block text-xs text-muted">{t('recurrence.fromToEndExcluded', { localStart: period.localStart, localEndExclusive: period.localEndExclusive, timezone: period.timezone })}</span>
            </span>
          </label>
        ))}
        {missingPeriodIds.map((periodId) => (
          <label key={periodId} className="flex min-w-0 items-start gap-2 text-sm">
            <input
              type="checkbox"
              className="mt-0.5"
              checked
              onChange={(e) => set('targetPeriodIds', toggled(value.targetPeriodIds, periodId, e.target.checked))}
            />
            <span className="min-w-0 [overflow-wrap:anywhere]">{t('recurrence.savedPeriodMissingFromCurrentList')}</span>
          </label>
        ))}
        {periods.length > 0 && value.targetPeriodIds.length === 0 ? <p className={hintClass}>{t('recurrence.noPeriodSelected2')}</p> : null}
      </fieldset> : null}
    </fieldset>
  );
}
