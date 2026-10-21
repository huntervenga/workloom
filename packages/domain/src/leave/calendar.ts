import type { LeaveCalculationSource, LeaveHolidayDto, LeavePolicyVersionDto, LeaveProfileDto, LeaveSettingsDto, LeaveTypeDto } from '@workloom/contracts';
import { leaveSettingsSchema, leaveProfileSchema, leaveStoredRequestSchema, leaveAdjustmentSchema } from '@workloom/contracts';
import { Temporal } from 'temporal-polyfill';
import { DomainError } from '../errors.js';

export function sameLeaveId(a: string, b: string): boolean { return a.toLowerCase() === b.toLowerCase(); }
export const DAY_MS = 86_400_000;
export function invalidLeave(message: string): never { throw new DomainError('VALIDATION_FAILED', message); }
export function dateOrdinal(date: string): number {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return invalidLeave('A valid date-only value is required.');
  const ms = Date.parse(`${date}T00:00:00.000Z`);
  if (!Number.isFinite(ms) || new Date(ms).toISOString().slice(0, 10) !== date || date < '1900-01-01' || date > '2200-12-31') return invalidLeave('Leave dates must be valid dates from 1900 through 2200.');
  return ms / DAY_MS;
}
export function ordinalDate(ordinal: number): string { return new Date(ordinal * DAY_MS).toISOString().slice(0, 10); }
export function dateYear(date: string): number { dateOrdinal(date); return Number(date.slice(0, 4)); }
export function dateRange(startDate: string, endDate: string, maximumDays = 3660): string[] {
  const start = dateOrdinal(startDate); const end = dateOrdinal(endDate);
  if (end < start || end - start + 1 > maximumDays) return invalidLeave(`Leave date range must contain 1 through ${maximumDays} days.`);
  return Array.from({ length: end - start + 1 }, (_, i) => ordinalDate(start + i));
}
export function policyVersionForYear(settings: LeaveSettingsDto, year: number): LeavePolicyVersionDto {
  const policy = settings.policyVersions.filter((item) => item.effectiveYear <= year).sort((a, b) => b.effectiveYear - a.effectiveYear)[0];
  return policy ?? invalidLeave('No leave policy covers this accounting year.');
}
export function leaveTypeForDate(settings: LeaveSettingsDto, typeId: string, date: string): LeaveTypeDto {
  const type = policyVersionForYear(settings, dateYear(date)).types.find((item) => sameLeaveId(item.id, typeId));
  return type ?? invalidLeave('The selected absence type is not configured for this year.');
}
export function profileForMember(source: LeaveCalculationSource, membershipId: string): LeaveProfileDto {
  return source.profiles.find((profile) => sameLeaveId(profile.membershipId, membershipId)) ?? invalidLeave('An employment profile is required.');
}
export function isEmployed(profile: LeaveProfileDto, date: string): boolean { return date >= profile.employmentStart && (profile.employmentEnd === null || date <= profile.employmentEnd); }
export function scheduledMinutes(settings: LeaveSettingsDto, profile: LeaveProfileDto, date: string): number {
  if (!isEmployed(profile, date)) return 0;
  const periods = profile.schedulePeriods.filter((item) => item.effectiveFrom <= date).sort((a, b) => b.effectiveFrom.localeCompare(a.effectiveFrom));
  const weekly = periods[0]?.weeklyMinutes ?? settings.defaultWeeklyMinutes;
  const weekday = (new Date(dateOrdinal(date) * DAY_MS).getUTCDay() + 6) % 7;
  return weekly[weekday] ?? 0;
}
export function isHoliday(holidays: LeaveHolidayDto[], date: string): boolean {
  return holidays.some(({ rule }) => rule.kind === 'date' ? rule.date === date : Number(date.slice(5, 7)) === rule.month && Number(date.slice(8, 10)) === rule.day);
}
export function isNonworkingHoliday(settings: LeaveSettingsDto, date: string): boolean { return isHoliday(policyVersionForYear(settings, dateYear(date)).holidays, date); }
export function isAccrualPaused(source: LeaveCalculationSource, membershipId: string, date: string): boolean {
  return source.requests.some((request) => sameLeaveId(request.membershipId, membershipId) && request.status === 'approved' && request.pausesAccrual && request.startDate <= date && request.endDate >= date);
}
function unique(values: (string | number)[], message: string): void { if (new Set(values.map((value) => typeof value === 'string' ? value.toLowerCase() : value)).size !== values.length) invalidLeave(message); }
export function assertLeaveSource(source: LeaveCalculationSource): void {
  if (!leaveSettingsSchema.safeParse(source.settings).success || source.profiles.some((profile) => !leaveProfileSchema.safeParse(profile).success) || source.requests.some((request) => !leaveStoredRequestSchema.safeParse(request).success) || source.adjustments.some((adjustment) => !leaveAdjustmentSchema.safeParse(adjustment).success)) invalidLeave('Invalid leave source shape.');
  if (source.profiles.length > 1000 || source.requests.length > 5000 || source.adjustments.length > 5000) invalidLeave('Leave calculation source exceeds its bounded size.');
  const settings = source.settings;
  unique(settings.policyVersions.map((policy) => policy.effectiveYear), 'Leave policy effective years must be unique.');
  if (settings.policyVersions.length === 0) invalidLeave('At least one leave policy is required.');
  const knownTypeIds = new Set<string>();
  for (const policy of [...settings.policyVersions].sort((a, b) => a.effectiveYear - b.effectiveYear)) {
    for (const knownId of knownTypeIds) if (!policy.types.some((type) => sameLeaveId(type.id, knownId))) invalidLeave('Previously configured absence types must be retained; archive them instead of removing them from later policies.');
    for (const type of policy.types) knownTypeIds.add(type.id);
    unique(policy.types.map((type) => type.id), 'Absence type IDs must be unique within a policy.');
    unique(policy.holidays.map((holiday) => holiday.id), 'Holiday IDs must be unique within a policy.');
    for (const holiday of policy.holidays) {
      if (holiday.rule.kind === 'date') dateOrdinal(holiday.rule.date);
      else dateOrdinal(`2000-${String(holiday.rule.month).padStart(2, '0')}-${String(holiday.rule.day).padStart(2, '0')}`);
    }
  }
  for (const timezone of [settings.timezone, ...source.profiles.map((profile) => profile.timezone)]) {
    if (/^[+-]/.test(timezone)) invalidLeave('A valid IANA timezone is required.');
    try { Temporal.Instant.fromEpochMilliseconds(0).toZonedDateTimeISO(timezone); } catch { invalidLeave('A valid IANA timezone is required.'); }
  }
  unique(source.profiles.map((profile) => profile.membershipId), 'Employment profiles must be unique per person.');
  for (const profile of source.profiles) {
    if (!sameLeaveId(profile.workspaceId, settings.workspaceId)) invalidLeave('Employment profile belongs to another workspace.');
    dateOrdinal(profile.employmentStart); dateOrdinal(profile.accountingStart);
    if (profile.accountingStart < profile.employmentStart) invalidLeave('Accounting cannot begin before employment.');
    policyVersionForYear(settings, dateYear(profile.accountingStart));
    if (profile.employmentEnd !== null && (dateOrdinal(profile.employmentEnd), profile.employmentEnd < profile.employmentStart)) invalidLeave('Employment end must not precede its start.');
    unique(profile.openingBalances.map((opening) => opening.typeId), 'Opening balance type IDs must be unique.');
    unique(profile.schedulePeriods.map((period) => period.effectiveFrom), 'Schedule effective dates must be unique.');
    for (const period of profile.schedulePeriods) dateOrdinal(period.effectiveFrom);
    for (const opening of profile.openingBalances) leaveTypeForDate(settings, opening.typeId, profile.accountingStart);
  }
  unique(source.requests.map((request) => request.id), 'Absence request IDs must be unique.');
  for (const request of source.requests) {
    if (!sameLeaveId(request.workspaceId, settings.workspaceId)) invalidLeave('Absence request belongs to another workspace.');
    const profile = profileForMember(source, request.membershipId);
    dateRange(request.startDate, request.endDate);
    for (let year = dateYear(request.startDate); year <= dateYear(request.endDate); year += 1) leaveTypeForDate(settings, request.typeId, `${year}-12-31`);
    // Inactive immutable history must not prevent a later employment/accounting correction.
    if ((request.status === 'pending' || request.status === 'approved') && (request.startDate < profile.accountingStart || !isEmployed(profile, request.startDate) || !isEmployed(profile, request.endDate))) invalidLeave('Absence must fall within the recorded employment and accounting dates.');
    unique(request.chargedDays.map((charge) => charge.date), 'An absence cannot charge a date twice.');
    for (const charge of request.chargedDays) {
      dateOrdinal(charge.date);
      if (charge.date < request.startDate || charge.date > request.endDate || charge.microdays !== (request.consumesBalance ? 1_000_000 : 0)) invalidLeave('Approved charge allocation must match its request and full-day balance rule.');
    }
  }
  unique(source.adjustments.map((adjustment) => adjustment.id), 'Balance adjustment IDs must be unique.');
  for (const adjustment of source.adjustments) {
    const profile = profileForMember(source, adjustment.membershipId);
    dateOrdinal(adjustment.effectiveDate);
    if (adjustment.effectiveDate < profile.accountingStart) invalidLeave('Adjustment predates accounting start.');
    leaveTypeForDate(settings, adjustment.typeId, adjustment.effectiveDate);
  }
}
