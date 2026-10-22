import type { WorkspaceReportBucketDto, WorkspaceReportResultDto } from '@workloom/contracts';

/** One person's paired Actual ÷ Estimate in one bucket; `ratio` is null when no task had both values (or the estimate was 0). */
export interface AccuracyPoint { start: string; end: string; ratio: number | null; paired: number }
export type TrendKind = 'improving' | 'worsening' | 'steady' | 'notEnough';
export interface AccuracyRow {
  key: string; membershipId: string | null; name: string; points: AccuracyPoint[];
  trend: TrendKind;
  /** Average distance from a perfect estimate (|ratio − 1|) in the earlier and the later half of the measured weeks. */
  earlyMiss: number | null; lateMiss: number | null;
}

export const GOOD_MISS = 0.1;
export const FAIR_MISS = 0.25;
/** Points needed before a direction is claimed, and the change in average miss that counts as a real move. */
export const MIN_POINTS = 4;
export const MOVE_THRESHOLD = 0.05;

const toNumber = (value: { numerator: string; denominator: string } | null): number | null => {
  if (!value) return null;
  const denominator = Number(value.denominator);
  return denominator === 0 ? null : Number(value.numerator) / denominator;
};

export const miss = (ratio: number): number => Math.abs(ratio - 1);

/** How far from a perfect estimate; the colour bands used in the table. */
export function band(ratio: number | null): 'good' | 'fair' | 'poor' | 'none' {
  if (ratio === null) return 'none';
  const m = miss(ratio);
  return m <= GOOD_MISS ? 'good' : m <= FAIR_MISS ? 'fair' : 'poor';
}

/**
 * Direction of the miss over the measured weeks: the average distance from 100% in the later half compared with the
 * earlier half. Needs at least MIN_POINTS weeks with paired tasks, and a clear move, otherwise it says "steady" or
 * "not enough data" instead of reading noise as progress.
 */
export function trendOf(points: readonly AccuracyPoint[]): { trend: TrendKind; early: number | null; late: number | null } {
  const measured = points.filter(point => point.ratio !== null).map(point => miss(point.ratio as number));
  if (measured.length < MIN_POINTS) return { trend: 'notEnough', early: null, late: null };
  const half = Math.floor(measured.length / 2);
  const average = (values: number[]) => values.reduce((sum, value) => sum + value, 0) / values.length;
  const early = average(measured.slice(0, half)), late = average(measured.slice(measured.length - half));
  const change = late - early;
  return { trend: change <= -MOVE_THRESHOLD ? 'improving' : change >= MOVE_THRESHOLD ? 'worsening' : 'steady', early, late };
}

function pointOf(bucket: WorkspaceReportBucketDto, comparison: WorkspaceReportBucketDto['comparison']): AccuracyPoint {
  return { start: bucket.startDate, end: bucket.endDate, ratio: comparison.pairedTasks > 0 ? toNumber(comparison.ratio) : null, paired: comparison.pairedTasks };
}

/** Rows for the team and every person in the result, one point per bucket in calendar order. */
export function accuracyRows(result: Pick<WorkspaceReportResultDto, 'buckets' | 'people' | 'summary'>, teamLabel: string, unassignedLabel: string): AccuracyRow[] {
  const buckets = [...result.buckets].sort((a, b) => a.startDate.localeCompare(b.startDate));
  const build = (key: string, membershipId: string | null, name: string, pick: (bucket: WorkspaceReportBucketDto) => AccuracyPoint): AccuracyRow => {
    const points = buckets.map(pick);
    const { trend, early, late } = trendOf(points);
    return { key, membershipId, name, points, trend, earlyMiss: early, lateMiss: late };
  };
  const team = build('team', null, teamLabel, bucket => pointOf(bucket, bucket.comparison));
  const people = result.people.map(person => build(person.membershipId ?? 'unassigned', person.membershipId, person.membershipId === null ? unassignedLabel : person.displayName, bucket => {
    const entry = bucket.people.find(candidate => candidate.membershipId === person.membershipId);
    return entry ? pointOf(bucket, entry.comparison) : { start: bucket.startDate, end: bucket.endDate, ratio: null, paired: 0 };
  }));
  return [team, ...people];
}
