import type { GenericGroupResultDto, GenericReportNumberDto, GenericReportResultDto, GenericReportConfig } from '@workloom/contracts';
import { comparisonOperation } from './effortAttribution';

type Capacity = NonNullable<GenericReportResultDto['capacity']>;
export type PersonMetricsRow = { key: string; label: string; taskCount: number; plan: GenericReportNumberDto | null; fact: GenericReportNumberDto | null; capacityMinutes: number | null; comparison: GenericGroupResultDto['comparison'] };

/** Full-scope SUM for one field inside a group; the paired comparison is never a fallback. */
const groupSum = (group: GenericGroupResultDto, fieldId: string | undefined, config: GenericReportConfig): GenericReportNumberDto | null =>
  fieldId === undefined ? null : group.measures.find(measure => measure.operation === comparisonOperation(config) && measure.fieldId === fieldId)?.value ?? null;

/** Unknown settings or schedules stay null; a known zero schedule stays 0. Matching is by membership ID only. */
function memberMinutes(capacity: Capacity | undefined, membershipId: string): number | null {
  if (!capacity?.settingsConfigured) return null;
  const member = capacity.members.find(candidate => candidate.membershipId === membershipId);
  return member?.scheduleKnown ? member.availableMinutes : null;
}

/** Per-person rows from server group aggregates and authorized capacity; never from loaded detail rows. */
export function personMetrics(result: GenericReportResultDto): PersonMetricsRow[] {
  if (result.config.groupBy.kind !== 'assignee') return [];
  const { comparison } = result.config, capacity = result.capacity;
  const rows = result.groups.map(group => ({ key: group.key, label: group.label, taskCount: group.taskCount, plan: groupSum(group, comparison?.planFieldId, result.config), fact: groupSum(group, comparison?.factFieldId, result.config), capacityMinutes: memberMinutes(capacity, group.key), comparison: group.comparison }));
  if (!capacity) return rows;
  const grouped = new Set(result.groups.map(group => group.key));
  /** Capacity-only members have no tasks; the UI resolves their label from the key. */
  const idle = capacity.members.filter(member => !grouped.has(member.membershipId)).map(member => ({ key: member.membershipId, label: '', taskCount: 0, plan: null, fact: null, capacityMinutes: memberMinutes(capacity, member.membershipId), comparison: null }));
  return [...rows, ...idle];
}
