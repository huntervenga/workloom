import type { GenericCoverageDto, GenericMeasureResultDto, GenericReportNumberDto, GenericReportResultDto, GenericReportRowDto, TaskFieldDefinitionDto } from '@workloom/contracts';
import { describe, expect, it } from 'vitest';
import type { PersonMetricsRow } from './dashboardMetrics';
import { sortablePersonRows, UNCATEGORIZED_COLOR, workTypeDistribution } from './workTypeDistribution';

const id = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
const PROJECT = id(0x1), OTHER_PROJECT = id(0x2), PERSON = id(0x3), METRIC = id(0xabc), ESTIMATE = id(0x4), CATEGORY = id(0xca7), OTHER_CATEGORY = id(0x5);
const BUILD = id(0xb1), REVIEW = id(0xb2), SUPPORT = id(0xb3);
/** Any group key without a persisted option of the category field. */
const UNCATEGORIZED = 'uncategorized';

/** Only the subset categoryColor reads; the full field schema lives outside the provided sources. */
const categoryField = { id: CATEGORY, projectId: PROJECT, type: 'single_select', options: [{ id: BUILD, color: '#2563EB' }, { id: REVIEW, color: '#2563eb' }, { id: SUPPORT, color: 'teal' }] } as unknown as TaskFieldDefinitionDto;

const num = (numerator: string, denominator = '1', decimal = numerator): GenericReportNumberDto => ({ numerator, denominator, decimal });
const ZERO_COVERAGE: GenericCoverageDto = { tasks: 0, filled: 0, missing: 0, null: 0, zero: 0 };
type Spec = { key: string; tasks: number; value: GenericReportNumberDto | null; coverage?: GenericCoverageDto };
const coverageOf = ({ tasks, value, coverage }: Spec): GenericCoverageDto => coverage ?? (value === null ? { ...ZERO_COVERAGE, tasks, missing: tasks } : { ...ZERO_COVERAGE, tasks, filled: tasks, zero: value.numerator === '0' ? tasks : 0 });
const addCoverage = (a: GenericCoverageDto, b: GenericCoverageDto): GenericCoverageDto => ({ tasks: a.tasks + b.tasks, filled: a.filled + b.filled, missing: a.missing + b.missing, null: a.null + b.null, zero: a.zero + b.zero });
const sum = (key: string, fieldId: string, value: GenericReportNumberDto | null, coverage: GenericCoverageDto, unit: 'minutes' | 'number'): GenericMeasureResultDto => ({ key, operation: 'sum', fieldId, unit, value, coverage });

/** Every group carries a decoy SUM of another field first, with identical labels, so only key/field matching can work. */
function report(specs: Spec[], total: GenericReportNumberDto | null, unit: 'minutes' | 'number' = 'minutes'): GenericReportResultDto {
  const coverage = specs.map(coverageOf).reduce(addCoverage, ZERO_COVERAGE);
  return {
    reportId: null, definitionRevision: null, sourceVersion: 'a'.repeat(64),
    config: { projectId: PROJECT, hierarchy: 'all_tasks', measures: [{ key: 'estimate', operation: 'sum', fieldId: ESTIMATE }, { key: 'actual', operation: 'sum', fieldId: METRIC }], comparison: null, groupBy: { kind: 'category', fieldId: CATEGORY }, filters: { statusGroups: [], tagIds: [], assignee: { kind: 'member', membershipId: PERSON }, dateRange: null } },
    scope: 'project_presence_canonical_tasks', hierarchy: 'all_tasks', attribution: 'primary_assignee', fields: [categoryField],
    totalTasks: coverage.tasks, measures: [sum('estimate', ESTIMATE, num('7'), coverage, unit), sum('actual', METRIC, total, coverage, unit)], initialMeasures: null, comparison: null, initialComparison: null,
    groups: specs.map(spec => ({ key: spec.key, label: 'Same label', taskCount: spec.tasks, measures: [sum('estimate', ESTIMATE, num('7'), coverageOf(spec), unit), sum('actual', METRIC, spec.value, coverageOf(spec), unit)], comparison: null, initialComparison: null })),
    rows: [], offset: 0, nextOffset: null, initialSnapshot: null, cohorts: null,
  };
}
const variant = (base: GenericReportResultDto, edit: (draft: GenericReportResultDto) => void) => { const draft = structuredClone(base); edit(draft); return draft; };
const actual = (measures: GenericMeasureResultDto[]) => { const measure=measures.find(candidate => candidate.key === 'actual'); if(!measure) throw Error('Missing actual fixture measure'); return measure; };
const group = (result: GenericReportResultDto, key: string) => { const value=result.groups.find(candidate => candidate.key === key); if(!value) throw Error('Missing fixture group'); return value; };
function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') { for (const child of Object.values(value)) deepFreeze(child); Object.freeze(value); }
  return value;
}
const simple = () => report([{ key: BUILD, tasks: 1, value: num('60') }, { key: UNCATEGORIZED, tasks: 1, value: num('60') }], num('120'));

