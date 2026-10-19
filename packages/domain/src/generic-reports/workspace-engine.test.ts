import { describe, expect, it } from 'vitest';
import { Temporal } from 'temporal-polyfill';
import {
  leaveAvailabilitySchema, taskFieldDefinitionSchema, taskFieldValueSchema,
  workspaceReportBoundSourceSchema, workspaceReportQueryInputSchema, workspaceReportResultSchema,
} from '@workloom/contracts';
import type {
  LeaveAvailabilityDto, TaskFieldDefinitionDto, TaskFieldValueDto, WorkspaceReportBoundSourceDto, WorkspaceReportCategoryDto,
  WorkspaceReportPersonDto, WorkspaceReportQueryInput, WorkspaceReportResultDto,
} from '@workloom/contracts';
import { calculateWorkspaceReport } from './workspace-engine.js';
import type { WorkspaceResolvedSource } from './workspace-engine.js';
import type { GenericSourceTask } from './ports.js';

const id = (number: number) => `00000000-0000-4000-8000-${number.toString(16).padStart(12, '0')}`;
const workspaceId = id(1), projectA = id(2), projectB = id(3), projectC = id(4);
const personA = id(5), personB = id(6), personC = id(7);
const timestamp = '2026-10-18T00:00:00.000Z', sourceVersion = 'a'.repeat(64), capacityVersion = 'b'.repeat(64);
const exact = (numerator: string, denominator = '1', decimal = numerator) => ({ numerator, denominator, decimal });
const coverage = (tasks: number, filled: number, missing: number, nulls: number, zero: number) => ({ tasks, filled, missing, null: nulls, zero });

function field(projectId: string, number: number, name: string, type: TaskFieldDefinitionDto['type'], options: { id: string; name: string }[] = []): TaskFieldDefinitionDto {
  return taskFieldDefinitionSchema.parse({ id: id(number), workspaceId, projectId, name, type, revision: 1,
    definitionVersionId: id(number + 1000), historyEnabled: true, locked: false, archivedAt: null,
    options: options.map((option, index) => ({ ...option, color: null, position: index + 1, revision: 1, archivedAt: null })),
    createdAt: timestamp, updatedAt: timestamp });
}
// Field names differ per project on purpose: bindings resolve by ID, never by name.
const alpha = { plan: field(projectA, 10, 'Budget', 'duration'), fact: field(projectA, 11, 'Spent', 'duration'),
  category: field(projectA, 12, 'Work type', 'single_select', [{ id: id(13), name: 'Development' }]), date: field(projectA, 14, 'Delivery', 'date') };
const beta = { plan: field(projectB, 20, 'Estimate', 'duration'), fact: field(projectB, 21, 'Actual', 'duration'),
  category: field(projectB, 22, 'Stream', 'single_select', [{ id: id(23), name: 'Development' }]), date: field(projectB, 24, 'Ship date', 'date') };
type ProjectFields = typeof alpha;

function binding(projectId: string, projectName: string, reportNumber: number, fields: ProjectFields, changes: Partial<WorkspaceReportBoundSourceDto> = {}): WorkspaceReportBoundSourceDto {
  return workspaceReportBoundSourceSchema.parse({ projectId, projectName, reportId: id(reportNumber), reportName: `${projectName} plan/fact`, revision: 1,
    planFieldId: fields.plan.id, planFieldName: fields.plan.name, factFieldId: fields.fact.id, factFieldName: fields.fact.name,
    categoryFieldId: null, categoryFieldName: null, dateFieldId: null, dateFieldName: null, ...changes });
}
const alphaBinding = binding(projectA, 'Alpha', 8, alpha), betaBinding = binding(projectB, 'Beta', 9, beta);

