import type { GenericReportConfig } from '@workloom/contracts';
import { comparisonOperation } from './effortAttribution';

/** Dashboard reads need full Plan/Actual sums even if the saved report only requests averages. Never change the saved definition. */
export function dashboardSums(config: GenericReportConfig): { config: GenericReportConfig; limited: boolean } {
  const measures = [...config.measures], operation = comparisonOperation(config);
  let limited = false;
  for (const [role, fieldId] of config.comparison ? [['plan', config.comparison.planFieldId], ['fact', config.comparison.factFieldId]] as const : []) {
    if (measures.some(measure => measure.operation === operation && 'fieldId' in measure && measure.fieldId === fieldId)) continue;
    if (measures.length >= 12) { limited = true; continue; }
    let key = `dashboard_${role}`;
    while (measures.some(measure => measure.key === key)) key += '_';
    measures.push({ key, operation, fieldId });
  }
  return { config: { ...config, measures }, limited };
}
