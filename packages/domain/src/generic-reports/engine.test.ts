import { describe, expect, it } from 'vitest';
import { taskFieldValueSchema } from '@workloom/contracts';
import type { GenericMeasureResultDto, GenericReportConfig, GenericReportResultDto, TaskFieldDefinitionDto, TaskFieldValueDto } from '@workloom/contracts';
import { calculateGenericReport, usedFieldIds, validateGenericConfig } from './engine.js';
import type { GenericReportSource, GenericSourceTask, StoredGenericInitial } from './ports.js';

const id = (number: number) => `00000000-0000-4000-8000-${number.toString(16).padStart(12, '0')}`;
const workspaceId = id(1), projectId = id(2), otherProject = id(3), personA = id(4), personB = id(5);
const timestamp = '2026-10-18T00:00:00.000Z', sourceVersion = 'a'.repeat(64);
function field(number: number, type: TaskFieldDefinitionDto['type'], changes: Partial<TaskFieldDefinitionDto> = {}): TaskFieldDefinitionDto {
  return { id: id(number), workspaceId, projectId, name: `Field ${number}`, type, revision: 1,
    definitionVersionId: id(number + 1000), historyEnabled: true, locked: false, archivedAt: null,
    options: [], createdAt: timestamp, updatedAt: timestamp, ...changes };
}
const plan = field(10, 'duration'), fact = field(11, 'duration'), numeric = field(12, 'number');
const category = field(13, 'single_select', { options: [{ id: id(30), name: 'Development', color: null, position: 1, revision: 1, archivedAt: null }] });
const date = field(14, 'date');
const allFields = [plan, fact, numeric, category, date];
function task(number: number, changes: Partial<GenericSourceTask> = {}): GenericSourceTask {
  return { id: id(number), projectId, title: `Task ${number}`, revision: 1, parentTaskId: null, sectionId: null,
    responsibleMembershipId: personA, dueDate: null, statusGroup: 'done', tagIds: [], ...changes };
}
function value(target: GenericSourceTask, definition: TaskFieldDefinitionDto, raw: number | string | null, revision = 1): TaskFieldValueDto {
  return taskFieldValueSchema.parse({ workspaceId, projectId: definition.projectId, taskId: target.id, fieldId: definition.id,
    definitionVersionId: definition.definitionVersionId, revision, value: { type: definition.type, value: raw }, updatedAt: timestamp });
}
function config(changes: Partial<GenericReportConfig> = {}): GenericReportConfig {
  return { projectId, hierarchy: 'all_tasks', measures: [
    { key: 'p', operation: 'sum', fieldId: plan.id }, { key: 'f', operation: 'sum', fieldId: fact.id },
    { key: 'tasks', operation: 'count_tasks' },
  ], comparison: { planFieldId: plan.id, factFieldId: fact.id, completion: 'done_only' }, groupBy: { kind: 'none' },
  filters: { statusGroups: [], tagIds: [], assignee: { kind: 'all' }, dateRange: null }, ...changes };
}
function source(tasks: GenericSourceTask[], values: TaskFieldValueDto[] = [], fields = allFields): GenericReportSource {
  return { head: '1:0', tasks, values, fields, memberLabels: { [personA]: 'Alice', [personB]: 'Bob' }, sectionLabels: { [id(40)]: 'Delivery' } };
}
function report(input: GenericReportSource, selected = config(), initial: StoredGenericInitial | null = null, offset = 0, limit = 100) {
  return calculateGenericReport(input, selected, sourceVersion, initial, offset, limit);
}
function measure(result: GenericReportResultDto, key: string): GenericMeasureResultDto {
  const found = result.measures.find(item => item.key === key);
  if (!found) throw new Error(`Missing measure ${key}`);
  return found;
}
function row(result: GenericReportResultDto, taskId: string) {
  const found = result.rows.find(item => item.taskId === taskId);
  if (!found) throw new Error('Expected report row');
  return found;
}
function snapshot(input: GenericReportSource, selected = config()): StoredGenericInitial {
  const captured = report(input, selected, null, 0, 5000);
  return { header: { id: id(80), workspaceId, reportId: id(81), projectId, name: 'Original', definitionRevision: 1,
    config: captured.config, fields: captured.fields, capturedAt: timestamp, capturedByUserId: id(82), sourceVersion,
    taskCount: captured.totalTasks }, rows: captured.rows, values: input.values.map(item => ({ ...item })) };
}
const exact = (numerator: string, denominator = '1', decimal = numerator) => ({ numerator, denominator, decimal });

