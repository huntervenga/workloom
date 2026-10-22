import type { LeaveBalanceDto, LeaveCalculationSource, LeaveProjectionDeficitDto, LeaveRequestDto, LeaveTypeDto } from '@workloom/contracts';
import { invalidLeave, dateOrdinal, dateYear, isEmployed, ordinalDate, policyVersionForYearOptional, profileForMemberOptional, sameLeaveId } from './calendar.js';

interface Lot { amount: number; expires: string | null }
interface Simulation { opening: number; earned: number; adjusted: number; taken: number; expired: number; available: number; deficits: LeaveProjectionDeficitDto[] }

/** Optional type lookup for simulation - returns undefined if type missing in year */
function typeForYearOptional(source: LeaveCalculationSource, typeId: string, year: number): LeaveTypeDto | undefined {
  const policy = policyVersionForYearOptional(source.settings, year);
  return policy?.types.find((type) => sameLeaveId(type.id, typeId));
}

function expiryAfterMonths(year: number, months: number): string { return `${year + Math.floor(months / 12)}-${String(months % 12 + 1).padStart(2, '0')}-01`; }
function prorata(entitlement: number, days: number, yearDays: number): number { return Number(BigInt(entitlement) * BigInt(days) / BigInt(yearDays)); }

/**
 * Replays pinned charge dates and current approved pause intervals.
 *
 * Engine tolerant behavior:
 * - Missing type in a year => zero accrual for that year, no crash
 * - Missing policy before earliest year => zero accrual, holidays none
 * - Opening anchored at accounting start even before hire
 * - Accrue only while employed AND on/after accounting start
 * - Pinned charges >= accounting are debited even outside employment
 * - Earlier charges/adjustments retained but excluded from balance
 * - Preserve old lots/debt at year-close even if type is missing (no expiry invention)
 */
