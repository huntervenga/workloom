import type { SetStateAction } from 'react';
import { commitmentSession, type CommitmentSession } from '../planning/CommitmentDialog';
import { factSession, type FactSession } from '../planning/FactDialog';
import { parseEstimateInput } from '../task-table/estimate';
import { recategorizeSession, type RecategorizeSession } from './RecategorizeDialog';

function sameHours(left: string, right: string): boolean {
  const a = parseEstimateInput(left), b = parseEstimateInput(right);
  return a.valid && b.valid ? a.minutes === b.minutes : left === right;
}
function sameAllocations(left: Record<string, string>, right: Record<string, string>): boolean {
  // Submission omits blank allocations, but keeps an explicit zero. Never normalize invalid text.
  const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
  return [...keys].every(key => sameHours(left[key] ?? '', right[key] ?? ''));
}
export function planDraftDirty(session: CommitmentSession): boolean {
  const base = commitmentSession(session.period, session.base, session.membershipId);
  return !sameHours(session.hours, base.hours) || !sameAllocations(session.allocations, base.allocations) || session.state !== base.state;
}
export function factDraftDirty(session: FactSession): boolean {
  const base = factSession(session.period, session.base, session.membershipId, session.taskId);
  return !sameHours(session.hours, base.hours) || session.reason.trim() !== base.reason.trim() || session.state !== base.state;
}
export function categoryDraftDirty(session: RecategorizeSession): boolean {
  const base = recategorizeSession(session.log, session.binding, session.taskTitle, session.memberName);
  return session.optionId !== base.optionId || session.reason.trim() !== base.reason.trim();
}
interface HoursDrafts {
  plans: Record<string, CommitmentSession>;
  facts: Record<string, FactSession>;
  categories: Record<string, RecategorizeSession>;
}

/** One actor/workspace/project owner's immutable sessions, separate from sent-command protection. */
export function createRetainedHoursDrafts() {
  let snapshot: HoursDrafts = { plans: {}, facts: {}, categories: {} };
  let dirty = false;
  const listeners = new Set<() => void>();
  function set<K extends keyof HoursDrafts>(kind: K, update: SetStateAction<HoursDrafts[K]>) {
    const next = typeof update === 'function' ? update(snapshot[kind]) : update;
    if (next === snapshot[kind]) return;
    snapshot = { ...snapshot, [kind]: next };
    dirty = Object.values(snapshot.plans).some(planDraftDirty) || Object.values(snapshot.facts).some(factDraftDirty) || Object.values(snapshot.categories).some(categoryDraftDirty);
    for (const listener of listeners) listener();
  }
  return {
    getSnapshot: () => snapshot,
    isDirty: () => dirty,
    subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    setPlanDrafts: (update: SetStateAction<HoursDrafts['plans']>) => set('plans', update),
    setFactDrafts: (update: SetStateAction<HoursDrafts['facts']>) => set('facts', update),
    setCategoryDrafts: (update: SetStateAction<HoursDrafts['categories']>) => set('categories', update),
    confirm<K extends keyof HoursDrafts>(kind: K, key: string, submitted: HoursDrafts[K][string] | null): boolean {
      if (!submitted || snapshot[kind][key] !== submitted) return false;
      set(kind, Object.fromEntries(Object.entries(snapshot[kind]).filter(([item]) => item !== key)) as HoursDrafts[K]);
      return true;
    },
  };
}
