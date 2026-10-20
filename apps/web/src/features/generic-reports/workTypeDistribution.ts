import type { GenericCoverageDto, GenericMeasureResultDto, GenericReportConfig, GenericReportNumberDto, GenericReportResultDto } from '@workloom/contracts';
import { comparisonOperation } from './effortAttribution';
import { categoryColor, effortCategoryColor } from './categoryColors';
import type { PersonMetricsRow } from './dashboardMetrics';

/** Neutral decoration for Uncategorized and for options without a valid persisted color. */
export const UNCATEGORIZED_COLOR = '#94a3b8';

export type WorkTypeState = 'ready' | 'empty' | 'unknown' | 'zero' | 'negative' | 'inconsistent';
/** Labels are resolved by the UI from stableKey; wedge cutoffs exist only for positive categories of a ready card. */
export type WorkTypeLegendItem = { stableKey: string; value: GenericReportNumberDto | null; percentText: string | null; startBps?: number; endBps?: number; color: string };
export type WorkTypeTotal = { value: GenericReportNumberDto | null; unit: 'minutes' | 'number'; coverage: GenericCoverageDto };
export type WorkTypeDistribution = { state: WorkTypeState; total: WorkTypeTotal | null; items: WorkTypeLegendItem[] };

type Rational = { n: bigint; d: bigint };
type Slice = { key: string; value: GenericReportNumberDto | null; exact: Rational | null; coverage: GenericCoverageDto; taskCount: number };

const FULL_BPS = 10000n;
const COVERAGE_PARTS = ['tasks', 'filled', 'missing', 'null', 'zero'] as const;
const sameId = (first: string, second: string) => first.toLowerCase() === second.toLowerCase();
const byKey = (first: string, second: string) => first < second ? -1 : first > second ? 1 : 0;
const copy = (value: GenericReportNumberDto | null) => value && { ...value };

/** Authoritative strings only; anything the contract would reject is unparseable rather than coerced. */
function rational(value: GenericReportNumberDto): Rational | null {
  return /^-?\d+$/.test(value.numerator) && /^[1-9]\d*$/.test(value.denominator) ? { n: BigInt(value.numerator), d: BigInt(value.denominator) } : null;
}
const add = (first: Rational, second: Rational): Rational => ({ n: first.n * second.d + second.n * first.d, d: first.d * second.d });
const compare = (first: Rational, second: Rational) => {
  const diff = first.n * second.d - second.n * first.d;
  return diff < 0n ? -1 : diff > 0n ? 1 : 0;
};
/** Half-up for a non-negative numerator over a positive denominator. */
const halfUp = (numerator: bigint, denominator: bigint) => numerator / denominator + ((numerator % denominator) * 2n >= denominator ? 1n : 0n);

/** Same half-up and ≈ convention as roundedRational, at basis-point precision. */
function percentText(numerator: bigint, denominator: bigint): string {
  const scaled = numerator * FULL_BPS, bps = halfUp(scaled, denominator);
  const fraction = (bps % 100n).toString().padStart(2, '0').replace(/0+$/, '');
  return `${scaled % denominator !== 0n ? '≈' : ''}${bps / 100n}${fraction ? `.${fraction}` : ''}%`;
}

/** A SUM over no filled values is unknown, even when the server spells it as zero. */
const known = (measure: GenericMeasureResultDto) => measure.coverage.filled > 0 ? measure.value : null;

/** Only an explicitly configured SUM of the metric field qualifies; results are matched by that measure's key. */
function metricMatcher(config: GenericReportConfig, metricFieldId: string) {
  const configured = config.measures.find(measure => (config.comparison ? measure.operation === comparisonOperation(config) : measure.operation === 'sum' || measure.operation === 'personal_effort') && 'fieldId' in measure && sameId(measure.fieldId, metricFieldId));
  return configured ? (measure: GenericMeasureResultDto) => measure.key === configured.key && measure.operation === configured.operation && measure.fieldId !== null && sameId(measure.fieldId, metricFieldId) : null;
}

/**
 * Work-type shares for one explicitly filtered person, from server category groups only.
 * Detail rows and labels are never read; any doubt about the partition withholds the pie.
 */
