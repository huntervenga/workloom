import { describe, expect, it } from 'vitest';
import { completionAtCalculation } from './report-completion.js';
const task = (statusId = 'done', archivedAt: string | null = null, workPackageId = 'package') => ({ statusId, archivedAt, workPackageId });
const statuses = [{ id: 'done', group: 'done' as const }, { id: 'open', group: 'in_progress' as const }, { id: 'cancelled', group: 'cancelled' as const }];
describe('immutable full-package report completion', () => {
  it('captures known completion only for a nonempty full package', () => {
    expect(completionAtCalculation('package', [task(), task('DONE')], statuses)).toEqual({ rule: 'all_nonarchived_package_tasks_v1', state: 'done', taskCount: 2 });
  });
  it('includes an unloaded or hidden pending child in the same work package', () => {
    expect(completionAtCalculation('package', [task(), task('open')], statuses).state).toBe('not_done');
  });
  it('never treats zero eligible tasks or an archived-only package as vacuously done', () => {
    expect(completionAtCalculation('package', [], statuses).state).toBe('unknown');
    expect(completionAtCalculation('package', [task('done', '2026-10-01T00:00:00Z')], statuses)).toMatchObject({ state: 'unknown', taskCount: 0 });
  });
  it('excludes archived siblings but includes all active tasks, independent of personal allocations', () => {
    expect(completionAtCalculation('PACKAGE', [task(), task('open', '2026-10-01T00:00:00Z'), task('open', null, 'other')], statuses)).toMatchObject({ state: 'done', taskCount: 1 });
  });
  it('keeps unknown status unknown, and cancelled work is not done', () => {
    expect(completionAtCalculation('package', [task('missing')], statuses).state).toBe('unknown');
    expect(completionAtCalculation('package', [task('cancelled')], statuses).state).toBe('not_done');
  });
});
