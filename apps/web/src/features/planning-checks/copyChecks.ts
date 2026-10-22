import type { PlanningCheckRuleDto, SectionDto, TaskFieldDefinitionDto } from '@workloom/contracts';

/**
 * Re-targets planning-check rules from one project to another in the same workspace. Fields and sections have
 * project-specific IDs, so they are matched by type and name (case and spacing ignored); a rule whose field or
 * section has no single match is skipped and reported instead of being guessed.
 */
export interface CopiedChecks {
  rules: PlanningCheckRuleDto[];
  skipped: { name: string; reason: 'field' | 'section' | 'duplicate' }[];
  /** Source fields used by a skipped rule that had no single same-name match; the person may pick a target for each. */
  unmatchedFields: { id: string; name: string; type: string }[];
}

const normal = (text: string) => text.normalize('NFC').trim().replace(/\s+/g, ' ').toLowerCase();

function matcher<T extends { id: string; name: string }>(source: readonly T[], target: readonly T[], keyOf: (item: T) => string): (id: string) => string | null {
  const byKey = new Map<string, string[]>();
  for (const item of target) byKey.set(keyOf(item), [...(byKey.get(keyOf(item)) ?? []), item.id]);
  const sourceKey = new Map(source.map(item => [item.id, keyOf(item)]));
  return id => {
    const key = sourceKey.get(id);
    const hits = key === undefined ? undefined : byKey.get(key);
    return hits?.length === 1 ? hits[0] ?? null : null;
  };
}

const sameRule = (a: PlanningCheckRuleDto, b: PlanningCheckRuleDto) => a.kind === b.kind && normal(a.name) === normal(b.name) && JSON.stringify({ ...a, id: '' }) === JSON.stringify({ ...b, id: '' });

export function copyPlanningChecks(input: {
  rules: readonly PlanningCheckRuleDto[];
  sourceFields: readonly TaskFieldDefinitionDto[]; targetFields: readonly TaskFieldDefinitionDto[];
  sourceSections: readonly SectionDto[]; targetSections: readonly SectionDto[];
  existing: readonly PlanningCheckRuleDto[];
  newId: () => string;
  /** Source field id → target field id, chosen by the person for fields whose names differ. */
  fieldChoices?: Readonly<Record<string, string>>;
}): CopiedChecks {
  const byName = matcher(input.sourceFields, input.targetFields.filter(item => item.archivedAt === null), item => `${item.type}:${normal(item.name)}`);
  const targetIds = new Set(input.targetFields.filter(item => item.archivedAt === null).map(item => item.id));
  const sourceById = new Map(input.sourceFields.map(item => [item.id, item]));
  const field = (id: string) => { const chosen = input.fieldChoices?.[id]; return chosen !== undefined && targetIds.has(chosen) ? chosen : byName(id); };
  const section = matcher(input.sourceSections, input.targetSections.filter(item => item.archivedAt === null), item => normal(item.name));
  const result: CopiedChecks = { rules: [], skipped: [], unmatchedFields: [] };
  const unmatched = new Map<string, { id: string; name: string; type: string }>();
  for (const original of input.rules) {
    const rule = structuredClone(original);
    let missing: 'field' | 'section' | null = null;
    const mapField = (id: string) => { const mapped = field(id); if (mapped === null) { missing = 'field'; const source = sourceById.get(id); if (source) unmatched.set(id, { id, name: source.name, type: source.type }); } return mapped ?? id; };
    if (rule.filters.dateRange?.source.kind === 'field') rule.filters.dateRange.source.fieldId = mapField(rule.filters.dateRange.source.fieldId);
    if (rule.kind === 'presence') rule.fieldId = mapField(rule.fieldId);
    if (rule.kind === 'balance') {
      rule.sumFieldId = mapField(rule.sumFieldId);
      if (rule.cohort.kind === 'task_dates' && rule.cohort.source.kind === 'field') rule.cohort.source.fieldId = mapField(rule.cohort.source.fieldId);
      if (rule.group.kind === 'section' && rule.group.sectionId !== null) { const mapped = section(rule.group.sectionId); if (mapped === null) missing ??= 'section'; else rule.group.sectionId = mapped; }
    }
    if (missing !== null) { result.skipped.push({ name: original.name, reason: missing }); continue; }
    rule.id = input.newId();
    if ([...input.existing, ...result.rules].some(other => sameRule(other, rule))) { result.skipped.push({ name: original.name, reason: 'duplicate' }); continue; }
    result.rules.push(rule);
  }
  result.unmatchedFields = [...unmatched.values()];
  return result;
}