export function workTypeDistribution(result: GenericReportResultDto, metricFieldId: string, categoryFieldId: string): WorkTypeDistribution {
  const { groupBy, filters, projectId } = result.config;
  const isMetric = metricMatcher(result.config, metricFieldId);
  const measure = isMetric ? result.measures.find(isMetric) : undefined;
  if (groupBy.kind !== 'category' || !sameId(groupBy.fieldId, categoryFieldId) || filters.assignee.kind === 'all' || !isMetric || !measure || measure.unit !== 'minutes' && measure.unit !== 'number') return { state: 'inconsistent', total: null, items: [] };
  const fieldId = groupBy.fieldId, unit = measure.unit, coverage = measure.coverage;
  const totalValue = known(measure), totalExact = totalValue && rational(totalValue);
  const total: WorkTypeTotal = { value: copy(totalValue), unit, coverage: { ...coverage } };
  if (totalValue && !totalExact) return { state: 'inconsistent', total, items: [] };

  const slices: Slice[] = [];
  for (const group of result.groups) {
    const groupMeasure = group.measures.find(isMetric);
    const value = groupMeasure ? known(groupMeasure) : null, exact = value && rational(value);
    if (!groupMeasure || groupMeasure.unit !== unit || value && !exact) return { state: 'inconsistent', total, items: [] };
    slices.push({ key: group.key, value, exact, coverage: groupMeasure.coverage, taskCount: group.taskCount });
  }
  const legend = (slice: Slice): WorkTypeLegendItem => ({ stableKey: slice.key, value: copy(slice.value), percentText: null, color: effortCategoryColor(result.groups.find(group=>group.key===slice.key)?.measures.find(isMetric)?.effort,fieldId,slice.key) ?? categoryColor(result.fields, projectId, fieldId, slice.key) ?? UNCATEGORIZED_COLOR });
  const items = slices.map(legend);

  /** Groups must partition the full scope exactly once; this also rejects multi-value double counting. */
  const totalSources = measure.effort?.contributions.map(row => row.sourceKey), groupSources = slices.flatMap(slice => result.groups.find(group => group.key === slice.key)?.measures.find(isMetric)?.effort?.contributions.map(row => row.sourceKey) ?? []);
  const sourcePartitioned = totalSources !== undefined && new Set(totalSources).size === totalSources.length && new Set(groupSources).size === groupSources.length && totalSources.length === groupSources.length && totalSources.every(key => groupSources.includes(key));
  const partitioned = new Set(slices.map(slice => slice.key.toLowerCase())).size === slices.length
    && (measure.effort ? sourcePartitioned : slices.reduce((count, slice) => count + slice.taskCount, 0) === result.totalTasks)
    && COVERAGE_PARTS.every(part => slices.reduce((count, slice) => count + slice.coverage[part], 0) === coverage[part]);
  if (!partitioned) return { state: 'inconsistent', total, items };
  if (result.totalTasks === 0) return { state: 'empty', total, items: [] };
  if (totalExact && totalExact.n < 0n || slices.some(slice => slice.exact && slice.exact.n < 0n)) return { state: 'negative', total, items };
  if (!totalExact) return { state: slices.some(slice => slice.exact) ? 'inconsistent' : 'unknown', total, items };
  const whole = totalExact;
  const knownSum = slices.reduce<Rational>((sum, slice) => slice.exact ? add(sum, slice.exact) : sum, { n: 0n, d: 1n });
  if (compare(knownSum, whole) !== 0) return { state: 'inconsistent', total, items };
  if (whole.n === 0n) return { state: 'zero', total, items };

  /** Cutoffs round exact cumulative sums, never summed per-item percentages, so the last wedge ends at exactly 10000. */
  let cumulative: Rational = { n: 0n, d: 1n }, startBps = 0;
  const ready = slices.map(slice => {
    const item = legend(slice);
    if (!slice.exact) return item;
    item.percentText = percentText(slice.exact.n * whole.d, slice.exact.d * whole.n);
    if (slice.exact.n === 0n) return item;
    cumulative = add(cumulative, slice.exact);
    const endBps = Number(halfUp(cumulative.n * whole.d * FULL_BPS, cumulative.d * whole.n));
    const wedge = { ...item, startBps, endBps };
    startBps = endBps;
    return wedge;
  });
  return { state: 'ready', total, items: ready };
}

/** Display order only: exact descending actual with unknown last, then locale name, then stable key. Labels are pre-resolved by the caller. */
export function sortablePersonRows(rows: readonly PersonMetricsRow[], sort: 'name' | 'actual', locale = 'en'): PersonMetricsRow[] {
  const collator = new Intl.Collator(locale);
  const byName = (first: PersonMetricsRow, second: PersonMetricsRow) => collator.compare(first.label, second.label) || byKey(first.key, second.key);
  if (sort === 'name') return [...rows].sort(byName);
  const facts = new Map(rows.map(row => [row, row.fact && rational(row.fact)] as const));
  return [...rows].sort((first, second) => {
    const a = facts.get(first) ?? null, b = facts.get(second) ?? null;
    if (a && b) return compare(b, a) || byName(first, second);
    return a ? -1 : b ? 1 : byName(first, second);
  });
}
