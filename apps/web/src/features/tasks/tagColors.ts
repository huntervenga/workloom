import type { TagDto } from '@workloom/contracts';

export const TAG_COLORS = [
  { name: 'blue', color: '#3b82f6' }, { name: 'purple', color: '#8b5cf6' },
  { name: 'pink', color: '#ec4899' }, { name: 'red', color: '#ef4444' },
  { name: 'orange', color: '#f97316' }, { name: 'yellow', color: '#eab308' },
  { name: 'green', color: '#22c55e' }, { name: 'teal', color: '#14b8a6' },
] as const;
export type TagColorName = typeof TAG_COLORS[number]['name'];
/** Stable across reloads and themes; never changes a persisted legacy null. */
export function defaultTagColor(seed: string): string {
  let hash = 2166136261;
  for (const character of seed.trim().toLowerCase()) { hash ^= character.codePointAt(0) ?? 0; hash = Math.imul(hash, 16777619); }
  return TAG_COLORS[(hash >>> 0) % TAG_COLORS.length]?.color ?? TAG_COLORS[0].color;
}
export function tagColor(tag: Pick<TagDto, 'id' | 'name' | 'color'>): string {
  return tag.color !== null && /^#[0-9a-f]{6}$/i.test(tag.color) ? tag.color.toLowerCase() : defaultTagColor(tag.id || tag.name);
}
