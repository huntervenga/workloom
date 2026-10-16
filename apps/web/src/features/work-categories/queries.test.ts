import type { TaskTimeSummaryDto } from '@workloom/contracts';
import { describe, expect, it } from 'vitest';
import { alpha } from '../../test/fakeApi';
import { COMMITMENT_ID, MEMBER_ID, PACKAGE_ID, PERIOD_A, PROJECT_ID, TASK_ID, commitment } from '../planning/test/fixtures';
import { mergeTaskTimeSummaries } from './queries';

function projection(sequence: string): TaskTimeSummaryDto {
  return {
    workspaceId: alpha.id, projectId: PROJECT_ID, periodId: PERIOD_A, subjectMembershipId: MEMBER_ID, asOfChangeSeq: sequence,
    tasks: [{ taskId: TASK_ID, workPackageId: PACKAGE_ID, currentAllocationMinutes: 120, ownManualWork: null, subjectActualMinutes: 0, taskActualMinutes: 0, subjectActiveSourceCount: 0, taskActiveSourceCount: 0, hasOtherSources: false }],
    packages: [{ workPackageId: PACKAGE_ID, commitment: { ...commitment(), id: COMMITMENT_ID, allocations: [{ taskId: TASK_ID, minutes: 120 }] }, subjectActualMinutes: 300, totalActualMinutes: 600, subjectActiveSourceCount: 1, totalActiveSourceCount: 2 }],
  };
}

describe('visible-task projection batch reconciliation', () => {
  it('does not resurrect an allocation when a newer full package snapshot has removed its commitment', () => {
    const older = projection('9');
    const newer = projection('10');
    newer.tasks = [];
    const packageRow = newer.packages[0];
    if (!packageRow?.commitment) throw new Error('Missing fixture commitment');
    packageRow.commitment = { ...packageRow.commitment, state: 'removed', revision: 2 };
    for (const pages of [[older, newer], [newer, older]]) {
      const result = mergeTaskTimeSummaries(pages);
      expect(result.tasks.get(TASK_ID)?.currentAllocationMinutes).toBeNull();
      expect(result.packages.get(PACKAGE_ID)?.commitment?.state).toBe('removed');
      expect(result.packages).toHaveLength(1);
      expect(result.packages.get(PACKAGE_ID)?.totalActualMinutes).toBe(600);
    }
  });

  it('rejects contradictory same-version package snapshots rather than silently displaying an arbitrary total', () => {
    const first = projection('10');
    const second = projection('10');
    const packageRow = second.packages[0];
    if (!packageRow) throw new Error('Missing fixture package');
    packageRow.totalActualMinutes = 700;
    expect(() => mergeTaskTimeSummaries([first, second])).toThrow();
  });
});
