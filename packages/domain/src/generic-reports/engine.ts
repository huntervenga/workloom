import type {
  GenericComparisonDto, GenericCoverageDto, GenericMeasureResultDto, GenericReportCellDto,
  GenericReportConfig, GenericReportNumberDto, GenericReportResultDto, GenericReportRowDto,
  TaskFieldDefinitionDto, TaskFieldValueDto,
} from '@workloom/contracts';
import { DomainError } from '../errors.js';
import type { GenericReportSource, GenericSourceTask, StoredGenericInitial } from './ports.js';

type Rational = { n: bigint; d: bigint };
const MAX_SCOPE = 5000;
const normalizeId = (id: string) => id.toLowerCase();
const sameId = (left: string, right: string) => normalizeId(left) === normalizeId(right);
const valueKey = (taskId: string, fieldId: string) => `${normalizeId(taskId)}:${normalizeId(fieldId)}`;
function invalid(message: string): never { throw new DomainError('DOMAIN_VALIDATION_FAILED', message); }
function gcd(a: bigint, b: bigint): bigint {
  a = a < 0n ? -a : a;
  b = b < 0n ? -b : b;
  while (b !== 0n) [a, b] = [b, a % b];
  return a || 1n;
}
function rational(n: bigint, d = 1n): Rational {
  if (d === 0n) invalid('A report number has an invalid denominator.');
  const divisor = gcd(n, d), sign = d < 0n ? -1n : 1n;
  return { n: sign * n / divisor, d: sign * d / divisor };
}
function decimal(value: number): Rational {
  if (!Number.isFinite(value)) invalid('A report value must be finite.');
  const [base = '0', exponent = '0'] = value.toString().toLowerCase().split('e');
  const [whole = '0', fraction = ''] = base.split('.');
  const power = Number(exponent) - fraction.length, numerator = BigInt(whole + fraction);
  return power >= 0 ? rational(numerator * 10n ** BigInt(power)) : rational(numerator, 10n ** BigInt(-power));
}
const add = (a: Rational, b: Rational) => rational(a.n * b.d + b.n * a.d, a.d * b.d);
const sum = (numbers: readonly number[]) => numbers.reduce((total, number) => add(total, decimal(number)), rational(0n));
function output(value: Rational): GenericReportNumberDto {
  const normalized = rational(value.n, value.d), absolute = normalized.n < 0n ? -normalized.n : normalized.n;
  const scale = 1_000_000_000_000n;
  // Half away from zero at 12 decimal places; the rational remains authoritative.
  const rounded = (absolute * scale * 2n + normalized.d) / (2n * normalized.d);
  const digits = rounded.toString().padStart(13, '0'), fraction = digits.slice(-12).replace(/0+$/, '');
  return {
    numerator: normalized.n.toString(), denominator: normalized.d.toString(),
    decimal: (rounded === 0n || normalized.n >= 0n ? '' : '-') + digits.slice(0, -12) + (fraction ? `.${fraction}` : ''),
  };
}
function coverage(cells: readonly GenericReportCellDto[]): GenericCoverageDto {
  return {
    tasks: cells.length, filled: cells.filter(c => c.state === 'value').length,
    missing: cells.filter(c => c.state === 'missing' || c.state === 'not_in_snapshot').length,
    null: cells.filter(c => c.state === 'null').length,
    zero: cells.filter(c => c.state === 'value' && c.value === 0).length,
  };
}
function knownValue(cell: GenericReportCellDto): number | null {
  if (cell.state !== 'value') return null;
  if (typeof cell.value !== 'number' || !Number.isFinite(cell.value)) invalid('A recorded report number is invalid.');
  return cell.value;
}
function numbers(cells: readonly GenericReportCellDto[]): number[] {
  return cells.flatMap(c => { const number = knownValue(c); return number === null ? [] : [number]; });
}
function cell(row: GenericReportRowDto, fieldId: string, initial = false): GenericReportCellDto {
  return (initial ? row.initialValues : row.values)?.find(c => sameId(c.fieldId, fieldId)) ?? {
    fieldId, state: initial ? 'not_in_snapshot' : 'missing', value: null, valueRevision: null, definitionVersionId: null,
  };
}
/** Initial comparison uses original PLAN/current FACT, current eligibility and current grouping.
 * Added rows are excluded entirely. Original attribution remains untouched in stored snapshot rows. */
