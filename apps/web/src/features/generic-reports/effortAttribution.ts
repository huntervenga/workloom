import type { GenericReportConfig, GenericReportMeasure, GenericMeasureResultDto } from '@workloom/contracts';

/** A saved SUM never changes meaning when participants are added. */
export function comparisonOperation(config: GenericReportConfig): 'sum' | 'personal_effort' {
  return config.comparison?.attribution === 'personal_effort' ? 'personal_effort' : 'sum';
}
export function hasPersonalEffort(config: GenericReportConfig): boolean {
  return config.comparison?.attribution === 'personal_effort' || config.measures.some(measure => measure.operation === 'personal_effort');
}
export function isComparisonMeasure(measure: GenericReportMeasure | GenericMeasureResultDto, config: GenericReportConfig, fieldId: string): boolean {
  return measure.operation === comparisonOperation(config) && 'fieldId' in measure && measure.fieldId === fieldId;
}