function task(number: number, changes: Partial<GenericSourceTask> = {}): GenericSourceTask {
  return { id: id(number), projectId: projectA, title: `Task ${number}`, revision: 1, parentTaskId: null, sectionId: null,
    responsibleMembershipId: personA, dueDate: '2026-10-21', statusGroup: 'done', tagIds: [], ...changes };
}
function value(target: GenericSourceTask, definition: TaskFieldDefinitionDto, raw: number | string | null): TaskFieldValueDto {
  return taskFieldValueSchema.parse({ workspaceId, projectId: definition.projectId, taskId: target.id, fieldId: definition.id,
    definitionVersionId: definition.definitionVersionId, revision: 1, value: { type: definition.type, value: raw }, updatedAt: timestamp });
}
function source(bound: WorkspaceReportBoundSourceDto, fields: ProjectFields, tasks: GenericSourceTask[], values: TaskFieldValueDto[] = []): WorkspaceResolvedSource {
  return { binding: bound, source: { head: '1:0', fields: Object.values(fields), tasks, values, memberLabels: {}, sectionLabels: {} } };
}

interface DayInput { scheduled: number; holiday?: number; absence?: number; available?: number }
/** `days: null` is an unconfigured schedule, which is not the same as a known schedule of zero minutes. */
interface PersonCapacity { membershipId: string; displayName: string; days: Record<string, DayInput> | null }
type Roster = (from: string, to: string) => PersonCapacity[];
type MinuteKey = 'scheduledMinutes' | 'holidayMinutes' | 'absenceMinutes' | 'availableMinutes';
function workweek(from: string, to: string, minutes = 480): Record<string, DayInput> {
  const days: Record<string, DayInput> = {}, last = Temporal.PlainDate.from(to);
  for (let date = Temporal.PlainDate.from(from); Temporal.PlainDate.compare(date, last) <= 0; date = date.add({ days: 1 }))
    days[date.toString()] = { scheduled: date.dayOfWeek <= 5 ? minutes : 0 };
  return days;
}
const alice = (days: Record<string, DayInput> | null): PersonCapacity => ({ membershipId: personA, displayName: 'Alice', days });
const bob = (days: Record<string, DayInput> | null): PersonCapacity => ({ membershipId: personB, displayName: 'Bob', days });
const carol = (days: Record<string, DayInput> | null): PersonCapacity => ({ membershipId: personC, displayName: 'Carol', days });
const staffed: Roster = (from, to) => [alice(workweek(from, to)), bob(workweek(from, to))];

/** Mirrors the leave service output: day rows already net holidays and approved absences out of availability. */
function availability(startDate: string, endDate: string, people: readonly PersonCapacity[]): LeaveAvailabilityDto {
  const days = people.flatMap(person => Object.entries(person.days ?? {}).map(([date, day]) => {
    const holidayMinutes = day.holiday ?? 0, absenceMinutes = day.absence ?? 0;
    return { membershipId: person.membershipId, date, scheduledMinutes: day.scheduled, holidayMinutes, absenceMinutes,
      availableMinutes: day.available ?? Math.max(0, day.scheduled - holidayMinutes - absenceMinutes) };
  }));
  const total = (key: MinuteKey, membershipId?: string) => days.filter(day => membershipId === undefined || day.membershipId === membershipId).reduce((sum, day) => sum + day[key], 0);
  const memberTotal = (person: PersonCapacity, key: MinuteKey) => person.days ? total(key, person.membershipId) : null;
  return leaveAvailabilitySchema.parse({ startDate, endDate, settingsConfigured: true, sourceVersion: capacityVersion, days,
    members: people.map(person => ({ membershipId: person.membershipId, displayName: person.displayName, scheduleKnown: person.days !== null,
      scheduledMinutes: memberTotal(person, 'scheduledMinutes'), holidayMinutes: memberTotal(person, 'holidayMinutes'),
      absenceMinutes: memberTotal(person, 'absenceMinutes'), availableMinutes: memberTotal(person, 'availableMinutes') })),
    totals: { scheduledMinutes: total('scheduledMinutes'), holidayMinutes: total('holidayMinutes'), absenceMinutes: total('absenceMinutes'),
      availableMinutes: total('availableMinutes'), unconfiguredMembers: people.filter(person => person.days === null).length },
    intervals: [], companyHolidays: [], inputVersions: { settingsRevision: 1, profiles: [], requests: [] } });
}