function simulate(source: LeaveCalculationSource, input: { membershipId: string; typeId: string; through: string; deficitFrom: string; historicalMinimum?: boolean }): Simulation {
  const profile = profileForMemberOptional(source, input.membershipId);
  const result: Simulation = { opening: 0, earned: 0, adjusted: 0, taken: 0, expired: 0, available: 0, deficits: [] };

  // No profile = no balance calculation possible
  if (!profile) return result;

  const through = dateOrdinal(input.through);
  const accountingOrdinal = dateOrdinal(profile.accountingStart);

  // If through date is before accounting start, nothing to calculate
  if (through < accountingOrdinal) return result;

  let debt = 0;
  let lots: Lot[] = [];

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

  // Build pause intervals from approved requests
  const pausedIntervals: { start: number; end: number }[] = [];
  for (const request of source.requests.filter((request) => sameLeaveId(request.membershipId, input.membershipId) && request.status === 'approved' && request.pausesAccrual).sort((a, b) => a.startDate.localeCompare(b.startDate))) {
    const next = { start: dateOrdinal(request.startDate), end: dateOrdinal(request.endDate) };
    const last = pausedIntervals.at(-1);
    if (last !== undefined && next.start <= last.end + 1) last.end = Math.max(last.end, next.end);
    else pausedIntervals.push(next);
  }
  let pauseIndex = 0;

  // Cache type lookups per year
  const typesByYear = new Map<number, LeaveTypeDto | undefined>();
  const resolveType = (year: number): LeaveTypeDto | undefined => {
    if (!typesByYear.has(year)) typesByYear.set(year, typeForYearOptional(source, input.typeId, year));
    return typesByYear.get(year);
  };

  // Collect all charges by date (pinned approved requests only)
  const requests = source.requests.filter((request) => request.status === 'approved' && sameLeaveId(request.membershipId, input.membershipId) && sameLeaveId(request.typeId, input.typeId) && request.consumesBalance).sort((a, b) => a.id.localeCompare(b.id));
  const chargeByDate = new Map<string, { amount: number; request: LeaveRequestDto }>();
  for (const request of requests) for (const charge of request.chargedDays) {
    // Pinned charges are debited if >= accounting, even outside employment
    if (dateOrdinal(charge.date) >= accountingOrdinal && !chargeByDate.has(charge.date)) {
      chargeByDate.set(charge.date, { amount: charge.microdays, request });
    }
  }

  // Collect adjustments by date (only those >= accounting start)
  const adjustments = new Map<string, number>();
  for (const adjustment of source.adjustments) {
    if (sameLeaveId(adjustment.membershipId, input.membershipId) && sameLeaveId(adjustment.typeId, input.typeId)) {
      if (dateOrdinal(adjustment.effectiveDate) >= accountingOrdinal) {
        adjustments.set(adjustment.effectiveDate, (adjustments.get(adjustment.effectiveDate) ?? 0) + adjustment.deltaMicrodays);
      }
    }
  }

  // Opening balance anchored at accounting start
  result.opening = profile.openingBalances.find((opening) => sameLeaveId(opening.typeId, input.typeId))?.microdays ?? 0;
  credit(result.opening);

  let eligibleDays = 0;
  let previousAccrued = 0;
  let upfrontCredited = false;
  let previousYear = dateYear(profile.accountingStart);
  let yearStart = dateOrdinal(`${previousYear}-01-01`);
  let yearEnd = dateOrdinal(`${previousYear}-12-31`);

  for (let ordinal = accountingOrdinal; ordinal <= through; ordinal += 1) {
    const date = ordinalDate(ordinal);
    const year = Number(date.slice(0, 4));

    // Expire before applying the carry cap
    for (const lot of lots) if (lot.expires !== null && lot.expires <= date) { result.expired += lot.amount; lot.amount = 0; }

    if (year !== previousYear) {
      // Year-end carry: apply previous year's type rules (if any)
      // If type is missing in previous year, preserve lots/debt as-is (no expiry invention)
      const previousType = resolveType(previousYear);
      if (previousType !== undefined) {
        const carry = previousType.carryover;
        const available = lots.reduce((sum, lot) => sum + lot.amount, 0);
        const permitted = carry.mode === 'unlimited' ? available : carry.mode === 'capped' ? Math.min(available, carry.capMicrodays ?? 0) : 0;
        let remaining = permitted;
        lots.sort((a, b) => (b.expires ?? '9999').localeCompare(a.expires ?? '9999'));
        for (const lot of lots) {
          const retained = Math.min(remaining, lot.amount);
          result.expired += lot.amount - retained;
          lot.amount = retained;
          remaining -= retained;
          if (carry.expiresAfterMonths !== null && carry.expiresAfterMonths !== undefined) {
            const expires = expiryAfterMonths(year, carry.expiresAfterMonths);
            if (lot.expires === null || lot.expires > expires) lot.expires = expires;
          }
        }
      }
      // If type is missing, lots/debt preserved as-is (undefined carry = no change)

      previousYear = year;
      eligibleDays = 0;
      previousAccrued = 0;
      upfrontCredited = false;
      yearStart = dateOrdinal(`${year}-01-01`);
      yearEnd = dateOrdinal(`${year}-12-31`);
    }

    // Post-year-change expiry check
    for (const lot of lots) if (lot.expires !== null && lot.expires <= date) { result.expired += lot.amount; lot.amount = 0; }

    const type = resolveType(year);

    // Advance pause index
    while ((pausedIntervals[pauseIndex]?.end ?? Infinity) < ordinal) pauseIndex += 1;
    const pause = pausedIntervals[pauseIndex];

    // Accrual eligibility: employed AND on/after accounting AND not paused
    const eligible = isEmployed(profile, date) && !(pause !== undefined && pause.start <= ordinal && pause.end >= ordinal);

    // Accrue only if type exists and consumes balance
    if (type !== undefined && type.consumesBalance && eligible) {
      let accrued = 0;
      if (type.accrualMethod === 'daily') {
        eligibleDays += 1;
        const cumulative = prorata(type.annualEntitlementMicrodays, eligibleDays, yearEnd - yearStart + 1);
        accrued = cumulative - previousAccrued;
        previousAccrued = cumulative;
      } else if (!upfrontCredited) {
        const eligibleStart = Math.max(accountingOrdinal, yearStart, dateOrdinal(profile.employmentStart));
        const eligibleEnd = Math.min(yearEnd, profile.employmentEnd === null ? yearEnd : dateOrdinal(profile.employmentEnd));
        let annualEligible = Math.max(0, eligibleEnd - eligibleStart + 1);
        for (const p of pausedIntervals) annualEligible -= Math.max(0, Math.min(p.end, eligibleEnd) - Math.max(p.start, eligibleStart) + 1);
        accrued = prorata(type.annualEntitlementMicrodays, annualEligible, yearEnd - yearStart + 1);
        upfrontCredited = true;
      }
      credit(accrued);
      result.earned += accrued;
    }
    // Missing type = zero accrual (no crash)

    // Apply adjustments
    const adjustment = adjustments.get(date) ?? 0;
    credit(adjustment);
    result.adjusted += adjustment;

    // Apply charges (pinned, >= accounting)
    const charge = chargeByDate.get(date);
    if (charge !== undefined) {
      spend(charge.amount);
      result.taken += charge.amount;
      if (!input.historicalMinimum && date >= input.deficitFrom && balance() < 0) {
        const permittedNegative = type?.allowNegative === true && (type.maxNegativeMicrodays === null || -balance() <= type.maxNegativeMicrodays);
        result.deficits.push({
          membershipId: input.membershipId,
          typeId: input.typeId,
          requestId: charge.request.id,
          date,
          availableMicrodays: balance(),
          negativeAllowed: permittedNegative,
          negativeApprovalRequired: !charge.request.negativeApproved
        });
      }
    }

    // Diagnostics observe every balance-affecting event, not only request charges.
    // Keep one worst dated point per pool; ordinary admission deficit semantics stay unchanged.
    if (input.historicalMinimum && (ordinal===accountingOrdinal||adjustments.has(date)||charge!==undefined||ordinal===through) && balance()<0 && (result.deficits[0]?.availableMicrodays??0)>balance()) {
      result.deficits=[{membershipId:input.membershipId,typeId:input.typeId,requestId:charge?.request.id??input.membershipId,date,availableMicrodays:balance(),negativeAllowed:type?.allowNegative===true&&(type.maxNegativeMicrodays===null||-balance()<=type.maxNegativeMicrodays),negativeApprovalRequired:false}];
    }

    lots = lots.filter((lot) => lot.amount > 0);
  }

  result.available = balance();
  return result;
}

