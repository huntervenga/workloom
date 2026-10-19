import type { LeaveBalanceDto, LeaveCalculationSource, LeaveProjectionDeficitDto, LeaveRequestDto, LeaveTypeDto } from '@workloom/contracts';
import { dateOrdinal, dateYear, invalidLeave, isEmployed, ordinalDate, policyVersionForYear, profileForMember, sameLeaveId } from './calendar.js';

interface Lot { amount: number; expires: string | null }
interface Simulation { opening: number; earned: number; adjusted: number; taken: number; expired: number; available: number; deficits: LeaveProjectionDeficitDto[] }
function typeForYear(source: LeaveCalculationSource, typeId: string, year: number): LeaveTypeDto | undefined { return policyVersionForYear(source.settings, year).types.find((type) => sameLeaveId(type.id, typeId)); }
function expiryAfterMonths(year: number, months: number): string { return `${year + Math.floor(months / 12)}-${String(months % 12 + 1).padStart(2, '0')}-01`; }
function prorata(entitlement: number, days: number, yearDays: number): number { return Number(BigInt(entitlement) * BigInt(days) / BigInt(yearDays)); }

/** Replays pinned charge dates and current approved pause intervals; never mutates either source. */
function simulate(source: LeaveCalculationSource, input: { membershipId: string; typeId: string; through: string; deficitFrom: string }): Simulation {
  const profile = profileForMember(source, input.membershipId);
  const through = dateOrdinal(input.through); const start = dateOrdinal(profile.accountingStart);
  const result: Simulation = { opening: 0, earned: 0, adjusted: 0, taken: 0, expired: 0, available: 0, deficits: [] };
  if (through < start) return result;
  let debt = 0; let lots: Lot[] = [];
  const credit = (amount: number): void => {
    if (amount < 0) { spend(-amount); return; }
    const repayment = Math.min(amount, debt); debt -= repayment;
    if (amount > repayment) {
      const existing = lots.find((lot) => lot.expires === null);
      if (existing === undefined) lots.push({ amount: amount - repayment, expires: null });
      else existing.amount += amount - repayment;
    }
  };
  const spend = (amount: number): void => {
    lots.sort((a, b) => (a.expires ?? '9999').localeCompare(b.expires ?? '9999'));
    for (const lot of lots) { const taken = Math.min(amount, lot.amount); lot.amount -= taken; amount -= taken; if (amount === 0) break; }
    debt += amount;
  };
  const balance = (): number => lots.reduce((sum, lot) => sum + lot.amount, 0) - debt;
  const pausedIntervals: { start: number; end: number }[] = [];
  for (const request of source.requests.filter((request) => sameLeaveId(request.membershipId, input.membershipId) && request.status === 'approved' && request.pausesAccrual).sort((a, b) => a.startDate.localeCompare(b.startDate))) {
    const next = { start: dateOrdinal(request.startDate), end: dateOrdinal(request.endDate) };
    const last = pausedIntervals.at(-1);
    if (last !== undefined && next.start <= last.end + 1) last.end = Math.max(last.end, next.end);
    else pausedIntervals.push(next);
  }
  let pauseIndex = 0;
  const typesByYear = new Map<number, LeaveTypeDto | undefined>();
  const resolveType = (year: number): LeaveTypeDto | undefined => {
    if (!typesByYear.has(year)) typesByYear.set(year, typeForYear(source, input.typeId, year));
    return typesByYear.get(year);
  };
  const requests = source.requests.filter((request) => request.status === 'approved' && sameLeaveId(request.membershipId, input.membershipId) && sameLeaveId(request.typeId, input.typeId) && request.consumesBalance).sort((a, b) => a.id.localeCompare(b.id));
  const chargeByDate = new Map<string, { amount: number; request: LeaveRequestDto }>();
  for (const request of requests) for (const charge of request.chargedDays) {
    // Approved overlaps are rejected on writes. Defensive union avoids duplicate historic debit.
    if (!chargeByDate.has(charge.date)) chargeByDate.set(charge.date, { amount: charge.microdays, request });
  }
  const adjustments = new Map<string, number>();
  for (const adjustment of source.adjustments) if (sameLeaveId(adjustment.membershipId, input.membershipId) && sameLeaveId(adjustment.typeId, input.typeId)) adjustments.set(adjustment.effectiveDate, (adjustments.get(adjustment.effectiveDate) ?? 0) + adjustment.deltaMicrodays);
  result.opening = profile.openingBalances.find((opening) => sameLeaveId(opening.typeId, input.typeId))?.microdays ?? 0;
  credit(result.opening);
  let eligibleDays = 0; let previousAccrued = 0; let upfrontCredited = false;
  let previousYear = dateYear(profile.accountingStart);
  let yearStart = dateOrdinal(`${previousYear}-01-01`);
  let yearEnd = dateOrdinal(`${previousYear}-12-31`);
  for (let ordinal = start; ordinal <= through; ordinal += 1) {
    const date = ordinalDate(ordinal); const year = Number(date.slice(0, 4));
    // Expire before applying the carry cap so expired lots never displace still-valid lots.
    for (const lot of lots) if (lot.expires !== null && lot.expires <= date) { result.expired += lot.amount; lot.amount = 0; }
    if (year !== previousYear) {
      // Closing year's rule controls what it carries into the new year. New policy does not retroactively change it.
      const carry = resolveType(previousYear)?.carryover;
      const available = lots.reduce((sum, lot) => sum + lot.amount, 0);
      const permitted = carry?.mode === 'unlimited' ? available : carry?.mode === 'capped' ? Math.min(available, carry.capMicrodays ?? 0) : 0;
      let remaining = permitted;
      // Preserve the longest-lived balance under a cap; spend still consumes the soonest expiry first.
      lots.sort((a, b) => (b.expires ?? '9999').localeCompare(a.expires ?? '9999'));
      for (const lot of lots) {
        const retained = Math.min(remaining, lot.amount); result.expired += lot.amount - retained; lot.amount = retained; remaining -= retained;
        if (carry?.expiresAfterMonths !== null && carry?.expiresAfterMonths !== undefined) {
          const expires = expiryAfterMonths(year, carry.expiresAfterMonths);
          if (lot.expires === null || lot.expires > expires) lot.expires = expires;
        }
      }
      previousYear = year; eligibleDays = 0; previousAccrued = 0; upfrontCredited = false;
      yearStart = dateOrdinal(`${year}-01-01`); yearEnd = dateOrdinal(`${year}-12-31`);
    }
    for (const lot of lots) if (lot.expires !== null && lot.expires <= date) { result.expired += lot.amount; lot.amount = 0; }
    const type = resolveType(year);
    while ((pausedIntervals[pauseIndex]?.end ?? Infinity) < ordinal) pauseIndex += 1;
    const pause = pausedIntervals[pauseIndex];
    const eligible = isEmployed(profile, date) && !(pause !== undefined && pause.start <= ordinal && pause.end >= ordinal);
    if (type !== undefined && type.consumesBalance && eligible) {
      let accrued = 0;
      if (type.accrualMethod === 'daily') {
        eligibleDays += 1;
        const cumulative = prorata(type.annualEntitlementMicrodays, eligibleDays, yearEnd - yearStart + 1);
        accrued = cumulative - previousAccrued; previousAccrued = cumulative;
      } else if (!upfrontCredited) {
        const eligibleStart = Math.max(start, yearStart, dateOrdinal(profile.employmentStart));
        const eligibleEnd = Math.min(yearEnd, profile.employmentEnd === null ? yearEnd : dateOrdinal(profile.employmentEnd));
        let annualEligible = Math.max(0, eligibleEnd - eligibleStart + 1);
        for (const pause of pausedIntervals) annualEligible -= Math.max(0, Math.min(pause.end, eligibleEnd) - Math.max(pause.start, eligibleStart) + 1);
        accrued = prorata(type.annualEntitlementMicrodays, annualEligible, yearEnd - yearStart + 1); upfrontCredited = true;
      }
      credit(accrued); result.earned += accrued;
    }
    const adjustment = adjustments.get(date) ?? 0; credit(adjustment); result.adjusted += adjustment;
    const charge = chargeByDate.get(date);
    if (charge !== undefined) {
      spend(charge.amount); result.taken += charge.amount;
      if (date >= input.deficitFrom && balance() < 0) {
        const permittedNegative = type?.allowNegative === true && (type.maxNegativeMicrodays === null || -balance() <= type.maxNegativeMicrodays);
        result.deficits.push({ membershipId: input.membershipId, typeId: input.typeId, requestId: charge.request.id, date, availableMicrodays: balance(), negativeAllowed: permittedNegative, negativeApprovalRequired: !charge.request.negativeApproved });
      }
    }
    lots = lots.filter((lot) => lot.amount > 0);
  }
  result.available = balance(); return result;
}