describe('workTypeDistribution', () => {
  it('splits thirds beyond Number precision from exact cumulative cutoffs', () => {
    const third = num((10n ** 30n + 1n).toString(), '3', '333333333333333333333333333333.666666666667'), total = num((10n ** 30n + 1n).toString());
    const input = report([{ key: BUILD, tasks: 2, value: third }, { key: REVIEW, tasks: 1, value: third }, { key: UNCATEGORIZED, tasks: 3, value: third }], total);
    // Individually rounded shares sum to 9999 bps; the ring must still close at 10000.
    expect(workTypeDistribution(input, METRIC, CATEGORY)).toStrictEqual({
      state: 'ready',
      total: { value: total, unit: 'minutes', coverage: { tasks: 6, filled: 6, missing: 0, null: 0, zero: 0 } },
      items: [
        { stableKey: BUILD, value: third, percentText: '≈33.33%', startBps: 0, endBps: 3333, color: '#2563eb' },
        { stableKey: REVIEW, value: third, percentText: '≈33.33%', startBps: 3333, endBps: 6667, color: '#2563eb' },
        { stableKey: UNCATEGORIZED, value: third, percentText: '≈33.33%', startBps: 6667, endBps: 10000, color: UNCATEGORIZED_COLOR },
      ],
    });
  });

  it('rounds exact half basis points up without summing rounded percentages', () => {
    const tiny = num((10n ** 20n).toString()), rest = num((19999n * 10n ** 20n).toString()), total = num((2n * 10n ** 24n).toString());
    const result = workTypeDistribution(report([{ key: BUILD, tasks: 1, value: tiny }, { key: REVIEW, tasks: 1, value: rest }], total, 'number'), METRIC, CATEGORY);
    expect(result.state).toBe('ready');
    expect(result.total?.unit).toBe('number');
    // 1 + 10000 individually rounded bps would overflow the ring.
    expect(result.items.map(({ percentText, startBps, endBps }) => ({ percentText, startBps, endBps }))).toStrictEqual([
      { percentText: '≈0.01%', startBps: 0, endBps: 1 },
      { percentText: '≈100%', startBps: 1, endBps: 10000 },
    ]);
  });

  it('keeps known-zero and unknown categories distinct while Uncategorized stays in the denominator', () => {
    const input = report([
      { key: BUILD, tasks: 2, value: num('90') },
      { key: REVIEW, tasks: 1, value: num('0') },
      { key: SUPPORT, tasks: 2, value: null, coverage: { tasks: 2, filled: 0, missing: 1, null: 1, zero: 0 } },
      { key: UNCATEGORIZED, tasks: 1, value: num('30') },
    ], num('120'));
    expect(workTypeDistribution(input, METRIC, CATEGORY)).toStrictEqual({
      state: 'ready',
      total: { value: num('120'), unit: 'minutes', coverage: { tasks: 6, filled: 4, missing: 1, null: 1, zero: 1 } },
      items: [
        { stableKey: BUILD, value: num('90'), percentText: '75%', startBps: 0, endBps: 7500, color: '#2563eb' },
        { stableKey: REVIEW, value: num('0'), percentText: '0%', color: '#2563eb' },
        { stableKey: SUPPORT, value: null, percentText: null, color: UNCATEGORIZED_COLOR },
        { stableKey: UNCATEGORIZED, value: num('30'), percentText: '25%', startBps: 7500, endBps: 10000, color: UNCATEGORIZED_COLOR },
      ],
    });
  });

  it('reports empty, unknown and zero totals without wedges', () => {
    expect(workTypeDistribution(report([], null), METRIC, CATEGORY)).toStrictEqual({ state: 'empty', total: { value: null, unit: 'minutes', coverage: ZERO_COVERAGE }, items: [] });

    const unknown = workTypeDistribution(report([{ key: BUILD, tasks: 2, value: null }, { key: UNCATEGORIZED, tasks: 1, value: null }], null), METRIC, CATEGORY);
    expect(unknown).toStrictEqual({
      state: 'unknown',
      total: { value: null, unit: 'minutes', coverage: { tasks: 3, filled: 0, missing: 3, null: 0, zero: 0 } },
      items: [{ stableKey: BUILD, value: null, percentText: null, color: '#2563eb' }, { stableKey: UNCATEGORIZED, value: null, percentText: null, color: UNCATEGORIZED_COLOR }],
    });

    const unfilled: GenericCoverageDto = { tasks: 1, filled: 0, missing: 1, null: 0, zero: 0 };
    const spelledZero = workTypeDistribution(report([{ key: BUILD, tasks: 1, value: num('0'), coverage: unfilled }], num('0')), METRIC, CATEGORY);
    expect(spelledZero.state).toBe('unknown');
    expect(spelledZero.total?.value).toBeNull();
    expect(spelledZero.items[0]?.value).toBeNull();

    const zero = workTypeDistribution(report([{ key: BUILD, tasks: 1, value: num('0') }, { key: UNCATEGORIZED, tasks: 2, value: num('0') }], num('0')), METRIC, CATEGORY);
    expect(zero).toStrictEqual({
      state: 'zero',
      total: { value: num('0'), unit: 'minutes', coverage: { tasks: 3, filled: 3, missing: 0, null: 0, zero: 3 } },
      items: [{ stableKey: BUILD, value: num('0'), percentText: null, color: '#2563eb' }, { stableKey: UNCATEGORIZED, value: num('0'), percentText: null, color: UNCATEGORIZED_COLOR }],
    });
  });

  it('refuses a pie for any negative value', () => {
    const negativeCategory = workTypeDistribution(report([{ key: BUILD, tasks: 1, value: num('-30') }, { key: UNCATEGORIZED, tasks: 1, value: num('90') }], num('60')), METRIC, CATEGORY);
    expect(negativeCategory.state).toBe('negative');
    expect(negativeCategory.items).toStrictEqual([
      { stableKey: BUILD, value: num('-30'), percentText: null, color: '#2563eb' },
      { stableKey: UNCATEGORIZED, value: num('90'), percentText: null, color: UNCATEGORIZED_COLOR },
    ]);
    expect(workTypeDistribution(report([{ key: BUILD, tasks: 1, value: num('-5') }], num('-5')), METRIC, CATEGORY).state).toBe('negative');
  });

  it('flags category sums that differ from the full-scope total, even past Number precision', () => {
    const input = report([{ key: BUILD, tasks: 1, value: num('9007199254740992') }, { key: REVIEW, tasks: 1, value: num('0') }], num('9007199254740993'));
    expect(Number('9007199254740992') + 0).toBe(Number('9007199254740993'));
    const result = workTypeDistribution(input, METRIC, CATEGORY);
    expect(result.state).toBe('inconsistent');
    expect(result.items.map(item => item.percentText)).toStrictEqual([null, null]);
    expect(result.items.some(item => 'startBps' in item || 'endBps' in item)).toBe(false);
  });

  it('flags groups that do not partition the full scope', () => {
    const base = simple();
    expect(workTypeDistribution(variant(base, draft => { actual(draft.measures).value = null; }), METRIC, CATEGORY).state).toBe('inconsistent');
    expect(workTypeDistribution(variant(base, draft => { draft.totalTasks += 1; }), METRIC, CATEGORY).state).toBe('inconsistent');
    expect(workTypeDistribution(variant(base, draft => { actual(group(draft, BUILD).measures).coverage.null += 1; }), METRIC, CATEGORY).state).toBe('inconsistent');
    expect(workTypeDistribution(variant(base, draft => { actual(group(draft, BUILD).measures).unit = 'number'; }), METRIC, CATEGORY)).toMatchObject({ state: 'inconsistent', items: [] });

    const missing = workTypeDistribution(variant(base, draft => { const target = group(draft, BUILD); target.measures = target.measures.filter(measure => measure.key !== 'actual'); }), METRIC, CATEGORY);
    expect(missing).toMatchObject({ state: 'inconsistent', total: { value: num('120') }, items: [] });

    const duplicated = workTypeDistribution(report([{ key: BUILD, tasks: 1, value: num('60') }, { key: BUILD, tasks: 1, value: num('60') }], num('120')), METRIC, CATEGORY);
    expect(duplicated.state).toBe('inconsistent');
    expect(duplicated.items).toHaveLength(2);
  });

  it.each<[string, (draft: GenericReportResultDto) => void]>([
    ['grouped by assignee', draft => { draft.config.groupBy = { kind: 'assignee' }; }],
    ['grouped by another category field', draft => { draft.config.groupBy = { kind: 'category', fieldId: OTHER_CATEGORY }; }],
    ['not filtered to one person', draft => { draft.config.filters.assignee = { kind: 'all' }; }],
    ['metric configured as AVG', draft => { draft.config.measures = [{ key: 'actual', operation: 'avg', fieldId: METRIC }]; }],
    ['result measure under another key', draft => { actual(draft.measures).key = 'renamed'; }],
    ['result measure is not a SUM', draft => { actual(draft.measures).operation = 'max'; }],
    ['result measure counts values', draft => { actual(draft.measures).unit = 'values'; }],
  ])('rejects a result %s', (_, edit) => {
    expect(workTypeDistribution(variant(simple(), edit), METRIC, CATEGORY)).toStrictEqual({ state: 'inconsistent', total: null, items: [] });
  });

  it('requires the requested category and metric to match the configuration by ID', () => {
    const base = simple();
    expect(workTypeDistribution(base, METRIC, OTHER_CATEGORY)).toStrictEqual({ state: 'inconsistent', total: null, items: [] });
    expect(workTypeDistribution(base, id(0x99), CATEGORY)).toStrictEqual({ state: 'inconsistent', total: null, items: [] });
    expect(workTypeDistribution(base, METRIC.toUpperCase(), CATEGORY.toUpperCase()).state).toBe('ready');
  });

  it('derives everything from groups, independent of loaded rows and page offset', () => {
    const base = simple();
    /** Deliberately contradicts the groups; the row schema's leaf types live outside the provided sources. */
    const pageRow = { taskId: id(0x51), homeProjectId: PROJECT, title: 'Loaded row', taskRevision: 1, parentTaskId: null, primaryAssigneeId: PERSON, statusGroup: 'done', dueDate: null, groupKey: REVIEW, groupLabel: 'Same label', placement: 'home', values: [{ fieldId: METRIC, state: 'value', value: 999999, valueRevision: 1, definitionVersionId: null }], initialValues: null, cohort: 'current', comparison: null, initialComparison: null } as unknown as GenericReportRowDto;
    const paged = variant(base, draft => { draft.rows = [pageRow]; draft.offset = 100; draft.nextOffset = 200; });
    expect(workTypeDistribution(paged, METRIC, CATEGORY)).toStrictEqual(workTypeDistribution(base, METRIC, CATEGORY));
  });

  it('colors follow persisted option IDs, not labels, position or shared colors', () => {
    const specs: Spec[] = [{ key: BUILD, tasks: 1, value: num('10') }, { key: REVIEW, tasks: 1, value: num('20') }, { key: SUPPORT, tasks: 1, value: num('30') }, { key: UNCATEGORIZED, tasks: 1, value: num('40') }];
    const colors = (result: GenericReportResultDto) => Object.fromEntries(workTypeDistribution(result, METRIC, CATEGORY).items.map(item => [item.stableKey, item.color]));
    const expected = { [BUILD]: '#2563eb', [REVIEW]: '#2563eb', [SUPPORT]: UNCATEGORIZED_COLOR, [UNCATEGORIZED]: UNCATEGORIZED_COLOR };
    expect(colors(report(specs, num('100')))).toStrictEqual(expected);
    expect(colors(report([...specs].reverse(), num('100')))).toStrictEqual(expected);
    const foreign = variant(report(specs, num('100')), draft => { draft.fields.forEach(field => { field.projectId = OTHER_PROJECT; }); });
    expect(new Set(Object.values(colors(foreign)))).toStrictEqual(new Set([UNCATEGORIZED_COLOR]));
  });

  it('does not mutate or alias the authoritative result', () => {
    const input = deepFreeze(report([{ key: BUILD, tasks: 1, value: num('1', '3', '0.333333333333') }, { key: UNCATEGORIZED, tasks: 1, value: num('2', '3', '0.666666666667') }], num('1')));
    const before = structuredClone(input);
    const result = workTypeDistribution(input, METRIC, CATEGORY);
    expect(input).toStrictEqual(before);
    expect(result.items[0]?.value).not.toBe(actual(group(input, BUILD).measures).value);
    expect(result.total?.value).not.toBe(actual(input.measures).value);
    expect(result.total?.coverage).not.toBe(actual(input.measures).coverage);
  });
});

