import { leaveAvailabilityInputSchema, type GenericReportConfig } from '@workloom/contracts';

export type CapacityDateRange = { from: string; to: string };
export type ReportCapacityChoice = { kind: 'none' | 'project_dates' | 'task_dates' } | { kind: 'custom'; from: string; to: string };
export type ReportCapacitySource = 'saved' | ReportCapacityChoice['kind'];
export interface ReportCapacityView {
 config: GenericReportConfig;
 source: ReportCapacitySource;
 range: CapacityDateRange | null;
 reason: 'no_period' | 'project_dates_missing' | 'task_dates_missing' | 'invalid_range' | 'unassigned' | null;
 /** A transient read differs from the saved/quick-filter config; never capture it as that definition. */
 derived: boolean;
}
export function validCapacityRange(range: CapacityDateRange): boolean {
 return leaveAvailabilityInputSchema.safeParse({ startDate: range.from, endDate: range.to, people: { kind: 'all_active' } }).success;
}

/** No clock or implicit week: saved capacity wins, otherwise inherit the existing project period. */
export function reportCapacityView(base: GenericReportConfig, projectDates: CapacityDateRange | null, choice: ReportCapacityChoice | null): ReportCapacityView {
 if (choice === null && base.capacity) return { config: base, source: 'saved', range: { from: base.capacity.startDate, to: base.capacity.endDate }, reason: null, derived: false };
 const source: ReportCapacitySource = choice?.kind ?? (projectDates ? 'project_dates' : 'none');
 const { capacity: omitted, ...withoutCapacity } = base;
 void omitted;
 const none = (reason: ReportCapacityView['reason']): ReportCapacityView => ({ config: base.capacity ? withoutCapacity : base, source, range: null, reason, derived: base.capacity !== undefined });
 if (source === 'none') return none(choice?.kind === 'none' ? null : 'no_period');
 const range = source === 'project_dates' ? projectDates : source === 'task_dates' ? base.filters.dateRange : choice?.kind === 'custom' ? choice : null;
 if (!range) return none(source === 'project_dates' ? 'project_dates_missing' : source === 'task_dates' ? 'task_dates_missing' : 'no_period');
 if (!validCapacityRange(range)) return none('invalid_range');
 if (base.filters.assignee.kind === 'unassigned') return none('unassigned');
 const people = base.filters.assignee.kind === 'member' ? { kind: 'selected' as const, membershipIds: [base.filters.assignee.membershipId] } : { kind: 'all_active' as const };
 const capacity = { startDate: range.from, endDate: range.to, people };
 const same = JSON.stringify(base.capacity) === JSON.stringify(capacity);
 return { config: same ? base : { ...withoutCapacity, capacity }, source, range: { from: range.from, to: range.to }, reason: null, derived: !same };
}