describe('generic report exact arithmetic and coverage', () => {
  it('uses field IDs rather than Budget/Spent names and needs no native period', () => {
    const a = task(100), fields = [field(10, 'duration', { name: 'A' }), field(11, 'duration', { name: 'B' })];
    const result = report(source([a], [value(a, fields[0] ?? plan, 120), value(a, fields[1] ?? fact, 200)], fields));
    expect(measure(result, 'p').value).toEqual(exact('120'));
    expect(result.comparison?.difference).toEqual(exact('80'));
    expect(result.fields.map(item => item.name)).toEqual(['A', 'B']);
  });
  it('sums decimal source numbers exactly and averages the same known set', () => {
    const a = task(100), b = task(101), selected = config({ comparison: null, measures: [
      { key: 'sum', operation: 'sum', fieldId: numeric.id }, { key: 'avg', operation: 'avg', fieldId: numeric.id },
    ] });
    const result = report(source([a, b], [value(a, numeric, 0.1), value(b, numeric, 0.2)]), selected);
    expect(measure(result, 'sum').value).toEqual(exact('3', '10', '0.3'));
    expect(measure(result, 'avg').value).toEqual(exact('3', '20', '0.15'));
  });
  it('handles negative and exponent-form decimals without binary accumulation', () => {
    const a = task(100), b = task(101), c = task(102), selected = config({ comparison: null, measures: [{ key: 'n', operation: 'sum', fieldId: numeric.id }] });
    const result = report(source([a, b, c], [value(a, numeric, -0.1), value(b, numeric, -0.2), value(c, numeric, 1e-7)]), selected);
    expect(measure(result, 'n').value).toEqual(exact('-2999999', '10000000', '-0.2999999'));
  });
  it('keeps repeating average exact while rounding presentation to twelve places', () => {
    const tasks = [task(100), task(101), task(102)], selected = config({ comparison: null, measures: [{ key: 'avg', operation: 'avg', fieldId: numeric.id }] });
    const result = report(source(tasks, tasks.map((item, index) => value(item, numeric, index === 0 ? 1 : 0))), selected);
    expect(measure(result, 'avg').value).toEqual(exact('1', '3', '0.333333333333'));
  });
  it('retains tiny exact values even when displayed decimal rounds to zero', () => {
    const a = task(100), selected = config({ comparison: null, measures: [{ key: 'sum', operation: 'sum', fieldId: numeric.id }] });
    expect(measure(report(source([a], [value(a, numeric, 1e-13)]), selected), 'sum').value).toEqual(exact('1', '10000000000000', '0'));
  });
  it('distinguishes absent row, explicit null and known zero in every numeric measure', () => {
    const tasks = [task(100), task(101), task(102), task(103)], selected = config({ comparison: null, measures: [
      { key: 'sum', operation: 'sum', fieldId: numeric.id }, { key: 'avg', operation: 'avg', fieldId: numeric.id },
      { key: 'count', operation: 'count_values', fieldId: numeric.id }, { key: 'tasks', operation: 'count_tasks' },
    ] });
    const a = tasks[0], b = tasks[1], d = tasks[3];
    if (!a || !b || !d) throw new Error('Fixture tasks missing');
    const result = report(source(tasks, [value(a, numeric, 0), value(b, numeric, null), value(d, numeric, 10)]), selected);
    expect(measure(result, 'sum').value).toEqual(exact('10'));
    expect(measure(result, 'avg').value).toEqual(exact('5'));
    expect(measure(result, 'count').value).toEqual(exact('2'));
    expect(measure(result, 'tasks').value).toEqual(exact('4'));
    expect(measure(result, 'sum').coverage).toEqual({ tasks: 4, filled: 2, missing: 1, null: 1, zero: 1 });
    expect(row(result, a.id).values.find(item => item.fieldId === numeric.id)?.state).toBe('value');
    expect(row(result, b.id).values.find(item => item.fieldId === numeric.id)?.state).toBe('null');
  });
  it('does not turn all-missing numeric sums into known zero', () => {
    const a = task(100), selected = config({ comparison: null, measures: [
      { key: 'sum', operation: 'sum', fieldId: numeric.id }, { key: 'avg', operation: 'avg', fieldId: numeric.id },
      { key: 'count', operation: 'count_values', fieldId: numeric.id },
    ] });
    const result = report(source([a]), selected);
    expect(measure(result, 'sum').value).toBeNull(); expect(measure(result, 'avg').value).toBeNull();
    expect(measure(result, 'count').value).toEqual(exact('0'));
    expect(measure(result, 'sum').coverage).toEqual({ tasks: 1, filled: 0, missing: 1, null: 0, zero: 0 });
  });
  it('reports empty scope honestly with zero task count but no numeric knowledge', () => {
    const result = report(source([]));
    expect(measure(result, 'tasks').value).toEqual(exact('0')); expect(measure(result, 'p').value).toBeNull();
    expect(result.comparison).toMatchObject({ eligibleTasks: 0, pairedTasks: 0, plan: null, fact: null, ratio: null, unavailableReason: 'no_tasks' });
    expect(result.initialMeasures).toBeNull();
  });
});