function futureHorizon(source: LeaveCalculationSource, membershipId: string, typeId: string, asOf: string): string {
  const accountingStart=profileForMemberOptional(source,membershipId)?.accountingStart??'2200-12-31';
  const horizon=source.requests.filter((request) => request.status === 'approved' && sameLeaveId(request.membershipId, membershipId) && sameLeaveId(request.typeId, typeId) && request.consumesBalance).flatMap((request) => request.chargedDays.filter(charge=>charge.date>=accountingStart).map((charge) => charge.date)).reduce((last, date) => date > last ? date : last, asOf);
  return source.adjustments.filter(a=>sameLeaveId(a.membershipId,membershipId)&&sameLeaveId(a.typeId,typeId)&&a.effectiveDate>=accountingStart).reduce((last,a)=>a.effectiveDate>last?a.effectiveDate:last,horizon);
}

/**
 * Calculates leave balance for a member/type as of a date.
 *
 * Tolerant behavior:
 * - If type never defined anywhere, returns zero balance (no crash)
 * - If type missing in some years, zero accrual for those years
 * - Opening/charges/adjustments still apply
 */
export function calculateLeaveBalance(source: LeaveCalculationSource, input: { membershipId: string; typeId: string; asOf: string }): LeaveBalanceDto {
  dateOrdinal(input.asOf);
  if(!source.settings.policyVersions.some(p=>p.types.some(t=>sameLeaveId(t.id,input.typeId)))&&!balanceTypeIds(source,input.membershipId).some(id=>sameLeaveId(id,input.typeId)))invalidLeave('Unknown absence balance type.');
  // Tolerant: if type never existed in any policy, return zero balance (not an error)
  // This allows reading orphan historical balances
  const now = simulate(source, { ...input, through: input.asOf, deficitFrom: input.asOf });
  const horizon = futureHorizon(source, input.membershipId, input.typeId, input.asOf);
  const future = horizon === input.asOf ? now : simulate(source, { ...input, through: horizon, deficitFrom: input.asOf });
  const futureDates = new Map<string, number>();
  const accountingStart=profileForMemberOptional(source,input.membershipId)?.accountingStart??'2200-12-31';
  for (const request of source.requests) if (request.status === 'approved' && sameLeaveId(request.membershipId, input.membershipId) && sameLeaveId(request.typeId, input.typeId) && request.consumesBalance) for (const charge of request.chargedDays) if (charge.date > input.asOf && charge.date>=accountingStart) futureDates.set(charge.date, charge.microdays);
  return { membershipId: input.membershipId, typeId: input.typeId, asOf: input.asOf, openingMicrodays: now.opening, earnedMicrodays: now.earned, adjustmentMicrodays: now.adjusted, takenMicrodays: now.taken, expiredMicrodays: now.expired, availableMicrodays: now.available, reservedFutureMicrodays: [...futureDates.values()].reduce((sum, amount) => sum + amount, 0), projectedAvailableMicrodays: future.available, projectedThroughDate: horizon };
}

/** Caller includes its proposed approved request in source. Every future charge date is checked, not just final total. */
export function validateProjectedBalance(source: LeaveCalculationSource, input: { membershipId: string; typeId: string; asOf: string }): LeaveProjectionDeficitDto[] {
  dateOrdinal(input.asOf);
  return simulate(source, { ...input, through: futureHorizon(source, input.membershipId, input.typeId, input.asOf), deficitFrom: input.asOf }).deficits;
}

