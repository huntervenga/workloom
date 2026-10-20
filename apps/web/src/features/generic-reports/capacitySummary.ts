import type { LeaveAvailabilityDto } from '@workloom/contracts';

export type CapacitySummary = { availableMinutes: number | null; knownMembers: number; totalMembers: number; unknownMembers: number; partial: boolean; complete: boolean };

/**
 * Team capacity headline from the server DTO. `totals.availableMinutes` is the authoritative sum over known schedules
 * and is never rebuilt from members, days or task rows. A partial subtotal is not a team total: callers must not label it
 * as all staff or derive a team utilization ratio unless `complete` is true.
 */
export function capacitySummary(capacity: LeaveAvailabilityDto | undefined): CapacitySummary {
  if (!capacity) return { availableMinutes: null, knownMembers: 0, totalMembers: 0, unknownMembers: 0, partial: false, complete: false };
  const { members, totals } = capacity;
  /** Unconfigured settings make every schedule unknown, whatever the member flags say. */
  if (!capacity.settingsConfigured) {
    const unknownMembers = Math.max(members.length, totals.unconfiguredMembers);
    return { availableMinutes: null, knownMembers: 0, totalMembers: unknownMembers, unknownMembers, partial: false, complete: false };
  }
  const flaggedUnknown = members.filter(member => !member.scheduleKnown).length;
  const knownMembers = members.length - flaggedUnknown;
  /** The server count and member flags describe the same people, so take the larger instead of adding them. */
  const unknownMembers = Math.max(flaggedUnknown, totals.unconfiguredMembers);
  /** With nobody known the server 0 is not a real capacity; a known 0-minute schedule stays 0. */
  const allUnknown = knownMembers === 0 && unknownMembers > 0;
  return {
    availableMinutes: allUnknown ? null : totals.availableMinutes,
    knownMembers,
    totalMembers: knownMembers + unknownMembers,
    unknownMembers,
    partial: knownMembers > 0 && unknownMembers > 0,
    complete: unknownMembers === 0,
  };
}