describe('generic Plan/Fact comparison uses complete pairs', () => {
  it('compares 870 paired plan to1020 fact instead of the990 ordinary partial plan sum', () => {
    const a = task(100), b = task(101), c = task(102);
    const result = report(source([a, b, c], [value(a, plan, 600), value(a, fact, 720), value(b, plan, 270), value(b, fact, 300), value(c, plan, 120)]));
    expect(measure(result, 'p').value).toEqual(exact('990')); expect(measure(result, 'f').value).toEqual(exact('1020'));
    expect(result.comparison).toEqual({ eligibleTasks: 3, pairedTasks: 2, plan: exact('870'), fact: exact('1020'), difference: exact('150'),
      ratio: exact('34', '29', '1.172413793103'), unavailableReason: null,
      planCoverage: { tasks: 3, filled: 3, missing: 0, null: 0, zero: 0 }, factCoverage: { tasks: 3, filled: 2, missing: 1, null: 0, zero: 0 } });
  });
  it('excludes unfinished tasks only from done-only comparison, not ordinary measures or captured rows', () => {
    const a = task(100), b = task(101, { statusGroup: 'todo' });
    const input = source([a, b], [value(a, plan, 120), value(a, fact, 200), value(b, plan, 1000), value(b, fact, 3000)]);
    const result = report(input);
    expect(measure(result, 'p').value).toEqual(exact('1120')); expect(result.totalTasks).toBe(2);
    expect(result.comparison).toMatchObject({ eligibleTasks: 1, pairedTasks: 1, plan: exact('120'), fact: exact('200') });
    expect(snapshot(input).rows).toHaveLength(2);
    const all = report(input, config({ comparison: { planFieldId: plan.id, factFieldId: fact.id, completion: 'all_tasks' } }));
    expect(all.comparison?.fact).toEqual(exact('3200'));
  });
  it('keeps a zero-plan pair and valid delta but refuses a false ratio', () => {
    const a = task(100), result = report(source([a], [value(a, plan, 0), value(a, fact, 5)]));
    expect(result.comparison).toMatchObject({ pairedTasks: 1, plan: exact('0'), fact: exact('5'), difference: exact('5'), ratio: null, unavailableReason: 'zero_plan' });
  });
  it('keeps genuine zero fact as a known pair and a zero ratio', () => {
    const a = task(100), result = report(source([a], [value(a, plan, 10), value(a, fact, 0)]));
    expect(result.comparison).toMatchObject({ pairedTasks: 1, fact: exact('0'), difference: exact('-10'), ratio: exact('0'), unavailableReason: null });
    expect(result.comparison?.factCoverage.zero).toBe(1);
  });
  it('does not compare disjoint partial populations when no complete pair exists', () => {
    const a = task(100), b = task(101), result = report(source([a, b], [value(a, plan, 10), value(b, fact, 20)]));
    expect(result.comparison).toMatchObject({ eligibleTasks: 2, pairedTasks: 0, plan: null, fact: null, difference: null, ratio: null, unavailableReason: 'missing_plan' });
    expect(result.comparison?.planCoverage.filled).toBe(1); expect(result.comparison?.factCoverage.filled).toBe(1);
  });
  it('explains an absent fact when all eligible plans are known', () => {
    const a = task(100), result = report(source([a], [value(a, plan, 10), value(a, fact, null)]));
    expect(result.comparison).toMatchObject({ pairedTasks: 0, unavailableReason: 'missing_fact', plan: null, fact: null });
  });
});

