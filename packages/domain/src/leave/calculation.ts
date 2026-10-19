import type { LeaveAvailabilityDayDto, LeaveCalculationSource, LeaveChargePreviewDto } from '@workloom/contracts';
import { LEAVE_MICRODAYS_PER_DAY } from '@workloom/contracts';
import { dateRange, invalidLeave, isEmployed, isNonworkingHoliday, leaveTypeForDate, profileForMember, scheduledMinutes, sameLeaveId } from './calendar.js';

export function previewLeaveCharge(source: LeaveCalculationSource, input: { membershipId: string; typeId: string; startDate: string; endDate: string; excludeRequestId?: string }): LeaveChargePreviewDto {
  const profile = profileForMember(source, input.membershipId);
  const dates = dateRange(input.startDate, input.endDate);
  if (input.startDate < profile.accountingStart || dates.some((date) => !isEmployed(profile, date))) invalidLeave('Absence must fall within the recorded employment and accounting dates.');
  const chargedDays = dates.flatMap((date) => {
    const type = leaveTypeForDate(source.settings, input.typeId, date);
    if (type.archived) invalidLeave('Archived absence types cannot receive new requests.');
    const minutes = scheduledMinutes(source.settings, profile, date);
    return minutes > 0 && !isNonworkingHoliday(source.settings, date) ? [{ date, microdays: type.consumesBalance ? LEAVE_MICRODAYS_PER_DAY : 0, scheduledMinutes: minutes }] : [];
  });
  return {
    chargedDays, totalMicrodays: chargedDays.reduce((sum, day) => sum + day.microdays, 0),
    unavailableMinutes: chargedDays.reduce((sum, day) => sum + (leaveTypeForDate(source.settings, input.typeId, day.date).capacityUnavailable ? day.scheduledMinutes : 0), 0),
    overlappingRequestIds: source.requests.filter((request) => (input.excludeRequestId === undefined || !sameLeaveId(request.id, input.excludeRequestId)) && sameLeaveId(request.membershipId, input.membershipId) && (request.status === 'approved' || request.status === 'pending') && request.startDate <= input.endDate && request.endDate >= input.startDate).map((request) => request.id).sort(),
  };
}

/** Capacity is a union of holidays/absences; duplicate historic records can never debit a day twice. */
export function calculateAvailability(source: LeaveCalculationSource, input: { startDate: string; endDate: string; membershipIds: string[] }): LeaveAvailabilityDayDto[] {
  const dates = dateRange(input.startDate, input.endDate);
  return [...new Set(input.membershipIds.map((id) => id.toLowerCase()))].sort().flatMap((membershipId) => {
    const profile = profileForMember(source, membershipId);
    return dates.map((date) => {
      const minutes = scheduledMinutes(source.settings, profile, date);
      const holidayMinutes = minutes > 0 && isNonworkingHoliday(source.settings, date) ? minutes : 0;
      const absent = source.requests.some((request) => sameLeaveId(request.membershipId, membershipId) && request.status === 'approved' && request.capacityUnavailable && request.startDate <= date && request.endDate >= date);
      const absenceMinutes = holidayMinutes === 0 && absent ? minutes : 0;
      return { membershipId, date, scheduledMinutes: minutes, holidayMinutes, absenceMinutes, availableMinutes: minutes - holidayMinutes - absenceMinutes };
    });
  });
}