/** One bounded diagnostic for opening, request, adjustment and final balance event points. */
export function historicalLeaveDeficit(source:LeaveCalculationSource,input:{membershipId:string;typeId:string;asOf:string}):LeaveProjectionDeficitDto|undefined {
 const accountingStart=profileForMemberOptional(source,input.membershipId)?.accountingStart??input.asOf;
 return simulate(source,{...input,through:futureHorizon(source,input.membershipId,input.typeId,input.asOf),deficitFrom:accountingStart,historicalMinimum:true}).deficits[0];
}

/**
 * New/deeper deficits introduced by a single authorized change, across every consuming pool.
 * The caller supplies the explicit employer approval for the causative write; no confirmed request is rewritten.
 *
 * Balance type universe: union of all policy/opening/approved-charge/adjustment type IDs.
 */
export function validateProjectedChange(before: LeaveCalculationSource, after: LeaveCalculationSource, input: { membershipId: string; asOf: string; deficitFrom?: string; negativeApproved: boolean }): LeaveProjectionDeficitDto[] {
  const scoped=(source:LeaveCalculationSource):LeaveCalculationSource=>({...source,profiles:source.profiles.filter(p=>sameLeaveId(p.membershipId,input.membershipId)),requests:source.requests.filter(r=>sameLeaveId(r.membershipId,input.membershipId)),adjustments:source.adjustments.filter(a=>sameLeaveId(a.membershipId,input.membershipId))});
  before=scoped(before);after=scoped(after);
  const deficitFrom = input.deficitFrom ?? input.asOf;
  dateOrdinal(input.asOf); dateOrdinal(deficitFrom);

  // Collect all type IDs from policies, openings, charges, adjustments
  const allTypeIds = new Set<string>();
  for (const policy of after.settings.policyVersions) {
    for (const type of policy.types) if (type.consumesBalance) allTypeIds.add(type.id.toLowerCase());
  }
  for (const profile of after.profiles) {
    for (const opening of profile.openingBalances) allTypeIds.add(opening.typeId.toLowerCase());
  }
  for (const request of after.requests) {
    if (request.consumesBalance) allTypeIds.add(request.typeId.toLowerCase());
  }
  for (const adjustment of after.adjustments) {
    allTypeIds.add(adjustment.typeId.toLowerCase());
  }

  const typeIds = [...allTypeIds].sort();
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

/**
 * Checks type consistency across a date range for approval.
 * Admin can use missing/inconsistent types (generates warnings); non-admin blocked.
 */
export function assertConsistentLeaveType(source: LeaveCalculationSource, typeId: string, startDate: string, endDate: string, options?: { canManage?: boolean }): void {
  const canManage = options?.canManage ?? false;
  const signatures = new Set<string>();
  let anyMissing = false;

  for (let year = dateYear(startDate); year <= dateYear(endDate); year += 1) {
    const type = typeForYearOptional(source, typeId, year);
    if (!type) {
      anyMissing = true;
      if (!canManage) {
        // Non-admin: type must exist in all covered years
        invalidLeave('Absence type is missing from a covered policy year.');
      }
      // Admin: skip missing years (warning will be generated)
      continue;
    }
    signatures.add(JSON.stringify([type.consumesBalance, type.pausesAccrual, type.capacityUnavailable, type.requiresApproval]));
  }

  // If all years are missing for admin, that's okay (warnings)
  if (anyMissing && signatures.size === 0 && canManage) return;

  // Admin can have changed type behavior (warning only); non-admin blocked
  if (signatures.size > 1 && !canManage) {
    invalidLeave('Split this request at the policy year boundary because its absence behavior changes.');
  }
}

/** Include orphan pinned pools without silently inventing entitlement. */
export function balanceTypeIds(source:LeaveCalculationSource,membershipId?:string):string[]{return [...new Set([
 ...source.settings.policyVersions.flatMap(p=>p.types.filter(t=>t.consumesBalance).map(t=>t.id)),
 ...source.profiles.filter(p=>membershipId===undefined||sameLeaveId(p.membershipId,membershipId)).flatMap(p=>p.openingBalances.map(b=>b.typeId)),
 ...source.requests.filter(r=>(membershipId===undefined||sameLeaveId(r.membershipId,membershipId))&&r.consumesBalance&&r.status==='approved').map(r=>r.typeId),
 ...source.adjustments.filter(a=>membershipId===undefined||sameLeaveId(a.membershipId,membershipId)).map(a=>a.typeId)
])].sort();}
