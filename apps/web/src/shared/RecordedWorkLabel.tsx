import type { RecordedWorkLogDto } from '@workloom/contracts';
import { t, formatDate, useTranslation } from '../i18n';

/** Source precision is explicit; occurrence facts must never masquerade as period-wide input. */
export function recordedWorkLabel(log: RecordedWorkLogDto): string {
  if (log.sourceKind === 'manual_period') return t('common.periodWork');
  const instant = log.attribution.basis === 'planned_absence' ? log.attribution.plannedStartAt : log.attribution.actualStartAt;
  const date = formatDate(instant, { timeZone: 'UTC', dateStyle: 'short', timeStyle: 'short' });
  return t('common.attendanceStamp', {
    source: t(log.attribution.basis === 'planned_absence' ? 'common.plannedAbsence' : 'common.meetingAttendance'),
    date,
  });
}
export function RecordedWorkLabel({ log }: { log: RecordedWorkLogDto }) {
  useTranslation();
  return <span>{recordedWorkLabel(log)}</span>;
}
