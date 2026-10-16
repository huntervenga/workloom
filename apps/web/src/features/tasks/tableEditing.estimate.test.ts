import { describe, expect, it } from 'vitest';
import { task } from '../planning/test/fixtures';
import { summarizeWorkPackages } from '../task-table/workPackages';
import { canResumeInlineSession, isCurrentEstimateProjection, matchesInlineTaskReceipt, taskInlineColumn } from './tableEditing';
import { buildUpdateInput, draftFromTask } from './taskDraft';

describe('inline package estimate source contract', () => {
  it('keeps the draft-field/column mapping explicit and emits only the two source revisions and estimate', () => {
    const draft = { ...draftFromTask(task), estimate: '0' };
    expect(taskInlineColumn('estimate')).toBe('estimate');
    expect(canResumeInlineSession({ base: task, draft, inlineField: 'estimate' }, 'estimate')).toBe(true);
    expect(canResumeInlineSession({ base: task, draft }, 'estimate')).toBe(false);
    expect(buildUpdateInput(task, draftFromTask(task), draft)).toEqual({ ok: true, input: { expectedRevision: task.revision, expectedWorkPackageRevision: task.workPackageRevision, estimateMinutes: 0 } });
  });

  it('requires a known exact nonconflicting package projection including unknown versus zero', () => {
    const unknown = { ...task, estimateMinutes: null };
    const zero = { ...task, estimateMinutes: 0 };
    expect(isCurrentEstimateProjection(unknown, summarizeWorkPackages([unknown]).packages)).toBe(true);
    expect(isCurrentEstimateProjection(unknown, summarizeWorkPackages([zero]).packages)).toBe(false);
    expect(isCurrentEstimateProjection(task, new Map())).toBe(false);
    expect(isCurrentEstimateProjection(task, summarizeWorkPackages([task, { ...task, estimateMinutes: null }]).packages)).toBe(false);
    expect(isCurrentEstimateProjection(task, summarizeWorkPackages([{ ...task, workPackageRevision: task.workPackageRevision + 1 }]).packages)).toBe(false);
  });

  it('matches package-only receipts independently from unchanged task revision and cancels superseding/different packages', () => {
    const receipt = { ...task, estimateMinutes: 45, workPackageRevision: task.workPackageRevision + 1 };
    expect(matchesInlineTaskReceipt(receipt, receipt, 'estimate')).toBe(true);
    expect(matchesInlineTaskReceipt(task, receipt, 'estimate')).toBe(false);
    expect(matchesInlineTaskReceipt({ ...receipt, workPackageRevision: receipt.workPackageRevision + 1 }, receipt, 'estimate')).toBe(false);
    expect(matchesInlineTaskReceipt({ ...receipt, workPackageId: 'another-package' }, receipt, 'estimate')).toBe(false);
    expect(matchesInlineTaskReceipt({ ...receipt, estimateMinutes: null }, receipt, 'estimate')).toBe(false);
    expect(matchesInlineTaskReceipt({ ...receipt, revision: receipt.revision + 1 }, receipt, 'estimate')).toBe(false);
  });
});