export function comparison(rows: readonly GenericReportRowDto[], config: GenericReportConfig, initial = false): GenericComparisonDto | null {
  const selected = config.comparison;
  if (!selected) return null;
  const eligible = rows.filter(row => (!initial || row.cohort === 'retained') && (selected.completion !== 'done_only' || row.statusGroup === 'done'));
  const plans = eligible.map(row => cell(row, selected.planFieldId, initial));
  const facts = eligible.map(row => cell(row, selected.factFieldId));
  const planCoverage = coverage(plans), factCoverage = coverage(facts);
  const pairedPlans: number[] = [], pairedFacts: number[] = [];
  for (let index = 0; index < eligible.length; index += 1) {
    const planCell = plans[index], factCell = facts[index];
    if (!planCell || !factCell) continue;
    const plan = knownValue(planCell), fact = knownValue(factCell);
    if (plan !== null && fact !== null) { pairedPlans.push(plan); pairedFacts.push(fact); }
  }
  const pairedTasks = pairedPlans.length, plan = sum(pairedPlans), fact = sum(pairedFacts);
  const unavailableReason = eligible.length === 0 ? 'no_tasks' : pairedTasks === 0
    ? planCoverage.filled < eligible.length ? 'missing_plan' : 'missing_fact'
    : plan.n === 0n ? 'zero_plan' : null;
  return {
    eligibleTasks: eligible.length, pairedTasks,
    plan: pairedTasks > 0 ? output(plan) : null, fact: pairedTasks > 0 ? output(fact) : null,
    difference: pairedTasks > 0 ? output(add(fact, { n: -plan.n, d: plan.d })) : null,
    ratio: pairedTasks > 0 && plan.n > 0n ? output(rational(fact.n * plan.d, fact.d * plan.n)) : null,
    unavailableReason, planCoverage, factCoverage,
  };
}
function measures(rows: readonly GenericReportRowDto[], config: GenericReportConfig, fields: readonly TaskFieldDefinitionDto[]): GenericMeasureResultDto[] {
  return config.measures.map(measure => {
    if (measure.operation === 'count_tasks') return {
      key: measure.key, operation: measure.operation, fieldId: null, unit: 'tasks', value: output(rational(BigInt(rows.length))),
      coverage: { tasks: rows.length, filled: rows.length, missing: 0, null: 0, zero: 0 },
    };
    const cells = rows.map(row => cell(row, measure.fieldId)), known = numbers(cells), total = sum(known);
    return {
      key: measure.key, operation: measure.operation, fieldId: measure.fieldId,
      unit: measure.operation === 'count_values' ? 'values' : fields.find(f => sameId(f.id, measure.fieldId))?.type === 'duration' ? 'minutes' : 'number',
      value: measure.operation === 'count_values' ? output(rational(BigInt(known.length))) : known.length === 0 ? null
        : output(measure.operation === 'avg' ? rational(total.n, total.d * BigInt(known.length)) : total),
      coverage: coverage(cells),
    };
  });
}
export function usedFieldIds(config: GenericReportConfig): string[] {
  return [...new Set([
    ...config.measures.flatMap(m => m.operation === 'count_tasks' ? [] : [m.fieldId]),
    ...(config.comparison ? [config.comparison.planFieldId, config.comparison.factFieldId] : []),
    ...(config.groupBy.kind === 'category' ? [config.groupBy.fieldId] : []),
    ...(config.filters.dateRange?.source.kind === 'field' ? [config.filters.dateRange.source.fieldId] : []),
  ].map(normalizeId))].sort();
}
export function validateGenericConfig(config: GenericReportConfig, fields: readonly TaskFieldDefinitionDto[]): void {
  const required = new Map<string, readonly string[]>();
  const requireType = (id: string, types: readonly string[]) => {
    const key = normalizeId(id), old = required.get(key);
    required.set(key, old ? types.filter(type => old.includes(type)) : types);
  };
  for (const measure of config.measures) if (measure.operation !== 'count_tasks') requireType(measure.fieldId, ['number', 'duration']);
  if (config.comparison) for (const id of [config.comparison.planFieldId, config.comparison.factFieldId]) requireType(id, ['duration']);
  if (config.groupBy.kind === 'category') requireType(config.groupBy.fieldId, ['single_select']);
  if (config.filters.dateRange?.source.kind === 'field') requireType(config.filters.dateRange.source.fieldId, ['date']);
  for (const [id, types] of required) {
    const field = fields.find(item => sameId(item.id, id));
    if (!field || !sameId(field.projectId, config.projectId) || field.archivedAt !== null || !types.includes(field.type)) {
      throw new DomainError('DOMAIN_VALIDATION_FAILED', 'A configured field is unavailable, archived, or has an incompatible type.', { details: { fieldId: id } });
    }
  }
}
function cloneField(field: TaskFieldDefinitionDto): TaskFieldDefinitionDto { return { ...field, options: field.options.map(option => ({ ...option })) }; }
function cloneConfig(config: GenericReportConfig): GenericReportConfig {
  return {
    ...config, measures: config.measures.map(measure => ({ ...measure })), comparison: config.comparison ? { ...config.comparison } : null,
    groupBy: { ...config.groupBy }, filters: { ...config.filters, statusGroups: [...config.filters.statusGroups], tagIds: [...config.filters.tagIds],
      assignee: { ...config.filters.assignee }, dateRange: config.filters.dateRange ? { ...config.filters.dateRange, source: { ...config.filters.dateRange.source } } : null },
  };
}
export function calculateGenericReport(source: GenericReportSource, config: GenericReportConfig, sourceVersion: string, initial: StoredGenericInitial | null, offset = 0, limit = 100): GenericReportResultDto {
  validateGenericConfig(config, source.fields);
  if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > MAX_SCOPE) invalid('The report page is invalid.');
  const selected = new Set(usedFieldIds(config)), fields = source.fields.filter(field => selected.has(normalizeId(field.id)));
  const numeric = fields.filter(field => field.type === 'number' || field.type === 'duration');
  const byValue = new Map(source.values.map(value => [valueKey(value.taskId, value.fieldId), value]));
  const originals = new Map(initial?.rows.map(row => [normalizeId(row.taskId), row]) ?? []);
  const readValue = (task: GenericSourceTask, fieldId: string): TaskFieldValueDto | undefined => {
    // Custom fields are home-project scoped. A linked row never exposes another project's values.
    if (!sameId(task.projectId, config.projectId)) return undefined;
    const value = byValue.get(valueKey(task.id, fieldId));
    return value && sameId(value.projectId, config.projectId) ? value : undefined;
  };
  const readDate = (task: GenericSourceTask): string | null => {
    const range = config.filters.dateRange;
    if (!range) return null;
    if (range.source.kind === 'due_date') return task.dueDate;
    const value = readValue(task, range.source.fieldId);
    return value?.value.type === 'date' ? value.value.value : null;
  };
  const seen = new Set<string>(), rows: GenericReportRowDto[] = [];
  for (const task of source.tasks) {
    const taskId = normalizeId(task.id);
    if (seen.has(taskId)) continue;
    seen.add(taskId);
    if (config.hierarchy === 'root_tasks' && task.parentTaskId !== null) continue;
    if (config.filters.statusGroups.length > 0 && !config.filters.statusGroups.includes(task.statusGroup)) continue;
    if (config.filters.tagIds.some(tagId => !task.tagIds.some(id => sameId(id, tagId)))) continue;
    const assignee = config.filters.assignee;
    if (assignee.kind === 'unassigned' && task.responsibleMembershipId !== null) continue;
    if (assignee.kind === 'member' && (task.responsibleMembershipId === null || !sameId(task.responsibleMembershipId, assignee.membershipId))) continue;
    const range = config.filters.dateRange;
    if (range) { const date = readDate(task); if (date === null || date < range.from || date > range.to) continue; }
    let groupKey = 'all', groupLabel = 'All tasks';
    if (config.groupBy.kind === 'assignee') {
      groupKey = task.responsibleMembershipId ?? 'unassigned';
      groupLabel = task.responsibleMembershipId ? source.memberLabels[task.responsibleMembershipId] ?? 'Former member' : 'Unassigned';
    } else if (config.groupBy.kind === 'status') { groupKey = task.statusGroup; groupLabel = task.statusGroup; }
    else if (config.groupBy.kind === 'section') {
      groupKey = task.sectionId ?? 'no_section'; groupLabel = task.sectionId ? source.sectionLabels[task.sectionId] ?? 'Archived section' : 'No section';
    } else if (config.groupBy.kind === 'category') {
      const value = readValue(task, config.groupBy.fieldId), optionId = value?.value.type === 'single_select' ? value.value.value : null;
      const field = fields.find(item => sameId(item.id, config.groupBy.kind === 'category' ? config.groupBy.fieldId : ''));
      groupKey = optionId ?? 'uncategorized'; groupLabel = optionId ? field?.options.find(option => sameId(option.id, optionId))?.name ?? 'Unavailable category' : 'Uncategorized';
    }
    const current: GenericReportCellDto[] = numeric.map(field => {
      const value = readValue(task, field.id), raw = value?.value.value;
      if (value && (value.value.type !== field.type || (raw !== null && (typeof raw !== 'number' || !Number.isFinite(raw))))) invalid('A report field value has an incompatible type.');
      if (field.type === 'duration' && typeof raw === 'number' && (!Number.isSafeInteger(raw) || raw < 0)) invalid('A duration report value must be whole minutes.');
      return { fieldId: field.id, state: !value ? 'missing' : raw === null ? 'null' : 'value', value: typeof raw === 'number' ? raw : null, valueRevision: value?.revision ?? null, definitionVersionId: value?.definitionVersionId ?? null };
    });
    const original = originals.get(taskId);
    const row: GenericReportRowDto = {
      taskId: task.id, homeProjectId: task.projectId, title: task.title, taskRevision: task.revision, parentTaskId: task.parentTaskId,
      primaryAssigneeId: task.responsibleMembershipId, statusGroup: task.statusGroup, dueDate: task.dueDate, groupKey, groupLabel,
      placement: sameId(task.projectId, config.projectId) ? 'home' : 'linked', values: current,
      initialValues: initial ? original ? original.values.map(value => ({ ...value })) : numeric.map(field => ({ fieldId: field.id, state: 'not_in_snapshot' as const, value: null, valueRevision: null, definitionVersionId: null })) : null,
      cohort: !initial ? 'current' : original ? 'retained' : 'added', comparison: null, initialComparison: null,
    };
    row.comparison = comparison([row], config); row.initialComparison = initial ? comparison([row], config, true) : null;
    rows.push(row);
    if (rows.length > MAX_SCOPE) invalid('The complete report scope exceeds 5000 tasks.');
  }
  rows.sort((left, right) => left.taskId.localeCompare(right.taskId));
  const grouped = new Map<string, GenericReportRowDto[]>();
  for (const row of rows) { const group = grouped.get(row.groupKey) ?? []; group.push(row); grouped.set(row.groupKey, group); }
  const groups = [...grouped.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([key, group]) => ({
    key, label: group[0]?.groupLabel ?? key, taskCount: group.length, measures: measures(group, config, fields), comparison: comparison(group, config), initialComparison: initial ? comparison(group, config, true) : null,
  }));
  const retained = rows.filter(row => originals.has(normalizeId(row.taskId))).length;
  return {
    ...(source.capacity?{capacity:source.capacity}:{}),...(initial?.header.capacity?{initialCapacity:initial.header.capacity}:{}),
    reportId: null, definitionRevision: null, sourceVersion, config: cloneConfig(config), scope: 'project_presence_canonical_tasks', hierarchy: config.hierarchy,
    attribution: 'primary_assignee', fields: fields.map(cloneField), totalTasks: rows.length, measures: measures(rows, config, fields), comparison: comparison(rows, config),
    initialComparison: initial ? comparison(rows, config, true) : null,
    initialMeasures: initial ? measures(initial.rows, initial.header.config, initial.header.fields) : null,
    groups, rows: rows.slice(offset, offset + limit), offset, nextOffset: offset + limit < rows.length ? offset + limit : null,
    initialSnapshot: initial ? { ...initial.header, config: cloneConfig(initial.header.config), fields: initial.header.fields.map(cloneField) } : null,
    cohorts: initial ? { initial: originals.size, retained, added: rows.length - retained, removed: originals.size - retained } : null,
  };
}