function query(sources: readonly WorkspaceResolvedSource[], changes: Partial<WorkspaceReportQueryInput> = {}): WorkspaceReportQueryInput {
  return workspaceReportQueryInputSchema.parse({
    sources: sources.map(item => ({ reportId: item.binding.reportId, expectedRevision: item.binding.revision, categoryFieldId: item.binding.categoryFieldId })),
    range: { from: '2026-10-01', to: '2026-10-31' }, bucket: 'month', people: { kind: 'all_active' }, dateSource: 'due_date', ...changes });
}
function run(sources: readonly WorkspaceResolvedSource[], changes: Partial<WorkspaceReportQueryInput> = {}, roster: Roster = staffed, weekStart?: number): WorkspaceReportResultDto {
  const input = query(sources, changes), capacity = availability(input.range.from, input.range.to, roster(input.range.from, input.range.to));
  return workspaceReportResultSchema.parse(calculateWorkspaceReport(input, sources, capacity, sourceVersion, weekStart));
}
function person(scope: { people: readonly WorkspaceReportPersonDto[] }, membershipId: string | null): WorkspaceReportPersonDto {
  const found = scope.people.find(item => item.membershipId === membershipId);
  if (!found) throw new Error(`Missing person ${String(membershipId)}`);
  return found;
}
function first<T>(list: readonly T[]): T {
  const [item] = list;
  if (item === undefined) throw new Error('Expected an item');
  return item;
}
const categorySummary = (list: readonly WorkspaceReportCategoryDto[]) => list.map(item => [item.key, item.taskCount, item.plan.value?.numerator ?? null]);