describe('canonical scope, groups and filters', () => {
  it('deduplicates canonical task IDs across placement rows without package rollup', () => {
    const parent = task(100), child = task(101, { parentTaskId: parent.id });
    const input = source([parent, { ...parent }, child], [value(parent, plan, 10), value(child, plan, 20)]);
    const all = report(input); expect(all.totalTasks).toBe(2); expect(measure(all, 'p').value).toEqual(exact('30'));
    const roots = report(input, config({ hierarchy: 'root_tasks' })); expect(roots.totalTasks).toBe(1); expect(measure(roots, 'p').value).toEqual(exact('10'));
  });
  it('marks linked-home project custom values missing instead of exposing them', () => {
    const home = task(100), linked = task(101, { projectId: otherProject });
    const result = report(source([home, linked], [value(home, plan, 10), value(linked, plan, 999)]));
    expect(measure(result, 'p').value).toEqual(exact('10'));
    expect(row(result, linked.id)).toMatchObject({ placement: 'linked', values: expect.arrayContaining([{ fieldId: plan.id, state: 'missing', value: null, valueRevision: null, definitionVersionId: null }]) });
  });
  it('requires ALL selected tags and honors current status and assignee together', () => {
    const a = task(100, { tagIds: [id(50), id(51)] }), b = task(101, { tagIds: [id(50)] }), c = task(102, { tagIds: [id(50), id(51)], responsibleMembershipId: personB });
    const selected = config({ filters: { statusGroups: ['done'], tagIds: [id(50), id(51)], assignee: { kind: 'member', membershipId: personA }, dateRange: null } });
    const result = report(source([a, b, c], [value(a, plan, 10), value(b, plan, 20), value(c, plan, 30)]), selected);
    expect(result.rows.map(item => item.taskId)).toEqual([a.id]); expect(measure(result, 'p').value).toEqual(exact('10'));
  });
  it('groups each task once by primary assignee, including Unassigned', () => {
    const a = task(100), b = task(101, { responsibleMembershipId: null });
    const input = source([a, b], [value(a, plan, 10), value(b, plan, 20)]), result = report(input, config({ groupBy: { kind: 'assignee' } }));
    expect(result.groups.map(item => [item.label, item.taskCount])).toEqual([['Alice', 1], ['Unassigned', 1]]);
    const unassigned = report(input, config({ filters: { ...config().filters, assignee: { kind: 'unassigned' } } }));
    expect(unassigned.rows.map(item => item.taskId)).toEqual([b.id]);
  });
  it('uses inclusive due-date boundaries and excludes missing dates', () => {
    const tasks = [task(100, { dueDate: '2026-10-01' }), task(101, { dueDate: '2026-10-31' }), task(102, { dueDate: '2026-11-01' }), task(103)];
    const selected = config({ filters: { ...config().filters, dateRange: { source: { kind: 'due_date' }, from: '2026-10-01', to: '2026-10-31' } } });
    expect(report(source(tasks), selected).rows.map(item => item.taskId)).toEqual([id(100), id(101)]);
  });
  it('filters by the chosen custom date rather than invented fact or due dates', () => {
    const a = task(100, { dueDate: '2030-01-01' }), b = task(101, { dueDate: '2026-10-18' });
    const selected = config({ filters: { ...config().filters, dateRange: { source: { kind: 'field', fieldId: date.id }, from: '2026-10-18', to: '2026-10-18' } } });
    expect(report(source([a, b], [value(a, date, '2026-10-18'), value(b, date, null)]), selected).rows.map(item => item.taskId)).toEqual([a.id]);
  });
  it('keeps single-select categories exclusive with missing/null Uncategorized', () => {
    const a = task(100), b = task(101), c = task(102);
    const result = report(source([a, b, c], [value(a, category, id(30)), value(b, category, null), value(a, plan, 10), value(b, plan, 20), value(c, plan, 30)]), config({ groupBy: { kind: 'category', fieldId: category.id } }));
    expect(result.groups.map(item => [item.label, item.taskCount, item.measures.find(m => m.key === 'p')?.value])).toEqual([
      ['Development', 1, exact('10')], ['Uncategorized', 2, exact('50')],
    ]);
    expect(measure(result, 'p').value).toEqual(exact('60'));
  });
  it('uses explicit current section groups and the missing-section group', () => {
    const a = task(100, { sectionId: id(40) }), b = task(101);
    expect(report(source([a, b]), config({ groupBy: { kind: 'section' } })).groups.map(item => item.label)).toEqual(['Delivery', 'No section']);
  });
  it('keeps full-scope totals and groups invariant across detail pagination', () => {
    const tasks = [task(100), task(101), task(102), task(103), task(104)];
    const input = source(tasks, tasks.map((item, index) => value(item, plan, (index + 1) * 10))), selected = config({ groupBy: { kind: 'assignee' } });
    const first = report(input, selected, null, 0, 2), next = report(input, selected, null, 2, 2);
    expect(first.totalTasks).toBe(5); expect(next.rows.map(item => item.taskId)).toEqual([id(102), id(103)]);
    expect(first.nextOffset).toBe(2); expect(next.nextOffset).toBe(4);
    expect(first.measures).toEqual(next.measures); expect(first.groups).toEqual(next.groups);
    expect(measure(next, 'p').value).toEqual(exact('150'));
  });
});