function futureHorizon(source: LeaveCalculationSource, membershipId: string, typeId: string, asOf: string): string {
  return source.requests.filter((request) => request.status === 'approved' && sameLeaveId(request.membershipId, membershipId) && sameLeaveId(request.typeId, typeId) && request.consumesBalance).flatMap((request) => request.chargedDays.map((charge) => charge.date)).reduce((last, date) => date > last ? date : last, asOf);
}
export function calculateLeaveBalance(source: LeaveCalculationSource, input: { membershipId: string; typeId: string; asOf: string }): LeaveBalanceDto {
  dateOrdinal(input.asOf);
  if (!source.settings.policyVersions.some((policy) => policy.types.some((type) => sameLeaveId(type.id, input.typeId)))) invalidLeave('Unknown absence balance type.');
  const now = simulate(source, { ...input, through: input.asOf, deficitFrom: input.asOf });
  const horizon = futureHorizon(source, input.membershipId, input.typeId, input.asOf);
  const future = horizon === input.asOf ? now : simulate(source, { ...input, through: horizon, deficitFrom: input.asOf });
  const futureDates = new Map<string, number>();
  for (const request of source.requests) if (request.status === 'approved' && sameLeaveId(request.membershipId, input.membershipId) && sameLeaveId(request.typeId, input.typeId) && request.consumesBalance) for (const charge of request.chargedDays) if (charge.date > input.asOf) futureDates.set(charge.date, charge.microdays);
  return { membershipId: input.membershipId, typeId: input.typeId, asOf: input.asOf, openingMicrodays: now.opening, earnedMicrodays: now.earned, adjustmentMicrodays: now.adjusted, takenMicrodays: now.taken, expiredMicrodays: now.expired, availableMicrodays: now.available, reservedFutureMicrodays: [...futureDates.values()].reduce((sum, amount) => sum + amount, 0), projectedAvailableMicrodays: future.available, projectedThroughDate: horizon };
}
/** Caller includes its proposed approved request in source. Every future charge date is checked, not just final total. */
export function validateProjectedBalance(source: LeaveCalculationSource, input: { membershipId: string; typeId: string; asOf: string }): LeaveProjectionDeficitDto[] {
  dateOrdinal(input.asOf);
  return simulate(source, { ...input, through: futureHorizon(source, input.membershipId, input.typeId, input.asOf), deficitFrom: input.asOf }).deficits;
}