describe('workspace report canonical scope', () => {
  it('counts a task linked into a second selected project once, using its home binding', () => {
    const shared = task(100), betaOnly = task(101, { projectId: projectB });
    const alphaSource = source(alphaBinding, alpha, [shared], [value(shared, alpha.plan, 60), value(shared, alpha.fact, 90)]);
    // The linked placement in Beta carries Beta-field values that must never be attributed to the Alpha home task.
    const betaSource = source(betaBinding, beta, [{ ...shared }, betaOnly], [value(shared, beta.plan, 999), value(shared, beta.fact, 999),
      value(betaOnly, beta.plan, 30), value(betaOnly, beta.fact, 45)]);
    const result = run([alphaSource, betaSource]);
    expect(result).toMatchObject({ sourceVersion, scope: 'selected_projects_canonical_tasks', filterSemantics: 'bindings_only', attribution: 'primary_assignee',
      dateSemantics: 'current_task_cohort', hierarchy: 'all_tasks', completion: 'done_only', missingDateTasks: 0, unmappedHomeTasks: 0 });
    expect(result.sources).toEqual([alphaBinding, betaBinding]);
    expect(result.rows.map(row => [row.taskId, row.homeProjectId, row.planMinutes, row.factMinutes])).toEqual([[shared.id, projectA, 60, 90], [betaOnly.id, projectB, 30, 45]]);
    expect(result.summary.taskCount).toBe(2);
    expect(result.summary.plan).toEqual({ key: 'plan', operation: 'sum', fieldId: null, unit: 'minutes', value: exact('90'), coverage: coverage(2, 2, 0, 0, 0) });
    expect(result.summary.fact.value).toEqual(exact('135'));
    expect(result.summary.comparison).toMatchObject({ eligibleTasks: 2, pairedTasks: 2, plan: exact('90'), fact: exact('135'), difference: exact('45'), ratio: exact('3', '2', '1.5') });
    const reversed = run([betaSource, alphaSource]);
    expect(reversed.summary).toEqual(result.summary);
    expect(reversed.rows).toEqual(result.rows);
  });

  it('excludes undated, out-of-range and unmapped-home tasks from every sum while counting coverage gaps', () => {
    const counted = task(100), undated = task(101, { dueDate: null }), late = task(102, { dueDate: '2026-11-01' }),
      early = task(103, { dueDate: '2026-09-30' }), foreign = task(104, { projectId: projectC });
    const all = [counted, undated, late, early, foreign];
    const result = run([source(alphaBinding, alpha, all, all.flatMap(item => [value(item, alpha.plan, 60), value(item, alpha.fact, 75)]))]);
    expect(result.rows.map(row => row.taskId)).toEqual([counted.id]);
    expect(result.summary).toMatchObject({ taskCount: 1, plan: { value: exact('60'), coverage: coverage(1, 1, 0, 0, 0) }, fact: { value: exact('75') } });
    expect(result).toMatchObject({ missingDateTasks: 1, unmappedHomeTasks: 1 });
    expect(result.buckets.map(item => [item.taskCount, item.plan.value?.numerator])).toEqual([[1, '60']]);
    expect(person(result, personA)).toMatchObject({ taskCount: 1, plan: { value: exact('60') } });
  });

  it('reads the bound report date field from the home project instead of the due date', () => {
    const dated = binding(projectA, 'Alpha', 8, alpha, { dateFieldId: alpha.date.id, dateFieldName: alpha.date.name });
    const byField = task(100, { dueDate: '2030-01-01' }), cleared = task(101), absent = task(102), later = task(103), betaTask = task(104, { projectId: projectB });
    const result = run([
      source(dated, alpha, [byField, cleared, absent, later], [value(byField, alpha.date, '2026-10-05'), value(cleared, alpha.date, null), value(later, alpha.date, '2026-11-05'),
        value(byField, alpha.plan, 10), value(cleared, alpha.plan, 20), value(absent, alpha.plan, 40), value(later, alpha.plan, 80)]),
      // Beta binds no date field, so its own date values are not a report date.
      source(betaBinding, beta, [betaTask], [value(betaTask, beta.date, '2026-10-06'), value(betaTask, beta.plan, 160)]),
    ], { dateSource: 'report_date_field' });
    expect(result.rows.map(row => [row.taskId, row.date])).toEqual([[byField.id, '2026-10-05']]);
    expect(result.missingDateTasks).toBe(3);
    expect(result.summary.plan.value).toEqual(exact('10'));
    expect(first(result.buckets).taskCount).toBe(1);
  });

  it('applies a selected people filter strictly, excluding other members and unassigned work', () => {
    const mine = task(100), theirs = task(101, { responsibleMembershipId: personB }), nobody = task(102, { responsibleMembershipId: null }),
      mineUndated = task(103, { dueDate: null }), theirsUndated = task(104, { responsibleMembershipId: personB, dueDate: null });
    const sources = [source(alphaBinding, alpha, [mine, theirs, nobody, mineUndated, theirsUndated],
      [value(mine, alpha.plan, 10), value(theirs, alpha.plan, 20), value(nobody, alpha.plan, 40)])];
    const selected = run(sources, { people: { kind: 'selected', membershipIds: [personA] } }, (from, to) => [alice(workweek(from, to))]);
    expect(selected.rows.map(row => row.taskId)).toEqual([mine.id]);
    expect(selected.summary.plan.value).toEqual(exact('10'));
    expect(selected.people.map(item => item.membershipId)).toEqual([personA]);
    expect(first(selected.buckets).people.map(item => item.membershipId)).toEqual([personA]);
    expect(selected.missingDateTasks).toBe(1);
    const everyone = run(sources);
    expect(everyone.rows.map(row => row.taskId)).toEqual([mine.id, theirs.id, nobody.id]);
    expect(everyone.summary.plan.value).toEqual(exact('70'));
    expect(everyone.people.map(item => [item.displayName, item.taskCount])).toEqual([['Alice', 1], ['Bob', 1], ['Unassigned', 1]]);
    expect(person(everyone, null).capacity).toBeNull();
    expect(everyone.missingDateTasks).toBe(2);
  });

  it('accepts 5000 canonical tasks after deduplicating linked placements and fails at 5001', () => {
    const tasks = Array.from({ length: 5000 }, (_, index) => task(0x10000 + index));
    const home = source(alphaBinding, alpha, tasks), linked = source(betaBinding, beta, tasks.slice(0, 1000).map(item => ({ ...item })));
    const result = run([home, linked]);
    expect(result.rows).toHaveLength(5000);
    expect(result.summary).toMatchObject({ taskCount: 5000, plan: { value: null, coverage: coverage(5000, 0, 5000, 0, 0) } });
    const overflow = source(betaBinding, beta, [...linked.source.tasks, task(0x20000, { projectId: projectB })]);
    expect(() => run([home, overflow])).toThrow(/5000/);
  });
});

