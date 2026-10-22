import { DomainError } from '@workloom/domain';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (value: string): boolean => UUID.test(value);
const normalize = (value: string): string => value.normalize('NFC').trim().replace(/\s+/g, ' ').toLowerCase();

export interface NamedItem {
  readonly id: string;
  readonly name: string;
}

function referenceError(field: string, reason: 'not_found' | 'ambiguous', value: string, candidates: readonly NamedItem[]): DomainError {
  const shown = candidates.slice(0, 20).map(item => ({ id: item.id, name: item.name }));
  const message = reason === 'ambiguous'
    ? `More than one ${field} is called "${value}". Use its id.`
    : `No ${field} matches "${value}". Use its id or exact name.`;
  return new DomainError('VALIDATION_FAILED', message, { details: { field, reason, value, candidates: shown } });
}

/** Every item whose id equals the value, or whose name equals it ignoring case and spacing. */
export function matchRef<T extends NamedItem>(value: string, items: readonly T[]): T[] {
  if (isUuid(value)) {
    const byId = items.filter(item => item.id.toLowerCase() === value.toLowerCase());
    if (byId.length > 0) return byId;
  }
  const wanted = normalize(value);
  return items.filter(item => normalize(item.name) === wanted);
}

/** Exactly one item, for commands that write one concrete reference. */
export function resolveRef<T extends NamedItem>(field: string, value: string, items: readonly T[]): T {
  const matches = matchRef(value, items);
  if (matches.length === 0) throw referenceError(field, 'not_found', value, items);
  if (matches.length > 1) throw referenceError(field, 'ambiguous', value, matches);
  return matches[0] as T;
}

export function resolveRefs<T extends NamedItem>(field: string, values: readonly string[], items: readonly T[]): T[] {
  const seen = new Set<string>();
  const resolved: T[] = [];
  for (const value of values) {
    const item = resolveRef(field, value, items);
    if (!seen.has(item.id)) { seen.add(item.id); resolved.push(item); }
  }
  return resolved;
}

/** Filters accept names shared by several projects (for example "To do"): every match is kept, an unknown name is still an error. */
export function matchRefs<T extends NamedItem>(field: string, values: readonly string[], items: readonly T[]): T[] {
  const result = new Map<string, T>();
  for (const value of values) {
    const matches = matchRef(value, items);
    if (matches.length === 0) throw referenceError(field, 'not_found', value, items);
    for (const item of matches) result.set(item.id, item);
  }
  return [...result.values()];
}
