import type { CreateWeeklyPlanFactReportInput, CreateWorkTypeReportRunInput } from '@workloom/contracts';

export interface ReportSetupState {
  expanded: boolean;
  dirty: boolean;
  configurationKey: string | null;
}
export interface ReportDraft<TSelection> {
  selection: TSelection | undefined;
  setup: ReportSetupState;
}
export type ReportDraftAction<TSelection> =
  | { type: 'edit'; periodId: string; selection: TSelection; configurationKey: string }
  | { type: 'expand'; periodId: string; expanded: boolean }
  | { type: 'submitted' | 'confirmed'; periodId: string; configurationKey: string };

/** Page-owned state survives the report components unmounting while another period loads. */
export function updateReportDraft<TSelection>(before: Record<string, ReportDraft<TSelection>>, action: ReportDraftAction<TSelection>): Record<string, ReportDraft<TSelection>> {
  const current = before[action.periodId] ?? { selection: undefined, setup: { expanded: false, dirty: false, configurationKey: null } };
  let next: ReportDraft<TSelection>;
  if (action.type === 'edit') {
    next = { selection: action.selection, setup: { expanded: true, dirty: true, configurationKey: action.configurationKey } };
  } else if (action.type === 'expand') {
    if (!action.expanded && current.setup.dirty) return before;
    next = { ...current, setup: { ...current.setup, expanded: action.expanded } };
  } else if (action.type === 'submitted') {
    // A delayed submit callback cannot replace a newer explicit configuration.
    if (current.setup.dirty && current.setup.configurationKey !== null && current.setup.configurationKey !== action.configurationKey) return before;
    next = { ...current, setup: { ...current.setup, expanded: true, configurationKey: action.configurationKey } };
  } else {
    // A late acknowledgement belongs only to the exact configuration that was sent.
    if (current.setup.configurationKey !== action.configurationKey) return before;
    next = { ...current, setup: { ...current.setup, expanded: false, dirty: false } };
  }
  return { ...before, [action.periodId]: next };
}

export function weeklyReportConfigurationKey(input: Pick<CreateWeeklyPlanFactReportInput, 'baselineId' | 'knownEstimatesOnly' | 'membershipIds'>): string {
  return JSON.stringify([input.baselineId, input.knownEstimatesOnly, [...input.membershipIds].sort()]);
}
export function workTypeReportConfigurationKey(input: Pick<CreateWorkTypeReportRunInput, 'membershipIds'>): string {
  return JSON.stringify([...input.membershipIds].sort());
}