describe('workspace plan/fact aggregation', () => {
  it('sums full-scope plan and fact independently of the done-only paired comparison', () => {
    const a = task(100), b = task(101), c = task(102), d = task(103, { statusGroup: 'todo' }), e = task(104);
    const input = source(alphaBinding, alpha, [a, b, c, d, e], [
      value(a, alpha.plan, 600), value(a, alpha.fact, 720), value(b, alpha.plan, 270), value(b, alpha.fact, 300),
      value(c, alpha.plan, 120), value(d, alpha.plan, 1000), value(d, alpha.fact, 3000), value(e, alpha.plan, null), value(e, alpha.fact, 0)]);
    const result = run([input]);
    expect(result.summary.plan).toMatchObject({ value: exact('1990'), coverage: coverage(5, 4, 0, 1, 0) });
    expect(result.summary.fact).toMatchObject({ value: exact('4020'), coverage: coverage(5, 4, 1, 0, 1) });
    expect(result.summary.comparison).toEqual({ eligibleTasks: 4, pairedTasks: 2, plan: exact('870'), fact: exact('1020'), difference: exact('150'),
      ratio: exact('34', '29', '1.172413793103'), unavailableReason: null, planCoverage: coverage(4, 3, 0, 1, 0), factCoverage: coverage(4, 3, 1, 0, 1) });
    expect(person(result, personA).comparison).toEqual(result.summary.comparison);
    const rows = new Map(result.rows.map(row => [row.taskId, row]));
    expect(rows.get(c.id)).toMatchObject({ planState: 'value', planMinutes: 120, factState: 'missing', factMinutes: null });
    expect(rows.get(e.id)).toMatchObject({ planState: 'null', planMinutes: null, factState: 'value', factMinutes: 0 });
    expect(rows.get(d.id)?.statusGroup).toBe('todo');
    const allTasks = run([input], { completion: 'all_tasks' });
    expect(allTasks.summary.plan).toEqual(result.summary.plan);
    expect(allTasks.summary.comparison).toMatchObject({ eligibleTasks: 5, pairedTasks: 3, plan: exact('1870'), fact: exact('4020'),
      difference: exact('2150'), ratio: { numerator: '402', denominator: '187' }, unavailableReason: null });
  });

  it('keeps known zero, all-missing and empty buckets distinct', () => {
    const zero = task(100, { dueDate: '2026-10-05' }), blank = task(101, { dueDate: '2026-11-10' });
    const result = run([source(alphaBinding, alpha, [zero, blank], [value(zero, alpha.plan, 0), value(zero, alpha.fact, 5)])],
      { range: { from: '2026-10-01', to: '2026-12-31' } });
    const [october, november, december] = result.buckets;
    expect(october?.plan).toMatchObject({ value: exact('0'), coverage: coverage(1, 1, 0, 0, 1) });
    expect(october?.comparison).toMatchObject({ eligibleTasks: 1, pairedTasks: 1, plan: exact('0'), fact: exact('5'), difference: exact('5'), ratio: null, unavailableReason: 'zero_plan' });
    expect(november?.plan).toMatchObject({ value: null, coverage: coverage(1, 0, 1, 0, 0) });
    expect(november?.fact.value).toBeNull();
    expect(november?.comparison).toMatchObject({ eligibleTasks: 1, pairedTasks: 0, plan: null, fact: null, difference: null, ratio: null, unavailableReason: 'missing_plan' });
    expect(december).toMatchObject({ taskCount: 0, plan: { value: null, coverage: coverage(0, 0, 0, 0, 0) } });
    expect(december?.comparison).toMatchObject({ eligibleTasks: 0, pairedTasks: 0, unavailableReason: 'no_tasks' });
    expect(result.summary.plan).toMatchObject({ value: exact('0'), coverage: coverage(2, 1, 1, 0, 1) });
  });
});

