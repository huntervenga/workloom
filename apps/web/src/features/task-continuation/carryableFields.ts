import type { TaskFieldDefinitionDto } from '@workloom/contracts';

const key = (name: string) => name.normalize('NFC').trim().replace(/\s+/g, ' ').toLowerCase();

/**
 * Fields whose value may be copied on continue: not choices (those always carry over) and not people, active in both
 * projects, matched by type and name — nothing is special-cased by name.
 */
export function carryableFields(source: readonly TaskFieldDefinitionDto[], target: readonly TaskFieldDefinitionDto[]): TaskFieldDefinitionDto[] {
  return source.filter(field => field.archivedAt === null && field.type !== 'single_select' && field.type !== 'multi_select' && field.type !== 'person'
    && target.some(other => other.archivedAt === null && other.type === field.type && key(other.name) === key(field.name)));
}
