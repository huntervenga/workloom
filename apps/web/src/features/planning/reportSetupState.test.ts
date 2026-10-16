import { describe, expect, it } from 'vitest';
import { updateReportDraft, weeklyReportConfigurationKey, workTypeReportConfigurationKey, type ReportDraft } from './reportSetupState';

describe('page-owned report setup confirmation', () => {
  const selectionA = { baselineId: 'baseline-a', knownOnly: false, membershipIds: ['person-a'] };
  const selectionB = { ...selectionA, knownOnly: true };
  const key = (selection: typeof selectionA) => weeklyReportConfigurationKey({ baselineId: selection.baselineId, knownEstimatesOnly: selection.knownOnly, membershipIds: selection.membershipIds });

  it('does not clear a newer configuration or another period when a late result acknowledges the original input', () => {
    let state: Record<string, ReportDraft<typeof selectionA>> = {};
    state = updateReportDraft(state, { type: 'edit', periodId: 'week-a', selection: selectionA, configurationKey: key(selectionA) });
    state = updateReportDraft(state, { type: 'submitted', periodId: 'week-a', configurationKey: key(selectionA) });
    state = updateReportDraft(state, { type: 'edit', periodId: 'week-b', selection: selectionA, configurationKey: key(selectionA) });
    state = updateReportDraft(state, { type: 'edit', periodId: 'week-a', selection: selectionB, configurationKey: key(selectionB) });
    state = updateReportDraft(state, { type: 'confirmed', periodId: 'week-a', configurationKey: key(selectionA) });
    expect(state['week-a']?.selection).toEqual(selectionB);
    expect(state['week-a']?.setup).toMatchObject({ dirty: true, expanded: true });
    expect(state['week-b']?.setup).toMatchObject({ dirty: true, expanded: true });
    state = updateReportDraft(state, { type: 'submitted', periodId: 'week-a', configurationKey: key(selectionB) });
    state = updateReportDraft(state, { type: 'confirmed', periodId: 'week-a', configurationKey: key(selectionB) });
    expect(state['week-a']?.setup).toMatchObject({ dirty: false, expanded: false });
    expect(state['week-a']?.selection).toEqual(selectionB);
    expect(state['week-b']?.setup).toMatchObject({ dirty: true, expanded: true });
  });

  it('keeps dirty setup visible and distinguishes all report inputs while ignoring membership selection order', () => {
    const state = updateReportDraft({}, { type: 'edit', periodId: 'week', selection: selectionA, configurationKey: key(selectionA) });
    expect(updateReportDraft(state, { type: 'expand', periodId: 'week', expanded: false })['week']?.setup.expanded).toBe(true);
    expect(key(selectionA)).not.toBe(key(selectionB));
    expect(key(selectionA)).not.toBe(key({ ...selectionA, baselineId: 'another-baseline' }));
    expect(key(selectionA)).not.toBe(key({ ...selectionA, membershipIds: [] }));
    expect(workTypeReportConfigurationKey({ membershipIds: ['a', 'b'] })).toBe(workTypeReportConfigurationKey({ membershipIds: ['b', 'a'] }));
  });
});
