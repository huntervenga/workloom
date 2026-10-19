import type { LeaveRequestDto, LeaveTypeDto } from '@workloom/contracts';
import { t } from '../../i18n';

type LeaveTypeFlag = keyof Pick<LeaveTypeDto, 'consumesBalance' | 'pausesAccrual' | 'capacityUnavailable' | 'requiresApproval' | 'allowNegative' | 'archived'>;
/** Finite, literal catalog calls keep each label auditable; no user value forms a locale key. */
export function weekdayLabel(day: number): string {
  const labels = [t('timeOff.weekday.0'), t('timeOff.weekday.1'), t('timeOff.weekday.2'), t('timeOff.weekday.3'), t('timeOff.weekday.4'), t('timeOff.weekday.5'), t('timeOff.weekday.6')] as const;
  return labels[day] ?? t('timeOff.day');
}
export function leaveStatusLabel(status: LeaveRequestDto['status']): string {
  const labels = { pending: t('timeOff.status.pending'), approved: t('timeOff.status.approved'), rejected: t('timeOff.status.rejected'), cancelled: t('timeOff.status.cancelled') } satisfies Record<LeaveRequestDto['status'], string>;
  return labels[status];
}
export function leaveTypeFlagLabel(flag: LeaveTypeFlag): string {
  const labels = { consumesBalance: t('timeOff.consumesBalance'), pausesAccrual: t('timeOff.pausesAccrual'), capacityUnavailable: t('timeOff.capacityUnavailable'), requiresApproval: t('timeOff.requiresApproval'), allowNegative: t('timeOff.allowNegative'), archived: t('timeOff.archived') } satisfies Record<LeaveTypeFlag, string>;
  return labels[flag];
}