describe('workspace capacity', () => {
  const range = { from: '2026-10-19', to: '2026-10-25' };

  it('treats an unconfigured schedule as unknown capacity, never as known zero', () => {
    const mine = task(100), theirs = task(101, { responsibleMembershipId: personB });
    const sources = [source(alphaBinding, alpha, [mine, theirs], [value(mine, alpha.plan, 60), value(theirs, alpha.plan, 90)])];
    const mixed = run(sources, { range, bucket: 'week' }, (from, to) => [alice(workweek(from, to, 0)), bob(null)]);
    expect(person(mixed, personA).capacity).toEqual({ membershipId: personA, displayName: 'Alice', scheduleKnown: true,
      scheduledMinutes: 0, holidayMinutes: 0, absenceMinutes: 0, availableMinutes: 0 });
    expect(person(mixed, personB).capacity).toEqual({ membershipId: personB, displayName: 'Bob', scheduleKnown: false,
      scheduledMinutes: null, holidayMinutes: null, absenceMinutes: null, availableMinutes: null });
    expect(person(mixed, personB)).toMatchObject({ taskCount: 1, plan: { value: exact('90') } });
    expect(first(mixed.buckets).capacity).toEqual({ scheduledMinutes: null, holidayMinutes: null, absenceMinutes: null, availableMinutes: null, unconfiguredMembers: 1 });
    const known = run(sources, { range, bucket: 'week', people: { kind: 'selected', membershipIds: [personA] } }, (from, to) => [alice(workweek(from, to, 0))]);
    expect(first(known.buckets).capacity).toEqual({ scheduledMinutes: 0, holidayMinutes: 0, absenceMinutes: 0, availableMinutes: 0, unconfiguredMembers: 0 });
    expect(known.summary.plan.value).toEqual(exact('60'));
  });

  it('keeps members without tasks together with their full capacity', () => {
    const mine = task(100), nobody = task(101, { responsibleMembershipId: null });
    const result = run([source(alphaBinding, alpha, [mine, nobody], [value(mine, alpha.plan, 120), value(nobody, alpha.plan, 30)])], { range, bucket: 'week' },
      (from, to) => [alice(workweek(from, to)), bob(workweek(from, to)), carol(workweek(from, to))]);
    expect(result.people.map(item => [item.displayName, item.taskCount])).toEqual([['Alice', 1], ['Bob', 0], ['Carol', 0], ['Unassigned', 1]]);
    const idle = person(result, personC);
    expect(idle.capacity).toEqual({ membershipId: personC, displayName: 'Carol', scheduleKnown: true, scheduledMinutes: 2400, holidayMinutes: 0, absenceMinutes: 0, availableMinutes: 2400 });
    expect(idle.plan).toMatchObject({ value: null, coverage: coverage(0, 0, 0, 0, 0) });
    expect(idle.comparison).toMatchObject({ eligibleTasks: 0, pairedTasks: 0, unavailableReason: 'no_tasks' });
    expect(idle.categories).toEqual([]);
    expect(person(result, null).capacity).toBeNull();
    const week = first(result.buckets);
    expect(week.people.map(item => item.displayName)).toEqual(['Alice', 'Bob', 'Carol', 'Unassigned']);
    expect(person(week, personC).capacity?.availableMinutes).toBe(2400);
    expect(week.capacity).toEqual({ scheduledMinutes: 7200, holidayMinutes: 0, absenceMinutes: 0, availableMinutes: 7200, unconfiguredMembers: 0 });
  });

  it('takes neutralized absence days as given: 40h scheduled minus one 8h absence leaves 32h', () => {
    const days = { ...workweek(range.from, range.to), '2026-10-21': { scheduled: 480, absence: 480, available: 0 } };
    const mine = task(100, { dueDate: '2026-10-22' });
    const result = run([source(alphaBinding, alpha, [mine], [value(mine, alpha.plan, 1920), value(mine, alpha.fact, 1800)])], { range, bucket: 'week' }, () => [alice(days)]);
    expect(person(result, personA).capacity).toEqual({ membershipId: personA, displayName: 'Alice', scheduleKnown: true,
      scheduledMinutes: 2400, holidayMinutes: 0, absenceMinutes: 480, availableMinutes: 1920 });
    expect(result.buckets.map(item => item.capacity)).toEqual([{ scheduledMinutes: 2400, holidayMinutes: 0, absenceMinutes: 480, availableMinutes: 1920, unconfiguredMembers: 0 }]);
    expect(person(result, personA).plan.value).toEqual(exact('1920'));
  });
});