describe('sortablePersonRows', () => {
  const person = (key: string, label: string, fact: GenericReportNumberDto | null): PersonMetricsRow => ({ key, label, taskCount: 1, plan: null, fact, capacityMinutes: null, comparison: null });

  it('sorts by locale name, then stable key', () => {
    const rows = [person(id(0x23), 'Zoë', null), person(id(0x22), 'Émile', null), person(id(0x21), 'adam', null), person(id(0x25), 'Sam', null), person(id(0x24), 'Sam', null)];
    expect(sortablePersonRows(rows, 'name').map(row => row.key)).toStrictEqual([id(0x21), id(0x22), id(0x24), id(0x25), id(0x23)]);
    const nordic = [person(id(0x26), 'Örjan', null), person(id(0x27), 'Zack', null)];
    expect(sortablePersonRows(nordic, 'name', 'en').map(row => row.label)).toStrictEqual(['Örjan', 'Zack']);
    expect(sortablePersonRows(nordic, 'name', 'sv').map(row => row.label)).toStrictEqual(['Zack', 'Örjan']);
  });

  it('sorts actual exactly descending with unknown last and zero distinct from unknown', () => {
    const rows = [
      person(id(0x31), 'Ann', null),
      person(id(0x32), 'Bo', num('0')),
      person(id(0x33), 'Cy', num('9007199254740992')),
      person(id(0x34), 'Di', num('9007199254740993')),
      person(id(0x35), 'Ed', num('1', '3', '0.333333333333')),
      person(id(0x36), 'Fa', num('333333333333333333', '1000000000000000000', '0.333333333333')),
      person(id(0x37), 'Gu', num('-1')),
      person(id(0x38), 'Hal', num('2', '4', '0.5')),
      person(id(0x30), 'Hal', num('1', '2', '0.5')),
      person(id(0x39), 'Abe', num('1', '2', '0.5')),
      person(id(0x40), 'Al', null),
    ];
    expect(Number('9007199254740992')).toBe(Number('9007199254740993'));
    expect(sortablePersonRows(rows, 'actual').map(row => row.key)).toStrictEqual([
      id(0x34), id(0x33), id(0x39), id(0x30), id(0x38), id(0x35), id(0x36), id(0x32), id(0x37), id(0x40), id(0x31),
    ]);
  });

  it('returns a new array without reordering the input', () => {
    const rows = Object.freeze([person(id(0x42), 'B', num('1')), person(id(0x41), 'A', num('2'))]);
    const sorted = sortablePersonRows(rows, 'actual');
    expect(sorted).not.toBe(rows);
    expect(sorted.map(row => row.key)).toStrictEqual([id(0x41), id(0x42)]);
    expect(rows.map(row => row.key)).toStrictEqual([id(0x42), id(0x41)]);
  });
});

it('keeps an explicit Unassigned category scope separate from Everyone',()=>{const value=simple();value.config.filters.assignee={kind:'unassigned'};expect(workTypeDistribution(value,METRIC,CATEGORY).state).toBe('ready');});
