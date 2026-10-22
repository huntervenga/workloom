import type { LeaveAvailabilityDayDto, LeaveCalculationSource, LeaveChargePreviewDto } from '@workloom/contracts';
import { LEAVE_MICRODAYS_PER_DAY } from '@workloom/contracts';
import {assertLeaveAvailabilityBudget} from './budget.js';
import { dateRange, dateYear, invalidLeave, isEmployed, isNonworkingHoliday, leaveTypeForDateOptional, profileForMember, profileForMemberOptional, scheduledMinutes, sameLeaveId, type LeaveValidationContext } from './calendar.js';

export interface LeaveChargePreviewOptions {
  membershipId: string;
  typeId: string;
  startDate: string;
  endDate: string;
  excludeRequestId?: string;
  /** Admin-tolerant mode: allow charges outside employment (zero availability) */
  context?: LeaveValidationContext;
  behavior?: {consumesBalance:boolean;capacityUnavailable:boolean};
}

/**
 * Finds type flags for preview.
 *
 * For NEW requests: choose same-ID type nearest at start (latest <= start, else earliest > start).
 * Uses those flags for the entire interval.
 *
 * For existing APPROVED requests: use pinned consumesBalance/capacity flags from the stored request.
 */
function resolveTypeFlags(source: LeaveCalculationSource, typeId: string, startDate: string): { consumesBalance: boolean; capacityUnavailable: boolean; archived: boolean } | null {
  const startYear = dateYear(startDate);

  // Try to find type at start year
  const type = leaveTypeForDateOptional(source.settings, typeId, startDate);
  if (type) {
    return { consumesBalance: type.consumesBalance, capacityUnavailable: type.capacityUnavailable, archived: type.archived };
  }

  // Find latest policy <= startYear that has this type
  const policiesBefore = source.settings.policyVersions
    .filter(p => p.effectiveYear <= startYear)
    .sort((a, b) => b.effectiveYear - a.effectiveYear);

  for (const policy of policiesBefore) {
    const found = policy.types.find(t => sameLeaveId(t.id, typeId));
    if (found) {
      return { consumesBalance: found.consumesBalance, capacityUnavailable: found.capacityUnavailable, archived: found.archived };
    }
  }

  // Find earliest policy > startYear that has this type
  const policiesAfter = source.settings.policyVersions
    .filter(p => p.effectiveYear > startYear)
    .sort((a, b) => a.effectiveYear - b.effectiveYear);

  for (const policy of policiesAfter) {
    const found = policy.types.find(t => sameLeaveId(t.id, typeId));
    if (found) {
      return { consumesBalance: found.consumesBalance, capacityUnavailable: found.capacityUnavailable, archived: found.archived };
    }
  }

  // Type never defined anywhere
  return null;
}

/**
 * Previews leave charges for a date range.
 *
 * Admin behavior:
 * - Tolerance for charges outside employment/accounting (zero minutes)
 * - Tolerance for missing/archived types
 * - Type flags resolved at start date, held for entire interval
 *
 * Non-admin behavior:
 * - Must be within employment and accounting
 * - Type must exist and not be archived
 */
export function previewLeaveCharge(source: LeaveCalculationSource, input: LeaveChargePreviewOptions): LeaveChargePreviewDto {
  const profile = profileForMember(source, input.membershipId);
  const dates = dateRange(input.startDate, input.endDate);
  const canManage = input.context?.canManage ?? false;

  // Non-admin: strict employment/accounting check
  if (!canManage && (input.startDate < profile.accountingStart || dates.some((date) => !isEmployed(profile, date)))) {
    invalidLeave('Absence must fall within the recorded employment and accounting dates.');
  }

  // Resolve type flags at start date, held for entire interval
  const typeFlags = input.behavior ? {...input.behavior,archived:false} : resolveTypeFlags(source, input.typeId, input.startDate);

  // Type never defined anywhere: reject
  if (!typeFlags) {
    invalidLeave('The selected absence type is not configured in any policy.');
  }

  // Non-admin: archived types blocked
  if (typeFlags.archived && !canManage) {
    invalidLeave('Archived absence types cannot receive new requests.');
  }

  const chargedDays = dates.flatMap((date) => {
    const minutes = scheduledMinutes(source.settings, profile, date);
    // Skip non-working days and holidays
    if (minutes <= 0 || isNonworkingHoliday(source.settings, date)) return [];
    return [{ date, microdays: typeFlags.consumesBalance ? LEAVE_MICRODAYS_PER_DAY : 0, scheduledMinutes: minutes }];
  });

  return {
    chargedDays,
    totalMicrodays: chargedDays.reduce((sum, day) => sum + day.microdays, 0),
    unavailableMinutes: typeFlags.capacityUnavailable ? chargedDays.reduce((sum, day) => sum + day.scheduledMinutes, 0) : 0,
    overlappingRequestIds: source.requests.filter((request) => (input.excludeRequestId === undefined || !sameLeaveId(request.id, input.excludeRequestId)) && sameLeaveId(request.membershipId, input.membershipId) && (request.status === 'approved' || request.status === 'pending') && request.startDate <= input.endDate && request.endDate >= input.startDate).map((request) => request.id).sort(),
  };
}

/** Capacity is a union of holidays/absences; duplicate historic records can never debit a day twice. */
export function calculateAvailability(source: LeaveCalculationSource, input: { startDate: string; endDate: string; membershipIds: string[] }): LeaveAvailabilityDayDto[] {
  const dates = dateRange(input.startDate, input.endDate);
  assertLeaveAvailabilityBudget(source,input.startDate,input.endDate,input.membershipIds);
  const intervalsByMember=new Map<string,{start:string;end:string}[]>();
  for(const r of source.requests)if(r.status==='approved'&&r.capacityUnavailable){const key=r.membershipId.toLowerCase(),items=intervalsByMember.get(key)??[];items.push({start:r.startDate,end:r.endDate});intervalsByMember.set(key,items);}
  for(const [id,items]of intervalsByMember){const merged:{start:string;end:string}[]=[];for(const item of items.sort((a,b)=>a.start.localeCompare(b.start))){const last=merged.at(-1);if(last&&item.start<=last.end){if(item.end>last.end)last.end=item.end;}else merged.push({...item});}intervalsByMember.set(id,merged);}
  return [...new Set(input.membershipIds.map((id) => id.toLowerCase()))].sort().flatMap((membershipId) => {
    const profile = profileForMemberOptional(source, membershipId);
    // No profile = return zeros for all dates
    if (!profile) {
      return dates.map((date) => ({
        membershipId, date, scheduledMinutes: 0, holidayMinutes: 0, absenceMinutes: 0, availableMinutes: 0
      }));
    }
    const intervals=intervalsByMember.get(membershipId)??[];let intervalIndex=0;
    return dates.map((date) => {
      const minutes = scheduledMinutes(source.settings, profile, date);
      const holidayMinutes = minutes > 0 && isNonworkingHoliday(source.settings, date) ? minutes : 0;
      while((intervals[intervalIndex]?.end??'9999-12-31')<date)intervalIndex++;
      const absent=(intervals[intervalIndex]?.start??'9999-12-31')<=date;
      const absenceMinutes = holidayMinutes === 0 && absent ? minutes : 0;
      return { membershipId, date, scheduledMinutes: minutes, holidayMinutes, absenceMinutes, availableMinutes: minutes - holidayMinutes - absenceMinutes };
    });
  });
}
