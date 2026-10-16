import { describe, expect, it } from 'vitest';
import { currentReportTaskHref, projectTimeHref, weeklyPlanningHref } from './navigation';

const workspaceId = 'workspace';
const projectId = 'project';
const base = `/w/${workspaceId}/projects/${projectId}`;
const params = (href: string) => new URL(href, 'https://workloom.test').searchParams;

describe('project and weekly time-context navigation', () => {
  it('keeps old standalone weekly URLs distinct from a deliberately unselected table week', () => {
    expect(weeklyPlanningHref(workspaceId, projectId)).toBe(`${base}/week`);
    const empty = params(weeklyPlanningHref(workspaceId, projectId, { periodId: '', workerId: 'person-b', explicitEmptyPeriod: true }));
    expect(empty.has('period')).toBe(true);
    expect(empty.get('period')).toBe('');
    expect(empty.get('worker')).toBe('person-b');
  });

  it('maps an explicitly selected week/person in both directions without carrying view or command state', () => {
    const context = { periodId: 'period-b', workerId: 'person-b', view: 'graph', run: 'report', task: 'other-task' };
    const week = params(weeklyPlanningHref(workspaceId, projectId, context));
    expect([...week.entries()]).toEqual([['period', 'period-b'], ['worker', 'person-b']]);
    const table = params(projectTimeHref(workspaceId, projectId, context));
    expect([...table.entries()]).toEqual([['week', 'period-b'], ['worker', 'person-b']]);
  });

  it('preserves an explicitly empty or unrecognized person instead of selecting another person', () => {
    expect(params(weeklyPlanningHref(workspaceId, projectId, { workerId: '' })).has('worker')).toBe(true);
    const unrecognized = 'unavailable&worker=someone-else';
    expect([...params(projectTimeHref(workspaceId, projectId, { workerId: unrecognized })).entries()]).toEqual([['worker', unrecognized]]);
  });
});


describe('current report task destinations', () => {
  const task = { id: 'task-current', workspaceId, projectId };
  const source = { workspaceId, projectId, periodId: 'saved-period', workerId: 'selected-person' };

  it('carries explicit period and person only while they belong to the current destination', () => {
    expect(currentReportTaskHref(task, source)).toBe(`${base}?week=saved-period&worker=selected-person&task=task-current`);
    expect(currentReportTaskHref({ ...task, projectId: 'moved-project' }, source)).toBe(`/w/${workspaceId}/projects/moved-project?worker=selected-person&task=task-current`);
    expect(currentReportTaskHref({ ...task, workspaceId: 'another-workspace' }, source)).toBe(`/w/another-workspace/projects/${projectId}?task=task-current`);
  });

  it('preserves an empty explicit person and never adds report or command parameters', () => {
    const context = { ...source, workerId: '', run: 'saved-run', typeRun: 'saved-type-run', view: 'report' };
    expect([...params(currentReportTaskHref(task, context)).entries()]).toEqual([['week', 'saved-period'], ['worker', ''], ['task', 'task-current']]);
  });
});