describe('immutable initial values and scope', () => {
  it('compares original120 to current200 after todo becomes done, never snapshot missing fact or current600 plan', () => {
    const originalTask = task(100, { statusGroup: 'todo', responsibleMembershipId: personA });
    const initial = snapshot(source([originalTask], [value(originalTask, plan, 120)]), config({ groupBy: { kind: 'assignee' } }));
    const saved = JSON.stringify(initial), currentTask = { ...originalTask, statusGroup: 'done' as const, responsibleMembershipId: personB, revision: 2 };
    const result = report(source([currentTask], [value(currentTask, plan, 600, 2), value(currentTask, fact, 200)]), config({ groupBy: { kind: 'assignee' } }), initial);
    expect(result.comparison).toMatchObject({ plan: exact('600'), fact: exact('200'), difference: exact('-400') });
    expect(result.initialComparison).toMatchObject({ eligibleTasks: 1, pairedTasks: 1, plan: exact('120'), fact: exact('200'), difference: exact('80') });
    expect(result.groups[0]?.label).toBe('Bob'); expect(result.groups[0]?.initialComparison?.plan).toEqual(exact('120'));
    expect(initial.rows[0]?.primaryAssigneeId).toBe(personA); expect(initial.rows[0]?.statusGroup).toBe('todo');
    expect(row(result, currentTask.id).initialValues?.find(item => item.fieldId === fact.id)?.state).toBe('missing');
    expect(JSON.stringify(initial)).toBe(saved);
  });
  it('never fills an originally missing plan with a late current value', () => {
    const a = task(100, { statusGroup: 'todo' }), initial = snapshot(source([a]));
    const result = report(source([{ ...a, statusGroup: 'done' }], [value(a, plan, 120), value(a, fact, 200)]), config(), initial);
    expect(result.comparison?.plan).toEqual(exact('120'));
    expect(result.initialComparison).toMatchObject({ eligibleTasks: 1, pairedTasks: 0, plan: null, fact: null, unavailableReason: 'missing_plan' });
    expect(result.initialMeasures?.find(item => item.key === 'p')?.value).toBeNull();
  });
  it('excludes added tasks entirely from initial comparison eligibility and coverage', () => {
    const a = task(100), b = task(101), initial = snapshot(source([a], [value(a, plan, 120)]));
    const result = report(source([a, b], [value(a, plan, 600), value(a, fact, 200), value(b, plan, 1000), value(b, fact, 2000)]), config(), initial);
    expect(result.initialComparison).toMatchObject({ eligibleTasks: 1, pairedTasks: 1, plan: exact('120'), fact: exact('200') });
    expect(result.initialComparison?.planCoverage.tasks).toBe(1);
    expect(row(result, b.id).cohort).toBe('added'); expect(row(result, b.id).initialComparison?.unavailableReason).toBe('no_tasks');
    expect(row(result, b.id).initialValues?.every(item => item.state === 'not_in_snapshot')).toBe(true);
  });
  it('preserves all1080 original minutes after a task is removed, with full initial measures on every page', () => {
    const a = task(100), removed = task(101), added = task(102);
    const initial = snapshot(source([a, removed], [value(a, plan, 120), value(removed, plan, 960)]));
    const result = report(source([a, added], [value(a, plan, 600), value(a, fact, 200), value(added, plan, 10)]), config(), initial, 1, 1);
    expect(result.cohorts).toEqual({ initial: 2, retained: 1, added: 1, removed: 1 });
    expect(result.initialMeasures?.find(item => item.key === 'p')?.value).toEqual(exact('1080'));
    expect(result.initialMeasures?.find(item => item.key === 'tasks')?.value).toEqual(exact('2'));
    expect(result.initialComparison?.plan).toEqual(exact('120')); expect(measure(result, 'p').value).toEqual(exact('610'));
    expect(result.rows.map(item => item.taskId)).toEqual([added.id]);
  });
  it('retains explicit null and zero originals and does not return mutable stored-cell aliases', () => {
    const a = task(100), b = task(101), initial = snapshot(source([a, b], [value(a, plan, 0), value(b, plan, null)]));
    const result = report(source([a, b], [value(a, plan, 99), value(a, fact, 5), value(b, plan, 10)]), config(), initial);
    expect(result.initialMeasures?.find(item => item.key === 'p')?.coverage).toEqual({ tasks: 2, filled: 1, missing: 0, null: 1, zero: 1 });
    const copiedCell = row(result, a.id).initialValues?.find(item => item.fieldId === plan.id);
    if (!copiedCell) throw new Error('Expected original cell');
    copiedCell.value = 12345;
    expect(initial.rows[0]?.values.find(item => item.fieldId === plan.id)?.value).toBe(0);
  });
});

