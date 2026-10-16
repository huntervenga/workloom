import { t } from '../../i18n';
import { projectImportMappingSchema, type ProjectImportDto, type ProjectImportMapping, type TaskFieldDefinitionDto } from '@workloom/contracts';
export const coreColumns = [
  ['externalIdColumn', 'imports.externalTaskId'], ['titleColumn', 'imports.taskTitle'], ['descriptionColumn', 'imports.description'],
  ['startDateColumn', 'imports.startDate'], ['dueDateColumn', 'imports.dueDate'], ['parentExternalIdColumn', 'imports.externalParentTaskId'],
  ['responsibleColumn', 'imports.assignee'], ['participantsColumn', 'imports.participants'], ['statusColumn', 'imports.status'],
  ['sectionColumn', 'imports.section'], ['tagsColumn', 'imports.tags'], ['privateColumn', 'imports.privacyFlag'],
] as const;
export type CoreColumnKey = (typeof coreColumns)[number][0];
export type ScalarChoice = { column: number; fieldId: string; empty: 'missing' | 'null'; sourceMeaning: 'ordinary' | 'current_estimate' | 'current_actual'; sourceUnit: 'minutes' | 'hours' | '' };
export interface ImportMappingForm {
  columns: Record<CoreColumnKey, number | ''>;
  defaultStatusId: string; dateFormat: 'iso' | 'us'; shareableScopeConfirmed: boolean; assigneeIsParticipant: boolean;
  participantsDelimiter: ';' | '|' | ',' | ''; tagsDelimiter: ';' | '|' | ',' | '';
  people: Record<string, string>; statuses: Record<string, string>; sections: Record<string, string>; tags: Record<string, string>;
  customFields: ScalarChoice[]; preserveColumns: number[];
}
export function initialMapping(): ImportMappingForm {
  return { columns: Object.fromEntries(coreColumns.map(([key]) => [key, ''])) as ImportMappingForm['columns'], defaultStatusId: '', dateFormat: 'iso', shareableScopeConfirmed: false, assigneeIsParticipant: false, participantsDelimiter: '', tagsDelimiter: '', people: {}, statuses: {}, sections: {}, tags: {}, customFields: [], preserveColumns: [] };
}
export function formFromMapping(mapping: ProjectImportMapping): ImportMappingForm {
  return { ...initialMapping(), columns: Object.fromEntries(coreColumns.map(([key]) => [key, mapping[key] ?? ''])) as ImportMappingForm['columns'], defaultStatusId: mapping.defaultStatusId, dateFormat: mapping.dateFormat, shareableScopeConfirmed: mapping.shareableScopeConfirmed, assigneeIsParticipant: mapping.assigneeIsParticipant ?? false, participantsDelimiter: mapping.participantsDelimiter ?? '', tagsDelimiter: mapping.tagsDelimiter ?? '', people: Object.fromEntries(mapping.people.map(row => [row.sourceValue, row.membershipId])), statuses: Object.fromEntries(mapping.statuses.map(row => [row.sourceValue, row.statusId])), sections: Object.fromEntries(mapping.sections.map(row => [row.sourceValue, row.sectionId])), tags: Object.fromEntries(mapping.tags.map(row => [row.sourceValue, row.tagId])), customFields: mapping.customFields.map(field => ({ ...field, sourceUnit: field.sourceUnit ?? '' })), preserveColumns: [...mapping.preserveColumns] };
}
export function sourceValues(source: ProjectImportDto, column: number | '', delimiter?: string): string[] {
  if (column === '') return [];
  return [...new Set(source.sourceRows.flatMap(row => delimiter ? (row.cells[column] ?? '').split(delimiter) : [row.cells[column] ?? '']).map(value => value.trim()).filter(Boolean))].sort();
}
export function mappedColumns(form: ImportMappingForm): Set<number> {
  return new Set([...Object.values(form.columns).filter((value): value is number => value !== ''), ...form.customFields.map(field => field.column)]);
}
export function peopleValues(source: ProjectImportDto, form: ImportMappingForm): string[] {
  return [...new Set([...sourceValues(source, form.columns.responsibleColumn), ...sourceValues(source, form.columns.participantsColumn, form.participantsDelimiter || undefined)])].sort();
}
export const referenceChoice = (record: Readonly<Record<string, string>>, sourceValue: string): string => Object.hasOwn(record, sourceValue) ? record[sourceValue] ?? '' : '';
export function buildImportMapping(source: ProjectImportDto, form: ImportMappingForm, definitions: readonly TaskFieldDefinitionDto[]): ProjectImportMapping | null {
  if (peopleValues(source, form).length + sourceValues(source, form.columns.statusColumn).length + sourceValues(source, form.columns.sectionColumn).length + sourceValues(source, form.columns.tagsColumn, form.tagsDelimiter || undefined).length > 100) return null;
  const base: Record<string, unknown> = { defaultStatusId: form.defaultStatusId, dateFormat: form.dateFormat, shareableScopeConfirmed: form.shareableScopeConfirmed, assigneeIsParticipant: form.assigneeIsParticipant };
  for (const [key, value] of Object.entries(form.columns)) if (value !== '') base[key] = value;
  if (form.columns.participantsColumn !== '' && form.participantsDelimiter) base.participantsDelimiter = form.participantsDelimiter;
  if (form.columns.tagsColumn !== '' && form.tagsDelimiter) base.tagsDelimiter = form.tagsDelimiter;
  base.people = peopleValues(source, form).filter(value => referenceChoice(form.people, value)).map(sourceValue => ({ sourceValue, membershipId: referenceChoice(form.people, sourceValue) }));
  base.statuses = sourceValues(source, form.columns.statusColumn).filter(value => referenceChoice(form.statuses, value)).map(sourceValue => ({ sourceValue, statusId: referenceChoice(form.statuses, sourceValue) }));
  base.sections = sourceValues(source, form.columns.sectionColumn).filter(value => referenceChoice(form.sections, value)).map(sourceValue => ({ sourceValue, sectionId: referenceChoice(form.sections, sourceValue) }));
  base.tags = sourceValues(source, form.columns.tagsColumn, form.tagsDelimiter || undefined).filter(value => referenceChoice(form.tags, value)).map(sourceValue => ({ sourceValue, tagId: referenceChoice(form.tags, sourceValue) }));
  const customFields = [];
  for (const choice of form.customFields) {
    const definition = definitions.find(field => field.id === choice.fieldId);
    if (!definition || definition.archivedAt || !['text', 'number', 'duration', 'date', 'boolean'].includes(definition.type)) return null;
    if ((definition.type === 'duration' || choice.sourceMeaning !== 'ordinary') && !choice.sourceUnit) return null;
    customFields.push({ column: choice.column, fieldId: choice.fieldId, expectedDefinitionRevision: definition.revision, empty: choice.empty, sourceMeaning: choice.sourceMeaning, ...(choice.sourceUnit ? { sourceUnit: choice.sourceUnit } : {}) });
  }
  base.customFields = customFields;
  const used = mappedColumns(form);
  base.preserveColumns = form.preserveColumns.filter(column => !used.has(column));
  const parsed = projectImportMappingSchema.safeParse(base);
  return parsed.success ? parsed.data : null;
}
export const columnName = (source: ProjectImportDto, index: number) => `${index + 1} · ${source.headers[index] || t('imports.untitled2')}`;
