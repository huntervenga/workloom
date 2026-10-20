import type { TaskFieldDefinitionDto } from '@workloom/contracts';
const HEX_COLOR = /^#[0-9a-f]{6}$/i;
const sameId = (first: string, second: string) => first.toLowerCase() === second.toLowerCase();
/** Decoration follows persisted option identity, never translated labels or category position. */
export function categoryColor(fields: readonly TaskFieldDefinitionDto[], projectId: string | null, fieldId: string | null, optionId: string | null): string | null {
  if (!projectId || !fieldId || !optionId) return null;
  const field = fields.find(candidate => sameId(candidate.id, fieldId) && sameId(candidate.projectId, projectId));
  if (!field || field.type !== 'single_select' && field.type !== 'multi_select') return null;
  const color = field.options.find(option => sameId(option.id, optionId))?.color;
  return color && HEX_COLOR.test(color) ? color.toLowerCase() : null;
}