/** New/deeper deficits introduced by a single authorized change, across every consuming pool.
 * The caller supplies the explicit employer approval for the causative write; no confirmed request is rewritten.
 */
export function validateProjectedChange(before: LeaveCalculationSource, after: LeaveCalculationSource, input: { membershipId: string; asOf: string; deficitFrom?: string; negativeApproved: boolean }): LeaveProjectionDeficitDto[] {
  const deficitFrom = input.deficitFrom ?? input.asOf;
  dateOrdinal(input.asOf); dateOrdinal(deficitFrom);
  const typeIds = [...new Set(after.settings.policyVersions.flatMap((policy) => policy.types.filter((type) => type.consumesBalance).map((type) => type.id)))].sort();
  return typeIds.flatMap((typeId) => {
    const through = futureHorizon(after, input.membershipId, typeId, input.asOf);
    const prior = new Map(before.profiles.some((profile) => sameLeaveId(profile.membershipId, input.membershipId))
      ? simulate(before, { membershipId: input.membershipId, typeId, through, deficitFrom }).deficits.map((deficit) => [deficit.date, deficit] as const)
      : []);
    return simulate(after, { membershipId: input.membershipId, typeId, through, deficitFrom }).deficits
      .filter((deficit) => {
        const existing = prior.get(deficit.date);
        return deficit.availableMicrodays < (existing?.availableMicrodays ?? 0) || (existing?.negativeAllowed === true && !deficit.negativeAllowed);
      }).map((deficit) => ({ ...deficit, negativeApprovalRequired: !input.negativeApproved }));
  });
}

/** No employer-specific counts/holidays: snapshot flag must be consistent across a single approved interval. */
export function assertConsistentLeaveType(source: LeaveCalculationSource, typeId: string, startDate: string, endDate: string): void {
  const signatures = new Set<string>();
  for (let year = dateYear(startDate); year <= dateYear(endDate); year += 1) {
    const type = typeForYear(source, typeId, year) ?? invalidLeave('Absence type is missing from a covered policy year.');
    signatures.add(JSON.stringify([type.consumesBalance, type.pausesAccrual, type.capacityUnavailable, type.requiresApproval]));
  }
  if (signatures.size > 1) invalidLeave('Split this request at the policy year boundary because its absence behavior changes.');
}
