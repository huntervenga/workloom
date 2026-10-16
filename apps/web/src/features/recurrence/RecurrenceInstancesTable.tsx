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
  gap_first_valid:
    'Этого времени нет из-за перевода часов: встреча начнётся в первое существующее время после пропущенного интервала.',
  ambiguous_earlier: 'Это время повторяется из-за перевода часов: выбрано более раннее из двух.',
  skipped_local_date:
    'Этой даты нет в часовом поясе серии: встреча начнётся в первое существующее время после пропущенного дня.',
};

const exceptionCopy: Record<RecurrenceExceptionKind, string> = {
  skip: 'Только эта встреча отменена',
  move: 'Только эта встреча перенесена',
  restore: 'Встреча восстановлена',
  reset: 'Возвращена к правилу серии',
};

const dateFormat = new Intl.DateTimeFormat('ru-RU', {
  weekday: 'short',
  day: 'numeric',
  month: 'long',
  year: 'numeric',
  timeZone: 'UTC',
});

/** Formats a calendar date as-is; the UTC zone only keeps the day from shifting. */
function calendarDate(value: string): string {
  return dateFormat.format(new Date(`${value}T00:00:00Z`));
}

function isReserved(instance: RecurrenceInstanceDto): boolean {
  return instance.taskId === null && instance.meetingId === null && instance.workPackageId === null;
}

export function RecurrenceInstancesTable({ instances, onOpenMeeting, onSelectException, writable = false }: RecurrenceInstancesTableProps) {
  if (instances.length === 0) {
    return (
      <p className="rounded-xl border border-dashed border-line p-4 text-sm text-muted">
        В этом периоде нет встреч серии.
      </p>
    );
  }

  const canEditOne = writable && onSelectException !== undefined;

  return (
    <div className="space-y-2">
      <p className="text-xs leading-relaxed text-muted">
        Дата серии — исходная дата встречи по правилу. Она остаётся постоянной, даже если встречу перенесли или время сдвинулось
        из-за перевода часов. Время по правилу и запланированное начало показаны отдельно.
      </p>
      <div className="relative max-w-full overflow-x-auto rounded-xl border border-line bg-surface">
        <table className="w-full min-w-[880px] text-left text-sm">
          <caption className="px-4 py-3 text-left text-sm font-semibold">Встречи серии в периоде</caption>
          <thead className="border-y border-line bg-canvas text-xs text-muted">
            <tr>
              <th scope="col" className="px-4 py-3">Дата серии</th>
              <th scope="col" className="px-3 py-3">По правилу</th>
              <th scope="col" className="px-3 py-3">Начало</th>
              <th scope="col" className="px-3 py-3">Состояние</th>
              <th scope="col" className="px-3 py-3">Подготовка</th>
              <th scope="col" className="px-3 py-3">
                <span className="sr-only">Действия</span>
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
          {instance.nominalSequence !== null ? ` · встреча ${instance.nominalSequence} серии` : null}
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
        <span className="mt-1 block text-xs text-muted [overflow-wrap:anywhere]">
          UTC{resolution.resolvedOffset} · {resolution.provenance.timezone} · {resolution.plannedDurationMinutes} мин
        </span>
        {resolution.warning !== null ? (
          <p className="mt-1.5 text-xs leading-relaxed text-amber-800">{warningCopy[resolution.warning]}</p>
        ) : shifted ? (
          <p className="mt-1.5 text-xs leading-relaxed text-muted">Время начала отличается от времени по правилу.</p>
        ) : null}
      </td>
      <td className="max-w-xs px-3 py-3">
        <Badge tone={cancelled ? 'warning' : 'neutral'}>{cancelled ? 'Отменена' : 'Запланирована'}</Badge>
        {exception !== null ? (
          <span className="mt-1.5 block text-xs text-muted">
            {exceptionCopy[exception.kind]}
            {exception.kind === 'move' ? ` · дата серии ${occurrenceKey} не меняется` : null}
            <span className="mt-0.5 block [overflow-wrap:anywhere]">Причина: {exception.reason}</span>
          </span>
        ) : null}
      </td>
      <td className="px-3 py-3">
        {reserved ? (
          <span className="text-sm text-muted">{cancelled ? 'Отменена до подготовки' : 'Ещё не подготовлена'}</span>
        ) : (
          <span className="text-sm">Подготовлена</span>
        )}
      </td>
      <td className="px-3 py-3">
        <div className="flex flex-wrap justify-end gap-2">
          {taskId !== null ? (
            <Button size="sm" onClick={() => onOpenMeeting(taskId, instance.plannedPeriodId)}>
              Открыть встречу {occurrenceKey}
            </Button>
          ) : null}
          {/* Offered for reserved headers too: an exception addresses the stable header, never a task. */}
          {onSelectException ? (
            <Button size="sm" variant="ghost" onClick={() => onSelectException(instance)}>
              Изменить встречу {occurrenceKey}
            </Button>
          ) : null}
        </div>
      </td>
    </tr>
  );
}
