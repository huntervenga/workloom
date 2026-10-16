import { t, useTranslation, formatDate } from '../../i18n';
import type { RecurrenceExceptionKind, RecurrenceInstanceDto, RecurrenceResolutionWarning } from '@workloom/contracts';
import { Badge, Button } from '@workloom/ui';

export interface RecurrenceInstancesTableProps {
  instances: readonly RecurrenceInstanceDto[];
  /** Opens the prepared meeting task in the period the occurrence was originally assigned to. */
  onOpenMeeting: (taskId: string, periodId: string) => void;
  /** Opens the parent-owned single-occurrence exception draft; offered only when writable, for every row. */
  onSelectException?: ((instance: RecurrenceInstanceDto) => void) | undefined;
  writable?: boolean | undefined;
}

const warningCopy: Record<RecurrenceResolutionWarning, string> = {
  get gap_first_valid() { return t('recurrence.thisTimeFallsInADaylightSavingGapThe'); },
  get ambiguous_earlier() { return t('recurrence.thisTimeOccursTwiceDuringADaylightSavingChange'); },
  get skipped_local_date() { return t('recurrence.thisDateDoesNotExistInTheSeriesTime'); },
};

const exceptionCopy: Record<RecurrenceExceptionKind, string> = {
  get skip() { return t('recurrence.onlyThisMeetingCancelled'); },
  get move() { return t('recurrence.onlyThisMeetingMoved'); },
  get restore() { return t('recurrence.meetingRestored'); },
  get reset() { return t('recurrence.resetToSeriesRule'); },
};



/** Formats a calendar date as-is; the UTC zone only keeps the day from shifting. */
function calendarDate(value: string): string {
  return formatDate(new Date(`${value}T00:00:00Z`), { weekday: 'short', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
}

function isReserved(instance: RecurrenceInstanceDto): boolean {
  return instance.taskId === null && instance.meetingId === null && instance.workPackageId === null;
}

export function RecurrenceInstancesTable({ instances, onOpenMeeting, onSelectException, writable = false }: RecurrenceInstancesTableProps) {
  const { t } = useTranslation();
  if (instances.length === 0) {
    return (
      <p className="rounded-xl border border-dashed border-line p-4 text-sm text-muted">
        {t('recurrence.noSeriesMeetingsInThisPeriod')}</p>
    );
  }

  const canEditOne = writable && onSelectException !== undefined;

  return (
    <div className="space-y-2">
      <p className="text-xs leading-relaxed text-muted">
        {t('recurrence.theSeriesDateIsTheOriginalDateFromThe')}</p>
      <div className="relative max-w-full overflow-x-auto rounded-xl border border-line bg-surface">
        <table className="w-full min-w-[880px] text-left text-sm">
          <caption className="px-4 py-3 text-left text-sm font-semibold">{t('recurrence.seriesMeetingsInPeriod')}</caption>
          <thead className="border-y border-line bg-canvas text-xs text-muted">
            <tr>
              <th scope="col" className="px-4 py-3">{t('recurrence.seriesDate')}</th>
              <th scope="col" className="px-3 py-3">{t('recurrence.byRule2')}</th>
              <th scope="col" className="px-3 py-3">{t('recurrence.start')}</th>
              <th scope="col" className="px-3 py-3">{t('recurrence.state')}</th>
              <th scope="col" className="px-3 py-3">{t('recurrence.preparation')}</th>
              <th scope="col" className="px-3 py-3">
                <span className="sr-only">{t('recurrence.actions')}</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {instances.map((instance) => (
              <InstanceRow
                key={instance.id}
                instance={instance}
                onOpenMeeting={onOpenMeeting}
                onSelectException={canEditOne ? onSelectException : undefined}
              />
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function InstanceRow({
  instance,
  onOpenMeeting,
  onSelectException,
}: {
  instance: RecurrenceInstanceDto;
  onOpenMeeting: (taskId: string, periodId: string) => void;
  onSelectException: ((instance: RecurrenceInstanceDto) => void) | undefined;
}) {
  const { t } = useTranslation();
  const { resolution, exception, occurrenceKey } = instance;
  const cancelled = instance.calendarState === 'cancelled';
  const reserved = isReserved(instance);
  const shifted =
    resolution.resolvedLocalDate !== resolution.intendedLocalDate || resolution.resolvedLocalTime !== resolution.intendedLocalTime;
  const taskId = instance.taskId;

  return (
    <tr className="border-b border-line align-top last:border-b-0">
      <th scope="row" className="px-4 py-3 text-left font-medium">
        <span className="block whitespace-nowrap">{calendarDate(occurrenceKey)}</span>
        <span className="mt-1 block text-xs font-normal text-muted">
          {occurrenceKey}
          {instance.nominalSequence !== null ? t('recurrence.meetingInSeries', { nominalSequence: instance.nominalSequence }) : null}
        </span>
      </th>
      <td className="px-3 py-3">
        <span className="block whitespace-nowrap">{calendarDate(resolution.intendedLocalDate)}</span>
        <span className="mt-1 block text-xs text-muted tabular-nums">{resolution.intendedLocalTime}</span>
      </td>
      <td className="max-w-xs px-3 py-3">
        <span className="block whitespace-nowrap">
          {calendarDate(resolution.resolvedLocalDate)}, <span className="tabular-nums">{resolution.resolvedLocalTime}</span>
        </span>
        <span className="mt-1 block text-xs text-muted [overflow-wrap:anywhere]">{t('recurrence.utcMin', { resolvedOffset: resolution.resolvedOffset, timezone: resolution.provenance.timezone, plannedDurationMinutes: resolution.plannedDurationMinutes })}</span>
        {resolution.warning !== null ? (
          <p className="mt-1.5 text-xs leading-relaxed text-amber-800">{warningCopy[resolution.warning]}</p>
        ) : shifted ? (
          <p className="mt-1.5 text-xs leading-relaxed text-muted">{t('recurrence.startDiffersFromTheRuleTime')}</p>
        ) : null}
      </td>
      <td className="max-w-xs px-3 py-3">
        <Badge tone={cancelled ? 'warning' : 'neutral'}>{cancelled ? t('recurrence.cancelled') : t('recurrence.scheduled')}</Badge>
        {exception !== null ? (
          <span className="mt-1.5 block text-xs text-muted">
            {exceptionCopy[exception.kind]}
            {exception.kind === 'move' ? t('recurrence.seriesDateStaysUnchanged', { occurrenceKey: occurrenceKey }) : null}
            <span className="mt-0.5 block [overflow-wrap:anywhere]">{t('recurrence.reason2', { reason: exception.reason })}</span>
          </span>
        ) : null}
      </td>
      <td className="px-3 py-3">
        {reserved ? (
          <span className="text-sm text-muted">{cancelled ? t('recurrence.cancelledBeforePreparation') : t('recurrence.notPreparedYet')}</span>
        ) : (
          <span className="text-sm">{t('recurrence.prepared')}</span>
        )}
      </td>
      <td className="px-3 py-3">
        <div className="flex flex-wrap justify-end gap-2">
          {taskId !== null ? (
            <Button size="sm" onClick={() => onOpenMeeting(taskId, instance.plannedPeriodId)}>{t('recurrence.openMeeting2', { occurrenceKey: occurrenceKey })}</Button>
          ) : null}
          {/* Offered for reserved headers too: an exception addresses the stable header, never a task. */}
          {onSelectException ? (
            <Button size="sm" variant="ghost" onClick={() => onSelectException(instance)}>{t('recurrence.changeMeeting2', { occurrenceKey: occurrenceKey })}</Button>
          ) : null}
        </div>
      </td>
    </tr>
  );
}
