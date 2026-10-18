import type { WeeklyPlanFactRowDto } from '@workloom/contracts';

/** A personal original-plan comparison after full-package completion, not a package-budget metric. */
export function completedWorkReview(row: WeeklyPlanFactRowDto) {
  if (row.scope !== 'original') return { state: 'not_original' as const };
  if (!row.completionAtCalculation || row.completionAtCalculation.state === 'unknown') return { state: 'unknown_completion' as const };
  if (row.completionAtCalculation.state !== 'done') return { state: row.factRecorded ? 'in_progress' as const : 'unreported' as const };
  if (!row.factRecorded) return { state: 'unreported' as const };
  if (row.plannedMinutes === null) return { state: 'unknown_plan' as const };
  return { state: 'completed' as const, deltaMinutes: row.actualMinutes - row.plannedMinutes, actualToPlanRatio: row.plannedMinutes === 0 ? null : row.actualMinutes / row.plannedMinutes };
}
