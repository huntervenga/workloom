import { describe, expect, it, vi } from 'vitest';
import { commitment, period } from '../planning/test/fixtures';
import { commitmentSession } from '../planning/CommitmentDialog';
import { factSession } from '../planning/FactDialog';
import { recategorizeSession } from './RecategorizeDialog';
import { binding, categorized, MEMBER_ID, OPTION_B, task } from './test/fixtures';
import { categoryDraftDirty, createRetainedHoursDrafts, factDraftDirty, planDraftDirty } from './retainedHoursDrafts';

const freshPlan = () => commitmentSession(period(), null, MEMBER_ID);
const freshFact = () => factSession(period(), null, MEMBER_ID, task.id);
const freshCategory = () => recategorizeSession(categorized(), binding(), task.title, 'Saved person');

describe('semantic retained hours inputs', () => {
  it('treats pristine captured sessions as clean without conflating absent and zero hours', () => {
    expect(planDraftDirty(freshPlan())).toBe(false); expect(factDraftDirty(freshFact())).toBe(false); expect(categoryDraftDirty(freshCategory())).toBe(false);
    expect(planDraftDirty({ ...freshPlan(), hours: '0' })).toBe(true); expect(factDraftDirty({ ...freshFact(), hours: '0:00' })).toBe(true);
    const zeroPlan = commitmentSession(period(), { ...commitment(0), allocations: [] }, MEMBER_ID);
    expect(planDraftDirty({ ...zeroPlan, hours: '0:00' })).toBe(false); expect(planDraftDirty({ ...zeroPlan, hours: '' })).toBe(true);
    const zeroFact = factSession(period(), categorized(0), MEMBER_ID);
    expect(factDraftDirty({ ...zeroFact, hours: '0.0' })).toBe(false); expect(factDraftDirty({ ...zeroFact, hours: '' })).toBe(true);
  });
  it('compares valid equivalent minutes semantically and keeps invalid raw text dirty', () => {
    const plan = commitmentSession(period(), commitment(90), MEMBER_ID);
    const fact = factSession(period(), categorized(90), MEMBER_ID);
    for (const hours of ['1.5', '1,5', '1:30']) { expect(planDraftDirty({ ...plan, hours })).toBe(false); expect(factDraftDirty({ ...fact, hours })).toBe(false); }
    for (const hours of ['1:', 'NaN', '-1', '0:90']) { expect(planDraftDirty({ ...plan, hours })).toBe(true); expect(factDraftDirty({ ...fact, hours })).toBe(true); }
  });
  it('preserves blank-versus-zero allocations, missing captured rows, invalid input and plan state', () => {
    const fresh = freshPlan();
    expect(planDraftDirty({ ...fresh, allocations: { [task.id]: ' ' } })).toBe(false);
    expect(planDraftDirty({ ...fresh, allocations: { [task.id]: '0' } })).toBe(true);
    expect(planDraftDirty({ ...fresh, allocations: { [task.id]: 'invalid' } })).toBe(true);
    const saved = commitmentSession(period(), { ...commitment(90), allocations: [{ taskId: task.id, minutes: 90 }] }, MEMBER_ID);
    expect(planDraftDirty({ ...saved, hours: '1.5', allocations: { [task.id]: '1,5' } })).toBe(false);
    expect(planDraftDirty({ ...saved, allocations: {} })).toBe(true);
    expect(planDraftDirty({ ...saved, state: 'removed' })).toBe(true);
  });
  it('uses submit-trimmed reasons and captured fact/category states rather than stale/read metadata', () => {
    const fact = factSession(period(), categorized(), MEMBER_ID);
    expect(factDraftDirty({ ...fact, reason: '  ', stale: true })).toBe(false);
    expect(factDraftDirty({ ...fact, reason: 'Correction' })).toBe(true);
    expect(factDraftDirty({ ...fact, state: 'void' })).toBe(true);
    const category = freshCategory();
    expect(categoryDraftDirty({ ...category, reason: '  ', stale: true })).toBe(false);
    expect(categoryDraftDirty({ ...category, optionId: OPTION_B })).toBe(true);
    expect(categoryDraftDirty({ ...category, optionId: '' })).toBe(true);
    expect(categoryDraftDirty({ ...category, reason: 'Reclassify' })).toBe(true);
  });
});

describe('one observable retained hours owner', () => {
  it('publishes immutable snapshots and actual dirtiness synchronously without treating clean entries as dirty', () => {
    const owner = createRetainedHoursDrafts(); const seen: boolean[] = []; owner.subscribe(() => seen.push(owner.isDirty()));
    const initial = owner.getSnapshot(); owner.setPlanDrafts({ clean: freshPlan() });
    expect(owner.isDirty()).toBe(false); expect(owner.getSnapshot()).not.toBe(initial);
    owner.setFactDrafts({ dirty: { ...freshFact(), hours: 'invalid' } }); expect(owner.isDirty()).toBe(true);
    owner.setFactDrafts({ dirty: freshFact() }); expect(owner.isDirty()).toBe(false); expect(seen).toEqual([false, true, false]);
  });
  it('confirms only the submitted identity and preserves a replacement, other keys and other kinds', () => {
    const owner = createRetainedHoursDrafts(); const submitted = { ...freshFact(), hours: '2' }, replacement = { ...submitted, hours: '3' };
    const plan = { ...freshPlan(), hours: '4' };
    owner.setFactDrafts({ same: replacement, other: { ...submitted, hours: '5' } }); owner.setPlanDrafts({ plan });
    expect(owner.confirm('facts', 'same', submitted)).toBe(false); expect(owner.getSnapshot().facts.same).toBe(replacement);
    expect(owner.confirm('facts', 'same', replacement)).toBe(true); expect(owner.isDirty()).toBe(true);
    owner.setFactDrafts({}); expect(owner.isDirty()).toBe(true); expect(owner.confirm('plans', 'plan', plan)).toBe(true); expect(owner.isDirty()).toBe(false);
    expect(owner.confirm('plans', 'plan', plan)).toBe(false);
  });
  it('detaches only a removed subscription and leaves other owners independent', () => {
    const owner = createRetainedHoursDrafts(), other = createRetainedHoursDrafts();
    const listener = vi.fn(); const stop = owner.subscribe(listener); stop();
    owner.setCategoryDrafts({ one: { ...freshCategory(), reason: 'Retained' } });
    expect(listener).not.toHaveBeenCalled(); expect(owner.isDirty()).toBe(true); expect(other.isDirty()).toBe(false);
  });
});
