import { describe, expect, it } from 'vitest';
import type { PlanningCheckRuleDto, SectionDto, TaskFieldDefinitionDto } from '@workloom/contracts';
import { copyPlanningChecks } from './copyChecks';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const fld = (n: number, name: string, type = 'duration', archivedAt: string | null = null) => ({ id: id(n), name, type, archivedAt }) as unknown as TaskFieldDefinitionDto;
const sec = (n: number, name: string) => ({ id: id(n), name, archivedAt: null }) as unknown as SectionDto;
const filters = { statusGroups: ['todo'], tagIds: [], assignee: { kind: 'all' }, dateRange: null };
const presence = (n: number, name: string, fieldId: string, extra: object = {}) => ({ id: id(n), kind: 'presence', name, color: '#dc2626', enabled: true, hierarchy: 'all_tasks', filters, severity: 'warning', fieldId, ...extra }) as unknown as PlanningCheckRuleDto;
let counter = 100;
const newId = () => id(counter++);

describe('copying planning checks to another project', () => {
  const sourceFields = [fld(1, 'Hours Estimation'), fld(2, 'Fact'), fld(3, 'Notes', 'text')];
  const targetFields = [fld(11, 'hours  estimation'), fld(12, 'Fact', 'duration'), fld(13, 'Notes', 'number')];

  it('maps fields by type and name, creates new rule ids and leaves the originals untouched', () => {
    const source = [presence(21, 'Estimate missing', id(1)), presence(22, 'Fact missing', id(2), { requireBeforeDone: true })];
    const copied = copyPlanningChecks({ rules: source, sourceFields, targetFields, sourceSections: [], targetSections: [], existing: [], newId });
    expect(copied.skipped).toEqual([]);
    expect(copied.rules.map(rule => (rule as { fieldId: string }).fieldId)).toEqual([id(11), id(12)]);
    expect(copied.rules.every((rule, index) => rule.id !== source[index]?.id)).toBe(true);
    expect((copied.rules[1] as { requireBeforeDone?: boolean }).requireBeforeDone).toBe(true);
    expect((source[0] as { fieldId: string }).fieldId).toBe(id(1));
  });
  it('skips, and names, rules whose field has no single same-type match', () => {
    const copied = copyPlanningChecks({ rules: [presence(21, 'Notes needed', id(3)), presence(22, 'Unknown', id(99))], sourceFields, targetFields, sourceSections: [], targetSections: [], existing: [], newId });
    expect(copied.rules).toEqual([]);
    expect(copied.skipped).toEqual([{ name: 'Notes needed', reason: 'field' }, { name: 'Unknown', reason: 'field' }]);
  });
  it('does not match an archived or ambiguous target field', () => {
    const ambiguous = [fld(11, 'Fact'), fld(12, 'fact'), fld(13, 'Hours Estimation', 'duration', '2026-01-01T00:00:00Z')];
    const copied = copyPlanningChecks({ rules: [presence(21, 'a', id(2)), presence(22, 'b', id(1))], sourceFields, targetFields: ambiguous, sourceSections: [], targetSections: [], existing: [], newId });
    expect(copied.rules).toEqual([]);
    expect(copied.skipped.map(item => item.reason)).toEqual(['field', 'field']);
  });
  it('does not add a rule that already exists in the target', () => {
    const existing = [presence(50, 'Estimate missing', id(11))];
    const copied = copyPlanningChecks({ rules: [presence(21, 'Estimate missing', id(1))], sourceFields, targetFields, sourceSections: [], targetSections: [], existing, newId });
    expect(copied.rules).toEqual([]);
    expect(copied.skipped).toEqual([{ name: 'Estimate missing', reason: 'duplicate' }]);
  });
  it('maps balance rules to the same-named section and skips them when it is missing', () => {
    const balance = (group: object) => ({ id: id(30), kind: 'balance', name: 'Load', enabled: true, hierarchy: 'all_tasks', filters, group, sumFieldId: id(1), cohort: { kind: 'all_tasks' }, missingPlan: 'unknown', target: { kind: 'fixed', unit: 'minutes', value: 100 }, under: { enabled: false, thresholdBps: 1, fullIntensityAtBps: 0, nearColor: '#000000', farColor: '#000000' }, over: { enabled: false, thresholdBps: 1, fullIntensityAtBps: 2, nearColor: '#000000', farColor: '#000000' } }) as unknown as PlanningCheckRuleDto;
    const ok = copyPlanningChecks({ rules: [balance({ kind: 'section', sectionId: id(41) })], sourceFields, targetFields, sourceSections: [sec(41, 'Mark')], targetSections: [sec(51, ' mark ')], existing: [], newId });
    expect((ok.rules[0] as { group: { sectionId: string } }).group.sectionId).toBe(id(51));
    const gone = copyPlanningChecks({ rules: [balance({ kind: 'section', sectionId: id(41) })], sourceFields, targetFields, sourceSections: [sec(41, 'Mark')], targetSections: [], existing: [], newId });
    expect(gone.skipped).toEqual([{ name: 'Load', reason: 'section' }]);
  });
  it('uses a field the person chose when the names differ, and only a live field of the same type', () => {
    const rules = [presence(21, 'Fact missing', id(2))];
    const renamed = [fld(12, 'Actual hours', 'duration'), fld(13, 'Actual text', 'text'), fld(14, 'Old', 'duration', '2026-01-01T00:00:00Z')];
    const none = copyPlanningChecks({ rules, sourceFields, targetFields: renamed, sourceSections: [], targetSections: [], existing: [], newId });
    expect(none.unmatchedFields).toEqual([{ id: id(2), name: 'Fact', type: 'duration' }]);
    const chosen = copyPlanningChecks({ rules, sourceFields, targetFields: renamed, sourceSections: [], targetSections: [], existing: [], newId, fieldChoices: { [id(2)]: id(12) } });
    expect((chosen.rules[0] as { fieldId: string }).fieldId).toBe(id(12));
    const archived = copyPlanningChecks({ rules, sourceFields, targetFields: renamed, sourceSections: [], targetSections: [], existing: [], newId, fieldChoices: { [id(2)]: id(14) } });
    expect(archived.rules).toEqual([]);
  });
});