describe('workspace buckets', () => {
  it('clips month buckets and per-person capacity to the requested range', () => {
    const due = ['2026-09-15', '2026-09-16', '2026-09-30', '2026-10-01', '2026-11-10', '2026-11-11'];
    const tasks = due.map((dueDate, index) => task(100 + index, { dueDate }));
    const result = run([source(alphaBinding, alpha, tasks, tasks.map((item, index) => value(item, alpha.plan, 2 ** index)))],
      { range: { from: '2026-09-16', to: '2026-11-10' } },
      () => [alice({ '2026-09-16': { scheduled: 480 }, '2026-10-01': { scheduled: 240 }, '2026-10-31': { scheduled: 0 }, '2026-11-10': { scheduled: 480, holiday: 480 } })]);
    expect(result.buckets.map(item => [item.startDate, item.endDate, item.taskCount, item.plan.value?.numerator])).toEqual([
      ['2026-09-16', '2026-09-30', 2, '6'], ['2026-10-01', '2026-10-31', 1, '8'], ['2026-11-01', '2026-11-10', 1, '16']]);
    expect(result.buckets.map(item => item.capacity)).toEqual([
      { scheduledMinutes: 480, holidayMinutes: 0, absenceMinutes: 0, availableMinutes: 480, unconfiguredMembers: 0 },
      { scheduledMinutes: 240, holidayMinutes: 0, absenceMinutes: 0, availableMinutes: 240, unconfiguredMembers: 0 },
      { scheduledMinutes: 480, holidayMinutes: 480, absenceMinutes: 0, availableMinutes: 0, unconfiguredMembers: 0 }]);
    expect(result.buckets.map(item => person(item, personA).capacity?.scheduledMinutes)).toEqual([480, 240, 480]);
    expect(person(result, personA).capacity).toMatchObject({ scheduledMinutes: 1200, holidayMinutes: 480, availableMinutes: 720 });
    expect(result.summary.plan.value).toEqual(exact('30'));
  });

  it('clips week buckets to the range and honors the configured week start', () => {
    const range = { from: '2026-10-14', to: '2026-10-28' };
    const due = ['2026-10-13', '2026-10-14', '2026-10-18', '2026-10-19', '2026-10-28', '2026-10-29'];
    const tasks = due.map((dueDate, index) => task(100 + index, { dueDate }));
    const sources = [source(alphaBinding, alpha, tasks, tasks.map((item, index) => value(item, alpha.plan, 2 ** index)))];
    const roster: Roster = (from, to) => [alice(workweek(from, to))];
    const shape = (result: WorkspaceReportResultDto) => result.buckets.map(item => [item.startDate, item.endDate, item.taskCount, item.plan.value?.numerator, item.capacity.scheduledMinutes]);
    expect(shape(run(sources, { range, bucket: 'week' }, roster))).toEqual([
      ['2026-10-14', '2026-10-18', 2, '6', 1440], ['2026-10-19', '2026-10-25', 1, '8', 2400], ['2026-10-26', '2026-10-28', 1, '16', 1440]]);
    expect(shape(run(sources, { range, bucket: 'week' }, roster, 7))).toEqual([
      ['2026-10-14', '2026-10-17', 1, '2', 1440], ['2026-10-18', '2026-10-24', 2, '12', 2400], ['2026-10-25', '2026-10-28', 1, '16', 1440]]);
  });
});