describe('configuration and bounds', () => {
  it('collects every referenced ID once in stable order', () => {
    const selected = config({ measures: [{ key: 'p', operation: 'sum', fieldId: plan.id }], groupBy: { kind: 'category', fieldId: category.id },
      filters: { ...config().filters, dateRange: { source: { kind: 'field', fieldId: date.id }, from: '2026-01-01', to: '2026-12-31' } } });
    expect(usedFieldIds(selected)).toEqual([plan.id, fact.id, category.id, date.id]);
  });
  it.each([
    ['foreign project', field(10, 'duration', { projectId: otherProject })],
    ['archived', field(10, 'duration', { archivedAt: timestamp })],
    ['incompatible type', field(10, 'number')],
  ] as const)('rejects %s selected comparison fields', (_, replacement) => {
    expect(() => validateGenericConfig(config(), [replacement, fact])).toThrow('configured field is unavailable');
  });
  it('rejects a field reused as both a numeric measure and a category', () => {
    const selected = config({ comparison: null, groupBy: { kind: 'category', fieldId: plan.id } });
    expect(() => validateGenericConfig(selected, allFields)).toThrow('configured field is unavailable');
  });
  it('rejects missing fields instead of rebinding a recreated same-name field', () => {
    const replacement = field(999, 'duration', { name: plan.name });
    expect(() => report(source([], [], [replacement, fact]))).toThrow('configured field is unavailable');
  });
  it('fails above the complete5000 task bound instead of silently truncating', () => {
    const tasks = Array.from({ length: 5001 }, (_, index) => task(index + 100));
    expect(() => report(source(tasks), config({ comparison: null, measures: [{ key: 'count', operation: 'count_tasks' }] }))).toThrow('exceeds 5000');
  });
  it('rejects invalid page sizes instead of fabricating a valid empty page', () => {
    expect(() => report(source([]), config(), null, 0, 0)).toThrow('report page is invalid');
  });
});
