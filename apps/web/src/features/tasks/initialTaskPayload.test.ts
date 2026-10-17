import type { CreateTaskInput } from '@workloom/contracts';
import { describe, expect, it } from 'vitest';
import { field } from '../fields/test/fixtures';
import { PROJECT_ID, task } from '../planning/test/fixtures';
import { emptyInitialTaskCellsDraft, setInitialHours, stageInitialField, type InitialTimeContext } from './InitialTaskCells';
import { buildInitialTaskPayload, snapshotInitialTaskPayload } from './initialTaskPayload';

const POINTS_ID = '90000000-0000-4000-8000-0000000000f2';
const PERIOD_A = 'a1000000-0000-4000-8000-000000000001';
const MEMBER_A = 'b1000000-0000-4000-8000-000000000001';
const PACKAGE_ID = 'c1000000-0000-4000-8000-000000000001';
const OTHER_PACKAGE_ID = 'c1000000-0000-4000-8000-000000000002';
const points = field('Points', 'number', POINTS_ID);
const weekA: InitialTimeContext = { periodId: PERIOD_A, membershipId: MEMBER_A, periodName: 'Week 43', memberName: 'Anna Stored' };
const parentPlan = (expectedRevision: number | null): InitialTimeContext => ({ ...weekA, plan: { workPackageId: PACKAGE_ID, expectedRevision } });
const input: CreateTaskInput = { projectId: PROJECT_ID, title: 'Row', statusId: task.statusId };
const sharedPlanMessage = 'Planned hours belong to the parent package. Clear this value to add the subtask.';

describe('buildInitialTaskPayload', () => {
  it('keeps the legacy create when nothing is staged', () => {
    expect(buildInitialTaskPayload(input, undefined, { sharesParentPackage: false })).toEqual({ ok: true, initial: undefined, contextChanged: false });
    expect(buildInitialTaskPayload(input, emptyInitialTaskCellsDraft(), { sharesParentPackage: false })).toEqual({ ok: true, initial: undefined, contextChanged: false });
  });

  it('encodes values and an own new package plan with explicit targets and no helper metadata', () => {
    const staged = setInitialHours(setInitialHours(stageInitialField(emptyInitialTaskCellsDraft(), points, { type: 'number', text: '7' }), 'planned', '0', weekA), 'fact', '1:30', weekA);
    const result = buildInitialTaskPayload(input, staged, { definitions: [points], sharesParentPackage: false });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.initial?.fields).toHaveLength(1);
    expect(Object.keys(result.initial?.fields?.[0] ?? {}).sort()).toEqual(['expectedDefinitionRevision', 'fieldId', 'value']);
    expect(result.initial?.fields?.[0]).toMatchObject({ fieldId: POINTS_ID, expectedDefinitionRevision: points.revision });
    // `0` is an explicit zero, and a new package expects no commitment.
    expect(result.initial?.plan).toEqual({ periodId: PERIOD_A, membershipId: MEMBER_A, expectedRevision: null, plannedMinutes: 0 });
    expect(result.initial?.actual).toEqual({ periodId: PERIOD_A, membershipId: MEMBER_A, minutes: 90 });
  });

  it('guards a detail subtask plan with the captured parent commitment revision, or its known absence', () => {
    for (const revision of [4, null]) {
      const staged = setInitialHours(emptyInitialTaskCellsDraft(), 'planned', '2', parentPlan(revision));
      const result = buildInitialTaskPayload(input, staged, { sharesParentPackage: true, parentWorkPackageId: PACKAGE_ID });
      expect(result).toMatchObject({ ok: true, initial: { plan: { periodId: PERIOD_A, membershipId: MEMBER_A, expectedRevision: revision, plannedMinutes: 120 } } });
    }
  });

  it('refuses a shared parent plan without the loaded commitment', () => {
    const staged = setInitialHours(emptyInitialTaskCellsDraft(), 'planned', '2', weekA);
    const result = buildInitialTaskPayload(input, staged, { sharesParentPackage: true, parentWorkPackageId: PACKAGE_ID });
    expect(result.ok).toBe(false);
  });

  it('never reinterprets a staged parent package plan as a new budget after Detail becomes Additional work', () => {
    const staged = setInitialHours(emptyInitialTaskCellsDraft(), 'planned', '2', parentPlan(4));
    const result = buildInitialTaskPayload(input, staged, { sharesParentPackage: false });
    expect(result).toEqual({ ok: false, issues: [{ kind: 'hours', hours: 'planned', message: sharedPlanMessage }] });
    // The draft is kept for review; only an explicit clear lets the task go.
    expect(staged.time.planned.raw).toBe('2');
    const cleared = setInitialHours(staged, 'planned', '', null);
    expect(buildInitialTaskPayload(input, cleared, { sharesParentPackage: false })).toEqual({ ok: true, initial: undefined, contextChanged: false });
  });

  it('refuses a plan captured for another parent package', () => {
    const staged = setInitialHours(emptyInitialTaskCellsDraft(), 'planned', '2', parentPlan(4));
    const result = buildInitialTaskPayload(input, staged, { sharesParentPackage: true, parentWorkPackageId: OTHER_PACKAGE_ID });
    expect(result).toMatchObject({ ok: false, issues: [{ kind: 'hours', hours: 'planned', message: sharedPlanMessage }] });
  });

  it('still reports every staged issue while the built-in fields are invalid', () => {
    const staged = setInitialHours(emptyInitialTaskCellsDraft(), 'fact', 'soon', weekA);
    const result = buildInitialTaskPayload(null, staged, { sharesParentPackage: false });
    expect(result).toMatchObject({ ok: false, issues: [{ kind: 'hours', hours: 'fact' }] });
  });

  it('snapshots a held payload so later draft edits cannot reach it', () => {
    const staged = setInitialHours(emptyInitialTaskCellsDraft(), 'fact', '1', weekA);
    const result = buildInitialTaskPayload(input, staged, { sharesParentPackage: false });
    if (!result.ok || result.initial === undefined) throw new Error('Expected a payload');
    const held = snapshotInitialTaskPayload(result.initial);
    expect(held).toEqual(result.initial);
    expect(held).not.toBe(result.initial);
    expect(held?.actual).not.toBe(result.initial.actual);
  });
});