describe('workspace categories', () => {
  it('keeps same-label options from different projects as separate category identities', () => {
    const alphaCategorized = binding(projectA, 'Alpha', 8, alpha, { categoryFieldId: alpha.category.id, categoryFieldName: alpha.category.name });
    const betaCategorized = binding(projectB, 'Beta', 9, beta, { categoryFieldId: beta.category.id, categoryFieldName: beta.category.name });
    const alphaDev = task(100), betaDev = task(101, { projectId: projectB }), cleared = task(102), unset = task(103, { projectId: projectB }),
      bobDev = task(104, { projectId: projectB, responsibleMembershipId: personB });
    const result = run([
      source(alphaCategorized, alpha, [alphaDev, cleared], [value(alphaDev, alpha.category, id(13)), value(cleared, alpha.category, null),
        value(alphaDev, alpha.plan, 60), value(cleared, alpha.plan, 10)]),
      source(betaCategorized, beta, [betaDev, unset, bobDev], [value(betaDev, beta.category, id(23)), value(bobDev, beta.category, id(23)),
        value(betaDev, beta.plan, 30), value(unset, beta.plan, 5), value(bobDev, beta.plan, 7)]),
    ]);
    const alphaKey = `${projectA}:${alpha.category.id}:${id(13)}`, betaKey = `${projectB}:${beta.category.id}:${id(23)}`;
    expect(result.categories.map(item => ({ key: item.key, label: item.label, projectId: item.projectId, projectName: item.projectName,
      fieldId: item.fieldId, optionId: item.optionId, taskCount: item.taskCount, plan: item.plan.value }))).toEqual([
      { key: alphaKey, label: 'Development', projectId: projectA, projectName: 'Alpha', fieldId: alpha.category.id, optionId: id(13), taskCount: 1, plan: exact('60') },
      { key: betaKey, label: 'Development', projectId: projectB, projectName: 'Beta', fieldId: beta.category.id, optionId: id(23), taskCount: 2, plan: exact('37') },
      { key: 'uncategorized', label: 'Uncategorized', projectId: null, projectName: null, fieldId: null, optionId: null, taskCount: 2, plan: exact('15') },
    ]);
    expect(categorySummary(person(result, personA).categories)).toEqual([[alphaKey, 1, '60'], [betaKey, 1, '30'], ['uncategorized', 2, '15']]);
    expect(categorySummary(person(result, personB).categories)).toEqual([[betaKey, 1, '7']]);
    expect(categorySummary(person(first(result.buckets), personA).categories)).toEqual(categorySummary(person(result, personA).categories));
    expect(result.rows.map(row => row.categoryKey)).toEqual([alphaKey, betaKey, 'uncategorized', 'uncategorized', betaKey]);
  });
});
