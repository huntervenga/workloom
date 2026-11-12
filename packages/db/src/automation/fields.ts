import { parseDurationMinutes, sqlCalendarDateSchema, type PublicFieldDto, type PublicFieldValueDto, type PublicFieldValueInput, type TaskFieldData, type TaskFieldDefinitionDto, type TaskFieldValueDto } from '@workloom/contracts';
import { DomainError } from '@workloom/domain';
import { isUuid } from './refs.js';

type PublicValue = PublicFieldValueDto['value'];

export interface PersonLookup {
  readonly name: (membershipId: string) => string;
  /** Resolves `me`, a membership id, a user id or an exact display name; throws on unknown or ambiguous. */
  readonly resolve: (reference: string) => string;
}

const invalid = (field: TaskFieldDefinitionDto, message: string) =>
  new DomainError('VALIDATION_FAILED', `${field.name}: ${message}`, { details: { field: field.name, reason: 'invalid_value' } });

export function toPublicField(field: TaskFieldDefinitionDto): PublicFieldDto {
  return {
    id: field.id, name: field.name, type: field.type, locked: field.locked,
    options: [...field.options].filter(option => option.archivedAt === null).sort((a, b) => a.position - b.position).map(option => ({ id: option.id, name: option.name })),
    ...(field.timeRole !== undefined ? { timeRole: field.timeRole } : {}),
  };
}

function optionName(field: TaskFieldDefinitionDto, id: string): string {
  return field.options.find(option => option.id.toLowerCase() === id.toLowerCase())?.name ?? id;
}

/** The friendly value of a typed value; option and person ids become names. */
export function toPublicValue(field: TaskFieldDefinitionDto, data: TaskFieldData | null, people: PersonLookup): PublicValue {
  if (data === null || data.value === null) return null;
  switch (data.type) {
    case 'single_select': return optionName(field, data.value);
    case 'multi_select': return data.value.map(id => optionName(field, id));
    case 'person': return data.value.map(id => people.name(id));
    default: return data.value;
  }
}

export function toPublicFieldValue(field: TaskFieldDefinitionDto, row: TaskFieldValueDto | undefined, people: PersonLookup): PublicFieldValueDto {
  const value = row ? toPublicValue(field, row.value, people) : null;
  return {
    fieldId: field.id, name: field.name, type: field.type, set: row !== undefined, value,
    ...(field.type === 'duration' ? { hours: typeof value === 'number' ? Math.round((value / 60) * 100) / 100 : null } : {}),
  };
}

function resolveOption(field: TaskFieldDefinitionDto, reference: string): string {
  const active = field.options.filter(option => option.archivedAt === null);
  const lowered = reference.trim().toLowerCase();
  const byId = isUuid(reference) ? active.find(option => option.id.toLowerCase() === lowered) : undefined;
  if (byId) return byId.id;
  const matches = active.filter(option => option.name.toLowerCase() === lowered);
  if (matches.length === 1 && matches[0]) return matches[0].id;
  const candidates = active.map(option => option.name).slice(0, 50).join(', ');
  throw invalid(field, matches.length > 1 ? `"${reference}" matches several options.` : `unknown option "${reference}". Options: ${candidates || 'none'}.`);
}

/** Turns a friendly input into the typed value the field command stores. */
export function toTypedValue(field: TaskFieldDefinitionDto, input: PublicFieldValueInput, people: PersonLookup): TaskFieldData {
  if (input === null) return { type: field.type, value: null } as TaskFieldData;
  switch (field.type) {
    case 'duration': {
      const minutes = typeof input === 'number' || typeof input === 'string' ? parseDurationMinutes(input) : null;
      if (minutes === null) throw invalid(field, 'expected whole minutes or a duration such as "90m", "1.5h", "1h 30m" or "1:30".');
      return { type: 'duration', value: minutes };
    }
    case 'number':
      if (typeof input !== 'number' || !Number.isFinite(input)) throw invalid(field, 'expected a number.');
      return { type: 'number', value: input };
    case 'text':
      if (typeof input !== 'string') throw invalid(field, 'expected text.');
      return { type: 'text', value: input };
    case 'url':
      if (typeof input !== 'string') throw invalid(field, 'expected an http or https URL.');
      return { type: 'url', value: input };
    case 'boolean':
      if (typeof input !== 'boolean') throw invalid(field, 'expected true or false.');
      return { type: 'boolean', value: input };
    case 'date':
      if (typeof input !== 'string' || !sqlCalendarDateSchema.safeParse(input).success) throw invalid(field, 'expected a date as YYYY-MM-DD.');
      return { type: 'date', value: input };
    case 'single_select':
      if (typeof input !== 'string') throw invalid(field, 'expected one option name.');
      return { type: 'single_select', value: resolveOption(field, input) };
    case 'multi_select': {
      const list = typeof input === 'string' ? [input] : Array.isArray(input) ? input : null;
      if (list === null) throw invalid(field, 'expected a list of option names.');
      return { type: 'multi_select', value: [...new Set(list.map(item => resolveOption(field, item)))].sort() };
    }
    case 'person': {
      const list = typeof input === 'string' ? [input] : Array.isArray(input) ? input : null;
      if (list === null) throw invalid(field, 'expected a list of people.');
      return { type: 'person', value: [...new Set(list.map(item => people.resolve(item)))].sort() };
    }
  }
}

export function sameTypedValue(a: TaskFieldData | null, b: TaskFieldData | null): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** Finds an active field by exact (case-insensitive) name or id. */
export function resolveField(fields: readonly TaskFieldDefinitionDto[], reference: string, role = 'field'): TaskFieldDefinitionDto {
  const active = fields.filter(field => field.archivedAt === null);
  const lowered = reference.trim().toLowerCase();
  const byId = isUuid(reference) ? active.find(field => field.id.toLowerCase() === lowered) : undefined;
  if (byId) return byId;
  const matches = active.filter(field => field.name.toLowerCase() === lowered);
  if (matches.length === 1 && matches[0]) return matches[0];
  const candidates = active.map(field => ({ id: field.id, name: field.name, type: field.type }));
  throw new DomainError('VALIDATION_FAILED', matches.length > 1 ? `Several fields are named "${reference}".` : `No field "${reference}" in this project.`,
    { details: { field: role, reason: matches.length > 1 ? 'ambiguous' : 'not_found', candidates } });
}
